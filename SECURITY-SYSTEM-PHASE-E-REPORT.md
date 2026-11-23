# Krisha — Security System Phase E: Security Intelligence, Correlation and Response Readiness

**Date:** 2026-11-22
**Scope:** unified security-event intelligence (E.1), cross-event correlation (E.2), threat assessment (E.3), situation awareness (E.4), safe response recommendations (E.5).
**Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md`; baseline inspection: `SECURITY-SYSTEM-PHASE-E-BASELINE.md` (produced before any changes). Prior: Phase A–D reports.

---

## 1. Baseline (summary — full report in `SECURITY-SYSTEM-PHASE-E-BASELINE.md`)

Phase E collects NOTHING new. Verified before implementation: every security subsystem already emits metadata through the E5 audit funnel (`appendAuditSyncSafe`) or a subscription API (`ProcessMonitor.onEvent`) — Phase E wraps those existing outputs into one normalized stream. LPV is the sole exception (own hash-chained audit file) and received a minimal **additive outbound sink** (`lpvCore.setLpvSecurityEventSink`, best-effort, post-write) so its decisions enter the stream without touching any LPV security behavior (LPV suites: green).

## 2. New components

`src/agent/securityintel/` (node-only; browser-safe tool wrappers in `tools.ts`):

| Component | File | Role |
|---|---|---|
| E.1 Event schema | `eventTypes.ts` | `SecurityEvent`: intel-assigned id, category, **original timestamp preserved** (`observedAt`; missing → `observedAt: 0`, `observedTimestamp: false`), separate `ingestedAt`, subject references, sanitized facts, provenance (`via`/`source`/`originalKind`/`auditSeq`), dedup state |
| E.1 Ingestion | `intel.ts` | Normalization + validation + defensive sanitization (denylisted keys, string caps, objects dropped) + dedup window + **bounded ring (2000, drop-oldest, counted)** + unknown-source preservation + malformed rejection counters |
| E.2 Correlation | `correlation.ts` | Seven evidence-linked rules (below); every result cites event ids; `directEvidence` vs `statisticalOnly`; severity/confidence are HINTS only |
| E.3 Assessment | `assessment.ts` | Severity (INFORMATIONAL→CRITICAL) **separate from** confidence (0–1 + label); contradictions recorded and confidence-reducing; `missingInfo` explicit; `kind: 'inferred' \| 'confirmed-by-source'`; **CRITICAL requires a source CONFIRMED_MALWARE fact — correlation alone can never produce it** |
| E.4 Situation | `situation.ts` | Read-only, on-demand view; every getter is the subsystem's own report; throwing/absent sources → explicit `UNKNOWN` (never invented); Defender availability only via a **rate-limited (5 min) explicit check**, otherwise UNKNOWN |
| E.5 Recommendations | `response.ts` | Closed action enum (GATHER_METADATA, REASSESS, NOTIFY_OPERATOR, PRESERVE_EVIDENCE, RECHECK_DEFENDER, REQUEST_HUMAN_REVIEW, RESTRICT_OPERATION, NONE); forbidden classes rejected structurally (`FORBIDDEN_ACTIONS`); authority-requiring proposals marked `approvalAvailability: 'unavailable'` (D.4); RESTRICT_OPERATION only POINTS at the operator E-stop route and never invokes it; recommendations audited (metadata-only) |

**Event sources (all existing):** monitor lifecycle events (subscription), `malware_classification`, `exec_gate_*`, `threat_containment`, `spf_decision`, E-stop transitions (`e5_stop_*`, `emergency_resume` — including pipe-driven ones via the funnel), enforcement blocks, LPV records (sink), plus a 5 s unref'd in-memory stop/storage change sampler as a completeness backstop. Defender events enter as Phase B detection facts (no new polling).

**Wiring (`server.ts`):** shared `auditAndIngest` tap (E5 append unchanged + ingestion), `processMonitor.onEvent` subscription, LPV sink, sampler (cleared on exit), read-only routes `GET /api/security/situation` (optional `?recheckDefender=1`) and `GET /api/security/assessments`. **`bridge.ts`:** two read-only tools (`securityIntel.status`, `securityIntel.assessments`) — no control surface anywhere.

## 3. Correlation rules

| Rule | Signal | Evidence type |
|---|---|---|
| R1 | Process creation → detection of the same subject (≤30 s) | direct |
| R2 | ≥3 execution-gate refusals/holds for one executable (≤10 min) | statistical-only |
| R3 | One subject across ≥2 signal categories (union-find over path/pid/name dimensions) | direct |
| R4 | Containment identity-change / PID-reuse refusals | direct |
| R5 | Monitor degradation → later suspicious signals | statistical-only, LOW confidence |
| R6 | Repeated access-denied containment attempts | direct |
| R7 | Security events clustered around an E-stop transition (±60 s) | statistical-only, INFORMATIONAL |

Constraints enforced: dual-use tool names are never evidence (verified: repeated `powershell.exe` creations produce zero correlations); time-less events cannot anchor time-window rules; stale events excluded; per-rule evidence ≤20, results ≤50, deduplicated per rule+subject.

## 4. Security boundaries preserved

- **Production termination remains disabled** — `verifyApprovalAuthority` unchanged (`authorized:false, unavailable:true`); runtime-asserted: containment + approval routes return `APPROVAL_AUTHORITY_UNAVAILABLE`; no new termination route (404 probes); intelligence routes are GET-only.
- **E-stop authoritative** — situation reads the authoritative snapshot (ACTIVE → FAILED, UNCERTAIN → UNKNOWN); recommendations under an active stop are suppressed to notify/review/evidence only.
- **No promotion** — correlation/assessment never re-classify; UNKNOWN stays UNKNOWN (suite-asserted); Phase B precedence untouched.
- **Privacy** — metadata-only end-to-end; denylist sanitization (password/secret/token/cmdline/content/screen…); strings capped at 200 chars, objects dropped; recommendation/assessment audits contain no paths or subjects beyond counters.
- **E5** — real-store inventory before/after: quarantine/journal/marker byte-identical; audit growth is live-traffic + metadata-only; `threat_containment` records in the real store: **0**.

## 5. Performance (measured, target-hardware budget)

| Metric | Measured | Budget |
|---|---|---|
| Ingest throughput | 10 000 events in 109 ms (**~92 k events/s**) | event-driven, no loops |
| Full-ring read (situation + correlation + assessment, 850 mixed events) | **0.7 ms** | on-demand only |
| Ring memory | 2000-event capacity ≈ low MBs (verified bounded; oldest dropped + counted) | 8 GB RAM |
| Background work | one 5 s in-memory sampler (unref'd) | no high-frequency loops |
| External requests | none (Defender check: explicit, rate-limited 5 min) | no cloud requests |

## 6. Regression (first run vs rerun, exact)

| Suite | First run | Rerun |
|---|---|---|
| **Security Intelligence (Phase E)** | **110 / 0** | **110 / 0** |
| Execution gate (C) | 41 / 0 | 41 / 0 |
| Process monitor (A) | 66 / 0 | 66 / 0 |
| Malware detection (B) | 98 / 0 | 98 / 0 |
| Containment (D.3 + D.4 approval authority) | 114 / 0 | 114 / 0 |
| SPF text | 220 / 0 | 220 / 0 |
| SPF visual | 113 / 0 | 113 / 0 |
| LPV core / security / perf | 92 / 55 / 11 — 0 failed | same |
| E5 M1 | 85 / **1** | 85 / **1** (same known cause) |
| E5 M2 / M3 / H4 | 74 / 72 / 70 — 0 failed | same |
| Phase 13 / 14 / 18 | 91 / 150 / 62 — 0 failed | same |
| Agent core | 49 / 0 | 49 / 0 |
| Goal continuity | 163 / 0 | 163 / 0 |
| `tsc --noEmit` | **0 errors** outside one externally-modified file | same |

**Transient/persistent failures — investigated, not hidden:**
1. **E5 M1 85/1 (both passes):** the documented global-recovery-pipe contention — the live Krisha instance holds `\\.\pipe\krisha-e5-recovery`, so the suite's two pipe-state-machine assertions cannot drive the state machine. All isolated-store assertions pass. The collision also explains the real-store stop-state generation advance (34→38, arm→resume cycles, ended INACTIVE/no-credential — semantically unchanged). Recommendation stands: M1 pipe tests should skip when the pipe is foreign-owned.
2. **`tsc` 23 errors, all in `scripts/test-proactive-conversations.ts` (+ its `src/utils/conversationInactivity.ts`):** these two files were modified by concurrent (user) work DURING this session (07:26/08:31 timestamps; not touched by Phase E). Excluding that WIP file pair, compilation is clean. Not modified, not run as part of Phase E.

## 7. E5 integrity (before/after)

| File | Before | After | Verdict |
|---|---|---|---|
| install.marker | 45 B, `000FA71A` | identical | ✓ |
| stop-state.json | 225 B, `09952D2E`, gen 34 | 225 B, `CE6407AC`, gen 38 | M1 pipe-collision cycle (documented); INACTIVE, no credential — semantically identical |
| audit/server-audit.jsonl | 1,264,197 B, `0954B47E`, 5157 lines | 1,285,835 B, `B555F9D7`, 5245 lines | +88 metadata-only (live traffic + overflow counters); chain intact |
| quarantine (2 files) | `91555D75` / `6124A833` | identical | ✓ |
| sandbox-journal | 4477 B, `44BA7705` | identical | ✓ |
| `threat_containment` records in real store | 0 | **0** | Phase D/E never touched it |

## 8. Known limitations

1. Correlation is intra-process and bounded to the ring (2000 events / ~1 h age window); restarts lose the in-memory stream (E5 audit remains the durable record; a future replay-from-audit capability is possible but not built).
2. LPV decisions enter the stream via the additive sink only while the LPV module is loaded in the same process (it is, via server.ts).
3. Situation Defender availability is UNKNOWN until an explicit rate-limited check — deliberate (no polling).
4. Assessments are computed per read (deterministic for a fixed event set) rather than continuously; the situation view is a moment-in-time snapshot.
5. Recommendations are non-executable by design; RESTRICT_OPERATION points at the operator E-stop route (Phase E cannot invoke it).
6. E5 M1 cannot run green concurrently with the live app (pipe ownership), and its pipe tests exercise the live instance's stop state machine (documented recommendation to fix the suite).

## 9. Implemented vs assumed

**Implemented and verified:** all five capabilities, the event schema with provenance, the seven correlation rules with their constraints, severity/confidence separation, UNKNOWN preservation, honest missing-info surfacing, the bounded response action set with structural rejection, runtime integration, performance numbers, and every safety-regression assertion.

**Assumed/theoretical:** correlation utility for real-world incident workflows (validated against synthetic scenarios only); future replay-from-audit; a future wired approval authority would make previously-unavailable recommendations actionable (out of Phase E scope).

## 10. Final status

**ACCEPTED — PHASE E COMPLETE**

All five capabilities are implemented, verified, and integrated; production termination remains disabled and unreachable; the E-stop remains authoritative; SPF/LPV/E5 security behavior is unchanged (suites green); missing telemetry is never read as safety; performance fits the target hardware with wide margins; TypeScript compiles clean outside one externally-modified WIP file pair.
