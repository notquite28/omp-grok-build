import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
type GrokEffort = NonNullable<ProviderModelConfig["thinking"]>["efforts"][number];

const COST_45 = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 };

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
