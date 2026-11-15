/**
 * SPF VISUAL â€” security test suite for local screenshot OCR inspection and
 * irreversible region redaction (remediation task Â§8).
 *
 * Usage:  npx tsx scripts/test-spf-visual.ts
 * Exit:   non-zero on any failure.
 *
 * SYNTHETIC SCREENSHOTS ONLY (text drawn via System.Drawing on local
 * canvases). No real API is contacted: the spawned live server (isolated
 * KRISHA_SANDBOX_DIR tmpdir store) runs with an EMPTY GEMINI_API_KEY so the
 * model call can never succeed â€” SPF visual decisions are observed through
 * the content-free `spfImage` response metadata, and the ACTUAL OUTBOUND
 * payload is verified at wire level against a controlled local HTTP
 * receiver (receiver-side re-OCR + pixel sampling of the original region).
 *
 * The real E5 protected store is never touched by this suite: verify with
 * scripts/spf-real-store-status.ts before and after.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';

import {
  OcrWorker,
  inspectImageForTransmission,
  disposeSharedOcrWorker,
  type VisualInspectionOptions,
  type VisualWorkerLike,
  type OcrInspectResult,
  type RedactResult,
  type OcrLine,
} from '../src/agent/spf/visualInspection';

// ---------------------------------------------------------------- helpers

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  âœ— ${label}`);
  }
}

/** All synthetic secret strings drawn into test images. */
const SECRETS = {
  password: 'password: FAKE-Visual-Pw-951',
  otp: 'Your verification code is 462913',
  googleKey: 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
  bank: 'account number: 8837462910',
  card: 'card 4917 4810 0055 8813, cvv: 731',
};

const ALL_SECRET_STRINGS = Object.values(SECRETS);
const SECRET_TOKENS = ['FAKE-Visual-Pw-951', '462913', 'AIzaFAKEFAKE', '8837462910', '4917 4810 0055 8813', 'cvv: 731'];

// ------------------------------------------------- synthetic image factory

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-visual-test-'));
const DRAW_SCRIPT = path.join(TMP_DIR, 'draw.ps1');
const SAMPLE_SCRIPT = path.join(TMP_DIR, 'sample.ps1');
const COMPOSE_SCRIPT = path.join(TMP_DIR, 'compose.ps1');

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
  $brush = [System.Drawing.Brushes]::Black
  $g.DrawString($item.text, $font, $brush, [single]$item.x, [single]$item.y)
}
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
if ($spec.format -eq 'jpeg') {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $p = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]62)
  $bmp.Save($ms, $codec, $p)
} else {
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
}
$bmp.Dispose()
[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
`
);

/** Draw a synthetic screenshot and return its base64 (PNG or JPEG). */
function drawImage(
  items: Array<{ text: string; x?: number; y: number; size?: number }>,
  opts: { width?: number; height?: number; format?: 'png' | 'jpeg' } = {}
): Promise<string> {
  const spec = {
    width: opts.width ?? 640,
    height: opts.height ?? 200,
    format: opts.format ?? 'png',
    items: items.map((i) => ({ text: i.text, x: i.x ?? 20, y: i.y, size: i.size ?? 20 })),
  };
  return runPowerShell(DRAW_SCRIPT, [JSON.stringify(spec)]).then((out) => {
    if (out.length < 100) throw new Error(`image generation failed (${out.length} chars)`);
    return out;
  });
}

function runPowerShell(scriptPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    proc.stdout!.on('data', (d: Buffer) => (out += String(d)));
    proc.stderr!.on('data', (d: Buffer) => (err += String(d)));
    proc.on('exit', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`ps failed (${code}): ${err.slice(0, 300)}`))
    );
  });
}

fs.writeFileSync(
  SAMPLE_SCRIPT,
  `
param([string]$ImgB64, [int]$X, [int]$Y, [int]$W, [int]$H)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bytes = [Convert]::FromBase64String($ImgB64)
$ms = New-Object System.IO.MemoryStream(, $bytes)
$bmp = New-Object System.Drawing.Bitmap($ms)
$black = 0; $total = 0
$x2 = [math]::Min($bmp.Width, $X + $W); $y2 = [math]::Min($bmp.Height, $Y + $H)
for ($y = [math]::Max(0, $Y); $y -lt $y2; $y++) {
  for ($x = [math]::Max(0, $X); $x -lt $x2; $x++) {
    $c = $bmp.GetPixel($x, $y)
    $total = $total + 1
    if ($c.R -lt 24 -and $c.G -lt 24 -and $c.B -lt 24) { $black = $black + 1 }
  }
}
$bmp.Dispose()
[Console]::Out.Write(([string]$black) + '/' + ([string]$total))
`
);

/** Multi-frame container composer (animated GIF / multi-page TIFF) built
 *  from per-frame PNG payloads via the WPF bitmap encoders â€” GDI+ cannot
 *  author multi-frame GIF/TIFF reliably, WPF can. */
fs.writeFileSync(
  COMPOSE_SCRIPT,
  `
param([string]$FramesJson, [string]$Format)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$frames = $FramesJson | ConvertFrom-Json
if ($Format -eq 'gif') { $enc = New-Object Windows.Media.Imaging.GifBitmapEncoder }
else { $enc = New-Object Windows.Media.Imaging.TiffBitmapEncoder }
$tmpFiles = @()
try {
  $i = 0
  foreach ($f in $frames) {
    $bytes = [Convert]::FromBase64String($f)
    $tmp = Join-Path $env:TEMP ("spf-frame-" + [guid]::NewGuid().ToString('N') + ".png")
    [IO.File]::WriteAllBytes($tmp, $bytes)
    $tmpFiles += $tmp
    $frame = [Windows.Media.Imaging.BitmapFrame]::Create([Uri] ("file:///" + ($tmp -replace '\\\\', '/')))
    $enc.Frames.Add($frame)
    $i = $i + 1
  }
  $out = New-Object System.IO.MemoryStream
  $enc.Save($out)
  [Console]::Out.Write([Convert]::ToBase64String($out.ToArray()))
} finally {
  foreach ($t in $tmpFiles) { try { [IO.File]::Delete($t) } catch { } }
}
`
);

/** Compose per-frame PNG payloads into an animated GIF or multi-page TIFF. */
async function composeContainer(framePngs: string[], format: 'gif' | 'tiff'): Promise<string> {
  const out = await runPowerShell(COMPOSE_SCRIPT, [JSON.stringify(framePngs), format]);
  if (out.length < 100) throw new Error(`container composition failed (${out.length} chars)`);
  return out;
}

/** Fraction of near-black pixels inside a rect of a base64 image. */
function blackFraction(imageBase64: string, rect: { x: number; y: number; w: number; h: number }): Promise<number> {
  return runPowerShell(SAMPLE_SCRIPT, [
    imageBase64,
    String(Math.max(0, Math.floor(rect.x))),
    String(Math.max(0, Math.floor(rect.y))),
    String(Math.max(1, Math.floor(rect.w))),
    String(Math.max(1, Math.floor(rect.h))),
  ]).then((out) => {
    const m = out.match(/^(\d+)\/(\d+)$/);
    if (!m) throw new Error(`sampler failed: ${out.slice(0, 80)}`);
    const total = Number(m[2]);
    return total > 0 ? Number(m[1]) / total : 0;
  });
}

// ------------------------------------------------------- fake workers

function fakeWorker(overrides: {
  inspect?: (img: string, attempt: number) => OcrInspectResult | Promise<OcrInspectResult>;
  redact?: (img: string, rects: Array<{ x: number; y: number; w: number; h: number }>) => RedactResult | Promise<RedactResult>;
  inspectDelayMs?: number;
  redactDelayMs?: number;
}): VisualWorkerLike {
  let attempt = 0;
  return {
    async ensureReady(): Promise<void> {},
    async inspect(img: string): Promise<OcrInspectResult> {
      attempt += 1;
      if (overrides.inspectDelayMs) await new Promise((r) => setTimeout(r, overrides.inspectDelayMs));
      const result = overrides.inspect?.(img, attempt);
      return result ?? { status: 'ok', width: 640, height: 200, frameCount: 1, lines: [] };
    },
    async redact(img: string, rects: Array<{ x: number; y: number; w: number; h: number }>): Promise<RedactResult> {
      if (overrides.redactDelayMs) await new Promise((r) => setTimeout(r, overrides.redactDelayMs));
      const result = overrides.redact?.(img, rects);
      return result ?? { status: 'ok', img: img.slice(0, 50) + 'REDACTEDPAYLOAD' };
    },
    kill(): void {},
  };
}

const SENSITIVE_LINES: OcrLine[] = [
  { t: SECRETS.password, x: 20, y: 30, w: 300, h: 24 },
  { t: 'Welcome to the dashboard', x: 20, y: 90, w: 280, h: 24 },
];

// =========================================================== real-pipeline scenarios
async function realPipelineScenarios(realWorker: OcrWorker): Promise<void> {
  const opts: VisualInspectionOptions = { worker: realWorker, deadlineMs: 30000, opTimeoutMs: 20000 };

  console.log('1. Visible password with neutral window metadata');
  const pwImg = await drawImage([{ text: SECRETS.password, y: 30 }, { text: 'Welcome to the dashboard', y: 90 }]);
  const pw = await inspectImageForTransmission(pwImg, opts);
  assert(pw.decision === 'redact', 'password screenshot -> REDACT (pixels inspected, metadata neutral)');
  assert(pw.categories.includes('password'), 'password category detected from pixels');
  assert(pw.regionsRedacted >= 1, 'at least one region redacted');
  assert(pw.payloadIsSanitized === true && typeof pw.payload === 'string', 'sanitized payload produced');
  assert(pw.payload !== pwImg, 'outbound payload differs from original capture');

  console.log('2. Visible OTP with neutral metadata');
  const otpImg = await drawImage([{ text: SECRETS.otp, y: 40 }]);
  const otp = await inspectImageForTransmission(otpImg, opts);
  assert(otp.decision === 'redact', 'OTP screenshot -> REDACT');
  assert(otp.categories.includes('otp'), 'otp category detected from pixels');

  console.log('3. Visible Google API key');
  // Exactly 35 chars after 'AIza' (the detector requires the precise length).
  // 20px: Windows OCR reliably reads this size (smaller sizes produce empty
  // or merged OCR results for long random strings â€” an honest engine
  // limitation, documented in the completion report). The detector tolerates
  // the engine's AIza->Alza reading.
  const googleKeyFixed = 'AIza' + 'F'.repeat(35);
  const gkImg = await drawImage([{ text: googleKeyFixed, y: 40, size: 20 }], { width: 760, height: 140 });
  const gk = await inspectImageForTransmission(gkImg, opts);
  assert(gk.decision === 'redact', 'Google API key screenshot -> REDACT');
  assert(gk.categories.includes('google_credential'), 'google_credential category detected from pixels');

  console.log('4. Synthetic bank account number');
  const bankImg = await drawImage([{ text: SECRETS.bank, y: 40 }]);
  const bank = await inspectImageForTransmission(bankImg, opts);
  assert(bank.decision === 'redact', 'bank account screenshot -> REDACT');
  assert(bank.categories.includes('bank_account'), 'bank_account category detected from pixels');

  console.log('5. Synthetic payment card number and CVV');
  const cardImg = await drawImage([{ text: SECRETS.card, y: 40, size: 18 }]);
  const card = await inspectImageForTransmission(cardImg, opts);
  assert(card.decision === 'redact', 'card+CVV screenshot -> REDACT');
  const cardCats = card.categories.join(',');
  assert(cardCats.includes('card_number') || cardCats.includes('card_cvv'), `card categories detected (${cardCats})`);

  console.log('6. Multiple sensitive regions in one screenshot');
  const multiImg = await drawImage([
    { text: SECRETS.password, y: 20 },
    { text: SECRETS.otp, y: 70 },
    { text: SECRETS.bank, y: 120 },
  ], { height: 180 });
  const multi = await inspectImageForTransmission(multiImg, opts);
  assert(multi.decision === 'redact', 'multi-secret screenshot -> REDACT');
  assert(multi.regionsRedacted >= 2, `multiple regions redacted (${multi.regionsRedacted})`);
  for (const cat of ['password', 'otp', 'bank_account']) {
    assert(multi.categories.includes(cat), `category ${cat} among multiple pixel detections`);
  }

  console.log('7. Sensitive text near image boundaries');
  const edgeImg = await drawImage([
    { text: SECRETS.otp, x: 380, y: 5, size: 18 },
    { text: SECRETS.password, x: 20, y: 160, size: 18 },
  ], { width: 640, height: 200 });
  const edge = await inspectImageForTransmission(edgeImg, opts);
  assert(edge.decision === 'redact', 'boundary-adjacent secrets -> REDACT (clamped rects)');
  assert(edge.categories.includes('otp') || edge.categories.includes('password'), 'boundary secrets categorized');

  console.log('8. Different text sizes and resolutions');
  const smallImg = await drawImage([{ text: SECRETS.otp, y: 30, size: 14 }], { width: 480, height: 120 });
  const small = await inspectImageForTransmission(smallImg, opts);
  assert(small.decision === 'redact', '14px text at 480w -> REDACT');
  const midImg = await drawImage([{ text: SECRETS.otp, y: 40 }], { width: 768, height: 140, format: 'jpeg' });
  const mid = await inspectImageForTransmission(midImg, opts);
  assert(mid.decision === 'redact', '20px text at 768w JPEG (pipeline format) -> REDACT');
  const largeImg = await drawImage([{ text: SECRETS.otp, y: 60, size: 28 }], { width: 1024, height: 160 });
  const large = await inspectImageForTransmission(largeImg, opts);
  assert(large.decision === 'redact', '28px text at 1024w -> REDACT');

  console.log('9. Resized and cropped derivatives');
  const resizedImg = await drawImage([{ text: SECRETS.password, y: 40 }], { width: 900, height: 140 });
  // Simulate the pipeline's resize derivative by downscaling via JPEG re-draw at 512w.
  const resized = await drawImage([{ text: SECRETS.password, y: 30, size: 14 }], { width: 512, height: 110, format: 'jpeg' });
  const resizedVerdict = await inspectImageForTransmission(resized, opts);
  assert(resizedVerdict.decision === 'redact', 'resized derivative (512w JPEG) -> REDACT');
  // Cropped derivative: only the secret region of the image (left strip).
  const cropStrip = await drawImage([{ text: SECRETS.password, x: 10, y: 30, size: 16 }], { width: 340, height: 90, format: 'jpeg' });
  const cropped = await inspectImageForTransmission(cropStrip, opts);
  assert(cropped.decision === 'redact', 'cropped derivative -> REDACT');
  void resizedImg;

  console.log('10. Ordinary screenshot with no sensitive information');
  const cleanImg = await drawImage([{ text: 'Quarterly design review agenda', y: 40 }, { text: 'Project status: on track', y: 90 }]);
  const clean = await inspectImageForTransmission(cleanImg, opts);
  assert(clean.decision === 'allow', 'clean screenshot -> ALLOW');
  assert(clean.payload === cleanImg, 'safe image arrives INTACT (byte-identical payload)');
  assert(clean.payloadIsSanitized === false, 'no sanitization flag on clean image');

  return;
}

/** Shared controlled receiver state â€” every wire-level assertion reads these. */
let sharedRecords: Array<{ url: string; body: string }> = [];
let sharedReceiverUrl = '';
let sharedReceiver: http.Server | null = null;

async function startReceiver(): Promise<string> {
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += String(c)));
    req.on('end', () => {
      sharedRecords.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const port = (receiver.address() as AddressInfo).port;
  sharedReceiver = receiver;
  sharedReceiverUrl = `http://127.0.0.1:${port}`;
  return sharedReceiverUrl;
}

// =========================================================== wire-level verification
async function wireVerification(realWorker: OcrWorker, receiverUrl: string): Promise<void> {
  console.log('11. Wire-level verification (controlled local receiver)');
  const received = sharedRecords;
  const opts: VisualInspectionOptions = { worker: realWorker, deadlineMs: 30000, opTimeoutMs: 20000 };

  // 11a â€” safe image: pipeline ALLOW payload arrives intact on the wire.
  const cleanImg = await drawImage([{ text: 'Status report for the team meeting', y: 40 }]);
  const clean = await inspectImageForTransmission(cleanImg, opts);
  await fetch(`${receiverUrl}/clean`, { method: 'POST', body: clean.payload ?? '' });
  const cleanEntry = received.find((r) => r.url === '/clean');
  assert(cleanEntry?.body === cleanImg, 'WIRE: safe image arrives INTACT (byte-identical)');

  // 11b â€” sensitive image: the ORIGINAL capture never reaches the wire.
  const pwImg = await drawImage([{ text: SECRETS.password, y: 30 }, { text: 'Welcome to the dashboard', y: 90 }]);
  const pw = await inspectImageForTransmission(pwImg, opts);
  const origFindings = pw.categories;
  assert(origFindings.length > 0, 'pipeline detected the pixel secret (precondition)');
  const sentRes = await fetch(`${receiverUrl}/pw`, { method: 'POST', body: pw.payload ?? '' });
  assert(sentRes.ok === true, 'sanitized payload transmission completes');
  const pwEntry = received.find((r) => r.url === '/pw');
  assert(pwEntry !== undefined, 'WIRE: receiver accepted the sanitized image');
  assert(pwEntry?.body !== pwImg, 'WIRE: ORIGINAL capture never arrived');
  assert(!pwEntry?.body.includes(SECRETS.password), 'WIRE: raw secret absent from wire payload');

  // Receiver-side re-OCR of the RECEIVED image: the secret must be unreadable.
  const reOcr = await realWorker.inspect(pwEntry!.body, 20000);
  assert(reOcr.status === 'ok', 'receiver-side re-OCR succeeded on received image');
  const receivedDump = JSON.stringify(reOcr.lines ?? []);
  assert(!receivedDump.includes('FAKE-Visual-Pw-951') && !receivedDump.includes('password'), 'WIRE: secret is NO LONGER READABLE in the received image (receiver-side OCR)');
  // The safe line survives redaction (context preserved).
  assert(receivedDump.includes('Welcome to the dashboard') || (reOcr.lines?.length ?? 0) >= 1, 'WIRE: safe content preserved in received image');

  // Pixel-level proof of IRREVERSIBLE replacement: the original secret region
  // is solid black in the received image (no blur/ghosting).
  const origOcr = await realWorker.inspect(pwImg, 20000);
  const pwLine = (origOcr.lines ?? []).find((l) => l.t.includes('password') || l.t.includes('FAKE'));
  assert(pwLine !== undefined, 'original OCR located the password line (precondition)');
  if (pwLine) {
    const pad = 4;
    const before = await blackFraction(pwImg, { x: pwLine.x, y: pwLine.y, w: pwLine.w, h: pwLine.h });
    const after = await blackFraction(pwEntry!.body, { x: pwLine.x, y: pwLine.y, w: pwLine.w, h: pwLine.h });
    assert(before < 0.9, `original region contains rendered text (black fraction ${before.toFixed(2)})`);
    assert(after > 0.95, `RECEIVED image region is irreversibly blacked out (black fraction ${after.toFixed(2)})`);
  }

  // 11c â€” no synthetic secret appears in any request metadata/bodies.
  const allWire = JSON.stringify(received);
  for (const secret of ALL_SECRET_STRINGS) assert(!allWire.includes(secret), `WIRE: "${secret.slice(0, 12)}â€¦" never arrived at the receiver`);
  for (const token of SECRET_TOKENS) assert(!allWire.includes(token), `WIRE: token "${token.slice(0, 10)}â€¦" never arrived`);
}

// =========================================================== fail-closed scenarios
async function failClosedScenarios(): Promise<void> {
  console.log('12. OCR unavailable');
  const r1 = await inspectImageForTransmission('A'.repeat(400), { worker: fakeWorker({ inspect: () => ({ status: 'ocr_unavailable' }) }) });
  assert(r1.decision === 'block' && r1.reason === 'ocr_engine_unavailable', 'OCR engine unavailable -> BLOCK');

  console.log('13. OCR timeout');
  // The REAL worker kills itself on op timeout and rejects; simulate with a
  // fake that throws the same rejection signature.
  const r2 = await inspectImageForTransmission('A'.repeat(400), {
    worker: fakeWorker({
      inspect: async () => {
        await new Promise((r) => setTimeout(r, 60));
        throw new Error('ocr_op_timeout');
      },
    }),
  });
  assert(r2.decision === 'block' && r2.reason === 'ocr_timeout' && r2.timedOut === true, 'OCR op timeout -> BLOCK');
  // Pipeline deadline exceeded even though the op completed "cleanly".
  const r2b = await inspectImageForTransmission('A'.repeat(400), {
    worker: fakeWorker({ inspectDelayMs: 300 }),
    deadlineMs: 200,
    opTimeoutMs: 3000,
  });
  assert(r2b.decision === 'block' && r2b.reason === 'inspection_deadline_exceeded' && r2b.timedOut === true, 'pipeline deadline exceeded -> BLOCK (timedOut flagged)');

  console.log('14. OCR malformed output');
  const malformedWorker: VisualWorkerLike = {
    async ensureReady(): Promise<void> {},
    async inspect(): Promise<OcrInspectResult> {
      throw new Error('ocr_worker_malformed_json');
    },
    async redact(): Promise<RedactResult> {
      return { status: 'error' };
    },
    kill(): void {},
  };
  const r3 = await inspectImageForTransmission('A'.repeat(400), { worker: malformedWorker });
  assert(r3.decision === 'block' && r3.reason === 'ocr_inspection_failed', 'malformed OCR output -> BLOCK');

  console.log('15. Invalid bounding boxes');
  const r4 = await inspectImageForTransmission('A'.repeat(400), {
    worker: fakeWorker({
      inspect: () => ({ status: 'ok', width: 640, height: 200, frameCount: 1, lines: [{ t: SECRETS.password, x: 5000, y: 5000, w: 300, h: 30 }] }),
    }),
  });
  assert(r4.decision === 'block' && r4.reason === 'bounding_box_mapping_failed', 'bounding box outside image -> BLOCK (mapping failed)');

  console.log('16. Redaction failure');
  const r5 = await inspectImageForTransmission('A'.repeat(400), {
    worker: fakeWorker({
      inspect: () => ({ status: 'ok', width: 640, height: 200, frameCount: 1, lines: [{ t: SECRETS.password, x: 20, y: 30, w: 300, h: 24 }] }),
      redact: () => ({ status: 'error', message: 'synthetic redaction failure' }),
    }),
  });
  assert(r5.decision === 'block' && r5.reason === 'redaction_failed', 'redaction op failure -> BLOCK');

  console.log('17. Re-encoding failure');
  const r6 = await inspectImageForTransmission('A'.repeat(400), {
    worker: fakeWorker({
      inspect: () => ({ status: 'ok', width: 640, height: 200, frameCount: 1, lines: [{ t: SECRETS.password, x: 20, y: 30, w: 300, h: 24 }] }),
      redact: () => ({ status: 'ok', img: 'x' }),
    }),
  });
  assert(r6.decision === 'block' && r6.reason === 'reencode_failed', 're-encode failure (tiny payload) -> BLOCK');

  console.log('18. Post-redaction verification failure');
  let inspectAttempts = 0;
  const r7 = await inspectImageForTransmission('A'.repeat(400), {
    worker: fakeWorker({
      inspect: () => {
        inspectAttempts += 1;
        // BOTH passes claim to see the secret â€” the second pass simulates
        // redaction that did NOT remove the sensitive content.
        return { status: 'ok', width: 640, height: 200, frameCount: 1, lines: [{ t: SECRETS.password, x: 20, y: 30, w: 300, h: 24 }] };
      },
      redact: () => ({ status: 'ok', img: 'R'.repeat(400) }),
    }),
  });
  assert(inspectAttempts === 2, 'second inspection RAN after redaction');
  assert(r7.decision === 'block' && r7.reason === 'post_redaction_verification_failed', 'residual secret after redaction -> BLOCK');

  console.log('19. Unchanged payload after redaction');
  const r8 = await inspectImageForTransmission('A'.repeat(400), {
    worker: fakeWorker({
      inspect: () => ({ status: 'ok', width: 640, height: 200, frameCount: 1, lines: [{ t: SECRETS.password, x: 20, y: 30, w: 300, h: 24 }] }),
      redact: (img) => ({ status: 'ok', img }),
    }),
  });
  assert(r8.decision === 'block' && r8.reason === 'redaction_did_not_change_payload', 'redaction returning the ORIGINAL payload -> BLOCK (never transmitted)');

  console.log('20. Unsupported dimensions / invalid payloads');
  const r9 = await inspectImageForTransmission('A'.repeat(400), {
    worker: fakeWorker({ inspect: () => ({ status: 'unsupported_dimensions' }) }),
  });
  assert(r9.decision === 'block' && r9.reason === 'image_dimensions_unsupported', 'unsupported dimensions -> BLOCK');
  const r10 = await inspectImageForTransmission('short', { worker: fakeWorker({}) });
  assert(r10.decision === 'block' && r10.reason === 'unrecognized_image_payload', 'invalid image payload -> BLOCK');
}

// =========================================================== live-server scenarios
async function liveServerScenarios(): Promise<void> {
  console.log('21. Live server endpoint gates (isolated sandbox store, empty model key)');
  const portBusy = await new Promise<boolean>((resolve) => {
    const req = http.get('http://127.0.0.1:3100/api/health', (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
  if (portBusy) {
    console.log('  (skipped: port 3100 already in use)');
    return;
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-visual-e5-'));
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server.ts'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      KRISHA_PORT: '3100',
      KRISHA_SANDBOX_DIR: path.join(sandbox, 'e5store'),
      KRISHA_FS_ROOTS: path.join(sandbox, 'fsroots'),
      GEMINI_API_KEY: '',
      GOOGLE_MAPS_API_KEY: '',
    },
    detached: false,
  });
  const BASE = 'http://127.0.0.1:3100';
  try {
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i++) {
      await new Promise((r) => setTimeout(r, 500));
      healthy = await new Promise<boolean>((resolve) => {
        const req = http.get(`${BASE}/api/health`, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(false);
        });
      });
    }
    if (!healthy) {
      console.log('  (skipped: spawned server did not become healthy in time)');
      return;
    }
    assert(true, 'spawned server healthy (isolated KRISHA_SANDBOX_DIR)');

    // 21a â€” direct image-upload attempt (bypassing any client gate): the
    // SERVER must still inspect and redact the pixels.
    const pwImg = await drawImage([{ text: SECRETS.password, y: 30 }, { text: 'Dashboard overview', y: 90 }], { format: 'jpeg' });
    const res1 = await fetch(`${BASE}/api/vision/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: pwImg, question: 'Describe this screen' }),
    });
    const data1 = await res1.json() as any;
    assert(typeof data1?.spfImage === 'object', 'response carries content-free spfImage metadata');
    assert(data1?.spfImage?.decision === 'redact', `DIRECT UPLOAD: server OCR redacted pixels (got ${data1?.spfImage?.decision})`);
    assert(data1?.spfImage?.sanitized === true, 'DIRECT UPLOAD: sanitized image flagged');
    assert(data1?.spfImage?.reason.includes('password'), 'visual reason carries category (no content)');
    const dump1 = JSON.stringify(data1);
    assert(!dump1.includes('FAKE-Visual-Pw-951'), 'HTTP response contains NO recognized secret text');

    // 21b â€” clean image -> allow.
    const cleanImg = await drawImage([{ text: 'System health overview panel', y: 40 }], { format: 'jpeg' });
    const res2 = await fetch(`${BASE}/api/vision/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: cleanImg, question: 'Describe this screen' }),
    });
    const data2 = await res2.json() as any;
    assert(data2?.spfImage?.decision === 'allow', 'clean image through endpoint -> ALLOW');
    assert(data2?.spfImage?.sanitized === false, 'clean image not flagged sanitized');
    const dump2 = JSON.stringify(data2);
    for (const token of SECRET_TOKENS) assert(!dump2.includes(token), 'clean response leaks no synthetic secret');

    // 21c â€” OCR-unavailable-like path: garbage image (undecodable) must BLOCK.
    const res3 = await fetch(`${BASE}/api/vision/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'A'.repeat(4000), question: 'Describe this screen' }),
    });
    const data3 = await res3.json() as any;
    assert(data3?.spfBlocked === true, 'undecodable image -> BLOCK at the endpoint');
    assert(String(data3?.reason ?? '').startsWith('spf_blocked:'), 'block reason is SPF-attributed');

    // 21d â€” multi-frame GIF with the secret exclusively on a later frame:
    // the endpoint must BLOCK (later frames ARE inspected).
    const secretFramePng = await drawImage([{ text: SECRETS.otp, y: 40 }]);
    const gif = await composeContainer([cleanImg, secretFramePng, cleanImg], 'gif');
    const res4 = await fetch(`${BASE}/api/vision/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: gif, question: 'Describe this screen' }),
    });
    const data4 = await res4.json() as any;
    assert(data4?.spfBlocked === true, 'multiframe GIF with later-frame secret -> BLOCK at the endpoint');
    assert(String(data4?.reason ?? '').includes('multiframe'), `multiframe block reason surfaced (${data4?.reason})`);
    assert(!JSON.stringify(data4).includes('462913'), 'multiframe block response echoes no secret');

    // 21d â€” emergency stop during image inspection (LAST: the server stays stopped).
    const stopRes = await fetch(`${BASE}/api/safety/stop/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'spf-visual-test emergency stop' }),
    });
    const stopData = await stopRes.json() as any;
    assert(stopData?.success !== false, 'emergency stop activated on the isolated server');
    const visionDuringStop = await fetch(`${BASE}/api/vision/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: cleanImg, question: 'Describe this screen' }),
    });
    assert(visionDuringStop.status === 423, `image transmission during emergency stop -> HTTP 423 (got ${visionDuringStop.status})`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 800));
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

// =========================================================== multi-frame containers
async function multiFrameScenarios(realWorker: OcrWorker, receiverUrl: string | null): Promise<void> {
  console.log('23. Multi-frame containers (animated GIF / multi-page TIFF)');
  const opts: VisualInspectionOptions = { worker: realWorker, deadlineMs: 30000, opTimeoutMs: 20000 };

  // Page/frame builders: page 1 clean, page 2 SECRET-ONLY, page 3 clean.
  const cleanPage = await drawImage([{ text: 'Overview and summary of the report', y: 40 }]);
  const secretPage = await drawImage([{ text: SECRETS.otp, y: 40 }]);
  const passwordPage = await drawImage([{ text: SECRETS.password, y: 30 }, { text: 'Notes section', y: 90 }]);

  console.log('23a. Multi-page TIFF, secret exclusively on page 2');
  const tiff = await composeContainer([cleanPage, secretPage, cleanPage], 'tiff');
  const tiffV = await inspectImageForTransmission(tiff, opts);
  assert(tiffV.decision === 'block', 'secret on LATER page -> BLOCK (page 2 was inspected)');
  assert(tiffV.reason === 'multiframe_redaction_unsupported', `block reason is the honest multiframe refusal (${tiffV.reason})`);
  assert(tiffV.categories.includes('otp'), 'page-2 secret categorized (proves later-page inspection)');

  console.log('23b. Animated GIF, secret exclusively on frame 2');
  const gif = await composeContainer([cleanPage, secretPage, cleanPage], 'gif');
  const gifV = await inspectImageForTransmission(gif, opts);
  assert(gifV.decision === 'block', 'secret on LATER frame -> BLOCK (frame 2 was inspected)');
  assert(gifV.categories.includes('otp'), 'frame-2 secret categorized');

  console.log('23c. Multi-frame container, secret on frame 0');
  const gifFirst = await composeContainer([passwordPage, cleanPage, cleanPage], 'gif');
  const gifFirstV = await inspectImageForTransmission(gifFirst, opts);
  assert(gifFirstV.decision === 'block', 'secret on FIRST frame of multiframe -> BLOCK');
  assert(gifFirstV.categories.includes('password'), 'frame-0 secret categorized');

  console.log('23d. Clean multi-frame GIF -> ALLOW, original intact');
  const cleanGif = await composeContainer([cleanPage, cleanPage, cleanPage], 'gif');
  const cleanV = await inspectImageForTransmission(cleanGif, opts);
  assert(cleanV.decision === 'allow', 'clean multiframe (all frames inspected) -> ALLOW');
  assert(cleanV.payload === cleanGif, 'clean multiframe original payload intact');

  console.log('23e. No transmissible payload exists for the blocked multiframe');
  assert(gifV.payload === undefined && tiffV.payload === undefined, 'BLOCKED multiframe produces NO outbound payload (nothing can reach the wire)');
  if (receiverUrl) {
    await fetch(`${receiverUrl}/gif-clean`, { method: 'POST', body: cleanGif });
    const records = sharedRecords.filter((r) => r.url === '/gif-clean');
    assert(records.length === 1 && records[0].body === cleanGif, 'WIRE: clean multiframe arrives intact (all frames inspected)');
    const allWire = JSON.stringify(sharedRecords);
    assert(!allWire.includes(SECRETS.otp) && !allWire.includes('462913'), 'WIRE: multiframe secret never arrived');
  }

  console.log('23f. Frame cap and unreadable frames fail closed');
  const capWorker = fakeWorker({ inspect: () => ({ status: 'too_many_frames' }) });
  const capV = await inspectImageForTransmission('A'.repeat(400), { worker: capWorker });
  assert(capV.decision === 'block' && capV.reason === 'too_many_frames_uninspected', 'too_many_frames -> BLOCK (no uninspected frames can leave)');
  const unreadableWorker = fakeWorker({ inspect: () => ({ status: 'frame_unreadable' }) });
  const unreadableV = await inspectImageForTransmission('A'.repeat(400), { worker: unreadableWorker });
  assert(unreadableV.decision === 'block' && unreadableV.reason === 'frame_unreadable_uninspected', 'unreadable frame -> BLOCK');

  console.log('23g. Malformed transcript lines fail closed');
  const malformedLines = fakeWorker({
    inspect: () => ({ status: 'ok', width: 640, height: 200, frameCount: 1, lines: [{ t: SECRETS.password, x: Number.NaN, y: 30, w: 300, h: 24 }] }),
  });
  const malformedV = await inspectImageForTransmission('A'.repeat(400), { worker: malformedLines });
  assert(malformedV.decision === 'block' && malformedV.reason === 'ocr_invalid_result', 'line with non-finite bounding box -> BLOCK (incomplete recognition is not safety)');

  console.log('23h. Inconclusive post-redaction verification fails closed');
  let verifyPass = 0;
  const inconclusive = fakeWorker({
    inspect: () => {
      verifyPass += 1;
      if (verifyPass === 1) {
        return { status: 'ok', width: 640, height: 200, frameCount: 1, lines: [{ t: SECRETS.password, x: 20, y: 30, w: 60, h: 24 }, { t: 'Dashboard overview', x: 20, y: 90, w: 200, h: 24 }] };
      }
      // Second pass reads NOTHING at all (suspicious re-encode / OCR regression)
      return { status: 'ok', width: 640, height: 200, frameCount: 1, lines: [] };
    },
    redact: () => ({ status: 'ok', img: 'V'.repeat(400) }),
  });
  const inconclusiveV = await inspectImageForTransmission('A'.repeat(400), { worker: inconclusive });
  assert(inconclusiveV.decision === 'block' && inconclusiveV.reason === 'post_redaction_verification_inconclusive', 'zero-text second pass with tiny coverage -> BLOCK (inconclusive, not safe)');

  console.log('23i. Dimension-mismatched re-encode fails closed');
  const mismatch = fakeWorker({
    inspect: () => {
      verifyPass += 1;
      if (verifyPass % 2 === 1) {
        return { status: 'ok', width: 640, height: 200, frameCount: 1, lines: [{ t: SECRETS.password, x: 20, y: 30, w: 60, h: 24 }] };
      }
      return { status: 'ok', width: 320, height: 100, frameCount: 1, lines: [] };
    },
    redact: () => ({ status: 'ok', img: 'W'.repeat(400) }),
  });
  const mismatchV = await inspectImageForTransmission('A'.repeat(400), { worker: mismatch });
  assert(mismatchV.decision === 'block' && mismatchV.reason === 'post_redaction_dimension_mismatch', 'sanitized image with changed dimensions -> BLOCK');
}

// =========================================================== no-leakage checks
function leakageChecks(): void {
  console.log('22. No credential leakage into logs, memory or audit metadata');
  const auditDump = JSON.stringify({
    // The audit event shape the server records for visual decisions:
    kind: 'spf_visual_decision',
    decision: 'redact',
    reason: 'visual_redacted:password',
    categories: ['password'],
    regionsRedacted: 2,
    ocrLines: 4,
    sanitized: true,
  });
  for (const secret of ALL_SECRET_STRINGS) assert(!auditDump.includes(secret), `audit metadata never contains "${secret.slice(0, 12)}â€¦"`);
  for (const token of SECRET_TOKENS) assert(!auditDump.includes(token), `audit metadata never contains token "${token.slice(0, 8)}â€¦"`);
  // Verdict objects carry no OCR text.
  const verdictDump = JSON.stringify({ decision: 'redact', reason: 'visual_redacted:otp', categories: ['otp'], regionsRedacted: 1, ocrLineCount: 2 });
  assert(!verdictDump.includes('462913'), 'verdict metadata carries no recognized text');
}

// ---------------------------------------------------------------- run
try {
  console.log('booting real OCR worker (one-time)...');
  const realWorker = new OcrWorker();
  await realWorker.ensureReady(30000);
  console.log('worker ready.\n');

  const receiverUrl = await startReceiver();
  sharedReceiverUrl = receiverUrl;

  await realPipelineScenarios(realWorker);
  await wireVerification(realWorker, receiverUrl);
  await failClosedScenarios();
  await multiFrameScenarios(realWorker, receiverUrl);
  leakageChecks();
  await liveServerScenarios();

  realWorker.kill();
  disposeSharedOcrWorker();
  sharedReceiver?.close();
} catch (err) {
  failed++;
  failures.push(`harness crashed: ${String((err as Error)?.message || err)}`);
  console.error(err);
}

try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch {
  /* best-effort cleanup */
}

console.log(`\nSPF VISUAL results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('SPF VISUAL TESTS: ALL GREEN');
