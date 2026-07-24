import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { AspectRatio } from "./aspect";

const DEFAULT_IMAGINE_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const DEFAULT_IMAGINE_MODEL = "grok-imagine-image-quality";
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429]);

function imagineUrl(baseUrl?: string): string {
  const root = (baseUrl ?? process.env["GROK_BUILD_IMAGINE_BASE_URL"] ?? DEFAULT_IMAGINE_BASE_URL)
    .replace(/\/+$/, "");
  return root.endsWith("/images/generations") ? root : `${root}/images/generations`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("request cancelled"),
    );
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("request cancelled"));
    },
    { once: true },
  );
  return promise;
}

function timeoutSignal(parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("request timed out")),
    REQUEST_TIMEOUT_MS,
  );
  const onParentAbort = () => {
    controller.abort(parent?.reason instanceof Error ? parent.reason : new Error("request cancelled"));
  };
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function extractB64Json(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return undefined;
  const data = payload.data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (!first || typeof first !== "object" || !("b64_json" in first)) return undefined;
  const b64 = first.b64_json;
  return typeof b64 === "string" && b64.length > 0 ? b64 : undefined;
}

export interface GenerateImageResult {
  b64: string;
  mimeType: "image/jpeg";
}

export async function generateImage(options: {
  token: string;
  prompt: string;
  aspectRatio: AspectRatio;
  resolution?: string;
  clientVersion: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
}): Promise<GenerateImageResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = process.env["GROK_BUILD_IMAGINE_MODEL"] ?? DEFAULT_IMAGINE_MODEL;
  const body = JSON.stringify({
    model,
    prompt: options.prompt,
    n: 1,
    aspect_ratio: options.aspectRatio,
    resolution: options.resolution ?? "1k",
    response_format: "b64_json",
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${options.token}`,
    "X-Grok-Client-Version": options.clientVersion,
    "User-Agent": `omp-grok-build/${options.clientVersion}`,
  };

  const url = imagineUrl(options.baseUrl);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), options.signal);

    const { signal, cleanup } = timeoutSignal(options.signal);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal,
      });
    } catch (err) {
      cleanup();
      lastError = err instanceof Error ? err : new Error(String(err));
      if (options.signal?.aborted) throw lastError;
      continue;
    }
    cleanup();

    if (!response.ok) {
      if (RETRYABLE_STATUS_CODES.has(response.status) || response.status >= 500) {
        lastError = new Error(`Image generation returned HTTP ${response.status}`);
        continue;
      }
      const text = await response.text().catch(() => "");
      throw new Error(`Image generation failed (HTTP ${response.status}): ${text}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Invalid response from image generation API");
    }

    const b64 = extractB64Json(payload);
    if (!b64) {
      throw new Error("Image generation response missing b64_json data");
    }
    return { b64, mimeType: "image/jpeg" };
  }

  throw lastError ?? new Error("Image generation failed after retries");
}
