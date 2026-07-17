# omp-grok-build

Use a **Grok Build CLI subscription** from [Oh My Pi](https://omp.sh) via the Grok CLI entitlement proxy.

This extension registers OMP provider `grok-build`, reuses the official Grok CLI login when available, supports native device-code OAuth, discovers the live Grok CLI model catalog, and adds `/grok-build-usage` for subscription billing.

It does **not** use the public xAI inference API.

```text
Inference/model/billing: https://cli-chat-proxy.grok.com/v1
OAuth only:              https://auth.x.ai
```

This package lives under the multi-plugin marketplace repo. Catalog entry:

```text
omp-grok-build@omp-ext
source: ./plugins/omp-grok-build
```

## Install / uninstall

```bash
# once per profile — add the marketplace
omp plugin marketplace add notquite28/omp-ext

# install
omp install omp-grok-build@omp-ext
# equivalent: omp plugin install omp-grok-build@omp-ext

# update later
omp plugin marketplace update
omp plugin upgrade omp-grok-build@omp-ext

# list / disable / enable
omp plugin list
omp plugin disable omp-grok-build@omp-ext
omp plugin enable omp-grok-build@omp-ext

# uninstall marketplace install
omp plugin uninstall omp-grok-build@omp-ext

# local link while developing this monorepo
omp install ./plugins/omp-grok-build --force
# remove a linked install
omp plugin uninstall omp-grok-build
```

With profile alias `grk` (`omp --profile grok-build --alias grk`):

```bash
grk plugin marketplace add notquite28/omp-ext
grk install omp-grok-build@omp-ext
grk plugin marketplace update
grk plugin upgrade omp-grok-build@omp-ext
grk plugin uninstall omp-grok-build@omp-ext
```

Full marketplace lifecycle (add/remove catalog, scopes, discover): see the [repo root README](../../README.md#install--uninstall).

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

## Models

```text
grok-build/grok-4.5
grok-build/grok-composer-2.5-fast
```

See the repository root README for marketplace layout and dual-plugin install.
