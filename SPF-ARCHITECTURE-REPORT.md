# Screen Privacy Firewall (SPF) — Architecture Investigation Report

**Status:** Investigation complete, before implementation.
**Method:** Repository-wide code tracing (four parallel investigations + direct verification of all enforcement sites). Every claim below cites `file:line` verified in source. No speculation.

---

## 1. How Krisha captures and processes screen observations

| Stage | Implementation | Notes |
|---|---|---|
| Capture | `navigator.mediaDevices.getDisplayMedia({frameRate:1})` — `src/agent/vision/browserCapture.ts:37` | Stream reused per session; **on-demand only** (no polling timers). Produces a 240px RGBA analysis buffer + a ≤768px JPEG data URL (`browserCapture.ts:19-21,94-130`). |
| Frame type | `CapturedFrame {width, height, data: Uint8ClampedArray, dataUrl?}` — `visionTypes.ts:125-131` | `dataUrl` exists only when a cloud encode was requested. |
| Observation hub | `ScreenObserver.getCurrentState()` — `screenObserver.ts:130-181` | Gated by default-deny `screen.observation` permission (`screenObserver.ts:99-103`). Region crops happen **before** analysis (`cropFrame`, `regionCrop.ts:36-57`; cropped frames carry **no** `dataUrl`). |
| OCR | **Only cloud**: `POST /api/vision/analyze` (`server.ts:1811`) → Gemini `inlineData` (`server.ts:1859`). Local provider is honest-empty (`localPixelVision.ts:87`, `texts: []`). | There is **no local OCR engine** anywhere in the repo. |
| Observation type | `ScreenState {id, timestamp, activeWindow, size, signature, analysis, snapshotRef?}` — `visionTypes.ts:88-97` | Deliberately contains **no image data**; pixels live in a bounded snapshot cache (3 entries / 60 s TTL, `screenObserver.ts:38-39,335-363`). |
| Derived representations | `VisionAnalysis {summary, application, texts, elements, dialogs, errors, warnings}` (`visionTypes.ts:68-79`); `ScreenSummary` (multimodal, secret-scanned — `modalityNormalizer.ts:95-130`); tool outputs bounded to ≤25 texts/≤20 elements (`screenTools.ts:41-64`); task summaries (`agentCore.ts:928-970`). |
| Adaptive layer | Phase 13 `src/agent/observation/` — decision/budget/policy only; never stores image data. |
| Consumers | screen tools → ToolRegistry → AgentCore summaries; ComputerControl/KeyboardControl targeting & verification (`computerControl.ts:112-256`); ComputerUseAgent loop (`computerUseAgent.ts:311-369`); multimodal evidence (in-memory, TTL 30 s); UI `ScreenVisionCard/Modal` (raw display is local-only). |

**Persistence of screen data:** pixels — in-memory only, never disk (`screenObserver.ts:14-16`; no `writeFile` in vision/observation/multimodal). One verified exception: a cloud-analysis snapshot can persist inside chat history in `localStorage krisha_conversations_v1` via `Message.screenVisionAction.snapshotUrl` (`src/utils/storage.ts:84-90`, created at `App.tsx:743-758`). Screen-derived *text* persists in `krisha_agent_tasks_v1` (task summaries) and may enter `krisha_agent_memory_v2` via consolidation/extraction.

## 2. Actual transmission paths (every verified external egress)

All external I/O funnels through (a) the Express server process and (b) a handful of browser-side calls. Two processes; `@google/genai` is imported only by `server.ts`.

### Model-request paths (→ generativelanguage.googleapis.com)

| # | Site | Data sent | Screen-derived? |
|---|---|---|---|
| 1 | **`/api/vision/analyze`** — `server.ts:1811`, image embedded at `:1859` | Raw base64 JPEG **screenshot** + question + active window title | **YES — the primary screen-pixel egress** (fed by `geminiVision.ts:41`, `ScreenVisionModal.tsx:87`) |
| 2 | `/api/chat` — `server.ts:1178` | Last 16 conversation turns + memories + notes + habits + location | Indirect: vision summaries / legible screen text embedded in chat messages (`App.tsx:746-748`), task summaries (`agentCore.ts:954-958`) |
| 3 | `executeMapsGroundingQuery` — `server.ts:836` (routes `:1159`, `:1784`) | Query text + lat/lng | Query may quote screen content |
| 4 | `/api/tts` — `server.ts:1641` | Speech text (≤400 chars) | May read screen-derived text aloud |
| 5 | `/api/audio/transcribe` — `server.ts:1727,1745` | Microphone/file audio | No (audio; out of screen scope) |
| 6 | `/api/memory/extract` — `server.ts:1541` | userMessage + botMessage + memories | Bot message may describe the screen (auto-called after turns, `App.tsx:879,1661`) |

### Non-model server fetches

| # | Site | Destination | Screen-derived? |
|---|---|---|---|
| 7 | `/api/location/geocode` — `server.ts:178,237,279` | Google Maps Geocoding API; Nominatim | Address text (rarely screen-derived) |
| 8 | `duckDuckGoSearch`/`bingSearch` — `server.ts:2515,2579` (route `/api/research/search:2612`) | DDG html/lite, Bing RSS | **Query can embed screen-derived text** |
| 9 | `/api/research/fetch` — `server.ts:2663` | Arbitrary public URL | URL string itself |

### Browser-side direct external (4, no body payloads)

10. `src/utils/locationService.ts:345` → `https://ipwho.is/` (IP geolocation fallback). 11. `GlobeModal.tsx:204` → Nominatim (user-typed address). 12. `globe/environment/envService.ts:162,239` → open-meteo (coordinates only). 13. `globe/providers/mapsLoader.ts:67` → Maps JS API script tag.

### Indirect website egress (agent-driven, data-in-URL / typed-into-form)

| # | Path | Screen-derived? |
|---|---|---|
| 14 | `/api/browser/navigate` (`server.ts:2325`) → CDP `Page.navigate` (`browserCdp.ts:158,164`) | URL query strings can carry screen text to external sites |
| 15 | `browserAgent.coerceUrl` (`browserAgent.ts:140-151`) — free text → DDG search URL | Same |
| 16 | `/api/browser/type` (`server.ts:2384`) + click → web form submission; OS keyboard `SendInput` (`server.ts:2140-2160`) | **Legitimate interaction** (filling forms in the user's own target apps) — must NOT be blocked (task §6); keyboard tool already masks sensitive input in summaries |
| 17 | Chat web-action URL builders (`server.ts:1316-1451`, e.g. YouTube/Google search URLs) + `window.open` (`webActions.ts:470-481`) | Query strings built from chat text |

### Dormant / background

- Multimodal external reasoning provider (`multimodalReasoner.ts:222-245`) — **never wired in production** (`bridge.ts:315` passes no provider; `setProvider` never called). Dormant, must be protected for future use.
- Proactive / longrun / learning / telemetry: **zero external calls** (verified by sweep). `routing/telemetry.ts` is in-process counters only.
- No WebSocket/EventSource/axios/undici/analytics anywhere.

### Local-only (not external — out of SPF scope but audited)

Loopback HTTP (server ↔ browser), CDP loopback `127.0.0.1:9223`, recovery named pipe, localStorage sinks, server disk sinks (audit JSONL, sandbox journal, quarantine, context cache).

## 3. Existing security infrastructure (reuse, not duplication)

- **Two enforced planes:** server-side E5 (`serverSafety.ts` — `enforce()` middleware on 26 side-effecting routes at `server.ts:57-106`, emergency stop with durable state, `appendAuditSyncSafe` hash-chained audit at `:614`, permissions authority `:1007`) and in-agent Phase 18 (`SafetyGate` on every `ToolRegistry.execute`, `toolRegistry.ts:227-234`; `EmergencyStop` wired at `bridge.ts:380-416`).
- **Existing (partial) redaction:** `scanSensitivity` in `src/agent/multimodal/modalityNormalizer.ts:27-58` — API keys/GitHub/AWS/JWT/bearer/key:value/card-like patterns → `[REDACTED]`, used only inside the multimodal layer. **Gaps:** no OTP detection, no Google-credential detection, no bank/IBAN, no Luhn card validation, no seed phrases/private keys/SSN, no image-region analysis, no transmission decisions, no enforcement on any endpoint, no audit of privacy decisions.
- **Deactivation asymmetry:** stop activation is callable; recovery is CLI+credential only — SPF must not touch this.
- No `Action Transparency` log exists yet; SPF audit events must be integration-ready for it.

## 4. SPF architecture to be implemented (enforcement points)

**Design principle:** SPF is a *mandatory boundary between screen observation and external communication*, implemented as one shared, dependency-free core (`src/agent/spf/`) with two planes of enforcement — **provenance-aware gates** at each egress point and a **system-wide outbound transport guard** as the final net. No agent can override: the firewall exposes no override API, and gates run *outside* agent control.

| EP | Location | What is gated |
|---|---|---|
| EP-0 | `src/agent/spf/*` (new) | Detection (credentials/OTP/Google/bank/card/API-key/auth/private-key/seed/IDs/confidential-context), decision engine (ALLOW/REDACT/BLOCK, fail-closed, deadline), text redaction, RGBA region redaction primitive, audit log |
| EP-1 | `server.ts /api/vision/analyze` | **Image-transfer gate before Gemini** (context signals: question, window title, prior texts); response-text screening before returning |
| EP-2 | `server.ts /api/chat` | Outbound prompt gate (messages, memories, notes, habits) — redact confident secrets; block unredactable; graceful blocked reply |
| EP-3 | `server.ts /api/maps/grounding` + `executeMapsGroundingQuery` | Query/contents gate |
| EP-4 | `server.ts /api/memory/extract` | Gate before model call (protects memory pipeline) |
| EP-5 | `server.ts /api/tts` | Speech-text gate |
| EP-6 | `server.ts /api/location/geocode` | Address-text gate |
| EP-7 | `server.ts /api/research/search` + `/api/research/fetch` | Query/URL gate |
| EP-8 | `server.ts /api/browser/navigate` | URL gate (data-in-URL egress) |
| EP-9 | `server.ts extractServerWebAction` URL builders | Query sanitize before URL construction |
| EP-10 | `src/agent/vision/geminiVision.ts` | Client-side pre-send gate (blocked requests never leave the tab) + post-receive text screening |
| EP-11 | `src/components/ScreenVisionModal.tsx` | Pre-send gate + honest blocked UX |
| EP-12 | `src/App.tsx handleReadScreen` | Sanitize screen text before it becomes a persisted chat message |
| EP-13 | `src/agent/vision/screenTools.ts stateOutput` | Per-item SPF screening of tool outputs (protects task summaries/memory) |
| EP-14 | `src/agent/agentCore.ts buildSummary` | Per-line screening of task summaries |
| EP-15 | `src/agent/multimodal/multimodalContext.ts providerSafeDigest` | Backstop scan of the (dormant) provider digest |
| EP-16 | **Global outbound guard** (server process; patches `globalThis.fetch` + `node:http`/`node:https`) | Final net: every outbound request's URL/headers/body scanned; never-transmit patterns → request destroyed. Covers any future/unknown client, service, or remote-agent path |

**Deliberately not blocked** (documented): `/api/browser/type`, OS keyboard typing, browser clicks — legitimate local interaction with the user's own target applications (task §6); OCR of the image itself (no local OCR engine exists — see residual risks).

## 5. Decision policy (task §4)

- **ALLOW** — no findings.
- **REDACT** — text payloads with confident, delimited findings: spans replaced with `[REDACTED-SPF:<category>]`, payload re-scanned; original never sent as fallback (post-redaction scan failure → BLOCK). Per-item redaction for tool outputs / digests / summaries (strip the offending item, keep the rest — preserves function).
- **BLOCK** — image transfers with any never-transmit signal, sensitive/confidential document context, or credential-indicating window titles; text payloads where redaction is impossible/unmappable, redaction coverage is excessive, detection errored or timed out; URLs carrying credentials; anything whose format cannot be validated. **Unknown/uncertain defaults to BLOCK** on all screen-provenance transports. One documented exception: chat-history transport (mixed provenance — screen-derived parts are already sanitized upstream at EP-12/13/14) downgrades *uncertain-only* findings to allow-with-flag, so an unrelated conversation is never disabled by a weak heuristic; never-transmit and sensitive findings are still redacted/blocked there.
- **Never transmitted raw:** OTPs, passwords, authentication credentials, full payment credentials (card+CVV), seed phrases, private keys.

## 6. Audit & failure handling

- `SpfAuditLog` — bounded ring + listener (Action-Transparency-ready); events carry: category, observationId, destination, decision, reason, confidence, timestamp, non-reversible content-hash prefix. **No raw sensitive values ever.** Server-side decisions additionally append to the existing tamper-evident E5 audit chain via `appendAuditSyncSafe({kind:'spf_decision',…})` (reuse, no duplicate system).
- **Fail-closed everywhere:** detector error → BLOCK; deadline exceeded (default 200 ms) → BLOCK; redaction failure/residual findings → BLOCK; unscannable payload → BLOCK; guard error → affected transmission blocked. Blocked endpoints degrade gracefully (existing `fallback`/`success:false` response shapes) so unrelated functionality keeps working.

## 7. Residual risks (honest limitations, to be re-stated in the completion report)

1. **No local OCR** — image-level detection is context-driven (metadata around the image), not pixel-content-driven. A password visible in a screenshot whose window title/question/prior texts carry no signal will pass. Mitigation: credential-indicating window titles and questions BLOCK; cloud-returned transcription is screened (EP-1 response gate) so extracted secrets do not flow into derived representations.
2. Split-secret evasion (a secret fragmented across JSON fields) is detected per-string, not cross-field.
3. Detection is pattern+structure based (deterministic, local); it will not catch novel secret formats — uncertain-shaped high-entropy blobs near credential keywords are treated conservatively.
4. `@google/genai` SDK may capture a `fetch` reference before guard installation; installation is ordered first in `server.ts`, and per-endpoint gates (EP-1..EP-6) run *before* any SDK call, so the guarantee does not depend on the SDK's transport choice.
