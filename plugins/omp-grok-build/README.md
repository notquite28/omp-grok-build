# omp-grok-build

Use a **Grok Build CLI subscription** from [Oh My Pi](https://omp.sh) via the Grok CLI entitlement proxy.

This extension registers OMP provider `grok-build`, reuses the official Grok CLI login when available, supports native device-code OAuth, discovers the live Grok CLI model catalog, and adds:

- `/grok-build-usage` — subscription quota with Codex-style bars
- `/grok-build-imagine` — Grok Imagine image generation
- `image_gen` — model-callable tool for the same path

Chat inference and billing stay on the CLI entitlement proxy. Image generation uses the public xAI images API with the same Grok Build OAuth token (same split as upstream [pi-grok-cli](https://github.com/kenryu42/pi-grok-cli)).

```text
Inference / models / billing: https://cli-chat-proxy.grok.com/v1
OAuth only:                   https://auth.x.ai
Imagine (images API):         https://api.x.ai/v1
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

## Login

```text
/login grok-build
```

Credentials are stored in OMP’s provider auth and refreshed through the normal OAuth pipeline. Local Grok CLI credentials (`grok login`) are used as a fallback when OMP auth is missing.

## Models

Live catalog from `GET https://cli-chat-proxy.grok.com/v1/models` via
`fetchDynamicModels` (host SQLite cache, 24h TTL). Falls back to the static
seed when unauthenticated or discovery fails:

```text
grok-build/grok-4.5
```

Keep `GROK_CLI_MODELS` aligned with what the CLI proxy currently serves
(`grok models` / `~/.grok/models_cache.json`). Non-chat families
(`grok-imagine-*`, `grok-stt-*`, `grok-voice-*`) are filtered out.

(Plus any models returned live by the CLI proxy catalog.)

## Commands

| Command | Description |
| --- | --- |
| `/grok-build-usage` | Show monthly/weekly subscription quota with bars and relative reset times |
| `/grok-build-imagine <prompt>` | Generate a JPEG. Supports `--aspect`, `--out`, `--resolution 1k` |

### Usage (`/grok-build-usage`)

Fetches billing from `https://cli-chat-proxy.grok.com/v1/billing` using the same OMP provider token as chat.

Output mirrors OMP Codex `/usage` style:

```text
Grok Build usage

✓ Monthly
● credits                      (14d1h)
█░░░░░░░░░░░░░░░░░░░    95.8% free
840 / 20,000 credits used · 19,160 remaining
resets in 14d1h (2026-08-01)

✓ Weekly
● credits                      (2d21h)
████░░░░░░░░░░░░░░░░    82% free
18% used this week
resets in 2d21h (2026-07-20)
```

- Status icon: `✓` ok, `!` ≥80% used, `✗` exhausted
- Bar shows **used** fraction; trailing label is **% free**
- Reset times are relative (`5d5h`, `3h12m`) plus ISO date
- A zero-credit monthly allocation is unavailable: `✗`, `0% free`, and `0 remaining`.

### Imagine (`/grok-build-imagine`)

```text
/grok-build-imagine <prompt> [--aspect <ratio>] [--out <path>] [--resolution 1k]
```

Examples:

```text
/grok-build-imagine a red apple on white --aspect 1:1
/grok-build-imagine "snowy mountain" --aspect-ratio 16:9 --out ./mountain.jpg
```

Behavior:

| Step | OMP API / path |
| --- | --- |
| Auth | `modelRegistry.getApiKeyForProvider("grok-build")`, then CLI credential fallback |
| Generate | `POST https://api.x.ai/v1/images/generations` (model `grok-imagine-image-quality`) |
| Save | `<sessionDir>/<sessionId>/images/N.jpg` when the session is on disk; otherwise tmp fallback |
| Display | `pi.sendUserMessage([{ type: "image", … }, { type: "text", path… }])` so user and model both see it |

Supported aspect ratios:

```text
auto, 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2,
19.5:9, 9:19.5, 20:9, 9:20
```

Only `--resolution 1k` is accepted (API default).

### Tool (`image_gen`)

Registered with `pi.registerTool` + `pi.zod` so any active model can generate images without the slash command:

| Param | Type | Description |
| --- | --- | --- |
| `prompt` | string | Image description |
| `aspect_ratio` | string (optional) | Same ratios as the command; default `auto` |

Returns a JSON text payload with absolute path, relative path, and filename. Same auth/save path as the command (no automatic thread injection — the model sees the tool result).

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROK_BUILD_IMAGINE_BASE_URL` | `https://api.x.ai/v1` | Imagine API root (or full `…/images/generations` URL) |
| `GROK_BUILD_IMAGINE_MODEL` | `grok-imagine-image-quality` | Image model id |
| `GROK_CLI_VERSION` | resolved from CLI / fallback | Client version header for proxy + Imagine |

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

Layout:

```text
src/
  main.ts           # provider + command registration
  auth.ts           # OAuth / credentials
  models.ts         # dynamic model catalog
  payload.ts        # before_provider_request sanitizer
  usage.ts          # /grok-build-usage + shared token resolve
  imagine/
    index.ts        # /grok-build-imagine
    tool.ts         # image_gen
    workflow.ts     # auth → generate → session save
    generate.ts     # xAI images API
    save.ts         # session-local / tmp JPEG store
    parseArgs.ts    # CLI arg parser
    aspect.ts       # aspect ratio set
```

See the repository root README for marketplace layout and dual-plugin install.
