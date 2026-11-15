# Krisha — Security Integration Baseline (SPF + LPV)

**Integration date:** 2026-11-15
**Authority:** this document is the reference baseline for subsequent Krisha development. Detailed per-subsystem documentation: `ARCHITECTURE.md` §32 (SPF), §33 (LPV), §34 (SPF visual remediation), §35 (consolidated integration); investigations in `SPF-ARCHITECTURE-REPORT.md`, `SPF-VISUAL-REMEDIATION.md`, `LPV-RACE-COORDINATION.md`.

## 1. Source-state identification

- **Version control:** Git is not available in this environment (`git` not on PATH); no branch/worktree could be created. Reproducible identification is by SHA-256 file inventory (first 16 hex chars) + sizes + mtimes, captured at baseline time. Any future change to these files invalidates this baseline and requires re-verification (§9).
- Key-file inventory (hash|bytes|mtime): recorded 2026-11-15 — `server.ts|1755761F7F443535|162180`, `lpvCore.ts|FA16AC39B46604FA|81623`, `browserCdp.ts|C5CC4C6DB306A1E6|20074`, `serverSafety.ts|B58C3BB276C71237|55492`, SPF core (`src/agent/spf/`: spfTypes `99887F…`, detectors `65C42083…`, decision `85EFAB7D…`, redact `4943CBE0…`, audit `281CA366…`, firewall `FBC12B0C…`, outboundGuard `51E22622…`, visualInspection `2CBCC745…`, index `03B1CFD6…`), suites (`test-spf.ts 600C77F2…`, `test-spf-visual.ts 69518610…`, `test-lpv-core.ts 07F4EA63…`, `test-lpv-security.ts 17F12C59…`, `test-lpv-perf.ts A8FCE352…`).
- All cross-workstream fixes verified present in the tree: SPF visual pipeline + gates + `spfImage` metadata + outbound guard install in `server.ts`; multiframe handling in `visualInspection.ts`; LPV pre-check readiness fix (`void preState` in `executeFillCore`) and test `waitForTabReady` probe.
- `tsc --noEmit`: **0 errors** (the LPV workstream's refactor has landed and the tree compiles clean).

## 2. SPF completion status

**Complete.** Text detection engine (credentials/OTP/Google/bank/card/CVV/API keys/auth tokens/private keys/seed phrases/national IDs/confidential context, JSON-field forms, URI+base64 evasion variants) with ALLOW/REDACT/BLOCK decisions, value-only JSON-valid redaction, marker-aware rescans, fail-closed deadline/error handling. Visual pipeline: local Windows.Media.Ocr pixel inspection of EVERY frame/page, detector re-use, irreversible black-fill redaction + JPEG re-encode, mandatory second inspection (residual/inconclusive/dimension-mismatch → BLOCK). Enforcement: 16 endpoint gates (vision image gate + response screening, chat, maps-grounding, memory-extract, TTS, transcribe prompt, geocode, research search/fetch, browser navigate, web-search URL builders), client pre-send gates, per-item screening of tool outputs/summaries/digests, system-wide outbound transport guard (patched `globalThis.fetch` + shared `ClientRequest` prototype), metadata-only audits (in-memory ring + E5 chain), `/api/vision/analyze` stop-blocked. No override API.

## 3. LPV completion status

**Complete.** DPAPI-wrapped master key + AES-256-GCM entries + full-document HMAC; account-SID binding; generation tracking with tamper fail-closed; category policy (Category A operator-approved saves, opted-in Category B auto-save, secret-shaped content refused); approval challenges with decision tokens; server-minted single-use fill grants bound to {entry, origin}; pinned origin-verified browser fills (live-origin probe + `readyState === 'complete'` + atomic in-page origin re-check + post-fill navigation detection); auto-lock with key zeroing; metadata-only responses/audit; degraded-mode strictness. Route layer fully enforced (`vault.manage`/`vault.retrieve` permissions, stop-blocked, rate-limited). **No vault tool exists in the agent ToolRegistry** — the model can request a challenge (authorizes nothing) and nothing more.

## 4. Shared integration points

1. `server.ts` — one Express process hosts both: SPF endpoint gates + outbound guard install + `ENFORCED_ROUTES` (SPF visual gate on `/api/vision/analyze`; LPV vault routes with `vault.*` permissions, stop-blocked, rate-limited). File owners: SPF (gates/metadata), LPV (route bodies); both verified present post-refactor.
2. `browserCdp.ts` — LPV owns the pinned-fill section (`browserFillFields`: live-origin probe, pinning, readiness gate, atomic in-page re-verification). SPF owns the `/api/browser/navigate` URL gate (server route). CDP transport is a loopback WebSocket (`ws://127.0.0.1:9223`) — local IPC, outside the SPF external-egress guard's scope by design; LPV's origin verification is the gate for what that channel receives.
3. `browserCdp` navigation assertions — LPV's fill flow and SPF's navigate gate are independent (different endpoints); no conflict.
4. Emergency stop — single durable server-side stop: SPF-enforced routes → 423 (incl. `/api/vision/analyze`, all vault mutation/fill routes); LPV `assertStopInactive` refuses vault operations in-process; recovery is operator-CLI+credential only. No inconsistency found.
5. Audit — SPF decisions append `spf_decision`/`spf_visual_decision` to the E5 chain + in-memory ring; LPV maintains its own hash-chained `lpv_audit.jsonl` inside the protected store. Both metadata-only.
6. Agent/model surface — no vault tools; no model-callable approvals; SPF gates conversation/memory/TTS/speech/research egress so screen-derived (and user-typed) secrets cannot reach models; LPV secrets never enter ordinary HTTP responses, logs, memory or task history (suite-asserted).

## 5. Exact regression results (2026-11-15, integrated tree, `tsc --noEmit` 0 errors)

| Suite | Command | Result |
|---|---|---|
| SPF text security | `npx tsx scripts/test-spf.ts` | **220 passed, 0 failed** |
| SPF visual security | `npx tsx scripts/test-spf-visual.ts` | **113 passed, 0 failed** |
| LPV core | `npx tsx scripts/test-lpv-core.ts` | **92 passed, 0 failed** |
| LPV security ×5 | `npx tsx scripts/test-lpv-security.ts` (5 consecutive runs) | **5× (55 passed, 0 failed)** |
| LPV performance | `npx tsx scripts/test-lpv-perf.ts` | **11 passed, 0 failed** (unlock cold 41 ms / warm 51 ms, save ~13 ms, lock ~5 ms) |
| E5 M1 / M2 / M3 / H4 | `npx tsx scripts/test-e5-m{1,2,3}.ts`, `test-e5-h4.ts` | **86 / 74 / 72 / 70 passed, 0 failed** |
| Phase 13 / 14 / 18 | `npx tsx scripts/test-{observation-phase13,multimodal-phase14,safety-phase18}.ts` | **91 / 150 / 62 passed, 0 failed** |
| Agent core | `npx tsx scripts/test-agent-core.ts` | **49 passed, 0 failed** |
| Goal continuity | `npx tsx scripts/test-goal-continuity.ts` | **163 passed, 0 failed** |
| TypeScript | `npx tsc --noEmit` | **0 errors** |
| Isolated HTTP smoke | spawned-server sections of both SPF suites + E5 M4 server scenarios (`KRISHA_SANDBOX_DIR` tmpdirs): health, endpoint gates, block paths, rollback flow | pass (see suite logs) |
| Real-browser CDP smoke | LPV security suite drives a real headless Chrome/Edge over CDP: browser boot, tab creation, multi-tab pinning, live-origin probes, page evaluation, restart scenarios | pass (55/0, five consecutive runs) |

## 6. Real E5 protected store — before/after evidence

Method: `scripts/spf-real-store-status.ts` + SHA-256 of every store file, captured immediately before and after the full campaign above (≈25 suite/server executions).

- Status: `{"root":"C:\\ProgramData\\Krisha\\sandbox","protection":"full","stopKind":"INACTIVE","audit":{"ok":false,"entries":732,"segments":0,"firstBrokenLine":3,"reason":"audit chain discontinuity at line 3 (seq 1, expected 3)"}}` — **identical before and after**.
- File hashes identical before and after: `install.marker 000FA71ACA75AE1B`, `stop-state.json 0A5A70029A449D48`, `audit\server-audit.jsonl 7977A4E9BDA22D6F`, `quarantine\items\697bff14-…-b240-934288f762a6.data 91555D75A62A219D`, `.meta.json 6124A8334FC79B51`, `sandbox-journal\journal.jsonl 44BA77055F4CA21D`.
- The `audit.ok=false` line-3 discontinuity **pre-dates this baseline** (first recorded 2026-11-14, before any SPF test campaign) and is unchanged; it is honest tamper-EVIDENT history, not damage from testing. Nothing was reset, recreated or repaired (repairs are operator-only).

## 7. Security invariants (each verified in the integrated tree)

1. Screen pixels leave the device **only** through `/api/vision/analyze`, only after local OCR inspection of every frame/page, only in the verified (clean-or-redacted) payload; metadata signals are additional, never a fallback.
2. Sensitive screen-derived text is redacted/removed from every external representation (prompts, research queries, speech, memory, digests, summaries) and from the model's own transcriptions at the response gate.
3. Every external outbound request from the server process is screened (fetch + node http/https); redactable bodies are rewritten with sanitized copies; unrewritable channels are blocked; app-operational auth headers are exempt.
4. Credentials exist in cleartext only inside LPV's unlocked in-memory document and the authorized fill expression on the pinned same-origin page; transit to the browser is loopback-only; zero retention outside the vault.
5. Fill requires: unlocked vault + server-minted single-use grant + operator-approved challenge (or explicit UI fill approval) + live-origin equality on a pinned complete page + in-page origin re-check + post-fill navigation check.
6. The model has no approval capability and no vault tool; server permissions (`vault.manage`/`vault.retrieve`) gate every route; grants and challenges are single-use, expiring, replay-refused.
7. Emergency stop halts SPF external transmissions (423) and LPV operations; recovery is operator-only.
8. Both audit trails are metadata-only; tests assert no secret appears in logs, HTTP responses, audit records or transparency events.
9. Test servers never touch the real E5 store (temporary `KRISHA_SANDBOX_DIR` before module init); the real store is hash-verified before/after campaigns.

## 8. Known limitations (explicit)

- SPF visual inspection is OCR-based and not complete: unrecognizable text (very small/low-contrast/non-Latin/stylized) can pass; empty OCR (`ocrLineCount=0`) is surfaced but is an allow; Windows-only OCR elsewhere fails closed; no per-word confidence from the engine.
- Multi-frame containers with sensitive content are blocked (GDI+ cannot re-encode edited GIF/TIFF) rather than redacted — availability trade for safety.
- Split-secret fragmentation across separate JSON fields is detected per-string only.
- LPV fill trust model: the operator's browser is same-user; page-level origin verification cannot defeat a determined same-user adversary (disclosed in §33).
- LPV fill secrets transit the loopback CDP WebSocket (not scanned by the SPF external-egress guard — local channel; destination gated by origin verification).
- The real E5 audit chain carries a pre-existing line-3 discontinuity (predates all SPF/LPV campaigns; tamper-evident history, unchanged).

## 9. Conditions that require reopening security verification

Any of the following invalidates this baseline and requires a full §5 regression re-run plus store re-verification:
1. Any change to `src/agent/spf/**`, `lpvCore.ts`, `lpvDpapi.ts`, `browserCdp.ts` (fill/fill-fields section), `serverSafety.ts`, or the SPF/LPV parts of `server.ts` (hashes in §1).
2. Any new outbound network path, endpoint, image format, or agent tool that can carry screen-derived data or credentials.
3. Any change to `serverSafety.ts` store layout, emergency-stop semantics, or the recovery pipe.
4. Any change to the browser-fill flow (target selection, origin checks, fill expression, CDP transport).
5. Addition of a new model/provider integration or a new OCR/analysis provider.
6. Test-suite changes that alter spawned-server isolation (`KRISHA_SANDBOX_DIR`/`KRISHA_FS_ROOTS` timing).
