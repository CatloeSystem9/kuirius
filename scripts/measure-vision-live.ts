/**
 * Live Screen Perception — performance measurement (task §7).
 * Run: npx tsx scripts/measure-vision-live.ts [--e2e http://127.0.0.1:3000]
 *
 * Measures, purely locally:
 *  1. Probe compute cost (signature on the 240px analysis buffer) — the
 *     per-frame CPU the watcher adds, in Node (browser canvas draw/getImageData
 *     is compositor-side and adds ~1-3ms at this scale on the target hardware).
 *  2. Derived idle/active CPU duty cycle from the adaptive intervals.
 *  3. OCR latency through the REAL WinRT worker at the perception format
 *     (768x432 JPEG-equivalent content) — cold boot + steady-state.
 *  4. Optional [--e2e]: end-to-end /api/screen/understand latency against a
 *     running dev server + server-process RSS.
 *  5. Extended-session stability: 45 s of continuous watching with a fake
 *     source — heap growth must stay bounded (no accumulating buffers).
 */
import { computeBlockSignature, compareSignatures } from '../src/agent/vision/signatures';
import { OcrWorker, screenUnderstandImage, disposeSharedOcrWorker, configureSharedOcrWorker } from '../src/agent/spf/visualInspection';
import { LiveScreenWatcher, DEFAULT_LIVE_INTERVALS } from '../src/agent/vision/liveWatcher';
import type { CapturedFrame } from '../src/agent/vision/visionTypes';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function report(label: string, times: number[]): string {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const line = `${label.padEnd(52)} n=${String(times.length).padEnd(4)} p50=${percentile(sorted, 50).toFixed(2)}ms  p95=${percentile(sorted, 95).toFixed(2)}ms  mean=${mean.toFixed(2)}ms`;
  console.log(line);
  return line;
}

function analysisBuffer(): CapturedFrame {
  // 240x135 RGBA — the real analysis resolution of the capture pipeline.
  const width = 240;
  const height = 135;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const v = (i * 7919) & 255;
    data[i] = v; data[i + 1] = (v * 3) & 255; data[i + 2] = (v * 7) & 255; data[i + 3] = 255;
  }
  return { width, height, data, capturedAt: Date.now() };
}

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-live-perf-'));
const DRAW_SCRIPT = path.join(TMP_DIR, 'draw.ps1');
fs.writeFileSync(
  DRAW_SCRIPT,
  `
param([string]$SpecJson)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$spec = $SpecJson | ConvertFrom-Json
$bmp = New-Object System.Drawing.Bitmap([int]$spec.width, [int]$spec.height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
foreach ($item in $spec.items) {
  $font = New-Object System.Drawing.Font('Arial', [single]$item.size)
  $g.DrawString($item.text, $font, [System.Drawing.Brushes]::Black, [single]$item.x, [single]$item.y)
}
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
`
);
function draw(items: Array<{ text: string; x?: number; y?: number; size?: number }>, width: number, height: number): Promise<string> {
  const spec = { width, height, items: items.map((i) => ({ text: i.text, x: i.x ?? 24, y: i.y ?? 40, size: i.size ?? 18 })) };
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DRAW_SCRIPT, JSON.stringify(spec)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    proc.stdout!.on('data', (d: Buffer) => (out += String(d)));
    proc.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('draw ' + code))));
  });
}

// ------------------------------------------------- 5. stability fixture
class FakeSource {
  level = 40;
  async captureAnalysis(): Promise<CapturedFrame> {
    // Slight drift every probe → realistic mix of unchanged/changed frames.
    if (Math.random() < 0.3) this.level = (this.level + 30) % 256;
    return analysisBuffer();
  }
  async capture(): Promise<CapturedFrame> {
    return this.captureAnalysis();
  }
  getActiveWindowInfo() {
    return { available: false, source: 'unavailable' as const };
  }
  stop(): void {}
}

async function main(): Promise<void> {
  const e2eBase = process.argv.find((a) => a.startsWith('--e2e'))?.split('=')[1];
  console.log('=== Live Screen Perception — performance measurement ===\n');

  // 1. Probe compute cost (the CPU the watcher adds per sampled frame).
  const frame = analysisBuffer();
  const sigTimes: number[] = [];
  for (let i = 0; i < 500; i++) {
    const t0 = process.hrtime.bigint();
    computeBlockSignature(frame);
    sigTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  report('Probe compute — block signature (240x135)', sigTimes);

  const sigA = computeBlockSignature(frame);
  const cmpTimes: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const t0 = process.hrtime.bigint();
    compareSignatures(sigA, sigA);
    cmpTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  report('Probe compare — compareSignatures (32x18)', cmpTimes);

  const probeCost = sigTimes.reduce((a, b) => a + b, 0) / sigTimes.length;
  const idleInterval = DEFAULT_LIVE_INTERVALS.idleMs / 1000;
  const activeInterval = DEFAULT_LIVE_INTERVALS.activeMs / 1000;
  const burstInterval = DEFAULT_LIVE_INTERVALS.burstMs / 1000;
  console.log(
    `\nDerived CPU duty cycle of one core (2-core machine; browser draw adds ~1-3ms/probe):\n` +
      `  idle   (1 probe / ${idleInterval}s): ~${((probeCost / 1000 / idleInterval) * 100).toFixed(2)}% of one core\n` +
      `  active (1 probe / ${activeInterval}s): ~${((probeCost / 1000 / activeInterval) * 100).toFixed(2)}% of one core\n` +
      `  burst  (1 probe / ${burstInterval}s): ~${((probeCost / 1000 / burstInterval) * 100).toFixed(2)}% of one core\n`
  );

  // 2/3. Real WinRT OCR at the perception format.
  configureSharedOcrWorker({ idleReleaseMs: 0 });
  const worker = new OcrWorker();
  const bootStart = Date.now();
  await worker.ensureReady(30000);
  console.log(`OCR worker cold boot: ${Date.now() - bootStart}ms (one-time; idle release reboots lazily)\n`);
  const image = await draw(
    [
      { text: 'Quarterly design review agenda for the platform team', y: 40 },
      { text: 'Status: on track, next milestone Friday', y: 120 },
      { text: 'Action items: deploy canary, update runbook, notify team', y: 200 },
    ],
    768,
    432
  );
  const ocrTimes: number[] = [];
  let ocrLines = 0;
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    const r = await screenUnderstandImage(image, { worker, opTimeoutMs: 20000 });
    ocrTimes.push(Date.now() - t0);
    if (r.status !== 'ok') throw new Error(`understand failed: ${r.status} ${r.message ?? ''}`);
    ocrLines = r.lines?.length ?? 0;
  }
  report('screenUnderstandImage — 768x432, 3 text blocks (WinRT OCR + SPF screening)', ocrTimes);
  console.log(`  recognized lines: ${ocrLines}\n`);

  // 4. Optional E2E against the running dev server.
  if (e2eBase) {
    console.log(`E2E against ${e2eBase}:`);
    const e2eTimes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = Date.now();
      const res = await fetch(`${e2eBase}/api/screen/understand`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: `data:image/png;base64,${image}` }),
      });
      const body = (await res.json()) as { success: boolean; result?: { status: string; lines?: unknown[]; ocrMs?: number } };
      e2eTimes.push(Date.now() - t0);
      if (!body.success) throw new Error(`e2e failed: ${JSON.stringify(body).slice(0, 160)}`);
      if (i === 0) console.log(`  route OK — ${body.result?.lines?.length ?? 0} lines, server-side ocrMs=${body.result?.ocrMs}`);
    }
    report('POST /api/screen/understand (E2E incl. HTTP transport)', e2eTimes);
  } else {
    console.log('E2E route measurement skipped (start the dev server and pass --e2e=http://127.0.0.1:3000)');
  }

  // 5. Extended-session stability (45 s of watching, heap-growth check).
  console.log('\nExtended-session stability (45 s continuous watching):');
  if (global.gc) global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const src = new FakeSource();
  const w = new LiveScreenWatcher({ captureSource: src, intervals: { idleMs: 250, activeMs: 120, burstMs: 60 } });
  w.start();
  const probesStart = w.getStats().probes;
  await new Promise((r) => setTimeout(r, 45_000));
  const stats = w.getStats();
  const probesRun = stats.probes - probesStart;
  if (global.gc) global.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const heapGrowth = (heapAfter - heapBefore) / 1024;
  console.log(
    `  probes=${stats.probes} (ran ${probesRun}), unchanged=${stats.unchanged}, minor=${stats.minor}, major=${stats.major}, failed=${stats.failed}\n` +
      `  avg probe compute: ${stats.avgProbeMs?.toFixed(2)}ms\n` +
      `  heap growth over 45 s: ${heapGrowth.toFixed(1)} KB ${heapGrowth < 2048 ? '(bounded — no accumulating buffers)' : '(GROWTH — INVESTIGATE)'}\n` +
      `  external RSS delta: ${((process.memoryUsage().rss - heapBefore) / 1024 / 1024).toFixed(1)} MB (process total)\n`
  );
  w.stop();

  worker.kill();
  disposeSharedOcrWorker();
  console.log('DONE');
  process.exit(0);
}

main().catch((err) => {
  console.error('MEASUREMENT FAILED:', err);
  disposeSharedOcrWorker();
  process.exit(1);
});
