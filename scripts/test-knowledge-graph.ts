/**
 * Knowledge Graph v1 tests — bounded, deterministic, local-first.
 * Usage: npx tsx scripts/test-knowledge-graph.ts
 * Deterministic: injected clocks, in-memory storage, no network, no timers.
 */
import { MemoryStorage } from "../src/agent/taskState";
import { AgentEventBus } from "../src/agent/events";
import {
  KnowledgeGraph,
  KnowledgeGraphFacade,
  queryKnowledgeContext,
  renderEdgeStatement,
  KNOWLEDGE_GRAPH_STORAGE_KEY,
  DEFAULT_KNOWLEDGE_LIMITS,
} from "../src/agent/knowledge";
import { ContextEngine } from "../src/agent/context/index";

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
/** Deterministic clock: each call advances time by one tick. */
function makeClock(start = 1000) {
  let t = start;
  return () => (t += 1);
}

console.log("Knowledge Graph v1\n");

// =================================================================
// 1. Node operations
// =================================================================
{
  console.log("1. Node operations");
  const g = new KnowledgeGraph({ now: makeClock() });

  const user = g.createNode({ type: "person", label: "User" });
  assert(user !== null && user.id.startsWith("kg_n_person_"), "node created with stable typed id");

  assertEqual(g.getNode(user!.id)?.label, "User", "created node retrievable");
  assert(g.hasNode(user!.id), "existence check true for existing node");
  assertEqual(g.hasNode("kg_n_person_nonexistent"), false, "existence check false for missing node");

  // Duplicate prevention: same type+label → same deterministic id → rejected.
  const dup = g.createNode({ type: "person", label: "user" });
  assertEqual(dup, null, "duplicate node (same type+label, case-insensitive) rejected");

  const updated = g.updateNode(user!.id, { properties: { role: "owner" } });
  assert(updated !== null && updated.properties?.role === "owner", "node properties updated");
  assert(g.updateNode("kg_n_person_missing", { label: "X" }) === null, "updating a missing node returns null");

  // Upsert: create-or-merge semantics.
  const upserted = g.upsertNode({ type: "person", label: "User", properties: { role: "admin" } });
  assert(upserted !== null && upserted.id === user!.id, "upsert reuses the existing node id");
  assert(upserted!.properties?.role === "admin" && upserted!.createdAt === user!.createdAt, "upsert merges properties, keeps createdAt");

  // Invalid entity type rejected by the validator (fail-safe, no throw).
  assertEqual(g.createNode({ type: "alien" as never, label: "X" }), null, "invalid entity type rejected");

  // Over-long labels are clamped deterministically, not rejected.
  const long = g.createNode({ type: "resource", label: "x".repeat(500) });
  assert(long !== null && long.label.length <= DEFAULT_KNOWLEDGE_LIMITS.maxLabelChars, "over-long label clamped to limit");

  // Delete cascades to incident edges (covered further in edge tests).
  assertEqual(g.deleteNode(user!.id), true, "existing node deleted");
  assertEqual(g.deleteNode(user!.id), false, "deleting a missing node returns false");
}

// =================================================================
// 2. Edge operations
// =================================================================
{
  console.log("2. Edge operations");
  const g = new KnowledgeGraph({ now: makeClock() });
  const a = g.createNode({ type: "component", label: "Context Engine" })!;
  const b = g.createNode({ type: "component", label: "Memory System" })!;
  const c = g.createNode({ type: "component", label: "Agent Core" })!;

  const e = g.createEdge({ sourceId: a.id, targetId: b.id, relationship: "depends_on", confidence: 0.8, source: "architecture" });
  assert(e !== null && e.id.startsWith("kg_e_"), "edge created");
  assertEqual(g.getEdge(e!.id)?.relationship, "depends_on", "edge retrievable");
  assert(g.hasEdge(a.id, "depends_on", b.id), "edge existence check by triple");

  // Duplicate prevention: same triple rejected.
  assertEqual(g.createEdge({ sourceId: a.id, targetId: b.id, relationship: "depends_on" }), null, "duplicate edge (same triple) rejected");

  // Dangling + self-loop + invalid relationship rejected (fail-safe).
  assertEqual(g.createEdge({ sourceId: "kg_n_missing", targetId: b.id, relationship: "uses" }), null, "dangling source rejected");
  assertEqual(g.createEdge({ sourceId: a.id, targetId: "kg_n_missing", relationship: "uses" }), null, "dangling target rejected");
  assertEqual(g.createEdge({ sourceId: a.id, targetId: a.id, relationship: "uses" }), null, "self-loop rejected");
  assertEqual(g.createEdge({ sourceId: a.id, targetId: b.id, relationship: "married_to" as never }), null, "invalid relationship type rejected");

  // Upsert by triple: refresh confidence/source without duplicating.
  const up = g.upsertEdge({ sourceId: a.id, targetId: b.id, relationship: "depends_on", confidence: 0.95, source: "verified" });
  assert(up !== null && up.id === e!.id && up.confidence === 0.95, "upsert refreshes the existing edge by triple");

  const e2 = g.createEdge({ sourceId: a.id, targetId: c.id, relationship: "related_to", confidence: 0.9 })!;
  // Delete cascades: deleting node b removes the a→b edge but not a→c.
  g.deleteNode(b.id);
  assertEqual(g.getEdge(e!.id), undefined, "deleting a node removes incident edges");
  assert(g.getEdge(e2.id) !== undefined, "unrelated edge survives node deletion");
  assertEqual(g.deleteEdge(e2.id), true, "edge deleted directly");
  assertEqual(g.deleteEdge(e2.id), false, "deleting a missing edge returns false");
}

// =================================================================
// 3. Queries — bounded traversal, path finding, result caps
// =================================================================
{
  console.log("3. Queries");
  const g = new KnowledgeGraph({ now: makeClock() });
  const a = g.createNode({ type: "component", label: "A" })!;
  const b = g.createNode({ type: "component", label: "B" })!;
  const c = g.createNode({ type: "component", label: "C" })!;
  const d = g.createNode({ type: "tool", label: "D" })!;
  g.createEdge({ sourceId: a.id, targetId: b.id, relationship: "depends_on" })!;
  g.createEdge({ sourceId: b.id, targetId: c.id, relationship: "part_of" })!;
  g.createEdge({ sourceId: d.id, targetId: a.id, relationship: "uses" })!;

  assertEqual(g.getNodesByType("component").length, 3, "getNodesByType filters correctly");
  assertEqual(g.getNodesByType("component").filter((n) => n.type === "tool").length, 0, "getNodesByType never leaks other types");

  const related = g.getRelatedNodes(a.id);
  assert(related.some((n) => n.label === "B") && related.some((n) => n.label === "D"), "related nodes include both directions");
  const filtered = g.getRelatedNodes(a.id, "depends_on");
  assertEqual(filtered.length, 1, "relationship filter narrows results");
  assertEqual(filtered[0].label, "B", "relationship filter picks the right neighbor");

  const inc = g.getIncomingRelations(a.id);
  assertEqual(inc.length, 1, "incoming relations correct");
  assertEqual(inc[0].relationship, "uses", "incoming edge is the d→a edge");
  assertEqual(g.getOutgoingRelations(a.id).length, 1, "outgoing relations correct");

  // Result caps.
  assertEqual(g.getRelatedNodes(a.id, undefined, 1).length, 1, "result limit respected");

  // Path finding: A → B → C exists within depth 2; depth 1 cannot reach C.
  const path = g.findPath(a.id, c.id);
  assert(path !== null && path.length === 3 && path[0] === a.id && path[2] === c.id, "findPath returns the full directed path");
  assertEqual(g.findPath(a.id, c.id, 1), null, "findPath respects the depth bound");
  assertEqual(g.findPath(a.id, "kg_n_missing"), null, "findPath with missing endpoint is null");
  assertEqual(JSON.stringify(g.findPath(a.id, a.id)), JSON.stringify([a.id]), "findPath to self is the trivial path");

  // Bounded neighborhood expansion.
  const hood1 = g.findRelatedEntities(a.id, { depth: 1 });
  assert(hood1.length === 2 && hood1.every((r) => r.depth === 1), "depth-1 neighborhood bounded correctly");
  const hood2 = g.findRelatedEntities(a.id, { depth: 2 });
  assert(hood2.some((r) => r.node.label === "C" && r.depth === 2), "depth-2 expansion reaches transitively connected nodes");
  assertEqual(g.findRelatedEntities(a.id, { relationship: "part_of" }).length, 0, "neighborhood relationship filter works");
}

// =================================================================
// 4. Persistence — restart survival, corruption recovery, salvage
// =================================================================
{
  console.log("4. Persistence");
  const storage = new MemoryStorage();

  // Restart simulation: two graph instances over one adapter.
  let t = 5000;
  const clock = () => (t += 1);
  const g1 = new KnowledgeGraph({ storage, now: clock });
  const n1 = g1.createNode({ type: "person", label: "User" })!;
  const n2 = g1.createNode({ type: "resource", label: "lightweight software" })!;
  g1.createEdge({ sourceId: n1.id, targetId: n2.id, relationship: "prefers", confidence: 0.9, source: "user_preference" })!;
  const g2 = new KnowledgeGraph({ storage, now: clock });
  assert(g2.hasNode(n1.id) && g2.hasNode(n2.id), "graph survives simulated restart");
  assert(g2.hasEdge(n1.id, "prefers", n2.id), "edges survive simulated restart");
  assertEqual(g2.stats().nodes, 2, "reloaded stats match");

  // Corruption A: garbage payload → clean start, never throws, recovers.
  storage.setItem(KNOWLEDGE_GRAPH_STORAGE_KEY, "{corrupt json!!");
  let threw = false;
  let g3stats = { nodes: -1, edges: -1 };
  try {
    g3stats = new KnowledgeGraph({ storage, now: clock }).stats();
  } catch {
    threw = true;
  }
  assert(!threw && g3stats.nodes === 0, "corrupt storage loads as empty without throwing");
  const g3 = new KnowledgeGraph({ storage, now: clock });
  g3.createNode({ type: "tool", label: "recovery-probe" });
  assert(new KnowledgeGraph({ storage, now: clock }).hasNode(`kg_n_tool_${"recovery-probe"}`) || new KnowledgeGraph({ storage, now: clock }).stats().nodes === 1, "graph re-persists cleanly after corruption");

  // Corruption B: partial payload → VALID entries salvaged, malformed dropped.
  const goodUser = { id: "kg_n_person_abc", type: "person", label: "User", createdAt: 1, updatedAt: 1 };
  const goodRes = { id: "kg_n_resource_def", type: "resource", label: "lightweight software", createdAt: 1, updatedAt: 1 };
  const partial = {
    schemaVersion: 1,
    nodes: [goodUser, goodRes, { id: "kg_n_bad", type: "alien", label: "bad", createdAt: 1, updatedAt: 1 }],
    edges: [
      { id: "kg_e_good", sourceId: goodUser.id, targetId: goodRes.id, relationship: "prefers", createdAt: 1, updatedAt: 1 },
      { id: "kg_e_dangling", sourceId: goodUser.id, targetId: "kg_n_gone", relationship: "uses", createdAt: 1, updatedAt: 1 },
    ],
  };
  storage.setItem(KNOWLEDGE_GRAPH_STORAGE_KEY, JSON.stringify(partial));
  const g4 = new KnowledgeGraph({ storage, now: clock });
  const s4 = g4.stats();
  assertEqual(s4.nodes, 2, "valid nodes salvaged from partially corrupt payload");
  assertEqual(s4.edges, 1, "valid edge salvaged; dangling edge dropped");
  assertEqual(s4.corruptedEntriesDropped, 2, "malformed entries counted, valid data never destroyed");

  // Future schema → clean start, never guess.
  storage.setItem(KNOWLEDGE_GRAPH_STORAGE_KEY, JSON.stringify({ schemaVersion: 99, nodes: [goodUser], edges: [] }));
  assertEqual(new KnowledgeGraph({ storage, now: clock }).stats().nodes, 0, "future schema loads as empty");

  // clear() wipes memory + storage.
  const g5 = new KnowledgeGraph({ storage, now: clock });
  g5.clear();
  assertEqual(new KnowledgeGraph({ storage, now: clock }).stats().nodes, 0, "clear removes persisted data");
}

// =================================================================
// 5. Deterministic size limits + pruning
// =================================================================
{
  console.log("5. Size limits + pruning");
  let t = 100;
  const clock = () => (t += 1);

  // Graph A — node cap: isolated nodes evicted first (degree 0, oldest first).
  const gA = new KnowledgeGraph({ storage: new MemoryStorage(), limits: { maxNodes: 5 }, now: clock });
  const hub = gA.createNode({ type: "component", label: "hub" })!;
  const leaves = ["l1", "l2", "l3"].map((l) => gA.createNode({ type: "resource", label: l })!);
  for (const leaf of leaves) gA.createEdge({ sourceId: hub.id, targetId: leaf.id, relationship: "produces", confidence: 0.9 })!;
  const isolated = ["i1", "i2", "i3", "i4"].map((l) => gA.createNode({ type: "resource", label: l })!);
  const sA = gA.stats();
  assert(sA.nodes <= 5, "node cap enforced");
  assertEqual(sA.evictedNodes, 3, "deterministic pruning evicts least-connected oldest nodes");
  assert(gA.hasNode(hub.id) && !gA.hasNode(isolated[0].id) && gA.hasNode(isolated[3].id), "well-connected + newest nodes survive pruning");

  // Graph B — edge cap: lowest-confidence edges evicted first.
  const gB = new KnowledgeGraph({ storage: new MemoryStorage(), limits: { maxEdges: 3 }, now: clock });
  const x = gB.createNode({ type: "component", label: "x" })!;
  const y = gB.createNode({ type: "component", label: "y" })!;
  const z = gB.createNode({ type: "component", label: "z" })!;
  gB.createEdge({ sourceId: x.id, targetId: y.id, relationship: "related_to", confidence: 0.9 })!;
  gB.createEdge({ sourceId: y.id, targetId: z.id, relationship: "related_to", confidence: 0.8 })!;
  gB.createEdge({ sourceId: z.id, targetId: x.id, relationship: "related_to", confidence: 0.7 })!;
  gB.createEdge({ sourceId: x.id, targetId: z.id, relationship: "related_to", confidence: 0.6 })!;
  const se = gB.stats();
  assertEqual(se.edges, 3, "edge cap enforced");
  assertEqual(se.evictedEdges, 1, "lowest-confidence edge evicted");
  assert(!gB.hasEdge(x.id, "related_to", z.id), "the 0.6-confidence edge was the victim");
  assert(gB.hasEdge(z.id, "related_to", x.id), "the 0.7-confidence edge survived");
}

// =================================================================
// 6. Indexer — deterministic extraction from messages + tasks
// =================================================================
{
  console.log("6. Knowledge Indexer");
  const facade = new KnowledgeGraphFacade({ now: makeClock() });
  const plan = facade.indexer.indexUserMessage("From now on Krisha should always be local first");
  assert(plan.edges.length >= 1, "decision extracted from explicit user statement");
  const decisions = facade.graph.getNodesByType("decision");
  assert(decisions.length === 1 && decisions[0].label.startsWith("Decision:"), "decision node created");
  const decEdge = facade.graph.getOutgoingRelations(decisions[0]!.id)[0]!;
  assertEqual(decEdge.relationship, "supports", "decision supports its concept");
  assertEqual(decEdge.confidence, 0.9, "explicit decision has high confidence");
  assertEqual(decEdge.source, "user_decision", "decision edge retains provenance");

  const plan2 = facade.indexer.indexUserMessage("I prefer lightweight software");
  assert(plan2.edges.length >= 1, "preference extracted");
  const userNodes = facade.graph.getNodesByType("person");
  assert(userNodes.length === 1 && userNodes[0].label === "User", "User person node created");
  const preferred = facade.graph.getRelatedNodes(userNodes[0]!.id, "prefers");
  assert(preferred.some((n) => n.label === "lightweight software"), "User -prefers-> lightweight software relationship");

  // Re-indexing identical information is a deterministic no-op.
  const before = facade.graph.stats();
  facade.indexer.indexUserMessage("I prefer lightweight software");
  const after = facade.graph.stats();
  assertEqual(after.nodes, before.nodes, "re-extraction adds no duplicate nodes");
  assertEqual(after.edges, before.edges, "re-extraction adds no duplicate edges");

  // Chitchat extracts nothing.
  const idle = facade.graph.stats();
  const chatPlan = facade.indexer.indexUserMessage("hey there, how is it going?");
  assertEqual(chatPlan.nodes.length, 0, "chitchat extracts nothing");
  assertEqual(facade.graph.stats().edges, idle.edges, "chitchat leaves the graph unchanged");

  // Task completion: task -produces-> result (0.7), task -uses-> tools (0.8).
  const taskPlan = facade.indexer.indexTaskCompletion({
    goal: { description: "Fix the login bug" },
    summary: "Fixed the login validation and all tests pass now",
    plan: {
      steps: [
        { toolName: "filesystem.search", status: "completed" },
        { toolName: "terminal.execute", status: "completed" },
        { toolName: "computer.click", status: "failed" },
      ],
    },
  });
  assert(taskPlan.edges.length >= 3, "task completion extracts result + tool edges");
  const tasks = facade.graph.getNodesByType("task");
  assert(tasks.some((n) => n.label === "Fix the login bug"), "task node created");
  const taskNode = tasks.find((n) => n.label === "Fix the login bug")!;
  const out = facade.graph.getOutgoingRelations(taskNode.id);
  const produces = out.find((e) => e.relationship === "produces")!;
  assertEqual(produces.confidence, 0.7, "derived task→result confidence is 0.7");
  const usedTools = out.filter((e) => e.relationship === "uses").map((e) => facade.graph.getNode(e.targetId)?.label);
  assert(usedTools.includes("filesystem.search") && usedTools.includes("terminal.execute"), "completed tools recorded");
  assert(!usedTools.includes("computer.click"), "failed tools NOT recorded");
  assert(out.find((e) => e.relationship === "uses")!.confidence === 0.8, "tool usage confidence is 0.8");
}

// =================================================================
// 7. Context Engine integration — additive, budgeted, event-driven
// =================================================================
{
  console.log("7. Context Engine integration");
  const facade = new KnowledgeGraphFacade({ now: makeClock() });
  const comp = (label: string) => facade.graph.upsertNode({ type: "component", label })!.id;
  const ce = comp("Context Engine");
  facade.graph.upsertEdge({ sourceId: ce, targetId: comp("Memory System"), relationship: "depends_on", confidence: 0.9 });
  facade.graph.upsertEdge({ sourceId: ce, targetId: comp("Agent Core"), relationship: "supports", confidence: 0.9 });
  facade.graph.upsertEdge({ sourceId: ce, targetId: comp("Network Usage"), relationship: "related_to", confidence: 0.8 });

  // Statements are bounded + synchronous (no network, no promises).
  const statements = facade.queryStatements("how does the context engine depend on the memory system", 3);
  assert(Array.isArray(statements) && statements.length > 0 && statements.length <= 3, "queryStatements bounded by limit");
  assert(statements.some((s) => s.includes("Context Engine -depends_on-> Memory System")), "compact statement rendered");

  // Structured KnowledgeContext shape (spec §16).
  const ctx = queryKnowledgeContext(facade.graph, "context engine", DEFAULT_KNOWLEDGE_LIMITS);
  assert(ctx.source === "knowledge-graph" && typeof ctx.relevanceScore === "number", "KnowledgeContext carries source + relevanceScore");
  assert(ctx.nodes.length > 0 && ctx.relationships.length > 0, "KnowledgeContext carries nodes + relationships");

  // Engine integration: graph statements flow through the existing pipeline.
  const memoryRecall: string[] = [];
  const engine = new ContextEngine({
    knowledge: { query: (input, limit) => facade.queryStatements(input, limit) },
    memory: {
      recall: () => memoryRecall.map((content) => ({ content, importance: 0.7 })),
    },
  });
  memoryRecall.push("The user prefers lightweight applications because the laptop has limited resources");
  // Input is a memory_query (needsMemory=true) whose keywords still hit the graph.
  const pkg = engine.buildContext({ input: "remember how the context engine depends on the memory system" });
  assert((pkg.knowledgeGraph?.length ?? 0) > 0, "ContextPackage includes knowledge graph statements");
  assert(pkg.relevantMemories.length > 0, "memory retrieval still present — graph does NOT replace memory");
  assert(pkg.metadata.networkRequired === false, "graph context requires no network");

  // Budget respect: under a tight budget the P0 instruction survives and the
  // P1 graph statements are dropped whole (never blindly truncated).
  const tight = new ContextEngine({
    knowledge: { query: (input, limit) => facade.queryStatements(input, limit) },
    budget: { maxChars: 90, priorityCaps: { P0: 1500, P1: 1800, P2: 1000, P3: 500, P4: 0 }, truncatable: ["P2", "P3"] },
  });
  const tightPkg = tight.buildContext({ input: "context engine memory" });
  assertEqual(tightPkg.knowledgeGraph?.length ?? 0, 0, "graph context dropped whole under tight budget");

  // Chitchat never triggers graph queries (targeted retrieval).
  let graphQueries = 0;
  const countingEngine = new ContextEngine({
    knowledge: {
      query: (input, limit) => {
        graphQueries++;
        return facade.queryStatements(input, limit);
      },
    },
  });
  countingEngine.buildContext({ input: "hey there" });
  assertEqual(graphQueries, 0, "chitchat does not query the graph");

  // Event-driven: USER_MESSAGE with an explicit decision feeds the graph.
  const bus = new AgentEventBus();
  const detach = facade.attach(bus);
  bus.emit({ name: "USER_MESSAGE", taskId: "t1", payload: { input: "Krisha should never store secrets in plain text" }, timestamp: 1 });
  assert(facade.graph.getNodesByType("decision").length >= 1, "USER_MESSAGE event indexed into the graph");

  // Event-driven: TASK_COMPLETED records task → result via the TaskStore.
  const taskStoreLike = {
    get: (id: string) =>
      id === "t2"
        ? {
            goal: { description: "Verify the build" },
            summary: "Production build completed successfully with no type errors",
            plan: { steps: [{ toolName: "terminal.execute", status: "completed" }] },
          }
        : undefined,
  };
  const facade2 = new KnowledgeGraphFacade({ now: makeClock() });
  const detach2 = facade2.attach(bus, { getTask: taskStoreLike.get });
  bus.emit({ name: "TASK_COMPLETED", taskId: "t2", timestamp: 2 });
  const tasks2 = facade2.graph.getNodesByType("task");
  assert(tasks2.some((n) => n.label === "Verify the build"), "TASK_COMPLETED event indexed into the graph");
  const t2 = tasks2.find((n) => n.label === "Verify the build")!;
  assert(facade2.graph.getOutgoingRelations(t2.id).some((e) => e.relationship === "produces"), "task→result edge recorded from the event");
  detach();
  detach2();
}

// =================================================================
// 8. Performance — bounded operations stay lightweight
// =================================================================
{
  console.log("8. Performance");
  let t = 0;
  const clock = () => (t += 1);
  const storage = new MemoryStorage();
  const g = new KnowledgeGraph({ storage, limits: { maxNodes: 400, maxEdges: 900 }, now: clock });

  const started = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < 300; i++) {
    ids.push(g.upsertNode({ type: i % 2 === 0 ? "component" : "resource", label: `entity-${i}` })!.id);
  }
  for (let i = 0; i < 300; i++) {
    g.upsertEdge({ sourceId: ids[i], targetId: ids[(i + 1) % ids.length], relationship: "related_to", confidence: 0.5 + (i % 5) / 10 });
  }
  const populated = Date.now();

  for (let i = 0; i < 50; i++) {
    g.findRelatedEntities(ids[i], { depth: 2, limit: 10 });
    g.findPath(ids[i], ids[(i + 40) % ids.length], 3);
    g.getRelatedNodes(ids[i]);
  }
  const queried = Date.now();

  const upsertAgain = g.upsertNode({ type: "component", label: "entity-0" })!;
  assertEqual(upsertAgain.id, ids[0], "re-upsert of 300-node graph stays idempotent");
  const total = Date.now();

  assert(populated - started < 3000, `600 mutations completed in ${populated - started}ms (bounded)`);
  assert(queried - populated < 2000, `150 bounded queries completed in ${queried - populated}ms`);
  assert(total - queried < 1000, "re-upsert on a large graph stays fast");

  // Serialized payload stays small.
  const raw = storage.getItem(KNOWLEDGE_GRAPH_STORAGE_KEY) ?? "";
  assert(raw.length > 0 && raw.length < 500_000, `serialized graph bounded (${raw.length} chars for 300 nodes/300 edges)`);
  assertEqual(g.stats().nodes, 300, "no unexpected eviction at configured caps");
}

// =================================================================
console.log(`\nKnowledge Graph v1: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
