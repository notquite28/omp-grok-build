import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";

const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;

async function nextVideoPath(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const indexes = (await fs.readdir(directory))
    .map((name) => name.match(/^(\d+)\.mp4$/i)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  return join(directory, `${Math.max(0, ...indexes) + 1}.mp4`);
}

async function writeNumberedVideo(directory: string, bytes: Buffer): Promise<string> {
  const videoPath = await nextVideoPath(directory);
  try {
    await fs.writeFile(videoPath, bytes, { flag: "wx" });
    return videoPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return writeNumberedVideo(directory, bytes);
    }
    throw error;
  }
}

export interface SavedVideo {
  absolutePath: string;
  relativePath: string;
  filename: string;
  usedFallback: boolean;
}

/**
 * Download a video from its URL and persist it to the session tree
 * (or tmp fallback / explicit out path).
 */
export async function saveVideo(options: {
  videoUrl: string;
  sessionDir?: string;
  sessionId?: string;
  outPath?: string;
  fallbackDir?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
}): Promise<SavedVideo> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("video download timed out")),
    VIDEO_DOWNLOAD_TIMEOUT_MS,
  );
  const onParentAbort = () =>
    controller.abort(options.signal?.reason instanceof Error ? options.signal.reason : new Error("cancelled"));
  if (options.signal?.aborted) onParentAbort();
  else options.signal?.addEventListener("abort", onParentAbort, { once: true });

  let response: Response;
  try {
    response = await fetchImpl(options.videoUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }

  if (!response.ok) {
    throw new Error(`Video download failed (HTTP ${response.status})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("Video download returned no data");
  }

  const usedFallback = !options.outPath && (!options.sessionDir || !options.sessionId);
  const absolutePath = options.outPath
    ? resolve(options.outPath)
    : await writeNumberedVideo(
        options.sessionDir && options.sessionId
          ? join(options.sessionDir, options.sessionId, "videos")
          : (options.fallbackDir ?? join(tmpdir(), "omp-grok-build", "videos")),
        bytes,
      );

  await fs.mkdir(dirname(absolutePath), { recursive: true });
  if (options.outPath) await fs.writeFile(absolutePath, bytes);

  const filename = basename(absolutePath);
  return {
    absolutePath,
    relativePath: options.outPath
      ? isAbsolute(options.outPath)
        ? options.outPath
        : resolve(options.outPath)
      : `videos/${filename}`,
    filename,
    usedFallback,
  };
}
