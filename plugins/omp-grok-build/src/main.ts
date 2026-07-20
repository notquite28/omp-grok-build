import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { loginToGrok, refreshGrokCredentials, resolveGrokVersion } from "./auth";
import { discoveryHeaders, withGrokRequestHeaders } from "./headers";
import { registerUsageCommand } from "./usage";
import { registerImagineCommand } from "./imagine";
import { fetchGrokCliModels } from "./models";
import { sanitizeProxyPayload } from "./payload";

const PROVIDER_ID = "grok-build";
const BASE_URL = "https://cli-chat-proxy.grok.com/v1";
// Custom API id so we can inject proxy headers at request time without
// baking per-model headers into the host SQLite model cache (which marks
// header-bearing dynamic models unrestorable and drops them offline).
const API_ID = "grok-build-responses";

function streamGrokBuildResponses(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  clientVersion: string,
) {
  // streamSimple resolves ApiKeyResolver before dispatch; cast to the string
  // apiKey surface expected by the Responses transport.
  const base = (options ?? {}) as Omit<SimpleStreamOptions, "apiKey"> & { apiKey?: string };
  return streamOpenAIResponses(model as Model<"openai-responses">, context, {
    ...base,
    headers: withGrokRequestHeaders(model.id, clientVersion, base.headers),
  });
}

export default function grokBuildExtension(pi: ExtensionAPI): void {
  const clientVersion = resolveGrokVersion();

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: BASE_URL,
    // Custom API (not built-in openai-responses) so streamSimple can inject
    // x-grok-model-override + client headers on every request without storing
    // them on cached model specs.
    api: API_ID,
    authHeader: true,
    streamSimple: (model, context, options) =>
      streamGrokBuildResponses(model, context, options, clientVersion),
    oauth: {
      name: "Grok Build CLI",
      login: (callbacks) => loginToGrok(callbacks, clientVersion),
      refreshToken: (credentials) => refreshGrokCredentials(credentials, clientVersion),
      getApiKey: (credentials) => credentials.access,
    },
    // Host treats `models` and `fetchDynamicModels` as mutually exclusive
    // (`models` early-returns before the dynamic path). Prefer live discovery
    // so the picker tracks the proxy catalog; fetchGrokCliModels falls back to
    // GROK_CLI_MODELS when unauthenticated or discovery fails.
    //
    // Intentionally omit model/provider `headers` here: the host cache never
    // persists headers, and dynamic-only header-bearing models become
    // unrestorable on offline hydrate (no-model / empty picker).
    fetchDynamicModels: async (apiKey) => {
      const models = await fetchGrokCliModels(apiKey, discoveryHeaders(clientVersion));
      return models.map(({ supportsReasoningEffort: _supports, ...model }) => model);
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    if (ctx.model.baseUrl !== BASE_URL) {
      throw new Error(`Grok Build requests require the canonical base URL ${BASE_URL}`);
    }
    // Derive reasoning support from the live model metadata rather than the
    // static catalog, so dynamically discovered reasoning models keep the
    // user-selected thinking effort. `thinking.efforts` is only populated for
    // models that expose a controllable reasoning-effort surface.
    const supportsReasoning = (ctx.model.thinking?.efforts?.length ?? 0) > 0;
    return sanitizeProxyPayload(
      event.payload,
      supportsReasoning,
      ctx.sessionManager?.getSessionId(),
    );
  });

  registerUsageCommand(pi);
  registerImagineCommand(pi);
}
