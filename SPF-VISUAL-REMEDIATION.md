# SPF Visual Remediation — Architecture Assessment & Implementation Proposal

**Status:** Investigation complete, before implementation (task §1).
**Scope:** Close the pixel-inspection gap: local OCR of actual screenshot pixels + irreversible region redaction + mandatory second inspection, before any external image transmission. No SPF redesign; no unrelated systems.

---

## 1. Findings

### 1.1 Screenshot lifecycle (verified, current state)

1. `BrowserCaptureSource.capture()` — `browserCapture.ts:94-130`: on-demand `getDisplayMedia`, 240px RGBA analysis buffer + **≤768px JPEG data URL** (quality 0.6).
2. `ScreenObserver.getCurrentState()` — `screenObserver.ts:130-181`: region crops happen pre-analysis (cropped frames carry no dataUrl); full JPEG kept in the bounded snapshot cache (3 entries/60s TTL).
3. Egress paths for image pixels (complete set — verified):
   - `GeminiVisionProvider.analyze()` (`geminiVision.ts`) POSTs stripped base64 → `/api/vision/analyze`;
   - `ScreenVisionModal.handleAskQuestion` (`ScreenVisionModal.tsx`) POSTs a stored snapshot → same endpoint.
   Both funnel into **one** external boundary: `/api/vision/analyze` (`server.ts`) → Gemini `inlineData`. No other endpoint carries image pixels (verified: audio/TTS/research/fs/browser routes carry no images; outbound guard skips bulk base64 by design).
4. **Current SPF image decision**: `spfFirewall.inspectImageTransfer` — metadata/context only (question, window title, prior texts + credential-window/credential-question heuristics). **No pixel inspection — this is the audited gap.**
5. Existing reusable utilities: `scanText` detector engine (works on any text), `SpfAuditLog`, `spfAuditDurable` (E5 chain), region-crop presets, `redactFrameRegions` (RGBA fill — browser-side), `PowerShellWorker` pattern (`server.ts:2191`) for persistent PS processes.

### 1.2 Local OCR options evaluated (Windows-compatible)

| Option | Verdict |
|---|---|
| **Windows.Media.Ocr (WinRT) via persistent PowerShell worker** — **CHOSEN** | Zero npm dependencies; built into Windows 10+; fully offline; native speed (~100-300ms at Krisha's ≤768px sizes); returns **word + line bounding rects**; runtime-verified on this machine (engine en-GB available; synthetic `password: FAKE-Test-123` recognized with exact rect `[27,46,338x27]`). Matches the repo's zero-dependency PowerShell pattern (mouse/keyboard workers, `server.ts:2191`). Windows-only — Krisha is already Windows-only (PowerShell mouse/keyboard are hard prerequisites). Requires ≥1 installed OCR language (`AvailableRecognizerLanguages` = en-GB, en-US here); **fail-closed BLOCK when none**. |
| Tesseract.js | Rejected: ~10-30MB dependency + language data, WASM startup cost — a large dependency introduced silently; slower than native WinRT. |
| Cloud OCR (Google Vision etc.) | Rejected: explicitly forbidden — OCR results must never leave the device to make a privacy decision. |
| PaddleOCR/EasyOCR/ONNX models | Rejected: heavy Python/model downloads, maintenance burden, installation requirements. |

**Privacy properties of the chosen engine:** runs inside the server process (localhost); screenshots and OCR text never leave the device for the decision; recognized text is used only for local detection and is never logged, persisted, or audited.

### 1.3 Where the decision is made and the new boundary

Earliest point where pixels can be inspected locally = the server process (the browser tab cannot run WinRT; the client→server hop is localhost, not external). **The mandatory inspection boundary is the image-pipeline inside `/api/vision/analyze`, before the Gemini call** — the single chokepoint every screenshot/crop/resized derivative passes through (both client paths). Metadata heuristics remain as an additional fast-fail signal (never a fallback for OCR: metadata-only ALLOW cannot happen anymore).

## 2. Implementation proposal

1. **`OcrWorker`** (`src/agent/spf/visualInspection.ts`, Node-only, imported by server.ts + tests): persistent `powershell.exe -NoProfile -NonInteractive -Command -` process (PowerShellWorker protocol: stdin JSON lines, `REQDONE <id>` markers, bounded queue, timeout kills the worker and reboots). Two ops:
   - `inspect`: WinRT `BitmapDecoder` (JPEG/PNG/BMP/GIF/TIFF) → `SoftwareBitmap` Bgra8 → `OcrEngine.RecognizeAsync` → `{status, width, height, lines:[{t, x, y, w, h}]}` (line rect = union of word rects). Dimension cap 8192px (engine max 10000) → `unsupported_dimensions` → BLOCK.
   - `redact`: System.Drawing decode → `Graphics.FillRectangle` **solid black** (irreversible pixel replacement, padding-expanded, clamped) → JPEG re-encode (quality ~65) → base64.
2. **`inspectImageForTransmission(base64, options)`** pipeline (deadline-budgeted, default 6s total / 4s per op):
   OCR inspect → `scanText` per OCR line (existing detectors — no competing system) → findings map to padded rects → if findings: `redact` → **mandatory second inspection** (OCR again → scan again; residual findings, OCR error, encode failure, or unchanged-payload assertion failure → BLOCK) → result `{decision, reason, categories, regionsRedacted, ocrLineCount, payload, payloadIsSanitized}`. Any failure (engine unavailable, init/timeout/malformed, decode/encode failure, bad rects) → BLOCK with content-free reason.
3. **`/api/vision/analyze` wiring**: metadata gate (fast fail) → visual pipeline → on REDACT the **sanitized base64** is what enters the coalescer/Gemini request (original never forwarded); response gains content-free `spfImage` metadata; durable audit `spf_visual_decision` + in-memory SPF audit event.
4. **Emergency stop**: `/api/vision/analyze` added to `ENFORCED_ROUTES` with `stopBlock: true` (423 when stop active) — image egress halts during a stop.
5. **Tests** (`scripts/test-spf-visual.ts`, synthetic screenshots drawn via System.Drawing): all §8 scenarios + wire-level verification (local receiver receives the sanitized payload; receiver-side re-OCR proves the secret is unreadable; pixel sampling proves irreversible black replacement) + fail-closed injection cases (fake workers) + spawned-isolated-server endpoint tests (`KRISHA_SANDBOX_DIR` tmpdir, real E5 store untouched, verified before/after) + emergency-stop + leakage checks.
6. **Performance script** (`scripts/measure-spf-visual-performance.ts`): init time, per-size OCR latency, detection, redaction, verification, total, memory.

**Honest limitations (declared up front):** OCR-based visual inspection is not perfect — very small fonts, low-contrast text, exotic renderings, and non-Latin scripts may not be recognized; OCR languages are those installed on the OS; non-Windows or language-less systems fail closed (cloud vision becomes unavailable rather than unguarded).
