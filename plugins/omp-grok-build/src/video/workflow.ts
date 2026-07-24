import { isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveGrokVersion } from "../auth";
import { resolveUsageToken } from "../usage";
import { generateVideo, type VideoAspectRatio, type VideoDuration, type VideoResolution } from "./generate";
import { saveVideo, type SavedVideo } from "./save";

export const VIDEO_AUTH_ERROR =
  "No Grok Build login found. Run `/login grok-build` or `grok login`.";

export type VideoDependencies = {
  generateVideo: typeof generateVideo;
  saveVideo: typeof saveVideo;
  resolveToken: typeof resolveUsageToken;
  resolveVersion: typeof resolveGrokVersion;
};

export const DEFAULT_VIDEO_DEPENDENCIES: VideoDependencies = {
  generateVideo,
  saveVideo,
  resolveToken: resolveUsageToken,
  resolveVersion: resolveGrokVersion,
};

export type SavedGrokVideo = SavedVideo & {
  videoUrl: string;
  duration: number;
};

export async function generateAndSaveVideo(
  options: {
    ctx: ExtensionContext;
    prompt: string;
    duration?: VideoDuration;
    resolution?: VideoResolution;
    aspectRatio?: VideoAspectRatio;
    imageUrl?: string;
    signal?: AbortSignal;
    outPath?: string;
  },
  dependencies: VideoDependencies = DEFAULT_VIDEO_DEPENDENCIES,
): Promise<SavedGrokVideo> {
  const token = await dependencies.resolveToken(options.ctx);
  if (!token) throw new Error(VIDEO_AUTH_ERROR);

  const generated = await dependencies.generateVideo({
    token,
    prompt: options.prompt,
    duration: options.duration,
    resolution: options.resolution,
    aspectRatio: options.aspectRatio,
    imageUrl: options.imageUrl,
    clientVersion: dependencies.resolveVersion(),
    signal: options.signal,
  });

  const persisted = options.ctx.sessionManager?.getSessionFile?.() !== undefined;
  const sessionDir = persisted ? options.ctx.sessionManager.getSessionDir() : undefined;
  const sessionId = persisted ? options.ctx.sessionManager.getSessionId() : undefined;

  const resolvedOut = options.outPath
    ? isAbsolute(options.outPath)
      ? options.outPath
      : resolve(options.ctx.cwd, options.outPath)
    : undefined;

  const saved = await dependencies.saveVideo({
    videoUrl: generated.videoUrl,
    sessionDir,
    sessionId,
    outPath: resolvedOut,
    signal: options.signal,
  });

  return {
    ...saved,
    videoUrl: generated.videoUrl,
    duration: generated.duration,
  };
}
