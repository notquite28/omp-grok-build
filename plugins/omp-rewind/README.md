# omp-rewind

Git checkpoint/rewind extension for [Oh My Pi](https://omp.sh). Creates automatic git-based snapshots of your working tree so you can rewind file changes (and optionally conversation) when the agent makes mistakes.

Port of [pi-rewind](https://github.com/arpagon/pi-rewind) for OMP: `omp.extensions` manifest, `@oh-my-pi/pi-coding-agent` types, and expanded mutating-tool coverage for OMP builtins (`ast_edit`, `eval`).

Shipped from the multi-plugin marketplace as **`omp-rewind@omp-ext`** (sibling of `omp-grok-build`, not the same package).

> **Not the same as OMP’s built-in `checkpoint`/`rewind` tools.** Those (setting `checkpoint.enabled`) collapse conversation history only. This extension stores **git worktree snapshots** and exposes `/rewind` plus restore prompts on `/tree` / `/branch`. Keep both; they solve different problems.

## Features

- Dedicated `/rewind` command — checkpoint browser → diff preview → restore modes
- Session tree / branch integration — pick an earlier message, optionally restore files
- Smart checkpointing — snapshots after write/edit/bash/ast_edit/eval, 1 per turn
- Smart dedup — skips checkpoints when worktree unchanged
- Descriptive labels — `"user prompt" → write → file.ts, edit → other.ts`
- Accurate staged/worktree preview before every file restore
- Branch labels in picker — `[feature]` for same-branch, `⚠️ main` for cross-branch
- Durable single-step undo — "↩ Undo last rewind" survives restarts
- Restore options: files + conversation, files only, conversation only
- Transactional restore — failures roll files/index back to the pre-restore snapshot
- Ref-safe restore — preserves `HEAD`, branch tips, `node_modules`, `.venv`, and large files
- Exact conversation routing by persisted session-entry ID; legacy checkpoints remain files-only
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

# local development from the omp-ext repository root
# replace <profile> with the profile used to run OMP
omp --profile <profile> plugin disable omp-rewind@omp-ext
omp --profile <profile> plugin link --force ./plugins/omp-rewind
omp --profile <profile>

# restore the marketplace copy after testing
omp --profile <profile> plugin uninstall omp-rewind
omp --profile <profile> plugin install --force omp-rewind@omp-ext
```

Inside the development session, run `/rewind help` to verify the local extension loaded. Restart OMP after source changes. Avoid combining `--no-extensions` with `--extension`: OMP 17.1.2 suppresses the explicit extension along with discovered extensions.

Full marketplace lifecycle (add/remove catalog, scopes, discover): see the [repo root README](../../README.md#install--uninstall).

### How to rewind

| Goal | How |
| --- | --- |
| Git checkpoint browser (diff + restore modes) | **`/rewind`** |
| Jump conversation to an earlier message | **`/tree`** or **Esc+Esc** (host, default) |
| Optional file restore after tree/branch pick | Prompt: *Keep current files* / *Restore files to that point* |
| Branch from a user message | **`/branch`** (same file-restore prompt when applicable) |

Esc+Esc is owned by OMP (`doubleEscapeAction`, default `"tree"`). This extension does **not** capture double-Esc, so the session tree stays available. Git-only restore is always **`/rewind`**.

```yaml
# ~/.omp/agent/config.yml — host double-Esc (default is already tree)
doubleEscapeAction: tree   # or "branch" | "none"
```

## Architecture

Two-layer split: `core.ts` is pure git operations with zero coding-agent dependency (independently testable), `index.ts` wires host events to core functions.

```
src/
├── core.ts       # git operations, filtering, safe restore, branch safety, prune
├── index.ts      # OMP event hooks, checkpoint scheduling, auto-prune
├── commands.ts   # /rewind, fork/tree restore handlers
├── state.ts      # shared mutable state
└── ui.ts         # footer status indicator
```

Checkpoint refs stay under `refs/pi-checkpoints/` so existing pi-rewind checkpoints in the same repos remain visible.

## Development

From the repository root, link the checkout into the profile you use for testing:

```bash
omp --profile <profile> plugin disable omp-rewind@omp-ext
omp --profile <profile> plugin link --force ./plugins/omp-rewind
omp --profile <profile>
```

Run `/rewind help` inside OMP to confirm the development copy loaded. To switch back, uninstall the local package name and force-install the marketplace ID:

```bash
omp --profile <profile> plugin uninstall omp-rewind
omp --profile <profile> plugin install --force omp-rewind@omp-ext
```

Run the plugin tests from its directory:

```bash
cd plugins/omp-rewind
bun run test
```

### Manual smoke test

Use a disposable Git repository because the extension creates refs under `refs/pi-checkpoints/*` and restores real index/worktree state.

1. Launch the linked profile and run `/rewind help`; the usage text confirms command registration.
2. Run `/rewind status`; a healthy session reports its checkpoint refs instead of sending the text to the model.
3. Ask OMP to modify a tracked file and wait for the turn to finish.
4. Confirm the footer shows `◆ N checkpoints`, then run `/rewind`.
5. Select the latest pre-change checkpoint and restore files only.
6. Confirm the file and index match the selected checkpoint while `HEAD` and the branch tip remain unchanged.

## Lineage

Port of **[pi-rewind](https://github.com/arpagon/pi-rewind)** by arpagon for Oh My Pi. Upstream builds on research from checkpoint-pi and pi-rewind-hook.

## License

MIT
