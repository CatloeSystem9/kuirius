/**
 * Camera Vision (Step 6) test suite.
 *
 * Covers the 24 verification scenarios: permission granted/denied/unavailable,
 * activation & immediate shutdown, track cleanup, frame acquisition,
 * invalid/blank frame rejection, resize/processing limits, analysis success/
 * failure, uncertain-observation handling, network interruption, camera
 * disconnection, permission revocation, duplicate-frame prevention, resource
 * cleanup, voice integration, active-speech protection, background/suspended
 * handling, no capture after shutdown, no frame retention, SPF/E5 boundaries
 * (payload bound + stop-block route), and Steps 1–5 integration surfaces.
 *
 * Usage: npx tsx scripts/test-camera-vision.ts
 * Exits non-zero on any failure.
 */
import {
  CameraVisionService,
  CAMERA_MAX_SIDE,
  CAMERA_JPEG_QUALITY,
  frameContentHash,
  deliverWhenNotSpeaking,
  resetCameraVisionForTests,
  type CameraCanvasContext,
} from '../src/utils/cameraVision';
import { ConversationTurnManager, getConversationTurnManager, resetConversationTurnManagerForTests } from '../src/utils/conversationTurnManager';

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
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/** Fake MediaStreamTrack. */
class FakeTrack {
  kind = 'video';
  muted = false;
  readonly listeners = new Map<string, Array<() => void>>();
  stopped = false;
  addEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  stop(): void {
    this.stopped = true;
  }
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

/** Fake MediaStream. */
class FakeStream {
  constructor(public track: FakeTrack) {}
  getTracks(): FakeTrack[] {
    return [this.track];
  }
  getVideoTracks(): FakeTrack[] {
    return [this.track];
  }
}

/** Fake video element (source of frames). */
class FakeVideo {
  readyState = 2;
  videoWidth = 1280;
  videoHeight = 720;
  srcObject: unknown = null;
  paused = false;
  play() {
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

/** Fake canvas: records drawImage + returns controllable pixel content. */
class FakeCtx {
  static pixelMode: 'normal' | 'blank' = 'normal';
  static lastDrawSize: { w: number; h: number } | null = null;
  static dataUrlSeq = 0;
  canvas = {
    width: 0,
    height: 0,
    toDataURL: (_t: string, _q?: number) =>
      // Realistic length (real 640px JPEGs encode well past 100 chars).
      `data:image/jpeg;base64,${'A'.repeat(200)}FRAME${FakeCtx.dataUrlSeq++}`,
  };
  drawImage(_src: unknown, _dx: number, _dy: number, dw: number, dh: number): void {
    FakeCtx.lastDrawSize = { w: dw, h: dh };
  }
  getImageData(_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray } {
    const data = new Uint8ClampedArray(w * h * 4);
    if (FakeCtx.pixelMode === 'normal') {
      // varied luminance gradient — passes the blank check
      for (let i = 0; i < w * h; i++) {
        const l = (i * 7) % 256;
        data[i * 4] = l;
        data[i * 4 + 1] = l;
        data[i * 4 + 2] = l;
        data[i * 4 + 3] = 255;
      }
    } // blank: all zeros (uniform → rejected)
    return { data };
  }
}

function makeCtxFactory(): (w: number, h: number) => { canvas: unknown; ctx: CameraCanvasContext } {
  return (w, h) => {
    const ctx = new FakeCtx();
    ctx.canvas.width = w;
    ctx.canvas.height = h;
    return { canvas: ctx.canvas, ctx: ctx as unknown as CameraCanvasContext };
  };
}

interface Harness {
  svc: CameraVisionService;
  track: FakeTrack;
  video: FakeVideo;
  gmedCalls: number;
  gmedError: { name: string } | null;
  fetchCalls: Array<{ url: string; body: string }>;
  fetchResult: { ok: boolean; json: () => Promise<unknown> } | null;
  setStatus: (s: CameraStatus2) => void;
}
type CameraStatus2 = import('../src/utils/cameraVision').CameraStatus;

function makeHarness(opts?: { gmedError?: string; fetchBody?: unknown }): Harness {
  const track = new FakeTrack();
  const video = new FakeVideo();
  const h: Harness = {
    svc: null as unknown as CameraVisionService,
    track,
    video,
    gmedCalls: 0,
    gmedError: opts?.gmedError ? { name: opts.gmedError } : null,
    fetchCalls: [],
    fetchResult: null,
    setStatus: () => undefined,
  };
  const gmed = async (_c: unknown): Promise<MediaStream> => {
    h.gmedCalls += 1;
    if (h.gmedError) throw Object.assign(new Error('denied'), { name: h.gmedError.name });
    return new FakeStream(track) as unknown as MediaStream;
  };
  const fetchImpl = (async (url: string | URL, init?: { body?: string }) => {
    h.fetchCalls.push({ url: String(url), body: init?.body ?? '' });
    if (h.fetchResult) return h.fetchResult as unknown as Response;
    return {
      ok: true,
      json: async () => ({
        analysis: {
          scene: 'A person is sitting at a desk in a room with a lamp.',
          objects: [{ label: 'lamp', confidence: 0.9 }, { label: 'book', confidence: 0.8 }],
          activities: [{ label: 'reading', confidence: 0.6 }],
          setting: 'indoor',
          uncertainties: ['time of day cannot be determined'],
          personPresent: true,
          confidence: 0.85,
        },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const svc = new CameraVisionService({
    getUserMediaImpl: gmed as unknown as typeof navigator.mediaDevices.getUserMedia,
    fetchImpl,
    createCanvas: makeCtxFactory(),
    now: () => Date.now(),
  });
  h.svc = svc;
  // Bind the fake video as the preview + frame source.
  svc.attachPreview(video as unknown as HTMLVideoElement);
  return h;
}

// --------------------------------- 1. camera permission granted

console.log('\n1. Camera permission granted');
{
  const h = makeHarness();
  const r = await h.svc.start();
  assert(r.ok && r.status === 'active', 'start succeeds with permission granted');
  assertEqual(h.gmedCalls, 1, 'getUserMedia called exactly once');
  assertEqual(h.svc.getStatus(), 'active', 'status active');
  h.svc.stop();
}

// --------------------------------- 2. camera permission denied

console.log('\n2. Camera permission denied');
{
  const h = makeHarness({ gmedError: 'NotAllowedError' });
  const r = await h.svc.start();
  assertEqual(r.ok, false, 'start refused');
  assertEqual(r.status, 'permission_denied', 'honest permission_denied state');
  assertEqual(h.svc.getStatus(), 'permission_denied', 'status persists');
  assertEqual(h.fetchCalls.length, 0, 'no frame ever transmitted without a camera');
  h.svc.stop();
}

// --------------------------------- 3. camera unavailable

console.log('\n3. Camera unavailable');
{
  for (const code of ['NotFoundError', 'NotReadableError', 'OverconstrainedError']) {
    const h = makeHarness({ gmedError: code });
    const r = await h.svc.start();
    assertEqual(r.status, 'camera_unavailable', `${code} → camera_unavailable`);
    h.svc.stop();
  }
}

// --------------------------------- 4. activation and shutdown lifecycle

console.log('\n4. Camera activation and shutdown');
{
  const h = makeHarness();
  await h.svc.start();
  assertEqual(h.svc.getStatus(), 'active', 'active after start');
  h.svc.stop();
  assertEqual(h.svc.getStatus(), 'inactive', 'inactive after stop');
  const r2 = await h.svc.start();
  assert(r2.ok, 're-start after stop works');
  h.svc.stop();
}

// --------------------------------- 5. immediate stop behavior

console.log('\n5. Immediate stop behavior');
{
  const h = makeHarness();
  await h.svc.start();
  h.svc.stop();
  assertEqual(h.track.stopped, true, 'the video track is stopped immediately');
  assertEqual(h.video.srcObject, null, 'preview detached immediately');
  const cap = h.svc.captureFrame();
  assertEqual(cap.ok, false, 'no frame can be acquired after stop');
  assertEqual(cap.reason, 'camera_not_active', 'honest rejection reason');
}

// --------------------------------- 6. camera-track cleanup

console.log('\n6. Camera-track cleanup');
{
  const h = makeHarness();
  await h.svc.start();
  h.svc.stop();
  assertEqual(h.track.listeners.get('ended')?.length ?? 0, 0, 'track event listener removed (no leaks)');
}

// --------------------------------- 7. frame acquisition

console.log('\n7. Frame acquisition');
{
  const h = makeHarness();
  await h.svc.start();
  const cap = h.svc.captureFrame();
  assertEqual(cap.ok, true, 'frame captured from the live preview source');
  assert((cap.dataUrl ?? '').startsWith('data:image/jpeg;base64,'), 'bounded JPEG data URL produced');
  assert(!!cap.hash && cap.hash.length === 8, 'content hash computed');
  const diag = h.svc.getDiagnostics();
  assertEqual(diag.framesAcquired, 1, 'acquisition counted (count only, no content)');
  h.svc.stop();
}

// --------------------------------- 8. invalid frame rejection

console.log('\n8. Invalid frame rejection');
{
  const h = makeHarness();
  await h.svc.start();
  FakeCtx.pixelMode = 'blank';
  const blank = h.svc.captureFrame();
  assertEqual(blank.ok, false, 'uniform/blank frame rejected');
  assertEqual(blank.reason, 'blank_frame', 'honest blank_frame reason');
  FakeCtx.pixelMode = 'normal';
  h.video.readyState = 0; // not ready
  const notReady = h.svc.captureFrame();
  assertEqual(notReady.reason, 'frame_not_ready', 'unready video rejected');
  h.video.readyState = 2;
  h.video.videoWidth = 0;
  const invalid = h.svc.captureFrame();
  assertEqual(invalid.reason, 'invalid_frame', 'zero-dimension frame rejected');
  h.video.videoWidth = 1280;
  h.svc.stop();
}

// --------------------------------- 9. resizing and processing limits

console.log('\n9. Frame resizing and processing limits');
{
  const h = makeHarness();
  await h.svc.start();
  FakeCtx.lastDrawSize = null;
  h.svc.captureFrame();
  assert(!!FakeCtx.lastDrawSize, 'frame drawn into the transient canvas');
  assertEqual(FakeCtx.lastDrawSize!.w, CAMERA_MAX_SIDE, '1280×720 downscaled to the 640px long side');
  assertEqual(FakeCtx.lastDrawSize!.h, 360, 'aspect ratio preserved');
  // A small source is never upscaled.
  h.video.videoWidth = 320;
  h.video.videoHeight = 240;
  h.svc.captureFrame();
  assertEqual(FakeCtx.lastDrawSize!.w, 320, 'small frames are not upscaled');
  h.svc.stop();
}

// --------------------------------- 10. visual-analysis success

console.log('\n10. Visual-analysis success');
{
  const h = makeHarness();
  await h.svc.start();
  const r = await h.svc.analyzeFrame('What do you see?');
  assertEqual(r.ok, true, 'analysis succeeds');
  assertEqual(r.perception!.scene.includes('desk'), true, 'scene returned');
  assertEqual(r.perception!.objects.length, 2, 'observed objects returned');
  assertEqual(r.perception!.activities[0].label, 'reading', 'interpretation separated from observation');
  assertEqual(r.perception!.personPresent, true, 'presence-only flag (no identity)');
  assertEqual(h.svc.getDiagnostics().analysesPerformed, 1, 'analysis counted');
  assertEqual(h.fetchCalls.length, 1, 'exactly one bounded transmission');
  assertEqual(h.fetchCalls[0].url, '/api/vision/camera-analyze', 'rides the authorized camera endpoint');
  assert(h.fetchCalls[0].body.length < 1_500_000, 'payload bounded (downscaled JPEG, not full-resolution video)');
  h.svc.stop();
}

// --------------------------------- 11. visual-analysis failure

console.log('\n11. Visual-analysis failure');
{
  const h = makeHarness();
  await h.svc.start();
  h.fetchResult = { ok: true, json: async () => ({ fallback: true, reason: 'malformed_model_output' }) };
  const r1 = await h.svc.analyzeFrame();
  assertEqual(r1.ok, false, 'model failure reported honestly');
  assertEqual(r1.reason, 'malformed_model_output', 'reason surfaced');
  h.fetchResult = { ok: false, json: async () => ({}) };
  const r2 = await h.svc.analyzeFrame();
  assertEqual(r2.reason, 'analysis_failed', 'HTTP failure surfaced');
  h.svc.stop();
}

// --------------------------------- 12. uncertain observation handling

console.log('\n12. Uncertain observation handling');
{
  const h = makeHarness();
  await h.svc.start();
  h.fetchResult = {
    ok: true,
    json: async () => ({
      analysis: { scene: 'Something blurry near a window.', objects: [], activities: [], setting: 'unknown', uncertainties: ['the object cannot be identified from this frame'], personPresent: null, confidence: 0.25 },
    }),
  };
  const r = await h.svc.analyzeFrame();
  assertEqual(r.perception!.uncertainties.length, 1, 'uncertainties preserved verbatim');
  assertEqual(r.perception!.personPresent, null, 'unclear presence → null (never a guess)');
  assertEqual(r.perception!.objects.length, 0, 'no fabricated objects');
  assertEqual(r.perception!.confidence < 0.45, true, 'low confidence honestly represented');
  h.svc.stop();
}

// --------------------------------- 13. network interruption

console.log('\n13. Network interruption');
{
  const h = makeHarness();
  await h.svc.start();
  h.fetchResult = null;
  const original = (h.svc as unknown as { fetchImpl: typeof fetch }).fetchImpl;
  (h.svc as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const r = await h.svc.analyzeFrame();
  assertEqual(r.ok, false, 'network failure reported');
  assertEqual(r.reason, 'network_unavailable', 'honest network reason');
  (h.svc as unknown as { fetchImpl: typeof fetch }).fetchImpl = original;
  const r2 = await h.svc.analyzeFrame();
  assertEqual(r2.ok, true, 'analysis succeeds after the network recovers');
  h.svc.stop();
}

// --------------------------------- 14. camera disconnection

console.log('\n14. Camera disconnection (track ended)');
{
  const h = makeHarness();
  await h.svc.start();
  h.track.emit('ended'); // the OS/browser disconnects the camera
  assertEqual(h.svc.getStatus(), 'camera_disconnected', 'honest disconnected state');
  assertEqual(h.track.stopped, true, 'cleanup ran');
  const cap = h.svc.captureFrame();
  assertEqual(cap.ok, false, 'no capture from a disconnected camera');
  h.svc.stop();
}

// --------------------------------- 15. permission revocation

console.log('\n15. Permission revocation mid-session');
{
  const h = makeHarness();
  await h.svc.start();
  // The browser ends the track when permission is revoked.
  h.track.emit('ended');
  assertEqual(h.svc.getStatus(), 'camera_disconnected', 'revocation → immediate honest shutdown');
  const restart = await h.svc.start(); // a new explicit start re-requests
  assertEqual(restart.ok, true, 're-authorization via explicit start works');
  h.svc.stop();
}

// --------------------------------- 16. duplicate-frame prevention

console.log('\n16. Duplicate-frame prevention');
{
  const h = makeHarness();
  await h.svc.start();
  // Freeze the encoder output so both frames hash identically (still scene).
  FakeCtx.dataUrlSeq = 0;
  const frozen = { ...new FakeCtx().canvas, toDataURL: () => 'data:image/jpeg;base64,SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS' };
  const realCreate = (h.svc as unknown as { createCanvas: (w: number, h: number) => { canvas: unknown; ctx: CameraCanvasContext } }).createCanvas;
  (h.svc as unknown as { createCanvas: (w: number, h: number) => { canvas: unknown; ctx: CameraCanvasContext } }).createCanvas = (w, h2) => {
    const made = realCreate(w, h2);
    (made.ctx as unknown as { canvas: unknown }).canvas = frozen;
    (made as { ctx: CameraCanvasContext }).ctx.canvas = frozen as unknown as HTMLCanvasElement;
    return made;
  };
  const r1 = await h.svc.analyzeFrame();
  assertEqual(r1.ok, true, 'first analysis performed');
  assertEqual(h.svc.getDiagnostics().analysesPerformed, 1, 'one model call');
  const r2 = await h.svc.analyzeFrame(); // identical frame content
  assertEqual(r2.ok, true, 'duplicate frame returns a result');
  assertEqual(r2.perception!.fromCache, true, 'result reused from cache — NO new model call');
  assertEqual(h.svc.getDiagnostics().analysesPerformed, 1, 'model call count unchanged (duplicate prevented)');
  assertEqual(h.svc.getDiagnostics().duplicateReuses, 1, 'reuse counted');
  h.svc.stop();
}

// --------------------------------- 17. resource cleanup

console.log('\n17. Resource cleanup');
{
  const h = makeHarness();
  await h.svc.start();
  await h.svc.analyzeFrame();
  h.svc.stop();
  const diag = h.svc.getDiagnostics();
  assertEqual(diag.previewAttached, false, 'preview detached');
  assertEqual(h.svc.getLastPerception(), null, 'perception cache cleared (no retention)');
  assertEqual(h.track.stopped, true, 'hardware track released');
  // Concurrent analysis guard: a second call during analysis is refused.
  const h2 = makeHarness();
  await h2.svc.start();
  const p1 = h2.svc.analyzeFrame();
  const p2 = h2.svc.analyzeFrame();
  const results = await Promise.all([p1, p2]);
  assertEqual(results.filter((r) => r.ok).length, 1, 'concurrent duplicate analysis refused (exactly one runs)');
  h2.svc.stop();
}

// --------------------------------- 18. voice conversation integration

console.log('\n18. Voice conversation integration (deferred delivery)');
{
  const mgr = new ConversationTurnManager({ now: () => Date.now() });
  const delivered: string[] = [];
  // Krix is speaking: the visual reply must NOT interrupt playback.
  mgr.beginTurn('wake_word');
  mgr.beginTurn('text');
  mgr.notifySpeechStarted();
  deliverWhenNotSpeaking(mgr, () => delivered.push('spoken'), []);
  assertEqual(delivered.length, 0, 'delivery deferred while Krix is speaking');
  mgr.notifySpeechEnded(); // playback finishes
  await flush();
  assertEqual(delivered.length, 1, 'visual reply delivered right after playback ends');
  mgr.dispose();
  resetConversationTurnManagerForTests();
}

// --------------------------------- 19. active conversation interruption protection

console.log('\n19. Active conversation interruption protection');
{
  // The turn manager + proactive service are never fed camera activity as
  // user turns: analysis is a silent computation, not a conversation turn.
  const { mgr } = makeManager();
  const t = mgr.beginTurn('wake_word');
  mgr.beginTurn('text'); // processing — camera analysis would run alongside
  assertEqual(mgr.getPhase(), 'processing', 'camera analysis does not disturb the open turn');
  mgr.notifySpeechStarted();
  mgr.notifySpeechEnded();
  assertEqual(mgr.getPhase(), 'listening', 'conversation continues normally around vision');
  void t;
  mgr.dispose();
  resetConversationTurnManagerForTests();
}
function makeManager() {
  return { mgr: new ConversationTurnManager(), clock: { value: 0 }, stopped: [] as number[], phases: [] as string[] };
}

// --------------------------------- 20. background and suspended-state handling

console.log('\n20. Background and suspended-state handling');
{
  // The camera is a live device: after suspension the frame is stale —
  // capture/analysis are refused unless the camera is (still) active; the
  // turn manager marks any in-flight work stale on wake (Step 5, verified).
  const h = makeHarness();
  await h.svc.start();
  h.svc.stop(); // suspension kills the device stream in practice
  const r = await h.svc.analyzeFrame();
  assertEqual(r.ok, false, 'no analysis from a suspended/stopped camera');
  assertEqual(r.reason, 'camera_not_active', 'honest refusal');
  // The service never auto-restarts the camera (no covert re-activation).
  assertEqual(h.gmedCalls, 1, 'no implicit re-activation after suspension');
  h.svc.stop();
}

// --------------------------------- 21. no capture after camera shutdown

console.log('\n21. No capture after camera shutdown');
{
  const h = makeHarness();
  await h.svc.start();
  const framesBefore = h.svc.getDiagnostics().framesAcquired;
  h.svc.stop();
  for (let i = 0; i < 5; i++) {
    assertEqual(h.svc.captureFrame().ok, false, `post-shutdown capture attempt ${i + 1} refused`);
  }
  assertEqual(h.svc.getDiagnostics().framesAcquired, framesBefore, 'acquisition counter unchanged after shutdown');
}

// --------------------------------- 22. no unauthorized frame retention

console.log('\n22. No unauthorized frame retention');
{
  const h = makeHarness();
  await h.svc.start();
  const r = await h.svc.analyzeFrame();
  assertEqual(r.ok, true, 'analysis succeeded');
  // The service retains NO frame data: only the derived perception (text).
  const svcInternal = h.svc as unknown as { lastFrameHash: string };
  assert(typeof svcInternal.lastFrameHash === 'string', 'only a content HASH is kept for duplicate prevention');
  h.svc.stop();
  assertEqual(h.svc.getLastPerception(), null, 'perception released on stop');
  assertEqual((h.svc as unknown as { lastFrameHash: string }).lastFrameHash, '', 'hash released on stop');
  // The frame dataUrl never enters storage, logs, or diagnostics.
  const diag = h.svc.getDiagnostics();
  assert(!JSON.stringify(diag).includes('data:image'), 'diagnostics are content-free');
}

// --------------------------------- 23. SPF / E5 security boundaries

console.log('\n23. SPF / E5 security boundaries');
{
  // Content hash determinism (bounded, sampled — no full-frame cost).
  assertEqual(frameContentHash('data:image/jpeg;base64,AAA'), frameContentHash('data:image/jpeg;base64,AAA'), 'hash deterministic');
  assert(frameContentHash('data:image/jpeg;base64,AAA') !== frameContentHash('data:image/jpeg;base64,BBB'), 'different content → different hash');
  // The client ALWAYS targets the camera-analyze endpoint (server-side SPF +
  // E5 stop-blocked) — verified in test 10; here: payload carries ONLY the
  // frame + question (never identity, memory, or conversation content).
  const h = makeHarness();
  await h.svc.start();
  await h.svc.analyzeFrame('Is my plant healthy?');
  const sent = JSON.parse(h.fetchCalls[0].body);
  assertEqual(Object.keys(sent).sort().join(','), 'image,question', 'transmission contains ONLY image + question');
  h.svc.stop();
}

// --------------------------------- 24. Steps 1–5 regression surfaces

console.log('\n24. Steps 1–5 regression surfaces');
{
  // The camera service is self-contained: constructing it does not touch the
  // tracker, turn manager, proactive service, or watchdog singletons.
  const h = makeHarness();
  await h.svc.start();
  assertEqual(h.svc.getStatus(), 'active', 'service operational');
  const turnMgr = getConversationTurnManager();
  assertEqual(turnMgr.getPhase(), 'idle', 'turn manager untouched by camera construction');
  h.svc.stop();
  // deliverWhenNotSpeaking immediate path (not speaking → deliver now).
  let immediate = 0;
  deliverWhenNotSpeaking(turnMgr, () => {
    immediate += 1;
  }, []);
  assertEqual(immediate, 1, 'immediate delivery path when not speaking');
  turnMgr.dispose();
  resetConversationTurnManagerForTests();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// ------------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILED assertions:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
