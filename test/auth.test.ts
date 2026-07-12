import { describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import { parseGrokAuth, refreshGrokCredentials } from "../src/auth";

describe("parseGrokAuth", () => {
  test("prefers refreshable OIDC credentials over a legacy token", () => {
    const expires = "2026-07-12T12:00:00.000Z";
    const credentials = parseGrokAuth({
      "https://accounts.x.ai/sign-in": { key: "legacy-token" },
      "https://auth.x.ai::client-id": {
        key: "oidc-access",
        refresh_token: "oidc-refresh",
        expires_at: expires,
        email: "user@example.com",
      },
    });

    expect(credentials).toEqual({
      access: "oidc-access",
      refresh: "oidc-refresh",
      expires: Date.parse(expires),
      email: "user@example.com",
    });
  });

  test("accepts the legacy CLI token format", () => {
    expect(
      parseGrokAuth({
        "https://accounts.x.ai/sign-in": { key: "legacy-token" },
      }),
    ).toBe("legacy-token");
  });

  test("rejects malformed credential files", () => {
    expect(parseGrokAuth(null)).toBeUndefined();
    expect(parseGrokAuth({ "https://auth.x.ai::client-id": { key: "" } })).toBeUndefined();
  });
});

describe("refreshGrokCredentials", () => {
  test("uses the xAI CLI token endpoint and preserves a non-rotated refresh token", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ access_token: "new-access", expires_in: 3600 });
    }) as typeof fetch;
    const current: OAuthCredentials = {
      access: "old-access",
      refresh: "old-refresh",
      expires: 1,
    };

    const refreshed = await refreshGrokCredentials(current, "0.2.93", fakeFetch);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://auth.x.ai/oauth2/token");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toMatchObject({
      "x-grok-client-version": "0.2.93",
      "x-grok-client-surface": "grok-build",
    });
    expect(String(requests[0]?.init?.body)).toContain("grant_type=refresh_token");
    expect(String(requests[0]?.init?.body)).toContain("refresh_token=old-refresh");
    expect(refreshed.access).toBe("new-access");
    expect(refreshed.refresh).toBe("old-refresh");
    expect(refreshed.expires).toBeGreaterThan(Date.now() + 3_500_000);
  });
});
