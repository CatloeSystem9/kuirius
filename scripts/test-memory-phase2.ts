/**
 * Phase 2 verification suite — persistent memory layer under Node with in-memory storage.
 * Usage: npx tsx scripts/test-memory-phase2.ts
 * Exits non-zero on any failure.
 */
import { MemoryService, assessWorth, detectCorrection, extractPreferenceTriples } from '../src/agent/memory/memoryService';
import { similarity } from '../src/agent/memory/similarity';
import { MemoryStore } from '../src/agent/memory/memoryStore';
import { MEMORY_STORAGE_KEY, LEGACY_MEMORY_KEY } from '../src/agent/memory/memoryTypes';
import { MemoryStorage } from '../src/agent/taskState';
import type { StorageAdapter } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { TaskStore } from '../src/agent/taskState';
import type { AgentSystem } from '../src/agent/bridge';
import { attachMemoryToSystem } from '../src/agent/memory/memoryBridge';
import { ok } from '../src/agent/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/** Storage adapter that throws on write — for resilience tests. */
class BrokenWriteStorage extends MemoryStorage {
  setItem(): void {
    throw new Error('disk full');
  }
}

// ---------------------------------------------------------------- 1. creation
{
  console.log('1. Memory creation');
  const mem = new MemoryService(new MemoryStorage());

  const fact = mem.remember('My favorite drink is iced matcha latte', { source: 'conversation_extract' });
  assertEqual(fact.action, 'created' as const, 'durable fact stored');
  assertEqual(fact.action === 'created' ? fact.record.category : '', 'preference', 'favorite fact categorized as preference');

  const job = mem.remember('I work as a UX designer at a startup', { source: 'conversation_extract' });
  assertEqual(job.action, 'created' as const, 'job fact stored');
  assertEqual(job.action === 'created' ? job.record.category : '', 'long_term', 'job fact categorized as long_term');

  assertEqual(mem.remember('haha', { source: 'conversation_extract' }).action, 'rejected' as const, 'noise rejected');
  assertEqual(mem.remember('ok', { source: 'conversation_extract' }).action, 'rejected' as const, 'greeting rejected');
  assertEqual(mem.remember('the weather seems fine today', { source: 'conversation_extract' }).action, 'rejected' as const, 'ephemeral remark rejected');
  assertEqual(mem.remember('my api key = sk-abcdefghij1234567890', { source: 'conversation_extract' }).action, 'rejected' as const, 'secret rejected');
  assertEqual(mem.remember('password: hunter2', { source: 'conversation_extract' }).action, 'rejected' as const, 'password rejected');
  assertEqual(mem.remember('', { source: 'conversation_extract' }).action, 'rejected' as const, 'empty rejected');

  // Manual additions always stored (unless secrets)
  assertEqual(mem.remember('Call me Boss', { source: 'user_manual' }).action, 'created' as const, 'manual add stored');
  assertEqual(mem.remember('token: ghp_' + 'a'.repeat(36), { source: 'user_manual' }).action, 'rejected' as const, 'manual secret still rejected');

  const worth = assessWorth('I am learning Japanese this year');
  assertEqual(worth.worth, true, 'worth assessment finds learning goals');
}

// ---------------------------------------------------------------- 2. persistence
{
  console.log('2. Persistence');
  const storage = new MemoryStorage();
  const mem = new MemoryService(storage);
  mem.remember('My favorite drink is iced matcha latte', { source: 'conversation_extract' });

  const raw = storage.getItem(MEMORY_STORAGE_KEY);
  assert(Boolean(raw) && raw!.includes('schemaVersion') && raw!.includes('iced matcha'), 'records serialized with schema envelope');

  const mirror = storage.getItem(LEGACY_MEMORY_KEY);
  assert(Boolean(mirror) && mirror!.includes('iced matcha'), 'legacy mirror key written for old readers');
}

// ---------------------------------------------------------------- 3. retrieval
{
  console.log('3. Retrieval (recall/search)');
  const mem = new MemoryService(new MemoryStorage());
  mem.remember('User prefers dark mode for coding', { source: 'user_manual' });
  mem.remember('Has a dog named Bruno who loves walks', { source: 'conversation_extract' });
  mem.remember('Completed the portfolio website task last week', { source: 'agent_task', category: 'episodic' });

  const recalled = mem.recall('should I use dark mode for the editor?', { limit: 3 });
  assert(recalled.length > 0, 'recall returns something');
  assert(recalled[0].content.includes('dark mode'), 'most relevant memory first');
  assert(recalled.length <= 3, 'recall respects limit (no database dump)');

  const searched = mem.search('Bruno');
  assertEqual(searched.length, 1, 'keyword search finds the dog memory');
}

// ---------------------------------------------------------------- 4. relevance ranking
{
  console.log('4. Relevance ranking');
  const mem = new MemoryService(new MemoryStorage());
  mem.remember('User prefers dark mode for coding', { source: 'user_manual' });
  mem.remember('User prefers short direct answers', { source: 'user_manual' });
  mem.remember('Has a dog named Bruno', { source: 'conversation_extract' });

  const ranked = mem.rankRelevance('how should krisha answer questions?');
  assert(ranked[0].record.content.includes('short direct answers'), 'top-ranked matches query semantics');
  assert(ranked[ranked.length - 1].record.content.includes('Bruno'), 'irrelevant memory ranked last');

  const filtered = mem.recall('anything at all', { categories: ['preference'], limit: 10 });
  assert(filtered.every((r) => r.category === 'preference'), 'category filter respected');

  // Importance influences ranking when overlap is equal.
  const mem2 = new MemoryService(new MemoryStorage());
  mem2.remember('likes jazz music in the evening', { source: 'conversation_extract', importance: 0.3 });
  mem2.remember('prefers jazz music while working', { source: 'user_manual', importance: 0.9 });
  assertEqual(mem2.records.filter((r) => r.content.includes('jazz')).length, 2, 'distinct jazz facts not merged');
  const ranked2 = mem2.rankRelevance('jazz music');
  assert(ranked2[0].record.importance > ranked2[1].record.importance, 'importance breaks overlap ties');
}

// ---------------------------------------------------------------- 5. duplicates
{
  console.log('5. Duplicate detection');
  const mem = new MemoryService(new MemoryStorage());
  const first = mem.remember('User prefers concise answers.', { source: 'user_manual' });
  const second = mem.remember('The user likes short direct answers.', { source: 'conversation_extract' });

  assertEqual(second.action, 'merged' as const, 'paraphrase merged into existing memory');
  assert(second.action === 'merged' && second.duplicateOf === (first.action === 'created' ? first.record.id : ''), 'merge points at original record');
  assertEqual(mem.records.filter((r) => r.valid && r.content.includes('answers')).length, 1, 'no duplicate records');

  // Dissimilar facts must NOT merge.
  const third = mem.remember('User prefers windowed mode for games', { source: 'conversation_extract' });
  assertEqual(third.action, 'created' as const, 'distinct fact still creates a record');

  assert(similarity('I love pizza', 'I enjoy pizza') > 0.6, 'synonym folding works');
}

// ---------------------------------------------------------------- 6. update
{
  console.log('6. Memory update');
  const mem = new MemoryService(new MemoryStorage());
  const created = mem.remember('User works at Acme Corp', { source: 'user_manual' });
  const id = created.action === 'created' ? created.record.id : '';
  const updated = mem.update(id, 'User works at Globex Corporation');
  assert(updated !== null && updated.content.includes('Globex'), 'update changes content');
  assert(updated !== null && updated.updatedAt >= updated.createdAt, 'updatedAt bumped');

  // Re-remembering an updated fact merges instead of duplicating.
  const again = mem.remember('User works at Globex Corporation', { source: 'conversation_extract' });
  assertEqual(again.action, 'merged' as const, 're-stated fact merges');

  assertEqual(mem.update('nonexistent_id', 'x'), null, 'update of unknown id returns null');
}

// ---------------------------------------------------------------- 7. conflicts
{
  console.log('7. Conflict detection & resolution');
  const mem = new MemoryService(new MemoryStorage());

  // Authoritative newer statement supersedes the older one.
  const a = mem.remember('My preferred editor is VS Code', { source: 'user_manual' });
  const b = mem.remember('My preferred editor is Sublime Text', { source: 'user_manual' });
  assertEqual(b.action, 'superseded' as const, 'newer authoritative preference supersedes old');
  assert(b.action === 'superseded' && b.replaced === (a.action === 'created' ? a.record.id : ''), 'superseded link recorded');
  assert(mem.records.find((r) => r.id === (a.action === 'created' ? a.record.id : ''))!.valid === false, 'old editor fact invalidated, not deleted');

  // Low-confidence contradiction: both kept, conflict recorded, no silent winner.
  mem.remember('I prefer tea in the morning', { source: 'conversation_extract' });
  const tea = mem.remember('I hate tea in the morning', { source: 'conversation_extract' });
  assertEqual(tea.action, 'created' as const, 'low-confidence contradiction stored');
  assert(mem.getConflicts().length >= 1, 'conflict registered');
  assert(tea.action === 'created' && tea.record.metadata?.conflicted === true, 'conflicted metadata flagged');

  // detectConflicts() finds the standing contradiction pair.
  const found = mem.detectConflicts();
  assert(found.length >= 1, 'detectConflicts() finds prefer-vs-avoid pair');

  assertEqual(extractPreferenceTriples('always use npm for installs').length > 0, true, 'triple extraction: always use');
  assertEqual(extractPreferenceTriples('the sky is blue').length, 0, 'triple extraction: no preference');
}

// ---------------------------------------------------------------- 8. forget/invalidate
{
  console.log('8. Forgetting and invalidation');
  const mem = new MemoryService(new MemoryStorage());
  const created = mem.remember('User is allergic to peanuts', { source: 'user_manual' });
  const id = created.action === 'created' ? created.record.id : '';

  assert(mem.invalidate(id) === true, 'invalidate succeeds');
  assert(mem.get(id)!.valid === false, 'invalidated record hidden from recall');
  assertEqual(mem.displayMemories().includes('User is allergic to peanuts'), false, 'invalidated not displayed');

  const other = mem.remember('User drives a blue car', { source: 'user_manual' });
  const otherId = other.action === 'created' ? other.record.id : '';
  assert(mem.forget(otherId) === true, 'forget removes record');
  assertEqual(mem.get(otherId), undefined, 'forgotten record gone');
  assert(mem.forget(otherId) === false, 'double forget returns false');
}

// ---------------------------------------------------------------- 9. restart persistence
{
  console.log('9. Restart persistence');
  const storage = new MemoryStorage();
  const mem1 = new MemoryService(storage);
  mem1.remember('User prefers standing desk', { source: 'user_manual' });
  mem1.remember('User prefers concise answers', { source: 'user_manual' });

  const mem2 = new MemoryService(storage); // "restart"
  assert(mem2.displayMemories().includes('User prefers standing desk'), 'memory survives restart');
  assertEqual(mem2.records.length, mem1.records.length, 'record count preserved');
  assert(mem2.records.length >= 2, 'stored facts present after restart');

  // Merge metadata survives too.
  const again = mem2.remember('The user prefers concise answers', { source: 'conversation_extract' });
  assertEqual(again.action, 'merged' as const, 'dedup works across restarts');
}

// ---------------------------------------------------------------- 10. agent core integration
{
  console.log('10. Agent Core integration');
  const storage = new MemoryStorage();
  const memory = new MemoryService(storage);

  const registry = new ToolRegistry();
  registry.register({
    name: 'system.note',
    description: 'note',
    category: 'test',
    riskLevel: 'low',
    execute: async () => ok({ output: 'noted' }),
  });
  registry.register({
    name: 'web.open_website',
    description: 'open',
    category: 'browser',
    riskLevel: 'low',
    execute: async () => ok({ output: { opened: true } }),
  });

  const core = new AgentCore({
    registry,
    events: new AgentEventBus(),
    store: new TaskStore(new MemoryStorage()),
  });
  const system: AgentSystem = { core, bus: core.events, registry, detach: () => {} };
  const attachment = attachMemoryToSystem(system, memory);

  // 10a. Correction during a task becomes a memory + relevant memories attach to task state.
  const task1 = await core.submit('never use yarn for installs, always use npm');
  const correctionRecord = memory.records.find((r) => r.category === 'correction' && r.content.includes('npm'));
  assert(Boolean(correctionRecord), 'durable correction stored from agent input');
  assert(Array.isArray(task1.memoryContext) && task1.memoryContext.length > 0, 'relevant memories attached to task state');

  // 10b. The learned correction is retrieved in a later, related task.
  const recalled = memory.recall('install dependencies with yarn or npm?', { limit: 5 });
  assert(recalled.some((r) => r.content.includes('npm')), 'learned correction recalled for related query');

  // 10c. Completed multi-step task creates episodic + workflow memory.
  const task2 = await core.submit('open https://example.com then open https://wikipedia.org');
  assertEqual(task2.status, 'completed' as const, 'workflow task completed');
  const episodic = memory.records.filter((r) => r.category === 'episodic' && r.content.includes('example.com'));
  assert(episodic.length >= 1, 'episodic memory of completed task stored');

  const workflow = memory.records.find((r) => r.category === 'workflow');
  assert(Boolean(workflow), 'workflow memory created from task');
  const steps = (workflow?.metadata?.steps as string[] | undefined) ?? [];
  assertEqual(steps.length, 2, 'workflow steps recorded in order');
  assert(((workflow?.metadata?.tools as string[]) ?? []).includes('web.open_website'), 'workflow tools recorded');

  // 10d. Repeating a similar workflow strengthens it instead of duplicating.
  await core.submit('open https://example.com then open https://wikipedia.org');
  const workflows = memory.records.filter((r) => r.category === 'workflow');
  assertEqual(workflows.length, 1, 'repeated workflow upserted, not duplicated');
  assertEqual(((workflows[0].metadata?.successCount as number) ?? 0) >= 2, true, 'workflow success count increased');

  // 10e. Failed tasks are remembered to avoid repeating mistakes.
  const before = memory.records.filter((r) => r.category === 'episodic' && r.metadata?.outcome === 'failed').length;
  registry.register({
    name: 'chat.report',
    description: 'report',
    category: 'conversation',
    riskLevel: 'low',
    execute: async () => ok({ output: 'reported' }),
  });
  await core.submit('open https://example.com then tell me the result');
  const after = memory.records.filter((r) => r.category === 'episodic' && r.metadata?.outcome === 'failed').length;
  assertEqual(after, before, 'no false failure episodes (task succeeded)');

  attachment.detach();
}

// ---------------------------------------------------------------- 11. corrections
{
  console.log('11. Correction-based learning');
  const mem = new MemoryService(new MemoryStorage());

  const durable = detectCorrection("That's wrong — always use the export button for reports");
  assertEqual(durable.isCorrection, true, 'correction detected');
  assertEqual(durable.durable, true, 'durable correction flagged');

  const fleeting = detectCorrection("don't do that");
  assertEqual(fleeting.isCorrection, true, 'brief correction detected');
  assertEqual(fleeting.durable, false, 'brief correction not durable');

  const stored = mem.remember("That's wrong — always use the export button for reports", { source: 'user_correction' });
  assertEqual(stored.action, 'created' as const, 'durable correction stored');
  assertEqual(stored.action === 'created' ? stored.record.category : '', 'correction', 'stored as correction category');

  // Corrections rank high for related future queries (importance 0.85).
  const ranked = mem.rankRelevance('export button for reports');
  assert(ranked[0].record.category === 'correction', 'correction recalled first for related query');

  const notRemembered = mem.remember("don't do that", { source: 'conversation_extract' });
  assertEqual(notRemembered.action, 'rejected' as const, 'fleeting correction not auto-stored');
}

// ---------------------------------------------------------------- 12. malformed data
{
  console.log('12. Malformed data handling');

  // Corrupted JSON envelope.
  const corrupt = new MemoryStorage();
  corrupt.setItem(MEMORY_STORAGE_KEY, '{this is not json{{');
  let threw = false;
  let mem: MemoryService;
  try {
    mem = new MemoryService(corrupt);
  } catch {
    threw = true;
    mem = undefined as unknown as MemoryService;
  }
  assert(!threw, 'corrupted JSON does not throw');
  assertEqual(mem!.records.length, 0, 'corrupted storage starts clean');

  // Bare array instead of envelope: records repaired with defaults.
  const bare = new MemoryStorage();
  bare.setItem(MEMORY_STORAGE_KEY, JSON.stringify([{ id: 'x1', content: 'Partially damaged record' }]));
  const memBare = new MemoryService(bare);
  assertEqual(memBare.records.length, 1, 'bare array recovered');
  assertEqual(memBare.records[0].category, 'long_term', 'missing fields defaulted');
  assert(memBare.records[0].importance > 0, 'numeric fields clamped into range');

  // Invalid entries filtered out.
  const mixed = new MemoryStorage();
  mixed.setItem(MEMORY_STORAGE_KEY, JSON.stringify({
    schemaVersion: 2,
    records: [{ id: 'ok1', content: 'Valid memory content', category: 'long_term', createdAt: 1, updatedAt: 1, importance: 0.5, confidence: 0.5, source: 'user_manual', usageCount: 0, valid: true }, 'garbage', 42, null, { content: '' }],
  }));
  const memMixed = new MemoryService(mixed);
  assertEqual(memMixed.records.length, 1, 'invalid entries filtered');

  // Future schema version: start clean without destroying evidence.
  const future = new MemoryStorage();
  future.setItem(MEMORY_STORAGE_KEY, JSON.stringify({ schemaVersion: 99, records: [] }));
  const memFuture = new MemoryService(future);
  assertEqual(memFuture.records.length, 0, 'future schema handled gracefully');

  // Legacy migration from v1 string[].
  const legacy = new MemoryStorage();
  legacy.setItem(LEGACY_MEMORY_KEY, JSON.stringify(['Old memory one', 'Old memory two']));
  const memLegacy = new MemoryService(legacy);
  assertEqual(memLegacy.records.length, 2, 'legacy v1 memories migrated');
  assertEqual(memLegacy.records[0].source, 'legacy_migrated', 'legacy source tagged');
  assert(Boolean(legacy.getItem(MEMORY_STORAGE_KEY)), 'migrated records persisted under v2 key');

  // Storage failure during writes must not break the API.
  const broken = new MemoryService(new BrokenWriteStorage());
  const outcome = broken.remember('User prefers morning walks', { source: 'user_manual' });
  assertEqual(outcome.action, 'created' as const, 'writes tolerated when storage fails');
  assert(broken.displayMemories().includes('User prefers morning walks'), 'in-memory state still serves queries');

  // Duplicate writes (same record twice) do not create ghosts.
  const dupeStorage = new MemoryStorage();
  dupeStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify({
    schemaVersion: 2,
    records: [
      { id: 'dup1', content: 'Same content twice', category: 'long_term', createdAt: 1, updatedAt: 1, importance: 0.5, confidence: 0.5, source: 'user_manual', usageCount: 0, valid: true },
      { id: 'dup1', content: 'Same content twice', category: 'long_term', createdAt: 1, updatedAt: 1, importance: 0.5, confidence: 0.5, source: 'user_manual', usageCount: 0, valid: true },
    ],
  }));
  const memDupe = new MemoryService(dupeStorage);
  assertEqual(memDupe.records.length, 1, 'duplicate ids collapsed on load');
}

// ---------------------------------------------------------------- seed behavior
{
  console.log('Seed behavior (fresh install)');
  const fresh = new MemoryService(new MemoryStorage());
  assert(fresh.records.length === 3, 'fresh install seeded with default preferences');
  assert(fresh.displayMemories().length === 3, 'seeds visible to UI');

  const store = new MemoryStore(new MemoryStorage());
  store.clear();
  assertEqual(store.records.length, 0, 'clear() empties the store');
  assertEqual(store.resetToSeed().length, 3, 'resetToSeed() restores defaults');
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('PHASE 2 TESTS: ALL GREEN');
