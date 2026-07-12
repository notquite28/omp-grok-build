import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";

const DEFAULT_ISSUER = "https://auth.x.ai";
const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEFAULT_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_ENDPOINT = `${DEFAULT_ISSUER}/oauth2/device/code`;
const TOKEN_ENDPOINT = `${DEFAULT_ISSUER}/oauth2/token`;
const GROK_SURFACE = "grok-build";
const EARLY_REFRESH_MS = 5 * 60 * 1000;
const FALLBACK_VERSION = "0.2.93";

interface GrokAuthEntry {
  key?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  email?: unknown;
  oidc_issuer?: unknown;
  oidc_client_id?: unknown;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface OAuthErrorResponse {
  error?: string;
  error_description?: string;
}

export function resolveGrokVersion(): string {
  const configured = process.env.GROK_CLI_VERSION?.trim();
  if (configured) return configured;

  try {
    const result = Bun.spawnSync(["grok", "--version"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const match = result.stdout.toString().match(/\bgrok\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[^\s]+)?)/i);
    return match?.[1] ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export function parseGrokAuth(auth: unknown, now = Date.now()): OAuthCredentials | string | undefined {
  if (!auth || typeof auth !== "object") return undefined;

  const entries = Object.entries(auth as Record<string, unknown>);
  const oidc = entries.find(([scope]) => scope.startsWith(`${DEFAULT_ISSUER}::`));
  const legacy = entries.find(([scope]) => scope === "https://accounts.x.ai/sign-in");
  const selected = (oidc ?? legacy)?.[1];
  if (!selected || typeof selected !== "object") return undefined;

  const entry = selected as GrokAuthEntry;
  if (typeof entry.key !== "string" || !entry.key) return undefined;

  if (typeof entry.refresh_token !== "string" || !entry.refresh_token) return entry.key;

  const parsedExpiry = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : Number.NaN;
  return {
    access: entry.key,
    refresh: entry.refresh_token,
    expires: Number.isFinite(parsedExpiry) ? parsedExpiry : now + 30 * 24 * 60 * 60 * 1000,
    email: typeof entry.email === "string" ? entry.email : undefined,
  };
}

export async function loadGrokCliCredentials(): Promise<OAuthCredentials | string | undefined> {
  const home = process.env.GROK_HOME?.trim() || `${process.env.HOME}/.grok`;
  try {
    return parseGrokAuth(await Bun.file(`${home}/auth.json`).json());
  } catch {
    return undefined;
  }
}

function requestHeaders(version: string): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-grok-client-version": version,
    "x-grok-client-surface": GROK_SURFACE,
  };
}

async function readJson<T>(response: Response, operation: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & OAuthErrorResponse;
  if (!response.ok) {
    const detail = body.error_description || body.error || `HTTP ${response.status}`;
    throw new Error(`${operation} failed: ${detail}`);
  }
  return body;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Authentication cancelled"));

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Authentication cancelled"));
    },
    { once: true },
  );
  return promise;
}

export async function refreshGrokCredentials(
  credentials: OAuthCredentials,
  version = resolveGrokVersion(),
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthCredentials> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: requestHeaders(version),
    body: new URLSearchParams({
      client_id: DEFAULT_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
    }),
  });
  const token = await readJson<TokenResponse>(response, "Grok token refresh");
  return {
    ...credentials,
    access: token.access_token,
    refresh: token.refresh_token || credentials.refresh,
    expires: Date.now() + token.expires_in * 1000,
  };
}

export async function loginToGrok(
  callbacks: OAuthLoginCallbacks,
  version = resolveGrokVersion(),
): Promise<OAuthCredentials | string> {
  const stored = await loadGrokCliCredentials();
  if (typeof stored === "string") {
    callbacks.onProgress?.("Using credentials from the Grok Build CLI");
    return stored;
  }
  if (stored) {
    if (stored.expires > Date.now() + EARLY_REFRESH_MS) {
      callbacks.onProgress?.("Using credentials from the Grok Build CLI");
      return stored;
    }
    try {
      callbacks.onProgress?.("Refreshing Grok Build CLI credentials");
      return await refreshGrokCredentials(stored, version, callbacks.fetch ?? fetch);
    } catch {
      callbacks.onProgress?.("Stored Grok credentials expired; starting device login");
    }
  }

  const fetchImpl = callbacks.fetch ?? fetch;
  const deviceResponse = await fetchImpl(DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: requestHeaders(version),
    body: new URLSearchParams({ client_id: DEFAULT_CLIENT_ID, scope: DEFAULT_SCOPE }),
    signal: callbacks.signal,
  });
  const device = await readJson<DeviceCodeResponse>(deviceResponse, "Grok device authorization");
  callbacks.onAuth({
    url: device.verification_uri_complete || device.verification_uri,
    instructions: `Confirm code ${device.user_code}. Only continue with a code you requested.`,
  });

  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = Math.max(device.interval ?? 5, 1) * 1000;
  callbacks.onProgress?.("Waiting for Grok authorization");

  while (Date.now() < deadline) {
    await delay(intervalMs, callbacks.signal);
    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: requestHeaders(version),
      body: new URLSearchParams({
        client_id: DEFAULT_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: callbacks.signal,
    });
    const body = (await response.json().catch(() => ({}))) as TokenResponse & OAuthErrorResponse;
    if (response.ok && body.access_token) {
      return {
        access: body.access_token,
        refresh: body.refresh_token ?? "",
        expires: Date.now() + body.expires_in * 1000,
      };
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (body.error === "access_denied") throw new Error("Grok authorization was denied");
    if (body.error === "expired_token") throw new Error("Grok device code expired");
    throw new Error(`Grok token exchange failed: ${body.error_description || body.error || `HTTP ${response.status}`}`);
  }

  throw new Error("Grok device code expired");
}
