# omp-grok-build

Use a **Grok Build CLI subscription** from [Oh My Pi](https://omp.sh) via the Grok CLI entitlement proxy.

This extension registers OMP provider `grok-build`, reuses the official Grok CLI login when available, supports native device-code OAuth, discovers the live Grok CLI model catalog, and adds a usage command for subscription billing.

It does **not** use the public xAI inference API.

```text
Inference/model/billing: https://cli-chat-proxy.grok.com/v1
OAuth only:              https://auth.x.ai
```

## Features

- OMP provider: `grok-build`
- OpenAI Responses-compatible transport through `cli-chat-proxy.grok.com`
- Grok CLI OAuth credential reuse from `~/.grok/auth.json`
- Device-code login fallback when no CLI credential exists
- Dynamic model discovery from `/v1/models`
- Exact observed Grok CLI model ids:
  - `grok-build/grok-4.5`
  - `grok-build/grok-composer-2.5-fast`
- Grok proxy payload sanitation for unsupported Responses fields
- Subscription usage command: `/grok-build-usage`

## Requirements

- [Oh My Pi](https://omp.sh) with `@oh-my-pi/pi-coding-agent >=16.4.6`
- [Bun](https://bun.sh) for local development/tests
- A Grok/X account with Grok Build access
- Optional but recommended: official Grok CLI login

Install the official Grok CLI if needed:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login --device-auth
```

## Install locally

From this repository:

```bash
omp install . --force
```

Verify the extension loaded:

```bash
omp -p '/extensions'
```

Verify the provider catalog:

```bash
omp models refresh
omp models grok-build
```

Expected current model ids:

```text
grok-build/grok-4.5
grok-build/grok-composer-2.5-fast
```

## Test in an isolated OMP profile

To avoid mixing this provider with your everyday OMP profile, create a dedicated profile alias. `grk` is a convenient alias name that does not conflict with the official `grok` CLI:

```bash
omp --profile grok-build --alias grk
source ~/.zshrc
```

If your shell cannot be detected automatically, add the equivalent function manually:

```zsh
grk() {
  command '/home/quiet/.bun/bin/bun' '/home/quiet/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js' --profile=grok-build "$@"
}
```

Install through the marketplace in that clean profile:

```bash
grk plugin marketplace add notquite28/omp-grok-build
grk install omp-grok-build@omp-grok-build-marketplace
grk models refresh
grk models grok-build
```

Then import existing Grok CLI credentials into the profile:

```bash
printf '%s\n' '{"id":"login-1","type":"login","providerId":"grok-build"}' \
  | grk --mode rpc --model grok-build/grok-4.5 --no-session
```

Smoke test:

```bash
grk --model grok-build/grok-4.5 --thinking high --no-session \
  -p "Reply with exactly grk-ok"
```

## Authenticate

If you already ran `grok login`, the extension can import the Grok CLI token from:

```text
~/.grok/auth.json
```

For a headless one-shot import into the current OMP profile:

```bash
printf '%s\n' '{"id":"login-1","type":"login","providerId":"grok-build"}' \
  | omp --mode rpc --model grok-build/grok-4.5 --no-session
```

Expected notification:

```text
Using credentials from the Grok Build CLI
```

In the interactive OMP UI, use:

```text
/login grok-build
```

If no CLI credential exists, the extension starts xAI device-code OAuth.

## Usage

Use Grok 4.5:

```bash
omp --model grok-build/grok-4.5 --thinking high -p "Write a short haiku"
```

Use Composer 2.5:

```bash
omp --model grok-build/grok-composer-2.5-fast -p "Fix this bug"
```

Show subscription usage:

```text
/grok-build-usage
```

Or in print mode:

```bash
omp -p '/grok-build-usage'
```

A quota error such as:

```text
402 Grok Build usage balance exhausted
```

means routing/auth reached the Grok CLI proxy; it is not a model-discovery failure.

## Architecture

```text
OMP host
  └─ package.json → omp.extensions → src/main.ts
       ├─ registerProvider("grok-build")
       │    ├─ baseUrl: https://cli-chat-proxy.grok.com/v1
       │    ├─ api: openai-responses
       │    ├─ oauth: loginToGrok / refreshGrokCredentials / getApiKey
       │    └─ fetchDynamicModels → GET /v1/models
       ├─ before_provider_request → sanitizeProxyPayload
       └─ /grok-build-usage → GET /v1/billing
```

Key files:

| File | Purpose |
| --- | --- |
| `src/main.ts` | Extension entry, provider wiring, request hook, usage command registration |
| `src/auth.ts` | Grok CLI auth import, device-code OAuth, token refresh, CLI version detection |
| `src/models.ts` | Static fallback models and live `/v1/models` mapping |
| `src/payload.ts` | In-place payload sanitation for CLI proxy compatibility |
| `src/usage.ts` | Billing endpoint client and `/grok-build-usage` formatting |
| `.claude-plugin/marketplace.json` | Marketplace catalog metadata |

## Configuration

Optional environment variables:

| Env | Purpose |
| --- | --- |
| `GROK_CLI_VERSION` | Override `x-grok-client-version`; defaults to `grok --version`, then `0.2.93` |
| `GROK_HOME` | Override Grok credential directory; defaults to `~/.grok` |

## Development

Run tests:

```bash
bun test
```

Focused tests:

```bash
bun test test/auth.test.ts
bun test -t "routes only through the CLI entitlement proxy"
```

CI runs `bun install --frozen-lockfile` and `bun test` on pushes and pull requests to `master`. There is currently no build, lint, format, or typecheck script. The extension ships as TypeScript source loaded by OMP.

## Releases

GitHub releases are created only when a matching `vX.Y.Z` tag is pushed. A commit to `master` runs CI but does **not** create a release by itself.

To cut a release:

1. Update `package.json` and `.claude-plugin/marketplace.json` to the same version.
2. Commit the version bump.
3. Push `master`.
4. Push a matching tag:

```bash
git tag v0.1.0
git push origin master
git push origin v0.1.0
```

The release workflow validates that `vX.Y.Z` matches `package.json`, runs `bun test`, creates a source archive, and publishes a GitHub release with generated notes. For the initial `0.1.0` release, pushing `v0.1.0` is enough because the package version is already `0.1.0`.

## Marketplace

This repository includes a local marketplace catalog:

```text
.claude-plugin/marketplace.json
```

For a published marketplace repo, users would add and install with:

```bash
omp plugin marketplace add owner/repo
omp install omp-grok-build@omp-grok-build-marketplace
```

The package is currently marked `private: true`; remove that before npm publishing.

## Endpoint policy

Do not change this extension to call:

```text
https://api.x.ai/v1
```

That is the public xAI API and does not use the Grok Build CLI subscription entitlement. This project intentionally uses the CLI proxy:

```text
https://cli-chat-proxy.grok.com/v1
```
