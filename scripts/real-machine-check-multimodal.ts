/**
 * Real-machine multimodal verification check (Phase 14) — safe, reversible.
 *
 * Workflow (spec §17), adapted to this machine's real application surface:
 *   0. Abort if the test application is already running (never touch a
 *      window the user has open).
 *   1. Launch "Character Map" (classic Windows accessory, discoverable via
 *      the Phase 9 Start-Menu allowlist) through /api/app/launch.
 *      (Store Notepad cannot be launched through any existing Phase 9
 *      surface on this machine — its app-execution alias is invisible to
 *      the server's path validation and Start-Menu discovery — and no
 *      safety layer is bypassed to force it.)
 *   2. Gather APPLICATION evidence through the Phase 9 service (real
 *      process table) via the Phase 14 analyzer.
 *   3. Focus the application (Phase 9 focus surface), type a harmless test
 *      phrase through the real keyboard backend (no Enter is ever sent) and
 *      record the ACTION RESULT as structured tool evidence, then perform a
 *      harmless reversible cursor nudge (moved +8,+8 then back) recorded as
 *      a second tool evidence item.
 *   4. Run a Phase 13 screen observation (synthetic cursor-position capture
 *      — real screen capture requires interactive consent) so the full
 *      multimodal pipeline is exercised; it is NOT used as proof of the app.
 *   5. Verify "charmap is open" through the MultimodalVerifier using the two
 *      INDEPENDENT real evidence kinds (process state + action results).
 *   6. Force-close the application and confirm the process is gone via a
 *      fresh status read.
 *
 * Nothing touches user files; nothing is typed into documents; the only
 * persistence is the application's own process state, which is terminated
 * before exit.
 */
import { MultimodalContext } from '../src/agent/multimodal/multimodalContext';
import { MultimodalAnalyzer } from '../src/agent/multimodal/multimodalAnalyzer';
import { MultimodalVerifier } from '../src/agent/multimodal/multimodalVerifier';
import type { ApplicationService } from '../src/agent/system/systemServices';
import type { ActiveWindowInfo, CaptureSource, CapturedFrame } from '../src/agent/vision/visionTypes';
import { makeFrame } from '../src/agent/vision/fakeCapture';

const BASE = 'http://localhost:3000';
const PHRASE = 'Krix phase 14 multimodal real-machine check';
const LAUNCH_NAME = 'Character Map'; // Start-Menu allowlist name (discovered)
const APP_NAME = 'charmap'; // real process name for Phase 9 status/close

async function post(path: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become healthy (start the local server first)');
}

/**
 * Synthetic capture source encoding the REAL cursor position (same approach
 * as the Phase 13 real-machine check). Clearly labeled as synthetic — the
 * multimodal layer treats it as pipeline integration evidence only.
 */
class CursorPositionCaptureSource implements CaptureSource {
  captures = 0;
  private bounds: { x: number; y: number; width: number; height: number } | null = null;

  async capture(): Promise<CapturedFrame> {
    const pos = await post('/api/computer/mouse', { action: 'position' });
    if (!pos.success) throw new Error('could not read cursor position');
    if (!this.bounds) {
      const b = await post('/api/computer/mouse', { action: 'screen_bounds' });
      if (!b.success) throw new Error('could not read screen bounds');
      this.bounds = b.bounds;
    }
    this.captures++;
    const W = 192;
    const H = 108;
    const bx = Math.min(W - 13, Math.max(0, Math.floor(((pos.position.x - this.bounds.x) / this.bounds.width) * W)));
    const by = Math.min(H - 13, Math.max(0, Math.floor(((pos.position.y - this.bounds.y) / this.bounds.height) * H)));
    return makeFrame(W, H, (x, y) => {
      if (x >= bx && x < bx + 12 && y >= by && y < by + 12) return [255, 255, 255];
      return [20, 20, 30];
    });
  }

  getActiveWindowInfo(): ActiveWindowInfo {
    return { available: false, source: 'unavailable' };
  }

  stop(): void {}
}

/** ApplicationService speaking to the REAL local server (Phase 9 surface). */
class ServerAppService {
  async status(name: string) {
    const r = await post('/api/app/status', { name });
    if (!r.success) return { action: 'status', name, verified: false, summary: String(r.error ?? 'failed') };
    return {
      action: 'status',
      name: r.result.name,
      running: r.result.running === true,
      pids: r.result.pids,
      verified: true,
      verificationNote: 'Real process table read via local server',
      summary: `"${r.result.name}" running=${r.result.running}`,
    };
  }
}

async function main() {
  await waitForHealth();
  console.log('server healthy');

  // E5 M1b enforcement reads server-side permission state — mirror this
  // script's mouse/keyboard grants (the explicit run IS the operator action).
  await fetch(`${BASE}/api/permissions/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: ['mouse.control', 'keyboard.control'] }),
  });

  const analyzer = new MultimodalAnalyzer({
    applicationService: new ServerAppService() as unknown as ApplicationService,
  });
  const verifier = new MultimodalVerifier();
  const context = new MultimodalContext();
  context.beginTask('real-check-14');

  // 0. Guard: never touch a window the user already has open.
  const pre = await post('/api/app/status', { name: APP_NAME });
  if (pre.success && pre.result?.running === true) {
    throw new Error(`${APP_NAME} is already running — refusing to interact with an existing user window. Close it first, then re-run this check.`);
  }

  // 1. Launch the accessory through the Phase 9 allowlist surface.
  const launched = await post('/api/app/launch', { name: LAUNCH_NAME });
  if (!launched.success) throw new Error(`launch failed: ${launched.error ?? '?'}`);
  console.log(`1. ${LAUNCH_NAME} launched through the Phase 9 surface (${launched.result?.launched ?? LAUNCH_NAME})`);
  try {
    // Real launch result as the first tool-evidence item (its resolved .lnk
    // target path names the real executable, e.g. ...\charmap.exe).
    analyzer.recordToolResult(context, 'app.launch', launched.result, true);
    // 2. Application evidence through the Phase 14 analyzer (real process table).
    await new Promise((r) => setTimeout(r, 2000)); // let the process register
    const appOk = await analyzer.gatherApplication(context, APP_NAME);
    if (!appOk) throw new Error('application status evidence could not be gathered');
    const appObs = context.latest('application_state');
    if (!appObs || appObs.payload.type !== 'application_state' || appObs.payload.running !== true) {
      throw new Error(`${APP_NAME} not reported running`);
    }
    console.log('2. application evidence gathered (real process table):', JSON.stringify(appObs.payload));
    const pids = (appObs.payload as { pids?: number[] }).pids ?? [];
    if (pids.length === 0) throw new Error('no PID captured');
    // The same real status read, also recorded as structured tool evidence.
    analyzer.recordToolResult(context, 'app.status', { name: APP_NAME, running: true, pids }, true);

    // 3. Focus the app (Phase 9 surface), type the harmless phrase (no Enter),
    //    record the ACTION RESULT as tool evidence, then a reversible cursor
    //    nudge as a second independent action-evidence item.
    const focused = await post('/api/app/focus', { pid: pids[0] });
    if (!focused.success) throw new Error(`focus failed: ${focused.error ?? '?'}`);
    await new Promise((r) => setTimeout(r, 800));
    const typed = await post('/api/computer/keyboard', { action: 'type', text: PHRASE });
    if (!typed.success) throw new Error(`typing failed: ${typed.error ?? '?'}`);
    analyzer.recordToolResult(context, 'keyboard.type', { action: 'type', sent: typed.sent, chars: PHRASE.length, note: 'no Enter sent' }, true);
    const pos1 = await post('/api/computer/mouse', { action: 'position' });
    if (!pos1.success) throw new Error('could not read cursor position');
    const moved = await post('/api/computer/mouse', { action: 'move', x: pos1.position.x + 8, y: pos1.position.y + 8 });
    if (!moved.success) throw new Error('cursor nudge failed');
    const movedBack = await post('/api/computer/mouse', { action: 'move', x: pos1.position.x, y: pos1.position.y });
    if (!movedBack.success) throw new Error('cursor restore failed');
    analyzer.recordToolResult(context, 'mouse.nudge', { action: 'move', from: pos1.position, to: { x: pos1.position.x + 8, y: pos1.position.y + 8 }, restored: true }, true);
    console.log(`3. phrase typed (${typed.sent} chars sent, no Enter) and cursor nudged +8,+8 then restored; both action results recorded as tool evidence`);

    // 4. Screen observation through Phase 13 (synthetic cursor capture — clearly labeled).
    const captureSource = new CursorPositionCaptureSource();
    const { ScreenObserver } = await import('../src/agent/vision/screenObserver');
    const { AdaptiveObserver } = await import('../src/agent/observation/adaptiveObserver');
    const screenObserver = new ScreenObserver({ captureSource });
    const adaptive = new AdaptiveObserver({ screenObserver });
    adaptive.beginTask('real-check-14');
    const screenResult = await adaptive.observe({ trigger: 'explicit_request', priority: 'NORMAL', taskId: 'real-check-14', requireFresh: true });
    if (screenResult.status !== 'observed' || !screenResult.state) throw new Error(`screen observation failed: ${screenResult.status}`);
    context.addInput({ type: 'ui_state', state: screenResult.state, source: 'real-check-14.synthetic-cursor-capture' });
    console.log('4. Phase 13 screen observation captured through the pipeline (synthetic source, labeled)');

    // 5. Verify "charmap is open" (real process name) from the two INDEPENDENT
    //    real evidence kinds (process state + launch/status/action tool
    //    results). The synthetic screen observation cannot visually
    //    corroborate the window (honest limitation) — the verifier reports
    //    that as a conflict with a required-verification recommendation,
    //    which we surface, not hide.
    const verdict = await verifier.verify(context, { expected: 'charmap is open' });
    console.log(`5. verification: ${verdict.verdict} (confidence ${verdict.confidence}, independent=${verdict.independentEvidence})`);
    console.log(`   evidence kinds: ${[...new Set(verdict.evidence.map((e) => e.type))].join(', ')}; conflicts: ${verdict.conflicts.map((c) => c.kind).join(', ') || 'none'}`);
    if (verdict.verdict !== 'confirmed') throw new Error(`expected "confirmed", got "${verdict.verdict}": ${JSON.stringify(verdict.reasoning)}`);
    if (!verdict.independentEvidence) throw new Error('expected independent confirmation from 2+ evidence kinds');
    if (verdict.evidence.length < 2) throw new Error('expected at least two evidence items');
    if (verdict.conflicts.length < 1) throw new Error('expected the synthetic screen corroboration gap to be reported as a conflict');
    if (!verdict.conflicts.some((c) => c.kind === 'application_presence_mismatch')) throw new Error('expected application_presence_mismatch conflict for the un-corroborated screen');

    // 6. Cleanup: force-close the test application, then confirm it is gone.
    const closed = await post('/api/app/close', { pid: pids[0], force: true });
    if (!closed.success) throw new Error(`close failed: ${closed.error ?? '?'}`);
    await new Promise((r) => setTimeout(r, 1000));

    const after = await post('/api/app/status', { name: APP_NAME });
    const stillRunning = after.success && after.result?.running === true;
    if (stillRunning) throw new Error(`${APP_NAME} still running after cleanup`);
    console.log(`6. ${APP_NAME} closed and confirmed gone (cleanup verified)`);
  } finally {
    context.endTask();
    // Safety net: if anything threw after launch, make sure we leave no
    // orphan test instance behind (only safe because of the step-0 guard).
    try {
      const rescue = await post('/api/app/status', { name: APP_NAME });
      if (rescue.success && rescue.result?.running === true && rescue.result.pids?.length) {
        await post('/api/app/close', { pid: rescue.result.pids[0], force: true });
        console.log('safety-net cleanup: test application instance force-closed');
      }
    } catch {}
  }

  console.log('REAL-MACHINE MULTIMODAL CHECK: PASS');
}

main().catch((err) => {
  console.error('REAL-MACHINE MULTIMODAL CHECK: FAIL —', err.message);
  process.exit(1);
});
