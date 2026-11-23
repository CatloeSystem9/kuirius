/**
 * KRISHA LIVE DEMO — "Open the browser and search for something."
 *
 * Krisha performs the task herself with her EXISTING Phase 5/6
 * computer-use features (no new code paths):
 *   1. KEYBOARD: Win key → type "msedge" → Enter      (opens the browser)
 *   2. KEYBOARD: Ctrl+L → type the search → Enter     (runs the search)
 *   3. MOUSE:    move the cursor + click on the page  (her mouse features)
 * Cleanup: Edge is closed at the end.
 *
 * Usage: server must be running on :3000, then
 *        npx tsx scripts/demo-krisha-browse.ts
 */
import { exec as _exec, execFile as _execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(_exec);
const execFile = promisify(_execFile);

const BASE = 'http://localhost:3000';
const SEARCH_QUERY = 'cute cat videos';

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
  throw new Error('Server did not become healthy');
}

async function ps(script: string): Promise<string> {
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000, windowsHide: true });
  return stdout.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await waitForHealth();
  console.log('[demo] Krisha server healthy');

  // Operator action: grant Krisha the mouse/keyboard session permissions.
  await post('/api/permissions/session', { grant: ['keyboard.control', 'mouse.control'] });
  console.log('[demo] permissions granted: keyboard.control + mouse.control');

  // --- STEP 1 — Krisha opens the browser with the KEYBOARD ---
  console.log('[demo] Krisha presses the Win key…');
  const win = await post('/api/computer/keyboard', { action: 'key', key: 'win' });
  if (!win.success) throw new Error('Win key failed: ' + JSON.stringify(win));
  await sleep(1200);

  console.log('[demo] Krisha types "msedge"…');
  const typeBrowser = await post('/api/computer/keyboard', { action: 'type', text: 'msedge' });
  if (!typeBrowser.success) throw new Error('type failed: ' + JSON.stringify(typeBrowser));
  await sleep(400);

  console.log('[demo] Krisha presses Enter…');
  const enter1 = await post('/api/computer/keyboard', { action: 'key', key: 'enter' });
  if (!enter1.success) throw new Error('Enter failed: ' + JSON.stringify(enter1));

  // Wait for the browser to actually start (cold launch takes seconds).
  let edgePid = NaN;
  for (let i = 0; i < 20 && !Number.isFinite(edgePid); i++) {
    await sleep(800);
    const out = await ps('(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).Id');
    edgePid = parseInt(out, 10);
  }
  if (!Number.isFinite(edgePid)) throw new Error('Edge did not start');
  console.log(`[demo] browser is open (pid ${edgePid})`);
  await sleep(2500); // let the start page render

  // --- STEP 2 — Krisha searches with the KEYBOARD ---
  console.log('[demo] Krisha focuses the address bar (Ctrl+L)…');
  const ctrlL = await post('/api/computer/keyboard', { action: 'hotkey', modifiers: ['ctrl'], key: 'l' });
  if (!ctrlL.success) throw new Error('Ctrl+L failed: ' + JSON.stringify(ctrlL));
  await sleep(500);

  console.log(`[demo] Krisha types the search: "${SEARCH_QUERY}"…`);
  const typeSearch = await post('/api/computer/keyboard', { action: 'type', text: SEARCH_QUERY });
  if (!typeSearch.success) throw new Error('search typing failed: ' + JSON.stringify(typeSearch));
  await sleep(300);

  console.log('[demo] Krisha presses Enter to search…');
  const enter2 = await post('/api/computer/keyboard', { action: 'key', key: 'enter' });
  if (!enter2.success) throw new Error('search Enter failed: ' + JSON.stringify(enter2));
  await sleep(4500); // results load

  const title = await ps('(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowTitle');
  console.log(`[demo] browser window title: "${title}"`);
  const searched = title.toLowerCase().includes('cat') || title.toLowerCase().includes('bing') || title.toLowerCase().includes('search');
  console.log(`[demo] search executed: ${searched ? 'YES' : 'unverified from title'}`);

  // --- STEP 3 — Krisha uses her MOUSE ---
  const boundsRes = await post('/api/computer/mouse', { action: 'screen_bounds' });
  const m = JSON.stringify(boundsRes).match(/BOUNDS (-?\d+) (-?\d+) (-?\d+) (-?\d+)/) || (boundsRes.bounds ? [0, boundsRes.bounds.x, boundsRes.bounds.y, boundsRes.bounds.width, boundsRes.bounds.height] : null);
  let W = 1920;
  let H = 1080;
  if (Array.isArray(m)) {
    W = parseInt(m[3], 10);
    H = parseInt(m[4], 10);
  } else if (boundsRes && boundsRes.success && boundsRes.bounds) {
    W = boundsRes.bounds.width;
    H = boundsRes.bounds.height;
  }
  const cx = Math.round(W * 0.5);
  const cy = Math.round(H * 0.1); // top banner area of the page — neutral click zone
  console.log(`[demo] Krisha moves her mouse to (${cx}, ${cy})…`);
  const move = await post('/api/computer/mouse', { action: 'move', x: cx, y: cy });
  if (!move.success) throw new Error('mouse move failed: ' + JSON.stringify(move));
  const pos = await post('/api/computer/mouse', { action: 'position' });
  console.log(`[demo] cursor confirmed at: ${JSON.stringify(pos.position ?? pos)}`);

  console.log('[demo] Krisha clicks…');
  const click = await post('/api/computer/mouse', { action: 'click', x: cx, y: cy });
  if (!click.success) throw new Error('mouse click failed: ' + JSON.stringify(click));
  console.log('[demo] click done');

  console.log('\n[demo] ✅ Krisha opened the browser and searched — using her keyboard and mouse features.');
  console.log('[demo] Cleaning up (closing Edge)…');
  await exec('taskkill /IM msedge.exe /F 2>nul', { shell: 'cmd.exe', windowsHide: true }).catch(() => undefined);
  console.log('[demo] done.');
}

main().catch((err) => {
  console.error('[demo] FAILED:', err?.message || err);
  exec('taskkill /IM msedge.exe /F 2>nul', { shell: 'cmd.exe', windowsHide: true }).catch(() => undefined);
  process.exit(1);
});
