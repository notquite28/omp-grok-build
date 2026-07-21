import { streamOpenAIResponses } from "@oh-my-pi/pi-ai";
import type {
  Api,
  Context,
  FetchImpl,
  Model,
  OpenAIResponsesOptions,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { requestHeaders } from "./headers";

const BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/**
 * Host `buildModel` leaves custom API ids with `compat: undefined`, and the
 * Responses transport crashes reading fields on that. We cannot import
 * `@oh-my-pi/pi-catalog/build` from marketplace installs (host only remaps
 * pi-ai / pi-coding-agent / …, not pi-catalog). Rebuild a request-time model
 * as `openai-responses` with a complete compat object instead.
 */
function toOpenAIResponsesModel(model: Model<Api>): Model<"openai-responses"> {
  const sparse = (model.compatConfig ?? model.compat ?? {}) as Record<string, unknown>;
  const supportsReasoningEffort =
    typeof sparse.supportsReasoningEffort === "boolean"
      ? sparse.supportsReasoningEffort
      : Boolean(model.reasoning);
  const compat = {
    supportsDeveloperRole: false,
    supportsStrictMode: false,
    supportsReasoningEffort,
    supportsLongPromptCacheRetention: false,
    strictResponsesPairing: false,
    supportsImageDetailOriginal: false,
    reasoningEffortMap: { minimal: "low" },
    supportsReasoningParams: true,
    supportsSamplingParams: true,
    thinkingFormat: "openai",
    reasoningDisableMode: "lowest-effort",
    omitReasoningEffort: !supportsReasoningEffort,
    includeEncryptedReasoning: false,
    filterReasoningHistory: true,
    disableReasoningOnForcedToolChoice: false,
    disableReasoningOnToolChoice: false,
    supportsToolChoice: true,
    supportsForcedToolChoice: true,
    supportsNamedToolChoice: true,
    reasoningContentField: "reasoning_content",
    requiresReasoningContentForToolCalls: false,
    requiresReasoningContentForAllAssistantTurns: false,
    allowsSyntheticReasoningContentForToolCalls: true,
    replayReasoningContent: false,
    qwenPreserveThinking: false,
    requiresThinkingAsText: false,
    requiresMistralToolIds: false,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresAssistantContentForToolCalls: false,
    openRouterRouting: undefined,
    isOpenRouterHost: false,
    wireModelIdMode: "raw",
    alwaysSendMaxTokens: false,
    enableGeminiThinkingLoopGuard: false,
    supportsObfuscationOptOut: false,
    stripDeepseekSpecialTokens: false,
    reasoningDeltasMayBeCumulative: false,
    emptyLengthFinishIsContextError: false,
    usesOpenAIToolCallIdLimit: false,
    promptCacheSessionHeader: "x-grok-conv-id",
    ...sparse,
  };

  return {
    ...model,
    api: "openai-responses",
    compat,
    compatConfig: model.compatConfig,
  } as Model<"openai-responses">;
}

function toOpenAIResponsesOptions(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  fetch: FetchImpl,
): OpenAIResponsesOptions {
  if (typeof options?.apiKey !== "string") {
    throw new Error("Grok Build custom transport requires a resolved API key");
  }

  return {
    ...options,
    apiKey: options.apiKey,
    fetch,
    maxTokens: options.maxTokens ?? model.maxTokens ?? undefined,
    reasoning: options.reasoning,
    disableReasoning: options.disableReasoning,
    toolChoice: options.toolChoice,
    serviceTier: options.serviceTier,
    textVerbosity: options.textVerbosity,
    openrouterVariant: options.openrouterVariant,
    reasoningSummary: options.hideThinkingSummary ? null : undefined,
    maxTokensExplicit: options.maxTokens !== undefined,
  };
}

/**
 * Custom-API stream handler.
 *
 * Injects CLI-proxy identity headers on the wire via a fetch wrapper so they
 * never need to live on cached model specs (host drops header-bearing dynamic
 * models on offline hydrate).
 */
export function streamGrokBuildResponses(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  clientVersion: string,
) {
  if (model.baseUrl !== BASE_URL) {
    throw new Error(`Grok Build requests require the canonical base URL ${BASE_URL}`);
  }

  const proxyHeaders = requestHeaders(model.id, clientVersion);
  const innerFetch: FetchImpl = options?.fetch ?? globalThis.fetch;
  const wrappedFetch: FetchImpl = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(proxyHeaders)) {
        headers.set(key, value);
      }
      return innerFetch(input, { ...init, headers, redirect: "error" });
    },
    innerFetch.preconnect ? { preconnect: innerFetch.preconnect } : {},
  );

  return streamOpenAIResponses(
    toOpenAIResponsesModel(model),
    context,
    toOpenAIResponsesOptions(model, options, wrappedFetch),
  );
}
