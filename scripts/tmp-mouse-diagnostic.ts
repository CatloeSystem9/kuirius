/** Throwaway diagnostic: agent-layer cursor move with physical verification. */
import { PowerShellMouseBackend, setMouseBackendBaseUrl } from '../src/agent/computer/powerShellMouse';
import { ComputerControlService } from '../src/agent/computer/computerControl';

const BASE = 'http://localhost:3000';
setMouseBackendBaseUrl(BASE);

async function serverPosition(): Promise<{ x: number; y: number }> {
  const r = await fetch(`${BASE}/api/computer/mouse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'position' }),
  });
  const d = await r.json();
  if (!d.success) throw new Error('position read failed');
  return d.position;
}

async function main() {
  const backend = new PowerShellMouseBackend();
  const service = new ComputerControlService({ backend });

  const bounds = await backend.getScreenBounds();
  console.log('backend screen bounds:', JSON.stringify(bounds));

  const p0 = await serverPosition();
  console.log('physical P0:', JSON.stringify(p0));

  const target = { x: Math.min(p0.x + 200, bounds.x + bounds.width - 5), y: Math.min(p0.y + 140, bounds.y + bounds.height - 5) };
  const result = await service.moveTo({ coordinates: target }, undefined);
  console.log('service result:', JSON.stringify({ action: result.action, intended: result.intended, final: result.final, verification: result.verification }, null, 2));

  const p1 = await serverPosition();
  console.log('physical P1 (immediately after):', JSON.stringify(p1));
  const d = Math.hypot(p1.x - target.x, p1.y - target.y);
  console.log(`distance from target: ${d.toFixed(1)}px`);
  console.log(d < 30 ? 'AGENT-LAYER MOVE: PHYSICALLY OK (within live-use tolerance)' : 'AGENT-LAYER MOVE: PHYSICAL MISMATCH');

  const restore = await service.moveTo({ coordinates: p0 }, undefined);
  console.log('restore:', restore.verification.note);
  const p2 = await serverPosition();
  console.log('physical after restore:', JSON.stringify(p2));
}

main().catch((err) => {
  console.error('AGENT-LAYER TEST FAILED:', err);
  process.exit(1);
});
