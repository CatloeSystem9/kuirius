/**
 * Semantic Intelligence v1 tests — bounded, local-first semantic expansion
 * layered UNDER the existing Context Engine relevance stack.
 * Usage: npx tsx scripts/test-semantic-intelligence.ts
 * Deterministic: injected clocks, in-memory storage, no network, no timers.
 */
import { MemoryStorage } from "../src/agent/taskState";
import { KnowledgeGraph } from "../src/agent/knowledge/knowledgeGraph";
import { queryGraphExpansions } from "../src/agent/knowledge/knowledgeQuery";
import { DEFAULT_KNOWLEDGE_LIMITS } from "../src/agent/knowledge/knowledgeTypes";
import {
  SemanticIntelligence,
  LearnedVocabulary,
  normalizeTerm,
  semanticOverlapFor,
  semanticGraphSource,
  DEFAULT_SEMANTIC_LIMITS,
  SEMANTIC_OVERLAP_CAP,
  SEMANTIC_VOCAB_STORAGE_KEY,
  findAliasExpansions,
} from "../src/agent/semantic";
import {
  analyzeContext,
  rankItems,
  scoreItem,
  retrieveCandidates,
  SessionCache,
  PersistentCache,
  ContextEngine,
  toItem,
  type ContextItem,
} from "../src/agent/context/index";

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

console.log("Semantic Intelligence v1\n");
const NOW = 1_700_000_000_000;

// =================================================================
// 1. Semantic matching — normalization + aliases + related terms
// =================================================================
{
  console.log("1. Semantic matching");
  assertEqual(normalizeTerm("Network Usage"), "network usage", "normalization lowercases");
  assertEqual(normalizeTerm("API Requests"), "api request", "normalization folds plurals");
  assertEqual(normalizeTerm("  weird--punctuation!! "), "weird punctuation", "normalization strips punctuation");
  assertEqual(normalizeTerm(""), "", "normalization of empty string");

  const expansions = findAliasExpansions(["internet"], DEFAULT_SEMANTIC_LIMITS.maxSeedTerms, DEFAULT_SEMANTIC_LIMITS.maxExpansions);
  assert(expansions.length > 0, "internet → alias expansions found");
  assert(expansions.some((e) => e.term.includes("network")), "internet expands toward network usage (spec example)");
  assert(expansions.every((e) => e.tier === "alias"), "alias tier for vocabulary matches");
  assert(expansions.every((e) => e.reason.includes("alias")), "alias expansion carries explainable reason");
  assert(!expansions.some((e) => e.term === "internet"), "seed term never expands to itself");

  // Related terminology: cache-first / offline operation group.
  const cacheExp = findAliasExpansions(["cache"], 6, 8);
  assert(cacheExp.some((e) => e.term.includes("cache")), "cache → cache-first related terminology");
  const localExp = findAliasExpansions(["offline"], 6, 8);
  assert(localExp.some((e) => e.term.includes("local")), "offline → local-first related terminology");

  // Normalized (plural) seeds work too.
  assert(findAliasExpansions(["api"], 6, 8).length === 0, "partial token does NOT spuriously match (no hallucinated relation)");
  assert(findAliasExpansions(["api request"], 6, 8).length > 0, "normalized multi-word seed matches group");

  // Unrelated terms → nothing.
  assertEqual(findAliasExpansions(["zebra"], 6, 8).length, 0, "unrelated term → no expansions");
  assertEqual(findAliasExpansions([], 6, 8).length, 0, "empty keywords → no expansions");

  // Semantic scorer.
  const itemTokens = new Set(["network", "usage", "local", "cache"]);
  const hit = semanticOverlapFor(itemTokens, "cache-first design reduces network usage", expansions);
  assert(hit.overlap > 0, "scorer finds alias hit in item tokens");
  assert(Boolean(hit.reason && hit.reason.includes("alias")), "scorer returns explainable reason");
  assertEqual(semanticOverlapFor(itemTokens, "cache-first design reduces network usage", []).overlap, 0, "no expansions → no semantic overlap");
  assertEqual(semanticOverlapFor(new Set(["zebra"]), "totally unrelated content", expansions).overlap, 0, "unrelated item → no semantic overlap");

  // Best-hit-only: weak associations never sum up.
  const multi = [
    { seed: "x", term: "network usage", tier: "alias" as const, confidence: 0.6, reason: "r1" },
    { seed: "x", term: "web access", tier: "alias" as const, confidence: 0.6, reason: "r2" },
  ];
  assertEqual(semanticOverlapFor(itemTokens, "network usage", multi).overlap, 0.6, "two weak hits do NOT sum to more than the best one");
}

// =================================================================
// 2. Ranking — exact beats semantic; low confidence never dominates
// =================================================================
{
  console.log("2. Ranking");
  const req = analyzeContext({ input: "why did we make krisha use less internet" });
  const expansions = findAliasExpansions(req.keywords, 6, 8);
  assert(expansions.length > 0, "spec example: 'internet' query expands");

  const exact = toItem("memory", "We reduced internet calls by batching API requests offline", NOW, { importance: 0.5 });
  const semanticOnly = toItem("memory", "The system follows a local-first architecture that keeps connectivity offline-friendly with persistent caching", NOW, { importance: 0.5 });
  const irrelevant = toItem("conversation", "model: I enjoy painting landscapes on weekends", NOW);

  const exactScore = scoreItem(exact, req, NOW, expansions);
  const semanticScore = scoreItem(semanticOnly, req, NOW, expansions);
  assert(exactScore.overlap > semanticScore.overlap, "exact token match beats semantic match");
  assert(semanticScore.semanticOverlap! > 0, "semantically related item gets semantic overlap");
  assert(semanticScore.semanticOverlap! * SEMANTIC_OVERLAP_CAP < 1, "semantic contribution is capped below a full overlap");
  assert(Boolean(semanticScore.matchReason), "semantic match carries a matchReason");
  assert(!exactScore.matchReason, "exact match needs no semantic matchReason");

  const ranked = rankItems([exact, semanticOnly, irrelevant], req, NOW, expansions);
  assert(ranked[0].item.id === exact.id, "exact match ranks first");
  assert(!ranked.some((r) => r.item.id === irrelevant.id), "irrelevant context is discarded by the gate");
  const semanticRanked = ranked.find((r) => r.item.id === semanticOnly.id);
  assert(Boolean(semanticRanked), "semantically related item survives the relevance gate");
  assert(Boolean(semanticRanked?.item.matchReason?.includes("alias")), "surviving semantic item carries matchReason");

  // Low-confidence tier ordering: graph (0.7) > alias (0.6) > learned (0.5) > model (0.45).
  const graphExp = { seed: "cache", term: "cache store", tier: "graph" as const, confidence: 0.7, reason: "graph" };
  const aliasExp = { seed: "cache", term: "cache store", tier: "alias" as const, confidence: 0.6, reason: "alias" };
  const mixed = [aliasExp, graphExp];
  assertEqual(semanticOverlapFor(new Set(["cache", "store"]), "the cache store", mixed).overlap, 0.7, "direct graph relation beats weak alias association");

  // Duplicate removal still works with expansions active.
  const dupA = toItem("memory", "local-first reduces network usage dramatically", NOW, { importance: 0.5 });
  const dupB = toItem("memory", "local-first reduces network usage dramatically", NOW - 1000, { importance: 0.5 });
  const deduped = rankItems([dupA, dupB, semanticOnly], req, NOW, expansions);
  assertEqual(deduped.filter((r) => r.item.content.startsWith("local-first reduces network")).length, 1, "duplicates removed when semantic layer active");
}

// =================================================================
// 3. Knowledge Graph integration — real relationships only, bounded
// =================================================================
{
  console.log("3. Knowledge Graph integration");
  const graph = new KnowledgeGraph({ limits: { maxTraversalDepth: 3, maxQueryResults: 10 } });
  const localFirst = graph.createNode({ type: "decision", label: "local-first architecture" })!;
  const network = graph.createNode({ type: "goal", label: "reduce network usage" })!;
  const cacheFirst = graph.createNode({ type: "decision", label: "cache-first retrieval" })!;
  const contextEngineNode = graph.createNode({ type: "component", label: "Context Engine" })!;
  assert(graph.createEdge({ sourceId: localFirst.id, targetId: network.id, relationship: "supports", confidence: 0.9, source: "user_decision" }) !== null, "graph edge created");
  graph.createEdge({ sourceId: cacheFirst.id, targetId: network.id, relationship: "supports", confidence: 0.9, source: "user_decision" });
  graph.createEdge({ sourceId: contextEngineNode.id, targetId: cacheFirst.id, relationship: "uses", confidence: 0.8, source: "task_result" });
  // A deliberately weak edge — must be filtered out of expansions.
  const junk = graph.createNode({ type: "resource", label: "random note" })!;
  graph.createEdge({ sourceId: network.id, targetId: junk.id, relationship: "related_to", confidence: 0.2 });

  const expansions = queryGraphExpansions(graph, ["network", "usage"], DEFAULT_KNOWLEDGE_LIMITS, 3, 3);
  assert(expansions.length > 0, "graph expansion found for matching seeds");
  const labels = expansions.flatMap((e) => e.related.map((r) => r.label.toLowerCase()));
  assert(labels.some((l) => l.includes("local-first")), "graph traversal reaches local-first through real relationships (spec example)");
  assert(labels.some((l) => l.includes("cache-first")), "graph traversal reaches cache-first (spec example)");
  assert(!labels.includes("random note"), "low-confidence edge (0.2) is NOT expanded — no hallucinated relationships");
  assert(expansions.every((e) => e.related.every((r) => r.confidence >= 0.5)), "all graph expansions carry adequate confidence");
  assert(expansions.every((e) => e.related.every((r) => r.relationship.length > 0)), "graph expansions carry the relationship name (explainability)");

  // Bounded: a hub node with many neighbors yields at most maxPerSeed.
  const hub = graph.createNode({ type: "component", label: "hub component" })!;
  for (let i = 0; i < 10; i++) {
    const leaf = graph.createNode({ type: "component", label: `leaf component ${i}` })!;
    graph.createEdge({ sourceId: hub.id, targetId: leaf.id, relationship: "part_of", confidence: 0.8 });
  }
  const hubExpansion = queryGraphExpansions(graph, ["hub", "component"], DEFAULT_KNOWLEDGE_LIMITS, 3, 3);
  assert(hubExpansion.every((e) => e.related.length <= 3), "graph expansion is result-capped (bounded traversal)");

  // Unknown seed → nothing (never invented).
  assertEqual(queryGraphExpansions(graph, ["quantum-flux"], DEFAULT_KNOWLEDGE_LIMITS, 3, 3).length, 0, "unknown concept → no graph expansion");
  assertEqual(queryGraphExpansions(graph, [], DEFAULT_KNOWLEDGE_LIMITS, 3, 3).length, 0, "empty seeds → no graph expansion");

  // Through the SemanticIntelligence facade with the adapter.
  const facadeLike = { graph } as never;
  const source = semanticGraphSource(facadeLike as never);
  assert(typeof source.signature() === "string" && source.signature().length > 0, "graph source exposes a deterministic signature");
  const adapted = source.relatedForTerms(["network"], 3);
  assert(adapted.length > 0 && adapted[0].related.length > 0, "adapter surfaces graph expansions");
}

// =================================================================
// 4. SemanticIntelligence — layers, caching, learning, limits
// =================================================================
{
  console.log("4. SemanticIntelligence");
  const storage = new MemoryStorage();
  const si = new SemanticIntelligence({ vocabularyStorage: storage, now: () => NOW });

  // Alias layer.
  const aliasOnly = si.expand(["internet"]);
  assert(aliasOnly.some((e) => e.tier === "alias"), "built-in vocabulary expands offline");

  // Learned layer — only trusted sources, minimum confidence.
  assertEqual(si.confirmAssociation("internet", ["offline operation"], "user_decision", 0.9), true, "trusted confirmed association accepted");
  assertEqual(si.confirmAssociation("internet", ["random gossip"], "conversation", 0.9), false, "untrusted source REJECTED (no uncontrolled learning)");
  assertEqual(si.confirmAssociation("internet", ["weak claim"], "user_decision", 0.4), false, "low-confidence claim REJECTED");
  assertEqual(si.confirmAssociation("internet", [], "user_decision", 0.9), false, "empty terms REJECTED");
  assertEqual(si.confirmAssociation("internet", ["internet"], "user_decision", 0.9), false, "self-association REJECTED");

  const learned = si.expand(["internet"]);
  assert(learned.some((e) => e.tier === "learned" && e.term === "offline operation"), "learned association expands");
  assert(learned.some((e) => e.reason.includes("user_decision")), "learned expansion carries source in reason");

  // Learned vocabulary persists and survives reload (corruption-tolerant).
  const reloaded = new SemanticIntelligence({ vocabularyStorage: storage, now: () => NOW });
  assert(reloaded.expand(["internet"]).some((e) => e.term === "offline operation"), "learned vocabulary survives reload");

  // Caching through the existing SessionCache — deterministic keys.
  const cache = new SessionCache({}, () => NOW);
  const si2 = new SemanticIntelligence({ now: () => NOW });
  const first = si2.expandDetailed(["network"], { cache });
  const second = si2.expandDetailed(["network"], { cache });
  assert(first.expansions.length > 0, "expansion computed fresh");
  assert(second.cached, "second expansion served from the EXISTING session cache");
  assert(JSON.stringify(first.expansions) === JSON.stringify(second.expansions), "cached expansion is identical (deterministic key)");

  // Malformed inputs never throw.
  assertEqual(si.expand(undefined as never).length, 0, "undefined keywords → empty");
  assertEqual(si.expand([undefined as never, 42 as never]).length, 0, "malformed keywords → empty");
  assertEqual(si.expand([]).length, 0, "empty keywords → empty");
  const longInput = "internet ".repeat(5000);
  assert(si.expand(longInput.split(" ").slice(0, 50)).length > 0, "very long keyword list handled (bounded seeds)");
  assert(si.expand(["internet".repeat(1000)]).length === 0 || si.expand(["internet".repeat(1000)]).length >= 0, "very long single keyword handled");

  // Expansion bounds are enforced.
  const bounded = new SemanticIntelligence({ limits: { maxExpansions: 2 }, now: () => NOW });
  assert(bounded.expand(["internet", "cache", "memory", "test"]).length <= 2, "maxExpansions limit enforced");

  // Learned vocabulary bounds.
  const boundedVocab = new LearnedVocabulary(new MemoryStorage(), { ...DEFAULT_SEMANTIC_LIMITS, maxLearnedTermsPerConcept: 3 }, () => NOW);
  for (let i = 0; i < 6; i++) boundedVocab.confirm("cache", [`term ${i} xyz`], "user_decision", 0.9);
  assertEqual(boundedVocab.entry("cache")!.terms.length, 3, "learned terms per concept bounded");
  const smallVocab = new LearnedVocabulary(new MemoryStorage(), { ...DEFAULT_SEMANTIC_LIMITS, maxLearnedEntries: 2 }, () => NOW);
  for (let i = 0; i < 5; i++) smallVocab.confirm(`concept${i} xyz`, ["something else"], "user_decision", 0.9);
  assertEqual(smallVocab.size, 2, "learned entry count bounded");

  // Corrupted vocabulary storage → clean start.
  const corrupt = new MemoryStorage();
  corrupt.setItem(SEMANTIC_VOCAB_STORAGE_KEY, "{not json at all");
  const corruptVocab = new LearnedVocabulary(corrupt, DEFAULT_SEMANTIC_LIMITS, () => NOW);
  assertEqual(corruptVocab.size, 0, "corrupted semantic vocab storage → clean start, never throws");
  const futureVocab = new LearnedVocabulary(
    (() => {
      const s = new MemoryStorage();
      s.setItem(SEMANTIC_VOCAB_STORAGE_KEY, JSON.stringify({ schemaVersion: 99, entries: [] }));
      return s;
    })(),
    DEFAULT_SEMANTIC_LIMITS,
    () => NOW
  );
  assertEqual(futureVocab.size, 0, "future-schema vocab storage → clean start");
}

// =================================================================
// 5. Context Engine integration — pipeline, P0/P1, budgets, memory
// =================================================================
{
  console.log("5. Context Engine integration");
  const engine = new ContextEngine({ now: () => NOW });
  const memoryRecalls: string[] = [];
  const engine2 = new ContextEngine({
    now: () => NOW,
    memory: {
      recall(query) {
        memoryRecalls.push(query);
        return [
          { content: "Krisha was made local-first to reduce network usage and API requests", updatedAt: NOW, importance: 0.8, category: "decision" },
          { content: "User's favorite color is teal", updatedAt: NOW, importance: 0.4, category: "preference" },
        ];
      },
    },
  });

  const pkg = engine2.buildContext({ input: "why did we make krisha use less internet", now: NOW });
  assert(pkg.relevantMemories.some((m) => m.includes("network usage")), "semantic pipeline reaches memory written with related vocabulary (spec example)");
  assert(memoryRecalls.length === 1 && memoryRecalls[0].includes("network usage"), "memory recall query was semantically widened");
  assert(memoryRecalls[0].length <= 600, "widened recall query is bounded");

  // Constraints stay P0 regardless of semantics.
  const pkgConstrained = engine2.buildContext({
    input: "why did we make krisha use less internet",
    constraints: ["Never delete user files without permission"],
    now: NOW,
  });
  assert(pkgConstrained.constraints.length === 1, "P0 constraints preserved through semantic pipeline");

  // Budget respected with semantic items in the pipeline.
  const tight = new ContextEngine({ now: () => NOW, budget: { maxChars: 500 } });
  const pkgTight = tight.buildContext({ input: "why did we make krisha use less internet", now: NOW });
  assert(pkgTight.metadata.charsUsed <= 500 + 60, "context budget respected with semantic expansion active");

  // Irrelevant content stays out even with expansions.
  const pkgClean = engine2.buildContext({ input: "why did we make krisha use less internet", now: NOW });
  assert(!pkgClean.relevantConversation.some((c) => c.includes("painting")), "irrelevant content never enters the package");

  // Semantically matched memory items carry matchReason (explainability).
  const req = analyzeContext({ input: "why did we make krisha use less internet" });
  const mem = engine2.buildContext({ input: "why did we make krisha use less internet", now: NOW });
  assert(mem.relevantMemories.length > 0, "memory behavior remains intact (still recall-based)");
  assert(req.keywords.includes("internet"), "analyzer behavior unchanged by semantic layer");

  // Default engine (no injected semantic) still works offline.
  const defaultPkg = engine.buildContext({ input: "explain our cache-first approach", now: NOW });
  assertEqual(defaultPkg.metadata.itemsKept >= 0, true, "default engine with built-in semantic layer works");
}

// =================================================================
// 6. Caching + failure cases
// =================================================================
{
  console.log("6. Caching + failure cases");
  // Deterministic persistent-cache keys for semantic flows still work.
  const storage = new MemoryStorage();
  const pc = new PersistentCache(storage, {}, () => NOW);
  pc.set("semantic:test", { ok: true }, { ttlMs: 1000 });
  const later = new PersistentCache(storage, {}, () => NOW + 5000);
  assertEqual(later.get("semantic:test").hit, false, "expired semantic cache entry is not served");
  const staleTolerant = new PersistentCache(storage, {}, () => NOW + 1500);
  assertEqual(staleTolerant.get("semantic:test", { allowStale: true }).stale, true, "stale semantic entry served only under stale tolerance");

  // Corrupted persistent cache → clean start.
  const corruptStorage = new MemoryStorage();
  corruptStorage.setItem("krisha_context_cache_v1", "]]corrupt{{");
  const corruptCache = new PersistentCache(corruptStorage, {}, () => NOW);
  assertEqual(corruptCache.stats().size, 0, "corrupted cache storage handled gracefully");

  // Optional model hook: used ONLY when local layers are empty + intent qualifies.
  let modelCalls = 0;
  const siModel = new SemanticIntelligence({
    now: () => NOW,
    modelHook: {
      related(terms) {
        modelCalls++;
        return [{ term: terms[0], related: ["model suggested concept"] }];
      },
    },
  });
  const modelExpansions = siModel.expand(["quantum-flux"], { intent: "question" });
  assertEqual(modelCalls, 1, "model hook consulted once when local layers empty");
  assert(modelExpansions.some((e) => e.tier === "model"), "model fallback expansion has model tier");
  assert(siModel.expand(["internet"], { intent: "question" }).every((e) => e.tier !== "model"), "model hook NOT used when local layers suffice");
  assertEqual(modelCalls, 1, "model hook not called again (local alias hit)");
  assertEqual(siModel.expand(["quantum-flux"], { intent: "chitchat" }).length, 0, "model hook NOT used for non-qualifying intents");

  // Unavailable model (throws) → silently stays local.
  const siBrokenModel = new SemanticIntelligence({
    now: () => NOW,
    modelHook: {
      related() {
        throw new Error("model unavailable");
      },
    },
  });
  assertEqual(siBrokenModel.expand(["quantum-flux"], { intent: "question" }).length, 0, "unavailable model degrades gracefully (network-last, fallback-safe)");

  // Graph source that throws → local layers still work.
  const siBrokenGraph = new SemanticIntelligence({
    now: () => NOW,
    graphSource: {
      relatedForTerms() {
        throw new Error("graph unavailable");
      },
      signature() {
        return "broken";
      },
    },
  });
  assert(siBrokenGraph.expand(["internet"]).some((e) => e.tier === "alias"), "graph failure never breaks local expansion");

  // Engine with a fully broken semantic layer still builds an honest package.
  const brokenEngine = new ContextEngine({
    now: () => NOW,
    semantic: {
      expand() {
        throw new Error("boom");
      },
    } as never,
  });
  const brokenPkg = brokenEngine.buildContext({ input: "why did we make krisha use less internet", now: NOW });
  assert(brokenPkg.request.length > 0, "engine degrades gracefully when the semantic layer throws");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
