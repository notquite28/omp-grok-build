import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { generateVideo } from "../src/video/generate";
import { parseVideoArgs } from "../src/video/parseArgs";
import { saveVideo } from "../src/video/save";
import { registerVideoCommand } from "../src/video";
import { generateAndSaveVideo } from "../src/video/workflow";

// Minimal MP4-like bytes (ftyp box header) for save validation.
const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

describe("parseVideoArgs", () => {
  test("parses prompt with duration, resolution, aspect, image, and out", () => {
    const parsed = parseVideoArgs(
      'a cat walking --duration 10 --resolution 720p --aspect 16:9 --image "https://example.com/cat.jpg" --out out.mp4',
    );
    expect(parsed.prompt).toBe("a cat walking");
    expect(parsed.duration).toBe(10);
    expect(parsed.resolution).toBe("720p");
    expect(parsed.aspectRatio).toBe("16:9");
    expect(parsed.imageUrl).toBe("https://example.com/cat.jpg");
    expect(parsed.outPath).toBe("out.mp4");
  });

  test("supports short flags", () => {
    const parsed = parseVideoArgs("sunset -d 6 -r 480p -i https://img.example.com/s.jpg -o vid.mp4");
    expect(parsed.prompt).toBe("sunset");
    expect(parsed.duration).toBe(6);
    expect(parsed.resolution).toBe("480p");
    expect(parsed.imageUrl).toBe("https://img.example.com/s.jpg");
    expect(parsed.outPath).toBe("vid.mp4");
  });

  test("requires a prompt", () => {
    expect(() => parseVideoArgs("")).toThrow(/Prompt is required/);
  });

  test("rejects invalid duration", () => {
    expect(() => parseVideoArgs("test --duration 7")).toThrow(/Invalid duration/);
  });

  test("rejects invalid resolution", () => {
    expect(() => parseVideoArgs("test --resolution 4k")).toThrow(/Invalid resolution/);
  });

  test("rejects invalid aspect ratio", () => {
    expect(() => parseVideoArgs("test --aspect 5:4")).toThrow(/Invalid aspect ratio/);
  });

  test("rejects unknown options", () => {
    expect(() => parseVideoArgs("test --bogus val")).toThrow(/Unknown option/);
  });
});

describe("generateVideo", () => {
  const originalBase = process.env.GROK_BUILD_VIDEO_BASE_URL;
  const originalModel = process.env.GROK_BUILD_VIDEO_MODEL;

  afterEach(() => {
    if (originalBase === undefined) delete process.env.GROK_BUILD_VIDEO_BASE_URL;
    else process.env.GROK_BUILD_VIDEO_BASE_URL = originalBase;
    if (originalModel === undefined) delete process.env.GROK_BUILD_VIDEO_MODEL;
    else process.env.GROK_BUILD_VIDEO_MODEL = originalModel;
  });

  test("submits to CLI proxy and polls until done", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let pollCount = 0;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === "POST") {
        return Response.json({ request_id: "req-123" });
      }
      pollCount += 1;
      if (pollCount < 2) {
        return Response.json({ status: "pending", progress: 50 });
      }
      return Response.json({
        status: "done",
        video: { url: "https://vidgen.x.ai/video.mp4", duration: 6, respect_moderation: true },
        model: "grok-imagine-video",
      });
    }) as FetchImpl;

    const result = await generateVideo({
      token: "tok",
      prompt: "a cat walking",
      duration: 6,
      resolution: "480p",
      clientVersion: "1.0.0",
      fetchImpl: fakeFetch,
      pollIntervalMs: 10,
    });

    expect(result.requestId).toBe("req-123");
    expect(result.videoUrl).toBe("https://vidgen.x.ai/video.mp4");
    expect(result.duration).toBe(6);
    expect(calls[0]?.url).toBe("https://cli-chat-proxy.grok.com/v1/videos/generations");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.model).toBe("grok-imagine-video");
    expect(body.prompt).toBe("a cat walking");
    expect(body.duration).toBe(6);
    expect(body.resolution).toBe("480p");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });

  test("includes image for I2V requests", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === "POST") return Response.json({ request_id: "req-i2v" });
      return Response.json({
        status: "done",
        video: { url: "https://vidgen.x.ai/i2v.mp4", duration: 6 },
      });
    }) as FetchImpl;

    await generateVideo({
      token: "tok",
      prompt: "animate this",
      imageUrl: "https://example.com/img.jpg",
      clientVersion: "1.0.0",
      fetchImpl: fakeFetch,
      pollIntervalMs: 10,
    });

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.image).toEqual({ url: "https://example.com/img.jpg" });
  });

  test("throws on failed status", async () => {
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ request_id: "req-fail" });
      return Response.json({
        status: "failed",
        error: { code: "internal_error", message: "generation exploded" },
      });
    }) as FetchImpl;

    await expect(
      generateVideo({
        token: "tok",
        prompt: "boom",
        clientVersion: "1.0.0",
        fetchImpl: fakeFetch,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow(/generation exploded/);
  });

  test("throws on HTTP error during submit", async () => {
    const fakeFetch = (async () => new Response("forbidden", { status: 403 })) as FetchImpl;

    await expect(
      generateVideo({
        token: "bad-tok",
        prompt: "test",
        clientVersion: "1.0.0",
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe("saveVideo", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("downloads and numbers videos under the session tree", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "omp-video-save-"));
    dirs.push(sessionDir);

    const fakeFetch = (async () => new Response(MP4_BYTES)) as FetchImpl;

    const saved = await saveVideo({
      videoUrl: "https://vidgen.x.ai/video.mp4",
      sessionDir,
      sessionId: "sess-1",
      fetchImpl: fakeFetch,
    });

    expect(saved.absolutePath).toBe(join(sessionDir, "sess-1", "videos", "1.mp4"));
    expect(saved.relativePath).toBe("videos/1.mp4");
    expect(saved.usedFallback).toBe(false);
    expect(await readFile(saved.absolutePath)).toEqual(MP4_BYTES);
  });

  test("falls back to tmp storage without a session", async () => {
    const fakeFetch = (async () => new Response(MP4_BYTES)) as FetchImpl;

    const saved = await saveVideo({
      videoUrl: "https://vidgen.x.ai/video.mp4",
      fetchImpl: fakeFetch,
    });

    expect(saved.usedFallback).toBe(true);
    expect(saved.absolutePath).toContain("omp-grok-build");
    dirs.push(saved.absolutePath.replace(/\/[^/]+$/, ""));
  });

  test("throws on download failure", async () => {
    const fakeFetch = (async () => new Response("not found", { status: 404 })) as FetchImpl;

    await expect(
      saveVideo({ videoUrl: "https://vidgen.x.ai/gone.mp4", fetchImpl: fakeFetch }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("registerVideoCommand", () => {
  test("registers the slash command and video_gen tool", () => {
    const commands: string[] = [];
    let toolName: string | undefined;
    const pi = {
      registerCommand(name: string) {
        commands.push(name);
      },
      registerTool(tool: { name: string }) {
        toolName = tool.name;
      },
      zod: {
        z: {
          object: (shape: unknown) => shape,
          string: () => ({
            describe() {
              return this;
            },
            optional() {
              return this;
            },
          }),
        },
      },
    } as unknown as ExtensionAPI;

    registerVideoCommand(pi);
    expect(commands).toEqual(["grok-build-imagine-video"]);
    expect(toolName).toBe("video_gen");
  });

  test("command generates and saves video via session path", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "omp-video-cmd-"));
    let working: string | undefined;
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const fakeFetch = (async () => new Response(MP4_BYTES)) as FetchImpl;

    const pi = {
      registerCommand(
        _name: string,
        config: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) {
        handler = config.handler;
      },
      registerTool() {},
      zod: {
        z: {
          object: (shape: unknown) => shape,
          string: () => ({
            describe() {
              return this;
            },
            optional() {
              return this;
            },
          }),
        },
      },
    } as unknown as ExtensionAPI;

    registerVideoCommand(pi, {
      generateVideo: async () => ({
        requestId: "req-cmd",
        videoUrl: "https://vidgen.x.ai/cmd.mp4",
        duration: 6,
      }),
      saveVideo: (opts) => saveVideo({ ...opts, fetchImpl: fakeFetch }),
      resolveToken: async () => "tok",
      resolveVersion: () => "9.9.9",
    });
    if (!handler) throw new Error("video command was not registered");

    const notifications: Array<{ message: string; level?: string }> = [];
    await handler("a dog running --duration 6", {
      cwd: sessionDir,
      sessionManager: {
        getSessionFile: () => join(sessionDir, "session.jsonl"),
        getSessionDir: () => sessionDir,
        getSessionId: () => "vid-session",
      },
      ui: {
        notify: (message: string, level?: string) => {
          notifications.push({ message, level });
        },
        setWorkingMessage: (message?: string) => {
          working = message;
        },
      },
    } as unknown as ExtensionCommandContext);

    expect(working).toBeUndefined();
    const infoNote = notifications.find((n) => n.level === "info");
    expect(infoNote?.message).toContain(join(sessionDir, "vid-session", "videos", "1.mp4"));
    expect(await readFile(join(sessionDir, "vid-session", "videos", "1.mp4"))).toEqual(MP4_BYTES);
    await rm(sessionDir, { recursive: true, force: true });
  });
});

describe("generateAndSaveVideo", () => {
  test("uses session persistence and token resolution", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "omp-video-flow-"));
    const fakeFetch = (async () => new Response(MP4_BYTES)) as FetchImpl;

    const saved = await generateAndSaveVideo(
      {
        ctx: {
          cwd: sessionDir,
          sessionManager: {
            getSessionFile: () => join(sessionDir, "s.jsonl"),
            getSessionDir: () => sessionDir,
            getSessionId: () => "abc",
          },
        } as ExtensionCommandContext,
        prompt: "ocean waves",
        duration: 10,
        resolution: "720p",
      },
      {
        generateVideo: async (opts) => {
          expect(opts.token).toBe("from-omp");
          expect(opts.clientVersion).toBe("v-test");
          expect(opts.duration).toBe(10);
          expect(opts.resolution).toBe("720p");
          return { requestId: "req-flow", videoUrl: "https://vidgen.x.ai/flow.mp4", duration: 10 };
        },
        saveVideo: (opts) => saveVideo({ ...opts, fetchImpl: fakeFetch }),
        resolveToken: async () => "from-omp",
        resolveVersion: () => "v-test",
      },
    );

    expect(saved.absolutePath).toBe(join(sessionDir, "abc", "videos", "1.mp4"));
    expect(saved.usedFallback).toBe(false);
    expect(saved.duration).toBe(10);
    expect(saved.videoUrl).toBe("https://vidgen.x.ai/flow.mp4");
    await rm(sessionDir, { recursive: true, force: true });
  });

  test("throws without a token", async () => {
    await expect(
      generateAndSaveVideo(
        {
          ctx: { cwd: "/tmp" } as ExtensionCommandContext,
          prompt: "test",
        },
        {
          generateVideo: async () => ({ requestId: "r", videoUrl: "u", duration: 6 }),
          saveVideo: async () => ({
            absolutePath: "/tmp/1.mp4",
            relativePath: "videos/1.mp4",
            filename: "1.mp4",
            usedFallback: true,
          }),
          resolveToken: async () => undefined,
          resolveVersion: () => "v",
        },
      ),
    ).rejects.toThrow(/No Grok Build login/);
  });
});
