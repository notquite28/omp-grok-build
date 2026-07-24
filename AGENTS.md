# Repository Guidelines

## Project Overview

`omp-ext` is a private Bun + TypeScript workspace that publishes the **Oh My Pi extension marketplace**. It ships **two independent plugins**, each installable separately:

| Plugin | Package | Purpose |
|---|---|---|
| `omp-grok-build` | `plugins/omp-grok-build/` | Grok Build CLI provider — chat/billing via the CLI entitlement proxy, usage bars, and Grok Imagine image/video commands and tools. |
| `omp-rewind` | `plugins/omp-rewind/` | Git checkpoint/rewind — `/rewind`, transactional tree/file restore, durable undo. |

Catalog (`.claude-plugin/marketplace.json`, Claude Code marketplace schema): name `omp-ext`, `metadata.version` `0.3.0`. End users install:

```text
omp install omp-grok-build@omp-ext
omp install omp-rewind@omp-ext
```

The root `package.json` is **workspace-scripts only — NOT an installable extension.** Do not reintroduce root-level `omp.extensions`.

## Architecture & Data Flow

### omp-grok-build — provider plugin

Entry point `src/main.ts` default-exports `grokBuildExtension(pi)` and registers exactly: one provider, one request hook, one usage command, one imagine command, one video command, and two tools.

```text
main.ts (PROVIDER_ID="grok-build", BASE_URL, API_ID="openai-responses")
  ├─ pi.registerProvider("grok-build")   baseUrl=BASE_URL, oauth{login,refreshToken,getApiKey}
  ├─ pi.on("before_provider_request")    → sanitizeProxyPayload (gated on baseUrl===BASE_URL)
  ├─ registerUsageCommand("grok-build-usage")        → GET /v1/billing (proxy host)
  ├─ registerImagineCommand("grok-build-imagine")
  │    └─ registerImageGenTool("image_gen")          → POST proxy/v1/images/generations
  └─ registerVideoCommand("grok-build-imagine-video")
       └─ registerVideoGenTool("video_gen")          → POST proxy/v1/videos/generations + GET poll
```

**Load-bearing base-URL split (do not change):**

| Concern | Host | Source |
|---|---|---|
| Chat / models / billing | `https://cli-chat-proxy.grok.com/v1` | `main.ts:10` `BASE_URL`; `usage.ts:5` `BILLING_URL` |
| Image generation (Imagine) | `https://cli-chat-proxy.grok.com/v1/images/generations` | `imagine/generate.ts:4` `DEFAULT_IMAGINE_BASE_URL` |
| Video generation (Imagine) | `https://cli-chat-proxy.grok.com/v1/videos/generations` | `video/generate.ts:4` `DEFAULT_VIDEO_BASE_URL` |
| OAuth (device code + refresh) | `https://auth.x.ai` | `auth.ts:4` `DEFAULT_ISSUER` |

All generation traffic (chat, image, video, billing) routes through the CLI entitlement proxy. `before_provider_request` **hard-throws** if the request's `baseUrl !== BASE_URL`, so chat can never leak elsewhere. Never switch any concern to public `api.x.ai`.

Request lifecycle: headers are attached **statically** to each model spec at registration time (`requestHeaders(modelId, version)`), so plan-mode subagents keep routing headers after extension APIs unload. At request time, `sanitizeProxyPayload` mutates the payload — strips reasoning from history, maps effort `minimal→low`, drops `reasoning.encrypted_content`, replaces `prompt_cache_retention` with `prompt_cache_key=sessionId`.

Auth (`auth.ts`): xAI OAuth2 device-code grant with refresh-token reuse. Credentials discovered from OMP provider store first, `~/.grok/auth.json` (`$GROK_HOME` override) as fallback. Refresh runs 5 min before expiry (`EARLY_REFRESH_MS`).

### omp-rewind — checkpoint plugin

Two-layer architecture:

```text
src/core.ts   PURE git ops, zero host deps (Node builtins only)
              ├─ refs under refs/pi-checkpoints/<id>
              ├─ createCheckpoint / restoreCheckpoint / load / list / delete / prune
              └─ shell-out spawn("git", …) — no libgit2

src/index.ts  HOST WIRING (default export function(pi))
              ├─ session_* hooks → initSession, resume checkpoint
              ├─ turn tool hooks → createCheckpoint when MUTATING_TOOLS fired
              ├─ /rewind command + session_before_branch/_tree hooks → restore
              └─ footer ◆ N checkpoints

src/commands.ts  /rewind flow (UI-driven, no subcommands), transactional restore
src/state.ts     in-memory singleton; persistence = git refs (no state file)
src/ui.ts        footer renderer
```

**Important:** this plugin does **not** register an `Esc+Esc`/`doubleEscapeAction` keybinding — `index.ts` leaves that to the host. Restore is exposed only via the `/rewind` command and the `session_before_branch` / `session_before_tree` hooks.

Checkpointing triggers after a turn uses any tool in `MUTATING_TOOLS` (`core.ts:66-72`):

```ts
export const MUTATING_TOOLS = new Set(["write", "edit", "bash", "ast_edit", "eval"]);
```

`/rewind` offers restore modes: `all` | `files` | `conversation` | `cancel`. Restore is **transactional** — a `before-restore` safety checkpoint is created first; on failure it rolls back to the safety cp (retained on double-failure). Cross-branch restore throws `Branch mismatch`.

All git-touching hook bodies run through `runRepositoryOperation(state, op)` which serializes onto a FIFO `repositoryTail` promise — the single concurrency-control mechanism.

## Key Directories

| Path | Purpose |
|---|---|
| `.claude-plugin/marketplace.json` | Marketplace catalog (both plugins, `source` → `./plugins/...`) |
| `plugins/omp-grok-build/` | Grok plugin (own `package.json`, `bun.lock`, `tsconfig.json`) |
| `plugins/omp-grok-build/src/` | `main.ts`, `auth.ts`, `models.ts`, `payload.ts`, `usage.ts`, `headers.ts`, `imagine/` |
| `plugins/omp-grok-build/test/` | `provider`, `auth`, `payload`, `usage`, `imagine` tests (`bun:test`) |
| `plugins/omp-rewind/` | Rewind plugin (own `package.json`; no `tsconfig`, no `bun.lock`) |
| `plugins/omp-rewind/src/` | `core.ts`, `index.ts`, `commands.ts`, `state.ts`, `ui.ts` |
| `plugins/omp-rewind/tests/` | `core.test.ts`, `commands.test.ts`, `index.test.ts` (hand-rolled runner) |
| `scripts/validate-marketplace.ts` | Catalog invariant validator |
| `.github/workflows/` | `ci.yml` (4 jobs), `release.yml` (tag gate) |
| `references/` | **Vendored upstream reference only** (`pi-rewind`, `oh-my-pi`) — NOT shipped, not in any `source`/`files[]` |

## Development Commands

```bash
# Everything (root) — chains grok then rewind sequentially
bun run test
bun run validate            # catalog invariants

# omp-grok-build
cd plugins/omp-grok-build
bun install --frozen-lockfile
bun run typecheck           # tsc --noEmit -p tsconfig.json (strict)
bun test                    # bun:test, auto-discovers test/**/*.test.ts

# omp-rewind
cd plugins/omp-rewind
bun run test                # = core.test.ts && commands.test.ts && index.test.ts
# (no typecheck target — no tsconfig; relies on Bun runtime + host types)
```

Root shortcuts: `bun run test:grok`, `bun run test:rewind`. **`typecheck` and `install:all` cover grok only.**

Link a checkout into an explicit live OMP profile:

```bash
# Disable the marketplace copy first so only one plugin instance loads.
omp --profile <profile> plugin disable omp-grok-build@omp-ext
omp --profile <profile> plugin link --force ./plugins/omp-grok-build
omp --profile <profile> plugin disable omp-rewind@omp-ext
omp --profile <profile> plugin link --force ./plugins/omp-rewind

# Restore a marketplace copy after local testing.
omp --profile <profile> plugin uninstall omp-grok-build
omp --profile <profile> plugin install --force omp-grok-build@omp-ext
omp --profile <profile> plugin uninstall omp-rewind
omp --profile <profile> plugin install --force omp-rewind@omp-ext
```

Do not combine `--no-extensions` with `--extension` for local development on OMP 17.1.2: it suppresses the explicit extension too.

## Code Conventions & Common Patterns

- **One concern per file.** Grok: `main`/`auth`/`models`/`payload`/`usage`/`headers.ts` + `imagine/` feature dir. Rewind: `core`/`index`/`commands`/`state`/`ui.ts`.
- **Named exports only** (no default re-exports except the plugin entry default).
- **Constants** `SCREAMING_SNAKE_CASE` (`BASE_URL`, `REF_BASE`, `MUTATING_TOOLS`, `MAX_UNTRACKED_FILE_SIZE`). Functions `camelCase`; types/interfaces `PascalCase`.
- **Dependency injection via `DEFAULT_*_DEPENDENCIES` objects** (grok `imagine/`, network `fetchImpl` params) — this is how tests swap collaborators.
- **AbortSignal-based cancellation everywhere** (`AbortSignal.timeout`, `AbortSignal.any`, `throwIfCancelled` at await boundaries). Numeric thresholds are named module consts (`AUTH_REQUEST_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `EARLY_REFRESH_MS`).
- **Error messages must not leak secrets** — bearer tokens and OAuth `error_description` are redacted (asserted in tests). Throw `new Error(string)` with an operation prefix.
- **No `console`/logger in plugin code.** All user-facing output goes through `ctx.ui.notify(msg, 'info'|'warning'|'error')` and callbacks (`onProgress`).
- **Import boundaries (load-bearing):**
  - `omp-rewind/src/core.ts` — **zero `@oh-my-pi/*` imports and zero relative imports.** It imports only Node builtins (`child_process`, `fs`, `fs/promises`, `os`, `path`). Keep it a leaf module.
  - `omp-rewind` host files (`index.ts`, `commands.ts`, `ui.ts`) import host types **only** from `@oh-my-pi/pi-coding-agent`. Legacy `@mariozechner/pi-coding-agent` must not appear (CI asserts this).
  - Relative imports use the `.js` suffix even for `.ts` source (`./core.js`) — Bun/ESM NodeNext style.
- **Git ops** shell out via `spawn("git", parsedArgs)` with manual quote-aware arg parsing; paths batched (e.g. `add --all` in batches of 100). No `exec`/`sh -c`.
- **Checkpoint ref namespace** stays under `refs/pi-checkpoints/` (shared with upstream pi-rewind). IDs: `turn-<session>-<turn>-<ts>`, `resume-<session>-<ts>`, `before-restore-<session>-<ts>`.

## Important Files

| File | Role |
|---|---|
| `plugins/omp-grok-build/src/main.ts` | Entry; provider + hook + command registration |
| `plugins/omp-grok-build/src/auth.ts` | OAuth device-code/refresh flow, `~/.grok/auth.json` parsing |
| `plugins/omp-grok-build/src/payload.ts` | `sanitizeProxyPayload` — request mutation |
| `plugins/omp-grok-build/src/models.ts` | Static `GROK_CLI_MODELS` (must align with `grok models` / `~/.grok/models_cache.json`) |
| `plugins/omp-grok-build/src/usage.ts` | Billing fetch + ASCII bar renderer; command `grok-build-usage` |
| `plugins/omp-grok-build/src/imagine/*` | `generate.ts` (proxy image caller), `tool.ts` (`image_gen`), `workflow.ts`, `save.ts`, `parseArgs.ts`, `aspect.ts` |
| `plugins/omp-grok-build/src/video/*` | `generate.ts` (proxy video submit + poll), `tool.ts` (`video_gen`), `workflow.ts`, `save.ts` (download), `parseArgs.ts`, `index.ts` (command) |
| `plugins/omp-rewind/src/core.ts` | Pure git core — checkpoint CRUD, restore, prune, compare |
| `plugins/omp-rewind/src/index.ts` | Host wiring — session/turn/tool hooks |
| `plugins/omp-rewind/src/commands.ts` | `/rewind` flow, transactional restore, ancestry resolution |
| `plugins/omp-rewind/src/state.ts` | In-memory `RewindState` + `runRepositoryOperation` FIFO |
| `.claude-plugin/marketplace.json` | Catalog — `plugins[].version` must match each `package.json` |
| `scripts/validate-marketplace.ts` | Enforces catalog ↔ package alignment |

## Runtime/Tooling Preferences

- **Runtime: Bun** (host = Oh My Pi, which is Bun-based). Grok uses `Bun.spawnSync`, `Bun.file`.
- **Package manager: Bun.** Grok has its own `bun.lock`; rewind has no runtime/dev deps needing a lockfile (only `@oh-my-pi/pi-coding-agent` peer/dev).
- **TypeScript:** grok `tsconfig.json` — `strict:true`, `target/module ESNext`, `moduleResolution Bundler`, `noEmit`, `types:[bun-types]`. Rewind has **no tsconfig**.
- **No lint/format config** in this tree (no biome/prettier/eslint). All such hits live under `references/` (vendored upstream, not shipped). Type safety comes from grok's `tsc --noEmit` only.
- **Env vars:** `GROK_HOME`, `GROK_CLI_VERSION`, `GROK_BUILD_IMAGINE_BASE_URL`, `GROK_BUILD_IMAGINE_MODEL`, `GROK_BUILD_VIDEO_BASE_URL`, `GROK_BUILD_VIDEO_MODEL`.

## Testing & QA

**The two plugins use different test harnesses — do not assume `bun:test` everywhere.**

| Plugin | Framework | Runner | Files |
|---|---|---|---|
| `omp-grok-build` | `bun:test` (`describe`/`test`) | `bun test` (auto-discovery) | `test/*.test.ts` |
| `omp-rewind` | **Hand-rolled** (own `assert`/`assertEqual`/`test` helpers, `process.exit` on failure) | explicit `bun tests/core.test.ts && bun tests/commands.test.ts && bun tests/index.test.ts` | `tests/*.test.ts` |

Rewind uses `bun` only as the TS runtime, not as a test harness — there is no `bun:test` import in its tests.

**Mocking patterns:**

- **Grok HTTP** — dependency-injected `FetchImpl` (typed from `@oh-my-pi/pi-ai`) capturing requests into arrays and returning `Response.json(...)`. One `globalThis.fetch` override in `usage.test.ts` (restored in `afterEach`). Retry simulation via counter-based fetch (429 → 200).
- **Grok host** — `ExtensionAPI` object literals cast `as unknown as ExtensionAPI`, capturing registrations into closures (`mockPi()`, `captureHandler()`).
- **Rewind git** — **real `git`** in disposable `mkdtemp(join(tmpdir(), "pi-rewind-test-"))` repos. Failure injected physically: `chmod 0o555` to break `git clean`; a `reference-transaction` hook script to break ref deletion. Cleanup via `rm -rf` in `finally`.
- **Rewind host** — `FakeUI` class (queueable `select`/`confirm`/`notify`), in-memory `ReadonlySessionManager`, one-method `ExtensionAPI` capture.

**`core.test.ts` runs in full isolation** — zero `@oh-my-pi/*` imports (mirrors `core.ts`). Host types appear only in the command/lifecycle integration tests.

**Contracts every suite defends:**

- Grok chat/image/video/billing routes **only** to `cli-chat-proxy.grok.com/v1`, never `api.x.ai`.
- Grok auth/usage errors **never** echo bearer tokens or `error_description`.
- `sanitizeProxyPayload` normalizes reasoning (`minimal→low`), strips reasoning history/encrypted includes, sets `prompt_cache_key`.
- Rewind restore **preserves HEAD + branch tip** while reverting worktree/index trees; cross-branch restore throws `Branch mismatch`.
- Rewind undo git ref consumed **only on success**; pruning protects live `before-restore` undo refs.
- `MUTATING_TOOLS` exactly `{write, edit, bash, ast_edit, eval}` — **not** `read`.

**No coverage tooling** configured (no c8/istanbul/`--coverage`). Coverage is implicit via contract breadth. **No shared helpers/fixtures** across test files — each redefines its own inline.

## Versioning & Releases

- **Plugin versions are independent** (`omp-grok-build` 0.1.x vs `omp-rewind` 0.5.x). Bumping a plugin requires bumping **both** its `package.json` **and** its catalog `plugins[].version` entry (the validator enforces exact match).
- **Marketplace metadata version** (`marketplace.json` `metadata.version` + root `package.json` version) is the release-tag target. A `vX.Y.Z` tag must equal both (CI release gate enforces it). Bump these together when cutting a catalog release tag; bumping a plugin alone does not require a metadata bump unless tagging a release.
- **CI** (`.github/workflows/ci.yml`, 4 jobs on `ubuntu-latest` + Bun latest): `marketplace` (validator + source-path assertion), `omp-grok-build` (install/typecheck/test/manifest smoke), `omp-rewind` (test/manifest smoke incl. legacy-import absence), `ci-ok` aggregate gate.
- **Release** (`.github/workflows/release.yml`, tag `v*.*.*`): installs/types/tests both, validates the catalog, runs the tag-version gate, publishes a `git archive` tar.gz via `softprops/action-gh-release`.

## Non-goals

- Do not merge the two plugins into one `package.json` / one `omp.extensions` entry.
- Do not set catalog `source` back to `"./"` (legacy single-plugin root layout).
- Do not route any grok traffic to public `api.x.ai` — all generation (chat, image, video, billing) goes through `cli-chat-proxy.grok.com`.
- Do not introduce `@oh-my-pi/*` imports into `plugins/omp-rewind/src/core.ts`.
- Do not vendor either plugin into `oh-my-pi` itself; `references/` is read-only upstream reference, not shipped.
