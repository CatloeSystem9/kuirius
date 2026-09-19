/**
 * Phase 14 verification suite — Multimodal Intelligence.
 * Usage: npx tsx scripts/test-multimodal-phase14.ts
 * Exits non-zero on any failure.
 */
import { ScreenObserver } from '../src/agent/vision/screenObserver';
import { FakeCaptureSource, splitFrame, solidFrame } from '../src/agent/vision/fakeCapture';
import { AdaptiveObserver } from '../src/agent/observation/adaptiveObserver';
import type { ScreenState, VisionAnalysis } from '../src/agent/vision/visionTypes';
import type { BrowserState } from '../src/agent/browser/browserTypes';
import { BrowserAgent } from '../src/agent/browser/browserAgent';
import type { BrowserBackend } from '../src/agent/browser/browserTypes';
import { MultimodalContext } from '../src/agent/multimodal/multimodalContext';
import { MultimodalAnalyzer } from '../src/agent/multimodal/multimodalAnalyzer';
import { MultimodalReasoner, classifyQuestion, extractTarget, detectConflicts, computeConfidence, computeUncertainty } from '../src/agent/multimodal/multimodalReasoner';
import { MultimodalVerifier, parseExpectation } from '../src/agent/multimodal/multimodalVerifier';
import { MultimodalService } from '../src/agent/multimodal/multimodalService';
import { MODALITY_REGISTRY, describeModality, isRegisteredModality, effectivePriority } from '../src/agent/multimodal/modalityRegistry';
import { scanSensitivity, chunkDocument, selectRelevantChunks, normalizeModalityInput, contentHash } from '../src/agent/multimodal/modalityNormalizer';
import { AgentEventBus } from '../src/agent/events';
import { ComputerUseAgent } from '../src/agent/computerUse/computerUseAgent';
import { ComputerControlService } from '../src/agent/computer/computerControl';
import { FakeMouseBackend } from '../src/agent/computer/fakeMouse';
import { KeyboardControlService } from '../src/agent/computer/keyboardControl';
import { FakeKeyboardBackend } from '../src/agent/computer/fakeKeyboard';
import type { ApplicationService } from '../src/agent/system/systemServices';
import type { ModalityObservation, MultimodalReasoningProvider } from '../src/agent/multimodal/multimodalTypes';

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

// ----------------------------------------------------------------- fixtures

let screenCounter = 0;
function makeScreenState(opts: {
  title?: string;
  texts?: string[];
  buttons?: string[];
  links?: string[];
  errors?: string[];
  loading?: boolean;
} = {}): ScreenState {
  screenCounter += 1;
  const analysis: VisionAnalysis = {
    provider: 'fake',
    summary: opts.title ?? 'Desktop',
    texts: (opts.texts ?? []).map((text) => ({ text, confidence: 0.9 })),
    elements: [
      ...(opts.buttons ?? []).map((text) => ({ type: 'button' as const, text, confidence: 0.9 })),
      ...(opts.links ?? []).map((text) => ({ type: 'link' as const, text, confidence: 0.9 })),
    ],
    dialogs: [],
    errors: opts.errors ?? [],
    warnings: [],
    loading: opts.loading,
    confidence: 0.85,
  };
  return {
    id: `screen-${screenCounter}`,
    timestamp: Date.now(),
    activeWindow: { available: true, title: opts.title ?? 'Desktop', source: 'display_media_track', surface: 'monitor' },
    size: { width: 1920, height: 1080 },
    signature: { gridW: 4, gridH: 4, blocks: new Array(16).fill(0) },
    analysis,
  };
}

function makeBrowserState(url: string, title: string, headings: string[] = []): BrowserState {
  return {
    available: true,
    page: { url, title, ready: 'complete', links: [], buttons: [], fields: [], headings },
    tabs: [],
    capturedAt: Date.now(),
  };
}

function makeBrowserAgent(page: { url: string; title: string; headings?: string[] }): { agent: BrowserAgent; backend: BrowserBackend; page: { url: string; title: string; ready: 'complete'; links: []; buttons: []; fields: []; headings: string[] } } {
  // BrowserBackend.getState() returns the PAGE state (Phase 8 wire contract).
  const state = {
    url: page.url,
    title: page.title,
    ready: 'complete' as const,
    links: [] as [],
    buttons: [] as [],
    fields: [] as [],
    headings: page.headings ?? [],
  };
  const backend: BrowserBackend = {
    async getState() {
      return { success: true, state, tabs: [] };
    },
    async navigate(url: string) {
      state.url = url;
      return { success: true, url };
    },
    goBack: async () => ({ success: true }),
    goForward: async () => ({ success: true }),
    refresh: async () => ({ success: true }),
    clickText: async () => ({ success: true }),
    typeIntoField: async () => ({ success: true }),
    scrollBy: async () => ({ success: true }),
    listTabs: async () => ({ success: true, tabs: [] }),
  };
  return { agent: new BrowserAgent({ backend }), backend, page: state };
}

function makeAppService(results: Record<string, { running: boolean; pids?: number[] }>): ApplicationService {
  const fake = {
    async status(name: string) {
      const r = results[name];
      if (!r) return { action: 'status', name, verified: false, summary: 'not found' };
      return { action: 'status', name, running: r.running, pids: r.pids ?? [4242], verified: true, summary: `${name} running=${r.running}` };
    },
  };
  return fake as unknown as ApplicationService;
}

function makeAdaptive(frames = [solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame(), solidFrame()]) {
  const captureSource = new FakeCaptureSource(frames);
  const screenObserver = new ScreenObserver({ captureSource });
  const adaptive = new AdaptiveObserver({ screenObserver });
  return { captureSource, screenObserver, adaptive };
}

// ------------------------------------------------------------ modality registry
{
  console.log('Modality registry');
  for (const type of ['text', 'image', 'screenshot', 'ui_state', 'browser_state', 'application_state', 'document', 'audio_transcript', 'tool_result'] as const) {
    assert(isRegisteredModality(type), `modality "${type}" registered`);
  }
  assert(!isRegisteredModality('hologram'), 'unknown modality rejected');
  assertEqual(MODALITY_REGISTRY.tool_result.basePriority, 100, 'fresh tool state is the top-priority source');
  assert(MODALITY_REGISTRY.ui_state.basePriority > MODALITY_REGISTRY.text.basePriority, 'screen observation outranks plain text');
  assert(MODALITY_REGISTRY.audio_transcript.basePriority < MODALITY_REGISTRY.text.basePriority, 'transcripts rank below text (recognition errors)');
  // Freshness: fresh browser evidence outranks stale browser evidence.
  const d = describeModality('browser_state');
  const fresh = effectivePriority(d, 0, 0.8);
  const old = effectivePriority(d, d.ttlMs, 0.8);
  assert(fresh > old, 'fresh evidence outranks stale evidence of the same kind');
  assertEqual(describeModality('screenshot').defaultSensitivity, 'sensitive', 'screenshot default sensitivity is sensitive');
}

// ------------------------------------------------------------- normalization
{
  console.log('Normalization');
  const n = normalizeModalityInput({ type: 'text', text: 'What button should I click?' });
  assertEqual(n.observation.payload.type, 'text', 'text payload type');
  assert(typeof n.observation.metadata['contentHash'] === 'string', 'content hash computed');

  // Secret redaction + sensitivity escalation
  const secret = scanSensitivity('my password=hunter2 and key sk-abcdef1234567890abcd', 'normal');
  assert(secret.flagged, 'secret scanner flags credentials');
  assertEqual(secret.sensitivity, 'highly_sensitive', 'secrets escalate to highly_sensitive');
  assert(!secret.text.includes('hunter2'), 'password value redacted');
  assert(!secret.text.includes('sk-abcdef'), 'api key redacted');
  assert(secret.text.includes('[REDACTED]'), 'redaction marker present');
  const jwt = scanSensitivity('auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c done', 'normal');
  assert(jwt.flagged && !jwt.text.includes('eyJhbGciOiJIUzI1NiJ9'), 'JWT redacted');

  // Screenshot/screen normalization never carries pixels
  const screen = makeScreenState({ title: 'Notepad', texts: ['hello world'], buttons: ['Save'] });
  const ns = normalizeModalityInput({ type: 'ui_state', state: screen });
  assertEqual(ns.observation.payload.type, 'ui_state', 'ui_state payload type');
  assert(!JSON.stringify(ns.observation).includes('Uint8'), 'no pixel structures in observation');
  const kw = ns.observation.metadata['keywords'];
  assert(Array.isArray(kw) && kw.length > 0, 'keywords extracted');

  // Browser URL raw input normalizes to browser_state
  const nb = normalizeModalityInput({ type: 'browser_url', url: 'https://example.com/page' });
  assertEqual(nb.observation.type, 'browser_state', 'browser_url normalizes to browser_state');

  // Tool result confidence: verified vs unverified
  const tv = normalizeModalityInput({ type: 'tool_result', toolName: 'app.launch', output: { ok: 1 }, verified: true });
  const tu = normalizeModalityInput({ type: 'tool_result', toolName: 'app.launch', output: { ok: 1 } });
  assert(tv.observation.confidence > tu.observation.confidence, 'verified tool result is more confident');
  assert(describeModality('tool_result').basePriority > describeModality('ui_state').basePriority, 'tool results outrank screen observations');

  // Unknown modality rejected
  let threw = false;
  try {
    normalizeModalityInput({ type: 'hologram' } as any);
  } catch {
    threw = true;
  }
  assert(threw, 'unregistered modality input rejected');

  // Content hash determinism
  assertEqual(contentHash('abc'), contentHash('abc'), 'content hash deterministic');
}

// ---------------------------------------------------------- document chunking
{
  console.log('Document understanding');
  const words = Array.from({ length: 3000 }, (_, i) => `word${i % 500}`).join(' ');
  const chunks = chunkDocument(words, 1200, 24);
  assert(chunks.length <= 24, `document chunking bounded (${chunks.length} <= 24)`);
  assert(chunks.every((c) => c.text.length <= 1200), 'chunks respect char size');
  const pineChunk = { index: 0, text: 'totally unrelated filler about weather and traffic reports' };
  const target = { index: 1, text: 'The quarterly report discusses revenue growth and pineapple imports across regions' };
  const selected = selectRelevantChunks([pineChunk, target, { index: 2, text: 'more filler text here' }], 'pineapple imports revenue', 1);
  assertEqual(selected[0]?.index, 1, 'relevant-section selection picks the matching chunk');

  // Oversized document: only bounded chunks retained
  const huge = Array.from({ length: 60 }, (_, i) => `chunk${i} ` + 'filler '.repeat(180)).join('\n');
  const limited = chunkDocument(huge, 1200, 24);
  assertEqual(limited.length, 24, 'huge document capped at maxChunks');
}

// -------------------------------------------------------------- multimodal context
{
  console.log('Multimodal context — bounds, dedup, staleness, association');
  const ctx = new MultimodalContext({ maxObservations: 5, maxPerModality: 2, totalCharBudget: 10_000, defaultTtlMs: 1000 });

  const t0 = Date.now();
  const a = ctx.addInput({ type: 'text', text: 'first message' }, t0, 'step-1');
  assertEqual(ctx.stats().total, 1, 'observation stored');

  // Dedup: same content refreshes instead of duplicating
  const dup = ctx.addInput({ type: 'text', text: 'first message' }, t0 + 10);
  assertEqual(ctx.stats().total, 1, 'duplicate content refreshed, not duplicated');
  assertEqual(dup.timestamp, t0 + 10, 'dedup refreshed the timestamp');

  // Per-modality cap: keep newest 2 texts
  ctx.addInput({ type: 'text', text: 'second message' }, t0 + 20, 'step-2');
  // Step associations while both observations are still live
  assert(ctx.forStep('step-1').length >= 1, 'evidence associated with step-1');
  assert(ctx.forStep('step-2').length >= 1, 'evidence associated with step-2');
  assertEqual(ctx.forStep('step-1')[0]?.stepId, 'step-1', 'observation carries its stepId');
  ctx.addInput({ type: 'text', text: 'third message' }, t0 + 30);
  assertEqual(ctx.byType('text', t0 + 31).length, 2, 'per-modality cap enforced (newest kept)');
  assert(ctx.live(t0 + 31).every((o) => o.payload.type !== 'text' || o.payload.text !== 'first message'), 'oldest text evicted');

  // Stale expiry
  const before = ctx.stats(t0 + 2000).total;
  const removed = ctx.removeStale(t0 + 2000);
  assert(removed > 0 || before === 0, 'stale observations expire');
  assertEqual(ctx.stats(t0 + 2000).total, 0, 'all observations expired after TTL');

  // Total count cap
  const tight = new MultimodalContext({ maxObservations: 3, maxPerModality: 10, totalCharBudget: 100_000 });
  for (let i = 0; i < 8; i++) tight.addInput({ type: 'text', text: `message number ${i} with unique words ${i * 7}` }, t0 + i);
  assertEqual(tight.stats().total, 3, 'total count cap enforced');

  // Char budget eviction
  const budgeted = new MultimodalContext({ maxObservations: 50, maxPerModality: 50, totalCharBudget: 600 });
  for (let i = 0; i < 6; i++) budgeted.addInput({ type: 'text', text: `x`.repeat(250) + ` unique${i}` }, t0 + i);
  assert(budgeted.stats().total < 6, 'char budget evicts oldest observations');

  // Task scoping: beginTask clears, endTask purges
  const scoped = new MultimodalContext();
  scoped.beginTask('task-1');
  scoped.addInput({ type: 'text', text: 'task one evidence' });
  assertEqual(scoped.getTaskId(), 'task-1', 'task scope set');
  scoped.beginTask('task-2');
  assertEqual(scoped.stats().total, 0, 'new task starts with fresh context');
  scoped.addInput({ type: 'text', text: 'task two evidence' });
  scoped.endTask();
  assertEqual(scoped.stats().total, 0, 'endTask purges all observations');
  assertEqual(scoped.getTaskId(), null, 'task scope cleared');

  // Provider-safe digest: excludes sensitive content
  const priv = new MultimodalContext();
  priv.addInput({ type: 'text', text: 'public info about the weather' });
  priv.addInput({ type: 'text', text: 'password=supersecret123' });
  const digest = priv.providerSafeDigest();
  assert(digest.includes('weather'), 'digest includes public evidence');
  assert(!digest.includes('supersecret123'), 'digest excludes sensitive evidence');

  // maxSensitivity
  assertEqual(priv.maxSensitivity(), 'highly_sensitive', 'max sensitivity reported for audits');
}

// ------------------------------------------------------- analyzer (Phase 4/13/8/9)
{
  console.log('Analyzer — Phase 13 screen gather (visual integration)');
  const { captureSource, adaptive } = makeAdaptive();
  adaptive.beginTask('mm-task');
  const ctx = new MultimodalContext();
  ctx.beginTask('mm-task');
  const analyzer = new MultimodalAnalyzer({ adaptive });
  const r = await analyzer.gather(ctx, ['ui_state'], { taskId: 'mm-task' });
  assertEqual(r.gathered.includes('ui_state'), true, 'screen evidence gathered through Phase 13');
  const ui = ctx.byType('ui_state');
  assertEqual(ui.length, 1, 'ui_state stored (deduped with screenshot metadata)');
  assertEqual(ctx.byType('screenshot').length, 1, 'screenshot metadata observation stored');
  assert(!JSON.stringify(ui[0]).includes('data:image'), 'no pixel data stored');
  assert(captureSource.captures >= 1, 'capture happened through the Phase 13 layer');

  // Second gather: Phase 13 reuses fresh state (adaptive reuse, no new capture)
  const capturesAfterFirst = captureSource.captures;
  await analyzer.gather(ctx, ['ui_state'], { taskId: 'mm-task' });
  assertEqual(captureSource.captures, capturesAfterFirst, 'Phase 13 reuse prevents duplicate captures');

  // requireFreshScreen forces a fresh capture
  const { captureSource: cs2, adaptive: ad2 } = makeAdaptive();
  ad2.beginTask('mm-task-2');
  const ctx2 = new MultimodalContext();
  ctx2.beginTask('mm-task-2');
  const an2 = new MultimodalAnalyzer({ adaptive: ad2 });
  await an2.gather(ctx2, ['ui_state'], { taskId: 'mm-task-2' });
  const before = cs2.captures;
  await an2.gather(ctx2, ['ui_state'], { taskId: 'mm-task-2', requireFreshScreen: true });
  assert(cs2.captures > before, 'requireFreshScreen forces fresh Phase 13 capture');
}

{
  console.log('Analyzer — browser + application integration');
  const { agent: browserAgent } = makeBrowserAgent({ url: 'https://example.com/login', title: 'Sign in' });
  const ctx = new MultimodalContext();
  const analyzer = new MultimodalAnalyzer({ browserAgent });
  const r = await analyzer.gather(ctx, ['browser_state'], {});
  assertEqual(r.gathered.includes('browser_state'), true, 'browser state gathered from Phase 8 agent');
  const b = ctx.latest('browser_state');
  assert(b && b.payload.type === 'browser_state' && b.payload.url === 'https://example.com/login', 'browser URL stored');

  const appService = makeAppService({ notepad: { running: true, pids: [321] } });
  const analyzer2 = new MultimodalAnalyzer({ applicationService: appService });
  const ok = await analyzer2.gatherApplication(ctx, 'notepad');
  assertEqual(ok, true, 'application status gathered from Phase 9 service');
  const app = ctx.latest('application_state');
  assert(app && app.payload.type === 'application_state' && app.payload.running === true, 'application running state stored');

  // Unverified status reads are NOT recorded (never guess)
  const appService2 = makeAppService({});
  const analyzer3 = new MultimodalAnalyzer({ applicationService: appService2 });
  const ok2 = await analyzer3.gatherApplication(ctx, 'unknown-app');
  assertEqual(ok2, false, 'unverified application status rejected');
}

{
  console.log('Analyzer — text + document (bounded)');
  const ctx = new MultimodalContext();
  const analyzer = new MultimodalAnalyzer({});
  analyzer.addText(ctx, 'Click the Save button');
  assertEqual(ctx.byType('text').length, 1, 'text recorded');
  const longDoc = 'Intro paragraph. '.repeat(60) + 'The configuration section explains settings in detail. '.repeat(60) + 'Ending notes.';
  const doc = analyzer.addDocument(ctx, 'Manual', longDoc, 'configuration section');
  assert(doc.chunks >= 2, `document chunked (${doc.chunks} chunks)`);
  assert(doc.selected >= 1 && doc.selected <= 3, `relevant chunks bounded (${doc.selected})`);
  const docObs = ctx.latest('document');
  assert(docObs && docObs.payload.type === 'document' && docObs.payload.totalChars > 0, 'document metadata stored');
  const retained = analyzer.documentChunks(ctx, docObs!.id).join(' ');
  assert(retained.includes('configuration'), 'retained chunks contain the queried section');
}

// ------------------------------------------------------------------ reasoning
{
  console.log('Question classification + source priority');
  assertEqual(classifyQuestion('Which application is currently active?'), 'active_application', 'active-app question classified');
  assertEqual(classifyQuestion('Find the login button on the current webpage.'), 'find_element', 'find-element question classified');
  assertEqual(classifyQuestion('Verify that the application actually opened.'), 'verify_state', 'verify question classified');
  assertEqual(classifyQuestion('Read this document and summarize the section I asked about.'), 'summarize_document', 'document question classified');
  assertEqual(classifyQuestion('Continue the workflow from the current state.'), 'continue_workflow', 'workflow question classified');
  assertEqual(extractTarget('Find the login button on the page.'), 'login', 'target extracted');

  // Source priority: fresh tool state > fresh screen > stale screen
  const now = Date.now();
  const freshTool = normalizeModalityInput({ type: 'tool_result', toolName: 'app.status', output: { running: true }, verified: true }, undefined, now).observation;
  const freshScreen = normalizeModalityInput({ type: 'ui_state', state: makeScreenState() }, undefined, now).observation;
  const staleScreen = normalizeModalityInput({ type: 'ui_state', state: makeScreenState() }, undefined, now - 29_000).observation;
  const ctx = new MultimodalContext();
  ctx.add(freshTool, 's1');
  ctx.add(freshScreen);
  ctx.add(staleScreen);
  const p = (o: ModalityObservation) => ctx.priorityOf(o, now);
  assert(p(freshTool) > p(freshScreen), 'fresh tool state outranks fresh screen');
  assert(p(freshScreen) > p(staleScreen), 'fresh screen outranks stale screen');
}

{
  console.log('Cross-modal reasoning — active application (app + screen agree)');
  const ctx = new MultimodalContext();
  ctx.addInput({ type: 'application_state', name: 'notepad', running: true, focused: true });
  ctx.addInput({ type: 'ui_state', state: makeScreenState({ title: 'Untitled - Notepad', texts: ['hello'] }) });
  const reasoner = new MultimodalReasoner();
  const conclusion = await reasoner.answer(ctx, { question: 'Which application is currently active?' });
  assert(conclusion.claim.includes('notepad'), 'claim names the focused application');
  assert(conclusion.supporting.length >= 2, 'two modalities support the conclusion');
  assert(conclusion.confidence > 0.5, `confidence reflects multi-source agreement (${conclusion.confidence})`);
  assert(conclusion.uncertainty < 0.5, 'uncertainty reduced by multi-source support');
  assertEqual(conclusion.reasoningSource, 'local', 'deterministic local reasoning');
}

{
  console.log('Cross-modal reasoning — find element (text + screen)');
  const ctx = new MultimodalContext();
  ctx.addInput({ type: 'text', text: 'Click the button I mentioned: the Submit button' });
  ctx.addInput({ type: 'ui_state', state: makeScreenState({ title: 'Form', buttons: ['Cancel', 'Submit'] }) });
  const reasoner = new MultimodalReasoner();
  const conclusion = await reasoner.answer(ctx, { question: 'Where is the submit button on the current screen?' });
  assert(conclusion.supporting.some((s) => s.quote?.toLowerCase().includes('submit')), 'submit button found in screen evidence');

  // Missing element → explicit uncertainty, no fabrication
  const empty = new MultimodalContext();
  empty.addInput({ type: 'ui_state', state: makeScreenState({ title: 'Form', buttons: ['Cancel'] }) });
  const c2 = await reasoner.answer(empty, { question: 'Where is the submit button on the current screen?' });
  assert(c2.supporting.length === 0 || !c2.claim.toLowerCase().includes('submit is visible'), 'no fabricated element');
  assert(c2.uncertainties.length > 0, 'uncertainty declared when evidence missing');
  assertEqual(c2.confidence === 0 || c2.requiresVerification, true, 'no manufactured confidence');
}

{
  console.log('Conflict detection');
  const now = Date.now();

  // Rule 1: browser URL vs screen URL
  const ctx1 = new MultimodalContext();
  ctx1.addInput({ type: 'browser_url', url: 'https://mail.example.com/inbox' }, now);
  ctx1.addInput({ type: 'ui_state', state: makeScreenState({ title: 'Browser', texts: ['welcome to https://shop.other.org/cart'] }) }, now);
  const c1 = detectConflicts(ctx1, now);
  assert(c1.some((c) => c.kind === 'browser_url_mismatch'), 'browser/screen URL mismatch detected');

  // Rule 2: app reported running but absent from screen
  const ctx2 = new MultimodalContext();
  ctx2.addInput({ type: 'application_state', name: 'excel', running: true }, now);
  ctx2.addInput({ type: 'ui_state', state: makeScreenState({ title: 'Untitled - Notepad', texts: ['notes'] }) }, now);
  const c2 = detectConflicts(ctx2, now);
  assert(c2.some((c) => c.kind === 'application_presence_mismatch'), 'application presence mismatch detected');

  // Rule 4: text mentions a different URL than the browser reports
  const ctx4 = new MultimodalContext();
  ctx4.addInput({ type: 'text', text: 'please open https://docs.mysite.org/setup' }, now);
  ctx4.addInput({ type: 'browser_url', url: 'https://mail.example.com/inbox' }, now);
  const c4 = detectConflicts(ctx4, now);
  assert(c4.some((c) => c.kind === 'text_vs_evidence_mismatch'), 'text vs browser URL mismatch detected');

  // No conflicts when evidence agrees
  const ctxOk = new MultimodalContext();
  ctxOk.addInput({ type: 'browser_url', url: 'https://example.com/login' }, now);
  ctxOk.addInput({ type: 'ui_state', state: makeScreenState({ title: 'Sign in — example.com', texts: ['Login form'] }) }, now);
  assertEqual(detectConflicts(ctxOk, now).length, 0, 'consistent evidence produces no conflicts');
}

{
  console.log('Reasoner conflict integration — conflicting evidence lowers confidence');
  const now = Date.now();
  const ctx = new MultimodalContext();
  ctx.addInput({ type: 'application_state', name: 'excel', running: true }, now);
  ctx.addInput({ type: 'ui_state', state: makeScreenState({ title: 'Untitled - Notepad', texts: ['notes'] }) }, now);
  const reasoner = new MultimodalReasoner();
  const conclusion = await reasoner.answer(ctx, { question: 'Verify that the application actually opened.' });
  assert(conclusion.conflicts.length > 0, 'conflicts surfaced in the conclusion');
  assert(conclusion.requiresVerification, 'conflicting evidence requires verification');
  assert(conclusion.requiredVerification.length > 0, 'required verification steps listed');
  assert(conclusion.uncertainties.some((u) => u.reason.includes('conflict')), 'uncertainty explains the conflict');
}

{
  console.log('Confidence math');
  const refs = [
    { observationId: 'a', type: 'ui_state' as const, aspect: 'x', confidence: 0.9 },
    { observationId: 'b', type: 'application_state' as const, aspect: 'y', confidence: 0.95 },
  ];
  const multi = computeConfidence(refs, 0, 0);
  const single = computeConfidence([refs[0]], 0, 0);
  const conflicted = computeConfidence(refs, 2, 0);
  assert(multi > single, 'multi-source confidence exceeds single-source');
  assertEqual(single <= 0.6, true, 'single-source claim capped');
  assert(conflicted < multi, 'conflicts reduce confidence');
  assertEqual(computeConfidence([], 0, 0), 0, 'no evidence → zero confidence');
  assertEqual(computeUncertainty('question', [], 0) > computeUncertainty('question', refs, 0), true, 'missing evidence raises uncertainty');
  assertEqual(computeUncertainty('q', refs, 0) < computeUncertainty('q', refs, 2), true, 'conflicts raise uncertainty');
}

// -------------------------------------------------------------- verification
{
  console.log('Multimodal verification — independent evidence');
  const verifier = new MultimodalVerifier();

  // Confirmed: app state + screen agree (2 independent modalities)
  const ctx1 = new MultimodalContext();
  ctx1.addInput({ type: 'application_state', name: 'notepad', running: true, pids: [99] });
  ctx1.addInput({ type: 'ui_state', state: makeScreenState({ title: 'Untitled - Notepad', texts: ['hello world'] }) });
  const v1 = await verifier.verify(ctx1, { expected: 'Notepad is open.' });
  assertEqual(v1.verdict, 'confirmed', 'app_open confirmed by two modalities');
  assertEqual(v1.independentEvidence, true, 'independent evidence flag set');
  assert(v1.confidence > 0.6, 'confirmed confidence high');

  // Refuted: process not running contradicts "open"
  const ctx2 = new MultimodalContext();
  ctx2.addInput({ type: 'application_state', name: 'calc', running: false });
  const v2 = await verifier.verify(ctx2, { expected: 'calc is open' });
  assertEqual(v2.verdict, 'refuted', 'contradiction refutes the expectation');

  // Uncertain: single weak source
  const ctx3 = new MultimodalContext();
  ctx3.addInput({ type: 'ui_state', state: makeScreenState({ title: 'Some window', texts: ['random'] }) });
  const v3 = await verifier.verify(ctx3, { expected: 'Notepad is open.' });
  assertEqual(v3.verdict, 'uncertain', 'single non-tool source → uncertain');
  assert(v3.requiredVerification.some((s) => s.toLowerCase().includes('screen') || s.toLowerCase().includes('application')), 'required verification listed for uncertain verdict');

  // Text present: screen + browser agree
  const ctx4 = new MultimodalContext();
  ctx4.addInput({ type: 'ui_state', state: makeScreenState({ title: 'Docs', texts: ['The requested text appeared'] }) });
  ctx4.addInput({ type: 'browser_url', url: 'https://example.com/doc', title: 'The requested text appeared — doc' });
  const v4 = await verifier.verify(ctx4, { expected: 'text "The requested text appeared" is visible' });
  assertEqual(v4.verdict, 'confirmed', 'text-present confirmed by screen + browser');
  assertEqual(v4.independentEvidence, true, 'screen+browser are independent sources');

  // Strong single tool result confirms
  const ctx5 = new MultimodalContext();
  ctx5.addInput({ type: 'tool_result', toolName: 'app.launch', output: { running: true }, verified: true });
  const v5 = await verifier.verify(ctx5, { expected: 'app is open' });
  assertEqual(v5.verdict, 'confirmed', 'single verified tool result can confirm');

  // Expectation parsing
  assertEqual(parseExpectation('Notepad is open.').kind, 'app_open', 'app_open parsed');
  assertEqual(parseExpectation('https://example.com/page loaded').kind, 'url', 'url expectation parsed');
  assertEqual(parseExpectation('text "hello world" is visible').kind, 'text_present', 'text_present parsed');
  assertEqual(parseExpectation('calc is closed').kind, 'app_closed', 'app_closed parsed');

  // Cancellation
  const controller = new AbortController();
  controller.abort();
  const vc = await verifier.verify(new MultimodalContext(), { expected: 'x is open', signal: controller.signal });
  assertEqual(vc.verdict, 'uncertain', 'cancelled verification is structured, not a crash');
  assert(vc.reasoning.some((r) => r.includes('cancelled')), 'cancellation noted in reasoning');
}

// -------------------------------------------------------- service facade + bus
{
  console.log('MultimodalService — task lifecycle + tool evidence via bus');
  const bus = new AgentEventBus();
  const { adaptive } = makeAdaptive();
  const { agent: browserAgent } = makeBrowserAgent({ url: 'https://example.com', title: 'Example' });
  const service = new MultimodalService({ adaptive, browserAgent });
  const detach = service.attach(bus);

  bus.emit({ name: 'TASK_STARTED', taskId: 'svc-task', timestamp: Date.now() });
  assertEqual(service.context.getTaskId(), 'svc-task', 'TASK_STARTED opens the context scope');

  bus.emit({ name: 'TOOL_COMPLETED', taskId: 'svc-task', stepId: 'st1', payload: { tool: 'app.launch', verified: true, outputSummary: JSON.stringify({ running: true }) }, timestamp: Date.now() });
  const toolObs = service.context.byType('tool_result');
  assertEqual(toolObs.length, 1, 'TOOL_COMPLETED recorded as evidence');
  assertEqual(toolObs[0].stepId, 'st1', 'evidence associated with the step');
  assertEqual(toolObs[0].sensitivity, 'normal', 'tool result sensitivity defaulted');

  bus.emit({ name: 'TOOL_FAILED', taskId: 'svc-task', payload: { tool: 'fs.delete', error: 'denied' }, timestamp: Date.now() });
  const failedObs = service.context.byType('tool_result');
  assert(failedObs.some((o) => o.payload.type === 'tool_result' && o.payload.verified === false), 'TOOL_FAILED recorded as unverified');

  bus.emit({ name: 'TASK_COMPLETED', taskId: 'svc-task', timestamp: Date.now() });
  assertEqual(service.context.stats().total, 0, 'task end purges the multimodal context');
  detach();
}

{
  console.log('Computer-Use integration — CU observations become multimodal evidence');
  const { adaptive, captureSource } = makeAdaptive();
  adaptive.beginTask('cu-mm');
  const ctx = new MultimodalContext();
  ctx.beginTask('cu-mm');
  const bus = new AgentEventBus();
  const mouse = new ComputerControlService({ backend: new FakeMouseBackend() });
  const keyboard = new KeyboardControlService({ backend: new FakeKeyboardBackend() });
  const cu = new ComputerUseAgent({ observer: adaptive['screenObserver' as keyof AdaptiveObserver] as any, adaptive, mouse, keyboard, events: bus });
  cu.setMultimodal({ recordObservation: (state) => ctx.addInput({ type: 'ui_state', state, source: 'phase7.computerUse' }) });
  const result = await cu.run('move the cursor to 100, 120 then move the cursor to 40, 50');
  assertEqual(result.status, 'completed', 'CU run completed');
  assert(ctx.byType('ui_state').length >= 1, 'CU observations recorded as ui_state evidence');
  assert(ctx.byType('ui_state').every((o) => o.source === 'phase7.computerUse'), 'CU evidence provenance recorded');
  assert(captureSource.captures >= 1, 'CU still uses Phase 13 adaptive observation');
}

// ------------------------------------------------------- provider abstraction
{
  console.log('Provider abstraction — enrichment, timeout, cancellation');
  // An EMPTY context leaves the local answer with no evidence → the provider
  // enrichment path (uncertainty >= 0.65 / no support) is exercised.
  const ctx = new MultimodalContext();
  const reasoner = new MultimodalReasoner();

  const provider: MultimodalReasoningProvider = {
    id: 'fake-provider',
    async reason(input) {
      assertEqual(typeof input.boundedContext, 'string', 'provider receives a bounded digest');
      return { ...input.conclusion, claim: 'Provider-enriched answer: the visible window is a text editor.', confidence: 0.8, reasoningSource: 'provider' };
    },
  };
  reasoner.setProvider(provider);
  const enriched = await reasoner.answer(ctx, { question: 'What is shown on the screen right now?' });
  assertEqual(enriched.provider, 'fake-provider', 'provider enriched the low-confidence answer');
  assertEqual(enriched.reasoningSource, 'provider', 'reasoning source reported');
  assert(enriched.claim.includes('Provider-enriched'), 'provider claim surfaced');

  // Provider that never resolves → local result stands after timeout
  const slowProvider: MultimodalReasoningProvider = {
    id: 'slow',
    reason: () => new Promise(() => undefined),
  };
  reasoner.setProvider(slowProvider);
  const started = Date.now();
  const local = await reasoner.answer(ctx, { question: 'What is shown on the screen right now?' }, { providerTimeoutMs: 80 });
  assert(Date.now() - started < 3_000, 'provider timeout bounded');
  assertEqual(local.reasoningSource, 'local', 'local result stands when provider times out');

  // Cancellation skips the provider
  const controller = new AbortController();
  controller.abort();
  let providerCalled = false;
  const countingProvider: MultimodalReasoningProvider = {
    id: 'counting',
    reason: async () => {
      providerCalled = true;
      return null;
    },
  };
  reasoner.setProvider(countingProvider);
  await reasoner.answer(ctx, { question: 'q', signal: controller.signal });
  assertEqual(providerCalled, false, 'aborted question skips the provider');

  // No provider set → still works fully locally (with evidence present)
  reasoner.setProvider(null);
  assertEqual(reasoner.getProvider(), null, 'provider removable');
  const evidenceCtx = new MultimodalContext();
  evidenceCtx.addInput({ type: 'application_state', name: 'notepad', running: true, focused: true });
  const localOnly = await reasoner.answer(evidenceCtx, { question: 'Which application is currently active?' });
  assertEqual(localOnly.reasoningSource, 'local', 'system works without any external provider');
}

// ------------------------------------------------------------------- privacy
{
  console.log('Privacy — no pixel persistence, sensitivity gating, secret rejection');
  const ctx = new MultimodalContext();
  const { observation } = normalizeModalityInput({ type: 'screenshot', state: makeScreenState() });
  const serialized = JSON.stringify(observation);
  assert(!serialized.includes('data:image') && !serialized.includes('base64'), 'screenshot observation stores no image data');

  ctx.addInput({ type: 'audio_transcript', transcript: 'my password is hunter2 and the api key sk-abcdefghijklmn12' });
  const transcript = ctx.byType('audio_transcript')[0];
  assertEqual(transcript.sensitivity, 'highly_sensitive', 'sensitive transcript escalated');
  assert(!JSON.stringify(transcript).includes('hunter2'), 'secret never persisted in payload');
  assertEqual(ctx.providerSafeDigest().includes('transcript'), false, 'sensitive evidence excluded from provider digest');

  // Clipboard-like credential text in tool output
  ctx.addInput({ type: 'tool_result', toolName: 'clipboard.read', output: { content: 'token: ghp_abcdefghijklmnopqrstuvwxyz123456' } });
  const toolObs = ctx.byType('tool_result').find((o) => o.payload.type === 'tool_result' && o.payload.toolName === 'clipboard.read');
  assert(toolObs !== undefined, 'tool result recorded');
  assert(!JSON.stringify(toolObs).includes('ghp_abcdefghij'), 'github token redacted from tool output');
  assertEqual(toolObs!.sensitivity, 'highly_sensitive', 'credential-bearing tool result escalated');
}

// ------------------------------------------------------- resource discipline
{
  console.log('Resource discipline — no polling, lazy gathering');
  const { captureSource, adaptive } = makeAdaptive();
  adaptive.beginTask('idle-mm');
  const ctx = new MultimodalContext();
  ctx.beginTask('idle-mm');
  const analyzer = new MultimodalAnalyzer({ adaptive });
  await new Promise((r) => setTimeout(r, 150));
  assertEqual(captureSource.captures, 0, 'no background captures without explicit gather');
  assertEqual(ctx.stats().total, 0, 'context stays empty without explicit gathering');

  // Selective gathering: only requested modalities touched
  const { agent: browserAgent } = makeBrowserAgent({ url: 'https://x.test', title: 'X' });
  const capturesBefore = captureSource.captures;
  const analyzer2 = new MultimodalAnalyzer({ adaptive, browserAgent });
  await analyzer2.gather(ctx, ['browser_state'], { taskId: 'idle-mm' });
  assertEqual(captureSource.captures, capturesBefore, 'browser gather does NOT capture the screen');
  assertEqual(ctx.byType('browser_state').length, 1, 'only the requested modality stored');
}

// ------------------------------------------------------------- timeout/cancel
{
  console.log('Analyzer — gather timeout + cancellation');
  const hanging = {
    async observe() {
      return new Promise<any>(() => undefined);
    },
  };
  const ctx = new MultimodalContext();
  const analyzer = new MultimodalAnalyzer({ adaptive: hanging as any });
  const r = await analyzer.gather(ctx, ['ui_state'], { timeoutMs: 60 });
  assertEqual(r.gathered.length, 0, 'timeout captured as structured failure');
  assert(r.failed.length === 1 && r.failed[0].error.includes('timed out'), 'timeout reported per-kind');

  const controller = new AbortController();
  controller.abort();
  const rc = await analyzer.gather(ctx, ['ui_state'], { signal: controller.signal });
  assertEqual(rc.gathered.length, 0, 'aborted gather performs no work');
}

console.log(`\nPhase 14 results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PHASE 14 TESTS: ALL GREEN');
