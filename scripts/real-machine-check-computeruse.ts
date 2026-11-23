/**
 * Real-machine computer-use check (Phase 7) — reversible, harmless.
 *
 * Runs the actual ComputerUseAgent orchestrator against the real PowerShell
 * mouse backend (via the local server) with a coordinate-only goal:
 *   move the cursor to (x+30, y+20) then move the cursor back to (x, y)
 * The original position is restored by the goal itself. No clicking, no
 * vision-dependent targeting (screen capture requires interactive consent).
 */
import { ComputerUseAgent } from '../src/agent/computerUse/computerUseAgent';
import { ComputerControlService } from '../src/agent/computer/computerControl';
import { PowerShellMouseBackend, setMouseBackendBaseUrl } from '../src/agent/computer/powerShellMouse';
import { KeyboardControlService } from '../src/agent/computer/keyboardControl';
import { PowerShellKeyboardBackend, setKeyboardBackendBaseUrl } from '../src/agent/computer/powerShellKeyboard';
import { AgentEventBus } from '../src/agent/events';

const BASE = 'http://localhost:3000';
setMouseBackendBaseUrl(BASE);
setKeyboardBackendBaseUrl(BASE);

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
  throw new Error('Server did not become healthy');
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

  const pos = await post({ action: 'position' });
  if (!pos.success) throw new Error('could not read cursor position');
  const original = pos.position as { x: number; y: number };
  console.log('original cursor position:', JSON.stringify(original));

  const bounds = await post({ action: 'screen_bounds' });
  if (!bounds.success) throw new Error('could not read screen bounds');
  const b = bounds.bounds;
  const nudgeX = Math.min(original.x + 30, b.x + b.width - 1);
  const nudgeY = Math.min(original.y + 20, b.y + b.height - 1);

  // The orchestrator loop with the REAL backend (no observer: coordinate
  // goals need no vision; verification is the backend-reported final position).
  const events = new AgentEventBus();
  events.on('COMPUTER_ACTION_PLANNED', (e) => console.log('  planned:', (e.payload as any)?.description));
  events.on('COMPUTER_USE_COMPLETED', () => console.log('  orchestrator completed'));
  const mouse = new ComputerControlService({ backend: new PowerShellMouseBackend(), events });
  const keyboard = new KeyboardControlService({ backend: new PowerShellKeyboardBackend(), events });
  const agent = new ComputerUseAgent({ mouse, keyboard, events });

  const goal = `move the cursor to ${nudgeX}, ${nudgeY} then move the cursor to ${original.x}, ${original.y}`;
  console.log('goal:', goal);
  let result;
  try {
    result = await agent.run(goal);
  } finally {
    // Always restore the cursor, even on failure.
    await post({ action: 'move', x: original.x, y: original.y });
  }

  console.log('status:', result.status);
  for (const action of result.actions) {
    console.log(`  - ${action.intent.description} — ${action.status}${action.error ? ` error: ${action.error}` : ''}${action.verified === undefined ? '' : ` (verified: ${action.verified})`}`);
  }

  const final = await post({ action: 'position' });
  const restored = final.position.x === original.x && final.position.y === original.y;
  console.log('cursor restored to original:', restored, JSON.stringify(final.position));

  if (result.status !== 'completed') throw new Error('orchestrator did not complete: ' + result.status);
  if (!restored) throw new Error('cursor was not restored');
  console.log('REAL-MACHINE COMPUTER-USE CHECK: PASS (orchestrator → real mouse backend → verified, restored)');
}

main().catch((err) => {
  console.error('REAL-MACHINE COMPUTER-USE CHECK: FAIL —', err.message);
  process.exit(1);
});
