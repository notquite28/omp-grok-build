# omp-grok-build

Use a **Grok Build CLI subscription** from [Oh My Pi](https://omp.sh) via the Grok CLI entitlement proxy.

This extension registers OMP provider `grok-build`, reuses the official Grok CLI login when available, supports native device-code OAuth, and ships a static model catalog with the routing headers required by the CLI proxy. It adds:

- `/grok-build-usage` — subscription quota with Codex-style bars
- `/grok-build-imagine` — Grok Imagine image generation
- `image_gen` — model-callable tool for the same path
- `/grok-build-imagine-video` — Grok Imagine video generation
- `video_gen` — model-callable video generation tool

Chat, billing, image generation, and video generation all use the Grok CLI entitlement proxy. OAuth device-code and refresh requests use `auth.x.ai`; generation traffic must never use the public `api.x.ai` host.

```text
Chat / models / billing: https://cli-chat-proxy.grok.com/v1
Imagine images:          https://cli-chat-proxy.grok.com/v1/images/generations
Imagine videos:          https://cli-chat-proxy.grok.com/v1/videos/generations
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

# local development from the omp-ext repository root
# replace <profile> with the profile used to run OMP
omp --profile <profile> plugin disable omp-grok-build@omp-ext
omp --profile <profile> plugin link --force ./plugins/omp-grok-build
omp --profile <profile>

# restore the marketplace copy after testing
omp --profile <profile> plugin uninstall omp-grok-build
omp --profile <profile> plugin install --force omp-grok-build@omp-ext
```

Restart OMP after source changes. Avoid combining `--no-extensions` with `--extension`: OMP 17.1.2 suppresses the explicit extension along with discovered extensions.

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

```text
grok-build/grok-4.5
```

The provider uses a static model entry because the CLI proxy requires
model-specific `x-grok-model-override` headers. OMP intentionally omits request
headers from its dynamic-model cache; a dynamic entry would therefore become
unrestorable after restart and unavailable to plan-mode subagents.

Keep `GROK_CLI_MODELS` aligned with the chat models served by Grok Build.

## Commands

| Command | Description |
| --- | --- |
| `/grok-build-usage` | Show monthly/weekly subscription quota with bars and relative reset times |
| `/grok-build-imagine <prompt>` | Generate a JPEG. Supports `--aspect`, `--out`, `--resolution 1k` |
| `/grok-build-imagine-video <prompt>` | Generate an MP4. Supports duration, resolution, aspect ratio, source image, and output path |

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
| Generate | `POST https://cli-chat-proxy.grok.com/v1/images/generations` (model `grok-imagine-image-quality`) |
| Save | `<sessionDir>/<sessionId>/images/N.jpg` when the session is on disk; otherwise tmp fallback |
| Display | `pi.sendUserMessage([{ type: "image", … }, { type: "text", path… }])` so user and model both see it |

Supported aspect ratios:

```text
auto, 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2,
19.5:9, 9:19.5, 20:9, 9:20
```

Only `--resolution 1k` is accepted (API default).

### Video (`/grok-build-imagine-video`, `video_gen`)

```text
/grok-build-imagine-video <prompt> [--duration 6|10] [--resolution 480p|720p|1080p] [--aspect <ratio>] [--image <url>] [--out <path>]
```

The command and `video_gen` tool submit to the entitlement proxy, poll the returned request until completion, download the MP4, and save it in session storage or a temporary fallback. Supported video aspect ratios are `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, and `2:3`.

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
| `GROK_BUILD_IMAGINE_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Imagine proxy root or full `…/images/generations` URL |
| `GROK_BUILD_IMAGINE_MODEL` | `grok-imagine-image-quality` | Image model ID |
| `GROK_BUILD_VIDEO_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Video proxy root or full `…/videos/generations` URL |
| `GROK_BUILD_VIDEO_MODEL` | `grok-imagine-video` | Video model ID |
| `GROK_CLI_VERSION` | resolved from CLI / fallback | Client version header for proxy requests |

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

Layout:

```text
src/
  main.ts           # provider, request hook, command, and tool registration
  auth.ts           # OAuth / credentials
  headers.ts        # static proxy routing headers
  models.ts         # static model catalog
  payload.ts        # before_provider_request sanitizer
  usage.ts          # /grok-build-usage + shared token resolve
  imagine/
    index.ts        # /grok-build-imagine
    tool.ts         # image_gen
    workflow.ts     # auth → generate → session save
    generate.ts     # entitlement-proxy image request
    save.ts         # session-local / tmp JPEG store
    parseArgs.ts    # CLI arg parser
    aspect.ts       # aspect ratio set
  video/
    index.ts        # /grok-build-imagine-video
    tool.ts         # video_gen
    workflow.ts     # submit → poll → download → save
    generate.ts     # entitlement-proxy video submit and polling
    save.ts         # session-local / tmp MP4 store
    parseArgs.ts    # CLI arg parser
```

See the repository root README for marketplace layout and dual-plugin install.
