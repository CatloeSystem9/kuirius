/**
 * Runtime verification: create → persist → RESTART (fresh instances over the
 * same real file) → retrieve. Uses a tiny JSON-file StorageAdapter (same
 * pattern as server.ts's JsonFileStorage). Real disk, real process boundary.
 * Usage: npx tsx scripts/verify-memory-consolidation.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { StorageAdapter } from "../src/agent/taskState";
import { MemoryService } from "../src/agent/memory/memoryService";
import { KnowledgeGraph } from "../src/agent/knowledge/knowledgeGraph";
import { SemanticIntelligence } from "../src/agent/semantic";
import { ConsolidationEngine } from "../src/agent/memory/consolidation";
import { ContextEngine } from "../src/agent/context/index";

/** Tiny JSON-file StorageAdapter (corruption-safe, mirrors server.ts pattern). */
class JsonFileStorage implements StorageAdapter {
  private map = new Map<string, string>();
  private loaded = false;
  constructor(private readonly filePath: string) {}
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) this.map.set(k, String(v));
      }
    } catch {
      // missing/corrupt file → clean start
    }
  }
  private flush(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.map)), "utf8");
    } catch {
      // best-effort
    }
  }
  getItem(key: string): string | null {
    this.ensureLoaded();
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.ensureLoaded();
    this.map.set(key, value);
    this.flush();
  }
  removeItem(key: string): void {
    this.ensureLoaded();
    this.map.delete(key);
    this.flush();
  }
}

const filePath = path.join(os.tmpdir(), `krisha-consolidation-verify-${Date.now()}.json`);
let failures = 0;
function check(condition: boolean, label: string) {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}`);
  if (!condition) failures++;
}

// ---------- Session 1: create + persist (real disk)
const storage1 = new JsonFileStorage(filePath);
const ledger1 = new JsonFileStorage(filePath.replace(".json", "-ledger.json"));
const memory1 = new MemoryService(storage1);
const graph1 = new KnowledgeGraph({ storage: storage1 });
const engine1 = new ConsolidationEngine({
  memory: memory1,
  knowledge: graph1,
  semantic: new SemanticIntelligence({}),
  storage: ledger1,
});
engine1.consolidate("User prefers lightweight software.", "user_message");
engine1.consolidate("Krisha depends on the Context Engine for retrieval.", "user_message");
engine1.consolidate("The system prefers cached results.", "task_result"); // ledger sighting 1
const fileBytes = fs.readFileSync(filePath, "utf8").length;
check(fileBytes > 100, `data written to real file (${fileBytes} bytes)`);

// ---------- RESTART: brand-new instances over the same files (new process state)
const storage2 = new JsonFileStorage(filePath);
const ledger2 = new JsonFileStorage(filePath.replace(".json", "-ledger.json"));
const memory2 = new MemoryService(storage2);
const graph2 = new KnowledgeGraph({ storage: storage2 });
const engine2 = new ConsolidationEngine({
  memory: memory2,
  knowledge: graph2,
  semantic: new SemanticIntelligence({}),
  storage: ledger2,
});

// ---------- Retrieve
const pref = memory2.records.find((r) => r.content.includes("lightweight software"));
check(Boolean(pref && pref.valid), "consolidated preference survived restart");
check(Boolean(memory2.records.find((r) => r.content.includes("Context Engine for retrieval"))), "consolidated project fact survived restart");
const user = graph2.getNodesByType("person", 50).find((n) => n.label === "User");
const obj = graph2.getNodesByType("resource", 50).find((n) => n.label === "lightweight software");
check(Boolean(user && obj && graph2.hasEdge(user.id, "prefers", obj.id)), "graph relationship survived restart");

// Recurrence ledger resumed (count 2 → still below threshold)
const resumed = engine2.consolidate("The system prefers cached results.", "task_result");
check(resumed[0].recurrence === 2, `recurrence ledger survived restart (count ${resumed[0].recurrence})`);

// Context Engine retrieval over restarted state
const ctx = new ContextEngine({
  memory: memory2,
  knowledge: { query: (input, limit) => graph2.getNodesByType("resource", limit ?? 5).map((n) => n.label) },
});
const pkg = ctx.buildContext({ input: "why do we prefer lightweight software", now: Date.now() });
check(pkg.relevantMemories.some((m) => m.includes("lightweight software")), "Context Engine retrieves consolidated knowledge after restart");

// cleanup
try {
  fs.unlinkSync(filePath);
  fs.unlinkSync(filePath.replace(".json", "-ledger.json"));
} catch {
  // ignore
}

console.log(failures === 0 ? "\nRUNTIME VERIFICATION: ALL PASS" : `\nRUNTIME VERIFICATION: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
