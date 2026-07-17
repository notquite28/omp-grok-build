# omp-rewind

Git checkpoint/rewind extension for [Oh My Pi](https://omp.sh). Creates automatic git-based snapshots of your working tree so you can rewind file changes and conversation state when the agent makes mistakes.

Port of [pi-rewind](https://github.com/arpagon/pi-rewind) for OMP: `omp.extensions` manifest, `@oh-my-pi/pi-coding-agent` types, and expanded mutating-tool coverage for OMP builtins (`ast_edit`, `eval`).

Shipped from the multi-plugin marketplace as **`omp-rewind@omp-ext`** (sibling of `omp-grok-build`, not the same package).

> **Not the same as OMP’s built-in `checkpoint`/`rewind` tools.** Those (setting `checkpoint.enabled`) collapse conversation history only. This extension stores **git worktree snapshots** and exposes `/rewind` + Esc+Esc for restore. Keep both; they solve different problems.

## Features

- Dedicated `/rewind` command — checkpoint browser → diff preview → restore
- `Esc+Esc` keyboard shortcut — quick files-only rewind
- Smart checkpointing — snapshots after write/edit/bash/ast_edit/eval, 1 per turn
- Smart dedup — skips checkpoints when worktree unchanged
- Descriptive labels — `"user prompt" → write → file.ts, edit → other.ts`
- Diff preview before restore
- Branch labels in picker — `[feature]` for same-branch, `⚠️ main` for cross-branch
- Redo stack (multi-level undo) — "↩ Undo last rewind"
- Restore options: files + conversation, files only, conversation only
- Safe restore — never deletes `node_modules`, `.venv`, or large files
- Branch safety — blocks cross-branch restore
- Git-based checkpoints stored as `refs/pi-checkpoints/*` (shared with pi-rewind; survives restarts)
- Footer status indicator (`◆ X checkpoints`)
- Auto-prune old sessions and per-session cap (50)

## Install / uninstall

```bash
# once per profile — add the marketplace
omp plugin marketplace add notquite28/omp-ext

# install
omp install omp-rewind@omp-ext
# equivalent: omp plugin install omp-rewind@omp-ext

# update later
omp plugin marketplace update
omp plugin upgrade omp-rewind@omp-ext

# list / disable / enable
omp plugin list
omp plugin disable omp-rewind@omp-ext
omp plugin enable omp-rewind@omp-ext

# uninstall marketplace install
omp plugin uninstall omp-rewind@omp-ext

# local link while developing this monorepo
omp install ./plugins/omp-rewind --force
# absolute
omp install /path/to/omp-ext/plugins/omp-rewind --force
# remove a linked install
omp plugin uninstall omp-rewind

# one-shot session load (no install)
omp --extension ./plugins/omp-rewind
omp -e ./plugins/omp-rewind
```

With profile alias `grk` (`omp --profile grok-build --alias grk`), use the same commands via `grk …`.

Lower-level aliases: `omp plugin link <path>`, `omp plugin install <path>`. Prefer `omp install`.

Full marketplace lifecycle (add/remove catalog, scopes, discover): see the [repo root README](../../README.md#install--uninstall).

### Esc+Esc coexistence

If double-Esc also opens OMP’s tree selector (`doubleEscapeAction`, default `"tree"`), set in `~/.omp/agent/config.yml`:

```yaml
doubleEscapeAction: none
```

when you want only git-rewind on Esc+Esc.

## Architecture

Two-layer split: `core.ts` is pure git operations with zero coding-agent dependency (independently testable), `index.ts` wires host events to core functions.

```
src/
├── core.ts       # git operations, filtering, safe restore, branch safety, prune
├── index.ts      # OMP event hooks, checkpoint scheduling, auto-prune
├── commands.ts   # /rewind, Esc+Esc, fork/tree handlers
├── state.ts      # shared mutable state
└── ui.ts         # footer status indicator
```

Checkpoint refs stay under `refs/pi-checkpoints/` so existing pi-rewind checkpoints in the same repos remain visible.

## Development

```bash
# Run tests
bun tests/core.test.ts
# or
npm test

# Load without install
omp -e ./omp-rewind
```

## Lineage

Port of **[pi-rewind](https://github.com/arpagon/pi-rewind)** by arpagon for Oh My Pi. Upstream builds on research from checkpoint-pi and pi-rewind-hook.

## License

MIT
