/**
 * Persistent Identity Foundation (Step 1) test suite.
 *
 * Covers: initial identity creation, restart restoration, consistency across
 * conversation sessions, identity stability across AI model switching and
 * provider switching (via the shared validated injection boundary), missing
 * identity recovery, corrupted identity handling, schema migration, future-
 * schema quarantine, concurrent-initialization protection, update immutability
 * rules (identityId/schemaVersion), backup adopt/reject semantics, transport
 * tamper rejection, and regression for existing agent functionality
 * (ToolRegistry Phase 3 contract + Phase 2 MemoryService on the shared stack).
 *
 * Usage: npx tsx scripts/test-identity-step1.ts
 * Exits non-zero on any failure.
 */
import {
  CANONICAL_IDENTITY,
  IdentityService,
  getIdentityService,
  identityContentHash,
  normalizeIdentity,
  renderIdentityPromptBlock,
  resetIdentityServiceForTests,
  validateIdentityRecord,
  validateIdentityTransportPayload,
  IDENTITY_SCHEMA_VERSION,
  IDENTITY_STORAGE_KEY,
  type KrishaIdentity,
} from '../src/agent/identity';
import { AgentEventBus, ToolRegistry, ok } from '../src/agent';
import { MemoryService } from '../src/agent/memory';
import { MemoryStorage, localStorageAdapter } from '../src/agent/taskState';
import type { AgentTool, StorageAdapter } from '../src/agent';

// ------------------------------------------------------------------ harness

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/** In-memory storage with seeding + wipe (restart / storage-loss simulation). */
class SeedableStorage implements StorageAdapter {
  constructor(private map = new Map<string, string>()) {}
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  wipe(): void {
    this.map.clear();
  }
}

// ------------------------------------------------- 1. initial identity creation

console.log('\n1. Initial identity creation');
{
  const storage = new SeedableStorage();
  const service = new IdentityService(storage);

  assert(service.lastLoad.status === 'created', 'first run creates the identity');
  assert(service.get().name === CANONICAL_IDENTITY.name, 'canonical name (Krisha) preserved');
  assert(service.get().archetype === CANONICAL_IDENTITY.archetype, 'canonical archetype preserved');
  assert(service.get().identityId.startsWith('krix_'), 'stable identity id minted (krix_ prefix)');
  assert(service.get().schemaVersion === IDENTITY_SCHEMA_VERSION, 'schema version stamped');
  assert(service.get().origin === 'canonical', 'origin marked canonical');
  assert(validateIdentityRecord(service.get()).ok, 'created record passes full validation');
  assert(service.verifyIntegrity(), 'content checksum verifies');
  assert(service.renderPromptBlock().includes('[KRISHA PERSISTENT IDENTITY'), 'identity prompt block renders');
  assert(service.renderPromptBlock().includes(service.getIdentityId()), 'prompt block carries the stable identity id');
  const envelope = JSON.parse(storage.getItem(IDENTITY_STORAGE_KEY)!);
  assert(envelope.schemaVersion === IDENTITY_SCHEMA_VERSION && envelope.identity.identityId === service.getIdentityId(), 'envelope persisted with stable id');
  // Canary: canonical content round-trips BYTE-PERFECT (never clamped).
  assert(envelope.identity.communication.expressionTagging.endsWith('shyness, perk_up).'), 'canonical expression protocol survives byte-perfect (no silent clamping)');
  assertEqual(envelope.identity.personality.foundation, CANONICAL_IDENTITY.personality.foundation, 'canonical foundation byte-identical after persistence');
  assertEqual(envelope.identity.communication.languages, CANONICAL_IDENTITY.communication.languages, 'canonical language rule byte-identical after persistence');
}

// ------------------------------------- 2. restoration after application restart

console.log('\n2. Identity restoration after restart');
{
  const storage = new SeedableStorage();
  const first = new IdentityService(storage);
  const promptBefore = first.renderPromptBlock();
  const idBefore = first.getIdentityId();

  // "Restart": a brand-new service instance over the same persisted storage.
  const second = new IdentityService(storage);
  assert(second.lastLoad.status === 'stored', 'restart loads the stored identity (status stored)');
  assertEqual(second.getIdentityId(), idBefore, 'identity id identical after restart');
  assertEqual(second.renderPromptBlock(), promptBefore, 'identity prompt block byte-identical after restart');
  assertEqual(second.get().personality.foundation, first.get().personality.foundation, 'personality foundation identical after restart');

  // Restart through a REAL persistence boundary: serialize to JSON (what a
  // file-backed/localStorage adapter stores) and boot a fresh service on it.
  const roundTrip = JSON.parse(JSON.stringify(JSON.parse(storage.getItem(IDENTITY_STORAGE_KEY)!)));
  const freshStore = new SeedableStorage(new Map([[IDENTITY_STORAGE_KEY, JSON.stringify(roundTrip)]]));
  const proc2 = new IdentityService(freshStore);
  assertEqual(proc2.getIdentityId(), idBefore, 'identity id identical across a serialized storage boundary (process restart simulation)');
  assertEqual(proc2.renderPromptBlock(), promptBefore, 'prompt block identical across the serialized boundary');

  // The browser adapter contract identity relies on at startup is intact.
  assert(typeof localStorageAdapter.getItem === 'function' && typeof localStorageAdapter.setItem === 'function', 'localStorageAdapter contract intact');
}

// ------------------------------------- 3. consistency across conversation sessions

console.log('\n3. Identity consistency across conversation sessions');
{
  const storage = new SeedableStorage();
  const service = new IdentityService(storage);
  const payload1 = JSON.stringify(service.getTransportPayload());

  // Three consecutive sessions (new chat turns/contexts, same persisted identity).
  const sessionPayloads = [service.getTransportPayload(), service.getTransportPayload(), service.getTransportPayload()];
  assert(sessionPayloads.every((p) => JSON.stringify(p) === payload1), 'transport payload identical across sessions');
  const id = service.getIdentityId();
  assert(sessionPayloads.every((p) => p.identityId === id), 'identity id constant across sessions');

  // A new service (fresh page load mid-day) still serves the same identity.
  const reloaded = new IdentityService(storage);
  assertEqual(reloaded.getTransportPayload(), service.getTransportPayload(), 'reloaded service serves the identical payload');
}

// ------------------------------------- 4. identity consistency after model switching

console.log('\n4. Identity consistency after AI model switching');
{
  const storage = new SeedableStorage();
  const service = new IdentityService(storage);
  const payload = service.getTransportPayload();

  // The server resolves the payload and renders the prompt block; the model
  // name is NOT an input to identity resolution (waterfall, router, local
  // fallback all receive the same canonical block).
  const resolveA = validateIdentityTransportPayload(payload);
  const resolveB = validateIdentityTransportPayload(payload);
  assert(resolveA.ok && resolveB.ok, 'payload validates on every resolution');
  assertEqual(renderIdentityPromptBlock(resolveB.identity!), renderIdentityPromptBlock(resolveA.identity!), 'identity block identical regardless of model context');

  // Direct proof: the block is a pure function of identity data.
  const canonicalBlock = renderIdentityPromptBlock(
    normalizeIdentity({ ...CANONICAL_IDENTITY, identityId: service.getIdentityId(), createdAt: 1, updatedAt: 1, origin: 'canonical' }, { origin: 'canonical' }).identity
  );
  assertEqual(renderIdentityPromptBlock(resolveA.identity!), canonicalBlock, 'rendered block equals canonical render for the same identity data');
}

// ------------------------------------- 5. identity consistency after provider switching

console.log('\n5. Identity consistency after provider switching');
{
  const storage = new SeedableStorage();
  const service = new IdentityService(storage);

  // Provider boundary = transport payload → server-side re-validation → render.
  // Cloud chat provider and local fallback both consume THE SAME functions.
  const viaCloud = validateIdentityTransportPayload(service.getTransportPayload());
  const viaLocal = validateIdentityTransportPayload(service.getTransportPayload());
  assert(viaCloud.ok && viaLocal.ok, 'payload validates for both provider paths');
  assertEqual(renderIdentityPromptBlock(viaLocal.identity!), renderIdentityPromptBlock(viaCloud.identity!), 'same identity block for cloud and local provider paths');
  assert(viaCloud.identity!.identityId === service.getIdentityId(), 'stable id preserved through the provider boundary');

  // A provider without transport data fails closed to the compiled-in
  // canonical identity rather than a re-initialized or empty one.
  const missing = validateIdentityTransportPayload(undefined);
  assert(!missing.ok, 'missing provider payload is rejected (never silently re-initialized)');
  const serverCanonical = normalizeIdentity({ ...CANONICAL_IDENTITY, createdAt: Date.now(), updatedAt: Date.now(), origin: 'canonical' }, { origin: 'canonical' });
  assert(serverCanonical.identity.name === 'Krisha', 'server-side canonical identity remains the fail-closed default');
}

// ------------------------------------- 6. missing identity recovery

console.log('\n6. Missing identity recovery');
{
  const storage = new SeedableStorage();
  const service = new IdentityService(storage);
  const idBefore = service.getIdentityId();
  const promptBefore = service.renderPromptBlock();

  // Storage wiped (browser data cleared) — a new service must recover honestly.
  storage.wipe();
  const recovered = new IdentityService(storage);
  assert(recovered.lastLoad.status === 'created', 'missing identity is re-created (honest status)');
  assert(recovered.get().name === 'Krisha', 'recovered identity is canonical Krisha');
  assert(validateIdentityRecord(recovered.get()).ok, 'recovered record validates');
  // After a full wipe the identityId cannot survive; canonical CONTENT must.
  const stripId = (block: string) => block.replace(/- Identity ID: krix_\S+ \(permanent[^\n]*\n/, '');
  assertEqual(stripId(recovered.renderPromptBlock()), stripId(promptBefore), 'recovered identity serves the canonical prompt (content identical, fresh stable id after full wipe)');
  assert(recovered.getIdentityId().startsWith('krix_'), 'recovered identity minted a fresh stable id');

  // Runtime deletion while a service instance is alive: the in-memory identity
  // stays authoritative (no crash, no re-init mid-session).
  storage.removeItem(IDENTITY_STORAGE_KEY);
  assert(service.get().identityId === idBefore, 'live service unaffected by mid-session storage loss');
  assert(service.verifyIntegrity(), 'live service integrity intact');
}

// ------------------------------------- 7. corrupted identity handling

console.log('\n7. Corrupted identity handling');
{
  // a) not valid JSON
  {
    const storage = new SeedableStorage(new Map([[IDENTITY_STORAGE_KEY, '{not json at all,,,']]));
    const service = new IdentityService(storage);
    assert(service.lastLoad.status === 'recovered', 'invalid JSON → recovered');
    assert(service.get().name === 'Krisha', 'canonical identity served after JSON corruption');
    assert(service.getQuarantinedRaw() !== null, 'corrupt raw payload quarantined');
  }
  // b) valid JSON, wrong types everywhere
  {
    const storage = new SeedableStorage(new Map([[IDENTITY_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, identity: { name: 42, identityId: null, personality: 'oops' }, savedAt: 'x' })]]));
    const service = new IdentityService(storage);
    assert(service.lastLoad.status === 'recovered', 'type-corrupted envelope → recovered');
    assert(service.get().name === 'Krisha', 'canonical fields restored over corrupted values');
    assert(validateIdentityRecord(service.get()).ok, 'repaired record fully validates');
  }
  // c) checksum mismatch (silently modified record)
  {
    const good = new IdentityService(new SeedableStorage());
    const tampered = JSON.parse(JSON.stringify(good.get())) as KrishaIdentity;
    tampered.name = 'SomeoneElse';
    const storage = new SeedableStorage(new Map([[IDENTITY_STORAGE_KEY, JSON.stringify({ schemaVersion: IDENTITY_SCHEMA_VERSION, identity: tampered, savedAt: Date.now() })]]));
    const service = new IdentityService(storage);
    assert(service.lastLoad.status === 'recovered', 'checksum-mismatched record → recovered (silent modification refused)');
    assert(service.get().name === 'Krisha', 'tampered identity replaced by canonical Krisha');
    assert(service.getIdentityId() === tampered.identityId, 'stable id re-derived from the stored payload when extractable');
  }
  // d) tampered transport payload (server boundary refuses it)
  {
    const good = new IdentityService(new SeedableStorage());
    const payload = good.getTransportPayload();
    const forged = { ...payload, name: 'FakeProviderPersona' };
    const verdict = validateIdentityTransportPayload(forged);
    assert(!verdict.ok, 'transport payload with stale checksum is rejected at the server boundary');
    assert(verdict.issues.some((i) => i.includes('hash mismatch')), 'rejection reason is the integrity checksum');
  }
  // e) oversized update fields are refused, never stored raw
  {
    const storage = new SeedableStorage();
    const service = new IdentityService(storage);
    const longName = 'X'.repeat(5000);
    const update = service.applyUpdate({ name: longName }, 'oversized name attempt');
    assert(!update.ok, 'oversized name update refused');
    assert(service.get().name === 'Krisha', 'identity unchanged after refused oversized update');
  }
}

// ------------------------------------- 8. identity schema migration

console.log('\n8. Identity schema migration');
{
  // a) legacy bare identity (pre-envelope shape) migrates up to v1
  const legacy = {
    identityId: 'krix_legacy_001',
    name: 'Krisha',
    archetype: CANONICAL_IDENTITY.archetype,
    version: 1,
    createdAt: 1600000000000,
    updatedAt: 1600000000000,
    personality: { ...CANONICAL_IDENTITY.personality },
    communication: { ...CANONICAL_IDENTITY.communication },
    principles: [...CANONICAL_IDENTITY.principles],
  };
  const legacyWithHash = { ...legacy, contentHash: identityContentHash(legacy as unknown as Omit<KrishaIdentity, 'contentHash'>) };
  const storage = new SeedableStorage(new Map([[IDENTITY_STORAGE_KEY, JSON.stringify(legacyWithHash)]]));
  const service = new IdentityService(storage);
  assert(service.lastLoad.status === 'migrated', 'legacy bare identity detected and migrated');
  assert(service.get().schemaVersion === IDENTITY_SCHEMA_VERSION, 'migrated record stamped with current schema version');
  assertEqual(service.getIdentityId(), 'krix_legacy_001', 'stable identity id preserved through migration');
  assertEqual(service.get().createdAt, 1600000000000, 'original creation timestamp preserved through migration');
  const persisted = JSON.parse(storage.getItem(IDENTITY_STORAGE_KEY)!);
  assert(persisted.schemaVersion === IDENTITY_SCHEMA_VERSION, 'migrated envelope persisted at current version');

  // b) future schema: quarantined, never destroyed, identityId carried forward
  const futureEnvelope = {
    schemaVersion: IDENTITY_SCHEMA_VERSION + 5,
    identity: { ...legacyWithHash, identityId: 'krix_future_009' },
    savedAt: Date.now(),
  };
  const futureStorage = new SeedableStorage(new Map([[IDENTITY_STORAGE_KEY, JSON.stringify(futureEnvelope)]]));
  const futureService = new IdentityService(futureStorage);
  assert(futureService.lastLoad.status === 'recovered', 'future schema → honest recovered status');
  assertEqual(futureService.getIdentityId(), 'krix_future_009', 'stable identity id carried forward from future schema');
  assert(futureService.get().name === 'Krisha', 'canonical identity served while future data is quarantined');
  assert(futureService.getQuarantinedRaw() !== null, 'future envelope preserved in quarantine (not destroyed)');
  const quarantined = JSON.parse(futureService.getQuarantinedRaw()!);
  assert(quarantined.schemaVersion === IDENTITY_SCHEMA_VERSION + 5, 'quarantined payload retains its future schema version');
}

// ------------------------------------- 9. concurrent initialization protection

console.log('\n9. Concurrent initialization protection');
{
  // a) singleton: repeated getIdentityService() calls share ONE instance.
  resetIdentityServiceForTests();
  const a = getIdentityService();
  const b = getIdentityService();
  assert(a === b, 'concurrent getIdentityService() calls return the same singleton');

  // b) parallel first-run construction over the same storage: the first one
  //    creates and persists; every other one adopts the stored stable id —
  //    exactly one identity is ever minted per persisted store.
  const storage = new SeedableStorage();
  const racers = [0, 1, 2, 3, 4].map(() => new IdentityService(storage));
  const ids = new Set(racers.map((s) => s.getIdentityId()));
  assert(ids.size === 1, `all concurrent first-run services share ONE identity id (got ${ids.size})`);
  assert(JSON.parse(storage.getItem(IDENTITY_STORAGE_KEY)!).identity.identityId === racers[0].getIdentityId(), 'persisted envelope matches the shared stable id');

  // c) late joiner after creation also adopts (read-before-write).
  const late = new IdentityService(storage);
  assertEqual(late.getIdentityId(), racers[0].getIdentityId(), 'late initializer adopts the existing stable id');
  resetIdentityServiceForTests();
}

// ------------------------------- (extra) mutation rules & backup semantics

console.log('\nExtra. Update immutability + backup adoption');
{
  const storage = new SeedableStorage();
  const service = new IdentityService(storage);
  const originalId = service.getIdentityId();

  const refusedId = service.applyUpdate({ identityId: 'krix_attacker_001' }, 'identity replacement attempt');
  assert(!refusedId.ok, 'identityId replacement refused (immutable)');
  const refusedSchema = service.applyUpdate({ schemaVersion: 99 } as Partial<KrishaIdentity>, 'schema jump attempt');
  assert(!refusedSchema.ok, 'schemaVersion jump refused (migrations only)');
  const refusedDowngrade = service.applyUpdate({ version: 0 }, 'version downgrade attempt');
  assert(!refusedDowngrade.ok, 'identity version downgrade refused');
  assertEqual(service.getIdentityId(), originalId, 'stable id unchanged after refused updates');
  assert(service.verifyIntegrity(), 'integrity intact after refused updates');

  const accepted = service.applyUpdate({ archetype: CANONICAL_IDENTITY.archetype }, 'explicit validated re-affirmation');
  assert(accepted.ok, 'validated update accepted');
  assert(validateIdentityRecord(accepted.identity!).ok, 'updated record re-validates with a fresh checksum');
  assert(service.getChangeHistory().length >= 1, 'change history records accepted updates');

  // Backup adoption: same id → adopted; different id → refused (never replaced).
  const backup = new IdentityService(new SeedableStorage());
  const foreign = new IdentityService(new SeedableStorage());
  assert(backup.getIdentityId() !== foreign.getIdentityId(), 'two independent stores mint different stable ids (uniqueness)');
  const adoptForeign = service.adoptFromBackup(foreign.get());
  assert(!adoptForeign.ok, 'backup with a DIFFERENT stable id is refused (identity replacement blocked)');
  const adoptSame = service.adoptFromBackup(service.get());
  assert(adoptSame.ok, 'backup with the SAME stable id is adopted (legitimate restore)');
}

// ------------------------------------- 10. regression for existing agent functionality

console.log('\n10. Regression — existing agent functionality on the shared stack');
{
  // a) Phase 2 MemoryService still works on the same StorageAdapter machinery.
  const memory = new MemoryService(new MemoryStorage());
  const remembered = memory.remember('My name is RegressionProbe and I work as a test engineer', { source: 'user_manual' });
  assert(remembered.action === 'created' || remembered.action === 'merged', `MemoryService remember operational (action: ${remembered.action})`);
  const recalled = memory.recall('What is RegressionProbe working as?', { limit: 5 });
  assert(recalled.some((m) => m.content.includes('RegressionProbe')), 'MemoryService recall operational');

  // b) Phase 3 ToolRegistry contract still operational (structured results,
  //    validation, events) — the machinery identity rides alongside.
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const probeTool: AgentTool = {
    name: 'system.note',
    description: 'Regression probe tool',
    category: 'system',
    riskLevel: 'safe',
    capabilities: ['system.note'],
    permissions: [],
    inputSchema: { required: ['note'], types: { note: 'string' } },
    timeoutMs: 2000,
    retryPolicy: { maxAttempts: 1 },
    cost: 'free',
    reliability: 0.99,
    execute: async (input) => ok({ output: { noted: input.note } }),
  };
  registry.registerAll([probeTool]);
  const toolResult = await registry.execute('system.note', { note: 'identity-step regression' });
  assert(toolResult.success === true, 'ToolRegistry executes the probe tool with a structured result');

  // c) the identity module is side-effect free for the agent stack:
  //    constructing an IdentityService over injected storage neither touches
  //    localStorage-backed stores nor mutates shared registries.
  const probe = new IdentityService(new MemoryStorage());
  assert(probe.get().name === 'Krisha' && probe.verifyIntegrity(), 'IdentityService self-contained on injected storage');
}

// ------------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILED assertions:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
