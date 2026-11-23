# Krisha — Security System Phase D.3: PID-Safe Containment and Runtime Authorization

**Verification date:** 2026-11-21
**Scope:** process-instance termination safety (PID reuse), runtime authorization boundary of the containment routes, E-stop enforcement through the production pathway, classification/evidence binding, audit correctness, E5 preservation, full regression.
**Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md`. Prior reports: Phase D, D.1, D.2.

---

## 1. Windows process identity mechanism investigated

| Mechanism | Privilege envelope | Binds to instance? | Verdict |
|---|---|---|---|
| `taskkill /PID <pid> /F` (Phase D) | same-user, non-admin | NO — re-resolves the PID to a process object at its own execution time | **REMOVED** — the root cause of the PID-reuse race |
| `OpenProcess` + retained handle → `TerminateProcess(handle)` (Phase D.3) | same-user, non-admin (identical envelope — taskkill uses the same APIs internally) | YES — the handle references the kernel process OBJECT | **ADOPTED** — documented Win32, no driver, no privilege escalation |
| `NtOpenProcess`/handle pinning at kernel level | native code | yes | not needed — the documented `OpenProcess` path already pins |
| `Process.Kill()` (.NET) | same-user | NO — re-resolves the PID at Kill() time | rejected |
| Custom kernel driver | admin + driver signing | — | prohibited by task rules; not attempted |

Access rights used: `PROCESS_TERMINATE (0x0001) | PROCESS_QUERY_LIMITED_INFORMATION (0x1000)` — sufficient for `GetProcessTimes` (creation time) and `QueryFullProcessImageName` (image path) on Windows Vista+, and identical in reach to what `taskkill` requires. Elevated/SYSTEM processes refuse `OpenProcess` with ERROR_ACCESS_DENIED — the same ceiling taskkill had, now surfaced as `IDENTITY_NOT_GUARANTEED` instead of an unreliable termination attempt.

## 2. PID-reuse analysis (the defect)

**Phase D pipeline:** WMI identity check at time T1 → `taskkill /PID` at time T2. `taskkill` opens the process by PID **at T2**. If the target exits between T1 and T2 and Windows assigns its PID to a new process, the termination signal goes to the NEW process. Post-termination WMI verification (Phase D.1) can *detect* most such cases but cannot *undo* a wrong kill. Phase D.1 §4 documented this honestly as a residual TOCTOU window; Phase D.3 eliminates it.

**Phase D.3 pipeline:** `OpenProcess` at T0 (pin) → identity read THROUGH the handle at T1 → `TerminateProcess(handle)` at T2. Whatever happens to the PID between T0 and T2 is irrelevant: the handle refers to the object pinned at T0. An exited process makes termination a harmless no-op on a dead object; a PID-reused process is a different kernel object the handle cannot reference. **The wrong-kill scenario is structurally impossible, not probabilistically mitigated.**

## 3. Termination safety decision

**Termination remains ENABLED**, bound to process-instance references:

- PID alone never establishes identity — creation time, image path, and name must all match the approved instance through the pin.
- Ambiguous identity (metadata unreadable through the pin: empty path/creation time) fails closed.
- Where a terminate-capable reference cannot be opened, the outcome is `IDENTITY_NOT_GUARANTEED` (termination refused; termination-attempt flags remain false). There is NO taskkill fallback anywhere in the module.
- Protected Windows processes are refused at approval AND at containment (checked against the pinned name, not client claims).
- No privilege escalation, no broad/process-tree termination, no automatic termination.

## 4. Authorization call graph (Phase D.3)

```
POST /api/containment/approve      ← ENFORCED: permission application.launch
  │                                  + stopBlock(423) + rate 10/min (own group)
  ▼
ThreatContainment.issueApproval(pid)
  ├─ E-stop check (no authorization material while stopped)
  ├─ readProcessIdentity(pid)      ← server-side, through an OS reference (mockable dep)
  ├─ ambiguity / protected-process gates
  ├─ classify(path)                ← Phase B dependency injected by server.ts
  └─ mint single-use token bound to {pid, creationTime, path, name}, TTL 5 min

POST /api/containment/contain      ← ENFORCED: permission application.launch
  │                                  + stopBlock(423) + rate 10/min (own group)
  │  request shape: {pid, approvalToken} ONLY (legacy client-supplied
  │  target/evidence shape → 400)
  ▼
ThreatContainment.contain({pid, approvalToken})
  ├─ E-stop check (entry)
  ├─ token shape check
  ├─ registry pre-check (unknown/expired/consumed → refuse BEFORE any process probing)
  ├─ pinProcess(pid)               ← OS reference; NOT_FOUND → ALREADY_EXITED,
  │                                  ACCESS_DENIED → IDENTITY_NOT_GUARANTEED,
  │                                  infra failure → VERIFICATION_UNAVAILABLE
  ├─ identity match token↔pin (creation time / path / name; mismatch consumes token)
  ├─ protected-process check (pinned name)
  ├─ classify(pinned path)         ← server-side; client labels cannot reach here
  ├─ freshness check (server assessment < 24 h)
  ├─ E-stop re-check (immediately before termination)
  ├─ pin.terminate()               ← TerminateProcess on the pinned handle
  ├─ pin.hasExited()               ← post-verification through the SAME pin
  └─ release() on every path (finally)
```

## 5. Authentication and permission boundaries

- **Server-side permission state** (`serverSafety.ts` M1b) is the authorization authority: both containment routes now require `application.launch` (the same operator-level permission governing `/api/app/close` process control). Ungranted → 403, audited.
- **Loopback binding:** the server listens on `127.0.0.1` by default (`KRISHA_BIND`); containment routes are not reachable from remote hosts on the default configuration.
- **No alternate route:** `POST /api/containment/kill` → 404 (suite-asserted); GET `/api/containment/contain` never reaches a containment handler (Express POST-only routing; suite-asserted that no containment JSON is returned).
- **No agent pathway:** no containment tool is registered in the ToolRegistry; `malwareDetect.*` tools are read-only; agents can neither mint tokens nor invoke containment.
- **Classifier separation:** Phase B engine has no containment capability; containment consumes classification through an injected dependency it cannot self-supply.

## 6. Operator identity limitation (documented, not invented around)

The existing architecture authenticates by server-side permission state, not by operator identity (Phase 18 doctrine, permissive operator baseline by documented decision). Phase D.3 does **not** invent an identity mechanism. What the boundary now guarantees:

- Containment authorization requires BOTH (a) the server-side `application.launch` permission at the route AND (b) a server-minted token bound to the exact process identity.
- Tokens cannot be forged, replayed, transferred to another process, or consumed twice (single-use registry, synchronous check-and-consume).
- Ordinary agents cannot obtain equivalent approval authority (no tool, no route without the permission, no token issuance outside `issueApproval`).
- What is NOT claimed: the token does not prove WHICH human operator approved. That remains the documented Phase 18 limitation.

## 7. Classification-to-containment binding

- Approval requires the server's own Phase B assessment of the identity-read executable path to be CONFIRMED_MALWARE. Approval for SUSPICIOUS/UNKNOWN/CLEAN/HIGH_CONFIDENCE_THREAT/UNAVAILABLE is refused.
- Containment re-classifies the pinned executable at containment time (fail-closed on assessment failure; a downgrade after approval refuses; stale evidence refuses).
- The HTTP request cannot supply classification, identity, or evidence — the Phase D.2 client-supplied shape is rejected with 400 (runtime-asserted).
- Phase B classification rules were NOT modified.

## 8. E-stop verification (through the production route)

| Scenario | Result |
|---|---|
| Stop active at entry | `REFUSED_E_STOP` (unit); 423 at route (runtime) |
| Stop activated after approval | `REFUSED_E_STOP` at entry — no process probing while stopped (unit-asserted) |
| Stop activated immediately before termination | `REFUSED_E_STOP` — termination not attempted (unit-asserted) |
| Stop state UNAVAILABLE (corrupted stop-state.json + valid marker) | boot → `ACTIVE_UNCERTAIN` → 423 `emergency_stop_uncertain` (runtime, isolated store) |
| Persisted stop across restart | 423 `emergency_stop_active` after kill+respawn (runtime, isolated store) |
| Concurrent requests | each independently E-stop-checked (unit) |
| Approval while stopped | 423 at route + module refusal (no authorization material minted during a stop) |

No stale token can bypass the E-stop: the E-stop check precedes token validation at entry and precedes termination again.

## 9. Defects found and corrections applied

| # | Defect | Root cause | Affected files | Security impact | Correction |
|---|---|---|---|---|---|
| 1 | PID-reuse wrong-kill window | `taskkill /PID` re-resolves the PID at kill time | `src/agent/containment/containment.ts`, `containmentTypes.ts`, `server.ts` | an unrelated process could receive the termination signal | process-instance pinning (`OpenProcess`/`TerminateProcess` on a retained handle); identity read through the pin; taskkill removed |
| 2 | Containment route reachable without any permission | no `permission` in `ENFORCED_ROUTES` for the route | `server.ts` | any shape-valid caller reached `contain()` | `application.launch` permission on both containment routes |
| 3 | No real approval token (any ≥8-char string accepted) | `contain()` checked only token length; no issuance path existed for containment (the exec-gate deliberately refuses CONFIRMED_MALWARE approvals) | `containment.ts`, `server.ts` | unauthenticated callers could impersonate approval | `issueApproval()` server-side minting + registry validation + single-use + identity binding |
| 4 | Client-supplied classification trusted | route passed `body.evidence.classification` into the CONFIRMED_MALWARE check | `server.ts`, `containment.ts` | forged CONFIRMED_MALWARE label authorized termination | server-side Phase B classification at approval and containment; request shape reduced to `{pid, approvalToken}` |
| 5 | Client-supplied identity treated as the comparison baseline | route passed `body.target.*` into identity checks | `server.ts`, `containment.ts` | identity claims could be shaped by the caller | identity read server-side through OS references; token binding carries the identity |
| 6 | Existence oracle for unauthorized callers | pinning happened before token validation | `containment.ts` | forged-token probing could distinguish live PIDs | registry pre-check precedes pinning |
| 7 | Audit lacked decision fields | audit event lacked requestId/authorization/termination fields | `containmentTypes.ts`, `containment.ts` | attempts not independently reconstructable | enriched metadata-only audit event (§10) |
| 8 | Pin worker transport stall | `-Command -` stdin REPL host reader competes with the worker's `[Console]::In.ReadLine()`; multi-line here-strings also fail to terminate over the REPL | `containment.ts` | containment would hang/fail-closed (correct but unusable) | `-EncodedCommand` transport (verified), C# delivered as single-line base64 |
| 9 | Honest-outcome gap: exited-without-termination | post-verify exited but termination failed | `containment.ts` | mislabeled `ACCESS_DENIED` | `ALREADY_EXITED` with explicit reason |

## 10. Audit correctness

Every attempt (issuance and containment, success or refusal) emits one `threat_containment` E5 record: `requestId`, outcome (decision + reason code), reason, PID/name/creation time, classification, confidence, evidence sources, `evidenceAgeMs`, `estopActive`, `authorized`, `terminationEligible`, `terminationAttempted`, `terminationResult`, `postVerifyResult`, `hasApprovalToken`. **Verified metadata-only:** no token values, no executable paths, no credentials, no screen content, no command lines (suite-asserted). Historical entries untouched.

## 11. E5 preservation (before/after the D.3 campaign)

| File | Before | After | Verdict |
|---|---|---|---|
| install.marker | 45 B, `000FA71A` | 45 B, `000FA71A` | identical |
| stop-state.json | 225 B, `70A73C1D` | 225 B, `70A73C1D` | identical |
| audit/server-audit.jsonl | 1,063,191 B, `023DD305`, 4319 lines | 1,063,191 B, `023DD305`, 4319 lines | **identical — zero growth** |
| quarantine/…data | 16 B, `91555D75` | 16 B, `91555D75` | identical |
| quarantine/…meta.json | 667 B, `6124A833` | 667 B, `6124A833` | identical |
| sandbox-journal/journal.jsonl | 4477 B, `44BA7705` | 4477 B, `44BA7705` | identical |
| Stop state | INACTIVE, generation 26 | INACTIVE, generation 26 | unchanged |

All D.3 tests ran against isolated stores (`KRISHA_SANDBOX_DIR` before any E5 module load; runtime servers spawned with their own sandbox). Pre-campaign growth between the D.2 report and this baseline (905,066 → 1,063,191 B) was traced to live UI polling of read-only routes (`executed` records for `/api/rollback/pending`, `/api/vault/approvals/pending`) — normal production traffic, not test contamination. The historical line-3 discontinuity predates all campaigns and is unchanged.

## 12. Regression results (exact, first run vs rerun)

| Suite | First run | Rerun | Notes |
|---|---|---|---|
| **Containment (Phase D.3)** | **100 / 0** | **100 / 0** | incl. real pin-worker smoke test + runtime route tests |
| Execution gate (Phase C) | 41 / 0 | 41 / 0 | |
| Process monitor (Phase A) | 66 / 0 | 66 / 0 | |
| Malware detection (Phase B) | 98 / 0 | 98 / 0 | |
| SPF text | 220 / 0 | 220 / 0 | |
| SPF visual | 113 / 0 | 113 / 0 | previously flaky (OCR cold start) — green in both passes |
| LPV core | 92 / 0 | 92 / 0 | |
| LPV security | 55 / 0 | 55 / 0 | |
| LPV perf | 11 / 0 | 11 / 0 | |
| E5 M1 | 86 / 0 | 86 / 0 | previously flaky (pipe binding) — green in both passes |
| E5 M2 | 74 / 0 | 74 / 0 | |
| E5 M3 | 72 / 0 | 72 / 0 | |
| E5 H4 | 70 / 0 | 70 / 0 | |
| Phase 13 | 91 / 0 | 91 / 0 | |
| Phase 14 | 150 / 0 | 150 / 0 | |
| Phase 18 | 62 / 0 | 62 / 0 | |
| Agent core | 49 / 0 | 49 / 0 | |
| Goal continuity | 163 / 0 | 163 / 0 | |
| `tsc --noEmit` | 4 errors → 0 after D.3 fixes | 0 | see §13 |

No transient failures occurred in either pass. No test expectations were altered to obtain green results (assertion fixes during development are documented in §9/#8 and were re-verified against corrected code).

## 13. TypeScript compilation and KrixAvatar3D

- The four previously identified `KrixAvatar3D.tsx` TypeScript errors **no longer appear** in `npx tsc --noEmit` output (verified; the file was NOT modified in this campaign).
- Four TypeScript errors existed during D.3 development, all introduced by the D.3 code itself: `HIGH_CONFIDENCE_THREAT` missing from `ContainmentClassification` (2 sites — the containment evidence type must be able to represent the full Phase B output space; extended, and it remains non-terminable) and the `ContainmentDependencies` re-export (2 sites). Fixed; final `tsc --noEmit` exits **0 errors**.

## 14. Verified guarantees vs assumptions

**Verified by tests on this machine (mocked process control + isolated stores + a real read-only pin worker):**
1. Termination acts on a pinned kernel object — PID reuse cannot redirect it (structural + unit-asserted creation-time refusal; real handle mechanics proven by the self-pin smoke test).
2. Unauthenticated/permission-less callers cannot reach containment (403), forged tokens are refused before any process probing, the legacy client-supplied shape is rejected.
3. Tokens are server-minted, single-use (including under concurrency), 5-min TTL, identity-bound; binding mismatches consume the token.
4. Classification is server-side at approval AND containment; client labels are ignored; failure/downgrade/staleness refuse.
5. E-stop is authoritative at entry, after approval, immediately before termination, while unavailable, and across restarts; approval while stopped is refused.
6. Every attempt is audited once, metadata-only.
7. The real E5 store is byte-identical across the campaign.

**Documented Windows/OS limitations (not defects):**
1. Same-user ceiling — elevated/SYSTEM processes cannot be pinned (`IDENTITY_NOT_GUARANTEED`); Krisha cannot contain them without privileges the non-admin operator does not have.
2. A malicious process may exit naturally before termination (`ALREADY_EXITED`, honest).
3. `TerminateProcess` is asynchronous at the OS level — post-verify uses a 5 s wait; a process still terminating after that window is reported honestly (`VERIFICATION_UNAVAILABLE`/`ACCESS_DENIED`).
4. Tokens burned by any post-validation refusal require fresh operator approval (deliberate fail-closed posture).

**Assumptions (not independently verified):** Windows PIDs are reused only after process-object teardown (documented Windows behavior; the pin does not depend on reuse timing); Defender classifications are trustworthy inputs to Phase B (Phase B boundary).

## 15. Files modified

- `src/agent/containment/containmentTypes.ts` — pin model (`PinnedProcess`, `PinUnavailableError`, `ClassificationEvidence`, `ContainmentApprovalToken`, `ContainmentApprovalIssuance`), new outcomes (`IDENTITY_NOT_GUARANTEED`, `REFUSED_APPROVAL_INVALID`, `APPROVAL_ISSUED`), `HIGH_CONFIDENCE_THREAT` classification, enriched audit event, request shape `{pid, approvalToken}`
- `src/agent/containment/containment.ts` — full rewrite: pin worker (`-EncodedCommand`, Win32 P/Invoke via base64 C#), `issueApproval`, token registry, 11-step pinned pipeline, enriched audit
- `src/agent/containment/index.ts` — exports updated
- `server.ts` — containment construction (pin deps + Phase B classify injection), route permissions, rewritten `approve`/`contain` routes (server-side data only)
- `scripts/test-containment.ts` — 100 assertions across 11 sections
- `ARCHITECTURE.md` §39 — rewritten for the D.3 architecture
- `SECURITY-SYSTEM-PHASE-D3-REPORT.md` — this report

## 16. Final status

**CONDITIONALLY ACCEPTED — TERMINATION ENABLED WITH PROCESS-INSTANCE PINNING; BOUNDED LIMITATIONS DOCUMENTED**

Termination remains enabled because the pin establishes the exact-instance guarantee within the existing privilege envelope (the acceptance rule's disable-branch does not apply). Remaining bounded limitations: same-user ceiling (`IDENTITY_NOT_GUARANTEED` for elevated processes), permission-based (not identity-based) operator authorization per Phase 18 doctrine, and honest-but-uncertain outcomes when Windows cannot confirm termination. None of these reintroduces the PID-reuse risk; all are documented above and in `ARCHITECTURE.md` §39.
