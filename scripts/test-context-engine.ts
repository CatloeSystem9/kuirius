/**
 * Context Engine v1 tests — local-first, cache-first, network-last.
 * Usage: npx tsx scripts/test-context-engine.ts
 * Deterministic: injected clocks, in-memory storage, no network, no timers.
 */
import fs from "fs";
import path from "path";
import { MemoryStorage } from "../src/agent/taskState";
import { AgentEventBus } from "../src/agent/events";
import {
  analyzeContext,
  extractKeywords,
  rankItems,
  scoreItem,
  packWithinBudget,
  buildPackage,
  renderPackageText,
  SessionCache,
  PersistentCache,
  ContextEngine,
  cacheKey,
  retrieveCandidates,
  toItem,
  DEFAULT_CONTEXT_BUDGET,
  CONTEXT_CACHE_STORAGE_KEY,
  type ContextItem,
  type ContextRequest,
  type ContextRequirements,
  type RankedItem,
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

console.log("Context Engine v1\n");

// =================================================================
// 1. Context Analyzer — requirements + local vs external
// =================================================================
{
  console.log("1. Context Analyzer");
  const weather = analyzeContext({ input: "what's the weather like in Tokyo today" });
  assertEqual(weather.networkNeed, "required", "weather → network REQUIRED");
  assertEqual(weather.staleTolerant, false, "weather → NOT stale tolerant");
  assertEqual(weather.intent, "research", "weather → research intent");

  const diagnose = analyzeContext({ input: "Open the Krisha project and check why the tests are failing" });
  assertEqual(diagnose.networkNeed, "none", "project diagnosis → no network needed (LOCAL-FIRST)");
  assertEqual(diagnose.intent, "diagnose", "project diagnosis → diagnose intent");
  assert(diagnose.needsMemory, "diagnose needs memory");
  assert(diagnose.needsTaskState, "diagnose needs task state");
  assert(diagnose.needsProjectFiles, "diagnose needs project files");
  assert(diagnose.needsToolState, "diagnose needs tool state");

  const chitchat = analyzeContext({ input: "hey there" });
  assertEqual(chitchat.intent, "chitchat", "small talk → chitchat");
  assertEqual(chitchat.needsMemory, false, "chitchat does NOT need memory recall");
  assertEqual(chitchat.networkNeed, "none", "chitchat needs no network");

  const device = analyzeContext({ input: "open notepad and type hello" });
  assertEqual(device.intent, "device_task", "app control → device_task");
  assert(device.needsEnvironment && device.needsToolState, "device task needs environment + tool state");

  const explicitSearch = analyzeContext({ input: "search the web for rust vs go benchmarks" });
  assertEqual(explicitSearch.networkNeed, "required", "explicit web search → network REQUIRED");
  assert(extractKeywords("fix the failing login tests").includes("login"), "keyword extraction keeps domain terms");
}

// =================================================================
// 2. Retriever — targeted retrieval + failure isolation
// =================================================================
{
  console.log("2. Context Retriever");
  let recallCalls = 0;
  const memory = {
    recall(_q: string, _o?: { limit?: number }) {
      recallCalls++;
      return [
        { content: "User prefers dark theme for coding", updatedAt: Date.now(), importance: 0.8, category: "preference" },
      ];
    },
  };
  const task = {
    goal: { description: "Fix login bug" },
    status: "running",
    memoryContext: [] as string[],
    context: { notepad: "open", screenshotData: "data:image/png;base64,AAAA" } as Record<string, unknown>,
  };
  const deps = {
    memory,
    getTask: (id: string) => (id === "t1" ? task : undefined),
    sessionCache: new SessionCache(),
    persistentCache: new PersistentCache(),
    now: Date.now(),
  };

  const reqDiag = analyzeContext({ input: "why is the login button failing in my project", taskId: "t1" });
  const items = retrieveCandidates({ input: "why is the login button failing in my project", taskId: "t1" }, reqDiag, deps);
  assert(items.some((i) => i.id === "user_current" && i.priority === "P0"), "current instruction always a P0 candidate");
  assert(items.some((i) => i.id === "task_goal" && i.content.includes("Fix login bug")), "task goal retrieved (P0 task_state)");
  assert(items.some((i) => i.id === "tool_notepad" && i.content === "notepad: open"), "tool state retrieved");
  assert(!items.some((i) => i.content.includes("screenshotData")), "screenshot tool state NEVER retrieved as context");
  assert(items.some((i) => i.source === "memory"), "memory recalled for diagnose request");
  assertEqual(recallCalls, 1, "memory recall called exactly once (targeted)");

  // Not-needed sources stay untouched: chitchat must not hit memory at all.
  recallCalls = 0;
  const reqChat = analyzeContext({ input: "hey there" });
  retrieveCandidates({ input: "hey there" }, reqChat, deps);
  assertEqual(recallCalls, 0, "chitchat does NOT trigger memory recall (targeted retrieval)");

  // Failure isolation: a throwing memory service must not break retrieval.
  const brokenDeps = {
    ...deps,
    memory: {
      recall() {
        throw new Error("memory boom");
      },
    },
  };
  const memQuery = "what do you remember about my favorite project";
  const items2 = retrieveCandidates({ input: memQuery }, analyzeContext({ input: memQuery }), brokenDeps);
  assert(items2.length >= 1 && items2[0].id === "user_current", "memory failure isolated — retrieval continues with local items");
}

// =================================================================
// 3. Relevance Engine — ranking, gate, duplicates, staleness
// =================================================================
{
  console.log("3. Relevance Engine");
  const req = analyzeContext({ input: "weather in Tokyo" });
  const now = 1_000_000;
  const relevant = toItem("conversation", "Tokyo weather forecast: sunny and 22 degrees", now - 1000);
  const irrelevant = toItem("conversation", "gardening tips for spring roses", now - 1000);
  const ranked = rankItems([irrelevant, relevant], req, now);
  assertEqual(ranked.length, 1, "zero-overlap ambient item removed by relevance gate");
  assert(ranked[0].item.id === relevant.id, "relevant item survives and ranks");

  // P0 floor: constraints survive even with zero topical overlap.
  const constraint = toItem("constraints", "never delete user files without permission", now);
  const s = scoreItem(constraint, req, now);
  assert(s.total >= 0.85, "P0 constraint keeps a high relevance floor");

  // Duplicate detection: identical content collapses to the newer copy.
  const dupA = toItem("conversation", "Tokyo weather forecast sunny 22 degrees today", now - 5000);
  const dupB = toItem("conversation", "Tokyo weather forecast sunny 22 degrees today", now);
  const rankedDup = rankItems([dupA, dupB], req, now);
  assertEqual(rankedDup.length, 1, "near-identical duplicates deduplicated");
  assertEqual(rankedDup[0].item.timestamp, now, "newer duplicate preferred");

  // Fresh beats stale.
  const staleCopy: ContextItem = { ...toItem("cached_knowledge", "Tokyo weather sunny 22 degrees", now), stale: true };
  const freshCopy = toItem("cached_knowledge", "Tokyo weather sunny 22 degrees", now);
  const rankedStale = rankItems([staleCopy, freshCopy], req, now);
  assertEqual(rankedStale.length, 1, "fresh/stale pair deduplicated");
  assert(!rankedStale[0].item.stale, "fresh copy preferred over stale copy");

  // Staleness penalty lowers score deterministically.
  const old = scoreItem({ ...relevant, timestamp: now - 8 * 24 * 60 * 60_000 }, req, now);
  const fresh = scoreItem(relevant, req, now);
  assert(old.total < fresh.total, "older item scores lower than fresh equivalent");
}

// =================================================================
// 4. Budget Manager — caps, P0 preservation, honest truncation
// =================================================================
{
  console.log("4. Context Budget Manager");
  const mk = (id: string, source: ContextItem["source"], priority: ContextItem["priority"], content: string): RankedItem => ({
    item: { id, source, content, priority, timestamp: Date.now(), chars: content.length },
    score: { total: 0.9, overlap: 0.5, recency: 1, sourceWeight: 0.8, importance: 0.5, stalenessPenalty: 0 },
  });
  const tight = { maxChars: 100, priorityCaps: { P0: 1500, P1: 1800, P2: 1000, P3: 500, P4: 0 }, truncatable: ["P2", "P3"] as ContextItem["priority"][] };

  const out1 = packWithinBudget([mk("a", "constraints", "P0", "c".repeat(60)), mk("b", "memory", "P1", "m".repeat(50))], tight);
  assertEqual(out1.kept.length, 1, "under tight budget only the highest tier fits");
  assertEqual(out1.kept[0].id, "a", "P0 preserved under tight budget");
  assert(out1.charsUsed <= 100, "global budget respected");

  const out2 = packWithinBudget([mk("big", "memory", "P1", "m".repeat(200))], tight);
  assertEqual(out2.kept.length, 0, "oversized P1 dropped, never blindly truncated");
  assertEqual(out2.truncatedItems, 0, "P1 truncation count is zero");

  const out3 = packWithinBudget([mk("p2", "conversation", "P2", "word ".repeat(40))], tight);
  assertEqual(out3.kept.length, 1, "P2 fits via word truncation");
  assertEqual(out3.truncatedItems, 1, "P2 truncation recorded");
  assert(out3.kept[0].content.length <= 100 && out3.kept[0].content.endsWith("…"), "P2 word-truncated with ellipsis");

  const out4 = packWithinBudget([mk("p4", "environment", "P4", "junk".repeat(10))], DEFAULT_CONTEXT_BUDGET);
  assertEqual(out4.kept.length, 0, "P4 discarded unconditionally");
  assertEqual(out4.dropped.length, 1, "P4 reported as dropped");
}

// =================================================================
// 5. Context Builder — package shape + rendering
// =================================================================
{
  console.log("5. Context Builder");
  const request: ContextRequest = { input: "why are the krisha project tests failing", taskId: "t5" };
  const requirements: ContextRequirements = analyzeContext(request);
  const kept: ContextItem[] = [
    toItem("user", request.input, Date.now(), { id: "user_current" }),
    toItem("task_state", "Active task: Fix the test suite", Date.now(), { id: "task_goal" }),
    toItem("memory", "Tests were green before the utils refactor", Date.now(), { id: "mem1" }),
    { ...toItem("cached_knowledge", "missing import in utils.ts broke the tests", Date.now(), { id: "ck1" }), stale: true },
  ];
  const outcome = { kept, dropped: [toItem("conversation", "unrelated", Date.now())], charsUsed: kept.reduce((s, i) => s + i.chars, 0), truncatedItems: 0 };
  const pkg = buildPackage(request, requirements, outcome, { skippedSources: ["environment"], now: Date.now() });
  assertEqual(pkg.request, request.input, "package echoes the request");
  assertEqual(pkg.currentGoal, "Fix the test suite", "current goal extracted from task state");
  assertEqual(pkg.activeTaskId, "t5", "active task id preserved");
  assert(pkg.relevantMemories.length === 1 && pkg.relevantMemories[0].includes("utils refactor"), "memories assembled");
  assert(pkg.cachedKnowledge.length === 1 && pkg.cachedKnowledge[0].startsWith("[stale] "), "stale cached knowledge clearly marked");
  assertEqual(pkg.metadata.staleCount, 1, "stale count tracked");
  assertEqual(pkg.metadata.candidatesConsidered, 5, "candidates = kept + dropped");
  assert(pkg.metadata.skippedSources.includes("environment"), "skipped sources recorded");
  const text = renderPackageText(pkg);
  assert(text.includes("[ACTIVE TASK]") && text.includes("[RELEVANT MEMORIES]") && text.includes("[CACHED KNOWLEDGE]"), "render includes all populated sections");
  const emptyPkg = buildPackage(request, requirements, { kept: [], dropped: [], charsUsed: 0, truncatedItems: 0 }, { skippedSources: [], now: Date.now() });
  assert(emptyPkg.relevantMemories.length === 0 && emptyPkg.currentGoal === undefined, "missing optional information degrades cleanly");
}

// =================================================================
// 6. Persistent Cache — restart, TTL, stale window, dedup, corruption
// =================================================================
{
  console.log("6. Persistent Cache");
  // TTL + stale overstay (injected clock).
  let t = 0;
  const pc = new PersistentCache(new MemoryStorage(), { persistentDefaultTtlMs: 1000 }, () => t);
  pc.set("knowledge:x", "tokyo weather value long enough for the cache minimum size");
  t = 500;
  assert(pc.get("knowledge:x").hit, "fresh entry hits");
  t = 1001;
  assert(!pc.get("knowledge:x").hit, "expired entry misses without stale tolerance");
  t = 1002;
  const staleHit = pc.get("knowledge:x", { allowStale: true });
  assert(staleHit.hit === true && staleHit.stale === true, "expired entry served marked stale inside overstay window");
  t = 3500;
  assert(!pc.get("knowledge:x", { allowStale: true }).hit, "entry beyond overstay window is gone");
  assertEqual(pc.stats().expired, 1, "expiry counted once");

  // Restart survival via the same storage adapter.
  const store2 = new MemoryStorage();
  const a = new PersistentCache(store2, {}, () => 0);
  a.set("knowledge:k", { msg: "survives restart payload abc" });
  const b = new PersistentCache(store2, {}, () => 0);
  assert(b.get("knowledge:k").hit, "persistent cache survives simulated restart");

  // Corruption → clean start, never throws, then recovers.
  const store3 = new MemoryStorage();
  store3.setItem(CONTEXT_CACHE_STORAGE_KEY, "{corrupt json!!");
  const c = new PersistentCache(store3, {}, () => 0);
  let threw = false;
  try {
    assert(!c.get("knowledge:any").hit, "corrupt storage loads as empty");
  } catch {
    threw = true;
  }
  assert(!threw, "corrupt storage never throws");
  c.set("knowledge:fresh", "fresh value after corruption recovery padding");
  assert(new PersistentCache(store3, {}, () => 0).get("knowledge:fresh").hit, "cache recovers and persists after corruption");

  // Dedup by deterministic key.
  const pc2 = new PersistentCache(undefined, {}, () => 0);
  const first = pc2.set("knowledge:same", "v1");
  const second = pc2.set("knowledge:same", "v2");
  assertEqual(pc2.stats().size, 1, "same logical entry deduplicated (no growth)");
  assertEqual(second.createdAt, first.createdAt, "dedup preserves original createdAt");
  assertEqual(pc2.get("knowledge:same").value, "v2", "dedup keeps latest value");

  // Invalidation by prefix.
  pc2.set("knowledge:aa", "x");
  pc2.set("knowledge:bb", "y");
  pc2.set("session:cc", "z");
  assertEqual(pc2.invalidate("knowledge:"), 3, "prefix invalidation removes the knowledge namespace");
  assert(pc2.get("session:cc").hit, "non-matching namespace untouched");

  // Deterministic keys: identical logical ids collide; different ids differ.
  assertEqual(cacheKey("knowledge", "Same ID"), cacheKey("knowledge", "same id"), "cache keys are deterministic (case/whitespace normalized)");
  assert(cacheKey("knowledge", "a") !== cacheKey("knowledge", "b"), "distinct ids produce distinct keys");

  // Size caps.
  const pc3 = new PersistentCache(new MemoryStorage(), { persistentMaxEntries: 2 }, () => 0);
  pc3.set("knowledge:1", "one");
  pc3.set("knowledge:2", "two");
  pc3.set("knowledge:3", "three");
  assert(pc3.stats().size <= 2, "entry cap enforced");
  assert(pc3.stats().evictions >= 1, "eviction recorded");
}

// =================================================================
// 7. Session Cache — session-only, TTL, bounded, never persisted
// =================================================================
{
  console.log("7. Session Cache");
  let st = 0;
  const sc = new SessionCache({ sessionTtlMs: 1000, sessionMaxEntries: 2 }, () => st);
  sc.set("a", 1);
  st = 500;
  assert(sc.get("a").hit, "session entry hits within TTL");
  st = 1001;
  assert(!sc.get("a").hit, "session entry expires");
  sc.set("x", 1);
  sc.set("y", 2);
  sc.set("z", 3);
  assertEqual(sc.size, 2, "session entry cap enforced (LRU eviction)");

  // Restart = new instance → empty. And it NEVER touches persistent storage.
  const mstore = new MemoryStorage();
  const eng = new ContextEngine({ cacheStorage: mstore });
  eng.cacheSession("tmp", "session only value that must never reach the disk adapter");
  assert(eng.lookupSession("tmp").hit, "session value readable during session");
  assertEqual(mstore.getItem(CONTEXT_CACHE_STORAGE_KEY), null, "session cache NEVER written to persistent storage");
  assert(new SessionCache().size === 0, "fresh session cache starts empty (restart clears)");
}

// =================================================================
// 8. Network Minimization — cache-first, honest network metadata
// =================================================================
{
  console.log("8. Network Minimization");
  const eng = new ContextEngine({ cacheStorage: new MemoryStorage() });
  eng.cacheKnowledge("krisha-tests-note", "Krisha project tests failed because of a missing import in the utils helper module");
  const pkg = eng.buildContext({ input: "why are the krisha project tests failing", taskId: "t8" });
  assert(pkg.metadata.networkRequired === false, "local/cached knowledge → networkRequired false");
  assert(pkg.cachedKnowledge.length >= 1, "cached knowledge served BEFORE any network use");
  assert(pkg.metadata.networkReason.length > 0, "honest networkReason metadata present");

  const fresh = eng.buildContext({ input: "what's the weather in tokyo right now" });
  assert(fresh.metadata.networkRequired === true, "genuinely fresh external info still triggers network metadata");
  assertEqual(fresh.metadata.staleTolerant, false, "time-sensitive request is not stale tolerant");
}

// =================================================================
// 9. Integration — engine pipeline, events, post-result caching
// =================================================================
{
  console.log("9. Integration");
  const mstore = new MemoryStorage();
  const task2: {
    goal?: { description?: string };
    status?: string;
    memoryContext?: string[];
    context?: Record<string, unknown>;
    summary?: string;
  } = {
    goal: { description: "diagnose project tests" },
    status: "completed",
    memoryContext: [],
    summary: "The failing test was caused by a missing import in utils; fixed and verified with all suites green.",
    context: { diagnosis: "missing import in utils.ts caused the failing test suite during verification runs" },
  };
  const eng = new ContextEngine({
    cacheStorage: mstore,
    memory: {
      recall() {
        return [{ content: "User prefers dark theme for coding", updatedAt: Date.now(), importance: 0.8 }];
      },
    },
    taskStore: { get: (id: string) => (id === "t2" ? task2 : undefined) },
  });

  // Full pipeline with memory + task state.
  const pkg = eng.buildContext({ input: "why is my project failing to build", taskId: "t1" });
  assertEqual(pkg.request, "why is my project failing to build", "package echoes request");
  assert(pkg.requirements.intent === "diagnose", "requirements analyzed");
  assert(pkg.metadata.budgetCap === DEFAULT_CONTEXT_BUDGET.maxChars, "budget cap recorded");
  assert(pkg.metadata.itemsKept >= 1, "P0 instruction kept through the full pipeline");
  assertEqual(eng.getTaskContext("t1")?.request, pkg.request, "last package retained per task (bounded)");

  // Event-driven attachment (no polling).
  const bus = new AgentEventBus();
  const detach = eng.attach(bus);
  bus.emit({ name: "USER_MESSAGE", taskId: "t1", payload: { input: "why is my project failing to build" }, timestamp: Date.now() });
  assert(eng.getTaskContext("t1") !== undefined, "USER_MESSAGE builds task context (event-driven)");

  // Post-result caching: summary → session, structured output → knowledge.
  bus.emit({ name: "TASK_COMPLETED", taskId: "t2", timestamp: Date.now() });
  assert(eng.lookupSession("task_summary_t2").hit, "task summary cached in SESSION cache");
  assert(eng.lookupKnowledge("diagnose project tests|diagnosis").hit, "reusable task output cached in PERSISTENT cache");
  assert(mstore.getItem(CONTEXT_CACHE_STORAGE_KEY) !== null, "persistent cache written to the storage adapter");

  // Volatile artifacts never cached.
  eng.afterTaskCompleted("t3", { goal: { description: "g3" }, context: { screenshot: "x".repeat(120) } });
  assert(!eng.lookupKnowledge("g3|screenshot").hit, "screenshots NEVER cached");

  // Stats + invalidation + clear + detach.
  const s = eng.stats();
  assert(typeof s.session.size === "number" && typeof s.persistent.size === "number", "stats available for diagnostics");
  assertEqual(eng.invalidateKnowledge("diagnose project tests|diagnosis"), 1, "knowledge invalidation works");
  assert(!eng.lookupKnowledge("diagnose project tests|diagnosis").hit, "invalidated knowledge no longer served");
  detach();
  eng.clearCaches();
  assertEqual(eng.stats().session.size, 0, "clearCaches empties session cache");
  assertEqual(eng.stats().persistent.size, 0, "clearCaches empties persistent cache");
}

// =================================================================
// 10. No-polling guarantee — no timers anywhere in the engine
// =================================================================
{
  console.log("10. No-polling guarantee");
  const dir = path.resolve(process.cwd(), "src", "agent", "context");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assertEqual(files.length, 9, "engine module set complete (9 files)");
  let timerUsage = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    if (/\bsetInterval\s*\(/.test(src) || /\bsetTimeout\s*\(/.test(src)) timerUsage++;
  }
  assertEqual(timerUsage, 0, "no setInterval/setTimeout — event-driven only, sweeps are lazy on mutation");
}

// =================================================================
console.log(`\nContext Engine v1: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
