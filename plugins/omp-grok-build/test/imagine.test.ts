import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { normalizeAspectRatio, VALID_ASPECT_RATIOS } from "../src/imagine/aspect";
import { generateImage } from "../src/imagine/generate";
import { registerImagineCommand } from "../src/imagine";
import { parseImagineArgs } from "../src/imagine/parseArgs";
import { saveImage } from "../src/imagine/save";
import { generateAndSaveImage } from "../src/imagine/workflow";

// Minimal JPEG SOI marker used by saveImage validation.
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

describe("imagine aspect ratios", () => {
  test("accepts the original Grok Imagine ratio set including phone ratios", () => {
    expect(normalizeAspectRatio(undefined)).toBe("auto");
    expect(normalizeAspectRatio("16:9")).toBe("16:9");
    expect(normalizeAspectRatio("19.5:9")).toBe("19.5:9");
    expect(VALID_ASPECT_RATIOS).toContain("9:20");
  });

  test("rejects unknown ratios", () => {
    expect(() => normalizeAspectRatio("5:4")).toThrow(/Invalid aspect ratio/);
  });
});

describe("parseImagineArgs", () => {
  test("parses prompt, aspect, out path, and resolution", () => {
    expect(parseImagineArgs('a red fox --aspect 16:9 --out ./out.jpg --resolution 1k')).toEqual({
      prompt: "a red fox",
      aspectRatio: "16:9",
      resolution: "1k",
      outPath: "./out.jpg",
    });
  });

  test("supports quoted prompts and aspect-ratio alias", () => {
    expect(parseImagineArgs('"snowy mountain" --aspect-ratio 1:1')).toEqual({
      prompt: "snowy mountain",
      aspectRatio: "1:1",
      resolution: "1k",
    });
  });

  test("requires a prompt and only 1k resolution", () => {
    expect(() => parseImagineArgs("--aspect 1:1")).toThrow(/Prompt is required/);
    expect(() => parseImagineArgs("cat --resolution 2k")).toThrow(/Only 1k/);
  });
});

describe("saveImage", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("numbers images under the OMP session tree", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "omp-imagine-session-"));
    dirs.push(sessionDir);
    const first = await saveImage({ b64: JPEG_B64, sessionDir, sessionId: "sess-1" });
    const second = await saveImage({ b64: JPEG_B64, sessionDir, sessionId: "sess-1" });
    expect(first.absolutePath).toBe(join(sessionDir, "sess-1", "images", "1.jpg"));
    expect(second.absolutePath).toBe(join(sessionDir, "sess-1", "images", "2.jpg"));
    expect(first.usedFallback).toBe(false);
    expect(first.relativePath).toBe("images/1.jpg");
    expect(await readFile(first.absolutePath)).toEqual(Buffer.from(JPEG_B64, "base64"));
  });

  test("falls back to tmp storage without a session", async () => {
    const fallbackDir = await mkdtemp(join(tmpdir(), "omp-imagine-fallback-"));
    dirs.push(fallbackDir);
    const saved = await saveImage({ b64: JPEG_B64, fallbackDir });
    expect(saved.usedFallback).toBe(true);
    expect(saved.absolutePath.startsWith(fallbackDir)).toBe(true);
  });

  test("rejects non-JPEG payloads", async () => {
    await expect(
      saveImage({ b64: Buffer.from("hello").toString("base64"), outPath: join(tmpdir(), "x.jpg") }),
    ).rejects.toThrow(/valid JPEG/);
  });
});

describe("generateImage", () => {
  const originalBase = process.env.GROK_BUILD_IMAGINE_BASE_URL;
  const originalModel = process.env.GROK_BUILD_IMAGINE_MODEL;

  afterEach(() => {
    if (originalBase === undefined) delete process.env.GROK_BUILD_IMAGINE_BASE_URL;
    else process.env.GROK_BUILD_IMAGINE_BASE_URL = originalBase;
    if (originalModel === undefined) delete process.env.GROK_BUILD_IMAGINE_MODEL;
    else process.env.GROK_BUILD_IMAGINE_MODEL = originalModel;
  });

  test("posts to the CLI proxy with original model defaults and returns b64", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ data: [{ b64_json: JPEG_B64 }] });
    }) as FetchImpl;

    const result = await generateImage({
      token: "tok",
      prompt: "a cat",
      aspectRatio: "16:9",
      clientVersion: "1.2.3",
      fetchImpl: fakeFetch,
    });

    expect(result).toEqual({ b64: JPEG_B64, mimeType: "image/jpeg" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://cli-chat-proxy.grok.com/v1/images/generations");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "grok-imagine-image-quality",
      prompt: "a cat",
      n: 1,
      aspect_ratio: "16:9",
      resolution: "1k",
      response_format: "b64_json",
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["X-Grok-Client-Version"]).toBe("1.2.3");
  });

  test("retries retryable HTTP statuses", async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts += 1;
      if (attempts < 3) return new Response("busy", { status: 429 });
      return Response.json({ data: [{ b64_json: JPEG_B64 }] });
    }) as FetchImpl;

    await expect(
      generateImage({
        token: "tok",
        prompt: "retry me",
        aspectRatio: "auto",
        clientVersion: "1.0.0",
        fetchImpl: fakeFetch,
      }),
    ).resolves.toEqual({ b64: JPEG_B64, mimeType: "image/jpeg" });
    expect(attempts).toBe(3);
  });
});

describe("registerImagineCommand", () => {
  test("registers the slash command and image_gen tool", () => {
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
      sendUserMessage() {},
    } as unknown as ExtensionAPI;

    registerImagineCommand(pi);
    expect(commands).toEqual(["grok-build-imagine"]);
    expect(toolName).toBe("image_gen");
  });

  test("command uses OMP provider auth, session save path, and sendUserMessage", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "omp-imagine-cmd-"));
    let sent: unknown;
    let working: string | undefined;
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;

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
      sendUserMessage(content: unknown) {
        sent = content;
      },
    } as unknown as ExtensionAPI;

    registerImagineCommand(pi, {
      generateImage: async () => ({ b64: JPEG_B64, mimeType: "image/jpeg" }),
      saveImage,
      resolveToken: async () => "omp-token",
      resolveVersion: () => "9.9.9",
    });
    if (!handler) throw new Error("imagine command was not registered");

    const notifications: Array<{ message: string; level?: string }> = [];
    await handler("sunset over water --aspect 16:9", {
      cwd: sessionDir,
      modelRegistry: {
        async getApiKeyForProvider() {
          return "omp-token";
        },
      },
      sessionManager: {
        getSessionFile: () => join(sessionDir, "session.jsonl"),
        getSessionDir: () => sessionDir,
        getSessionId: () => "live-session",
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
    expect(Array.isArray(sent)).toBe(true);
    const parts = sent as Array<{ type: string; data?: string; text?: string }>;
    expect(parts[0]).toMatchObject({ type: "image", data: JPEG_B64, mimeType: "image/jpeg" });
    expect(parts[1]?.text).toContain(join(sessionDir, "live-session", "images", "1.jpg"));
    expect(await readFile(join(sessionDir, "live-session", "images", "1.jpg"))).toEqual(
      Buffer.from(JPEG_B64, "base64"),
    );
    await rm(sessionDir, { recursive: true, force: true });
  });
});

describe("generateAndSaveImage", () => {
  test("uses sessionManager persistence and OMP token resolution", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "omp-imagine-flow-"));
    await mkdir(sessionDir, { recursive: true });

    const saved = await generateAndSaveImage(
      {
        ctx: {
          cwd: sessionDir,
          sessionManager: {
            getSessionFile: () => join(sessionDir, "s.jsonl"),
            getSessionDir: () => sessionDir,
            getSessionId: () => "abc",
          },
        } as ExtensionCommandContext,
        prompt: "mountain",
        aspectRatio: "1:1",
      },
      {
        generateImage: async (opts) => {
          expect(opts.token).toBe("from-omp");
          expect(opts.clientVersion).toBe("v-test");
          return { b64: JPEG_B64, mimeType: "image/jpeg" };
        },
        saveImage,
        resolveToken: async () => "from-omp",
        resolveVersion: () => "v-test",
      },
    );

    expect(saved.absolutePath).toBe(join(sessionDir, "abc", "images", "1.jpg"));
    expect(saved.usedFallback).toBe(false);
    await rm(sessionDir, { recursive: true, force: true });
  });
});
