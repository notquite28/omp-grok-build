import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loginToGrok, refreshGrokCredentials, resolveGrokVersion } from "./auth";
import { requestHeaders } from "./headers";
import { registerUsageCommand } from "./usage";
import { registerImagineCommand } from "./imagine";
import { registerVideoCommand } from "./video";
import { GROK_CLI_MODELS } from "./models";
import { sanitizeProxyPayload } from "./payload";

const PROVIDER_ID = "grok-build";
const BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const API_ID = "openai-responses";

export default function grokBuildExtension(pi: ExtensionAPI): void {
  const clientVersion = resolveGrokVersion();

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: BASE_URL,
    // Use OMP's built-in Responses API. Plan-mode subagents intentionally
    // unload extension-scoped custom APIs, but retain the selected model and
    // its request headers.
    api: API_ID,
    authHeader: true,
    oauth: {
      name: "Grok Build CLI",
      login: (callbacks) => loginToGrok(callbacks, clientVersion),
      refreshToken: (credentials) => refreshGrokCredentials(credentials, clientVersion),
      getApiKey: (credentials) => credentials.access,
    },
    // Static models keep their required routing headers across restarts.
    // OMP's dynamic model cache intentionally omits headers, which would make
    // these models unrestorable and leave plan-mode subagents with no model.
    models: GROK_CLI_MODELS.map(({ supportsReasoningEffort: _supports, ...model }) => ({
      ...model,
      headers: requestHeaders(model.id, clientVersion),
    })),
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    if (ctx.model.baseUrl !== BASE_URL) {
      throw new Error(`Grok Build requests require the canonical base URL ${BASE_URL}`);
    }
    // `thinking.efforts` is populated only for models that expose a
    // controllable reasoning-effort surface.
    const supportsReasoning = (ctx.model.thinking?.efforts?.length ?? 0) > 0;
    return sanitizeProxyPayload(
      event.payload,
      supportsReasoning,
      ctx.sessionManager?.getSessionId(),
    );
  });

  registerUsageCommand(pi);
  registerImagineCommand(pi);
  registerVideoCommand(pi);
}
