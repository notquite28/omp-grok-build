import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import rewindExtension from "../src/index.js";
import { git, loadAllCheckpoints, listCheckpointRefs } from "../src/core.js";

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
  const root = await mkdtemp(join(tmpdir(), "omp-rewind-index-test-"));
  await git("init", root);
  await git('config user.email "test@test.com"', root);
  await git('config user.name "Test"', root);
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await git("add tracked.txt", root);
  await git('commit -m "initial"', root);
  return root;
}

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

interface CapturedExtension {
  handlers: Map<string, Handler>;
  commands: string[];
}

function captureExtension(): CapturedExtension {
  const handlers = new Map<string, Handler>();
  const commands: string[] = [];
  const api = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    registerCommand: (name: string) => {
      commands.push(name);
    },
  };
  rewindExtension(api as unknown as ExtensionAPI);
  return { handlers, commands };
}

function createContext(root: string, sessionId: string): ExtensionContext {
  const sessionManager = {
    getSessionId: () => sessionId,
    getLeafId: () => null,
    getEntry: (_id: string) => undefined,
    getBranch: () => [],
  };
  return {
    cwd: root,
    hasUI: false,
    sessionManager,
  } as unknown as ExtensionContext;
}

function requireHandler(captured: CapturedExtension, name: string): Handler {
  const handler = captured.handlers.get(name);
  if (!handler) throw new Error(`missing ${name} handler`);
  return handler;
}

async function runTests(): Promise<void> {
  console.log("\nomp-rewind lifecycle tests\n");

  await test("registers one OMP rewind command and native lifecycle hooks", async () => {
    const captured = captureExtension();
    assertEqual(captured.commands.join(","), "rewind", "exact command registration");
    for (const name of ["turn_end", "session_before_branch", "session_before_tree"]) {
      assert(captured.handlers.has(name), `${name} registered`);
    }
    assert(!captured.handlers.has("agent_settled"), "agent_settled not registered");
    assert(!captured.handlers.has("session_before_fork"), "session_before_fork not registered");
  });

  await test("observed workspace identity controls turn checkpoint retention", async () => {
    const root = await createTempRepo();
    try {
      const captured = captureExtension();
      const context = createContext(root, "identity-session");
      await requireHandler(captured, "session_start")({}, context);
      const initialRefs = await listCheckpointRefs(root);

      await requireHandler(captured, "before_agent_start")({ prompt: "external change" }, context);
      await requireHandler(captured, "turn_start")({ turnIndex: 1 }, context);
      await writeFile(join(root, "external.txt"), "outside tool events\n");
      await requireHandler(captured, "turn_end")({}, context);
      let checkpoints = await loadAllCheckpoints(root, "identity-session");
      assertEqual(checkpoints.length, initialRefs.length + 1, "unrecognized change retained");
      assert(
        checkpoints.some((checkpoint) => checkpoint.description?.includes("external change")),
        "prompt fallback labels change without known tools",
      );

      const afterExternal = (await listCheckpointRefs(root)).length;
      await requireHandler(captured, "before_agent_start")({ prompt: "read only" }, context);
      await requireHandler(captured, "turn_start")({ turnIndex: 2 }, context);
      await requireHandler(captured, "turn_end")({}, context);
      assertEqual((await listCheckpointRefs(root)).length, afterExternal, "no-op turn creates no ref");

      await requireHandler(captured, "before_agent_start")({ prompt: "known tool" }, context);
      await requireHandler(captured, "turn_start")({ turnIndex: 3 }, context);
      await requireHandler(captured, "tool_call")({
        toolName: "write",
        toolCallId: "tool-1",
        input: { path: "known.txt" },
      }, context);
      await writeFile(join(root, "known.txt"), "known\n");
      await requireHandler(captured, "tool_execution_end")({
        toolName: "write",
        toolCallId: "tool-1",
      }, context);
      await requireHandler(captured, "turn_end")({}, context);
      checkpoints = await loadAllCheckpoints(root, "identity-session");
      assert(
        checkpoints.some((checkpoint) => checkpoint.description?.includes("write → known.txt")),
        "known tool remains in checkpoint description",
      );

      const beforeStage = (await listCheckpointRefs(root)).length;
      await requireHandler(captured, "before_agent_start")({ prompt: "stage only" }, context);
      await requireHandler(captured, "turn_start")({ turnIndex: 4 }, context);
      await git("add tracked.txt external.txt known.txt", root);
      await requireHandler(captured, "turn_end")({}, context);
      assertEqual(
        (await listCheckpointRefs(root)).length,
        beforeStage + 1,
        "index-only transition retained with unchanged worktree bytes",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await test("queued session switch prevents stale checkpoint publication", async () => {
    const root = await createTempRepo();
    try {
      const captured = captureExtension();
      const oldContext = createContext(root, "old-session");
      const newContext = createContext(root, "new-session");
      await requireHandler(captured, "session_start")({}, oldContext);
      await requireHandler(captured, "before_agent_start")({ prompt: "stale turn" }, oldContext);
      await requireHandler(captured, "turn_start")({ turnIndex: 1 }, oldContext);
      await writeFile(join(root, "queued.txt"), "queued\n");
      const refsBefore = (await listCheckpointRefs(root)).length;

      const switchPromise = requireHandler(captured, "session_switch")(
        { reason: "fork" },
        newContext,
      );
      const staleTurnPromise = requireHandler(captured, "turn_end")({}, oldContext);
      await Promise.all([switchPromise, staleTurnPromise]);
      assertEqual((await listCheckpointRefs(root)).length, refsBefore, "stale turn creates no ref");
      assertEqual((await loadAllCheckpoints(root, "new-session")).length, 0, "no old work tagged new");

      await requireHandler(captured, "before_agent_start")({ prompt: "new session turn" }, newContext);
      await requireHandler(captured, "turn_start")({ turnIndex: 2 }, newContext);
      await requireHandler(captured, "turn_end")({}, newContext);
      assertEqual((await loadAllCheckpoints(root, "new-session")).length, 1, "new session retains change");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (errors.length > 0) {
    console.log("Failures:");
    errors.forEach((error) => console.log(error));
  }
  process.exit(failed > 0 ? 1 : 0);
}

await runTests();
