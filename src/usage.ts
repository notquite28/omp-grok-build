import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadGrokCliCredentials } from "./auth";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

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

function numericValue(value: unknown): number | undefined {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>).val : value;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string") {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function configFrom(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") throw new Error("Invalid Grok billing response");
  const config = (payload as Record<string, unknown>).config;
  if (!config || typeof config !== "object") throw new Error("Invalid Grok billing response");
  return config as Record<string, unknown>;
}

function billingHeaders(token: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
  };
}

export async function fetchBillingUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<BillingUsage> {
  const headers = billingHeaders(token);
  const monthlyResponse = await fetchImpl(BILLING_URL, { headers });
  if (!monthlyResponse.ok) throw new Error(`Grok billing endpoint returned HTTP ${monthlyResponse.status}`);
  const monthlyConfig = configFrom(await monthlyResponse.json());
  const limit = numericValue(monthlyConfig.monthlyLimit);
  const used = numericValue(monthlyConfig.used);
  const resetsAt = monthlyConfig.billingPeriodEnd;
  if (limit === undefined || used === undefined || typeof resetsAt !== "string") {
    throw new Error("Invalid Grok monthly billing response");
  }

  const usage: BillingUsage = { monthly: { limit, used, resetsAt } };
  const weeklyResponse = await fetchImpl(`${BILLING_URL}?format=credits`, { headers });
  if (weeklyResponse.ok) {
    const weeklyConfig = configFrom(await weeklyResponse.json());
    const currentPeriod = weeklyConfig.currentPeriod;
    const percentUsed = numericValue(weeklyConfig.creditUsagePercent);
    const weeklyReset =
      currentPeriod && typeof currentPeriod === "object" && typeof (currentPeriod as Record<string, unknown>).end === "string"
        ? (currentPeriod as Record<string, unknown>).end as string
        : weeklyConfig.billingPeriodEnd;
    if (percentUsed !== undefined && typeof weeklyReset === "string") {
      usage.weekly = { percentUsed, resetsAt: weeklyReset };
    }
  }
  return usage;
}

function formatReset(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

export function formatBillingUsage(usage: BillingUsage): string {
  const percent = usage.monthly.limit > 0 ? Math.round((usage.monthly.used / usage.monthly.limit) * 100) : 0;
  const remaining = Math.max(usage.monthly.limit - usage.monthly.used, 0);
  const lines = [
    "Grok Build usage",
    `Monthly: ${usage.monthly.used.toLocaleString()} / ${usage.monthly.limit.toLocaleString()} credits (${percent}% used)`,
    `Remaining: ${remaining.toLocaleString()} credits`,
    `Monthly reset: ${formatReset(usage.monthly.resetsAt)}`,
  ];
  if (usage.weekly) {
    lines.push(
      `Weekly: ${Math.round(usage.weekly.percentUsed)}% used`,
      `Weekly reset: ${formatReset(usage.weekly.resetsAt)}`,
    );
  }
  return lines.join("\n");
}

export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("grok-build-usage", {
    description: "Show Grok Build subscription usage",
    handler: async (_args, ctx) => {
      const credentials = await loadGrokCliCredentials();
      const token = typeof credentials === "string" ? credentials : credentials?.access;
      if (!token) throw new Error("No Grok Build CLI login found. Run `grok login` or `/login grok-build`.");
      ctx.ui.notify(formatBillingUsage(await fetchBillingUsage(token)), "info");
    },
  });
}
