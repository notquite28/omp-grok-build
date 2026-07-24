import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { parseVideoArgs } from "./parseArgs";
import { registerVideoGenTool } from "./tool";
import {
  DEFAULT_VIDEO_DEPENDENCIES,
  generateAndSaveVideo,
  type VideoDependencies,
} from "./workflow";

export function registerVideoCommand(
  pi: ExtensionAPI,
  dependencies: VideoDependencies = DEFAULT_VIDEO_DEPENDENCIES,
): void {
  pi.registerCommand("grok-build-imagine-video", {
    description:
      "Generate a video with Grok Imagine. Usage: /grok-build-imagine-video <prompt> [--duration 6|10] [--resolution 480p|720p|1080p] [--aspect <ratio>] [--image <url>] [--out <path>]",
    handler: async (args, ctx: ExtensionCommandContext) => {
      let parsed;
      try {
        parsed = parseVideoArgs(args);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }

      ctx.ui.setWorkingMessage("Generating video…");
      try {
        const saved = await generateAndSaveVideo(
          {
            ctx,
            prompt: parsed.prompt,
            duration: parsed.duration,
            resolution: parsed.resolution,
            aspectRatio: parsed.aspectRatio,
            imageUrl: parsed.imageUrl,
            outPath: parsed.outPath,
          },
          dependencies,
        );

        if (saved.usedFallback) {
          ctx.ui.notify(
            "Session storage unavailable; saved video in temporary storage.",
            "warning",
          );
        }

        ctx.ui.notify(
          `Video saved to ${saved.relativePath} (${saved.absolutePath})`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      } finally {
        ctx.ui.setWorkingMessage(undefined);
      }
    },
  });

  registerVideoGenTool(pi, dependencies);
}
