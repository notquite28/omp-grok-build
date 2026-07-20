import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { withGrokRequestHeaders } from "../src/headers";
import grokBuildExtension from "../src/main";

const originalVersion = process.env.GROK_CLI_VERSION;
const BASE_URL = "https://cli-chat-proxy.grok.com/v1";
type ProviderHook = (
  event: { payload: unknown },
  ctx: {
    model?: {
      provider?: string;
      baseUrl?: string;
      thinking?: { efforts?: string[] };
    };
    sessionManager?: { getSessionId(): string | undefined };
  },
) => unknown;

afterEach(() => {
  if (originalVersion === undefined) delete process.env.GROK_CLI_VERSION;
  else process.env.GROK_CLI_VERSION = originalVersion;
});

function mockPi(): {
  pi: ExtensionAPI;
  registration: { name: string; config: ProviderConfig } | undefined;
  getRegistration(): { name: string; config: ProviderConfig } | undefined;
} {
  let registration: { name: string; config: ProviderConfig } | undefined;
  const pi = {
    registerProvider(name: string, config: ProviderConfig) {
      registration = { name, config };
    },
    registerCommand() {},
    registerTool() {},
    zod: {
      z: {
        object: () => ({}),
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
    on() {},
  } as unknown as ExtensionAPI;
  return {
    pi,
    get registration() {
      return registration;
    },
    getRegistration() {
      return registration;
    },
  };
}

describe("Grok Build provider", () => {
  test("routes only through the CLI entitlement proxy with cache-safe models", async () => {
    process.env.GROK_CLI_VERSION = "9.8.7";
    const { pi, getRegistration } = mockPi();

    grokBuildExtension(pi);
    const registration = getRegistration();

    expect(registration?.name).toBe("grok-build");
    expect(registration?.config.baseUrl).toBe(BASE_URL);
    expect(registration?.config.baseUrl).not.toContain("api.x.ai");
    expect(registration?.config.api).toBe("grok-build-responses");
    expect(registration?.config.authHeader).toBe(true);
    expect(registration?.config.headers).toBeUndefined();
    expect(registration?.config.models).toBeUndefined();
    expect(registration?.config.streamSimple).toEqual(expect.any(Function));
    expect(registration?.config.fetchDynamicModels).toEqual(expect.any(Function));

    const discovered = await registration?.config.fetchDynamicModels?.(undefined);
    expect(discovered?.map((model) => model.id)).toEqual(["grok-4.5"]);
    const model = discovered?.find((entry) => entry.id === "grok-4.5");
    expect(model).toMatchObject({
      id: "grok-4.5",
      reasoning: true,
      contextWindow: 500_000,
      maxTokens: 30_000,
      compat: { promptCacheSessionHeader: "x-grok-conv-id", supportsReasoningEffort: true },
    });
    // Cache-safe: no per-model headers (host drops header-bearing dynamic models offline).
    expect(model?.headers).toBeUndefined();
  });

  test("fetchDynamicModels surfaces live proxy catalog entries", async () => {
    process.env.GROK_CLI_VERSION = "9.8.7";
    const { pi, getRegistration } = mockPi();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer live-key",
        "x-grok-client-version": "9.8.7",
        "X-XAI-Token-Auth": "xai-grok-cli",
      });
      return Response.json({
        data: [
          {
            id: "grok-5",
            name: "Grok 5",
            context_window: 750_000,
            supports_reasoning_effort: true,
            reasoning_efforts: [{ value: "high" }, { value: "xhigh" }],
          },
        ],
      });
    }) as typeof fetch;

    try {
      grokBuildExtension(pi);
      const discovered = await getRegistration()?.config.fetchDynamicModels?.("live-key");
      expect(discovered?.map((model) => model.id)).toEqual(["grok-5"]);
      expect(discovered?.[0]).toMatchObject({
        id: "grok-5",
        name: "Grok 5",
        reasoning: true,
        contextWindow: 750_000,
        thinking: { mode: "effort", efforts: ["high", "xhigh"] },
      });
      expect(discovered?.[0]?.headers).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("request headers inject proxy routing override without caching on models", () => {
    const headers = withGrokRequestHeaders("grok-4.5", "9.8.7", { "x-extra": "1" });
    expect(headers).toMatchObject({
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-model-override": "grok-4.5",
      "x-grok-client-version": "9.8.7",
      "x-grok-client-identifier": "grok-pager",
      "x-extra": "1",
    });
    expect(headers["User-Agent"]).toContain("grok-pager/9.8.7");
  });

  test("sanitizes only canonical Grok Build requests", () => {
    let hook: ProviderHook | undefined;
    const pi = {
      registerProvider() {},
      registerCommand() {},
      registerTool() {},
      zod: {
        z: {
          object: () => ({}),
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
      on(_event: string, handler: ProviderHook) {
        hook = handler;
      },
    } as unknown as ExtensionAPI;

    grokBuildExtension(pi);
    expect(hook).toBeDefined();

    const otherPayload = { reasoning: { effort: "high", summary: "auto" } };
    expect(
      hook?.({ payload: otherPayload }, { model: { provider: "other", baseUrl: "https://example.com/v1" } }),
    ).toBeUndefined();
    expect(otherPayload).toEqual({ reasoning: { effort: "high", summary: "auto" } });

    const payload = { reasoning: { effort: "minimal", summary: "auto" }, prompt_cache_retention: "24h" };
    expect(
      hook?.(
        { payload },
        {
          model: { provider: "grok-build", baseUrl: BASE_URL, thinking: { efforts: ["low", "high"] } },
          sessionManager: { getSessionId: () => "session-123" },
        },
      ),
    ).toEqual({ reasoning: { effort: "low" }, prompt_cache_key: "session-123" });

    expect(() =>
      hook?.({ payload: {} }, { model: { provider: "grok-build", baseUrl: "https://example.com/v1" } }),
    ).toThrow(`Grok Build requests require the canonical base URL ${BASE_URL}`);
  });
});
