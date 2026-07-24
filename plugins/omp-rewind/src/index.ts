/**
 * omp-rewind — Extension entry point
 *
 * Automatic git-based checkpoints with per-tool granularity.
 * Creates snapshots of your working tree so you can rewind when the AI makes mistakes.
 *
 * Checkpoint strategy (matches Cline — research-backed):
 *   - 1 resume checkpoint on session start
 *   - 1 checkpoint at turn_end (after ALL tools in a response finish)
 *   - Label: user prompt + list of mutating tools that ran
 *   - No per-tool or per-turn-start checkpoints (noisy, redundant)
 *
 * Local development from the omp-ext repository root:
 *   omp --profile <profile> plugin disable omp-rewind@omp-ext
 *   omp --profile <profile> plugin link --force ./plugins/omp-rewind
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { CheckpointData } from "./core.js";
import {
  isGitRepo,
  getRepoRoot,
  createCheckpoint,
  deleteCheckpoint,
  loadAllCheckpoints,
  pruneCheckpoints,
  pruneOldSessions,
  MUTATING_TOOLS,
  DEFAULT_MAX_CHECKPOINTS,
  captureWorkspaceSnapshot,
  sameWorkspaceIdentity,
} from "./core.js";
import { createInitialState, resetState, runRepositoryOperation } from "./state.js";
import { updateStatus, clearStatus } from "./ui.js";
import { registerCommands, handleBranchRestore, handleTreeRestore } from "./commands.js";

/** Truncate a string to maxLen, adding ellipsis if needed */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

/** Extract a human-readable description from a tool_call event */
function describeToolCall(toolName: string, input: any): string {
  if (!input) return toolName;
  switch (toolName) {
    case "write":
    case "edit":
      return `${toolName} → ${input.path || "?"}`;
    case "ast_edit": {
      const paths = Array.isArray(input.paths) ? input.paths : [];
      const shown = paths.slice(0, 2).join(", ") || "?";
      const more = paths.length > 2 ? ` +${paths.length - 2}` : "";
      return `ast_edit → ${shown}${more}`;
    }
    case "bash":
      return `bash: ${truncate(String(input.command || ""), 50)}`;
    case "eval":
      return `eval: ${truncate(String(input.code || input.language || ""), 50)}`;
    default:
      return toolName;
  }
}

export default function (pi: ExtensionAPI) {
  const state = createInitialState();

  // Register /rewind command (git checkpoint browser).
  // Esc+Esc is left to the host (session tree / branch via doubleEscapeAction).
  // Tree/branch navigation hooks below offer optional file restore.
  registerCommands(pi, state);

  // ========================================================================
  // Session lifecycle
  // ========================================================================

  async function initSession(ctx: ExtensionContext): Promise<void> {

    await runRepositoryOperation(state, async () => {
      resetState(state);
      state.gitAvailable = await isGitRepo(ctx.cwd);
      if (!state.gitAvailable) {
        if (ctx.hasUI) clearStatus(ctx);
        return;
      }

      state.repoRoot = await getRepoRoot(ctx.cwd);
      state.sessionId = ctx.sessionManager.getSessionId();

      const branchEntryIds = new Set(
        ctx.sessionManager.getBranch().map((entry) => entry.id),
      );
      let allCheckpoints: CheckpointData[] = [];
      try {
        allCheckpoints = await loadAllCheckpoints(state.repoRoot);
      } catch {
        // Existing refs are optional; capture can still proceed.
      }

      const belongsToActiveBranch = (checkpoint: CheckpointData) =>
        checkpoint.sessionId === state.sessionId
        || (
          checkpoint.conversationLeafId !== undefined
          && branchEntryIds.has(checkpoint.conversationLeafId)
        );
      for (const checkpoint of allCheckpoints) {
        if (checkpoint.trigger !== "before-restore" && belongsToActiveBranch(checkpoint)) {
          state.checkpoints.set(checkpoint.id, checkpoint);
        }
      }

      const recoverableUndoCheckpoints = allCheckpoints
        .filter(
          (checkpoint) =>
            checkpoint.trigger === "before-restore"
            && checkpoint.restoreTargetId !== undefined
            && belongsToActiveBranch(checkpoint),
        )
        .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
      state.undoCheckpoint = recoverableUndoCheckpoints[0] ?? null;

      for (const checkpoint of allCheckpoints) {
        if (checkpoint.trigger !== "before-restore") continue;
        const isOlderEligibleUndo =
          belongsToActiveBranch(checkpoint) && checkpoint.id !== state.undoCheckpoint?.id;
        const isUnlinkedCurrentSession =
          checkpoint.sessionId === state.sessionId && checkpoint.restoreTargetId === undefined;
        if (isOlderEligibleUndo || isUnlinkedCurrentSession) {
          await deleteCheckpoint(state.repoRoot, checkpoint.id).catch(() => {});
        }
      }

      try {
        const leafId = ctx.sessionManager.getLeafId();
        const leafEntry = leafId ? ctx.sessionManager.getEntry(leafId) : undefined;
        const resumeId = `resume-${state.sessionId}-${Date.now()}`;
        const cp = await createCheckpoint({
          root: state.repoRoot,
          id: resumeId,
          sessionId: state.sessionId,
          trigger: "resume",
          turnIndex: 0,
          description: "Session start",
          conversationLeafId: leafEntry?.id,
          conversationLeafParentId: leafEntry?.parentId,
        });
        state.resumeCheckpoint = cp;
        state.checkpoints.set(cp.id, cp);
        state.lastWorkspaceIdentity = {
          worktreeTreeSha: cp.worktreeTreeSha,
          indexTreeSha: cp.indexTreeSha,
        };
      } catch {
        // Resume checkpoint is optional.
      }

      try {
        const protectedIds = new Set(state.checkpoints.keys());
        if (state.undoCheckpoint) protectedIds.add(state.undoCheckpoint.id);
        await pruneOldSessions(state.repoRoot, state.sessionId, protectedIds);
      } catch {
        // Old-session pruning is best effort.
      }

      if (ctx.hasUI) updateStatus(state, ctx);
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    // OMP SessionStartEvent has no reason field; initial load only.
    await initSession(ctx);
  });

  // /new, /resume, /fork, handoff — OMP emits session_switch, not session_start.
  pi.on("session_switch", async (event, ctx) => {
    if (event.reason === "fork") {
      await runRepositoryOperation(state, async () => {
        if (!state.gitAvailable) return;
        state.sessionId = ctx.sessionManager.getSessionId();
      });
      return;
    }
    await initSession(ctx);
  });

  // /branch creates a new session file; retag so new checkpoints stay isolated.
  pi.on("session_branch", async (_event, ctx) => {
    await runRepositoryOperation(state, async () => {
      if (!state.gitAvailable) return;
      state.sessionId = ctx.sessionManager.getSessionId();
    });
  });

  // ========================================================================
  // Capture user prompt for checkpoint labels
  // ========================================================================

  pi.on("before_agent_start", async (event, _ctx) => {
    state.currentPrompt = truncate(String(event.prompt || ""), 60);
    // Reset tool list for this new turn
    state.turnToolDescriptions = [];
  });

  // ========================================================================
  // Track turn index
  // ========================================================================

  pi.on("turn_start", async (event, _ctx) => {
    state.currentTurnIndex = event.turnIndex;
  });

  // ========================================================================
  // Capture tool args for checkpoint labels
  // ========================================================================

  pi.on("tool_call", async (event, _ctx) => {
    if (MUTATING_TOOLS.has(event.toolName)) {
      const desc = describeToolCall(event.toolName, event.input);
      state.pendingToolInfo.set(event.toolCallId, desc);
    }
  });

  // ========================================================================
  // Track mutating tools (accumulate per turn, checkpoint at turn_end)
  // ========================================================================

  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!MUTATING_TOOLS.has(event.toolName)) return;


    // Get the description captured from tool_call
    const toolDesc = state.pendingToolInfo.get(event.toolCallId)
      || event.toolName;
    state.pendingToolInfo.delete(event.toolCallId);

    state.turnToolDescriptions.push(toolDesc);
  });

  // ========================================================================
  // Create checkpoint at turn_end (1 per model response, like Cline)
  // ========================================================================

  pi.on("turn_end", async (_event, ctx) => {
    if (!state.gitAvailable) return;
    if (!state.repoRoot || !state.sessionId) return;

    const leafId = ctx.sessionManager.getLeafId();
    const leafEntry = leafId ? ctx.sessionManager.getEntry(leafId) : undefined;
    const root = state.repoRoot;
    const sessionId = state.sessionId;
    const turnIndex = state.currentTurnIndex;
    const promptLabel = state.currentPrompt ? `"${state.currentPrompt}"` : "";
    const toolsLabel = state.turnToolDescriptions.join(", ");
    const description = promptLabel && toolsLabel
      ? `${promptLabel} → ${toolsLabel}`
      : promptLabel || toolsLabel || `Turn ${turnIndex}`;

    try {
      await runRepositoryOperation(state, async () => {
        if (
          !state.gitAvailable
          || state.repoRoot !== root
          || state.sessionId !== sessionId
        ) return;
        const snapshot = await captureWorkspaceSnapshot(root);
        if (
          !state.gitAvailable
          || state.repoRoot !== root
          || state.sessionId !== sessionId
        ) return;

        if (!sameWorkspaceIdentity(snapshot, state.lastWorkspaceIdentity)) {
          const timestamp = Date.now();
          const cp = await createCheckpoint({
            root,
            id: `turn-${sessionId}-${turnIndex}-${timestamp}`,
            sessionId,
            trigger: "tool",
            turnIndex,
            description,
            conversationLeafId: leafEntry?.id,
            conversationLeafParentId: leafEntry?.parentId,
            snapshot,
          });

          if (
            !state.gitAvailable
            || state.repoRoot !== root
            || state.sessionId !== sessionId
          ) return;
          state.checkpoints.set(cp.id, cp);
          state.lastWorkspaceIdentity = {
            worktreeTreeSha: cp.worktreeTreeSha,
            indexTreeSha: cp.indexTreeSha,
          };
        }

        try {
          const protectedIds = new Set(
            [...state.checkpoints.values()]
              .filter((checkpoint) => checkpoint.sessionId !== sessionId)
              .map((checkpoint) => checkpoint.id),
          );
          if (state.undoCheckpoint) protectedIds.add(state.undoCheckpoint.id);
          const pruned = await pruneCheckpoints(
            root,
            sessionId,
            DEFAULT_MAX_CHECKPOINTS,
            protectedIds,
          );
          if (pruned > 0) {
            const remaining = await loadAllCheckpoints(root, sessionId);
            if (
              !state.gitAvailable
              || state.repoRoot !== root
              || state.sessionId !== sessionId
            ) return;
            for (const [id, checkpoint] of state.checkpoints) {
              if (checkpoint.sessionId === sessionId) state.checkpoints.delete(id);
            }
            for (const checkpoint of remaining) {
              if (checkpoint.trigger !== "before-restore") {
                state.checkpoints.set(checkpoint.id, checkpoint);
              }
            }
          }
        } catch {
          // Pruning is non-critical.
        }

        if (
          ctx.hasUI
          && state.gitAvailable
          && state.repoRoot === root
          && state.sessionId === sessionId
        ) updateStatus(state, ctx);
      });
    } catch {
      // Checkpoint failures are non-fatal.
    } finally {
      if (state.repoRoot === root && state.sessionId === sessionId) {
        state.turnToolDescriptions = [];
      }
    }
  });

  // ========================================================================
  // Fork / tree restore hooks
  // ========================================================================

  // OMP uses session_before_branch (Pi renamed it to session_before_fork).
  pi.on("session_before_branch", async (event, ctx) => {
    return handleBranchRestore(state, event, ctx);
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (state.suppressNavigationRestore > 0) return undefined;
    return handleTreeRestore(state, event, ctx);
  });

  // ========================================================================
  // Shutdown
  // ========================================================================

  pi.on("session_shutdown", async () => {
    await state.repositoryTail;
  });
}
