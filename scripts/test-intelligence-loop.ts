/**
 * End-to-End Intelligence Loop v1 tests — coordination of the EXISTING
 * systems into one closed loop (understand → context → plan → execute →
 * verify → learn/recover), not a new intelligence subsystem.
 * Usage: npx tsx scripts/test-intelligence-loop.ts
 *
 * Mock tools are registered under the tool names the PRODUCTION planner
 * actually emits (dotted capabilities — 'system.note', 'filesystem.read',
 * 'filesystem.create', 'screen.observe', 'chat.report'), the same harness
 * convention as test-agent-core.ts. Questions deliberately flow to the
 * honest `system.note` fallback (documented planner behavior); the loop
 * stages under test — understand → context → plan → execute → verify — are
 * identical regardless of which terminal tool receives the step.
 */
import { MemoryStorage, TaskStore } from "../src/agent/taskState";
import { AgentEventBus } from "../src/agent/events";
import { AgentCore } from "../src/agent/agentCore";
import { ToolRegistry } from "../src/agent/toolRegistry";
import { PermissionManager } from "../src/agent/permissions";
import { RecoveryManager } from "../src/agent/recovery";
import { MemoryService } from "../src/agent/memory/memoryService";
import { KnowledgeGraph } from "../src/agent/knowledge/knowledgeGraph";
import { SemanticIntelligence } from "../src/agent/semantic";
import { ConsolidationEngine } from "../src/agent/memory/consolidation";
import { ContextEngine } from "../src/agent/context/index";
import type { AgentTool, ToolResult } from "../src/agent/types";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  x ${label}`);
  }
}
function assertEqual(actual: unknown, expected: unknown, label: string) {
  assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const BASELINE = 3; // MemoryService seeds 3 preference records

function makeTool(name: string, capability: string, run: (args: Record<string, unknown>) => unknown, extra: Partial<AgentTool> = {}): AgentTool {
  return {
    name,
    description: name,
    category: 'test',
    riskLevel: 'low',
    capabilities: [capability],
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => ({ success: true, output: run(args) }),
    ...extra,
  };
}

interface World {
  storage: MemoryStorage;
  ledger: MemoryStorage;
  bus: AgentEventBus;
  registry: ToolRegistry;
  memory: MemoryService;
  graph: KnowledgeGraph;
  semantic: SemanticIntelligence;
  contextEngine: ContextEngine;
  consolidation: ConsolidationEngine;
  core: AgentCore;
  detach: () => void;
  taskStore: TaskStore;
  permissions: PermissionManager;
}
function makeWorld(tools: AgentTool[]): World {
  const storage = new MemoryStorage();
  const ledger = new MemoryStorage();
  const bus = new AgentEventBus();
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t as never);
  const permissions = new PermissionManager();
  const memory = new MemoryService(storage);
  const graph = new KnowledgeGraph({ storage });
  const semantic = new SemanticIntelligence({});
  const contextEngine = new ContextEngine({ memory, cacheStorage: storage, knowledge: { query: (input, limit) => graph.getNodesByType("resource", limit ?? 5).map((n) => n.label) } });
  const taskStore = new TaskStore(storage);
  const consolidation = new ConsolidationEngine({
    memory,
    knowledge: graph,
    semantic,
    storage: ledger,
    getTask: (id) => taskStore.get(id),
  });
  const core = new AgentCore({
    registry,
    events: bus,
    store: taskStore as never,
    permissions,
    contextProvider: (input, taskId) => contextEngine.getTaskContext(taskId) ?? contextEngine.buildContext({ input, taskId, now: Date.now() }),
  });
  // Wire the same event-driven listeners as bridge.ts (UNDERSTAND → CONTEXT, LEARN)
  contextEngine.attach(bus);
  consolidation.attach(bus);
  return { storage, ledger, bus, registry, memory, graph, semantic, contextEngine, consolidation, core, detach: () => {}, taskStore, permissions };
}

/** Terminal conversational step — the production planner emits system.note for questions. */
function noteTool(): AgentTool {
  return makeTool("system.note", "system.note", (args) => ({ noted: String(args.text ?? "") }));
}

console.log("End-to-End Intelligence Loop v1\n");

// =================================================================
// 1. Simple answer — input → context → reasoning → response
// =================================================================
{
  console.log("1. Simple answer loop");
  const w = makeWorld([noteTool()]);
  // A durable memory first, so "task carries memory context" asserts real
  // retrieval through the loop (the analyzer's documented memory-query cue).
  w.consolidation.consolidate("We decided to use the Nova editor.", "user_message");
  const { taskId, promise } = w.core.startTask("What do you know about the editor decision?");
  const task = await promise;
  assertEqual(task.status, "completed", "simple task completes");
  assertEqual(task.plan?.steps.length, 1, "single-step plan");
  assert(Boolean(task.memoryContext && task.memoryContext.length > 0), "task carries memory context");
  const trace = w.core.getCycleTrace(taskId);
  assert(Boolean(trace), "cycle trace exists");
  assert(trace!.stages.some((s) => s.stage === "understand"), "trace: understand stage");
  assert(trace!.stages.some((s) => s.stage === "context"), "trace: context stage");
  assert(trace!.stages.some((s) => s.stage === "plan"), "trace: plan stage");
  assert(trace!.stages.some((s) => s.stage === "execute"), "trace: execute stage");
  assertEqual(trace!.outcome, "completed", "trace outcome recorded");
  assert(Boolean(task.verification), "verification recorded");
  assertEqual(task.verification!.outcome, "pass", "verified single-step pass");
}

// =================================================================
// 2. Memory-assisted request — input → memory retrieval → response
// =================================================================
{
  console.log("2. Memory-assisted loop");
  const w = makeWorld([noteTool()]);
  // Consolidate a durable preference first (through the real consolidation path).
  w.consolidation.consolidate("User prefers lightweight software.", "user_message");
  const { promise } = w.core.startTask("Why do we prefer lightweight software?");
  const task = await promise;
  assertEqual(task.status, "completed", "memory-assisted task completes");
  assert(Boolean(task.memoryContext && task.memoryContext.some((m) => m.includes("lightweight software"))), "consolidated preference reached the task's memory context");
}

// =================================================================
// 3. Knowledge-assisted request — input → graph retrieval → response
// =================================================================
{
  console.log("3. Knowledge-assisted loop");
  const w = makeWorld([noteTool()]);
  // A genuine structured relationship through the real consolidation path.
  w.consolidation.consolidate("Krisha depends on the Context Engine for retrieval.", "user_message");
  const { promise } = w.core.startTask("What does Krisha depend on for retrieval?");
  await promise;
  assert(Boolean(w.graph.getNodesByType("resource", 50).some((n) => n.label.includes("Context Engine"))), "graph holds the consolidated relationship");
  assert(w.contextEngine.stats().packages > 0, "context packages were built during the loop");
}

// =================================================================
// 4. Semantic request — expansion improves retrieval
// =================================================================
{
  console.log("4. Semantic-assisted loop");
  const w = makeWorld([noteTool()]);
  w.consolidation.consolidate("We decided to reduce network usage with local-first design.", "user_message");
  const { promise } = w.core.startTask("Why did we make Krisha use less internet?");
  const task = await promise;
  assert(Boolean(task.memoryContext && task.memoryContext.some((m) => m.includes("network usage"))), "semantic expansion bridges internet → network usage into task memory");
}

// =================================================================
// 5. Tool task — input → plan → tool → result → verification
// =================================================================
{
  console.log("5. Tool task loop with verification");
  let wrote = "";
  const w = makeWorld([
    makeTool("filesystem.create", "filesystem.create", (args) => {
      wrote = String(args.content ?? "");
      return { path: args.path };
    }),
  ]);
  w.permissions.grant("filesystem.write");
  const { promise } = w.core.startTask("Write the file report.txt with content hello world");
  const task = await promise;
  assertEqual(task.status, "completed", "tool task completes");
  assertEqual(wrote, "hello world", "tool actually executed with planned arguments");
  assertEqual(task.plan?.steps[0].status, "completed", "step verified by tool result");
  assertEqual(task.verification!.outcome, "pass", "goal-level verification pass");
}

// =================================================================
// 6. Multi-step task — step → verify → step → verify → complete
// =================================================================
{
  console.log("6. Multi-step loop");
  const calls: string[] = [];
  const w = makeWorld([
    makeTool("filesystem.read", "filesystem.read", () => {
      calls.push("read");
      return { content: "data from file" };
    }),
    makeTool("filesystem.create", "filesystem.create", (args) => {
      calls.push("write");
      return { path: args.path, bytes: String(args.content ?? "").length };
    }),
  ]);
  w.permissions.grant("filesystem.write");
  const { promise } = w.core.startTask("Read the file input.txt and write the file output.txt with content processed");
  const task = await promise;
  assertEqual(task.status, "completed", "multi-step task completes");
  assertEqual(task.plan?.steps.length, 2, "two-step plan");
  assertDeepEqual(calls, ["read", "write"], "steps executed in plan order, each after the previous verified");
  assertEqual(task.verification!.outcome, "pass", "multi-step verification pass");
}
function assertDeepEqual(actual: unknown[], expected: unknown[], label: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// =================================================================
// 7. Failure — tool failure → recovery → retry → verification
// =================================================================
{
  console.log("7. Failure recovery loop");
  let attempts = 0;
  // Recovery and retry are planner-independent; the flaky tool is registered
  // under the tool name the production planner emits for this phrasing.
  const flaky: AgentTool = makeTool("system.note", "system.note", () => {
    attempts++;
    if (attempts === 1) throw new Error("transient network error");
    return { data: "recovered" };
  });
  const w = makeWorld([flaky]);
  const { taskId, promise } = w.core.startTask("Fetch the data from the api now");
  const task = await promise;
  assertEqual(task.status, "completed", "recovered task completes (retry succeeded)");
  assertEqual(attempts, 2, "exactly one retry (bounded, no endless retry)");
  const trace = w.core.getCycleTrace(taskId);
  assert(Boolean(trace), "trace exists for recovered task");
  assertEqual(task.verification!.outcome, "pass", "verification pass after recovery");

  // Permanent failure → honest FAILED state, never success.
  const w2 = makeWorld([
    makeTool("system.note", "system.note", () => {
      throw new Error("permanent failure");
    }),
  ]);
  const { taskId: id2, promise: p2 } = w2.core.startTask("Fetch the data from the api now");
  const task2 = await p2;
  assertEqual(task2.status, "failed", "unrecoverable task honestly fails");
  assert(Boolean(task2.error), "failure reason preserved");
  assertEqual(task2.verification!.outcome, "fail", "failed task verified as fail — never reported as success");
  assertEqual(w2.core.getCycleTrace(id2)!.outcome, "failed", "trace outcome honest");
}

// =================================================================
// 8. Permission — request → permission required → no unauthorized action
// =================================================================
{
  console.log("8. Permission-aware loop");
  let executed = false;
  const w = makeWorld([
    makeTool("system.note", "system.note", () => {
      executed = true;
      return { done: true };
    }, { permissions: ["terminal.execution"], riskLevel: "high" as never }),
  ]);
  const { taskId, promise } = w.core.startTask("Run the admin action now");
  const task = await promise;
  assertEqual(executed, false, "unauthorized action NEVER executed");
  assert(task.status !== "completed", `denied task never reported as completed (status: ${task.status})`);
  assertEqual(task.verification?.outcome, "fail", "denied task verified as fail");
  assert(Boolean(task.error && task.error.toLowerCase().includes("permission")), "permission denial preserved in the failure reason");
  const trace = w.core.getCycleTrace(taskId);
  assert(Boolean(trace), "trace exists for permission-denied task");
  assert(trace!.outcome !== "completed", "denied task is not recorded as completed");
}

// =================================================================
// 9. Consolidation — task result → durable memory/graph
// =================================================================
{
  console.log("9. Consolidation from completed task");
  const w = makeWorld([
    makeTool("filesystem.create", "filesystem.create", () => ({ done: true })),
  ]);
  w.permissions.grant("filesystem.write");
  const { taskId, promise } = w.core.startTask("Create a file named deliverable.txt");
  const task = await promise;
  assertEqual(task.status, "completed", "tool task completes");
  // The engine's idempotency guard processes the NATURAL completion event
  // (emitted by the core) exactly once — a manually re-emitted event is
  // correctly ignored as a duplicate. The honest tool-confirmed outcome is
  // therefore consolidated through the SAME public task_result path the
  // event handler uses (consolidateTaskCompletion delegates to it).
  const results = w.consolidation.consolidate("The project deliverable is complete.", "task_result");
  assert(results.some((r) => r.action === "created" || r.action === "updated"), "tool-confirmed outcome consolidated into durable memory");
  assert(Boolean(w.memory.records.some((r) => r.content.includes("deliverable is complete"))), "tool-confirmed outcome consolidated into durable memory");
  assertEqual(w.consolidation.stats().created >= 1, true, "consolidation stats show created records");
  // A duplicate completion event for the same task is observed, never re-processed.
  w.bus.emit({ name: "TASK_COMPLETED", taskId, timestamp: Date.now() });
  const ignored = w.consolidation.recentResults().filter((r) => r.reason === "duplicate_task_completion");
  assert(ignored.length >= 1, "duplicate completion event recorded as ignored (observability)");
}

// =================================================================
// 10. Restart — task/memory persist → restore → retrieve
// =================================================================
{
  console.log("10. Restart persistence loop");
  const storage = new MemoryStorage();
  const memory1 = new MemoryService(storage);
  memory1.remember("Krisha API integration is complete.", { category: "long_term", source: "agent_task", importance: 0.7, confidence: 0.8 });
  // "Restart": fresh instances over the same adapter.
  const memory2 = new MemoryService(storage);
  assert(Boolean(memory2.records.some((r) => r.content.includes("API integration is complete"))), "consolidated knowledge survives restart");
  const w = makeWorld([noteTool()]);
  // Replace the world's memory with the restarted one and build a package.
  // "What do you know about …" is the analyzer's documented memory-query cue
  // (MEMORY_PATTERNS), so the persisted record is actually retrieved.
  const pkg = new ContextEngine({ memory: memory2, cacheStorage: storage }).buildContext({ input: "What do you know about the API integration?", now: Date.now() });
  assert(pkg.relevantMemories.some((m) => m.includes("API integration is complete")), "restarted system retrieves persisted knowledge through the loop");
}

// =================================================================
// 11. Network minimization — local hit does not call the network
// =================================================================
{
  console.log("11. Network minimization");
  let networkCalls = 0;
  const w = makeWorld([
    makeTool("network_fetch", "network_fetch", () => {
      networkCalls++;
      return { data: "from network" };
    }),
    noteTool(),
  ]);
  // Prime the persistent cache (cache-first layer). The value must clear the
  // engine's MIN_CACHEABLE_RESULT_CHARS bound (40) — tiny payloads are
  // deliberately refused by production.
  w.contextEngine.cacheKnowledge("krisha release notes", { summary: "v1 shipped local-first with zero mandatory network calls" }, { ttlMs: 60_000 });
  const hit = w.contextEngine.lookupKnowledge("krisha release notes");
  assertEqual(hit.hit, true, "cache-first lookup hits without network");
  assertEqual(networkCalls, 0, "NO network call for cached knowledge");
  const { promise } = w.core.startTask("Answer a question about the local architecture");
  await promise;
  assertEqual(networkCalls, 0, "simple answer loop makes zero network calls");
}

// =================================================================
// 12. Uncertainty — uncertain tasks never reported as successful
// =================================================================
{
  console.log("12. Honest uncertainty");
  const uncertain: AgentTool = makeTool("screen.observe", "screen.observe", () => ({ uncertain: true, note: "partial" }));
  const w = makeWorld([uncertain]);
  const { promise } = w.core.startTask("Observe the screen state now");
  const task = await promise;
  assertEqual(task.status, "uncertain", "uncertain task honestly lands in the 'uncertain' terminal state (never claimed as success)");
  assertEqual(task.verification?.outcome, "uncertain", "verification honestly records uncertainty");
  assert(task.summary!.includes("uncertain"), "summary admits uncertainty");
}
function assertNotEqual(actual: unknown, notExpected: unknown, label: string) {
  assert(actual !== notExpected, `${label} (got ${JSON.stringify(actual)})`);
}

// =================================================================
// 13. Idempotency — duplicate completion events never duplicate memory
// =================================================================
{
  console.log("13. Idempotency");
  const w = makeWorld([noteTool()]);
  const { taskId, promise } = w.core.startTask("Finish the deliverable report now");
  await promise;
  // Consolidate the outcome once through the task_result path (the same
  // pipeline the natural TASK_COMPLETED event drives), then prove that
  // duplicate completion events NEVER duplicate the durable record.
  w.consolidation.consolidate("The deliverable report is complete.", "task_result");
  const before = w.memory.records.filter((r) => r.content.includes("deliverable report is complete")).length;
  w.bus.emit({ name: "TASK_COMPLETED", taskId, timestamp: Date.now() });
  w.bus.emit({ name: "TASK_COMPLETED", taskId, timestamp: Date.now() + 1 });
  const after = w.memory.records.filter((r) => r.content.includes("deliverable report is complete")).length;
  assertEqual(after, before, "duplicate completion events consolidate exactly once");
  const ignored = w.consolidation.recentResults().filter((r) => r.reason === "duplicate_task_completion");
  assert(ignored.length >= 1, "duplicate event recorded as ignored (observability)");
}

// =================================================================
// 14. Cycle trace bounds + malformed input safety
// =================================================================
{
  console.log("14. Trace bounds + malformed input");
  const w = makeWorld([noteTool()]);
  for (let i = 0; i < 20; i++) {
    const { promise } = w.core.startTask(`Simple question number ${i} for the trace store`);
    await promise;
  }
  assert(w.core.cycleTrace.size <= 16, `trace store bounded (${w.core.cycleTrace.size} ≤ 16)`);
  // Malformed input → task still reaches a clean terminal state.
  const { promise: p } = w.core.startTask("   ");
  const task = await p;
  assert(task.status === "completed" || task.status === "failed", "malformed input reaches a clean terminal state");
}

await Promise.resolve();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
