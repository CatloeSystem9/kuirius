/**
 * Real-machine check (Phase 5) — exercises the actual /api/computer/mouse
 * PowerShell pipeline against the running local server. Fully reversible:
 * reads position/bounds, nudges the cursor 25px, verifies, restores.
 * No clicks are performed.
 */
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
  throw new Error('Server did not become healthy');
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

  const pos0 = await post({ action: 'position' });
  if (!pos0.success) throw new Error('position failed: ' + JSON.stringify(pos0));
  const original = pos0.position;
  console.log('original position:', JSON.stringify(original));

  const bounds = await post({ action: 'screen_bounds' });
  if (!bounds.success) throw new Error('screen_bounds failed: ' + JSON.stringify(bounds));
  console.log('screen bounds:', JSON.stringify(bounds.bounds));

  const target = { x: Math.min(original.x + 25, bounds.bounds.x + bounds.bounds.width - 1), y: original.y + 15 };
  const move1 = await post({ action: 'move', x: target.x, y: target.y });
  console.log('move to', JSON.stringify(target), '→', JSON.stringify(move1));
  if (!move1.success || move1.position.x !== target.x || move1.position.y !== target.y) {
    throw new Error('move verification failed: ' + JSON.stringify(move1));
  }

  const pos1 = await post({ action: 'position' });
  console.log('verified position after move:', JSON.stringify(pos1.position));
  if (pos1.position.x !== target.x || pos1.position.y !== target.y) throw new Error('position readback mismatch');

  const restore = await post({ action: 'move', x: original.x, y: original.y });
  console.log('restore →', JSON.stringify(restore));
  const pos2 = await post({ action: 'position' });
  console.log('final position:', JSON.stringify(pos2.position));
  if (pos2.position.x !== original.x || pos2.position.y !== original.y) throw new Error('restore failed');

  console.log('REAL-MACHINE MOUSE CHECK: PASS (position, bounds, move, readback, restore)');
}

main().catch((err) => {
  console.error('REAL-MACHINE MOUSE CHECK: FAIL —', err.message);
  process.exit(1);
});
