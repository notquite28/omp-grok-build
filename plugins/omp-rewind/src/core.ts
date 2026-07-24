/**
 * omp-rewind — Core git operations
 *
 * Pure git functions with zero coding-agent dependency.
 * Independently testable, safe to import from anywhere.
 */

import { spawn } from "child_process";
import { statSync, readdirSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ============================================================================
// Constants & Types
// ============================================================================

export const ZEROS = "0".repeat(40);
export const REF_BASE = "refs/pi-checkpoints";

/** Maximum size for untracked files to include in snapshot (10 MiB) */
export const MAX_UNTRACKED_FILE_SIZE = 10 * 1024 * 1024;

/** Maximum files in an untracked directory before skipping (200) */
export const MAX_UNTRACKED_DIR_FILES = 200;

/** Default max checkpoints before auto-pruning */
export const DEFAULT_MAX_CHECKPOINTS = 50;

const NO_PROTECTED_CHECKPOINTS: ReadonlySet<string> = new Set();

/** Directories to exclude from snapshots (matched against any path component) */
export const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".env",
  "dist",
  "build",
  ".pytest_cache",
  ".mypy_cache",
  ".cache",
  ".tox",
  "__pycache__",
]);

/** Tools that can change the workspace and warrant a turn-end checkpoint */
export const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "ast_edit",
  "eval",
]);

export interface CheckpointData {
  /** Unique checkpoint ID (used as git ref name) */
  id: string;
  /** Session this checkpoint belongs to */
  sessionId: string;
  /** What triggered this checkpoint */
  trigger: "turn" | "tool" | "resume" | "before-restore";
  /** Turn index when checkpoint was created */
  turnIndex: number;
  /** Tool name if trigger === "tool" */
  toolName?: string;
  /** Human-readable description (prompt text, tool args, etc.) */
  description?: string;
  /** Git branch name at snapshot time */
  branch: string;
  /** SHA of HEAD at snapshot time */
  headSha: string;
  /** SHA of the real git index tree */
  indexTreeSha: string;
  /** SHA of the full worktree tree (index + untracked) */
  worktreeTreeSha: string;
  /** Epoch ms when created */
  timestamp: number;
  /** Untracked files present when snapshot was taken (for safe restore) */
  preexistingUntrackedFiles?: string[];
  /** Files skipped because > 10 MiB */
  skippedLargeFiles?: string[];
  /** Directories skipped because >= 200 files */
  skippedLargeDirs?: string[];
  /** Exact conversation leaf present when the checkpoint was created */
  conversationLeafId?: string;
  /** Parent of the exact conversation leaf; null identifies a root entry */
  conversationLeafParentId?: string | null;
  /** Checkpoint ID this before-restore snapshot can undo */
  restoreTargetId?: string;
}

// ============================================================================
// Git helpers
// ============================================================================

/**
 * Run a git command via spawn (no shell injection).
 * `cmd` is parsed into args respecting quotes.
 */
export function git(
  cmd: string,
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = parseArgs(cmd);
    const proc = spawn("git", args, {
      cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `git ${args[0]} failed (code ${code})`));
    });
    proc.on("error", reject);

    if (opts.input && proc.stdin) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    } else if (proc.stdin) {
      proc.stdin.end();
    }
  });
}

function parseArgs(cmd: string): string[] {
  const args: string[] = [];
  let cur = "";
  let sq = false;
  let dq = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (c === " " && !sq && !dq) {
      if (cur) { args.push(cur); cur = ""; }
    } else cur += c;
  }
  if (cur) args.push(cur);
  return args;
}

export const isGitRepo = (cwd: string) =>
  git("rev-parse --is-inside-work-tree", cwd).then(() => true).catch(() => false);

export const getRepoRoot = (cwd: string) =>
  git("rev-parse --show-toplevel", cwd);

// ============================================================================
// Path filtering
// ============================================================================

/** Returns true if any path component is in IGNORED_DIR_NAMES */
export function shouldIgnoreForSnapshot(path: string): boolean {
  return path.split(/[/\\]/).some((c) => IGNORED_DIR_NAMES.has(c));
}

/** Returns true if file exceeds MAX_UNTRACKED_FILE_SIZE */
export function isLargeFile(root: string, rel: string): boolean {
  try {
    const s = statSync(join(root, rel));
    return s.isFile() && s.size > MAX_UNTRACKED_FILE_SIZE;
  } catch { return false; }
}

/** Returns true if directory contains >= MAX_UNTRACKED_DIR_FILES files */
export function isLargeDirectory(root: string, rel: string): boolean {
  try {
    const full = join(root, rel);
    const s = statSync(full);
    if (!s.isDirectory()) return false;
    return countFiles(full, MAX_UNTRACKED_DIR_FILES) >= MAX_UNTRACKED_DIR_FILES;
  } catch { return false; }
}

function countFiles(dir: string, max: number): number {
  let n = 0;
  const walk = (d: string) => {
    if (n > max) return;
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (n > max) return;
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.isFile()) n++;
      }
    } catch { /* permission errors */ }
  };
  walk(dir);
  return n;
}

function normalizeGitPath(p: string): string {
  let n = p.replace(/\\/g, "/");
  if (n.startsWith("./")) n = n.slice(2);
  return n.replace(/\/$/, "");
}

function isPathWithin(path: string, dir: string): boolean {
  if (!dir || dir === ".") return true;
  if (path === dir) return true;
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return path.startsWith(prefix);
}

function isPathWithinAny(path: string, dirs: Set<string>): boolean {
  for (const d of dirs) if (isPathWithin(path, d)) return true;
  return false;
}

// ============================================================================
// Status snapshot (what files need snapshotting)
// ============================================================================

interface StatusSnapshot {
  trackedPaths: string[];
  untrackedFiles: string[];
  untrackedFilesForIndex: string[];
  untrackedDirs: string[];
  skippedLargeFiles: string[];
}

async function captureStatusSnapshot(root: string): Promise<StatusSnapshot> {
  const snap: StatusSnapshot = {
    trackedPaths: [],
    untrackedFiles: [],
    untrackedFilesForIndex: [],
    untrackedDirs: [],
    skippedLargeFiles: [],
  };

  const output = await git("status --porcelain=2 -z --untracked-files=all", root).catch(() => "");
  if (!output) return snap;

  const entries = output.split("\0").filter(Boolean);
  let expectRename = false;

  for (const entry of entries) {
    if (expectRename) {
      const n = normalizeGitPath(entry);
      if (n) snap.trackedPaths.push(n);
      expectRename = false;
      continue;
    }

    const tag = entry[0];
    if (tag === "?" || tag === "!") {
      const sp = entry.indexOf(" ");
      if (sp === -1) continue;
      const raw = normalizeGitPath(entry.slice(sp + 1));
      if (!raw || shouldIgnoreForSnapshot(raw)) continue;

      let st: ReturnType<typeof statSync> | null = null;
      try { st = statSync(join(root, raw)); } catch { st = null; }

      if (st?.isDirectory()) { snap.untrackedDirs.push(raw); continue; }

      snap.untrackedFiles.push(raw);
      const large = st?.isFile() ? st.size > MAX_UNTRACKED_FILE_SIZE : false;
      if (large) snap.skippedLargeFiles.push(raw);
      else snap.untrackedFilesForIndex.push(raw);
    } else if (tag === "1") {
      const p = extractField(entry, 8);
      if (p) snap.trackedPaths.push(normalizeGitPath(p));
    } else if (tag === "2") {
      const p = extractField(entry, 9);
      if (p) snap.trackedPaths.push(normalizeGitPath(p));
      expectRename = true;
    } else if (tag === "u") {
      const p = extractField(entry, 10);
      if (p) snap.trackedPaths.push(normalizeGitPath(p));
    }
  }
  return snap;
}

function extractField(record: string, n: number): string | null {
  let spaces = 0;
  for (let i = 0; i < record.length; i++) {
    if (record[i] === " " && ++spaces === n) {
      const p = record.slice(i + 1);
      return p.length > 0 ? p : null;
    }
  }
  return null;
}

/** Detect directories with >= threshold untracked files */
function detectLargeDirs(files: string[], dirs: string[], threshold: number): string[] {
  if (threshold <= 0 || files.length === 0) return [];
  const counts = new Map<string, number>();

  const sortedDirs = [...dirs].sort((a, b) => {
    const da = a.split("/").length, db = b.split("/").length;
    return da !== db ? db - da : a.localeCompare(b);
  });

  for (const f of files) {
    let bucket: string | null = null;
    for (const d of sortedDirs) {
      if (isPathWithin(f, d)) { bucket = d; break; }
    }
    if (!bucket) {
      const parts = f.split("/");
      bucket = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    }
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }

  return [...counts.entries()]
    .filter(([k, v]) => v >= threshold && k !== ".")
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

interface FilesToAddResult {
  filtered: string[];
  allUntracked: string[];
  skippedLargeFiles: string[];
  skippedLargeDirs: string[];
}

async function getFilesToAdd(root: string): Promise<FilesToAddResult> {
  const status = await captureStatusSnapshot(root);
  const largeDirs = detectLargeDirs(
    status.untrackedFiles,
    status.untrackedDirs,
    MAX_UNTRACKED_DIR_FILES,
  );
  const largeDirsSet = new Set(largeDirs);

  const untrackedForIndex = status.untrackedFilesForIndex
    .filter((p) => !isPathWithinAny(p, largeDirsSet));
  const skippedLargeFiles = status.skippedLargeFiles
    .filter((p) => !isPathWithinAny(p, largeDirsSet));

  const all = new Set<string>();
  status.trackedPaths.forEach((p) => all.add(p));
  untrackedForIndex.forEach((p) => all.add(p));

  return {
    filtered: [...all],
    allUntracked: status.untrackedFiles,
    skippedLargeFiles,
    skippedLargeDirs: largeDirs,
  };
}

export interface WorkspaceSnapshot {
  headSha: string;
  branch: string;
  indexTreeSha: string;
  worktreeTreeSha: string;
  preexistingUntrackedFiles: string[];
  skippedLargeFiles: string[];
  skippedLargeDirs: string[];
}

export interface WorkspaceIdentity {
  worktreeTreeSha: string;
  indexTreeSha: string;
}

export function sameWorkspaceIdentity(
  a: WorkspaceIdentity | null,
  b: WorkspaceIdentity | null,
): boolean {
  return a !== null
    && b !== null
    && a.worktreeTreeSha === b.worktreeTreeSha
    && a.indexTreeSha === b.indexTreeSha;
}

export async function captureWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  const headSha = await git("rev-parse HEAD", root).catch(() => ZEROS);
  const branch = await git("rev-parse --abbrev-ref HEAD", root).catch(() => "unknown");
  const indexTreeSha = await git("write-tree", root);
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-"));
  const tmpIndex = join(tmpDir, "index");

  try {
    const tmpEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const { filtered, allUntracked, skippedLargeFiles, skippedLargeDirs } =
      await getFilesToAdd(root);
    const largeDirsSet = new Set(skippedLargeDirs);
    const largeFilesSet = new Set(skippedLargeFiles);
    const preexistingUntrackedFiles = allUntracked.filter((file) => {
      if (shouldIgnoreForSnapshot(file)) return false;
      if (largeFilesSet.has(file)) return false;
      if (isPathWithinAny(file, largeDirsSet)) return false;
      return true;
    });

    if (headSha !== ZEROS) {
      await git(`read-tree ${headSha}`, root, { env: tmpEnv });
    }

    const batchSize = 100;
    for (let i = 0; i < filtered.length; i += batchSize) {
      const paths = filtered
        .slice(i, i + batchSize)
        .map((file) => `"${file}"`)
        .join(" ");
      await git(`add --all -- ${paths}`, root, { env: tmpEnv });
    }

    const worktreeTreeSha = await git("write-tree", root, { env: tmpEnv });
    return {
      headSha,
      branch,
      indexTreeSha,
      worktreeTreeSha,
      preexistingUntrackedFiles,
      skippedLargeFiles,
      skippedLargeDirs,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================================
// Checkpoint CRUD
// ============================================================================

export interface CreateCheckpointOpts {
  root: string;
  id: string;
  sessionId: string;
  trigger: CheckpointData["trigger"];
  turnIndex: number;
  toolName?: string;
  /** Human-readable label (user prompt, tool args summary) */
  description?: string;
  conversationLeafId?: string;
  conversationLeafParentId?: string | null;
  restoreTargetId?: string;
  snapshot?: WorkspaceSnapshot;
}

/**
 * Snapshot HEAD + index + worktree into a git ref.
 * Returns full checkpoint metadata.
 */
export async function createCheckpoint(opts: CreateCheckpointOpts): Promise<CheckpointData> {
  const {
    root,
    id,
    sessionId,
    trigger,
    turnIndex,
    toolName,
    description,
    conversationLeafId,
    conversationLeafParentId,
    restoreTargetId,
    snapshot,
  } = opts;
  const timestamp = Date.now();
  const iso = new Date(timestamp).toISOString();
  const workspace = snapshot ?? await captureWorkspaceSnapshot(root);

  const msg = [
    `pi-rewind:${id}`,
    `sessionId ${sessionId}`,
    `trigger ${trigger}`,
    `turn ${turnIndex}`,
    toolName ? `toolName ${toolName}` : null,
    description ? `description ${description}` : null,
    conversationLeafId ? `conversation-leaf ${conversationLeafId}` : null,
    conversationLeafParentId !== undefined
      ? `conversation-leaf-parent ${conversationLeafParentId === null ? "null" : conversationLeafParentId}`
      : null,
    restoreTargetId ? `restore-target ${restoreTargetId}` : null,
    `branch ${workspace.branch}`,
    `head ${workspace.headSha}`,
    `index-tree ${workspace.indexTreeSha}`,
    `worktree-tree ${workspace.worktreeTreeSha}`,
    `created ${iso}`,
    `untracked ${JSON.stringify(workspace.preexistingUntrackedFiles)}`,
    `largeFiles ${JSON.stringify(workspace.skippedLargeFiles)}`,
    `largeDirs ${JSON.stringify(workspace.skippedLargeDirs)}`,
  ].filter(Boolean).join("\n");

  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "pi-rewind",
    GIT_AUTHOR_EMAIL: "rewind@pi",
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_NAME: "pi-rewind",
    GIT_COMMITTER_EMAIL: "rewind@pi",
    GIT_COMMITTER_DATE: iso,
  };

  const commitSha = await git(`commit-tree ${workspace.worktreeTreeSha}`, root, {
    input: msg,
    env: commitEnv,
  });
  await git(`update-ref ${REF_BASE}/${id} ${commitSha}`, root);

  return {
    id,
    sessionId,
    trigger,
    turnIndex,
    toolName,
    description,
    conversationLeafId,
    conversationLeafParentId,
    restoreTargetId,
    branch: workspace.branch,
    headSha: workspace.headSha,
    indexTreeSha: workspace.indexTreeSha,
    worktreeTreeSha: workspace.worktreeTreeSha,
    timestamp,
    preexistingUntrackedFiles: workspace.preexistingUntrackedFiles,
    skippedLargeFiles: workspace.skippedLargeFiles.length > 0
      ? workspace.skippedLargeFiles
      : undefined,
    skippedLargeDirs: workspace.skippedLargeDirs.length > 0
      ? workspace.skippedLargeDirs
      : undefined,
  };
}

/**
 * Restore worktree + index to a checkpoint's state.
 * Safely preserves pre-existing untracked files and skipped large items.
 */
export async function restoreCheckpoint(root: string, cp: CheckpointData): Promise<void> {
  // Safety: verify we're on the same branch as when the checkpoint was created
  if (cp.branch) {
    const currentBranch = await git("rev-parse --abbrev-ref HEAD", root).catch(() => "unknown");
    if (currentBranch !== cp.branch) {
      throw new Error(
        `Branch mismatch: checkpoint was created on "${cp.branch}" but you are on "${currentBranch}". ` +
        `Switch to "${cp.branch}" first, or this restore could corrupt your worktree.`
      );
    }
  }
  // 1. Restore worktree from snapshot tree without moving HEAD
  await git(`read-tree --reset -u ${cp.worktreeTreeSha}`, root);

  // 2. Safe-clean new untracked files only
  await safeClean(
    root,
    cp.preexistingUntrackedFiles || [],
    cp.skippedLargeFiles || [],
    cp.skippedLargeDirs || [],
  );

  // 3. Restore staged state without touching files
  await git(`read-tree --reset ${cp.indexTreeSha}`, root);
}

export interface WorkspaceComparison {
  currentWorktreeTreeSha: string;
  currentIndexTreeSha: string;
  worktreeChanged: boolean;
  indexChanged: boolean;
  worktreeStat: string;
  indexStat: string;
  skippedLargeFiles: string[];
  skippedLargeDirs: string[];
}

export interface TreeChange {
  status: "A" | "M" | "D";
  path: string;
}

export interface CheckpointDiff {
  comparison: WorkspaceComparison;
  worktreeChanges: TreeChange[];
  indexChanges: TreeChange[];
}

export async function compareCheckpointToCurrent(
  root: string,
  checkpoint: CheckpointData,
): Promise<WorkspaceComparison> {
  const current = await captureWorkspaceSnapshot(root);
  const worktreeChanged = current.worktreeTreeSha !== checkpoint.worktreeTreeSha;
  const indexChanged = current.indexTreeSha !== checkpoint.indexTreeSha;
  const maxStatLength = 2000;
  const [worktreeStat, indexStat] = await Promise.all([
    worktreeChanged
      ? diffCheckpoints(root, checkpoint.worktreeTreeSha, current.worktreeTreeSha)
      : "",
    indexChanged
      ? diffCheckpoints(root, checkpoint.indexTreeSha, current.indexTreeSha)
      : "",
  ]);

  return {
    currentWorktreeTreeSha: current.worktreeTreeSha,
    currentIndexTreeSha: current.indexTreeSha,
    worktreeChanged,
    indexChanged,
    worktreeStat: worktreeStat.slice(0, maxStatLength),
    indexStat: indexStat.slice(0, maxStatLength),
    skippedLargeFiles: current.skippedLargeFiles,
    skippedLargeDirs: current.skippedLargeDirs,
  };
}

export async function listTreeChanges(
  root: string,
  fromTree: string,
  toTree: string,
): Promise<TreeChange[]> {
  const output = await git(
    `diff-tree --no-commit-id -r --no-renames --name-status -z ${fromTree} ${toTree}`,
    root,
  );
  if (!output) return [];

  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: TreeChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const rawStatus = fields[index];
    const path = fields[index + 1];
    if (!rawStatus || path === undefined) {
      throw new Error("Tree diff: unsupported status malformed");
    }
    const status = rawStatus === "T" ? "M" : rawStatus;
    if (status !== "A" && status !== "M" && status !== "D") {
      throw new Error(`Tree diff: unsupported status ${rawStatus}`);
    }
    changes.push({ status, path });
  }
  return changes;
}

export async function buildCheckpointDiff(
  root: string,
  checkpoint: CheckpointData,
): Promise<CheckpointDiff> {
  const comparison = await compareCheckpointToCurrent(root, checkpoint);
  const [worktreeChanges, indexChanges] = await Promise.all([
    comparison.worktreeChanged
      ? listTreeChanges(root, comparison.currentWorktreeTreeSha, checkpoint.worktreeTreeSha)
      : Promise.resolve([]),
    comparison.indexChanged
      ? listTreeChanges(root, comparison.currentIndexTreeSha, checkpoint.indexTreeSha)
      : Promise.resolve([]),
  ]);
  return { comparison, worktreeChanges, indexChanges };
}

async function safeClean(
  root: string,
  preexisting: string[],
  skippedFiles: string[],
  skippedDirs: string[],
): Promise<void> {
  const currentWorkspace = await getFilesToAdd(root);
  const current = currentWorkspace.allUntracked;
  if (current.length === 0) return;

  const preSet = new Set(preexisting);
  const sfSet = new Set([...skippedFiles, ...currentWorkspace.skippedLargeFiles]);
  const sdSet = new Set([...skippedDirs, ...currentWorkspace.skippedLargeDirs]);

  const toRemove = current.filter((f) => {
    if (preSet.has(f)) return false;
    if (shouldIgnoreForSnapshot(f)) return false;
    if (sfSet.has(f)) return false;
    if (isPathWithinAny(f, sdSet)) return false;
    return true;
  });

  if (toRemove.length === 0) return;

  const BATCH = 100;
  for (let i = 0; i < toRemove.length; i += BATCH) {
    const batch = toRemove.slice(i, i + BATCH);
    const paths = batch.map((f) => `"${f}"`).join(" ");
    await git(`clean -f -- ${paths}`, root);
  }
}

// ============================================================================
// Load / list checkpoints
// ============================================================================

export interface CheckpointInspection {
  id: string;
  checkpoint: CheckpointData | null;
  errors: string[];
}

function parseCheckpointMetadata(refName: string, msg: string): CheckpointData | null {
  const get = (key: string) =>
    msg.match(new RegExp(`^${key} (.+)$`, "m"))?.[1]?.trim();

  const sid = get("sessionId");
  const turn = get("turn");
  const head = get("head");
  const idx = get("index-tree");
  const wt = get("worktree-tree");
  if (!sid || !turn || !head || !idx || !wt) return null;

  const parseJson = (key: string): string[] | undefined => {
    const raw = get(key);
    if (!raw) return undefined;
    try {
      const arr = JSON.parse(raw);
      return arr.length > 0 ? arr : undefined;
    } catch {
      return undefined;
    }
  };
  const conversationLeafParent = get("conversation-leaf-parent");

  return {
    id: refName,
    sessionId: sid,
    trigger: (get("trigger") as CheckpointData["trigger"]) || "turn",
    turnIndex: parseInt(turn, 10),
    toolName: get("toolName"),
    description: get("description"),
    conversationLeafId: get("conversation-leaf"),
    conversationLeafParentId: conversationLeafParent === undefined
      ? undefined
      : conversationLeafParent === "null" ? null : conversationLeafParent,
    restoreTargetId: get("restore-target"),
    branch: get("branch") || "unknown",
    headSha: head,
    indexTreeSha: idx,
    worktreeTreeSha: wt,
    timestamp: get("created") ? new Date(get("created")!).getTime() : 0,
    preexistingUntrackedFiles: parseJson("untracked"),
    skippedLargeFiles: parseJson("largeFiles"),
    skippedLargeDirs: parseJson("largeDirs"),
  };
}

async function loadCheckpointMetadataFromRef(
  root: string,
  id: string,
): Promise<CheckpointData | null> {
  if (!isSafeId(id)) return null;
  try {
    const commitSha = await git(`rev-parse --verify ${REF_BASE}/${id}`, root);
    const msg = await git(`cat-file commit ${commitSha}`, root);
    return parseCheckpointMetadata(id, msg);
  } catch {
    return null;
  }
}

export async function inspectCheckpointRef(
  root: string,
  id: string,
): Promise<CheckpointInspection> {
  const checkpoint = await loadCheckpointMetadataFromRef(root, id);

  if (!checkpoint) {
    return { id, checkpoint: null, errors: ["invalid checkpoint metadata"] };
  }

  const errors: string[] = [];
  await git(`cat-file -e "${checkpoint.indexTreeSha}^{tree}"`, root).catch(() => {
    errors.push(`missing index tree ${checkpoint!.indexTreeSha}`);
  });
  await git(`cat-file -e "${checkpoint.worktreeTreeSha}^{tree}"`, root).catch(() => {
    errors.push(`missing worktree tree ${checkpoint!.worktreeTreeSha}`);
  });
  return { id, checkpoint: errors.length === 0 ? checkpoint : null, errors };
}

export async function inspectAllCheckpointRefs(root: string): Promise<CheckpointInspection[]> {
  const refs = await listCheckpointRefs(root);
  return Promise.all(refs.map((id) => inspectCheckpointRef(root, id)));
}

/** Load checkpoint metadata from a git ref */
export async function loadCheckpointFromRef(
  root: string,
  refName: string,
): Promise<CheckpointData | null> {
  return loadCheckpointMetadataFromRef(root, refName);
}

/** List all checkpoint ref names under REF_BASE */
export async function listCheckpointRefs(root: string): Promise<string[]> {
  try {
    const prefix = `${REF_BASE}/`;
    const out = await git(`for-each-ref --format=%(refname) ${prefix}`, root);
    return out.split("\n").filter(Boolean).map((r) => r.replace(prefix, ""));
  } catch {
    return [];
  }
}

/** Load all checkpoints, optionally filtered by session */
export async function loadAllCheckpoints(
  root: string,
  sessionId?: string,
): Promise<CheckpointData[]> {
  const refs = await listCheckpointRefs(root);
  const results = await Promise.all(refs.map((r) => loadCheckpointFromRef(root, r)));
  return results.filter(
    (cp): cp is CheckpointData =>
      cp !== null && (!sessionId || cp.sessionId === sessionId),
  );
}

/** Delete a checkpoint ref */
export async function deleteCheckpoint(root: string, id: string): Promise<void> {
  await git(`update-ref -d ${REF_BASE}/${id}`, root);
}

/** Prune oldest checkpoints for a session, keeping at most `max` */
export async function pruneCheckpoints(
  root: string,
  sessionId: string,
  max: number = DEFAULT_MAX_CHECKPOINTS,
  protectedIds: ReadonlySet<string> = NO_PROTECTED_CHECKPOINTS,
): Promise<number> {
  const all = await loadAllCheckpoints(root, sessionId);
  all.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const deletionTarget = Math.max(0, all.length - max);
  let deleted = 0;

  for (const checkpoint of all) {
    if (deleted >= deletionTarget) break;
    if (protectedIds.has(checkpoint.id)) continue;
    try {
      await deleteCheckpoint(root, checkpoint.id);
      deleted++;
    } catch {
      // Automatic history pruning is best effort.
    }
  }
  return deleted;
}

/**
 * Prune checkpoints from all sessions except the current one.
 * Keeps only the most recent `keepPerOldSession` checkpoints per old session.
 * Returns total number of deleted checkpoints.
 */
export async function pruneOldSessions(
  root: string,
  currentSessionId: string,
  protectedIds: ReadonlySet<string> = NO_PROTECTED_CHECKPOINTS,
  keepPerOldSession: number = 0,
): Promise<number> {
  const checkpoints = await loadAllCheckpoints(root);
  const bySession = new Map<string, CheckpointData[]>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.sessionId === currentSessionId) continue;
    const sessionCheckpoints = bySession.get(checkpoint.sessionId);
    if (sessionCheckpoints) sessionCheckpoints.push(checkpoint);
    else bySession.set(checkpoint.sessionId, [checkpoint]);
  }

  let deleted = 0;
  for (const sessionCheckpoints of bySession.values()) {
    const toDelete = sessionCheckpoints
      .filter((checkpoint) => !protectedIds.has(checkpoint.id))
      .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id))
      .slice(keepPerOldSession);
    for (const checkpoint of toDelete) {
      try {
        await deleteCheckpoint(root, checkpoint.id);
        deleted++;
      } catch {
        // Automatic old-session pruning is best effort.
      }
    }
  }
  return deleted;
}

/** Get a diff summary between two checkpoint trees */
export async function diffCheckpoints(
  root: string,
  fromTree: string,
  toTree: string,
): Promise<string> {
  try {
    // diff-tree compares two tree objects and works with tree SHAs or commit refs
    return await git(`diff-tree --stat --no-commit-id ${fromTree} ${toTree}`, root);
  } catch {
    return "(diff unavailable)";
  }
}

// ============================================================================
// Utilities
// ============================================================================

/** Validate ID contains only safe characters */
export const isSafeId = (id: string) => /^[\w-]+$/.test(id);

/** Sanitize a string for use in git ref names */
export function sanitizeForRef(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, "_");
}

