import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadGrokCliCredentials } from "./auth";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const BILLING_REQUEST_TIMEOUT_MS = 10_000;

export interface BillingUsage {
  monthly: {
    limit: number;
    used: number;
    resetsAt: string;
  };
  weekly?: {
    percentUsed: number;
    resetsAt: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function numericValue(value: unknown): number | undefined {
  const candidate = isRecord(value) ? value.val : value;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate !== "string" || !candidate.trim()) return undefined;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = value.trim();
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

function configFrom(payload: unknown): Record<string, unknown> | undefined {
  return isRecord(payload) && isRecord(payload.config) ? payload.config : undefined;
}

function billingHeaders(token: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
  };
}

function requestOptions(headers: Record<string, string>): RequestInit {
  return {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
  };
}

export async function fetchBillingUsage(token: string, fetchImpl: FetchImpl = fetch): Promise<BillingUsage> {
  const headers = billingHeaders(token);
  let monthlyResponse: Response;
  try {
    monthlyResponse = await fetchImpl(BILLING_URL, requestOptions(headers));
  } catch {
    throw new Error("Grok billing request failed");
  }
  if (!monthlyResponse.ok) throw new Error(`Grok billing endpoint returned HTTP ${monthlyResponse.status}`);

  let monthlyPayload: unknown;
  try {
    monthlyPayload = await monthlyResponse.json();
  } catch {
    throw new Error("Invalid Grok monthly billing response");
  }
  const monthlyConfig = configFrom(monthlyPayload);
  const limit = monthlyConfig ? numericValue(monthlyConfig.monthlyLimit) : undefined;
  const used = monthlyConfig ? numericValue(monthlyConfig.used) : undefined;
  const resetsAt = monthlyConfig ? validTimestamp(monthlyConfig.billingPeriodEnd) : undefined;
  if (limit === undefined || used === undefined || limit < 0 || used < 0 || !resetsAt) {
    throw new Error("Invalid Grok monthly billing response");
  }

  const usage: BillingUsage = { monthly: { limit, used, resetsAt } };
  try {
    const weeklyResponse = await fetchImpl(`${BILLING_URL}?format=credits`, requestOptions(headers));
    if (!weeklyResponse.ok) return usage;

    const weeklyConfig = configFrom(await weeklyResponse.json());
    if (!weeklyConfig) return usage;
    const currentPeriod = isRecord(weeklyConfig.currentPeriod) ? weeklyConfig.currentPeriod : undefined;
    const percentUsed = numericValue(weeklyConfig.creditUsagePercent);
    const weeklyReset = validTimestamp(currentPeriod?.end) ?? validTimestamp(weeklyConfig.billingPeriodEnd);
    if (percentUsed !== undefined && percentUsed >= 0 && percentUsed <= 100 && weeklyReset) {
      usage.weekly = { percentUsed, resetsAt: weeklyReset };
    }
  } catch {
    // Weekly data is optional: malformed, unavailable, or timed-out credits
    // data must not hide the already-parsed monthly balance.
  }
  return usage;
}

const BAR_WIDTH = 20;
const WARNING_USED_FRACTION = 0.8;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Relative duration like `5d5h`, `3h12m`, `45m` (Codex /usage style). */
function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes > 0 ? `${totalHours}h${minutes}m` : `${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

function formatResetMeta(value: string, nowMs: number): { remaining: string; absolute: string } {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return { remaining: value, absolute: value };
  }
  return {
    remaining: formatRemaining(date.getTime() - nowMs),
    absolute: date.toISOString().slice(0, 10),
  };
}

function statusIcon(usedFraction: number): string {
  if (usedFraction >= 1) return "✗";
  if (usedFraction >= WARNING_USED_FRACTION) return "!";
  return "✓";
}

/** Filled bar for *used* fraction (green-ish left fill in monochrome). */
function renderUsedBar(usedFraction: number, width = BAR_WIDTH): string {
  const clamped = clamp01(usedFraction);
  const filled = Math.round(clamped * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatWindow(
  label: string,
  usedFraction: number,
  detail: string | undefined,
  resetsAt: string,
  nowMs: number,
): string[] {
  const freeFraction = clamp01(1 - usedFraction);
  const reset = formatResetMeta(resetsAt, nowMs);
  const identity = "credits";
  const pad = Math.max(1, 34 - identity.length - reset.remaining.length);
  const lines = [
    `${statusIcon(usedFraction)} ${label}`,
    `● ${identity}${" ".repeat(pad)}(${reset.remaining})`,
    `${renderUsedBar(usedFraction)}    ${formatPercent(freeFraction * 100)}% free`,
  ];
  if (detail) lines.push(detail);
  lines.push(`resets in ${reset.remaining} (${reset.absolute})`);
  return lines;
}

export function formatBillingUsage(usage: BillingUsage, nowMs: number = Date.now()): string {
  const monthlyUsedFraction =
    usage.monthly.limit > 0 ? clamp01(usage.monthly.used / usage.monthly.limit) : 0;
  const monthlyRemaining = Math.max(usage.monthly.limit - usage.monthly.used, 0);
  const monthlyDetail =
    `${usage.monthly.used.toLocaleString()} / ${usage.monthly.limit.toLocaleString()} credits used` +
    ` · ${monthlyRemaining.toLocaleString()} remaining`;

  const lines = [
    "Grok Build usage",
    "",
    ...formatWindow(
      "Monthly",
      monthlyUsedFraction,
      monthlyDetail,
      usage.monthly.resetsAt,
      nowMs,
    ),
  ];

  if (usage.weekly) {
    const weeklyUsedFraction = clamp01(usage.weekly.percentUsed / 100);
    lines.push("");
    lines.push(
      ...formatWindow(
        "Weekly",
        weeklyUsedFraction,
        `${formatPercent(usage.weekly.percentUsed)}% used this week`,
        usage.weekly.resetsAt,
        nowMs,
      ),
    );
  }

  return lines.join("\n");
}

const PROVIDER_ID = "grok-build";

export async function resolveUsageToken(ctx: ExtensionContext): Promise<string | undefined> {
  // Prefer OMP's provider auth storage: it covers credentials created by
  // `/login grok-build` and runs them through the provider refresh pipeline,
  // re-minting expired access tokens instead of returning a billing 401.
  try {
    const token = await ctx.modelRegistry?.getApiKeyForProvider(
      PROVIDER_ID,
      ctx.sessionManager?.getSessionId(),
    );
    if (token) return token;
  } catch {
    // Fall through to the local Grok CLI credentials.
  }

  const credentials = await loadGrokCliCredentials();
  return typeof credentials === "string" ? credentials : credentials?.access;
}

export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("grok-build-usage", {
    description: "Show Grok Build subscription usage",
    handler: async (_args, ctx) => {
      const token = await resolveUsageToken(ctx);
      if (!token) throw new Error("No Grok Build login found. Run `/login grok-build` or `grok login`.");
      ctx.ui.notify(formatBillingUsage(await fetchBillingUsage(token)), "info");
    },
  });
}
