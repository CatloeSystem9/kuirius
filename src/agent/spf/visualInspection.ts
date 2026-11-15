/**
 * SPF VISUAL INSPECTION — local OCR of actual screenshot pixels.
 *
 * Closes the audited gap: the metadata-only image gate cannot see a password
 * rendered inside a screenshot whose window title, question and prior texts
 * are clean. This module gives SPF actual pixel inspection WITHOUT adding
 * any dependency and WITHOUT any network use:
 *
 *   OCR engine: Windows.Media.Ocr (WinRT), driven through a persistent
 *   PowerShell worker process (same zero-dependency pattern as the Phase 5
 *   mouse / Phase 6 keyboard workers). Fully offline; engine languages are
 *   the OS-installed OCR languages; engine unavailability is a BLOCK.
 *
 * Pipeline (deadline-budgeted, fail-closed):
 *   1. OCR inspect   — decode (WinRT BitmapDecoder: JPEG/PNG/BMP/GIF/TIFF)
 *                      and recognize; returns line texts + bounding rects.
 *   2. Detection     — the EXISTING SPF detector engine (`scanText`) runs on
 *                      each recognized line (no competing detector system).
 *   3. Redaction     — matched line regions are filled with SOLID BLACK in
 *                      the actual pixels (System.Drawing), padding-expanded
 *                      and clamped; image re-encoded as JPEG.
 *   4. Verification  — the sanitized image is OCR'd AGAIN and re-scanned;
 *                      residual sensitive content, OCR errors, re-encode
 *                      failures or an unchanged payload force a BLOCK.
 *
 * SECURITY PROPERTIES:
 *  - screenshots and recognized text never leave the device for the decision;
 *  - recognized text is used only for detection and is NEVER logged,
 *    persisted or audited (audit carries categories/counts only);
 *  - every failure mode (engine unavailable, init/timeout/malformed, decode/
 *    encode failure, bad bounding boxes, verification failure) BLOCKS;
 *  - no override parameter exists;
 *  - OCR EXECUTION SUCCESS IS NOT DETECTION SUCCESS: a valid-but-empty OCR
 *    result (status ok, zero lines) is a legitimate inspection outcome that
 *    means "no READABLE text found" — it is never proof that an image
 *    contains no sensitive content (unrecognizable text, tiny/low-contrast
 *    fonts and exotic renderings remain an honest limitation). The emptiness
 *    is surfaced (ocrLineCount/frames metadata in audit + response) rather
 *    than silent. Engine failures are never treated as "no text";
 *  - malformed transcripts (lines without complete finite bounding boxes)
 *    are a BLOCK, not a best-effort redaction;
 *  - EVERY frame/page of a container (animated GIF, multi-page TIFF) is
 *    OCR-inspected — frame-count cap exceeded or any unreadable frame is a
 *    BLOCK; sensitive content in ANY frame of a multi-frame container blocks
 *    the transmission (GDI+ cannot re-encode edited multi-frame containers).
 *
 * NODE-ONLY: imports node:child_process — import this module only from the
 * server entrypoint and tests, never from browser code.
 */
import { spawn } from 'node:child_process';

import { scanText } from './detectors';
import type { SpfFinding } from './spfTypes';

// ------------------------------------------------------------------ types

export interface OcrLine {
  /** Recognized text (LOCAL ONLY — never logged, persisted or audited). */
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Frame/page index the line was recognized in (multi-frame GIF/TIFF). */
  f?: number;
}

export interface OcrInspectResult {
  status: 'ok' | 'ocr_unavailable' | 'unsupported_dimensions' | 'too_many_frames' | 'frame_unreadable' | 'error';
  width?: number;
  height?: number;
  /** Every frame/page of the container is inspected; 1 for plain JPEG/PNG. */
  frameCount?: number;
  lines?: OcrLine[];
  message?: string;
}

export interface RedactResult {
  status: 'ok' | 'error';
  img?: string;
  message?: string;
}

/** Minimal worker surface — injectable for tests (fail-closed scenarios). */
export interface VisualWorkerLike {
  ensureReady(timeoutMs: number): Promise<void>;
  inspect(imageBase64: string, timeoutMs: number): Promise<OcrInspectResult>;
  redact(imageBase64: string, rects: Array<{ x: number; y: number; w: number; h: number }>, timeoutMs: number): Promise<RedactResult>;
  kill(): void;
}

export interface VisualInspectionResult {
  decision: 'allow' | 'redact' | 'block';
  /** Content-free machine reason. */
  reason: string;
  /** Detection categories involved (labels only). */
  categories: string[];
  regionsRedacted: number;
  ocrLineCount: number;
  /** The image that may be transmitted (original for allow, sanitized for redact). */
  payload?: string;
  payloadIsSanitized: boolean;
  timedOut?: boolean;
}

export interface VisualInspectionOptions {
  /** Test injection: replaces the real PowerShell OCR worker. */
  worker?: VisualWorkerLike;
  /** Total budget for inspect+redact+verify (default 6000ms). */
  deadlineMs?: number;
  /** Per-operation timeout (default 4000ms). */
  opTimeoutMs?: number;
  /** Padding applied to redaction rects (default 6px). */
  redactPaddingPx?: number;
}

// ---------------------------------------------------------------- worker

const OCR_MAX_DIMENSION = 8192; // engine hard max is 10000; keep bounded
/** Bounded work per container: more frames/pages than this → BLOCK. */
const OCR_MAX_FRAMES = 16;

const PS_BOOTSTRAP = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]0x60 + '1' })[0]
function Await-Op($WinRtTask, $ResultType) {
  $asTask = $script:AsTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataWriter,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapPixelFormat,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapAlphaMode,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
$script:OcrEngine = $null
function Get-OcrEngine {
  if ($null -ne $script:OcrEngine) { return $script:OcrEngine }
  $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
  if ($null -eq $langs -or $langs.Count -eq 0) { return $null }
  $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $e) { $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langs[0]) }
  $script:OcrEngine = $e
  return $e
}
function Get-SoftBitmaps($bytes) {
  # EVERY frame/page of the container is decoded (animated GIF frames,
  # multi-page TIFF pages). BitmapDecoder.GetFrameAsync enumerates them;
  # GetSoftwareBitmapAsync alone would silently decode only frame 0.
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
  $writer.WriteBytes($bytes)
  (Await-Op ($writer.StoreAsync()) ([UInt32])) | Out-Null
  (Await-Op ($writer.FlushAsync()) ([bool])) | Out-Null
  $writer.DetachStream() | Out-Null
  $stream.Seek(0) | Out-Null
  $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $frameCount = [int]$decoder.FrameCount
  if ($frameCount -gt ${OCR_MAX_FRAMES}) { return @{ tooMany = $true } }
  $bitmaps = @()
  for ($i = 0; $i -lt $frameCount; $i++) {
    $frame = Await-Op ($decoder.GetFrameAsync([uint32]$i)) ([Windows.Graphics.Imaging.BitmapFrame])
    $soft = Await-Op ($frame.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $bitmaps += ,$soft
  }
  return @{ bitmaps = $bitmaps; frameCount = $frameCount }
}
function Get-OcrLines($engine, $soft, $frameIndex) {
  $res = Await-Op ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $res.Lines) {
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0; $words = 0
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect; $words = $words + 1
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    }
    if ($words -gt 0) {
      $lines += ,@{ t = $line.Text; x = [math]::Floor($minX); y = [math]::Floor($minY); w = [math]::Ceiling($maxX - $minX); h = [math]::Ceiling($maxY - $minY); f = [int]$frameIndex }
    }
  }
  return @{ lines = $lines }
}
function New-JpegParams {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $p = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]65)
  return @{ codec = $codec; params = $p }
}
Write-Output 'SPF_OCR_BOOT_OK'
[Console]::Out.Flush()
`;

/**
 * Per-request op scripts (the proven PowerShellWorker pattern: the host
 * reads complete statements per request — a REPL loop reading
 * [Console]::In would fight the host's own stdin read-ahead buffering).
 * Function definitions persist in the session from boot.
 */
function buildInspectScript(id: number, imageBase64: string): string {
  // base64 alphabet contains no single quotes — safe literal embedding.
  return `
$reqId = ${id}
$out = $null
try {
  $reqImg = '${imageBase64}'
  $engine = Get-OcrEngine
  if ($null -eq $engine) {
    $out = @{ status = 'ocr_unavailable' }
  } else {
    $bytes = [Convert]::FromBase64String($reqImg)
    $decoded = Get-SoftBitmaps $bytes
    if ($decoded.tooMany) {
      $out = @{ status = 'too_many_frames' }
    } else {
      $outWidth = 0; $outHeight = 0
      $allLines = @()
      $tooBig = $false
      for ($i = 0; $i -lt $decoded.bitmaps.Count; $i++) {
        $bmp = $decoded.bitmaps[$i]
        if (-not $tooBig) {
          if ($bmp.PixelWidth -gt ${OCR_MAX_DIMENSION} -or $bmp.PixelHeight -gt ${OCR_MAX_DIMENSION}) {
            $tooBig = $true
          } else {
            if ($i -eq 0) { $outWidth = $bmp.PixelWidth; $outHeight = $bmp.PixelHeight }
            $ocr = Get-OcrLines $engine $bmp $i
            $allLines += @($ocr.lines)
          }
        }
        try { $bmp.Dispose() } catch { }
      }
      if ($tooBig) {
        $out = @{ status = 'unsupported_dimensions' }
      } else {
        $out = @{ status = 'ok'; width = $outWidth; height = $outHeight; frameCount = $decoded.frameCount; lines = $allLines }
      }
    }
  }
} catch {
  $msg = ''
  if ($_.Exception -and $_.Exception.Message) { $msg = $_.Exception.Message }
  if ($msg.Length -gt 160) { $msg = $msg.Substring(0, 160) }
  $out = @{ status = 'error'; message = $msg }
}
Write-Output ('OUT ' + ($out | ConvertTo-Json -Compress -Depth 6))
Write-Output ('REQDONE ' + $reqId)
[Console]::Out.Flush()
`;
}

function buildRedactScript(
  id: number,
  imageBase64: string,
  rects: Array<{ x: number; y: number; w: number; h: number }>
): string {
  const rectLiterals = rects
    .slice(0, 200)
    .map((r) => `@{ x = ${Math.floor(r.x)}; y = ${Math.floor(r.y)}; w = ${Math.ceil(r.w)}; h = ${Math.ceil(r.h)} }`)
    .join(', ');
  return `
$reqId = ${id}
$reqRects = @(${rectLiterals})
$out = $null
try {
  $reqImg = '${imageBase64}'
  $bytes = [Convert]::FromBase64String($reqImg)
  $msIn = New-Object System.IO.MemoryStream(, $bytes)
  $bmp = New-Object System.Drawing.Bitmap($msIn)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $brush = [System.Drawing.Brushes]::Black
  foreach ($r in $reqRects) {
    $x = [math]::Max(0, [math]::Floor($r.x))
    $y = [math]::Max(0, [math]::Floor($r.y))
    $x2 = [math]::Min($bmp.Width, [math]::Ceiling($r.x + $r.w))
    $y2 = [math]::Min($bmp.Height, [math]::Ceiling($r.y + $r.h))
    if ($x2 -gt $x -and $y2 -gt $y) { $g.FillRectangle($brush, $x, $y, $x2 - $x, $y2 - $y) }
  }
  $g.Dispose()
  $jp = New-JpegParams
  $msOut = New-Object System.IO.MemoryStream
  $bmp.Save($msOut, $jp.codec, $jp.params)
  $bmp.Dispose()
  $msIn.Dispose()
  $out = @{ status = 'ok'; img = [Convert]::ToBase64String($msOut.ToArray()) }
  $msOut.Dispose()
} catch {
  $msg = ''
  if ($_.Exception -and $_.Exception.Message) { $msg = $_.Exception.Message }
  if ($msg.Length -gt 160) { $msg = $msg.Substring(0, 160) }
  $out = @{ status = 'error'; message = $msg }
}
Write-Output ('OUT ' + ($out | ConvertTo-Json -Compress -Depth 6))
Write-Output ('REQDONE ' + $reqId)
[Console]::Out.Flush()
`;
}

export class OcrWorker implements VisualWorkerLike {
  private proc: ReturnType<typeof spawn> | null = null;
  private buffer = '';
  private bootBuffer = '';
  private booted = false;
  private booting: Promise<void> | null = null;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { id: number; resolve: (out: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private pendingCount = 0;

  ensureReady(timeoutMs: number): Promise<void> {
    if (this.booted && this.proc && !this.proc.killed) return Promise.resolve();
    if (!this.booting) {
      this.booting = this.boot(timeoutMs).then(() => {
        this.booting = null;
      }, (err) => {
        this.booting = null;
        throw err;
      });
    }
    return this.booting;
  }

  private boot(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.buffer = '';
        this.bootBuffer = '';
        this.booted = false;
        this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        reject(new Error(`ocr_worker_spawn_failed: ${String((err as Error)?.message || err)}`));
        return;
      }
      const timer = setTimeout(() => {
        this.kill();
        reject(new Error('ocr_worker_boot_timeout'));
      }, timeoutMs);
      this.proc.stdout!.on('data', (d: Buffer) => {
        const chunk = String(d);
        if (!this.booted) {
          this.bootBuffer += chunk;
          if (this.bootBuffer.includes('SPF_OCR_BOOT_OK')) {
            this.booted = true;
            this.bootBuffer = '';
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        this.buffer += chunk;
        this.tryCompletePending();
      });
      this.proc.stderr!.on('data', () => {
        /* stderr noise ignored */
      });
      this.proc.on('exit', () => {
        this.proc = null;
        this.booted = false;
        if (this.pending) {
          clearTimeout(this.pending.timer);
          const p = this.pending;
          this.pending = null;
          this.pendingCount = 0;
          p.reject(new Error('ocr_worker_exited'));
        }
      });
      this.proc.stdin!.write(PS_BOOTSTRAP + '\n');
    });
  }

  private tryCompletePending(): void {
    if (!this.pending) return;
    const id = this.pending.id;
    const marker = `REQDONE ${id}`;
    const idx = this.buffer.indexOf(marker);
    if (idx < 0) return;
    const output = this.buffer.slice(0, idx);
    // Trim consumed output — the buffer must not grow across calls (redact
    // responses carry full image payloads).
    this.buffer = this.buffer.slice(idx + marker.length);
    const p = this.pending;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(output);
  }

  private runOp(build: (id: number) => string, timeoutMs: number): Promise<string> {
    if (!this.booted) return Promise.reject(new Error('ocr_worker_not_ready'));
    if (this.pendingCount >= 8) return Promise.reject(new Error('ocr_worker_queue_full'));
    this.pendingCount += 1;
    const task = this.queue.then(
      () =>
        new Promise<string>((resolve, reject) => {
          const id = ++this.seq;
          const timer = setTimeout(() => {
            // Kill + reboot: a timed-out op desyncs the script protocol.
            this.kill();
            reject(new Error('ocr_op_timeout'));
          }, timeoutMs);
          this.pending = { id, resolve, reject, timer };
          try {
            this.proc!.stdin!.write(build(id) + '\n');
          } catch (err) {
            clearTimeout(timer);
            this.pending = null;
            this.pendingCount -= 1;
            reject(new Error(`ocr_worker_write_failed: ${String((err as Error)?.message || err)}`));
          }
        })
    );
    const settled = task.finally(() => {
      this.pendingCount -= 1;
    });
    this.queue = settled.catch(() => undefined);
    return settled;
  }

  async inspect(imageBase64: string, timeoutMs: number): Promise<OcrInspectResult> {
    const out = await this.runOp((id) => buildInspectScript(id, imageBase64), timeoutMs);
    return parseWorkerJson<OcrInspectResult>(out);
  }

  async redact(
    imageBase64: string,
    rects: Array<{ x: number; y: number; w: number; h: number }>,
    timeoutMs: number
  ): Promise<RedactResult> {
    const out = await this.runOp((id) => buildRedactScript(id, imageBase64, rects), timeoutMs);
    return parseWorkerJson<RedactResult>(out);
  }

  kill(): void {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.booted = false;
    this.pendingCount = 0;
  }
}

/** Worker boot writes PS_BOOTSTRAP (definitions + BOOT_OK), then PS_LOOP. */

function parseWorkerJson<T>(output: string): T {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const outLine = lines.reverse().find((l) => l.startsWith('OUT '));
  if (!outLine) throw new Error('ocr_worker_malformed_output');
  try {
    return JSON.parse(outLine.slice(4)) as T;
  } catch {
    throw new Error('ocr_worker_malformed_json');
  }
}

// ------------------------------------------------------- singleton worker

let sharedWorker: OcrWorker | null = null;

function getSharedWorker(): OcrWorker {
  if (!sharedWorker) sharedWorker = new OcrWorker();
  return sharedWorker;
}

// ---------------------------------------------------------------- pipeline

const MAX_LINE_COUNT = 400; // bounded work per image

function block(reason: string, extra: Partial<VisualInspectionResult> = {}): VisualInspectionResult {
  return { decision: 'block', reason, categories: [], regionsRedacted: 0, ocrLineCount: 0, payloadIsSanitized: false, ...extra };
}

function clampRect(
  r: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
  padding: number
): { x: number; y: number; w: number; h: number } | null {
  const x = Math.max(0, Math.floor(r.x - padding));
  const y = Math.max(0, Math.floor(r.y - padding));
  const x2 = Math.min(width, Math.ceil(r.x + r.w + padding));
  const y2 = Math.min(height, Math.ceil(r.y + r.h + padding));
  if (x2 <= x || y2 <= y) return null; // fully outside the image → mapping failure
  return { x, y, w: x2 - x, h: y2 - y };
}

/** Severity of a finding set: any non-uncertain wins; uncertain alone redacts too. */
function worstCategory(findings: SpfFinding[]): string[] {
  return Array.from(new Set(findings.map((f) => f.category)));
}

/**
 * Inspect one screenshot (base64 JPEG/PNG) for transmission. Fail-closed:
 * every unusual outcome is a BLOCK; only a verified-clean or verified-
 * redacted image is allowed onward.
 */
export async function inspectImageForTransmission(
  imageBase64: string,
  options: VisualInspectionOptions = {}
): Promise<VisualInspectionResult> {
  const deadlineMs = options.deadlineMs ?? 6000;
  const opTimeoutMs = options.opTimeoutMs ?? 4000;
  const padding = options.redactPaddingPx ?? 6;

  if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
    return block('unrecognized_image_payload');
  }
  if (process.platform !== 'win32') {
    // The OCR engine is Windows-only; other platforms cannot establish image
    // safety → fail closed (cloud vision stays unavailable rather than
    // unguarded).
    return block('ocr_unavailable_platform');
  }

  const worker = options.worker ?? getSharedWorker();
  const deadline = Date.now() + deadlineMs;
  const remaining = () => Math.max(1, deadline - Date.now());

  // 1. Worker ready (boot excluded from the pipeline deadline; boot has its
  //    own bounded timeout so a cold first call stays bounded too).
  try {
    await worker.ensureReady(Math.min(15000, Math.max(opTimeoutMs * 2, 10000)));
  } catch {
    return block('ocr_initialization_failure');
  }
  if (Date.now() > deadline) return block('inspection_deadline_exceeded', { timedOut: true });

  // 2. First OCR pass over the ACTUAL pixels.
  let first: OcrInspectResult;
  try {
    const t = Math.min(opTimeoutMs, remaining());
    if (t <= 0) return block('inspection_deadline_exceeded', { timedOut: true });
    first = await worker.inspect(imageBase64, t);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    return block(msg.includes('timeout') ? 'ocr_timeout' : 'ocr_inspection_failed', { timedOut: msg.includes('timeout') });
  }
  if (first.status === 'ocr_unavailable') return block('ocr_engine_unavailable');
  if (first.status === 'unsupported_dimensions') return block('image_dimensions_unsupported');
  if (first.status === 'too_many_frames') return block('too_many_frames_uninspected');
  if (first.status === 'frame_unreadable') return block('frame_unreadable_uninspected');
  if (first.status !== 'ok' || !Array.isArray(first.lines) || typeof first.width !== 'number' || typeof first.height !== 'number' || typeof first.frameCount !== 'number' || first.frameCount < 1) {
    return block('ocr_invalid_result');
  }
  // Incomplete recognition cannot count as safe: every line must carry a
  // complete, finite bounding box — a malformed transcript is a BLOCK, not a
  // best-effort redaction.
  for (const line of first.lines) {
    const shapeOk =
      typeof line?.t === 'string' &&
      Number.isFinite(line?.x) && Number.isFinite(line?.y) && Number.isFinite(line?.w) && Number.isFinite(line?.h) &&
      line.w > 0 && line.h > 0 && (line.f === undefined || (Number.isInteger(line.f) && line.f >= 0));
    if (!shapeOk) return block('ocr_invalid_result');
  }
  // Deadline enforcement applies to the ALLOW path too: an inspection that
  // exceeded its budget is not "established safe".
  if (Date.now() > deadline) return block('inspection_deadline_exceeded', { timedOut: true, ocrLineCount: first.lines.length });
  const ocrLineCount = first.lines.length;

  // 3. Detection on recognized text (existing SPF detectors — LOCAL only).
  let findingsByLine: Array<{ line: OcrLine; findings: SpfFinding[] }> = [];
  let detectionError = false;
  try {
    for (const line of first.lines.slice(0, MAX_LINE_COUNT)) {
      if (Date.now() > deadline) return block('inspection_deadline_exceeded', { timedOut: true, ocrLineCount });
      const detection = scanText(String(line.t ?? ''), { deadlineMs: 200 });
      if (detection.error) {
        detectionError = true;
        break;
      }
      if (detection.timedOut) return block('classification_timeout', { timedOut: true, ocrLineCount });
      if (detection.findings.length > 0) findingsByLine.push({ line, findings: detection.findings });
    }
  } catch {
    detectionError = true;
  }
  if (detectionError) return block('detection_error', { ocrLineCount });
  const categories = Array.from(new Set(findingsByLine.flatMap((f) => worstCategory(f.findings))));

  // 4. Clean image → ALLOW with the ORIGINAL payload (metadata gate still
  //    applies upstream). OCR success with zero lines is a valid outcome —
  //    it means "no READABLE text found", not "no text present" (documented
  //    limitation; the ocrLineCount/frames metadata in every audit record
  //    and response makes the emptiness visible rather than silent).
  if (findingsByLine.length === 0) {
    return { decision: 'allow', reason: 'visual_ocr_clean', categories: [], regionsRedacted: 0, ocrLineCount, payload: imageBase64, payloadIsSanitized: false };
  }

  // 4b. Multi-frame containers: EVERY frame was inspected; if any frame
  //     carries sensitive content, redaction requires re-encoding the whole
  //     container — GDI+ cannot re-encode edited multi-frame GIF/TIFF — so
  //     fail closed. No uninspected and no unredactable frame can leave.
  if ((first.frameCount ?? 1) > 1) {
    return block('multiframe_redaction_unsupported', { categories, ocrLineCount });
  }

  // 5. Map findings to padded rects (irreversible region replacement).
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const { line } of findingsByLine) {
    const mapped = clampRect({ x: line.x, y: line.y, w: line.w, h: line.h }, first.width!, first.height!, padding);
    if (!mapped) return block('bounding_box_mapping_failed', { categories, ocrLineCount });
    rects.push(mapped);
  }

  // 6. Redact actual pixels (solid black), re-encode.
  let redacted: RedactResult;
  try {
    const t = Math.min(opTimeoutMs, remaining());
    if (t <= 0) return block('inspection_deadline_exceeded', { timedOut: true, categories, ocrLineCount });
    redacted = await worker.redact(imageBase64, rects, t);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    return block(msg.includes('timeout') ? 'redaction_timeout' : 'redaction_failed', { categories, ocrLineCount, timedOut: msg.includes('timeout') });
  }
  if (redacted.status === 'error') {
    return block('redaction_failed', { categories, ocrLineCount });
  }
  if (redacted.status !== 'ok' || typeof redacted.img !== 'string' || redacted.img.length < 100) {
    return block('reencode_failed', { categories, ocrLineCount });
  }
  if (redacted.img === imageBase64) {
    // Redaction must change the payload — an unchanged payload is the
    // original image in disguise → never transmit it.
    return block('redaction_did_not_change_payload', { categories, ocrLineCount });
  }

  // 7. MANDATORY second inspection of the sanitized image.
  let second: OcrInspectResult;
  try {
    const t = Math.min(opTimeoutMs, remaining());
    if (t <= 0) return block('inspection_deadline_exceeded', { timedOut: true, categories, ocrLineCount });
    second = await worker.inspect(redacted.img, t);
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    return block(msg.includes('timeout') ? 'verification_ocr_timeout' : 'verification_ocr_failed', { categories, ocrLineCount, timedOut: msg.includes('timeout') });
  }
  if (second.status !== 'ok' || !Array.isArray(second.lines)) {
    return block('post_redaction_verification_failed', { categories, ocrLineCount });
  }
  // Conservative verification conditions: the re-encoded image must be the
  // same picture — dimensions must match the inspected original, and when
  // the first pass read text but the second pass reads NOTHING (while the
  // redacted regions cover only a small part of the image), the verification
  // is inconclusive (possible re-encode corruption or OCR regression) rather
  // than proof of safety.
  if (typeof second.width === 'number' && typeof second.height === 'number' && (second.width !== first.width || second.height !== first.height)) {
    return block('post_redaction_dimension_mismatch', { categories, ocrLineCount });
  }
  const redactedArea = rects.reduce((sum, r) => sum + r.w * r.h, 0);
  const imageArea = (first.width ?? 0) * (first.height ?? 0);
  const coverage = imageArea > 0 ? redactedArea / imageArea : 1;
  // Inconclusive second pass: safe (non-redacted) text existed on the first
  // pass but the verification reads NOTHING at all — that is a suspicious
  // re-encode/OCR regression, not proof of safety. (When every recognized
  // line was itself redacted, an empty second pass is the expected outcome.)
  const expectedSurvivingLines = first.lines.length - findingsByLine.length;
  if (expectedSurvivingLines > 0 && second.lines.length === 0 && coverage < 0.5) {
    return block('post_redaction_verification_inconclusive', { categories, ocrLineCount });
  }
  let residual = false;
  try {
    for (const line of second.lines.slice(0, MAX_LINE_COUNT)) {
      const detection = scanText(String(line.t ?? ''), { deadlineMs: 200 });
      if (detection.error || detection.timedOut) {
        residual = true;
        break;
      }
      if (detection.findings.length > 0) {
        residual = true;
        break;
      }
    }
  } catch {
    residual = true;
  }
  if (residual) return block('post_redaction_verification_failed', { categories, ocrLineCount });

  // 8. Verified sanitized payload.
  return {
    decision: 'redact',
    reason: `visual_redacted:${categories.join('+')}`,
    categories,
    regionsRedacted: rects.length,
    ocrLineCount,
    payload: redacted.img,
    payloadIsSanitized: true,
  };
}

/** Test hook: dispose the shared worker (process cleanup). */
export function disposeSharedOcrWorker(): void {
  sharedWorker?.kill();
  sharedWorker = null;
}
