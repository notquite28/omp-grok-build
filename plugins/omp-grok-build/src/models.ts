import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

const COST_45 = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const NON_CHAT_PREFIXES = ["grok-imagine-", "grok-stt-", "grok-voice-"] as const;
type GrokEffort = NonNullable<ProviderModelConfig["thinking"]>["efforts"][number];
const EFFORT_BY_VALUE: Record<string, GrokEffort> = {
  minimal: "minimal" as GrokEffort,
  low: "low" as GrokEffort,
  medium: "medium" as GrokEffort,
  high: "high" as GrokEffort,
  xhigh: "xhigh" as GrokEffort,
  max: "max" as GrokEffort,
};

export const GROK_PROXY_COMPAT = {
  reasoningEffortMap: { minimal: "low" },
  includeEncryptedReasoning: false,
  filterReasoningHistory: true,
  supportsImageDetailOriginal: false,
  promptCacheSessionHeader: "x-grok-conv-id",
} as const;

export interface GrokCliModel extends ProviderModelConfig {
  supportsReasoningEffort: boolean;
}

// Keep this list aligned with what the Grok CLI proxy actually serves
// (`grok models` / `~/.grok/models_cache.json`). Unserved ids must not be
// registered — they show up as selectable but fail at request time.
export const GROK_CLI_MODELS: readonly GrokCliModel[] = [
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    reasoning: true,
    supportsReasoningEffort: true,
    input: ["text", "image"],
    cost: COST_45,
    contextWindow: 500_000,
    maxTokens: 30_000,
    thinking: { mode: "effort", efforts: ["low", "medium", "high"] as GrokEffort[] },
    compat: { ...GROK_PROXY_COMPAT, supportsReasoningEffort: true, omitReasoningEffort: false },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function effortsFor(model: Record<string, unknown>): GrokEffort[] {
  if (!Array.isArray(model.reasoning_efforts)) return [];
  return model.reasoning_efforts.flatMap((effort) => {
    if (!isRecord(effort) || typeof effort.value !== "string") return [];
    const value = EFFORT_BY_VALUE[effort.value.trim()];
    return value ? [value] : [];
  });
}

export function mapProxyModel(model: unknown): GrokCliModel | undefined {
  if (!isRecord(model) || typeof model.id !== "string") return undefined;

  const id = model.id.trim();
  if (!id || NON_CHAT_PREFIXES.some(prefix => id.startsWith(prefix))) return undefined;

  const fallback = GROK_CLI_MODELS.find(entry => entry.id === id);
  const reasoningEfforts = effortsFor(model);
  const supportsReasoning = model.supports_reasoning_effort === true && reasoningEfforts.length > 0;
  const name = typeof model.name === "string" ? model.name.trim() : undefined;
  const contextWindow = model.context_window;
  return {
    id,
    name: name || fallback?.name || id,
    reasoning: supportsReasoning,
    supportsReasoningEffort: supportsReasoning,
    input: fallback?.input ?? (id.includes("composer") ? ["text"] : ["text", "image"]),
    cost: fallback?.cost ?? COST_45,
    contextWindow:
      typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0
        ? contextWindow
        : fallback?.contextWindow ?? 200_000,
    maxTokens: fallback?.maxTokens ?? 30_000,
    compat: {
      ...GROK_PROXY_COMPAT,
      supportsReasoningEffort: supportsReasoning,
      omitReasoningEffort: !supportsReasoning,
    },
    ...(supportsReasoning ? { thinking: { mode: "effort" as const, efforts: reasoningEfforts } } : {}),
  };
}

export async function fetchGrokCliModels(
  apiKey: string | undefined,
  headers: Record<string, string>,
  fetchImpl: FetchImpl = fetch,
): Promise<readonly GrokCliModel[]> {
  if (!apiKey) return GROK_CLI_MODELS;

  try {
    const response = await fetchImpl("https://cli-chat-proxy.grok.com/v1/models", {
      headers: {
        ...headers,
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return GROK_CLI_MODELS;

    const payload = await response.json() as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.data)) return GROK_CLI_MODELS;

    const models: GrokCliModel[] = [];
    const seen = new Set<string>();
    for (const item of payload.data) {
      const model = mapProxyModel(item);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    return models;
  } catch {
    return GROK_CLI_MODELS;
  }
}
