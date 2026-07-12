import { supportsReasoningEffort } from "./models";

export function sanitizeProxyPayload(
  payload: unknown,
  modelId: string,
  sessionId?: string,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const next = payload as Record<string, unknown>;

  if (Array.isArray(next.input)) {
    next.input = next.input.filter((item) => {
      if (!item || typeof item !== "object") return true;
      const value = item as Record<string, unknown>;
      if (value.type === "reasoning") return false;
      return value.content !== "";
    });
  }

  if (supportsReasoningEffort(modelId)) {
    const reasoning = next.reasoning;
    if (reasoning && typeof reasoning === "object") {
      const value = reasoning as Record<string, unknown>;
      if (value.effort === "minimal") value.effort = "low";
    }
  } else {
    delete next.reasoning;
    delete next.reasoningEffort;
  }

  if (Array.isArray(next.include)) {
    next.include = next.include.filter((item) => item !== "reasoning.encrypted_content");
    if (next.include.length === 0) delete next.include;
  }

  delete next.prompt_cache_retention;
  if (sessionId && !next.prompt_cache_key) next.prompt_cache_key = sessionId;
  return next;
}
