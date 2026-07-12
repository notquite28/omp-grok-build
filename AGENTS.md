# Repository Guidelines

## Project Overview

`omp-grok-build` is an **Oh My Pi** extension that lets OMP use a **Grok Build CLI subscription** through the CLI entitlement proxy, not the public xAI API.

It registers provider `grok-build`, reuses or obtains Grok CLI OAuth credentials, discovers live Grok CLI models from the proxy, sanitizes Responses API payloads for proxy compatibility, and adds `/grok-build-usage` for subscription billing data.

Do **not** route inference or billing to `https://api.x.ai`; this project intentionally targets:

```text
https://cli-chat-proxy.grok.com/v1
```

## Architecture & Data Flow

```text
OMP host
  └─ package.json → omp.extensions → src/main.ts
       ├─ registerProvider("grok-build")
       │    ├─ baseUrl: https://cli-chat-proxy.grok.com/v1
       │    ├─ api: openai-responses
       │    ├─ oauth: loginToGrok / refreshGrokCredentials / getApiKey
       │    └─ fetchDynamicModels → GET /v1/models
       ├─ on("before_provider_request") → sanitizeProxyPayload
       └─ registerCommand("grok-build-usage") → GET /v1/billing
```

**Authentication (`src/auth.ts`)**

1. Prefer existing Grok CLI credentials from `$GROK_HOME/auth.json` or `~/.grok/auth.json`.
2. Current OIDC entries (`https://auth.x.ai::…`) win over legacy `https://accounts.x.ai/sign-in` entries.
3. Refresh near-expiry OAuth credentials through `https://auth.x.ai/oauth2/token`.
4. If no usable credential exists, start xAI device-code OAuth with client id `b1a00492-073a-47ea-816f-4c329264a828` and scope `openid profile email offline_access grok-cli:access api:access`.
5. Preserve old refresh tokens when xAI does not rotate them.

**Request path**

1. OMP builds an OpenAI Responses request for provider `grok-build`.
2. `before_provider_request` is provider-gated and calls `sanitizeProxyPayload`.
3. Sanitization removes proxy-incompatible fields: replayed reasoning items, empty content items, encrypted reasoning include, unsupported reasoning effort, and `prompt_cache_retention`.
4. Model-specific Grok CLI headers are sent with each discovered model:
   - `User-Agent: grok-pager/<version> grok-shell/<version> (...)`
   - `X-XAI-Token-Auth: xai-grok-cli`
   - `x-grok-model-override: <model>`
   - `x-grok-client-version: <version>`
   - `x-grok-client-identifier: grok-pager`

**Model discovery (`src/models.ts`)**

- Live catalog: `GET https://cli-chat-proxy.grok.com/v1/models` with Grok CLI OAuth token.
- Static fallback: `grok-4.5` and `grok-composer-2.5-fast`, matching observed Grok CLI parity.
- Current Grok CLI display label “Composer 2.5” maps to id `grok-composer-2.5-fast`; do not replace it with hidden proxy alias `composer-2.5`.

**Usage path (`src/usage.ts`)**

- Monthly usage: `GET /v1/billing`.
- Weekly credits: `GET /v1/billing?format=credits`.
- Missing weekly data is non-fatal; malformed monthly data is fatal.

## Key Directories

| Path | Purpose |
| --- | --- |
| `src/` | Extension runtime: provider registration, auth, dynamic models, payload sanitation, billing command |
| `test/` | Bun unit tests for auth, provider registration/model headers, and billing usage |
| `.claude-plugin/` | Marketplace catalog metadata |
| Root | `package.json`, `bun.lock`, this guide |

No `docs/`, `scripts/`, `assets/`, `.github/`, README, changelog, lint config, or build config currently exists.

## Development Commands

```bash
bun test                              # run all tests
bun test test/auth.test.ts            # focused test file
bun test -t "parseGrokAuth"           # focused test name/pattern
omp install . --force                 # link local extension into current OMP profile
omp -p '/extensions'                  # verify extension surfaces loaded
omp models refresh                    # refresh dynamic model cache
omp models grok-build                 # list Grok Build models
omp --model grok-build/grok-4.5 -p "hi" # smoke-test provider
```

CI exists under `.github/workflows/`: `ci.yml` runs Bun tests on pushes/PRs to `master`; `release.yml` runs tests and creates GitHub releases for `v*.*.*` tags. There are no build, lint, format, or typecheck scripts.

## Code Conventions & Common Patterns

**Modules**

- One concern per file:
  - `src/main.ts` — extension entry and provider wiring
  - `src/auth.ts` — Grok CLI credential import, device OAuth, refresh, version detection
  - `src/models.ts` — static fallback catalog and live proxy model mapping
  - `src/payload.ts` — in-place Responses payload sanitation
  - `src/usage.ts` — billing fetch/format and slash command registration
- Default export only for the extension factory in `src/main.ts`.
- Use named exports for helpers tested directly.

**Naming**

- Provider id: `grok-build`.
- Command id: `grok-build-usage`.
- Constants: `SCREAMING_SNAKE` for auth/proxy constants.
- Interfaces describe external payload shapes (`GrokCliModel`, `BillingUsage`, OAuth response shapes).

**External boundaries**

- Parse untrusted JSON as `unknown` and narrow with runtime guards.
- Keep proxy/OAuth response parsing tolerant where safe: missing auth file or failed model fetch falls back; bad OAuth/billing essentials throw operator-facing `Error`s.
- Never log or commit tokens from `~/.grok/auth.json`.

**Async and DI**

- Network helpers accept injectable `fetchImpl` for tests (`refreshGrokCredentials`, `fetchGrokCliModels`, `fetchBillingUsage`).
- Use `Promise.withResolvers()` for custom promises; do not introduce `new Promise((resolve, reject) => ...)` unless an API requires executor form.
- Device-code polling must respect `AbortSignal` and handle `authorization_pending`, `slow_down`, `access_denied`, and `expired_token`.

**Bun/runtime APIs**

- Bun is intentional: `Bun.file(...).json()` reads Grok auth; `Bun.spawnSync` resolves `grok --version`.
- Prefer Bun-compatible TypeScript/ESM patterns; package is `"type": "module"`.

**Payload mutation**

- `sanitizeProxyPayload` mutates the host payload in place. Keep changes surgical and provider-gated in `src/main.ts`.
- Do not add shims to public `api.x.ai`; proxy quirks belong in `src/payload.ts`.

## Important Files

| File | Role |
| --- | --- |
| `package.json` | OMP extension manifest, peer dependency, `bun test` script |
| `bun.lock` | Bun lockfile for workspace/peer dependency graph |
| `.claude-plugin/marketplace.json` | Marketplace catalog pointing to this package root |
| `src/main.ts` | Extension factory: provider, request hook, usage command |
| `src/auth.ts` | Grok CLI auth import, OAuth device login, refresh, version detection |
| `src/models.ts` | Static fallback models plus live `/v1/models` mapping |
| `src/payload.ts` | Grok proxy payload sanitizer |
| `src/usage.ts` | Billing endpoint client and `/grok-build-usage` command |
| `test/auth.test.ts` | Auth parsing and refresh-token request contracts |
| `test/provider.test.ts` | Provider registration, proxy URL, dynamic model/header contracts |
| `test/usage.test.ts` | Billing URL/header/parsing/formatting contracts |

## Runtime/Tooling Preferences

- **Runtime/package manager**: Bun. Use `bun test`; do not assume npm scripts beyond `test`.
- **Module system**: ESM TypeScript loaded directly by OMP; no build output or `tsconfig` currently exists.
- **Host**: Oh My Pi via `@oh-my-pi/pi-coding-agent >=16.4.6`.
- **Marketplace**: local catalog exists under `.claude-plugin/marketplace.json`; package is `private: true`, so npm publishing is not configured.
- **Grok CLI parity**: prefer the official CLI model ids from the proxy/CLI (`grok-4.5`, `grok-composer-2.5-fast`). Refresh model cache with `omp models refresh` when xAI changes entitlements.
- **Endpoint constraint**: inference, model discovery, and billing stay on `cli-chat-proxy.grok.com`; only OAuth uses `auth.x.ai`.
- **Releases**: tag-driven GitHub releases. Keep `package.json` and `.claude-plugin/marketplace.json` versions aligned before pushing `vX.Y.Z`.

Optional env used by source:

| Env | Purpose |
| --- | --- |
| `GROK_CLI_VERSION` | Override client version header; else `grok --version`, else `0.2.93` |
| `GROK_HOME` | Override credential directory; else `~/.grok` |

## Testing & QA

- Framework: `bun:test` with flat files in `test/*.test.ts`.
- Preferred unit-test style: inject fake `fetchImpl`, record outbound URLs/headers/body, and assert observable contracts.
- Restore mutated environment in `afterEach` (`GROK_CLI_VERSION` in provider tests).
- Use minimal typed fakes for `ExtensionAPI`; avoid global mocks when DI is available.

Current coverage:

- `auth.test.ts` — OIDC-over-legacy precedence, legacy token parsing, malformed auth rejection, refresh-token endpoint/body/header behavior.
- `provider.test.ts` — provider id, proxy-only base URL, `openai-responses`, dynamic model fallback, per-model Grok CLI headers.
- `usage.test.ts` — monthly and weekly billing endpoints, subscription auth headers, usage mapping and formatting.

Known gaps:

- Limited negative-path coverage for failed/non-JSON HTTP responses, rotated refresh tokens, malformed billing payloads, command registration, and full OMP runtime login flows.
- Live smoke tests require valid Grok CLI OAuth credentials and may fail with quota errors (`402 Grok Build usage balance exhausted`). Treat quota errors as evidence that auth/model routing reached the proxy, not as model-not-found.

Useful smoke tests:

```bash
omp models refresh
omp models grok-build
omp --model grok-build/grok-4.5 --thinking high --no-session -p "Reply with exactly ok"
omp --model grok-build/grok-composer-2.5-fast --no-session -p "Reply with exactly ok"
```

Before yielding non-trivial changes, run at least the focused affected tests; run `bun test` for behavior changes that touch auth, provider registration, models, payloads, or usage.