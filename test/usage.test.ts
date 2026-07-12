import { describe, expect, test } from "bun:test";
import { fetchBillingUsage, formatBillingUsage } from "../src/usage";

describe("Grok Build billing", () => {
  test("fetches monthly and weekly subscription usage from the CLI proxy", async () => {
    const requests: Array<{ url: string; authorization?: string; tokenAuth?: string }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const url = String(input);
      requests.push({
        url,
        authorization: headers.authorization,
        tokenAuth: headers["x-xai-token-auth"],
      });
      if (url.endsWith("?format=credits")) {
        return Response.json({
          config: {
            creditUsagePercent: 42,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-07-15T00:00:00Z" },
          },
        });
      }
      return Response.json({
        config: {
          monthlyLimit: { val: 15_000 },
          used: { val: 3_000 },
          billingPeriodEnd: "2026-08-01T00:00:00Z",
        },
      });
    }) as typeof fetch;

    const usage = await fetchBillingUsage("subscription-token", fakeFetch);

    expect(requests.map((request) => request.url)).toEqual([
      "https://cli-chat-proxy.grok.com/v1/billing",
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    ]);
    expect(requests.every((request) => request.authorization === "Bearer subscription-token")).toBe(true);
    expect(requests.every((request) => request.tokenAuth === "xai-grok-cli")).toBe(true);
    expect(usage.monthly).toEqual({
      limit: 15_000,
      used: 3_000,
      resetsAt: "2026-08-01T00:00:00Z",
    });
    expect(usage.weekly).toEqual({ percentUsed: 42, resetsAt: "2026-07-15T00:00:00Z" });
    expect(formatBillingUsage(usage)).toContain("12,000 credits");
  });
});
