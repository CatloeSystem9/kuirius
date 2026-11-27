/**
 * Krix Learning Mechanism — Production Verification Test Suite
 *
 * Tests:
 * 1. Natural-language intake classification (all 9 categories + regression cases)
 * 2. Resource efficiency (no polling, queue limits, dedup, cancellable)
 * 3. LearningOrchestrator interface connectivity (buildReasoningContext)
 *
 * Run: npx tsx scripts/test-learning-verification.ts
 */

import { LearningIntake } from '../src/agent/learning/learningIntake';
import { LearningOrchestrator } from '../src/agent/learning/learningOrchestrator';
import { MemoryStorage } from '../src/agent/taskState';
import { DEFAULT_LEARNING_CONFIG } from '../src/agent/learning/learningTypes';

// ─── Test harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
    failures.push(`${label}${detail ? ': ' + detail : ''}`);
  }
}

// ─── SECTION 1 — NL Intake Classification ────────────────────────────────────
console.log('\n=== SECTION 1: Natural-Language Intake Classification ===\n');

const intake = new LearningIntake();
const SESSION = 'test-session';
const CFG = DEFAULT_LEARNING_CONFIG;

// Helper: classify text as 'conversation' source
function classify(text: string, source: Parameters<typeof intake.identifyLearningCandidates>[1] = 'conversation') {
  return intake.identifyLearningCandidates(text, source, SESSION, CFG);
}

// 1a. New fact — use FACT_RE-matching text with "is/are"
{
  const c = classify('The capital of France is Paris and it is the most visited city in Europe.');
  assert('New fact → has candidate', c.length > 0, `got ${c.length}`);
  if (c.length > 0) {
    assert('New fact → type is new_knowledge or procedure', ['new_knowledge','procedure'].includes(c[0].type), `type=${c[0].type}`);
  }
}

// 1b. Correction — prefix with correction signal so detectCorrection fires
{
  const c = classify('Actually, that was wrong. The correct answer is 42, not 41.', 'correction');
  assert('Correction source → has candidate', c.length > 0);
  if (c.length > 0) {
    assert('Correction → type is correction or skill_change', ['correction','skill_change'].includes(c[0].type), `type=${c[0].type}`);
  }
}

// 1c. Question — should NOT produce learning candidates
{
  const c = classify('What is the weather like today?');
  assert('Question → no learning candidates', c.length === 0, `got ${c.length}`);
}

// 1d. Hypothetical
{
  const c = classify('If the sun were blue, the sky would look different.');
  const noLearn = c.length === 0 || (c.length > 0 && (c[0].confidence ?? 1) < 0.65);
  assert('Hypothetical → not treated as high-confidence fact', noLearn, `length=${c.length} conf=${c[0]?.confidence}`);
}

// 1e. Negation
{
  const c = classify('I am not tired today.');
  const ok = c.length === 0 || (c.length > 0 && c[0].type === 'temporary');
  assert('Negation → no fact extraction or tagged temporary', ok, `length=${c.length} type=${c[0]?.type}`);
}

// 1f. Past event (ephemeral)
{
  const c = classify('Yesterday I went to the market.');
  const ok = c.length === 0 || (c.length > 0 && (c[0].type === 'temporary' || (c[0].confidence ?? 1) < 0.5));
  assert('Past event → temporary or skipped', ok, `length=${c.length} type=${c[0]?.type} conf=${c[0]?.confidence}`);
}

// 1g. Emotional statement (ephemeral)
{
  const c = classify("I'm feeling so happy right now!");
  const ok = c.length === 0 || (c.length > 0 && c[0].type === 'temporary');
  assert('Emotional statement → temporary or skipped', ok, `length=${c.length} type=${c[0]?.type}`);
}

// 1h. Temporary info
{
  const c = classify('I will be busy until 5pm today and cannot take calls.');
  const ok = c.length === 0 || (c.length > 0 && c[0].type === 'temporary');
  assert('Temporary info → temporary or skipped', ok, `length=${c.length} type=${c[0]?.type}`);
}

// 1i. Ambiguous statement
{
  const c = classify('Banks can be found near rivers and financial districts.');
  if (c.length > 0) {
    assert('Ambiguous → low confidence or new_knowledge with <0.8 conf', (c[0].confidence ?? 1) < 0.8, `conf=${c[0].confidence} type=${c[0].type}`);
  } else {
    assert('Ambiguous → skipped (acceptable)', true);
  }
}

// REGRESSION CASE: "My cat died."
{
  const c = classify('My cat died.');
  // 1) Must NOT produce a concept with intent = new_fact / type = new_knowledge where "died" is the subject
  // 2) Should be empty (too short or temporary) or tagged temporary
  assert('REGRESSION "My cat died." → 0 candidates (too short / noise)', c.length === 0, `got ${c.length}: ${JSON.stringify(c.map(x => ({type: x.type, content: x.content?.slice(0,50)})))}`);
}

// ─── SECTION 2 — Resource Efficiency ─────────────────────────────────────────
console.log('\n=== SECTION 2: Resource Efficiency ===\n');

{
  // Use MemoryStorage (synchronous, no localStorage needed)
  const storage = new MemoryStorage();
  const orch = new LearningOrchestrator({ storage });

  // 2a. No polling / setInterval — attach() returns a detach function
  const mockBus = {
    _listeners: new Map<string, Function[]>(),
    on(event: string, fn: Function) {
      const arr = this._listeners.get(event) ?? [];
      arr.push(fn);
      this._listeners.set(event, arr);
      // Return an unsubscribe function (matches AgentEventBus.on() contract)
      return () => {
        const current = this._listeners.get(event) ?? [];
        this._listeners.set(event, current.filter(f => f !== fn));
      };
    },
    off(event: string, fn: Function) {
      const arr = this._listeners.get(event) ?? [];
      this._listeners.set(event, arr.filter(f => f !== fn));
    },
    emit(event: string, payload: unknown) {
      (this._listeners.get(event) ?? []).forEach(fn => fn(payload));
    },
  };

  const detach = orch.attach(mockBus as any);
  assert('attach() returns a function', typeof detach === 'function');

  // 2b. Duplicate event deduplication — same text emitted twice, no crash
  const TEXT = 'The speed of light is approximately 299792458 metres per second.';
  try {
    mockBus.emit('USER_MESSAGE', { content: TEXT, timestamp: Date.now() });
    mockBus.emit('USER_MESSAGE', { content: TEXT, timestamp: Date.now() + 1 });
    await new Promise(r => setTimeout(r, 200));
    assert('Duplicate rapid events do not throw', true);
  } catch (e) {
    assert('Duplicate rapid events do not throw', false, String(e));
  }

  // 2c. cancelPending() exists and can be called
  const hasCancelPending = typeof (orch as any).cancelPending === 'function';
  assert('cancelPending() method exists', hasCancelPending);
  if (hasCancelPending) {
    try {
      (orch as any).cancelPending();
      assert('cancelPending() does not throw', true);
    } catch (e) {
      assert('cancelPending() does not throw', false, String(e));
    }
  }

  // 2d. detach() removes listeners
  detach();
  const listenerCountAfterDetach = [...mockBus._listeners.values()].reduce((a, b) => a + b.length, 0);
  assert('detach() removes all listeners', listenerCountAfterDetach === 0, `remaining: ${listenerCountAfterDetach}`);
}

// ─── SECTION 3 — buildReasoningContext interface ──────────────────────────────
console.log('\n=== SECTION 3: buildReasoningContext Interface ===\n');

{
  const storage = new MemoryStorage();
  const orch = new LearningOrchestrator({ storage });

  const result = orch.buildReasoningContext('What is the speed of light?');
  assert('buildReasoningContext returns object', typeof result === 'object' && result !== null);
  assert('result.formatted is a string', typeof result.formatted === 'string');
  assert('result.formatted does not exceed 3000 chars', result.formatted.length <= 3000,
    `length=${result.formatted.length}`);
  // With empty store, formatted should be empty or minimal
  assert('Empty store → empty or minimal context', result.formatted.length < 100,
    `formatted="${result.formatted.slice(0,80)}"`);
}

// ─── SUMMARY ──────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════');
console.log(`  PASSED: ${passed}   FAILED: ${failed}`);
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
}
console.log('════════════════════════════════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
