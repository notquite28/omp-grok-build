import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import grokBuildExtension from "../src/main";

const originalVersion = process.env.GROK_CLI_VERSION;

afterEach(() => {
  if (originalVersion === undefined) delete process.env.GROK_CLI_VERSION;
  else process.env.GROK_CLI_VERSION = originalVersion;
});

describe("Grok Build provider", () => {
  test("routes only through the CLI entitlement proxy with required headers", async () => {
    process.env.GROK_CLI_VERSION = "9.8.7";
    let registration: { name: string; config: ProviderConfig } | undefined;
    const pi = {
      registerProvider(name: string, config: ProviderConfig) {
        registration = { name, config };
      },
      registerCommand() {},
      on() {},
    } as unknown as ExtensionAPI;

    grokBuildExtension(pi);

    expect(registration?.name).toBe("grok-build");
    expect(registration?.config.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(registration?.config.baseUrl).not.toContain("api.x.ai");
    expect(registration?.config.api).toBe("openai-responses");
    expect(registration?.config.authHeader).toBe(true);
    expect(registration?.config.headers).toBeUndefined();
    expect(registration?.config.models).toBeUndefined();
    expect(registration?.config.fetchDynamicModels).toBeFunction();

    const models = await registration?.config.fetchDynamicModels?.(undefined);
    expect(models?.map((model) => model.id)).toEqual([
      "grok-4.5",
      "grok-composer-2.5-fast",
    ]);
    expect(models?.find((model) => model.id === "grok-4.5")).toMatchObject({
      id: "grok-4.5",
      reasoning: true,
      contextWindow: 500_000,
      maxTokens: 30_000,
      headers: {
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-grok-model-override": "grok-4.5",
        "x-grok-client-version": "9.8.7",
        "x-grok-client-identifier": "grok-pager",
      },
    });
  });
});
