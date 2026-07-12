import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loginToGrok, refreshGrokCredentials, resolveGrokVersion } from "./auth";
import { registerUsageCommand } from "./usage";
import { fetchGrokCliModels } from "./models";
import { sanitizeProxyPayload } from "./payload";

const PROVIDER_ID = "grok-build";
const BASE_URL = "https://cli-chat-proxy.grok.com/v1";

function clientHeaders(modelId: string, version: string): Record<string, string> {
  const platform = process.platform === "darwin" ? "macos" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch;
  return {
    "User-Agent": `grok-pager/${version} grok-shell/${version} (${platform}; ${arch})`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-model-override": modelId,
    "x-grok-client-version": version,
    "x-grok-client-identifier": "grok-pager",
  };
}

export default function grokBuildExtension(pi: ExtensionAPI): void {
  const clientVersion = resolveGrokVersion();

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: BASE_URL,
    api: "openai-responses",
    authHeader: true,
    oauth: {
      name: "Grok Build CLI",
      login: (callbacks) => loginToGrok(callbacks, clientVersion),
      refreshToken: (credentials) => refreshGrokCredentials(credentials, clientVersion),
      getApiKey: (credentials) => credentials.access,
    },
    fetchDynamicModels: async (apiKey) => {
      const models = await fetchGrokCliModels(apiKey, clientHeaders("grok-4.5", clientVersion));
      return models.map(({ supportsReasoningEffort: _supports, ...model }) => ({
        ...model,
        headers: clientHeaders(model.id, clientVersion),
      }));
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    return sanitizeProxyPayload(
      event.payload,
      ctx.model.id,
      ctx.sessionManager?.getSessionId(),
    );
  });

  registerUsageCommand(pi);
}
