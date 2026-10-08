/**
 * Intelligent Memory Consolidation v1 tests — bounded, event-driven
 * consolidation into the EXISTING Memory System + Knowledge Graph.
 * Usage: npx tsx scripts/test-memory-consolidation.ts
 * Notes: MemoryService seeds 3 preference records on fresh storage (baseline 3).
 */
import { MemoryStorage } from "../src/agent/taskState";
import { MemoryService } from "../src/agent/memory/memoryService";
import { KnowledgeGraph } from "../src/agent/knowledge/knowledgeGraph";
import { SemanticIntelligence } from "../src/agent/semantic";
import {
  ConsolidationEngine,
  CONSOLIDATION_LEDGER_STORAGE_KEY,
  DEFAULT_CONSOLIDATION_LIMITS,
} from "../src/agent/memory/consolidation";
import { AgentEventBus } from "../src/agent/events";
import { ContextEngine } from "../src/agent/context/index";
import type { StorageAdapter } from "../src/agent/taskState";

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

function validCount(memory: MemoryService): number {
  return memory.records.filter((r) => r.valid).length;
}
function findRecord(memory: MemoryService, needle: string) {
  return memory.records.find((r) => r.content.includes(needle));
}
function nodeByLabel(graph: KnowledgeGraph, type: string, label: string) {
  return graph.getNodesByType(type as never, 50).find((n) => n.label === label);
}

interface Fixture {
  storage: MemoryStorage;
  ledgerStorage: MemoryStorage;
  memory: MemoryService;
  graph: KnowledgeGraph;
  semantic: SemanticIntelligence;
  engine: ConsolidationEngine;
}
function makeFixture(limits?: Parameters<typeof makeEngineFrom>[0]): Fixture {
  const storage = new MemoryStorage();
  const ledgerStorage = new MemoryStorage();
  const memory = new MemoryService(storage);
  const graph = new KnowledgeGraph({ storage });
  const semantic = new SemanticIntelligence({});
  const engine = makeEngineFrom(limits, memory, graph, semantic, ledgerStorage);
  return { storage, ledgerStorage, memory, graph, semantic, engine };
}
function makeEngineFrom(
  limits: Partial<import("../src/agent/memory/consolidation").ConsolidationLimits> | undefined,
  memory: MemoryService,
  graph: KnowledgeGraph,
  semantic: SemanticIntelligence,
  ledgerStorage: StorageAdapter,
  getTask?: ConstructorParameters<typeof ConsolidationEngine>[0]["getTask"]
): ConsolidationEngine {
  return new ConsolidationEngine({ memory, knowledge: graph, semantic, storage: ledgerStorage, limits, getTask });
}

console.log("Intelligent Memory Consolidation v1\n");
const BASELINE = 3; // seeded preference records

// =================================================================
// 1. Explicit preference → consolidated (memory + graph)
// =================================================================
{
  console.log("1. Explicit preference consolidated");
  const f = makeFixture();
  const results = f.engine.consolidate("User prefers lightweight software.", "user_message");
  assertEqual(results.length, 2, "preference yields memory + graph results");
  assertEqual(results[0].action, "created", "memory record created");
  assertEqual(results[0].kind, "preference", "classified as preference");
  assertEqual(results[0].reason, "explicit_preference", "reason is explicit_preference");
  assert(results[0].confidence! >= 0.85, "explicit user statement → high confidence");
  assertEqual(results[1].surface, "graph", "structured relation routed to graph");
  const user = nodeByLabel(f.graph, "person", "User");
  const obj = nodeByLabel(f.graph, "resource", "lightweight software");
  assert(Boolean(user && obj), "graph nodes created (User, lightweight software)");
  assert(Boolean(user && obj && f.graph.hasEdge(user.id, "prefers", obj.id)), "User —prefers→ Lightweight Software edge exists (spec example)");
  const record = findRecord(f.memory, "lightweight software");
  assert(Boolean(record && record.category === "preference"), "memory record is a preference");
  assert(Boolean(record && (record.metadata as { consolidated?: boolean } | undefined)?.consolidated), "record carries consolidation metadata");
  assertEqual(validCount(f.memory), BASELINE + 1, "exactly one new memory record");
}

// =================================================================
// 2. Repeated preference → existing memory updated (no duplicate)
// =================================================================
{
  console.log("2. Repeated preference updates existing memory");
  const f = makeFixture();
  f.engine.consolidate("User prefers lightweight software.", "user_message");
  const results = f.engine.consolidate("I prefer lightweight software tools.", "user_message");
  assertEqual(results.length, 1, "recurrence skips redundant graph write");
  assertEqual(results[0].action, "updated", "repeated preference updates existing record");
  assertEqual(results[0].reason, "normalized_match_recurrence", "updated via normalized match");
  assertEqual(results[0].recurrence, 2, "recurrence tracked");
  assert(validCount(f.memory) === BASELINE + 1, "still exactly ONE memory record (no duplicate)");
  assert(results[0].confidence! > 0.85, "confidence increased with recurrence");
}

// =================================================================
// 3. Duplicate memory → no duplicate
// =================================================================
{
  console.log("3. Exact duplicates never create copies");
  const f = makeFixture();
  f.engine.consolidate("User prefers lightweight software.", "user_message");
  const before = validCount(f.memory);
  const results = f.engine.consolidate("User prefers lightweight software.", "user_message");
  assertEqual(results[0].action, "updated", "exact duplicate → update");
  assertEqual(results[0].reason, "exact_match_recurrence", "detected via exact match");
  assertEqual(validCount(f.memory), before, "record count unchanged");
  const beforeEdges = f.graph.stats().edges;
  f.engine.consolidate("User prefers lightweight software.", "user_message");
  assertEqual(f.graph.stats().edges, beforeEdges, "graph structure not duplicated");
}

// =================================================================
// 4. Casual chat → ignored
// =================================================================
{
  console.log("4. Casual chat ignored");
  const f = makeFixture();
  for (const text of ["hey thanks that was great", "hello", "haha lol nice", "yes exactly"]) {
    const results = f.engine.consolidate(text, "user_message");
    assertEqual(results[0].action, "ignored", `ignored: "${text}"`);
    assertEqual(results[0].reason, "no_durable_signal", `no durable signal: "${text}"`);
  }
  assertEqual(validCount(f.memory), BASELINE, "nothing persisted from chitchat");
}

// =================================================================
// 5. Low-confidence inference → rejected until recurrence
// =================================================================
{
  console.log("5. Low-confidence inference gated by recurrence");
  const f = makeFixture();
  const inferred = "The system prefers cached results.";
  let last = f.engine.consolidate(inferred, "task_result");
  assertEqual(last[0].action, "ignored", "first inferred sighting ignored");
  assertEqual(last[0].reason, "awaiting_recurrence", "awaiting recurrence");
  assertEqual(last[0].recurrence, 1, "ledger count 1");
  assertEqual(validCount(f.memory), BASELINE, "not persisted on first sight");
  f.engine.consolidate(inferred, "task_result");
  last = f.engine.consolidate(inferred, "task_result");
  assertEqual(last[0].action, "ignored", "third sighting still below threshold");
  last = f.engine.consolidate(inferred, "task_result");
  assertEqual(last[0].action, "created", "fourth consistent sighting promoted");
  assert(last[0].confidence! >= DEFAULT_CONSOLIDATION_LIMITS.minConfidence, "promoted confidence reaches threshold");
  assertEqual(validCount(f.memory), BASELINE + 1, "promoted exactly once");
  assertEqual(f.engine.stats().ledgerSize, 0, "ledger cleared after promotion");

  // A different one-off inference stays out permanently.
  const other = f.engine.consolidate("The tool prefers verbose logs.", "task_result");
  assertEqual(other[0].action, "ignored", "single one-off inference never persists");
  assertEqual(validCount(f.memory), BASELINE + 1, "memory unchanged by one-off inference");
}

// =================================================================
// 6. Conflicting information → handled safely (no silent overwrite)
// =================================================================
{
  console.log("6. Conflicts handled safely");
  const f = makeFixture();
  f.engine.consolidate("I prefer VS Code for editing.", "user_message");
  const before = validCount(f.memory);
  const results = f.engine.consolidate("I dislike VS Code for editing.", "user_message");
  assertEqual(results[0].action, "rejected", "ambiguous contradiction rejected");
  assertEqual(results[0].reason, "conflicts_with_existing_fact", "conflict reason recorded");
  assertEqual(results.length, 1, "rejected fact never reaches the graph");
  assertEqual(validCount(f.memory), before, "no record created from the contradiction");
  const original = findRecord(f.memory, "prefer VS Code");
  assert(Boolean(original && original.valid), "stronger existing fact preserved intact");

  // Explicit durable correction IS allowed through (user changed their mind).
  const f2 = makeFixture();
  f2.engine.consolidate("From now on my preferred editor is Zed.", "user_message");
  const correction = f2.engine.consolidate(
    "Stop using Zed — my preferred editor is Neovim now, I am serious about this change.",
    "user_message"
  );
  assertEqual(correction[0].action, "superseded", "durable correction supersedes via memory rules");
  assert(Boolean(correction[0].replacedMemoryId), "replaced memory id reported");
  const oldRecord = f2.memory.records.find((r) => r.id === correction[0].replacedMemoryId);
  const newRecord = findRecord(f2.memory, "Neovim");
  assert(Boolean(oldRecord && !oldRecord.valid && oldRecord.supersededBy), "old fact marked superseded, not deleted (lifecycle preserved)");
  assert(Boolean(newRecord && newRecord.valid), "new fact is the current truth");
}

// =================================================================
// 7. Superseded knowledge preserved correctly
// =================================================================
{
  console.log("7. Superseded knowledge preserved");
  const f = makeFixture();
  f.engine.consolidate("From now on my preferred editor is Zed.", "user_message");
  const results = f.engine.consolidate(
    "Stop using Zed — my preferred editor is Neovim now, I am serious about this change.",
    "user_message"
  );
  const superseded = f.memory.records.find((r) => r.id === results[0].replacedMemoryId);
  assert(Boolean(superseded), "superseded record still exists in memory (history available)");
  assertEqual(superseded?.valid, false, "superseded record is not current truth");
  assert(Boolean(superseded?.supersededBy), "superseded record points to its successor");
}

// =================================================================
// 8. Graph relationship → graph updated
// =================================================================
{
  console.log("8. Structured relations update the graph");
  const f = makeFixture();
  const results = f.engine.consolidate("Krisha depends on the Context Engine for retrieval.", "user_message");
  assertEqual(results[0].action, "created", "durable project fact created in memory");
  assertEqual(results[1].action, "created", "structured relation recorded in graph");
  const krisha = nodeByLabel(f.graph, "project", "Krisha");
  const target = nodeByLabel(f.graph, "resource", "the Context Engine for retrieval");
  assert(Boolean(krisha && target), "subject/object nodes created");
  assert(Boolean(krisha && target && f.graph.hasEdge(krisha.id, "depends_on", target.id)), "Krisha —depends_on→ Context Engine edge exists");
}

// =================================================================
// 9. Existing facts not duplicated in the graph unnecessarily
// =================================================================
{
  console.log("9. No unnecessary graph duplication");
  const f = makeFixture();
  f.engine.consolidate("Krisha depends on the Context Engine for retrieval.", "user_message");
  const edges = f.graph.stats().edges;
  const nodes = f.graph.stats().nodes;
  const results = f.engine.consolidate("Krisha depends on the Context Engine for retrieval.", "user_message");
  assertEqual(results.length, 1, "repeat touches memory only (fact already known)");
  assertEqual(f.graph.stats().edges, edges, "edge count unchanged");
  assertEqual(f.graph.stats().nodes, nodes, "node count unchanged");

  // Conflicting preference in the graph → explicit user statement supersedes.
  const f2 = makeFixture();
  f2.engine.consolidate("User prefers lightweight software.", "user_message");
  const r2 = f2.engine.consolidate("User prefers modular software architecture.", "user_message");
  const obj1 = nodeByLabel(f2.graph, "resource", "lightweight software");
  const obj2 = nodeByLabel(f2.graph, "resource", "modular software architecture");
  assert(Boolean(obj1 && obj2 && f2.graph.hasEdge(obj2.id, "supersedes", obj1.id)), "supersedes edge created between conflicting objects");
  assertEqual(r2[1].action, "superseded", "graph conflict resolved via supersedes (spec §8)");
  // Task-derived candidates never override graph structure.
  const f3 = makeFixture();
  f3.engine.consolidate("User prefers lightweight software.", "user_message");
  const r3 = f3.engine.consolidate("User prefers modular software architecture.", "task_result");
  assertEqual(r3[1]?.action, "ignored", "task-derived candidate never overrides existing structure");
}

// =================================================================
// 10. Context Engine retrieves consolidated knowledge
// =================================================================
{
  console.log("10. Context Engine benefits from consolidated knowledge");
  const f = makeFixture();
  f.engine.consolidate("User prefers lightweight software.", "user_message");
  f.engine.consolidate("Krisha depends on the Context Engine for retrieval.", "user_message");
  const engine = new ContextEngine({
    memory: f.memory,
    knowledge: { query: (input, limit) => f.graph.getNodesByType("resource", limit ?? 5).map((n) => n.label) },
  });
  const pkg = engine.buildContext({ input: "why do we prefer lightweight software", now: Date.now() });
  assert(pkg.relevantMemories.some((m) => m.includes("lightweight software")), "consolidated preference retrieved through the existing pipeline");
  const pkg2 = engine.buildContext({ input: "why does Krisha depend on the Context Engine", now: Date.now() });
  assert(pkg2.relevantMemories.some((m) => m.includes("Context Engine")), "consolidated project fact retrieved");
}

// =================================================================
// 11. Semantic Intelligence helps detect related information
// =================================================================
{
  console.log("11. Semantic Intelligence prevents near-duplicates");
  const f = makeFixture();
  const first = f.engine.consolidate("We decided to reduce network usage with local-first design.", "user_message");
  assertEqual(first[0].action, "created", "first related decision created");
  const second = f.engine.consolidate("We decided to reduce our internet usage with an offline-first architecture.", "user_message");
  assertEqual(second[0].action, "ignored", "semantically related statement not duplicated");
  assertEqual(second[0].reason, "semantically_related_memory_exists", "semantic guard reason recorded");
  assert(Boolean(second[0].relatedMemoryId), "related memory id reported");
  assertEqual(validCount(f.memory), BASELINE + 1, "no near-duplicate record created");
}

// =================================================================
// 12. Malformed input → safe failure
// =================================================================
{
  console.log("12. Malformed input handled safely");
  const f = makeFixture();
  assertEqual(f.engine.consolidate(undefined as never, "user_message")[0].action, "rejected", "undefined input rejected");
  assertEqual(f.engine.consolidate(42 as never, "user_message")[0].action, "rejected", "number input rejected");
  assertEqual(f.engine.consolidate({} as never, "user_message")[0].action, "rejected", "object input rejected");
  assertEqual(f.engine.consolidate("   ", "user_message")[0].action, "rejected", "whitespace input rejected");
  assertEqual(f.engine.consolidate(null as never, "user_message")[0].action, "rejected", "null input rejected");
  assertEqual(f.engine.consolidateTaskCompletion(undefined as never).length, 0, "malformed task handled");
  assertEqual(f.engine.consolidateTaskCompletion({ summary: 123 as never }).length, 0, "malformed summary handled");
}

// =================================================================
// 13. Corrupted persistence → safe recovery
// =================================================================
{
  console.log("13. Corrupted persistence recovers safely");
  const ledgerStorage = new MemoryStorage();
  ledgerStorage.setItem(CONSOLIDATION_LEDGER_STORAGE_KEY, "]]not json{{{");
  const f = makeFixture();
  f.engine.clearLedger();
  const engine2 = new ConsolidationEngine({
    memory: f.memory,
    knowledge: f.graph,
    semantic: f.semantic,
    storage: ledgerStorage,
  });
  const results = engine2.consolidate("The system prefers cached results.", "task_result");
  assertEqual(results[0].action, "ignored", "engine works with corrupted ledger (clean slate)");
  const results2 = engine2.consolidate("User prefers compact summaries over long ones.", "user_message");
  assertEqual(results2[0].action, "created", "consolidation fully functional after corruption recovery");
}

// =================================================================
// 14. Large input → bounded processing
// =================================================================
{
  console.log("14. Large input bounded");
  const f = makeFixture();
  const huge = "decided " + "x".repeat(50000);
  const results = f.engine.consolidate(huge, "user_message");
  assertEqual(results[0].action, "created", "oversized durable input processed");
  const record = findRecord(f.memory, "decided");
  assert(Boolean(record && record.content.length <= DEFAULT_CONSOLIDATION_LIMITS.maxContentChars + 10), "content capped at the configured limit");
  for (let i = 0; i < 150; i++) f.engine.consolidate(`casual message number ${i} nothing durable here`, "user_message");
  assert(f.engine.recentResults().length <= DEFAULT_CONSOLIDATION_LIMITS.maxRecentResults, "recent-results buffer bounded");
  assertEqual(f.engine.stats().processed, 151, "stats consistent under load");
}

// =================================================================
// 15. Restart → persistent knowledge survives
// =================================================================
{
  console.log("15. Consolidated knowledge survives restart");
  const storage = new MemoryStorage();
  const ledgerStorage = new MemoryStorage();
  const memory1 = new MemoryService(storage);
  const graph1 = new KnowledgeGraph({ storage });
  const engine1 = makeEngineFrom(undefined, memory1, graph1, new SemanticIntelligence({}), ledgerStorage);
  engine1.consolidate("Krisha depends on the Context Engine for retrieval.", "user_message");
  engine1.consolidate("The system prefers cached results.", "task_result"); // ledger count 1

  // "Restart": fresh instances over the same storage adapters.
  const memory2 = new MemoryService(storage);
  const graph2 = new KnowledgeGraph({ storage });
  const engine2 = makeEngineFrom(undefined, memory2, graph2, new SemanticIntelligence({}), ledgerStorage);
  assert(Boolean(findRecord(memory2, "Context Engine for retrieval")), "consolidated memory survives restart");
  const krisha = nodeByLabel(graph2, "project", "Krisha");
  const target = nodeByLabel(graph2, "resource", "the Context Engine for retrieval");
  assert(Boolean(krisha && target && graph2.hasEdge(krisha.id, "depends_on", target.id)), "graph relationship survives restart");
  const resumed = engine2.consolidate("The system prefers cached results.", "task_result");
  assertEqual(resumed[0].recurrence, 2, "recurrence ledger survives restart (count resumed, not reset)");
  assertEqual(resumed[0].action, "ignored", "below-threshold candidate still gated after restart");
}

// =================================================================
// 16. Session-only information → never becomes permanent
// =================================================================
{
  console.log("16. Session-only info never persists");
  const f = makeFixture();
  for (const text of [
    "what is the weather today in tokyo",
    "calculate 23 * 7 for me please",
    "maybe we could perhaps try something",
    "how do I write a for loop in python?",
  ]) {
    const results = f.engine.consolidate(text, "user_message");
    assert(results[0].action === "ignored" || results[0].action === "rejected", `session-only "${text.slice(0, 24)}…" not persisted`);
  }
  assertEqual(validCount(f.memory), BASELINE, "memory untouched by session-only content");
  assertEqual(f.graph.stats().nodes, 0, "graph untouched by session-only content");
  // Speculation is rejected outright even when it mentions preferences.
  const speculative = f.engine.consolidate("Maybe the user prefers dark themes, not sure though.", "user_message");
  assertEqual(speculative[0].action, "ignored", "speculation never consolidates");
}

// =================================================================
// 17. Boundaries: ledger cap, event wiring, secrets
// =================================================================
{
  console.log("17. Boundaries and event wiring");
  // Ledger cap (small limit for test speed).
  const f = makeFixture({ maxLedgerEntries: 8 });
  for (let i = 0; i < 12; i++) f.engine.consolidate(`The system prefers option number ${i} here.`, "task_result");
  assert(f.engine.stats().ledgerSize <= 8, `ledger bounded (size ${f.engine.stats().ledgerSize} ≤ 8)`);

  // Secrets never consolidate.
  const f2 = makeFixture();
  const secret = f2.engine.consolidate("My api key is: sk-abcdefghijklmnopqrstuvwx", "user_message");
  assert(secret[0].action === "rejected" || secret[0].action === "ignored", "secret-like content never consolidated");
  assertEqual(f2.memory.records.filter((r) => r.content.includes("sk-abc")).length, 0, "no secret stored");

  // Event wiring: USER_MESSAGE / TASK_COMPLETED on the existing bus; no polling.
  const storage = new MemoryStorage();
  const memory = new MemoryService(storage);
  const graph = new KnowledgeGraph({ storage });
  const engine = makeEngineFrom(undefined, memory, graph, new SemanticIntelligence({}), new MemoryStorage(), (id) =>
    id === "tk1" ? { goal: { description: "finish api" }, summary: "The Krisha API integration is complete." } : undefined
  );
  const bus = new AgentEventBus();
  const detach = engine.attach(bus);
  bus.emit({ name: "USER_MESSAGE", taskId: "t1", payload: { input: "User prefers dark mode interfaces." }, timestamp: Date.now() });
  assertEqual(engine.recentResults().filter((r) => r.action === "created").length, 2, "USER_MESSAGE event triggers consolidation (memory + graph)");
  bus.emit({ name: "TASK_COMPLETED", taskId: "tk1", timestamp: Date.now() });
  const taskResults = engine.recentResults().slice(-1);
  assertEqual(taskResults[0].source, "task_result", "TASK_COMPLETED event consolidates tool-confirmed outcome");
  assertEqual(taskResults[0].reason, "task_confirmed_outcome", "completion reason recorded");
  assertEqual(taskResults[0].action, "created", "project fact persisted from task completion");
  const snapshot = engine.recentResults().length;
  detach();
  bus.emit({ name: "USER_MESSAGE", taskId: "t2", payload: { input: "User prefers quiet interfaces." }, timestamp: Date.now() });
  assertEqual(engine.recentResults().length, snapshot, "detach stops event-driven consolidation");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
