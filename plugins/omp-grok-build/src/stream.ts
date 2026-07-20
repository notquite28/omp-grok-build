import { streamSimple } from "@oh-my-pi/pi-ai";
import type { Api, Context, FetchImpl, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { requestHeaders } from "./headers";

const BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/**
 * Custom-API stream handler.
 *
 * Host `buildModel` leaves custom API ids with `compat: undefined`, and the
 * Responses transport crashes on that. Rebuild as `openai-responses` (with the
 * sparse `compatConfig` overrides) and inject CLI-proxy identity headers on the
 * wire via a fetch wrapper so they never need to live on cached model specs.
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

  // Rebuild as built-in openai-responses so streamSimple dispatches to the
  // native Responses transport with a fully resolved compat record.
  const responsesModel = buildModel({
    ...model,
    api: "openai-responses",
    compat: model.compatConfig,
  } as ModelSpec<"openai-responses">) as Model<Api>;

  return streamSimple(responsesModel, context, {
    ...options,
    fetch: wrappedFetch,
  });
}
