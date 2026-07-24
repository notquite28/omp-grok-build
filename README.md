# omp-ext

Oh My Pi marketplace containing **two separate plugins**:

| Plugin | What it does |
| --- | --- |
| [`omp-grok-build`](./plugins/omp-grok-build) | Grok Build CLI provider (`grok-build/*`), OAuth, usage, and Grok Imagine image/video commands and tools |
| [`omp-rewind`](./plugins/omp-rewind) | Git worktree checkpoints — `/rewind`, session tree/branch restore integration, transactional restore, durable undo |

Repo layout:

```text
.
├── .claude-plugin/marketplace.json   # catalog (multi-plugin)
├── plugins/
│   ├── omp-grok-build/               # provider extension
│   └── omp-rewind/                   # checkpoint/rewind extension
└── package.json                      # marketplace workspace scripts only
```

## Install / uninstall

Plugins install **independently**. Catalog id is `name@omp-ext`.

```text
omp-grok-build@omp-ext
omp-rewind@omp-ext
```

`omp install` is the top-level convenience for local paths, npm specs, and marketplace refs. `omp plugin …` is the full lifecycle CLI.

### 1. Add the marketplace (once per profile)

```bash
omp plugin marketplace add notquite28/omp-ext

# local checkout while developing this repo
omp plugin marketplace add ./path/to/omp-ext

# list / refresh / remove marketplaces
omp plugin marketplace list
omp plugin marketplace update              # all
omp plugin marketplace update omp-ext      # one
omp plugin marketplace remove omp-ext
```

With the Grok profile alias (`omp --profile grok-build --alias grk`), the same commands work as `grk …`.

### 2. Install plugins

```bash
# marketplace (preferred for update tracking)
omp install omp-grok-build@omp-ext
omp install omp-rewind@omp-ext

# equivalent explicit form
omp plugin install omp-grok-build@omp-ext
omp plugin install omp-rewind@omp-ext

# project-scoped (optional)
omp install omp-rewind@omp-ext --scope project

# discover available catalog entries
omp plugin discover
omp plugin discover omp-ext
```

### 3. List, enable, disable

```bash
omp plugin list
omp plugin list --json

omp plugin disable omp-rewind@omp-ext
omp plugin enable omp-rewind@omp-ext
```

### 4. Upgrade

```bash
# refresh catalog from GitHub (or local source), then upgrade installs
omp plugin marketplace update
omp plugin upgrade                         # all outdated marketplace plugins
omp plugin upgrade omp-rewind@omp-ext
omp plugin upgrade omp-grok-build@omp-ext
```

`marketplace update` only refreshes the catalog. `plugin upgrade` applies newer catalog versions to installed marketplace plugins.

### 5. Uninstall plugins

```bash
# marketplace installs — use name@marketplace
omp plugin uninstall omp-rewind@omp-ext
omp plugin uninstall omp-grok-build@omp-ext

# project-scoped install
omp plugin uninstall omp-rewind@omp-ext --scope project

# linked / local path installs — use the package name
omp plugin uninstall omp-rewind
omp plugin uninstall omp-grok-build
```

There is no top-level `omp remove`; use `omp plugin uninstall`.

### 6. Local development (link)

Use an explicit profile so the development link and marketplace install are changed in the same OMP profile. If the marketplace plugin is already installed, disable it before linking the checkout to avoid loading two copies.

```bash
# Run from the omp-ext repository root. Replace <profile> with your OMP profile.
omp --profile <profile> plugin disable omp-rewind@omp-ext
omp --profile <profile> plugin link --force ./plugins/omp-rewind
omp --profile <profile>
```

Verify the linked extension inside OMP with `/rewind help`. Restart OMP after source changes.

Restore the marketplace installation when local testing is complete:

```bash
omp --profile <profile> plugin uninstall omp-rewind
omp --profile <profile> plugin install --force omp-rewind@omp-ext
```

Use the same flow with `omp-grok-build`. Do not combine `--no-extensions` with `--extension` for this workflow: OMP 17.1.2 suppresses the explicit extension along with discovered extensions.

### Quick reference

| Action | Command |
| --- | --- |
| Add marketplace | `omp plugin marketplace add notquite28/omp-ext` |
| List marketplaces | `omp plugin marketplace list` |
| Update catalog | `omp plugin marketplace update` |
| Remove marketplace | `omp plugin marketplace remove omp-ext` |
| Discover plugins | `omp plugin discover [omp-ext]` |
| Install plugin | `omp install name@omp-ext` |
| List installed | `omp plugin list` |
| Upgrade plugin(s) | `omp plugin upgrade [name@omp-ext]` |
| Disable / enable | `omp plugin disable\|enable name@omp-ext` |
| Uninstall plugin | `omp plugin uninstall name@omp-ext` |
| Link local path | `omp --profile <profile> plugin link --force ./plugins/<name>` |

## Local development

Link plugins with `omp --profile <profile> plugin link --force ./plugins/<name>` (see [Install / uninstall](#install--uninstall) above).

Tests:

```bash
# Grok plugin (needs deps)
cd plugins/omp-grok-build && bun install --frozen-lockfile
bun run typecheck
bun test

# Rewind plugin (no deps)
cd plugins/omp-rewind && bun run test
```

From repo root (after `bun install` in the Grok plugin dir):

```bash
bun run test:grok
bun run test:rewind
```

## Plugin docs

- **Grok Build provider** — [plugins/omp-grok-build](./plugins/omp-grok-build) (see root history / AGENTS for architecture; install section above)
- **Rewind** — [plugins/omp-rewind/README.md](./plugins/omp-rewind/README.md)

### Note on extension loading

Both plugins are TypeScript **extension factories** (`package.json` → `omp.extensions`). Prefer marketplace install for update tracking. For local development, use `omp plugin link` as documented above; do not use a simultaneous marketplace install and direct extension load.

## Releases

Marketplace catalog metadata version lives in:

- root `package.json` `version`
- `.claude-plugin/marketplace.json` → `metadata.version`

Each plugin has its **own** version in `plugins/<name>/package.json` and a matching entry in the catalog `plugins[].version`.

Tag releases as `vX.Y.Z` matching the **marketplace** metadata version (not necessarily a plugin version). CI validates catalog entries match each plugin package version, then publishes a source archive.

```bash
# example: bump rewind only
# 1. plugins/omp-rewind/package.json version
# 2. catalog plugins[name=omp-rewind].version
# 3. optionally bump marketplace metadata.version + root package.json
# 4. commit, tag vX.Y.Z, push
```

## License

Plugin licenses live with each package (`plugins/omp-rewind` is MIT). Grok plugin remains as previously published.
