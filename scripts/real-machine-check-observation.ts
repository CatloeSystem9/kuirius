/**
 * Real-machine adaptive observation check (Phase 13) — safe, reversible.
 *
 * Real screen capture requires interactive browser consent (no native
 * dependencies are allowed), so — like the Phase 7 real-machine check — this
 * script drives the REAL pipeline against a harmless real-machine signal:
 * a capture source whose frames encode the REAL cursor position reported by
 * the local server. Moving the cursor really changes the captured frame, so
 * change detection, staleness, and adaptive re-observation are exercised
 * end-to-end against the real machine.
 *
 * Workflow:
 *   1. Observe the current state (capture #1).
 *   2. Re-observe without acting → reused (no capture, unchanged screen).
 *   3. Perform a harmless reversible action (cursor nudge via the server).
 *   4. After the reuse window, adaptive observation captures fresh (#3) and
 *      classifies the real change as meaningful.
 *   5. Verify no polling (captures stay flat while idle).
 *   6. Restore the original cursor position. Bounded observation counts.
 */
import { ScreenObserver } from '../src/agent/vision/screenObserver';
import { AdaptiveObserver } from '../src/agent/observation/adaptiveObserver';
import { makeFrame } from '../src/agent/vision/fakeCapture';
import type { CaptureSource, CapturedFrame, ActiveWindowInfo } from '../src/agent/vision/visionTypes';

const BASE = 'http://localhost:3000';

async function post(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/api/computer/mouse`, {
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
 * Capture source that encodes the real cursor position into a frame:
 * a bright marker block on a dark background. Real change → real signature
 * change through the standard Phase 4 pipeline.
 */
class CursorPositionCaptureSource implements CaptureSource {
  captures = 0;
  private bounds: { x: number; y: number; width: number; height: number } | null = null;

  async capture(): Promise<CapturedFrame> {
    const pos = await post({ action: 'position' });
    if (!pos.success) throw new Error('could not read cursor position');
    if (!this.bounds) {
      const b = await post({ action: 'screen_bounds' });
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

async function main() {
  await waitForHealth();
  console.log('server healthy');

  // E5 M1b enforcement reads server-side permission state — mirror this
  // script's mouse-control grant (the explicit run IS the operator action).
  await fetch(`${BASE}/api/permissions/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: ['mouse.control'] }),
  });

  const pos = await post({ action: 'position' });
  if (!pos.success) throw new Error('could not read cursor position');
  const original = pos.position as { x: number; y: number };
  console.log('original cursor position:', JSON.stringify(original));

  const bounds = await post({ action: 'screen_bounds' });
  if (!bounds.success) throw new Error('could not read screen bounds');
  const b = bounds.bounds;
  const nudgeX = Math.min(original.x + 240, b.x + b.width - 1);
  const nudgeY = Math.min(original.y + 160, b.y + b.height - 1);
  const willActuallyMove = nudgeX !== original.x || nudgeY !== original.y;

  const captureSource = new CursorPositionCaptureSource();
  const screenObserver = new ScreenObserver({ captureSource });
  const adaptive = new AdaptiveObserver({ screenObserver });
  adaptive.beginTask('real-check-13');

  try {
    // 1. Observe the current state.
    const r1 = await adaptive.observe({ trigger: 'explicit_request', priority: 'HIGH', taskId: 'real-check-13', requireFresh: true });
    if (r1.status !== 'observed') throw new Error(`initial observation failed: ${r1.status} ${r1.error?.message ?? ''}`);
    console.log('1. initial observation: captured');

    // 2. Re-observe without acting → unchanged-screen reuse, no capture.
    const capturesAfterFirst = captureSource.captures;
    const r2 = await adaptive.observe({ trigger: 'task_step', priority: 'NORMAL', taskId: 'real-check-13' });
    if (r2.status !== 'reused') throw new Error(`expected unchanged-screen reuse, got: ${r2.status}`);
    if (captureSource.captures !== capturesAfterFirst) throw new Error('reuse unexpectedly captured a new frame');
    console.log('2. unchanged-screen reuse: verified (no new capture)');

    if (willActuallyMove) {
      // 3. Harmless reversible action: nudge the cursor via the real backend.
      const moved = await post({ action: 'move', x: nudgeX, y: nudgeY });
      if (!moved.success) throw new Error('cursor move failed');
      console.log('3. reversible action performed: cursor nudged to', JSON.stringify({ x: nudgeX, y: nudgeY }));

      // Record the action the way the event bus would (post-action trigger).
      adaptive.recordAction('mouse', 'after_mouse_action');

      // 4. Wait out the reuse window, then observe — adaptive must capture
      //    fresh and classify the real change as meaningful.
      await new Promise((r) => setTimeout(r, 1700));
      const r3 = await adaptive.observe({ trigger: 'after_mouse_action', priority: 'HIGH', taskId: 'real-check-13' });
      if (r3.status !== 'observed') throw new Error(`expected fresh observation after action, got: ${r3.status}`);
      if (r3.changeKind === 'none' || r3.changeKind === undefined) {
        throw new Error(`expected a meaningful change classification, got: ${r3.changeKind}`);
      }
      console.log(`4. adaptive re-observation: captured fresh, change classified as "${r3.changeKind}"`);
    } else {
      console.log('3-4. cursor at screen edge — skipping nudge (bounds-safe), reuse behavior already verified');
    }

    // 5. No polling: captures stay flat while idle.
    const flat = captureSource.captures;
    await new Promise((r) => setTimeout(r, 400));
    if (captureSource.captures !== flat) throw new Error('unexpected background captures (polling loop detected)');
    console.log('5. no polling: capture count stable while idle');

    if (captureSource.captures > 6) throw new Error(`observation count too high: ${captureSource.captures} (budget discipline violated)`);
  } finally {
    // 6. Always restore the original cursor position.
    await post({ action: 'move', x: original.x, y: original.y });
  }

  const final = await post({ action: 'position' });
  const restored = final.position.x === original.x && final.position.y === original.y;
  console.log('6. cursor restored to original:', restored, JSON.stringify(final.position));

  if (!restored) throw new Error('cursor was not restored');
  adaptive.endTask('real-check-13');
  console.log('REAL-MACHINE ADAPTIVE OBSERVATION CHECK: PASS');
}

main().catch((err) => {
  console.error('REAL-MACHINE ADAPTIVE OBSERVATION CHECK: FAIL —', err.message);
  process.exit(1);
});
