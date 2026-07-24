import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReadonlySessionManager,
} from "@oh-my-pi/pi-coding-agent";
import rewindExtension from "../src/index.js";
import {
  handleBranchRestore,
  resolveCheckpointAtOrBefore,
  registerCommands,
} from "../src/commands.js";
import {
  createCheckpoint,
  git,
  listCheckpointRefs,
  captureWorkspaceSnapshot,
  type CheckpointData,
} from "../src/core.js";
import {
  createInitialState,
  runRepositoryOperation,
  type RewindState,
} from "../src/state.js";

let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function test(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`  FAIL ${name}: ${message}`);
    console.log(`  FAIL ${name}: ${message}`);
  }
}

async function createTempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-rewind-command-test-"));
  await git("init", root);
  await git('config user.email "test@test.com"', root);
  await git('config user.name "Test"', root);
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await git("add tracked.txt", root);
  await git('commit -m "initial"', root);
  return root;
}

interface FakeEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  message?: { role: string };
}

function createSessionManager(
  entries: FakeEntry[],
  leafId: string | null,
  sessionId = "command-session",
): ReadonlySessionManager {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const manager = {
    getSessionId: () => sessionId,
    getLeafId: () => leafId,
    getEntry: (id: string) => byId.get(id),
    getBranch: (fromId?: string) => {
      const branch: FakeEntry[] = [];
      let current = byId.get(fromId ?? leafId ?? "");
      while (current) {
        branch.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return branch.reverse();
    },
  };
  // The fake implements the exact ReadonlySessionManager methods exercised here.
  return manager as unknown as ReadonlySessionManager;
}

type Selection = string | ((options: string[]) => string | undefined) | undefined;
type Confirmation = boolean | (() => boolean | Promise<boolean>);

class FakeUI {
  readonly selections: Selection[];
  readonly confirms: Confirmation[];
  readonly selectionOptions: string[][] = [];
  readonly notifications: Array<{ message: string; level: string }> = [];

  constructor(selections: Selection[] = [], confirms: Confirmation[] = []) {
    this.selections = [...selections];
    this.confirms = [...confirms];
  }
  readonly theme = {
    fg: (_tone: string, text: string) => text,
  };
  readonly statuses = new Map<string, string | undefined>();

  async select<T extends string>(_title: string, options: T[]): Promise<T | undefined> {
    this.selectionOptions.push([...options]);
    const response = this.selections.shift();
    const selected = typeof response === "function" ? response([...options]) : response;
    return selected as T | undefined;
  }

  async confirm(_title: string, _message: string): Promise<boolean> {
    const response = this.confirms.shift();
    return typeof response === "function" ? response() : response ?? true;
  }

  notify(message: string, level: string): void {
    this.notifications.push({ message, level });
  }

  setStatus(key: string, value: string | undefined): void {
    this.statuses.set(key, value);
  }
}

function createContext(
  root: string,
  sessionManager: ReadonlySessionManager,
  ui: FakeUI,
  navigateTree: (id: string) => Promise<{ cancelled: boolean }> = async () => ({ cancelled: false }),
): ExtensionCommandContext {
  const context = {
    cwd: root,
    hasUI: true,
    ui,
    sessionManager,
    navigateTree,
  };
  // The command only consumes this tested subset of ExtensionCommandContext.
  return context as unknown as ExtensionCommandContext;
}
interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  getArgumentCompletions?: (argumentPrefix: string) => Array<{
    value: string;
    label: string;
    description?: string;
  }> | null;
}

function registerRewind(state: RewindState): RegisteredCommand {
  let registered: RegisteredCommand | undefined;
  const api = {
    registerCommand: (_name: string, command: RegisteredCommand) => {
      registered = command;
    },
  };
  // registerCommands only calls registerCommand on this focused fake.
  registerCommands(api as unknown as ExtensionAPI, state);
  if (!registered) throw new Error("rewind command was not registered");
  return registered;
}

function readyState(root: string, sessionId = "command-session"): RewindState {
  const state = createInitialState();
  state.gitAvailable = true;
  state.repoRoot = root;
  state.sessionId = sessionId;
  return state;
}

function checkpointStub(id: string, leafId: string, timestamp: number): CheckpointData {
  return {
    id,
    sessionId: "command-session",
    trigger: "turn",
    turnIndex: 0,
    branch: "main",
    headSha: "0".repeat(40),
    indexTreeSha: "1".repeat(40),
    worktreeTreeSha: "2".repeat(40),
    timestamp,
    conversationLeafId: leafId,
  };
}

async function runTests(): Promise<void> {
  console.log("\nomp-rewind command tests\n");

  await test("exact ancestry resolution and fork user-parent semantics", async () => {
    const entries: FakeEntry[] = [
      { id: "root", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      { id: "a", parentId: "root", type: "message", timestamp: "2026-01-02", message: { role: "assistant" } },
      { id: "a-user", parentId: "a", type: "message", timestamp: "2026-01-03", message: { role: "user" } },
      { id: "b", parentId: "root", type: "message", timestamp: "2026-01-02", message: { role: "assistant" } },
    ];
    const manager = createSessionManager(entries, "a-user");
    const checkpoints = [
      checkpointStub("root-cp", "root", 10),
      checkpointStub("a-z", "a", 20),
      checkpointStub("a-a", "a", 20),
      checkpointStub("sibling", "b", 20),
    ];
    const resolved = resolveCheckpointAtOrBefore(checkpoints, "a-user", manager);
    assertEqual(resolved?.id, "a-a", "deepest exact leaf with deterministic ID tie-break");

    const root = await createTempRepo();
    try {
      const state = readyState(root);
      state.checkpoints.set("user-only", checkpointStub("user-only", "a-user", 30));
      const ui = new FakeUI(["Conversation only (keep files)"]);
      const context = createContext(root, manager, ui);
      await handleBranchRestore(state, { entryId: "a-user" }, context);
      assert(
        !ui.selectionOptions[0]?.includes("Restore all (files + conversation)"),
        "normal user branch resolves against parent and excludes user-leaf checkpoint",
      );

      const rootUserEntries: FakeEntry[] = [
        { id: "first-user", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "user" } },
      ];
      const rootUserManager = createSessionManager(rootUserEntries, "first-user");
      const rootUserState = readyState(root);
      rootUserState.resumeCheckpoint = {
        ...checkpointStub("resume", "unrelated", 10),
        trigger: "resume",
      };
      const rootUserUi = new FakeUI(["Conversation only (keep files)"]);
      await handleBranchRestore(
        rootUserState,
        { entryId: "first-user" },
        createContext(root, rootUserManager, rootUserUi),
      );
      assert(
        rootUserUi.selectionOptions[0]?.includes("Restore all (files + conversation)"),
        "root user branch falls back to the session-start checkpoint",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("legacy checkpoint offers files-only and never navigates", async () => {
    const root = await createTempRepo();
    try {
      const state = readyState(root);
      const legacy = await createCheckpoint({
        root,
        id: "legacy-command",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "legacy marker",
      });
      state.checkpoints.set(legacy.id, legacy);
      await writeFile(join(root, "tracked.txt"), "changed\n");
      const ui = new FakeUI([
        (options) => options.find((option) => option.includes("legacy marker")),
        "Files only (keep conversation)",
      ], [true]);
      let navigations = 0;
      const manager = createSessionManager([], null);
      const context = createContext(root, manager, ui, async () => {
        navigations++;
        return { cancelled: false };
      });
      await registerRewind(state).handler("restore", context);

      assertEqual(navigations, 0, "legacy restore does not navigate conversation");
      assertEqual(
        ui.selectionOptions[1]?.join("|"),
        "Files only (keep conversation)|Cancel",
        "legacy restore modes",
      );
      assert(
        ui.notifications.some((notice) =>
          notice.message === "Conversation restore unavailable: checkpoint predates exact session IDs."),
        "legacy warning emitted",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("file restore failure rolls back once without success or navigation", async () => {
    const root = await createTempRepo();
    try {
      const entries: FakeEntry[] = [
        { id: "leaf", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      ];
      const manager = createSessionManager(entries, "leaf");
      const state = readyState(root);
      const valid = await createCheckpoint({
        root,
        id: "invalid-target-ref",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "invalid target",
        conversationLeafId: "leaf",
        conversationLeafParentId: null,
      });
      const invalid = { ...valid, worktreeTreeSha: "f".repeat(40) };
      state.checkpoints.set(invalid.id, invalid);
      const priorUndo = await createCheckpoint({
        root,
        id: "prior-undo",
        sessionId: "command-session",
        trigger: "before-restore",
        turnIndex: 0,
        restoreTargetId: "older-target",
        conversationLeafId: "leaf",
        conversationLeafParentId: null,
      });
      state.undoCheckpoint = priorUndo;
      await writeFile(join(root, "tracked.txt"), "dirty current\n");
      const currentBytes = await readFile(join(root, "tracked.txt"), "utf-8");
      const ui = new FakeUI([
        (options) => options.find((option) => option.includes("invalid target")),
        "Restore all (files + conversation)",
      ], [true]);
      let navigations = 0;
      const context = createContext(root, manager, ui, async () => {
        navigations++;
        return { cancelled: false };
      });
      await registerRewind(state).handler("restore", context);

      assertEqual(await readFile(join(root, "tracked.txt"), "utf-8"), currentBytes, "rollback bytes");
      assertEqual(state.undoCheckpoint?.id, priorUndo.id, "prior undo remains authoritative");
      assertEqual(navigations, 0, "navigation not attempted after file failure");
      assertEqual(
        ui.notifications.filter((notice) => notice.level === "error").length,
        1,
        "one error notification",
      );
      assert(
        !ui.notifications.some((notice) => notice.level === "info" && notice.message.startsWith("Rewound")),
        "no success notification",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("real command restores trees without moving HEAD or branch refs", async () => {
    const root = await createTempRepo();
    try {
      const entries: FakeEntry[] = [
        { id: "smoke-leaf", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      ];
      const manager = createSessionManager(entries, "smoke-leaf");
      const state = readyState(root);
      await writeFile(join(root, "tracked.txt"), "checkpoint staged\n");
      await git("add tracked.txt", root);
      await writeFile(join(root, "tracked.txt"), "checkpoint worktree\n");
      const target = await createCheckpoint({
        root,
        id: "head-smoke-target",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "head smoke target",
        conversationLeafId: "smoke-leaf",
        conversationLeafParentId: null,
      });
      state.checkpoints.set(target.id, target);

      await writeFile(join(root, "tracked.txt"), "newer commit\n");
      await git("add tracked.txt", root);
      await git('commit -m "newer branch tip"', root);
      const headBefore = await git("rev-parse HEAD", root);
      const branchBefore = await git("symbolic-ref -q HEAD", root);
      const branchTipBefore = await git(`rev-parse ${branchBefore}`, root);
      const ui = new FakeUI([
        (options) => options.find((option) => option.includes("head smoke target")),
        "Files only (keep conversation)",
      ], [true]);

      await registerRewind(state).handler("restore", createContext(root, manager, ui));

      assertEqual(
        await readFile(join(root, "tracked.txt"), "utf-8"),
        "checkpoint worktree\n",
        "checkpoint worktree bytes",
      );
      assertEqual(await git("write-tree", root), target.indexTreeSha, "checkpoint index tree");
      assertEqual(await git("rev-parse HEAD", root), headBefore, "HEAD remains at newer commit");
      assertEqual(await git("symbolic-ref -q HEAD", root), branchBefore, "symbolic branch unchanged");
      assertEqual(
        await git(`rev-parse ${branchBefore}`, root),
        branchTipBefore,
        "branch tip remains at newer commit",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("all-mode navigation cancellation restores pre-command worktree and index", async () => {
    const root = await createTempRepo();
    try {
      const entries: FakeEntry[] = [
        { id: "target-leaf", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      ];
      const manager = createSessionManager(entries, "target-leaf");
      const state = readyState(root);
      await writeFile(join(root, "tracked.txt"), "checkpoint staged\n");
      await git("add tracked.txt", root);
      await writeFile(join(root, "tracked.txt"), "checkpoint worktree\n");
      const target = await createCheckpoint({
        root,
        id: "cancel-target",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "cancel target",
        conversationLeafId: "target-leaf",
        conversationLeafParentId: null,
      });
      state.checkpoints.set(target.id, target);
      await writeFile(join(root, "tracked.txt"), "current staged\n");
      await git("add tracked.txt", root);
      await writeFile(join(root, "tracked.txt"), "current worktree\n");
      const bytesBefore = await readFile(join(root, "tracked.txt"), "utf-8");
      const indexBefore = await git("write-tree", root);
      const ui = new FakeUI([
        (options) => options.find((option) => option.includes("cancel target")),
        "Restore all (files + conversation)",
      ], [true]);
      const navigated: string[] = [];
      const context = createContext(root, manager, ui, async (id) => {
        navigated.push(id);
        return { cancelled: true };
      });
      await registerRewind(state).handler("restore", context);

      assertEqual(navigated.join(","), "target-leaf", "navigation uses stored leaf ID");
      assertEqual(await readFile(join(root, "tracked.txt"), "utf-8"), bytesBefore, "worktree rolled back");
      assertEqual(await git("write-tree", root), indexBefore, "index rolled back");
      assertEqual(state.undoCheckpoint, null, "cancelled all-mode does not commit undo point");
      assert(
        !ui.notifications.some((notice) => notice.level === "info" && notice.message.startsWith("Rewound")),
        "cancelled navigation has no success notification",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("undo consumes its ref only after success and remains after failure", async () => {
    const root = await createTempRepo();
    try {
      const manager = createSessionManager([], null);
      const state = readyState(root);
      const undo = await createCheckpoint({
        root,
        id: "undo-success",
        sessionId: "command-session",
        trigger: "before-restore",
        turnIndex: 0,
        restoreTargetId: "target",
      });
      state.undoCheckpoint = undo;
      await writeFile(join(root, "tracked.txt"), "after rewind\n");
      const ui = new FakeUI(["↩ Undo last rewind"], [true]);
      await registerRewind(state).handler("restore", createContext(root, manager, ui));
      assertEqual(state.undoCheckpoint, null, "successful undo clears state");
      assert(!(await listCheckpointRefs(root)).includes(undo.id), "successful undo consumes ref");

      const retryable = await createCheckpoint({
        root,
        id: "undo-failure",
        sessionId: "command-session",
        trigger: "before-restore",
        turnIndex: 0,
        restoreTargetId: "target",
      });
      state.undoCheckpoint = { ...retryable, worktreeTreeSha: "e".repeat(40) };
      await writeFile(join(root, "tracked.txt"), "retry current\n");
      const failureUi = new FakeUI(["↩ Undo last rewind"], [true]);
      await registerRewind(state).handler("restore", createContext(root, manager, failureUi));
      assertEqual(state.undoCheckpoint?.id, retryable.id, "failed undo remains available");
      assert((await listCheckpointRefs(root)).includes(retryable.id), "failed undo ref retained");
      assertEqual(
        failureUi.notifications.filter((notice) => notice.level === "error").length,
        1,
        "failed undo emits one error",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("session restart recovers newest linked undo and excludes restore refs from picker", async () => {
    const root = await createTempRepo();
    try {
      const entries: FakeEntry[] = [
        { id: "restart-leaf", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      ];
      const manager = createSessionManager(entries, "restart-leaf", "restart-session");
      await createCheckpoint({
        root,
        id: "restart-ordinary",
        sessionId: "restart-session",
        trigger: "turn",
        turnIndex: 1,
        description: "ordinary marker",
        conversationLeafId: "restart-leaf",
        conversationLeafParentId: null,
      });
      const older = await createCheckpoint({
        root,
        id: "restart-undo-old",
        sessionId: "restart-session",
        trigger: "before-restore",
        turnIndex: 0,
        description: "BEFORE-MARKER",
        restoreTargetId: "restart-ordinary",
        conversationLeafId: "restart-leaf",
        conversationLeafParentId: null,
      });
      const newest = await createCheckpoint({
        root,
        id: "restart-undo-new",
        sessionId: "restart-session",
        trigger: "before-restore",
        turnIndex: 0,
        description: "BEFORE-MARKER",
        restoreTargetId: "restart-ordinary",
        conversationLeafId: "restart-leaf",
        conversationLeafParentId: null,
      });
      const unlinked = await createCheckpoint({
        root,
        id: "restart-unlinked",
        sessionId: "restart-session",
        trigger: "before-restore",
        turnIndex: 0,
        description: "BEFORE-MARKER",
        conversationLeafId: "restart-leaf",
        conversationLeafParentId: null,
      });

      const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
      let command: RegisteredCommand | undefined;
      const api = {
        on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => {
          handlers.set(name, handler);
        },
        registerCommand: (_name: string, registered: RegisteredCommand) => {
          command = registered;
        },
      };
      // The extension uses only on/registerCommand during registration.
      rewindExtension(api as unknown as ExtensionAPI);
      const ui = new FakeUI([undefined]);
      const context = createContext(root, manager, ui);
      const startHandler = handlers.get("session_start");
      if (!startHandler || !command) throw new Error("extension handlers were not registered");
      await startHandler({}, context);

      const refs = await listCheckpointRefs(root);
      assert(refs.includes(newest.id), "newest linked undo recovered");
      assert(!refs.includes(older.id), "older linked undo deleted");
      assert(!refs.includes(unlinked.id), "unlinked current-session ref deleted");
      await command.handler("restore", context);
      assert(ui.selectionOptions[0]?.includes("↩ Undo last rewind"), "undo action reconstructed");
      assert(
        !ui.selectionOptions[0]?.some((option) => option.includes("BEFORE-MARKER")),
        "before-restore refs excluded from picker",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("diff and full reports are read-only in restore direction", async () => {
    const root = await createTempRepo();
    try {
      await writeFile(join(root, "restore create.txt"), "target create\n");
      await writeFile(join(root, "modify.txt"), "target modify\n");
      await writeFile(join(root, "staged only.txt"), "target staged\n");
      await git('add "restore create.txt" modify.txt "staged only.txt"', root);
      const target = await createCheckpoint({
        root,
        id: "diff-target",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "diff target",
      });

      await rm(join(root, "restore create.txt"));
      await writeFile(join(root, "modify.txt"), "current modify\n");
      await writeFile(join(root, "current only.txt"), "current only\n");
      await writeFile(join(root, "staged only.txt"), "current staged\n");
      await git('add --all -- "restore create.txt" modify.txt "current only.txt" "staged only.txt"', root);
      await writeFile(join(root, "staged only.txt"), "target staged\n");
      for (let index = 0; index < 41; index++) {
        await writeFile(join(root, `overflow ${String(index).padStart(2, "0")}.txt`), "current\n");
      }

      const state = readyState(root);
      state.checkpoints.set(target.id, target);
      const undo = await createCheckpoint({
        root,
        id: "diff-undo",
        sessionId: "command-session",
        trigger: "before-restore",
        turnIndex: 0,
        restoreTargetId: target.id,
      });
      state.undoCheckpoint = undo;
      const command = registerRewind(state);
      assertEqual(
        command.getArgumentCompletions?.("").map((item) => item.value).join("|"),
        "restore|diff|diff --full|status|help",
        "argument completions",
      );

      const bareUi = new FakeUI();
      await command.handler("", createContext(root, createSessionManager([], null), bareUi));
      assert(
        bareUi.notifications.at(-1)?.message.includes("Use /rewind restore to open the checkpoint browser.") === true,
        "bare command shows explicit restore migration hint",
      );
      assert(
        bareUi.notifications.at(-1)?.message.includes("/rewind restore") === true,
        "bare command shows explicit subcommand usage",
      );
      assertEqual(bareUi.selectionOptions.length, 0, "bare command does not open checkpoint picker");

      const restoreUi = new FakeUI([undefined]);
      await command.handler("restore", createContext(root, createSessionManager([], null), restoreUi));
      assert(
        restoreUi.selectionOptions[0]?.some((option) => option.includes("diff target")) === true,
        "restore subcommand opens checkpoint picker",
      );

      const before = await captureWorkspaceSnapshot(root);
      const refsBefore = (await listCheckpointRefs(root)).join("|");
      const headBefore = await git("rev-parse HEAD", root);
      const branchBefore = await git("symbolic-ref -q HEAD", root);
      const tipBefore = await git(`rev-parse ${branchBefore}`, root);
      let navigations = 0;
      const manager = createSessionManager([], null);
      const cancelledUi = new FakeUI([undefined]);
      await command.handler("diff", createContext(root, manager, cancelledUi, async () => {
        navigations++;
        return { cancelled: false };
      }));

      const defaultUi = new FakeUI([(options) => options.find((option) => option.includes("diff target"))]);
      await command.handler("diff", createContext(root, manager, defaultUi));
      const report = defaultUi.notifications.at(-1)?.message ?? "";
      assert(report.includes("Worktree restore effects"), "worktree section");
      assert(report.includes("Index restore effects"), "index section");
      assert(report.includes("A restore create.txt"), "restore creates target-only path");
      assert(report.includes("M modify.txt"), "restore modifies tracked path");
      assert(report.includes("D current only.txt"), "restore deletes current-only path");
      assert(report.includes("use /rewind diff --full"), "default report capped");

      const fullUi = new FakeUI([(options) => options.find((option) => option.includes("diff target"))]);
      await command.handler("diff --full", createContext(root, manager, fullUi));
      const fullReport = fullUi.notifications.at(-1)?.message ?? "";
      assert(!fullReport.includes("more path(s)"), "full report is uncapped");
      assert(fullReport.includes("D overflow 40.txt"), "full report includes final path");
      assert(fullReport.includes("M staged only.txt"), "index-only path classified");

      const after = await captureWorkspaceSnapshot(root);
      assertEqual(after.worktreeTreeSha, before.worktreeTreeSha, "diff leaves worktree unchanged");
      assertEqual(after.indexTreeSha, before.indexTreeSha, "diff leaves index unchanged");
      assertEqual((await listCheckpointRefs(root)).join("|"), refsBefore, "diff leaves refs unchanged");
      assertEqual(await git("rev-parse HEAD", root), headBefore, "diff leaves HEAD unchanged");
      assertEqual(await git(`rev-parse ${branchBefore}`, root), tipBefore, "diff leaves branch tip unchanged");
      assertEqual(state.undoCheckpoint?.id, undo.id, "diff leaves undo unchanged");
      assertEqual(navigations, 0, "diff never navigates");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("status reports healthy and invalid checkpoint health without mutation", async () => {
    const root = await createTempRepo();
    try {
      const state = readyState(root);
      const healthy = await createCheckpoint({
        root,
        id: "status-healthy",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
      });
      state.checkpoints.set(healthy.id, healthy);
      const command = registerRewind(state);
      const manager = createSessionManager([], null);
      const healthyUi = new FakeUI();
      await command.handler("status", createContext(root, manager, healthyUi));
      assertEqual(healthyUi.notifications.at(-1)?.level, "info", "healthy status level");
      assert(healthyUi.notifications.at(-1)?.message.includes("0 invalid") === true, "healthy count");

      const snapshot = await captureWorkspaceSnapshot(root);
      const incomplete = await createCheckpoint({
        root,
        id: "status-incomplete",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 2,
        snapshot: { ...snapshot, skippedLargeFiles: ["target-large.bin"] },
      });
      state.checkpoints.set(incomplete.id, incomplete);
      const undo = await createCheckpoint({
        root,
        id: "status-undo",
        sessionId: "command-session",
        trigger: "before-restore",
        turnIndex: 0,
        restoreTargetId: healthy.id,
      });
      state.undoCheckpoint = undo;
      await git("update-ref refs/pi-checkpoints/status-malformed HEAD", root);
      const tree = await git("rev-parse HEAD^{tree}", root);
      const head = await git("rev-parse HEAD", root);
      const missingId = "status-missing-tree";
      const missingCommit = await git(`commit-tree ${tree}`, root, {
        input: [
          `pi-rewind:${missingId}`,
          "sessionId command-session",
          "trigger turn",
          "turn 3",
          `head ${head}`,
          `index-tree ${tree}`,
          `worktree-tree ${"c".repeat(40)}`,
        ].join("\n"),
      });
      await git(`update-ref refs/pi-checkpoints/${missingId} ${missingCommit}`, root);

      const refsBefore = (await listCheckpointRefs(root)).join("|");
      const before = await captureWorkspaceSnapshot(root);
      const statusUi = new FakeUI();
      await command.handler("status", createContext(root, manager, statusUi));
      const notice = statusUi.notifications.at(-1);
      assertEqual(notice?.level, "warning", "unhealthy status level");
      assert(notice?.message.includes("Durable undo: available") === true, "undo status");
      assert(notice?.message.includes("Incomplete coverage checkpoints: 1") === true, "coverage status");
      assert(notice?.message.includes("status-malformed: invalid checkpoint metadata") === true, "malformed status");
      assert(
        notice?.message.includes(`status-missing-tree: missing worktree tree ${"c".repeat(40)}`) === true,
        "missing tree status",
      );
      const after = await captureWorkspaceSnapshot(root);
      assertEqual(after.worktreeTreeSha, before.worktreeTreeSha, "status leaves worktree unchanged");
      assertEqual(after.indexTreeSha, before.indexTreeSha, "status leaves index unchanged");
      assertEqual((await listCheckpointRefs(root)).join("|"), refsBefore, "status leaves refs unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("restore preflight discloses target coverage and exposes all 50 checkpoints", async () => {
    const root = await createTempRepo();
    try {
      const manager = createSessionManager([], null);
      const snapshot = await captureWorkspaceSnapshot(root);
      const target = await createCheckpoint({
        root,
        id: "coverage-target",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "coverage target",
        snapshot: { ...snapshot, skippedLargeFiles: ["target-large.bin"] },
      });
      const state = readyState(root);
      state.checkpoints.set(target.id, target);
      await writeFile(join(root, "tracked.txt"), "dirty\n");
      const coverageUi = new FakeUI([
        (options) => options.find((option) => option.includes("coverage target")),
        "Files only (keep conversation)",
      ], [false]);
      await registerRewind(state).handler("restore", createContext(root, manager, coverageUi));
      assert(
        coverageUi.notifications.some((notice) =>
          notice.message === "Not captured by checkpoint: file target-large.bin"),
        "target-only skipped coverage disclosed",
      );

      const invalid = await createCheckpoint({
        root,
        id: "preflight-invalid",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 2,
        description: "preflight invalid",
      });
      state.checkpoints.clear();
      state.checkpoints.set(invalid.id, invalid);
      await git(`update-ref refs/pi-checkpoints/${invalid.id} HEAD`, root);
      const refsBefore = await listCheckpointRefs(root);
      let navigations = 0;
      const invalidUi = new FakeUI([
        (options) => options.find((option) => option.includes("preflight invalid")),
        "Files only (keep conversation)",
      ]);
      await registerRewind(state).handler("restore", createContext(root, manager, invalidUi, async () => {
        navigations++;
        return { cancelled: false };
      }));
      assert(
        invalidUi.notifications.some((notice) =>
          notice.message === "Checkpoint unavailable: invalid checkpoint metadata"),
        "invalid preflight reason",
      );
      assertEqual((await listCheckpointRefs(root)).join("|"), refsBefore.join("|"), "no safety ref created");
      assertEqual(navigations, 0, "invalid target never navigates");

      state.checkpoints.clear();
      for (let index = 0; index < 50; index++) {
        const checkpoint = checkpointStub(`retained-${index}`, "leaf", index + 1);
        checkpoint.description = index === 0 ? "oldest marker" : `checkpoint ${index}`;
        if (index === 0) checkpoint.conversationLeafId = undefined;
        state.checkpoints.set(checkpoint.id, checkpoint);
      }
      state.undoCheckpoint = checkpointStub("selection-undo", "leaf", 100);
      state.undoCheckpoint.trigger = "before-restore";
      const selectionUi = new FakeUI([
        (options) => options.find((option) => option.includes("oldest marker")),
        "Cancel",
      ]);
      await registerRewind(state).handler("restore", createContext(root, manager, selectionUi));
      assertEqual(selectionUi.selectionOptions[0]?.length, 51, "undo plus all 50 checkpoints selectable");
      assertEqual(
        selectionUi.selectionOptions[1]?.join("|"),
        "Files only (keep conversation)|Cancel",
        "oldest selection maps correctly despite undo item",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("restore undo and navigation rollback synchronize workspace identity", async () => {
    const root = await createTempRepo();
    try {
      const manager = createSessionManager([
        { id: "identity-leaf", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "assistant" } },
      ], "identity-leaf");
      const state = readyState(root);
      await writeFile(join(root, "tracked.txt"), "target\n");
      const target = await createCheckpoint({
        root,
        id: "identity-target",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "identity target",
        conversationLeafId: "identity-leaf",
        conversationLeafParentId: null,
      });
      state.checkpoints.set(target.id, target);
      await writeFile(join(root, "tracked.txt"), "current\n");
      const restoreUi = new FakeUI([
        (options) => options.find((option) => option.includes("identity target")),
        "Files only (keep conversation)",
      ], [true]);
      await registerRewind(state).handler("restore", createContext(root, manager, restoreUi));
      assertEqual(state.lastWorkspaceIdentity?.worktreeTreeSha, target.worktreeTreeSha, "restore worktree identity");
      assertEqual(state.lastWorkspaceIdentity?.indexTreeSha, target.indexTreeSha, "restore index identity");

      const undo = state.undoCheckpoint;
      if (!undo) throw new Error("restore did not create undo checkpoint");
      const undoUi = new FakeUI(["↩ Undo last rewind"], [true]);
      await registerRewind(state).handler("restore", createContext(root, manager, undoUi));
      assertEqual(state.lastWorkspaceIdentity?.worktreeTreeSha, undo.worktreeTreeSha, "undo worktree identity");
      assertEqual(state.lastWorkspaceIdentity?.indexTreeSha, undo.indexTreeSha, "undo index identity");

      await writeFile(join(root, "tracked.txt"), "rollback current\n");
      await git("add tracked.txt", root);
      await writeFile(join(root, "tracked.txt"), "rollback worktree\n");
      const beforeRollback = await captureWorkspaceSnapshot(root);
      const rollbackUi = new FakeUI([
        (options) => options.find((option) => option.includes("identity target")),
        "Restore all (files + conversation)",
      ], [true]);
      await registerRewind(state).handler("restore", createContext(root, manager, rollbackUi, async () => ({
        cancelled: true,
      })));
      assertEqual(
        state.lastWorkspaceIdentity?.worktreeTreeSha,
        beforeRollback.worktreeTreeSha,
        "navigation rollback worktree identity",
      );
      assertEqual(
        state.lastWorkspaceIdentity?.indexTreeSha,
        beforeRollback.indexTreeSha,
        "navigation rollback index identity",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("double restore failure clears uncertain workspace identity", async () => {
    const root = await createTempRepo();
    try {
      await writeFile(join(root, "target-only.txt"), "target\n");
      const target = await createCheckpoint({
        root,
        id: "double-failure-target",
        sessionId: "command-session",
        trigger: "turn",
        turnIndex: 1,
        description: "double failure target",
      });
      await rm(join(root, "target-only.txt"));
      await writeFile(join(root, "current-only.txt"), "current\n");
      const state = readyState(root);
      state.checkpoints.set(target.id, target);
      state.lastWorkspaceIdentity = {
        worktreeTreeSha: target.worktreeTreeSha,
        indexTreeSha: target.indexTreeSha,
      };

      const hookPath = join(root, ".git", "hooks", "reference-transaction");
      await writeFile(hookPath, [
        "#!/bin/sh",
        '[ "$1" = "prepared" ] || exit 0',
        "while read old new ref; do",
        "  case \"$ref\" in",
        "    refs/pi-checkpoints/before-restore-*)",
        "      tree=$(git cat-file -p \"$new\" | sed -n '1s/^tree //p')",
        "      dir=$(printf '%s' \"$tree\" | cut -c1-2)",
        "      file=$(printf '%s' \"$tree\" | cut -c3-)",
        "      rm -f \".git/objects/$dir/$file\"",
        "      ;;",
        "  esac",
        "done",
        "exit 0",
      ].join("\n"));
      await chmod(hookPath, 0o755);
      const targetObject = join(
        root,
        ".git",
        "objects",
        target.worktreeTreeSha.slice(0, 2),
        target.worktreeTreeSha.slice(2),
      );
      const ui = new FakeUI([
        (options) => options.find((option) => option.includes("double failure target")),
        "Files only (keep conversation)",
      ], [async () => {
        await rm(targetObject, { force: true });
        return true;
      }]);
      await registerRewind(state).handler("restore", createContext(root, createSessionManager([], null), ui));
      assertEqual(state.lastWorkspaceIdentity, null, "double failure clears baseline");
      assert(
        ui.notifications.some((notice) => notice.message.includes("Rollback failed")),
        "double failure reported",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("repository operations execute FIFO after rejection", async () => {
    const state = createInitialState();
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const first = runRepositoryOperation(state, async () => {
      order.push("first-start");
      markFirstStarted();
      await firstGate;
      order.push("first-end");
      throw new Error("expected rejection");
    });
    const second = runRepositoryOperation(state, async () => {
      order.push("second");
      return 2;
    });
    await firstStarted;
    assertEqual(order.join("|"), "first-start", "second waits behind first");
    releaseFirst();
    await first.catch(() => undefined);
    assertEqual(await second, 2, "second result");
    assertEqual(order.join("|"), "first-start|first-end|second", "FIFO order");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (errors.length > 0) {
    console.log("Failures:");
    errors.forEach((error) => console.log(error));
  }
  process.exit(failed > 0 ? 1 : 0);
}

await runTests();
