/**
 * SPF VISUAL performance measurement (remediation task §9).
 *
 * Usage: npx tsx scripts/measure-spf-visual-performance.ts
 *
 * Measures: OCR worker initialization, OCR latency by image size, detection
 * latency, redaction latency, post-redaction verification latency, total
 * screenshot-inspection latency (clean + sensitive), memory usage.
 * Purely local — no network.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { OcrWorker, inspectImageForTransmission, disposeSharedOcrWorker } from '../src/agent/spf/visualInspection';
import { scanText } from '../src/agent/spf/detectors';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-visual-perf-'));
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

function draw(items: Array<{ text: string; x?: number; y: number; size?: number }>, width: number, height: number): Promise<string> {
  const spec = { width, height, format: 'png', items: items.map((i) => ({ text: i.text, x: i.x ?? 20, y: i.y, size: i.size ?? 20 })) };
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

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(label: string, times: number[]): void {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(
    `${label.padEnd(56)} n=${String(times.length).padEnd(4)} p50=${percentile(sorted, 50).toFixed(1)}ms  p95=${percentile(sorted, 95).toFixed(1)}ms  mean=${mean.toFixed(1)}ms`
  );
}

async function main(): Promise<void> {
  const memBefore = process.memoryUsage();

  console.log('=== SPF VISUAL performance (local OCR / redaction / verification) ===\n');

  // 1. OCR worker initialization (cold boot).
  const worker = new OcrWorker();
  const initStart = Date.now();
  await worker.ensureReady(30000);
  const initMs = Date.now() - initStart;
  console.log(`OCR worker initialization (cold boot): ${initMs}ms (one-time per process; Add-Type compilation dominates)\n`);

  // 2. OCR latency by image size (the pipeline's inspect op).
  const sizes: Array<[string, number, number]> = [
    ['480x120', 480, 120],
    ['640x200', 640, 200],
    ['768x300 (pipeline format)', 768, 300],
    ['1024x400', 1024, 400],
  ];
  for (const [label, w, h] of sizes) {
    const img = await draw([{ text: 'Quarterly design review agenda for the platform team', y: 30 }, { text: 'Status: on track, next milestone Friday', y: 80 }], w, h);
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      const r = await worker.inspect(img, 20000);
      times.push(Date.now() - t0);
      if (r.status !== 'ok') throw new Error(`inspect failed: ${r.status}`);
    }
    report(`OCR inspect — ${label}`, times);
  }

  // 3. Detection latency (per OCR line set).
  const ocrLines = [
    { t: 'Quarterly design review agenda for the platform team', x: 20, y: 30, w: 420, h: 24 },
    { t: 'Status: on track, next milestone Friday', x: 20, y: 80, w: 330, h: 24 },
    { t: 'Buttons: Save, Run, Debug; links: docs settings', x: 20, y: 130, w: 400, h: 24 },
  ];
  const detTimes: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = Date.now();
    for (const line of ocrLines) scanText(line.t, { deadlineMs: 200 });
    detTimes.push(Date.now() - t0);
  }
  report('SPF detection — 3 OCR lines (scanText x3)', detTimes);

  // 4. Redaction latency (one region) + 5. post-redaction verification.
  const sensitiveImg = await draw([{ text: 'password: FAKE-Perf-Secret-42', y: 30 }, { text: 'Welcome to the dashboard', y: 90 }], 640, 160);
  const rects = [{ x: 14, y: 26, w: 320, h: 34 }];
  const redTimes: number[] = [];
  let sanitized = '';
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    const r = await worker.redact(sensitiveImg, rects, 20000);
    redTimes.push(Date.now() - t0);
    if (r.status !== 'ok') throw new Error('redact failed');
    sanitized = r.img!;
  }
  report('Redaction (decode+fill+JPEG re-encode, 1 region)', redTimes);

  const verTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    const r = await worker.inspect(sanitized, 20000);
    verTimes.push(Date.now() - t0);
    if (r.status !== 'ok') throw new Error('verify inspect failed');
  }
  report('Post-redaction verification (second OCR pass)', verTimes);

  // 6. Total pipeline latency (payloads pre-generated outside timed loops).
  const cleanPerfImg = await draw([{ text: 'Agenda for the quarterly platform review meeting', y: 30 }], 640, 120);
  const totalClean: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    const r = await inspectImageForTransmission(cleanPerfImg, {
      worker,
      deadlineMs: 30000,
      opTimeoutMs: 20000,
    });
    totalClean.push(Date.now() - t0);
    if (r.decision !== 'allow') throw new Error('expected allow');
  }
  report('Total pipeline — clean image (1 OCR pass)', totalClean);

  const totalSensitive: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    const r = await inspectImageForTransmission(sensitiveImg, { worker, deadlineMs: 30000, opTimeoutMs: 20000 });
    totalSensitive.push(Date.now() - t0);
    if (r.decision !== 'redact') throw new Error('expected redact');
  }
  report('Total pipeline — sensitive image (2 OCR + redact)', totalSensitive);

  const memAfter = process.memoryUsage();
  console.log('\n--- totals ---');
  console.log(`heap: before=${(memBefore.heapUsed / 1024 / 1024).toFixed(1)}MB after=${(memAfter.heapUsed / 1024 / 1024).toFixed(1)}MB delta=${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(1)}MB`);
  console.log('(the OCR worker is a separate OS process; its memory is bounded by the 8192px image cap and one in-flight op)');

  worker.kill();
  disposeSharedOcrWorker();
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

main().catch((err) => {
  console.error('PERF FAILED:', err);
  process.exit(1);
});
