import { afterEach, describe, expect, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { fetchBillingUsage, formatBillingUsage, registerUsageCommand } from "../src/usage";

const MONTHLY_CONFIG = {
  monthlyLimit: { val: 15_000 },
  used: { val: 3_000 },
  billingPeriodEnd: "2026-08-01T00:00:00Z",
};

describe("Grok Build billing", () => {
  test("fetches monthly and weekly subscription usage through bounded proxy requests", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("?format=credits")) {
        return Response.json({
          config: {
            creditUsagePercent: 42,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-07-15T00:00:00Z" },
          },
        });
      }
      return Response.json({ config: MONTHLY_CONFIG });
    }) as FetchImpl;

    const usage = await fetchBillingUsage("subscription-token", fakeFetch);

    expect(requests.map((request) => request.url)).toEqual([
      "https://cli-chat-proxy.grok.com/v1/billing",
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    ]);
    expect(requests.every((request) => {
      const headers = request.init?.headers as Record<string, string>;
      return headers.authorization === "Bearer subscription-token" && headers["x-xai-token-auth"] === "xai-grok-cli";
    })).toBe(true);
    expect(requests.every((request) => request.init?.redirect === "error")).toBe(true);
    expect(requests.every((request) => request.init?.signal instanceof AbortSignal)).toBe(true);
    expect(usage.monthly).toEqual({
      limit: 15_000,
      used: 3_000,
      resetsAt: "2026-08-01T00:00:00Z",
    });
    expect(usage.weekly).toEqual({ percentUsed: 42, resetsAt: "2026-07-15T00:00:00Z" });
    const formatted = formatBillingUsage(usage, Date.parse("2026-07-14T00:00:00Z"));
    expect(formatted).toContain("Grok Build usage");
    expect(formatted).toContain("✓ Monthly");
    expect(formatted).toContain("12,000 remaining");
    expect(formatted).toContain("3,000 / 15,000 credits used");
    expect(formatted).toContain("80% free");
    expect(formatted).toContain("✓ Weekly");
    expect(formatted).toContain("58% free");
    expect(formatted).toMatch(/█+░+/);
    expect(formatted).toContain("resets in");
  });

  test("keeps monthly usage when weekly billing data is malformed", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("?format=credits")) return Response.json({ config: { creditUsagePercent: 101 } });
      return Response.json({ config: MONTHLY_CONFIG });
    }) as FetchImpl;

    const usage = await fetchBillingUsage("subscription-token", fakeFetch);
    expect(usage.monthly).toEqual({ limit: 15_000, used: 3_000, resetsAt: "2026-08-01T00:00:00Z" });
    expect(usage.weekly).toBeUndefined();
  });

  test("omits weekly usage for invalid percentage and reset boundaries", async () => {
    for (const weeklyConfig of [
      { creditUsagePercent: -1, currentPeriod: { end: "2026-07-15T00:00:00Z" } },
      { creditUsagePercent: 10, currentPeriod: { end: "not-a-date" } },
    ]) {
      const fakeFetch = (async (input: string | URL | Request) =>
        String(input).endsWith("?format=credits")
          ? Response.json({ config: weeklyConfig })
          : Response.json({ config: MONTHLY_CONFIG })) as FetchImpl;
      const usage = await fetchBillingUsage("subscription-token", fakeFetch);
      expect(usage.weekly).toBeUndefined();
    }
  });

  test("rejects invalid monthly numeric and reset boundaries", async () => {
    for (const config of [
      { ...MONTHLY_CONFIG, monthlyLimit: { val: " " } },
      { ...MONTHLY_CONFIG, used: { val: -1 } },
      { ...MONTHLY_CONFIG, billingPeriodEnd: "not-a-date" },
    ]) {
      const fakeFetch = (async () => Response.json({ config })) as FetchImpl;
      await expect(fetchBillingUsage("subscription-token", fakeFetch)).rejects.toThrow(
        "Invalid Grok monthly billing response",
      );
    }
  });

  test("keeps errors secret-safe for failed, malformed, and unreachable monthly responses", async () => {
    const failedStatus = (async () => new Response("Bearer secret-token", { status: 503 })) as FetchImpl;
    const invalidJson = (async () => new Response("Bearer secret-token", { status: 200 })) as FetchImpl;
    const unavailable = (async () => { throw new Error("Bearer secret-token"); }) as FetchImpl;

    await expect(fetchBillingUsage("subscription-token", failedStatus)).rejects.toThrow(
      "Grok billing endpoint returned HTTP 503",
    );
    await expect(fetchBillingUsage("subscription-token", invalidJson)).rejects.toThrow(
      "Invalid Grok monthly billing response",
    );
    await expect(fetchBillingUsage("subscription-token", unavailable)).rejects.toThrow("Grok billing request failed");
    for (const fetchImpl of [failedStatus, invalidJson, unavailable]) {
      try {
        await fetchBillingUsage("subscription-token", fetchImpl);
      } catch (error) {
        expect(String(error)).not.toContain("secret-token");
      }
    }
  });
});

describe("grok-build-usage command", () => {
  const realFetch = globalThis.fetch;
  const originalGrokHome = process.env.GROK_HOME;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
  });

  function captureHandler() {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      registerCommand(_name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        handler = config.handler;
      },
    } as unknown as ExtensionAPI;
    registerUsageCommand(pi);
    if (!handler) throw new Error("usage command was not registered");
    return handler;
  }

  function billingFetch(tokens: string[]): FetchImpl {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      tokens.push(headers.authorization);
      if (String(input).endsWith("?format=credits")) {
        return Response.json({
          config: { creditUsagePercent: 10, currentPeriod: { end: "2026-07-15T00:00:00Z" } },
        });
      }
      return Response.json({
        config: { monthlyLimit: { val: 100 }, used: { val: 10 }, billingPeriodEnd: "2026-08-01T00:00:00Z" },
      });
    }) as FetchImpl;
  }

  test("resolves the billing token through OMP provider auth before CLI credentials", async () => {
    const tokens: string[] = [];
    globalThis.fetch = billingFetch(tokens) as unknown as typeof fetch;
    const requestedProviders: string[] = [];
    let notified: string | undefined;

    const handler = captureHandler();
    await handler("", {
      modelRegistry: {
        async getApiKeyForProvider(provider: string) {
          requestedProviders.push(provider);
          return "omp-token";
        },
      },
      sessionManager: { getSessionId: () => "session-1" },
      ui: { notify: (message: string) => { notified = message; } },
    });

    expect(requestedProviders).toEqual(["grok-build"]);
    expect(tokens.every((token) => token === "Bearer omp-token")).toBe(true);
    expect(notified).toContain("Grok Build usage");
  });

  test("errors clearly when neither OMP auth nor CLI credentials resolve a token", async () => {
    process.env.GROK_HOME = `${import.meta.dir}/no-such-grok-home`;
    const handler = captureHandler();
    await expect(
      handler("", {
        modelRegistry: { async getApiKeyForProvider() { return undefined; } },
        sessionManager: { getSessionId: () => "session-1" },
        ui: { notify: () => {} },
      }),
    ).rejects.toThrow("No Grok Build login found");
  });
});
