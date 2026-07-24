/**
 * omp-rewind — /rewind command and tree/branch restore hooks
 *
 * Registers /rewind (git checkpoint browser) and handlers used when the host
 * navigates the session tree or branches from an earlier message.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReadonlySessionManager,
} from "@oh-my-pi/pi-coding-agent";
import type { RewindState } from "./state.js";
import { runRepositoryOperation } from "./state.js";
import type { CheckpointData, TreeChange, WorkspaceComparison } from "./core.js";
import {
  compareCheckpointToCurrent,
  deleteCheckpoint,
  createCheckpoint,
  git,
  restoreCheckpoint,
  inspectCheckpointRef,
  buildCheckpointDiff,
  inspectAllCheckpointRefs,
} from "./core.js";

// ============================================================================
// Helpers
// ============================================================================

interface ConversationAnchor {
  id: string | null;
  parentId: string | null;
}

function getConversationAnchor(
  sessionManager: Pick<ReadonlySessionManager, "getLeafId" | "getEntry">,
): ConversationAnchor {
  const id = sessionManager.getLeafId();
  const entry = id ? sessionManager.getEntry(id) : undefined;
  return entry ? { id: entry.id, parentId: entry.parentId } : { id: null, parentId: null };
}


type RestoreHookContext = Pick<ExtensionContext, "hasUI" | "ui" | "sessionManager">;

async function confirmWorkspaceRestore(
  state: RewindState,
  target: CheckpointData,
  ctx: Pick<ExtensionContext, "ui">,
  title: string,
): Promise<WorkspaceComparison | undefined> {
  let comparison: WorkspaceComparison;
  try {
    const result = await runRepositoryOperation(state, async () => {
      const inspection = await inspectCheckpointRef(state.repoRoot!, target.id);
      if (!inspection.checkpoint) return { error: inspection.errors[0] };
      return { comparison: await compareCheckpointToCurrent(state.repoRoot!, target) };
    });
    if (result.error) {
      ctx.ui.notify(`Checkpoint unavailable: ${result.error}`, "error");
      return undefined;
    }
    comparison = result.comparison!;
  } catch (error) {
    ctx.ui.notify(
      `Unable to compare current workspace: ${error instanceof Error ? error.message : error}`,
      "error",
    );
    return undefined;
  }

  const targetSkipped = [
    ...(target.skippedLargeFiles ?? []).map((path) => `file ${path}`),
    ...(target.skippedLargeDirs ?? []).map((path) => `directory ${path}`),
  ];
  if (targetSkipped.length > 0) {
    ctx.ui.notify(`Not captured by checkpoint: ${targetSkipped.join(", ")}`, "warning");
  }

  const skipped = [
    ...comparison.skippedLargeFiles.map((path) => `file ${path}`),
    ...comparison.skippedLargeDirs.map((path) => `directory ${path}`),
  ];
  if (skipped.length > 0) {
    ctx.ui.notify(`Skipped in current workspace scan: ${skipped.join(", ")}`, "warning");
  }

  if (comparison.worktreeChanged || comparison.indexChanged) {
    const stats = [
      comparison.worktreeStat ? `Worktree:\n${comparison.worktreeStat}` : "",
      comparison.indexStat ? `Index:\n${comparison.indexStat}` : "",
    ].filter(Boolean).join("\n\n");
    const proceed = await ctx.ui.confirm(
      `${title}:${stats ? `\n\n${stats}` : ""}`,
      "Proceed with restore?",
    );
    if (!proceed) return undefined;
  }

  return comparison;
}
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatCheckpointLabel(cp: CheckpointData, index: number, _state: RewindState, currentBranch?: string): string {
  const time = formatTimestamp(cp.timestamp);
  const branchTag = (cp.branch && currentBranch && cp.branch !== currentBranch)
    ? ` ⚠️ ${cp.branch}`
    : (cp.branch ? ` [${cp.branch}]` : "");

  if (cp.description) {
    return `#${index + 1} [${time}]${branchTag} ${cp.description}`;
  }

  // Fallback for old checkpoints without description
  if (cp.trigger === "resume") return `#${index + 1} [${time}]${branchTag} Session start`;
  if (cp.trigger === "tool" && cp.toolName) return `#${index + 1} [${time}]${branchTag} → ${cp.toolName}`;
  return `#${index + 1} [${time}]${branchTag} Turn ${cp.turnIndex}`;
}

type RestoreMode = "all" | "files" | "conversation" | "cancel";

const RESTORE_OPTIONS: { label: string; value: RestoreMode }[] = [
  { label: "Restore all (files + conversation)", value: "all" },
  { label: "Files only (keep conversation)", value: "files" },
  { label: "Conversation only (keep files)", value: "conversation" },
  { label: "Cancel", value: "cancel" },
];

export function resolveCheckpointAtOrBefore(
  checkpoints: Iterable<CheckpointData>,
  targetId: string,
  sessionManager: Pick<ReadonlySessionManager, "getBranch">,
): CheckpointData | undefined {
  const depthById = new Map(
    sessionManager.getBranch(targetId).map((entry, depth) => [entry.id, depth]),
  );

  return [...checkpoints]
    .filter(
      (checkpoint): checkpoint is CheckpointData & { conversationLeafId: string } =>
        checkpoint.conversationLeafId !== undefined
        && depthById.has(checkpoint.conversationLeafId),
    )
    .sort((a, b) => {
      const depthDifference =
        depthById.get(b.conversationLeafId)! - depthById.get(a.conversationLeafId)!;
      if (depthDifference !== 0) return depthDifference;
      if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
      return a.id.localeCompare(b.id);
    })[0];
}

type CheckpointChoice =
  | { kind: "undo"; checkpoint: CheckpointData }
  | { kind: "checkpoint"; checkpoint: CheckpointData; index: number };

async function selectCheckpoint(
  state: RewindState,
  ctx: Pick<ExtensionCommandContext, "ui">,
  title: string,
  includeUndo: boolean,
): Promise<CheckpointChoice | undefined> {
  const checkpoints = [...state.checkpoints.values()]
    .filter((checkpoint) => checkpoint.trigger !== "before-restore")
    .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  const undoCheckpoint = includeUndo ? state.undoCheckpoint : null;
  if (checkpoints.length === 0 && !undoCheckpoint) {
    ctx.ui.notify("No checkpoints available", "warning");
    return undefined;
  }

  const currentBranch = await runRepositoryOperation(
    state,
    () => git("rev-parse --abbrev-ref HEAD", state.repoRoot!).catch(() => "unknown"),
  );
  const checkpointItems = checkpoints.map((checkpoint, index) =>
    formatCheckpointLabel(checkpoint, index, state, currentBranch)
  );
  const undoLabel = "↩ Undo last rewind";
  const items = undoCheckpoint ? [undoLabel, ...checkpointItems] : checkpointItems;
  const choice = await ctx.ui.select(title, items);
  if (!choice) return undefined;
  if (choice === undoLabel && undoCheckpoint) {
    return { kind: "undo", checkpoint: undoCheckpoint };
  }

  const index = checkpointItems.indexOf(choice);
  if (index < 0) return undefined;
  return { kind: "checkpoint", checkpoint: checkpoints[index], index };
}

// ============================================================================
// Rewind flow
// ============================================================================

async function runRewindFlow(
  state: RewindState,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
    ctx.ui.notify("Rewind not available (no git repo or session)", "warning");
    return;
  }

  const selection = await selectCheckpoint(state, ctx, "Rewind to checkpoint:", true);
  if (!selection) return;

  if (selection.kind === "undo") {
    const comparison = await confirmWorkspaceRestore(
      state,
      selection.checkpoint,
      ctx,
      "Current workspace changes before undo",
    );
    if (!comparison) return;
    try {
      await undoLastRestore(
        state,
        getConversationAnchor(ctx.sessionManager),
        {
          worktreeTreeSha: comparison.currentWorktreeTreeSha,
          indexTreeSha: comparison.currentIndexTreeSha,
        },
        ctx,
      );
    } catch (error) {
      ctx.ui.notify(
        `Undo failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      return;
    }
    ctx.ui.notify("Undo successful — files restored to before last rewind", "info");
    return;
  }

  const { checkpoint: target, index } = selection;
  const restoreOptions = target.conversationLeafId
    ? RESTORE_OPTIONS
    : RESTORE_OPTIONS.filter((option) => option.value === "files" || option.value === "cancel");
  if (!target.conversationLeafId) {
    ctx.ui.notify(
      "Conversation restore unavailable: checkpoint predates exact session IDs.",
      "warning",
    );
  }

  const modeChoice = await ctx.ui.select(
    "Restore mode:",
    restoreOptions.map((option) => option.label),
  );
  const mode = restoreOptions.find((option) => option.label === modeChoice)?.value ?? "cancel";
  if (mode === "cancel") return;

  const targetEntry = target.conversationLeafId
    ? ctx.sessionManager.getEntry(target.conversationLeafId)
    : undefined;
  if ((mode === "conversation" || mode === "all") && !targetEntry) {
    ctx.ui.notify("Conversation restore failed: checkpoint entry no longer exists", "error");
    return;
  }

  let beforeCheckpoint: CheckpointData | undefined;
  if (mode === "files" || mode === "all") {
    const comparison = await confirmWorkspaceRestore(
      state,
      target,
      ctx,
      `Files changed since checkpoint #${index + 1}`,
    );
    if (!comparison) return;
    try {
      beforeCheckpoint = await performRestore(
        state,
        target,
        getConversationAnchor(ctx.sessionManager),
        {
          worktreeTreeSha: comparison.currentWorktreeTreeSha,
          indexTreeSha: comparison.currentIndexTreeSha,
        },
      );
    } catch (error) {
      ctx.ui.notify(
        `Restore failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      return;
    }
  }

  if ((mode === "conversation" || mode === "all") && targetEntry) {
    let navigationError: unknown;
    let navigationCancelled = false;
    state.suppressNavigationRestore++;
    try {
      const result = await ctx.navigateTree(targetEntry.id, { summarize: true });
      navigationCancelled = result.cancelled;
    } catch (error) {
      navigationError = error;
    } finally {
      state.suppressNavigationRestore--;
    }

    if (navigationError || navigationCancelled) {
      if (beforeCheckpoint) {
        try {
          await rollbackForwardRestore(state, beforeCheckpoint);
        } catch (rollbackError) {
          ctx.ui.notify(
            `Conversation restore failed: ${
              navigationError instanceof Error
                ? navigationError.message
                : navigationError || "cancelled"
            }. ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`,
            "error",
          );
          return;
        }
      }
      ctx.ui.notify(
        `Conversation restore ${
          navigationError instanceof Error ? `failed: ${navigationError.message}` : "cancelled"
        }`,
        "error",
      );
      return;
    }
  }

  if (beforeCheckpoint) await commitUndoCheckpoint(state, beforeCheckpoint, ctx);
  const restored = mode === "all" ? "files + conversation"
    : mode === "files" ? "files" : "conversation";
  ctx.ui.notify(`Rewound ${restored} to checkpoint #${index + 1}`, "info");
}

async function runDiffFlow(
  state: RewindState,
  ctx: ExtensionCommandContext,
  full: boolean,
): Promise<void> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
    ctx.ui.notify("Rewind not available (no git repo or session)", "warning");
    return;
  }

  const selection = await selectCheckpoint(state, ctx, "Inspect checkpoint:", false);
  if (!selection || selection.kind !== "checkpoint") return;

  const result = await runRepositoryOperation(state, async () => {
    const inspection = await inspectCheckpointRef(state.repoRoot!, selection.checkpoint.id);
    if (!inspection.checkpoint) return { error: inspection.errors[0] };
    return {
      checkpoint: inspection.checkpoint,
      diff: await buildCheckpointDiff(state.repoRoot!, inspection.checkpoint),
    };
  });
  if (result.error) {
    ctx.ui.notify(`Checkpoint unavailable: ${result.error}`, "error");
    return;
  }

  const checkpoint = result.checkpoint!;
  const diff = result.diff!;
  const targetSkipped = [
    ...(checkpoint.skippedLargeFiles ?? []).map((path) => `file ${path}`),
    ...(checkpoint.skippedLargeDirs ?? []).map((path) => `directory ${path}`),
  ];
  if (targetSkipped.length > 0) {
    ctx.ui.notify(`Not captured by checkpoint: ${targetSkipped.join(", ")}`, "warning");
  }
  const currentSkipped = [
    ...diff.comparison.skippedLargeFiles.map((path) => `file ${path}`),
    ...diff.comparison.skippedLargeDirs.map((path) => `directory ${path}`),
  ];
  if (currentSkipped.length > 0) {
    ctx.ui.notify(
      `Skipped in current workspace scan: ${currentSkipped.join(", ")}`,
      "warning",
    );
  }

  if (!diff.comparison.worktreeChanged && !diff.comparison.indexChanged) {
    ctx.ui.notify("Checkpoint already matches the current workspace", "info");
    return;
  }

  const statusOrder: Record<TreeChange["status"], number> = {
    A: 0,
    M: 1,
    D: 2,
  };
  const worktreeChanges = [...diff.worktreeChanges].sort((a, b) =>
    statusOrder[a.status] - statusOrder[b.status] || a.path.localeCompare(b.path)
  );
  const indexChanges = [...diff.indexChanges].sort((a, b) =>
    statusOrder[a.status] - statusOrder[b.status] || a.path.localeCompare(b.path)
  );
  const totalPaths = worktreeChanges.length + indexChanges.length;
  const pathCap = full ? totalPaths : 40;
  const shownWorktree = worktreeChanges.slice(0, pathCap);
  const shownIndex = indexChanges.slice(0, Math.max(0, pathCap - shownWorktree.length));
  const lines = [
    "Worktree restore effects",
    ...(shownWorktree.length > 0
      ? shownWorktree.map((change) => `${change.status} ${change.path}`)
      : worktreeChanges.length === 0 ? ["(none)"] : []),
    "",
    "Index restore effects",
    ...(shownIndex.length > 0
      ? shownIndex.map((change) => `${change.status} ${change.path}`)
      : indexChanges.length === 0 ? ["(none)"] : []),
  ];
  const omitted = totalPaths - shownWorktree.length - shownIndex.length;
  if (omitted > 0) {
    lines.push("", `... and ${omitted} more path(s); use /rewind diff --full`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function runStatusFlow(
  state: RewindState,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
    ctx.ui.notify("Rewind not available (no git repo or session)", "warning");
    return;
  }

  const { branch, inspections } = await runRepositoryOperation(state, async () => ({
    branch: await git("rev-parse --abbrev-ref HEAD", state.repoRoot!).catch(() => "unknown"),
    inspections: await inspectAllCheckpointRefs(state.repoRoot!),
  }));
  const valid = inspections.filter((inspection) => inspection.checkpoint !== null);
  const invalid = inspections.filter((inspection) => inspection.checkpoint === null);
  const incompleteCoverage = valid.filter((inspection) =>
    (inspection.checkpoint?.skippedLargeFiles?.length ?? 0) > 0
    || (inspection.checkpoint?.skippedLargeDirs?.length ?? 0) > 0
  );
  const invalidLines = invalid.slice(0, 10).map(
    (inspection) => `${inspection.id}: ${inspection.errors[0]}`,
  );
  if (invalid.length > invalidLines.length) {
    invalidLines.push(`... and ${invalid.length - invalidLines.length} more invalid ref(s)`);
  }

  const lines = [
    `Repository root: ${state.repoRoot}`,
    `Current branch: ${branch}`,
    `Current session ID: ${state.sessionId}`,
    `Active ordinary checkpoints: ${state.checkpoints.size}`,
    `Checkpoint refs: ${inspections.length} total, ${valid.length} valid, ${invalid.length} invalid`,
    `Durable undo: ${state.undoCheckpoint ? "available" : "none"}`,
    `Incomplete coverage checkpoints: ${incompleteCoverage.length}`,
    ...(invalidLines.length > 0 ? ["Invalid refs:", ...invalidLines] : []),
  ];
  ctx.ui.notify(
    lines.join("\n"),
    invalid.length > 0 || incompleteCoverage.length > 0 ? "warning" : "info",
  );
}

async function performRestore(
  state: RewindState,
  target: CheckpointData,
  sourceConversation: ConversationAnchor,
  expectedCurrent: { worktreeTreeSha: string; indexTreeSha: string },
): Promise<CheckpointData> {
  if (!state.repoRoot || !state.sessionId) {
    throw new Error("Rewind repository state is unavailable");
  }
  const root = state.repoRoot;
  const sessionId = state.sessionId;

  return runRepositoryOperation(state, async () => {
    if (target.branch) {
      const currentBranch = await git("rev-parse --abbrev-ref HEAD", root).catch(() => "unknown");
      if (currentBranch !== target.branch) {
        throw new Error(
          `Branch mismatch: checkpoint was created on "${target.branch}" but you are on "${currentBranch}".`,
        );
      }
    }

    const current = await compareCheckpointToCurrent(root, target);
    if (
      current.currentWorktreeTreeSha !== expectedCurrent.worktreeTreeSha
      || current.currentIndexTreeSha !== expectedCurrent.indexTreeSha
    ) {
      throw new Error("Workspace changed while restore confirmation was open; retry.");
    }

    const beforeCheckpoint = await createCheckpoint({
      root,
      id: `before-restore-${sessionId}-${Date.now()}`,
      sessionId,
      trigger: "before-restore",
      turnIndex: 0,
      conversationLeafId: sourceConversation.id ?? undefined,
      conversationLeafParentId:
        sourceConversation.id === null ? undefined : sourceConversation.parentId,
      restoreTargetId: target.id,
    });

    try {
      await restoreCheckpoint(root, target);
      state.lastWorkspaceIdentity = {
        worktreeTreeSha: target.worktreeTreeSha,
        indexTreeSha: target.indexTreeSha,
      };
    } catch (restoreError) {
      try {
        await restoreCheckpoint(root, beforeCheckpoint);
        state.lastWorkspaceIdentity = {
          worktreeTreeSha: beforeCheckpoint.worktreeTreeSha,
          indexTreeSha: beforeCheckpoint.indexTreeSha,
        };
      } catch (rollbackError) {
        state.lastWorkspaceIdentity = null;
        const restoreMessage =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
        const rollbackMessage =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(
          `Restore failed: ${restoreMessage}. `
          + `Rollback failed: ${rollbackMessage}. `
          + `Safety checkpoint retained: ${beforeCheckpoint.id}`,
        );
      }
      try {
        await deleteCheckpoint(root, beforeCheckpoint.id);
      } catch (cleanupError) {
        throw new Error(
          `Restore failed: ${
            restoreError instanceof Error ? restoreError.message : restoreError
          }. Rollback succeeded, but safety checkpoint cleanup failed: `
          + `${beforeCheckpoint.id}: ${
            cleanupError instanceof Error ? cleanupError.message : cleanupError
          }`,
        );
      }
      throw restoreError;
    }

    return beforeCheckpoint;
  });
}

async function rollbackForwardRestore(
  state: RewindState,
  beforeCheckpoint: CheckpointData,
): Promise<void> {
  if (!state.repoRoot) throw new Error("Rewind repository state is unavailable");
  const root = state.repoRoot;
  await runRepositoryOperation(state, async () => {
    try {
      await restoreCheckpoint(root, beforeCheckpoint);
      state.lastWorkspaceIdentity = {
        worktreeTreeSha: beforeCheckpoint.worktreeTreeSha,
        indexTreeSha: beforeCheckpoint.indexTreeSha,
      };
    } catch (rollbackError) {
      state.lastWorkspaceIdentity = null;
      throw new Error(
        `Restore rollback failed: ${
          rollbackError instanceof Error ? rollbackError.message : rollbackError
        }. Safety checkpoint retained: ${beforeCheckpoint.id}`,
      );
    }
    await deleteCheckpoint(root, beforeCheckpoint.id);
  });
}

async function commitUndoCheckpoint(
  state: RewindState,
  nextCheckpoint: CheckpointData,
  ctx: Pick<ExtensionContext, "ui">,
): Promise<void> {
  const supersededCheckpoint = state.undoCheckpoint;
  state.undoCheckpoint = nextCheckpoint;
  if (!supersededCheckpoint || supersededCheckpoint.id === nextCheckpoint.id) return;

  try {
    await runRepositoryOperation(
      state,
      () => deleteCheckpoint(state.repoRoot!, supersededCheckpoint.id),
    );
  } catch (error) {
    ctx.ui.notify(
      `New undo checkpoint ${nextCheckpoint.id} is active, but stale checkpoint cleanup failed: `
      + `${supersededCheckpoint.id}: ${error instanceof Error ? error.message : error}`,
      "warning",
    );
  }
}

async function undoLastRestore(
  state: RewindState,
  sourceConversation: ConversationAnchor,
  expectedCurrent: { worktreeTreeSha: string; indexTreeSha: string },
  ctx: Pick<ExtensionContext, "ui">,
): Promise<void> {
  if (!state.repoRoot || !state.sessionId || !state.undoCheckpoint) {
    throw new Error("No rewind is available to undo");
  }
  const root = state.repoRoot;
  const sessionId = state.sessionId;
  const undoCheckpoint = state.undoCheckpoint;

  await runRepositoryOperation(state, async () => {
    if (undoCheckpoint.branch) {
      const currentBranch = await git("rev-parse --abbrev-ref HEAD", root).catch(() => "unknown");
      if (currentBranch !== undoCheckpoint.branch) {
        throw new Error(
          `Branch mismatch: checkpoint was created on "${undoCheckpoint.branch}" `
          + `but you are on "${currentBranch}".`,
        );
      }
    }

    const current = await compareCheckpointToCurrent(root, undoCheckpoint);
    if (
      current.currentWorktreeTreeSha !== expectedCurrent.worktreeTreeSha
      || current.currentIndexTreeSha !== expectedCurrent.indexTreeSha
    ) {
      throw new Error("Workspace changed while restore confirmation was open; retry.");
    }

    const temporaryCheckpoint = await createCheckpoint({
      root,
      id: `before-restore-${sessionId}-${Date.now()}`,
      sessionId,
      trigger: "before-restore",
      turnIndex: 0,
      conversationLeafId: sourceConversation.id ?? undefined,
      conversationLeafParentId:
        sourceConversation.id === null ? undefined : sourceConversation.parentId,
    });

    try {
      await restoreCheckpoint(root, undoCheckpoint);
      state.lastWorkspaceIdentity = {
        worktreeTreeSha: undoCheckpoint.worktreeTreeSha,
        indexTreeSha: undoCheckpoint.indexTreeSha,
      };
    } catch (restoreError) {
      try {
        await restoreCheckpoint(root, temporaryCheckpoint);
        state.lastWorkspaceIdentity = {
          worktreeTreeSha: temporaryCheckpoint.worktreeTreeSha,
          indexTreeSha: temporaryCheckpoint.indexTreeSha,
        };
      } catch (rollbackError) {
        state.lastWorkspaceIdentity = null;
        const restoreMessage =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
        const rollbackMessage =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(
          `Undo failed: ${restoreMessage}. `
          + `Rollback failed: ${rollbackMessage}. `
          + `Safety checkpoint retained: ${temporaryCheckpoint.id}`,
        );
      }
      try {
        await deleteCheckpoint(root, temporaryCheckpoint.id);
      } catch (cleanupError) {
        throw new Error(
          `Undo failed: ${
            restoreError instanceof Error ? restoreError.message : restoreError
          }. Rollback succeeded, but safety checkpoint cleanup failed: `
          + `${temporaryCheckpoint.id}: ${
            cleanupError instanceof Error ? cleanupError.message : cleanupError
          }`,
        );
      }
      throw restoreError;
    }

    try {
      await deleteCheckpoint(root, undoCheckpoint.id);
    } catch (cleanupError) {
      let temporaryCleanupDetail = "";
      try {
        await deleteCheckpoint(root, temporaryCheckpoint.id);
      } catch (temporaryCleanupError) {
        temporaryCleanupDetail =
          ` Temporary checkpoint also remains: ${temporaryCheckpoint.id}: ${
            temporaryCleanupError instanceof Error
              ? temporaryCleanupError.message
              : temporaryCleanupError
          }`;
      }
      throw new Error(
        `Files restored, but failed to consume undo checkpoint ${undoCheckpoint.id}: ${
          cleanupError instanceof Error ? cleanupError.message : cleanupError
        }.${temporaryCleanupDetail}`,
      );
    }
    state.undoCheckpoint = null;
    try {
      await deleteCheckpoint(root, temporaryCheckpoint.id);
    } catch (error) {
      ctx.ui.notify(
        `Undo succeeded, but temporary checkpoint cleanup failed: `
        + `${temporaryCheckpoint.id}: ${error instanceof Error ? error.message : error}`,
        "warning",
      );
    }
  });
}

// ============================================================================
// Handle fork/tree restore prompts
// ============================================================================

export async function handleBranchRestore(
  state: RewindState,
  event: { entryId: string },
  ctx: RestoreHookContext,
): Promise<{ cancel: true } | { skipConversationRestore: true } | undefined> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId || !ctx.hasUI) {
    return undefined;
  }

  const entry = ctx.sessionManager.getEntry(event.entryId);
  const routingTargetId = entry?.type === "message" && entry.message.role === "user"
    ? entry.parentId
    : entry?.id;
  const checkpoint = routingTargetId
    ? resolveCheckpointAtOrBefore(
      state.checkpoints.values(),
      routingTargetId,
      ctx.sessionManager,
    )
    : entry?.type === "message" && entry.message.role === "user"
      ? state.resumeCheckpoint
      : undefined;

  const options = ["Conversation only (keep files)"];
  if (checkpoint) {
    options.push("Restore all (files + conversation)");
    options.push("Code only (restore files, keep conversation)");
  }
  if (state.undoCheckpoint) options.push("↩ Undo last rewind");
  options.push("Cancel");

  const choice = await ctx.ui.select("Restore Options", options);
  if (!choice || choice === "Cancel") return { cancel: true };
  if (choice === "Conversation only (keep files)") return undefined;

  if (choice === "↩ Undo last rewind" && state.undoCheckpoint) {
    const comparison = await confirmWorkspaceRestore(
      state,
      state.undoCheckpoint,
      ctx,
      "Current workspace changes before undo",
    );
    if (!comparison) return { cancel: true };
    try {
      await undoLastRestore(
        state,
        getConversationAnchor(ctx.sessionManager),
        {
          worktreeTreeSha: comparison.currentWorktreeTreeSha,
          indexTreeSha: comparison.currentIndexTreeSha,
        },
        ctx,
      );
    } catch (error) {
      ctx.ui.notify(
        `Undo failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      return { cancel: true };
    }
    ctx.ui.notify("Files restored to before last rewind", "info");
    return { cancel: true };
  }

  if (!checkpoint) return { cancel: true };
  const comparison = await confirmWorkspaceRestore(
    state,
    checkpoint,
    ctx,
    "Current workspace changes",
  );
  if (!comparison) return { cancel: true };

  try {
    const beforeCheckpoint = await performRestore(
      state,
      checkpoint,
      getConversationAnchor(ctx.sessionManager),
      {
        worktreeTreeSha: comparison.currentWorktreeTreeSha,
        indexTreeSha: comparison.currentIndexTreeSha,
      },
    );
    await commitUndoCheckpoint(state, beforeCheckpoint, ctx);
  } catch (error) {
    ctx.ui.notify(
      `Restore failed: ${error instanceof Error ? error.message : error}`,
      "error",
    );
    return { cancel: true };
  }

  ctx.ui.notify("Files restored from checkpoint", "info");
  return choice === "Code only (restore files, keep conversation)"
    ? { skipConversationRestore: true }
    : undefined;
}

export async function handleTreeRestore(
  state: RewindState,
  event: { preparation: { targetId: string } },
  ctx: RestoreHookContext,
): Promise<{ cancel: true } | undefined> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId || !ctx.hasUI) {
    return undefined;
  }

  const checkpoint = resolveCheckpointAtOrBefore(
    state.checkpoints.values(),
    event.preparation.targetId,
    ctx.sessionManager,
  );
  const options = ["Keep current files"];
  if (checkpoint) options.push("Restore files to that point");
  if (state.undoCheckpoint) options.push("↩ Undo last rewind");
  options.push("Cancel navigation");

  const choice = await ctx.ui.select("Restore Options", options);
  if (!choice || choice === "Cancel navigation") return { cancel: true };
  if (choice === "Keep current files") return undefined;

  if (choice === "↩ Undo last rewind" && state.undoCheckpoint) {
    const comparison = await confirmWorkspaceRestore(
      state,
      state.undoCheckpoint,
      ctx,
      "Current workspace changes before undo",
    );
    if (!comparison) return { cancel: true };
    try {
      await undoLastRestore(
        state,
        getConversationAnchor(ctx.sessionManager),
        {
          worktreeTreeSha: comparison.currentWorktreeTreeSha,
          indexTreeSha: comparison.currentIndexTreeSha,
        },
        ctx,
      );
    } catch (error) {
      ctx.ui.notify(
        `Undo failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      return { cancel: true };
    }
    ctx.ui.notify("Files restored to before last rewind", "info");
    return { cancel: true };
  }

  if (!checkpoint) return { cancel: true };
  const comparison = await confirmWorkspaceRestore(
    state,
    checkpoint,
    ctx,
    "Current workspace changes",
  );
  if (!comparison) return { cancel: true };

  try {
    const beforeCheckpoint = await performRestore(
      state,
      checkpoint,
      getConversationAnchor(ctx.sessionManager),
      {
        worktreeTreeSha: comparison.currentWorktreeTreeSha,
        indexTreeSha: comparison.currentIndexTreeSha,
      },
    );
    await commitUndoCheckpoint(state, beforeCheckpoint, ctx);
  } catch (error) {
    ctx.ui.notify(
      `Restore failed: ${error instanceof Error ? error.message : error}`,
      "error",
    );
    return { cancel: true };
  }

  ctx.ui.notify("Files restored to checkpoint", "info");
  return undefined;
}

// ============================================================================
// Registration
// ============================================================================

const REWIND_USAGE = [
  "Use /rewind restore to open the checkpoint browser.",
  "",
  "Usage:",
  "  /rewind restore",
  "  /rewind diff",
  "  /rewind diff --full",
  "  /rewind status",
  "  /rewind help",
].join("\n");

export function registerCommands(pi: ExtensionAPI, state: RewindState): void {
  pi.registerCommand("rewind", {
    description: "Rewind file changes and/or conversation to a checkpoint",
    getArgumentCompletions: (argumentPrefix: string) => {
      const completions = [
        { value: "restore", label: "restore", description: "Open checkpoint browser" },
        { value: "diff", label: "diff", description: "Inspect restore effects" },
        { value: "diff --full", label: "diff --full", description: "Inspect every affected path" },
        { value: "status", label: "status", description: "Report checkpoint health" },
        { value: "help", label: "help", description: "Show rewind usage" },
      ];
      const prefix = argumentPrefix.trimStart();
      return completions.filter((completion) => completion.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const command = args.trim().split(/\s+/).filter(Boolean).join(" ");
      if (command === "restore") {
        await runRewindFlow(state, ctx);
      } else if (command === "diff") {
        await runDiffFlow(state, ctx, false);
      } else if (command === "diff --full") {
        await runDiffFlow(state, ctx, true);
      } else if (command === "status") {
        await runStatusFlow(state, ctx);
      } else if (command === "help" || command === "--help") {
        ctx.ui.notify(REWIND_USAGE, "info");
      } else {
        ctx.ui.notify(REWIND_USAGE, "warning");
      }
    },
  });
}

