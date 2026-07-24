import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  VALID_VIDEO_ASPECT_RATIOS,
  VALID_VIDEO_RESOLUTIONS,
} from "./generate";
import {
  DEFAULT_VIDEO_DEPENDENCIES,
  generateAndSaveVideo,
  type VideoDependencies,
} from "./workflow";

type VideoGenDetails = {
  path?: string;
  relativePath?: string;
  filename?: string;
  error?: string;
};

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Video Gen error: ${message}` }],
    details: { error: message } satisfies VideoGenDetails,
  };
}

export function registerVideoGenTool(
  pi: ExtensionAPI,
  dependencies: VideoDependencies = DEFAULT_VIDEO_DEPENDENCIES,
): void {
  const { z } = pi.zod;

  pi.registerTool({
    name: "video_gen",
    label: "Video Gen",
    description:
      "Generate a video from a text description (and optionally a source image) using Grok Imagine; returns the saved video's absolute path. For a single video request, call this tool exactly once. Provide an image URL for image-to-video animation.",
    parameters: z.object({
      prompt: z.string().describe("Text description of the video to generate."),
      duration: z
        .string()
        .optional()
        .describe("Video duration in seconds: 6 or 10. Defaults to 6."),
      resolution: z
        .string()
        .optional()
        .describe("Video resolution: 480p, 720p, or 1080p. Defaults to 480p."),
      aspect_ratio: z
        .string()
        .optional()
        .describe("Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, or 2:3."),
      image_url: z
        .string()
        .optional()
        .describe(
          "URL or base64 data URL of a source image to animate (image-to-video). When provided, the video is generated from this image.",
        ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const prompt = params.prompt.trim();
        if (!prompt) throw new Error("Prompt is required");

        let duration: 6 | 10 | undefined;
        if (params.duration) {
          const d = Number(params.duration);
          if (d !== 6 && d !== 10) {
            throw new Error(`Invalid duration "${params.duration}". Valid values: 6, 10`);
          }
          duration = d;
        }

        let resolution: "480p" | "720p" | "1080p" | undefined;
        if (params.resolution) {
          if (!(VALID_VIDEO_RESOLUTIONS as readonly string[]).includes(params.resolution)) {
            throw new Error(
              `Invalid resolution "${params.resolution}". Valid values: ${VALID_VIDEO_RESOLUTIONS.join(", ")}`,
            );
          }
          resolution = params.resolution as typeof resolution;
        }

        let aspectRatio: "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3" | undefined;
        if (params.aspect_ratio) {
          if (!(VALID_VIDEO_ASPECT_RATIOS as readonly string[]).includes(params.aspect_ratio)) {
            throw new Error(
              `Invalid aspect ratio "${params.aspect_ratio}". Valid values: ${VALID_VIDEO_ASPECT_RATIOS.join(", ")}`,
            );
          }
          aspectRatio = params.aspect_ratio as typeof aspectRatio;
        }

        const saved = await generateAndSaveVideo(
          {
            ctx,
            prompt,
            duration,
            resolution,
            aspectRatio,
            imageUrl: params.image_url,
            signal,
          },
          dependencies,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                path: saved.absolutePath,
                filename: saved.filename,
                relative_path: saved.relativePath,
                duration: saved.duration,
                message:
                  "Video generated successfully. Do not repeat the saved path unless the user asks.",
              }),
            },
          ],
          details: {
            path: saved.absolutePath,
            relativePath: saved.relativePath,
            filename: saved.filename,
          } satisfies VideoGenDetails,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
