import {
  VALID_VIDEO_ASPECT_RATIOS,
  VALID_VIDEO_DURATIONS,
  VALID_VIDEO_RESOLUTIONS,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoResolution,
} from "./generate";

function tokenize(args: string): string[] {
  const tokens = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) =>
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token,
  );
}

export interface VideoArgs {
  prompt: string;
  duration?: VideoDuration;
  resolution?: VideoResolution;
  aspectRatio?: VideoAspectRatio;
  imageUrl?: string;
  outPath?: string;
}

export function parseVideoArgs(args: string): VideoArgs {
  const tokens = tokenize(args);
  const optionValues = new Map<string, string>();
  const prompt: string[] = [];
  const aliases: Record<string, "duration" | "resolution" | "aspect" | "image" | "out"> = {
    "--duration": "duration",
    "-d": "duration",
    "--resolution": "resolution",
    "-r": "resolution",
    "--aspect": "aspect",
    "--aspect-ratio": "aspect",
    "--image": "image",
    "-i": "image",
    "--out": "out",
    "-o": "out",
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (!token.startsWith("-")) {
      prompt.push(token);
      continue;
    }
    const option = aliases[token];
    if (!option) throw new Error(`Unknown option: ${token}`);
    const value = tokens[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`${token} requires a value`);
    optionValues.set(option, value);
    index += 1;
  }

  if (prompt.length === 0) throw new Error("Prompt is required");

  const result: VideoArgs = { prompt: prompt.join(" ") };

  const durationRaw = optionValues.get("duration");
  if (durationRaw) {
    const duration = Number(durationRaw) as VideoDuration;
    if (!(VALID_VIDEO_DURATIONS as readonly number[]).includes(duration)) {
      throw new Error(`Invalid duration "${durationRaw}". Valid values: ${VALID_VIDEO_DURATIONS.join(", ")}`);
    }
    result.duration = duration;
  }

  const resolutionRaw = optionValues.get("resolution");
  if (resolutionRaw) {
    if (!(VALID_VIDEO_RESOLUTIONS as readonly string[]).includes(resolutionRaw)) {
      throw new Error(`Invalid resolution "${resolutionRaw}". Valid values: ${VALID_VIDEO_RESOLUTIONS.join(", ")}`);
    }
    result.resolution = resolutionRaw as VideoResolution;
  }

  const aspectRaw = optionValues.get("aspect");
  if (aspectRaw) {
    if (!(VALID_VIDEO_ASPECT_RATIOS as readonly string[]).includes(aspectRaw)) {
      throw new Error(`Invalid aspect ratio "${aspectRaw}". Valid values: ${VALID_VIDEO_ASPECT_RATIOS.join(", ")}`);
    }
    result.aspectRatio = aspectRaw as VideoAspectRatio;
  }

  if (optionValues.has("image")) result.imageUrl = optionValues.get("image");
  if (optionValues.has("out")) result.outPath = optionValues.get("out");

  return result;
}
