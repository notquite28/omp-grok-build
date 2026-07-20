/** Shared CLI-proxy client headers (no model id). Safe for discovery. */
export function discoveryHeaders(version: string): Record<string, string> {
  const platform = process.platform === "darwin" ? "macos" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch;
  return {
    "User-Agent": `grok-pager/${version} grok-shell/${version} (${platform}; ${arch})`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-version": version,
    "x-grok-client-identifier": "grok-pager",
  };
}

/**
 * Per-request proxy headers including model routing override.
 * Injected at stream time — never stored on cached model specs.
 */
export function requestHeaders(modelId: string, version: string): Record<string, string> {
  return {
    ...discoveryHeaders(version),
    "x-grok-model-override": modelId,
  };
}

/** Merge Grok proxy headers under caller-supplied request headers. */
export function withGrokRequestHeaders(
  modelId: string,
  version: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    ...requestHeaders(modelId, version),
    ...(extra ?? {}),
  };
}
