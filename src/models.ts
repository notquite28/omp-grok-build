import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

const COST_COMPOSER = { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 };
const COST_45 = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };

export interface GrokCliModel extends ProviderModelConfig {
  supportsReasoningEffort: boolean;
}

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
    thinking: { mode: "openai", efforts: ["low", "medium", "high"] },
  },
  {
    id: "grok-composer-2.5-fast",
    name: "Composer 2.5",
    reasoning: false,
    supportsReasoningEffort: false,
    input: ["text"],
    cost: COST_COMPOSER,
    contextWindow: 200_000,
    maxTokens: 30_000,
  },
];

interface GrokProxyModel {
  id?: unknown;
  name?: unknown;
  context_window?: unknown;
  supports_reasoning_effort?: unknown;
  reasoning_efforts?: Array<{ value?: unknown }>;
}


function effortsFor(model: GrokProxyModel): string[] {
  if (!Array.isArray(model.reasoning_efforts)) return [];
  return model.reasoning_efforts
    .map((effort) => effort.value)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function mapProxyModel(model: GrokProxyModel): GrokCliModel | undefined {
  if (typeof model.id !== "string" || !model.id) return undefined;
  const fallback = GROK_CLI_MODELS.find((entry) => entry.id === model.id);
  const reasoningEfforts = effortsFor(model);
  const supportsReasoning = model.supports_reasoning_effort === true && reasoningEfforts.length > 0;
  return {
    id: model.id,
    name: typeof model.name === "string" && model.name ? model.name : fallback?.name ?? model.id,
    reasoning: supportsReasoning,
    supportsReasoningEffort: supportsReasoning,
    input: fallback?.input ?? (model.id.includes("composer") ? ["text"] : ["text", "image"]),
    cost: fallback?.cost ?? COST_45,
    contextWindow:
      typeof model.context_window === "number" && Number.isFinite(model.context_window)
        ? model.context_window
        : fallback?.contextWindow ?? 200_000,
    maxTokens: fallback?.maxTokens ?? 30_000,
    ...(supportsReasoning ? { thinking: { mode: "openai" as const, efforts: reasoningEfforts } } : {}),
  };
}

export async function fetchGrokCliModels(
  apiKey: string | undefined,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly GrokCliModel[]> {
  if (!apiKey) return GROK_CLI_MODELS;
  const response = await fetchImpl("https://cli-chat-proxy.grok.com/v1/models", {
    headers: {
      ...headers,
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) return GROK_CLI_MODELS;
  const payload = await response.json() as { data?: GrokProxyModel[] };
  const models = Array.isArray(payload.data) ? payload.data.map(mapProxyModel).filter(Boolean) : [];
  return models.length > 0 ? models : GROK_CLI_MODELS;
}

export function supportsReasoningEffort(modelId: string): boolean {
  return GROK_CLI_MODELS.some((model) => model.id === modelId && model.supportsReasoningEffort);
}
