/**
 * omp-rewind — Shared state
 *
 * Mutable state shared between index.ts, commands.ts, and ui.ts.
 */

import type { CheckpointData, WorkspaceIdentity } from "./core.js";

export interface RewindState {
  /** Is the cwd a git repo? */
  gitAvailable: boolean;
  /** Absolute path to repo root */
  repoRoot: string | null;
  /** Current session ID (UUID) */
  sessionId: string | null;
  /** In-memory checkpoint cache: checkpoint ID → data */
  checkpoints: Map<string, CheckpointData>;
  /** Checkpoint taken at session start (fallback for restore) */
  resumeCheckpoint: CheckpointData | null;
  /** Singular durable checkpoint used by Undo last rewind */
  undoCheckpoint: CheckpointData | null;
  /** FIFO tail for every repository operation */
  repositoryTail: Promise<void>;
  /** Nesting guard for tree navigation initiated by this plugin */
  suppressNavigationRestore: number;
  /** Current turn index (updated by turn_start) */
  currentTurnIndex: number;
  /** Current user prompt (updated by before_agent_start) */
  currentPrompt: string;
  /** Pending tool info captured from tool_call (before execution ends) */
  pendingToolInfo: Map<string, string>;
  /** Tool descriptions accumulated during the current turn */
  turnToolDescriptions: string[];
  /** Exact worktree and index identity retained by the latest checkpoint or restore */
  lastWorkspaceIdentity: WorkspaceIdentity | null;
}

export function createInitialState(): RewindState {
  return {
    gitAvailable: false,
    repoRoot: null,
    sessionId: null,
    checkpoints: new Map(),
    resumeCheckpoint: null,
    undoCheckpoint: null,
    repositoryTail: Promise.resolve(),
    suppressNavigationRestore: 0,
    currentTurnIndex: 0,
    currentPrompt: "",
    pendingToolInfo: new Map(),
    turnToolDescriptions: [],
    lastWorkspaceIdentity: null,
  };
}

export function resetState(state: RewindState): void {
  state.gitAvailable = false;
  state.repoRoot = null;
  state.sessionId = null;
  state.checkpoints.clear();
  state.resumeCheckpoint = null;
  state.undoCheckpoint = null;
  state.currentTurnIndex = 0;
  state.suppressNavigationRestore = 0;
  state.currentPrompt = "";
  state.pendingToolInfo.clear();
  state.turnToolDescriptions = [];
  state.lastWorkspaceIdentity = null;
}

export function runRepositoryOperation<T>(
  state: RewindState,
  operation: () => Promise<T>,
): Promise<T> {
  const result = state.repositoryTail.catch(() => undefined).then(operation);
  state.repositoryTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
