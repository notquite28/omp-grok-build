/**
 * omp-rewind — Core unit tests
 *
 * Tests git operations on a disposable temp repo. No OMP host needed.
 *
 * Run: bun tests/core.test.ts
 */

import { chmod, mkdtemp, rm, writeFile, mkdir, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  git,
  isGitRepo,
  getRepoRoot,
  createCheckpoint,
  restoreCheckpoint,
  compareCheckpointToCurrent,
  loadCheckpointFromRef,
  listCheckpointRefs,
  loadAllCheckpoints,
  deleteCheckpoint,
  pruneCheckpoints,
  pruneOldSessions,
  shouldIgnoreForSnapshot,
  sanitizeForRef,
  isSafeId,
  MUTATING_TOOLS,
  MAX_UNTRACKED_FILE_SIZE,
  captureWorkspaceSnapshot,
  sameWorkspaceIdentity,
  buildCheckpointDiff,
  inspectCheckpointRef,
  inspectAllCheckpointRefs,
  type CreateCheckpointOpts,
  type CheckpointData,
} from "../src/core.js";

// ============================================================================
// Test harness
// ============================================================================

let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`  ✗ ${name}: ${msg}`);
    console.log(`  ✗ ${name}: ${msg}`);
  }
}

// ============================================================================
// Repo setup helpers
// ============================================================================

async function createTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
  await git("init", dir);
  await git('config user.email "test@test.com"', dir);
  await git('config user.name "Test"', dir);

  // Initial commit so HEAD exists
  await writeFile(join(dir, "README.md"), "# Test\n");
  await git("add .", dir);
  await git('commit -m "initial"', dir);

  return dir;
}

async function cleanupRepo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

function makeOpts(root: string, overrides: Partial<CreateCheckpointOpts> = {}): CreateCheckpointOpts {
  return {
    root,
    id: `test-${Date.now()}`,
    sessionId: "test-session",
    trigger: "turn",
    turnIndex: 0,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

async function runTests() {
  console.log("\n🧪 omp-rewind core tests\n");

  // ------ Utilities ------

  console.log("Utilities:");

  await test("isSafeId accepts valid IDs", async () => {
    assert(isSafeId("abc-123_def"), "should accept alphanumeric + dash + underscore");
    assert(!isSafeId("abc def"), "should reject spaces");
    assert(!isSafeId("abc/def"), "should reject slashes");
    assert(!isSafeId(""), "should reject empty");
  });

  await test("sanitizeForRef cleans special characters", async () => {
    assertEqual(sanitizeForRef("abc:def/ghi"), "abc_def_ghi", "colons and slashes");
    assertEqual(sanitizeForRef("hello-world_123"), "hello-world_123", "safe chars untouched");
  });

  await test("shouldIgnoreForSnapshot filters known dirs", async () => {
    assert(shouldIgnoreForSnapshot("node_modules/foo.js"), "node_modules");
    assert(shouldIgnoreForSnapshot("src/.venv/bin/python"), ".venv");
    assert(shouldIgnoreForSnapshot("dist/index.js"), "dist");
    assert(!shouldIgnoreForSnapshot("src/index.ts"), "src should pass");
    assert(!shouldIgnoreForSnapshot("lib/utils.ts"), "lib should pass");
  });

  await test("MUTATING_TOOLS has expected tools", async () => {
    assert(MUTATING_TOOLS.has("write"), "write");
    assert(MUTATING_TOOLS.has("edit"), "edit");
    assert(MUTATING_TOOLS.has("bash"), "bash");
    assert(MUTATING_TOOLS.has("ast_edit"), "ast_edit");
    assert(MUTATING_TOOLS.has("eval"), "eval");
    assert(!MUTATING_TOOLS.has("read"), "read should not be mutating");
  });

  // ------ Git helpers ------

  console.log("\nGit helpers:");

  let repo = "";

  await test("isGitRepo returns true for git repo", async () => {
    repo = await createTempRepo();
    assertEqual(await isGitRepo(repo), true, "temp repo");
  });

  await test("isGitRepo returns false for non-repo", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "not-a-repo-"));
    try {
      assertEqual(await isGitRepo(tmp), false, "plain dir");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  await test("getRepoRoot returns correct path", async () => {
    const root = await getRepoRoot(repo);
    // Resolve symlinks for macOS /private/tmp
    const { realpathSync } = await import("fs");
    assertEqual(realpathSync(root), realpathSync(repo), "root matches");
  });

  // ------ Checkpoint CRUD ------

  console.log("\nCheckpoint CRUD:");

  await test("createCheckpoint returns valid data", async () => {
    const cp = await createCheckpoint(makeOpts(repo, { id: "cp-1", turnIndex: 0 }));
    assertEqual(cp.id, "cp-1", "id");
    assertEqual(cp.sessionId, "test-session", "sessionId");
    assertEqual(cp.trigger, "turn", "trigger");
    assertEqual(cp.turnIndex, 0, "turnIndex");
    assert(cp.headSha.length === 40, "headSha is 40 chars");
    assert(cp.worktreeTreeSha.length === 40, "worktreeTreeSha is 40 chars");
    assert(cp.timestamp > 0, "timestamp > 0");
  });

  await test("loadCheckpointFromRef roundtrips", async () => {
    const loaded = await loadCheckpointFromRef(repo, "cp-1");
    assert(loaded !== null, "loaded should not be null");
    assertEqual(loaded!.id, "cp-1", "id");
    assertEqual(loaded!.sessionId, "test-session", "sessionId");
    assertEqual(loaded!.trigger, "turn", "trigger");
  });

  await test("listCheckpointRefs lists created refs", async () => {
    await createCheckpoint(makeOpts(repo, { id: "cp-2", turnIndex: 1 }));
    const refs = await listCheckpointRefs(repo);
    assert(refs.includes("cp-1"), "cp-1 in list");
    assert(refs.includes("cp-2"), "cp-2 in list");
  });

  await test("loadAllCheckpoints filters by session", async () => {
    await createCheckpoint(makeOpts(repo, { id: "cp-other", sessionId: "other-session" }));
    const all = await loadAllCheckpoints(repo);
    assert(all.length >= 3, "has at least 3 checkpoints");

    const filtered = await loadAllCheckpoints(repo, "test-session");
    assert(filtered.every((cp) => cp.sessionId === "test-session"), "all match session");
    assert(!filtered.some((cp) => cp.id === "cp-other"), "other session excluded");
  });

  await test("deleteCheckpoint removes ref", async () => {
    await deleteCheckpoint(repo, "cp-other");
    const refs = await listCheckpointRefs(repo);
    assert(!refs.includes("cp-other"), "cp-other deleted");
  });

  // ------ Snapshot & Restore ------

  console.log("\nSnapshot & Restore:");

  await test("restore reverts file changes", async () => {
    // Create a checkpoint with file "a.txt"
    await writeFile(join(repo, "a.txt"), "version 1");
    await git("add a.txt", repo);
    const cp = await createCheckpoint(makeOpts(repo, { id: "cp-restore", turnIndex: 5 }));

    // Modify the file
    await writeFile(join(repo, "a.txt"), "version 2");
    const before = await readFile(join(repo, "a.txt"), "utf-8");
    assertEqual(before, "version 2", "file modified");

    // Restore
    await restoreCheckpoint(repo, cp);
    const after = await readFile(join(repo, "a.txt"), "utf-8");
    assertEqual(after, "version 1", "file restored");
  });

  await test("restore preserves pre-existing untracked files", async () => {
    // Create untracked file, then checkpoint
    await writeFile(join(repo, "preexisting.txt"), "keep me");
    const cp = await createCheckpoint(makeOpts(repo, { id: "cp-safe", turnIndex: 6 }));

    // Add a new untracked file
    await writeFile(join(repo, "new-file.txt"), "delete me");

    // Restore should keep preexisting.txt but remove new-file.txt
    await restoreCheckpoint(repo, cp);

    const exists = await stat(join(repo, "preexisting.txt")).then(() => true).catch(() => false);
    assert(exists, "preexisting file preserved");

    const newExists = await stat(join(repo, "new-file.txt")).then(() => true).catch(() => false);
    assert(!newExists, "new file removed");
  });

  await test("snapshot ignores node_modules", async () => {
    await mkdir(join(repo, "node_modules"), { recursive: true });
    await writeFile(join(repo, "node_modules", "pkg.js"), "module");
    const cp = await createCheckpoint(makeOpts(repo, { id: "cp-ignore" }));
    // node_modules content should not appear in preexistingUntrackedFiles
    const hasNM = cp.preexistingUntrackedFiles?.some((f) => f.includes("node_modules"));
    assert(!hasNM, "node_modules excluded from preexisting list");
  });


  await test("restore preserves HEAD while restoring staged and worktree trees", async () => {
    const restoreRepo = await createTempRepo();
    try {
      await writeFile(join(restoreRepo, "state.txt"), "commit A\n");
      await git("add state.txt", restoreRepo);
      await git('commit -m "commit A"', restoreRepo);
      await writeFile(join(restoreRepo, "state.txt"), "staged checkpoint\n");
      await git("add state.txt", restoreRepo);
      await writeFile(join(restoreRepo, "state.txt"), "worktree checkpoint\n");
      const checkpoint = await createCheckpoint(makeOpts(restoreRepo, {
        id: "head-preserving",
      }));

      await writeFile(join(restoreRepo, "state.txt"), "commit B\n");
      await git("add state.txt", restoreRepo);
      await git('commit -m "commit B"', restoreRepo);
      const headBefore = await git("rev-parse HEAD", restoreRepo);
      const branchBefore = await git("symbolic-ref -q HEAD", restoreRepo);
      const branchTipBefore = await git(`rev-parse ${branchBefore}`, restoreRepo);

      await restoreCheckpoint(restoreRepo, checkpoint);

      assertEqual(
        await readFile(join(restoreRepo, "state.txt"), "utf-8"),
        "worktree checkpoint\n",
        "worktree bytes restored",
      );
      assertEqual(await git("write-tree", restoreRepo), checkpoint.indexTreeSha, "index restored");
      const comparison = await compareCheckpointToCurrent(restoreRepo, checkpoint);
      assert(!comparison.worktreeChanged, "restored worktree matches checkpoint");
      assert(!comparison.indexChanged, "restored index matches checkpoint");
      assertEqual(await git("rev-parse HEAD", restoreRepo), headBefore, "HEAD unchanged");
      assertEqual(await git("symbolic-ref -q HEAD", restoreRepo), branchBefore, "branch unchanged");
      assertEqual(
        await git(`rev-parse ${branchBefore}`, restoreRepo),
        branchTipBefore,
        "branch tip unchanged",
      );
    } finally {
      await cleanupRepo(restoreRepo);
    }
  });

  await test("restore propagates git clean failures", async () => {
    const cleanRepo = await createTempRepo();
    const lockedDir = join(cleanRepo, "locked");
    try {
      const checkpoint = await createCheckpoint(makeOpts(cleanRepo, { id: "clean-failure" }));
      await mkdir(lockedDir);
      await writeFile(join(lockedDir, "post.txt"), "cannot clean");
      await chmod(lockedDir, 0o555);
      let rejected = false;
      try {
        await restoreCheckpoint(cleanRepo, checkpoint);
      } catch {
        rejected = true;
      }
      assert(rejected, "git clean failure rejects restore");
    } finally {
      await chmod(lockedDir, 0o755).catch(() => {});
      await cleanupRepo(cleanRepo);
    }
  });

  await test("checkpoint identity metadata roundtrips and legacy metadata stays absent", async () => {
    const identity = await createCheckpoint(makeOpts(repo, {
      id: "identity-roundtrip",
      conversationLeafId: "leaf-1",
      conversationLeafParentId: null,
      restoreTargetId: "target-1",
    }));
    const loadedIdentity = await loadCheckpointFromRef(repo, identity.id);
    assertEqual(loadedIdentity?.conversationLeafId, "leaf-1", "leaf ID");
    assertEqual(loadedIdentity?.conversationLeafParentId, null, "nullable parent");
    assertEqual(loadedIdentity?.restoreTargetId, "target-1", "restore linkage");

    const legacy = await createCheckpoint(makeOpts(repo, { id: "legacy-metadata" }));
    const loadedLegacy = await loadCheckpointFromRef(repo, legacy.id);
    assertEqual(loadedLegacy?.conversationLeafId, undefined, "legacy leaf omitted");
    assertEqual(loadedLegacy?.conversationLeafParentId, undefined, "legacy parent omitted");
    assertEqual(loadedLegacy?.restoreTargetId, undefined, "legacy linkage omitted");
  });

  await test("workspace comparison separates index, worktree, untracked, and skipped paths", async () => {
    const comparisonRepo = await createTempRepo();
    try {
      await writeFile(join(comparisonRepo, "tracked.txt"), "base\n");
      await git("add tracked.txt", comparisonRepo);
      await git('commit -m "tracked baseline"', comparisonRepo);
      const checkpoint = await createCheckpoint(makeOpts(comparisonRepo, {
        id: "comparison-baseline",
      }));

      await writeFile(join(comparisonRepo, "tracked.txt"), "staged\n");
      await git("add tracked.txt", comparisonRepo);
      await writeFile(join(comparisonRepo, "tracked.txt"), "base\n");
      let comparison = await compareCheckpointToCurrent(comparisonRepo, checkpoint);
      assert(!comparison.worktreeChanged, "staged-only change leaves worktree tree unchanged");
      assert(comparison.indexChanged, "staged-only change changes index");
      assert(comparison.indexStat.includes("tracked.txt"), "index stat names staged path");

      await git("reset --hard HEAD", comparisonRepo);
      await writeFile(join(comparisonRepo, "tracked.txt"), "unstaged\n");
      comparison = await compareCheckpointToCurrent(comparisonRepo, checkpoint);
      assert(comparison.worktreeChanged, "unstaged change changes worktree");
      assert(!comparison.indexChanged, "unstaged change leaves index");
      assert(comparison.worktreeStat.includes("tracked.txt"), "worktree stat names unstaged path");

      await git("reset --hard HEAD", comparisonRepo);
      await writeFile(join(comparisonRepo, "untracked.txt"), "untracked\n");
      comparison = await compareCheckpointToCurrent(comparisonRepo, checkpoint);
      assert(comparison.worktreeChanged, "eligible untracked change changes worktree");
      assert(comparison.worktreeStat.includes("untracked.txt"), "worktree stat names untracked path");

      await writeFile(
        join(comparisonRepo, "large.bin"),
        Buffer.alloc(MAX_UNTRACKED_FILE_SIZE + 1),
      );
      await mkdir(join(comparisonRepo, "bulk"));
      await Promise.all(
        Array.from({ length: 200 }, (_, index) =>
          writeFile(join(comparisonRepo, "bulk", `${index}.txt`), "x")),
      );
      await mkdir(join(comparisonRepo, "node_modules"));
      await writeFile(join(comparisonRepo, "node_modules", "ignored.js"), "ignored");
      comparison = await compareCheckpointToCurrent(comparisonRepo, checkpoint);
      assert(comparison.skippedLargeFiles.includes("large.bin"), "large file reported");
      assert(comparison.skippedLargeDirs.includes("bulk"), "large directory reported");

      await restoreCheckpoint(comparisonRepo, checkpoint);
      assert(await stat(join(comparisonRepo, "large.bin")).then(() => true), "large file preserved");
      assert(await stat(join(comparisonRepo, "bulk", "0.txt")).then(() => true), "large dir preserved");
      assert(
        await stat(join(comparisonRepo, "node_modules", "ignored.js")).then(() => true),
        "ignored file preserved",
      );
    } finally {
      await cleanupRepo(comparisonRepo);
    }
  });

  await test("composite identity and supplied snapshots preserve exact trees", async () => {
    const identityRepo = await createTempRepo();
    try {
      const snapshot = await captureWorkspaceSnapshot(identityRepo);
      assert(
        sameWorkspaceIdentity(snapshot, {
          worktreeTreeSha: snapshot.worktreeTreeSha,
          indexTreeSha: snapshot.indexTreeSha,
        }),
        "matching worktree and index identities",
      );
      assert(
        !sameWorkspaceIdentity(snapshot, {
          worktreeTreeSha: snapshot.worktreeTreeSha,
          indexTreeSha: "f".repeat(40),
        }),
        "index SHA participates in identity",
      );

      await writeFile(join(identityRepo, "after-snapshot.txt"), "later\n");
      const checkpoint = await createCheckpoint(makeOpts(identityRepo, {
        id: "supplied-snapshot",
        snapshot,
      }));
      assertEqual(checkpoint.worktreeTreeSha, snapshot.worktreeTreeSha, "supplied worktree tree");
      assertEqual(checkpoint.indexTreeSha, snapshot.indexTreeSha, "supplied index tree");
      assert(
        checkpoint.preexistingUntrackedFiles?.includes("after-snapshot.txt") !== true,
        "checkpoint uses supplied coverage metadata verbatim",
      );
    } finally {
      await cleanupRepo(identityRepo);
    }
  });

  await test("structured restore diff is NUL-safe and reports A M D direction", async () => {
    const diffRepo = await createTempRepo();
    try {
      await writeFile(join(diffRepo, "create me.txt"), "target create\n");
      await writeFile(join(diffRepo, "modify me.txt"), "target modify\n");
      await git('add "create me.txt" "modify me.txt"', diffRepo);
      const checkpoint = await createCheckpoint(makeOpts(diffRepo, { id: "structured-diff" }));

      await rm(join(diffRepo, "create me.txt"));
      await writeFile(join(diffRepo, "modify me.txt"), "current modify\n");
      await writeFile(join(diffRepo, "remove me.txt"), "current only\n");
      await git('add --all -- "create me.txt" "modify me.txt" "remove me.txt"', diffRepo);
      const diff = await buildCheckpointDiff(diffRepo, checkpoint);
      const worktree = diff.worktreeChanges.map((change) => `${change.status}:${change.path}`).join("|");
      const index = diff.indexChanges.map((change) => `${change.status}:${change.path}`).join("|");
      assert(worktree.includes("A:create me.txt"), "restore creates target-only path");
      assert(worktree.includes("M:modify me.txt"), "restore replaces modified path");
      assert(worktree.includes("D:remove me.txt"), "restore removes current-only path");
      assert(index.includes("A:create me.txt"), "index restore creates target-only path");
      assert(index.includes("M:modify me.txt"), "index restore replaces modified path");
      assert(index.includes("D:remove me.txt"), "index restore removes current-only path");
    } finally {
      await cleanupRepo(diffRepo);
    }
  });

  await test("checkpoint inspection reports legacy validity and stable failures", async () => {
    const inspectRepo = await createTempRepo();
    try {
      const legacy = await createCheckpoint(makeOpts(inspectRepo, { id: "inspect-legacy" }));
      const valid = await inspectCheckpointRef(inspectRepo, legacy.id);
      assertEqual(valid.errors.length, 0, "legacy checkpoint remains valid");
      assertEqual(valid.checkpoint?.conversationLeafId, undefined, "legacy conversation ID optional");

      await git(`update-ref refs/pi-checkpoints/inspect-malformed HEAD`, inspectRepo);
      const malformed = await inspectCheckpointRef(inspectRepo, "inspect-malformed");
      assertEqual(malformed.errors[0], "invalid checkpoint metadata", "malformed reason");

      const tree = await git("rev-parse HEAD^{tree}", inspectRepo);
      const head = await git("rev-parse HEAD", inspectRepo);
      const missingIndexId = "inspect-missing-index";
      const missingIndexCommit = await git(`commit-tree ${tree}`, inspectRepo, {
        input: [
          `pi-rewind:${missingIndexId}`,
          "sessionId inspect-session",
          "trigger turn",
          "turn 1",
          `head ${head}`,
          `index-tree ${"e".repeat(40)}`,
          `worktree-tree ${tree}`,
        ].join("\n"),
      });
      await git(`update-ref refs/pi-checkpoints/${missingIndexId} ${missingIndexCommit}`, inspectRepo);
      const missingIndex = await inspectCheckpointRef(inspectRepo, missingIndexId);
      assertEqual(
        missingIndex.errors[0],
        `missing index tree ${"e".repeat(40)}`,
        "missing index reason",
      );

      const missingWorktreeId = "inspect-missing-worktree";
      const missingWorktreeCommit = await git(`commit-tree ${tree}`, inspectRepo, {
        input: [
          `pi-rewind:${missingWorktreeId}`,
          "sessionId inspect-session",
          "trigger turn",
          "turn 1",
          `head ${head}`,
          `index-tree ${tree}`,
          `worktree-tree ${"d".repeat(40)}`,
        ].join("\n"),
      });
      await git(`update-ref refs/pi-checkpoints/${missingWorktreeId} ${missingWorktreeCommit}`, inspectRepo);
      const missingWorktree = await inspectCheckpointRef(inspectRepo, missingWorktreeId);
      assertEqual(
        missingWorktree.errors[0],
        `missing worktree tree ${"d".repeat(40)}`,
        "missing worktree reason",
      );

      const all = await inspectAllCheckpointRefs(inspectRepo);
      assert(all.some((inspection) => inspection.id === legacy.id && inspection.checkpoint !== null), "valid ref listed");
      assert(all.some((inspection) => inspection.id === missingIndexId && inspection.checkpoint === null), "invalid ref listed");
    } finally {
      await cleanupRepo(inspectRepo);
    }
  });
  // ------ Tool checkpoints ------

  console.log("\nTool checkpoints:");

  await test("createCheckpoint with tool trigger stores toolName", async () => {
    const cp = await createCheckpoint(makeOpts(repo, {
      id: "cp-tool-write",
      trigger: "tool",
      toolName: "write",
    }));
    assertEqual(cp.trigger, "tool", "trigger");
    assertEqual(cp.toolName, "write", "toolName");

    const loaded = await loadCheckpointFromRef(repo, "cp-tool-write");
    assertEqual(loaded!.trigger, "tool", "loaded trigger");
    assertEqual(loaded!.toolName, "write", "loaded toolName");
  });

  // ------ Pruning ------

  console.log("\nPruning:");

  await test("pruneCheckpoints removes oldest", async () => {
    // Create 5 checkpoints in a new session
    for (let i = 0; i < 5; i++) {
      await createCheckpoint(makeOpts(repo, {
        id: `prune-${i}`,
        sessionId: "prune-session",
        turnIndex: i,
      }));
    }

    const pruned = await pruneCheckpoints(repo, "prune-session", 3);
    assertEqual(pruned, 2, "pruned 2");

    const remaining = await loadAllCheckpoints(repo, "prune-session");
    assertEqual(remaining.length, 3, "3 remaining");
  });

  await test("pruning preserves protected undo refs for non-UUID sessions", async () => {
    const pruneRepo = await createTempRepo();
    try {
      await createCheckpoint(makeOpts(pruneRepo, {
        id: "active-old-1",
        sessionId: "active-session",
      }));
      await createCheckpoint(makeOpts(pruneRepo, {
        id: "active-old-2",
        sessionId: "active-session",
      }));
      const liveUndo = await createCheckpoint(makeOpts(pruneRepo, {
        id: "active-live-undo",
        sessionId: "active-session",
        trigger: "before-restore",
        restoreTargetId: "active-old-2",
      }));
      await pruneCheckpoints(
        pruneRepo,
        "active-session",
        1,
        new Set([liveUndo.id]),
      );
      const activeRemaining = await loadAllCheckpoints(pruneRepo, "active-session");
      assertEqual(activeRemaining.length, 1, "only protected active ref remains");
      assertEqual(activeRemaining[0]?.id, liveUndo.id, "live undo protected");

      const inherited = await createCheckpoint(makeOpts(pruneRepo, {
        id: "copied-inherited",
        sessionId: "source-session-name",
        conversationLeafId: "copied-leaf",
        conversationLeafParentId: null,
      }));
      await createCheckpoint(makeOpts(pruneRepo, {
        id: "old-ordinary",
        sessionId: "source-session-name",
      }));
      await createCheckpoint(makeOpts(pruneRepo, {
        id: "old-restore",
        sessionId: "source-session-name",
        trigger: "before-restore",
        restoreTargetId: "old-ordinary",
      }));
      await pruneOldSessions(
        pruneRepo,
        "active-session",
        new Set([inherited.id, liveUndo.id]),
      );
      const refs = await listCheckpointRefs(pruneRepo);
      assert(refs.includes(inherited.id), "inherited active-branch checkpoint protected");
      assert(!refs.includes("old-ordinary"), "old ordinary ref pruned");
      assert(!refs.includes("old-restore"), "old restore ref pruned with session");
      assert(refs.includes(liveUndo.id), "current live undo retained");
    } finally {
      await cleanupRepo(pruneRepo);
    }
  });

  await test("deleteCheckpoint rejects while automatic pruning catches deletion failures", async () => {
    const invalidRoot = await mkdtemp(join(tmpdir(), "pi-rewind-invalid-"));
    try {
      let rejected = false;
      try {
        await deleteCheckpoint(invalidRoot, "missing");
      } catch {
        rejected = true;
      }
      assert(rejected, "strict deletion rejects outside a repository");
    } finally {
      await rm(invalidRoot, { recursive: true, force: true });
    }

    const hookRepo = await createTempRepo();
    try {
      await createCheckpoint(makeOpts(hookRepo, {
        id: "hook-prune-1",
        sessionId: "hook-session",
      }));
      await createCheckpoint(makeOpts(hookRepo, {
        id: "hook-prune-2",
        sessionId: "hook-session",
      }));
      const hookPath = join(hookRepo, ".git", "hooks", "reference-transaction");
      await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
      await chmod(hookPath, 0o755);
      const deleted = await pruneCheckpoints(hookRepo, "hook-session", 0);
      assertEqual(deleted, 0, "best-effort pruning reports no successful deletions");
      assertEqual(
        (await loadAllCheckpoints(hookRepo, "hook-session")).length,
        2,
        "failed deletions remain",
      );
    } finally {
      await cleanupRepo(hookRepo);
    }
  });


  // ------ Branch safety ------

  await test("restore blocks cross-branch restore", async () => {
    const branchRepo = await createTempRepo();
    try {
      // Create checkpoint on main
      const cp = await createCheckpoint({
        root: branchRepo,
        id: `branch-test-${Date.now()}`,
        sessionId: "branch-test",
        trigger: "tool",
        turnIndex: 0,
        description: "on main",
      });

      // Create and switch to feature branch
      await git("checkout -b feature", branchRepo);
      await writeFile(join(branchRepo, "feature.txt"), "feature content");
      await git("add .", branchRepo);
      await git('commit -m "feature commit"', branchRepo);

      // Try to restore main checkpoint while on feature — should throw
      let threw = false;
      try {
        await restoreCheckpoint(branchRepo, cp);
      } catch (error) {
        threw = true;
        const message = error instanceof Error ? error.message : String(error);
        assert(
          message.includes("Branch mismatch"),
          `expected branch mismatch error, got: ${message}`,
        );
      }
      assert(threw, "should have thrown on cross-branch restore");
    } finally {
      await rm(branchRepo, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ------ Cleanup ------

  await cleanupRepo(repo);

  // ------ Summary ------

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (errors.length > 0) {
    console.log("Failures:");
    errors.forEach((e) => console.log(e));
  }
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
