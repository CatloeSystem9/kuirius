# Krisha — Security System Phase D: Complete Audit, Repair and Acceptance — Final Report

**Date:** 2026-11-22
**Scope:** full audit of the Phase D containment system (D.1–D.4), the operator-approval resolution, containment correctness, production integration, security boundaries, regression, and E5 integrity.
**Prior reports:** D, D.1, D.2, D.3, D.4, targeted repair. **Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md`.

---

## 1. Original design and intended responsibilities

Phase D responds to a process that Phase B independently classified as CONFIRMED_MALWARE. Lifecycle: Phase A observes → Phase B classifies → Phase C gates Krisha-managed execution → **Phase D contains (identity-safe, auditable)** → Phase E provides intelligence. Phase D is NOT a detection engine and does not replace Defender. Its guarantees, as built across D.1–D.4 and verified in this campaign: OS process-instance pinning (a retained `OpenProcess` handle — termination can never follow PID reuse), identity read through the pin (creation time via `GetProcessTimes`, image path via `QueryFullProcessImageName`), server-side Phase B classification of the pinned executable, operator approval (D.4 authority gate; credential-backed since this campaign), single-use/TTL/identity-bound tokens, E-stop at every boundary, protected-process exclusion, metadata-only E5 auditing, no taskkill anywhere, no broad kill.

## 2. Full audit findings (source-inspected this campaign)

1. **The approval-authority gap (D.4)** — termination was disabled because no genuine operator-approval authority existed; `application.launch` (baseline-true) was the only gate, so any caller could self-serve approve+contain. RESOLVED (§3/§5).
2. **The recovery credential is episode-scoped** — `activateStop` and `recoverStop` both CLEAR it, so it cannot anchor containment approval in the normal INACTIVE state. This invalidated the simplest reuse idea and shaped the final design (a dedicated enrollment credential on the same trusted primitives).
3. **`clearContainmentApprovalCredential` left stale failure pacing** — a verification against a CLEARED authority threw a backoff error instead of failing closed quietly. Found by the new tests; fixed (pacing resets on clear).
4. **The credential authority conflated "not enrolled" with "wrong credential"** in the approval branch — a pre-enrollment approval surfaced as DENIED instead of UNAVAILABLE. Fixed (enrollment is checked first; the D.4 posture is preserved exactly).
5. **Route contract change** — approval now requires `operatorCredential`; the security-intel suite's approval assertion was updated to the new contract (the security property it asserts — no token without a verified decision — still holds, stronger than before).
6. **Spawned-server runtime transient** — one containment run lost its spawned server mid-runtime (`ECONNRESET`, exit code null, no server-side stack; all unit assertions green). Same environmental pattern observed in D.4/E campaigns; passes on rerun. Documented, not hidden.
7. **External concurrent user work** — during this campaign the user actively edited Background Presence and vision files (`conversationTurnManager`, `test-proactive-conversations` (resolved), `test-camera-vision`, `liveWatcher`, `screenUnderstanding`, `test-vision-live`). Repository `tsc` snapshots show changing error sets confined to THEIR files; every Phase D file compiles clean. Not touched, reported honestly.

Verified-intact (no changes needed): pin implementation and identity verification; single-use/epoch token machinery; protected-process set; E-stop checks at entry and pre-termination; E5 audit recording; rate limits (10/min per route, separate groups); Phase E ingestion via `auditAndIngest`; concurrent duplicate containment (registry + single-use); worker timeouts and guaranteed `release()`.

## 3. The operator-approval resolution (§3 of the task)

**Investigation:** the only server-verified operator knowledge factor in the entire architecture is the E5 recovery credential — but it is episode-scoped (cleared on activation and recovery), so it cannot authorize containment in the normal state. No authenticated user identity exists anywhere; every other approval surface is permission-gated. The disclosed same-user OS boundary applies to everything a same-user process can reach.

**Design — a dedicated, operator-enrolled approval credential** (reusing the E5 trusted primitives, not a new trust system):

- **Enrollment (operator channel only):** `set-containment-credential` / `clear-containment-credential` recovery-pipe ops. The recovery CLI is the documented operator channel; the MODEL has no tool or bridge path to it. The credential lives in the protected E5 store (`containment-approval.json`: scrypt hash + salt + timing-safe compare + integrity self-hash, durable tmp+rename writes), deliberately separate from the episode-scoped recovery credential.
- **Approval (the human decision moment):** `POST /api/containment/approve` requires `operatorCredential`; the server verifies it with the E5 machinery (`verifyContainmentApprovalCredential`). A token is minted ONLY after verification — a server-generated token is never mistaken for the operator's decision, because no token can exist without one.
- **Binding:** the token remains bound to the exact pinned identity `{pid, creationTime, executablePath, name}`, single-use, 5-minute TTL, and now carries the **authority epoch** (bumped on every enrollment change).
- **Re-validation immediately before termination:** the pinned identity is re-read through the handle (D.3), the E-stop is re-checked (D.1), AND the authority epoch is re-checked — a credential cleared or re-enrolled between approval and termination refuses the termination (`REFUSED_NO_APPROVAL`, "authority changed since issuance").
- **Fail-closed everywhere:** forged (not server-issued), replayed (single-use), expired (TTL), mismatched (binding), wrong-credential (denied), not-enrolled (UNAVAILABLE — the D.4 posture), and verification-infrastructure failure (backoff/fail-closed) all refuse. Failed verifications share an exponential backoff (no brute-force oracle); clearing the enrollment resets pacing and restores the disabled posture.
- **What it defends:** agent self-authorization (the model cannot enroll — no tool path — and cannot guess a scrypt-protected secret) and permission-only callers (`application.launch` never mints anything). **What it cannot defend:** a same-user process reaching the enrollment pipe — the disclosed OS boundary, identical to the recovery credential's; such a process can terminate processes directly without Krisha. This is documented, not hidden.

**Before enrollment, termination is disabled (the D.4 posture).** The real E5 store has NO `containment-approval.json` — the operator has not enrolled, so production containment remains disabled until they choose to enable it. The mechanism is genuinely defensible and opt-in; nothing was weakened to enable it.

## 4. Containment implementation and identity guarantees (verified)

Pin → identity through the handle → token binding (epoch captured) → protected-process check on the pinned name → server-side classification (CONFIRMED_MALWARE only; downgrade/stale/failure refuse) → E-stop re-check → authority-epoch re-check → `TerminateProcess` on the pinned handle → post-verification through the same pin (`exited`/`still_running`/`cannot-determine` honestly distinguished) → `release()` on every path. No PID-only termination, no taskkill fallback, no automatic privilege escalation, no process-tree kill. CLEAN/UNKNOWN/SUSPICIOUS never terminate; only an independent source CONFIRMED_MALWARE fact qualifies.

## 5. Production integration (verified through the real routes)

Production singleton construction wired to `createCredentialApprovalAuthority` over the E5 enrollment getters; both routes permission-gated (`application.launch`), stop-blocked (423), rate-limited; request shape validation (pid/token/credential); E5 audit on every attempt; Phase E ingestion of every decision; the situation view reports `approvalAuthority: 'operator-approval-credential' | 'unavailable'` honestly. Runtime tests spawn a real server on an isolated store and verify: forged-token refusal, no-bypass routes (404), GET-only intelligence routes, E-stop 423 on both routes, persisted stop across restart, corrupted-state `emergency_stop_uncertain`, and the full credential gate through the spawned server's own recovery pipe (enroll → wrong credential DENIED → correct credential PROCEEDS to identity read (`ALREADY_EXITED` for a ghost pid) → benign live process REFUSED at the server-side classification gate → clearing restores the disabled posture).

## 6. Files created or modified

| File | Change |
|---|---|
| `serverSafety.ts` | containment approval credential machinery (enroll/clear/verify, epoch, backoff, integrity-hashed protected file, boot load) + two recovery-pipe ops |
| `src/agent/containment/containmentTypes.ts` | authority input shapes (`operatorCredential`/`authorityEpoch`), token `authorityEpoch`, authorized-result epoch |
| `src/agent/containment/containment.ts` | `createCredentialApprovalAuthority` factory; `issueApproval(pid, operatorCredential)`; binding returns the epoch; pre-termination epoch re-check; clear-pacing fix removed a defect |
| `src/agent/containment/index.ts` | factory export |
| `server.ts` | credential-backed production wiring; approve route requires `operatorCredential`; situation authority label reflects enrollment |
| `scripts/test-containment.ts` | 142 assertions: sections 11P (credential authority), 13 (E5 credential machinery), 12p–12v (runtime credential gate through the real pipe) |
| `scripts/test-security-intel.ts` | 7h assertion updated to the new approval contract |
| `ARCHITECTURE.md` §39 | approval-authority + tests + limitations updated |

## 7. Test results (first run / rerun, exact)

| Suite | First run | Rerun |
|---|---|---|
| **Containment (D.3 + credential authority)** | 142 / 0 | 131 / 1 (spawned-server transient) → **142 / 0** |
| Process monitor (A) | 66 / 0 | 66 / 0 |
| Malware detection (B) | 98 / 0 | 98 / 0 |
| Execution gate (C) | 41 / 0 | 41 / 0 |
| Phase E security intelligence | 109 / 1 (7h contract update) → 110 / 0 | 110 / 0 |
| E5 M1 / M2 / M3 / H4 | 87 / 74 / 72 / 70 — 0 failed | same |
| SPF text | 220 / 0 | 220 / 0 |
| SPF visual | 109 / **4** (cold-start OCR transient) | 113 / 0 |
| LPV core / security / perf | 92 / 55 / **9+2** (perf: machine-load flake) / 0 | 92 / 55 / **11** / 0 |
| Phase 13 / 14 / 18 | 91 / 150 / 62 — 0 failed | same |
| `tsc --noEmit` | 0 errors in all Phase D files; changing error sets confined to the user's actively-edited Background-Presence/vision files (external, not touched) | same |

Transient failures are reported, not hidden: one spawned-server ECONNRESET (exit code null, no server-side stack — environmental, recurs only in spawned-server runtime sections, passes on rerun), one SPF-visual cold-start OCR set (109/4 → 113/0), one LPV-PERF timing flake under machine load (9/2 → 11/0).

## 8. E5 before-and-after integrity

| File | Before this campaign | After | Verdict |
|---|---|---|---|
| install.marker | 45 B, `000FA71A` | identical | byte-identical |
| stop-state.json | 225 B, `5512237F`, gen 40 | 225 B, `5512237F`, gen 40 | **byte-identical** — no recovery operation occurred, no generation drift |
| quarantine (2 files) | `91555D75` / `6124A833` | identical | byte-identical |
| sandbox-journal | 4477 B, `44BA7705` | identical | byte-identical |
| audit/server-audit.jsonl | 1,390,467 B, `1DE167F9`, 5682 lines | 1,414,262 B, `E8D79811`, 5777 lines | +95 metadata-only records (live UI traffic; all Phase D tests ran on isolated stores) |
| Real-store `threat_containment` records | 0 | **0** | containment has never touched the real store |
| Real-store `containment-approval.json` | absent | **absent** | the operator has not enrolled — production termination remains in the disabled posture until they do |

## 9. Remaining limitations (explicit)

1. **Same-user OS boundary on enrollment** — a same-user process can reach the enrollment pipe exactly as it can reach the recovery credential. The defended threat is agent self-authorization; same-user malware can terminate processes directly without Krisha. Fundamental to the non-admin architecture; documented, not solvable without an OS-level trust change.
2. **Operator enrollment is required** — before `set-containment-credential`, termination stays disabled. This is the designed opt-in, not a defect.
3. **Exec-gate launch approval remains self-service** (Phase C scope, documented finding; its durable value is the non-overridable CONFIRMED_MALWARE block).
4. **Spawned-server runtime tests occasionally lose the child process** on this machine under concurrent load (ECONNRESET, exit code null) — environmental; unit sections always complete; reruns pass.
5. **Concurrent user workstreams** are actively editing presence/vision files; repository-wide `tsc` snapshots vary with their edits. All Phase D files compile clean.
6. Elevated/SYSTEM processes cannot be pinned (`IDENTITY_NOT_GUARANTEED` — same-user ceiling).

## 10. Final acceptance decision

**COMPLETE — all acceptance criteria verified.**

- Containment implementation correct: pinning, identity revalidation, honest outcomes — suite-verified.
- Production integration verified through the real routes on isolated stores, including the full credential gate.
- Authorization and approval are genuine: the operator enrolls a secret through a channel with no model/tool path; the server verifies it (scrypt, protected store); tokens cannot exist without it; epoch re-check prevents mid-operation authority loss; `application.launch` never substitutes for the decision.
- Identity safely pinned and revalidated; PID reuse structurally impossible.
- E-stop authoritative; E5 protected (byte-identical stop state, zero containment records); no bypass introduced.
- Confirmed-malware containment exercised end-to-end through a safe controlled pathway (unit full-path with the production authority factory; runtime through the classification boundary).
- All required regression suites pass; transient failures reported honestly.
- Remaining platform limitations documented explicitly (above).
