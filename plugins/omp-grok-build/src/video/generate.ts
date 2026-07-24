import type { FetchImpl } from "@oh-my-pi/pi-ai";

const DEFAULT_VIDEO_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const DEFAULT_VIDEO_MODEL = "grok-imagine-video";
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_TIME_MS = 10 * 60_000;

export const VALID_VIDEO_DURATIONS = [6, 10] as const;
export type VideoDuration = (typeof VALID_VIDEO_DURATIONS)[number];

export const VALID_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export type VideoResolution = (typeof VALID_VIDEO_RESOLUTIONS)[number];

export const VALID_VIDEO_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
] as const;
export type VideoAspectRatio = (typeof VALID_VIDEO_ASPECT_RATIOS)[number];

function videoUrl(baseUrl?: string): string {
  const root = (baseUrl ?? process.env["GROK_BUILD_VIDEO_BASE_URL"] ?? DEFAULT_VIDEO_BASE_URL)
    .replace(/\/+$/, "");
  return root.endsWith("/videos/generations") ? root : `${root}/videos/generations`;
}

function videoStatusUrl(requestId: string, baseUrl?: string): string {
  const root = (baseUrl ?? process.env["GROK_BUILD_VIDEO_BASE_URL"] ?? DEFAULT_VIDEO_BASE_URL)
    .replace(/\/+$/, "");
  const base = root.endsWith("/videos/generations") ? root.slice(0, -"/generations".length) : root;
  return `${base}/videos/${requestId}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("cancelled"));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("cancelled"));
    },
    { once: true },
  );
  return promise;
}

function timeoutSignal(parent?: AbortSignal, ms = REQUEST_TIMEOUT_MS): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("request timed out")),
    ms,
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

export interface VideoGenerationResult {
  requestId: string;
  videoUrl: string;
  duration: number;
}

export interface VideoSubmitOptions {
  token: string;
  prompt: string;
  duration?: VideoDuration;
  resolution?: VideoResolution;
  aspectRatio?: VideoAspectRatio;
  /** Image URL or base64 data URL for image-to-video. */
  imageUrl?: string;
  clientVersion: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
  /** Poll interval in ms (default 5000). Injectable for tests. */
  pollIntervalMs?: number;
}

/**
 * Submit a video generation request and poll until complete.
 * Returns the video URL on success.
 */
export async function generateVideo(options: VideoSubmitOptions): Promise<VideoGenerationResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = process.env["GROK_BUILD_VIDEO_MODEL"] ?? DEFAULT_VIDEO_MODEL;

  const body: Record<string, unknown> = {
    model,
    prompt: options.prompt,
    duration: options.duration ?? 6,
    resolution: options.resolution ?? "480p",
  };
  if (options.aspectRatio) body["aspect_ratio"] = options.aspectRatio;
  if (options.imageUrl) body["image"] = { url: options.imageUrl };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${options.token}`,
    "X-Grok-Client-Version": options.clientVersion,
    "User-Agent": `omp-grok-build/${options.clientVersion}`,
  };

  // Submit
  const { signal: submitSignal, cleanup: submitCleanup } = timeoutSignal(options.signal);
  let submitResponse: Response;
  try {
    submitResponse = await fetchImpl(videoUrl(options.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: submitSignal,
    });
  } catch (err) {
    submitCleanup();
    throw err instanceof Error ? err : new Error(String(err));
  }
  submitCleanup();

  if (!submitResponse.ok) {
    const text = await submitResponse.text().catch(() => "");
    throw new Error(`Video generation failed (HTTP ${submitResponse.status}): ${text}`);
  }

  let submitPayload: unknown;
  try {
    submitPayload = await submitResponse.json();
  } catch {
    throw new Error("Invalid response from video generation API");
  }

  const requestId =
    submitPayload && typeof submitPayload === "object" && "request_id" in submitPayload
      ? (submitPayload as { request_id: unknown }).request_id
      : undefined;
  if (typeof requestId !== "string" || !requestId) {
    throw new Error("Video generation response missing request_id");
  }

  // Poll
  const statusUrl = videoStatusUrl(requestId, options.baseUrl);
  const deadline = Date.now() + MAX_POLL_TIME_MS;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("cancelled");
    }

    await sleep(options.pollIntervalMs ?? POLL_INTERVAL_MS, options.signal);

    const { signal: pollSignal, cleanup: pollCleanup } = timeoutSignal(options.signal);
    let pollResponse: Response;
    try {
      pollResponse = await fetchImpl(statusUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.token}`,
          "X-Grok-Client-Version": options.clientVersion,
          "User-Agent": `omp-grok-build/${options.clientVersion}`,
        },
        signal: pollSignal,
      });
    } catch (err) {
      pollCleanup();
      throw err instanceof Error ? err : new Error(String(err));
    }
    pollCleanup();

    if (!pollResponse.ok) {
      const text = await pollResponse.text().catch(() => "");
      throw new Error(`Video status check failed (HTTP ${pollResponse.status}): ${text}`);
    }

    let pollPayload: unknown;
    try {
      pollPayload = await pollResponse.json();
    } catch {
      throw new Error("Invalid response from video status API");
    }

    if (!pollPayload || typeof pollPayload !== "object") {
      throw new Error("Invalid video status response");
    }

    const status = (pollPayload as Record<string, unknown>).status;

    if (status === "done") {
      const video = (pollPayload as Record<string, unknown>).video as Record<string, unknown> | undefined;
      const url = video?.url;
      if (typeof url !== "string" || !url) {
        throw new Error("Video generation completed but no video URL returned");
      }
      const duration = typeof video?.duration === "number" ? video.duration : 0;
      return { requestId, videoUrl: url, duration };
    }

    if (status === "failed") {
      const error = (pollPayload as Record<string, unknown>).error as Record<string, unknown> | undefined;
      const message = error?.message ?? "unknown error";
      throw new Error(`Video generation failed: ${message}`);
    }

    // status === "pending" — continue polling
  }

  throw new Error("Video generation timed out");
}
