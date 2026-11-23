# Krisha — Security System Phase D.4: Approval Authority Verification and Correction

**Verification date:** 2026-11-22
**Scope:** source-inspected determination of what containment approval actually proves; correction of the approval-authority boundary; E-stop interaction; process/evidence binding; E5 preservation; full regression.
**Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md`. Prior reports: Phase D, D.1, D.2, D.3.

---

## 1. Determination (source-backed)

**The Phase D.3 approval mechanism did NOT represent an independent operator decision.** It was a server-generated token obtainable by any caller satisfying the route's permission baseline — and `application.launch` is baseline-true by the Phase 18 operator doctrine. A caller could self-serve the entire loop: `POST /api/containment/approve` → receive a token → immediately `POST /api/containment/contain` → terminate. No step required a human decision, a credential, or any evidence a same-user process cannot produce.

This is not unique to containment. Source inspection of every approval surface in the repository shows the same model, and the source documents it explicitly:

- `rollbackCore.ts:381` — *"Operator approval — reachable ONLY through the Krisha UI affordance. The model has no tool or bridge path here (**disclosed same-user boundary applies to raw loopback HTTP**)."*
- `lpvCore.ts:1573` — *"the honest boundary remains the documented same-user one ... from another same-user process — disclosed in ARCHITECTURE.md §33."*
- `serverSafety.ts:980` — *"the operator baseline is permissive BY DOCUMENTED DECISION. The MODEL is filtered by the browser-side gate ... The server state is authoritative for: the emergency stop, revocation semantics, and scoped-grant consumption."*

**The system has no authenticated user identity anywhere.** There is no session concept, no caller credential on any route, and no server-side distinction between "the operator's UI clicked Approve" and "a rogue same-user process POSTed Approve". The model/operator separation on approval routes is architectural discipline (no tool/bridge path — verified: `src/agent/bridge.ts` has no containment or token surface; `ThreatContainment.issueApproval` has exactly one caller, the HTTP route), not enforcement.

**The only server-verified operator secret in the entire system** is the E5 recovery credential (scrypt-hashed in the protected store, used by the recovery pipe to lift an E-stop). Repurposing it as a containment-approval authenticator was considered and rejected: it would silently change the meaning of a break-glass secret, expand its exposure to routine HTTP calls, and couple approval to E-stop recovery state (task §4 forbids weakening the E-stop).

## 2. Approval call graph (as found, and as corrected)

**As found (Phase D.3):**
```
[any same-user caller, or the operator UI — indistinguishable server-side]
  POST /api/containment/approve        (permission application.launch: baseline TRUE)
    → ThreatContainment.issueApproval(pid)
        ├─ E-stop check
        ├─ readProcessIdentity(pid)          ← server-side, via OS reference
        ├─ protected-process / ambiguity gates
        ├─ classify(path)                    ← Phase B dependency
        └─ MINT token (single-use, 5-min TTL, bound to process identity)
  POST /api/containment/contain        (permission application.launch: baseline TRUE)
    → ThreatContainment.contain({pid, approvalToken})
        ├─ E-stop check → token shape → registry pre-check
        ├─ pin(pid) → identity match → protected check
        ├─ classify(pinned path) → freshness
        ├─ E-stop re-check
        └─ terminate via pinned handle
```
Answers to the required sequence: (1) whoever holds `application.launch`; (2) nobody independently authorizes — the route IS the authorization; (3) the server (`issueApproval`); (4) in-memory registry; (5) the same caller that requested it; (6) anyone with the token string; (7) only the registry (single-use/TTL) — nothing prevents SELF-ISSUANCE; (8) refusal + metadata-only audit. Critical questions: self-service token acquisition — **YES** (defect); immediate own-token consumption — **YES** (defect); client input influencing approval — **NO** (D.3 fix held); impersonating an operator — trivially possible, because "operator" is not a server-side concept (defect); transfer/replay — **NO** (D.3 binding held).

**As corrected (Phase D.4):**
```
POST /api/containment/approve     (permission + stopBlock 423 + rate, unchanged)
  → ThreatContainment.issueApproval(pid)
      ├─ E-stop check
      ├─ verifyApprovalAuthority({pid})   ← NEW: INDEPENDENT authority gate
      │     production wiring: authorized:false, unavailable:true
      ├─ (never reached in production: identity read, classification, mint)
POST /api/containment/contain     (permission + stopBlock 423 + rate, unchanged)
  → ThreatContainment.contain({pid, approvalToken})
      ├─ E-stop check (entry)
      ├─ verifyApprovalAuthority({pid})   ← NEW: refusal precedes ALL probing
      ├─ (never reached in production: token checks, pin, classification,
      │    E-stop re-check, authority RE-CHECK pre-termination, termination)
```
**Production behavior: containment termination is unreachable.** Every request returns `APPROVAL_AUTHORITY_UNAVAILABLE`; no token is ever minted; the approval registry stays empty. The refusal is explicit and audited (`approvalAuthority: 'unavailable'`).

## 3. The correction

New dependency in `ContainmentDependencies`:

```ts
verifyApprovalAuthority(input: { pid: number }): ApprovalAuthorityResult | Promise<ApprovalAuthorityResult>
// ApprovalAuthorityResult =
//   | { authorized: true;  authorityId: string; method: string }
//   | { authorized: false; unavailable: boolean; reason: string }
```

- **What it separates:** application permission (a capability grant) from operator approval (evidence that a decision about THIS action was made). A permission satisfies routes; only the authority satisfies termination.
- **Where it is enforced:** `issueApproval` (after E-stop, before identity read/classification/minting) and `contain` (after E-stop entry, before token/registry/pin handling) plus a **re-check immediately before termination** (fail-closed, mirroring the E-stop re-check — an authority that disappears or denies mid-flight stops the termination even with a consumed token).
- **Production wiring (`server.ts`):** returns `authorized: false, unavailable: true` with an explicit reason. No new identity system was invented; no existing permission changed meaning; the capability gap is declared, not simulated.
- **Normalization:** infrastructure failure inside the authority dependency normalizes to `unavailable` (fail-closed). A capable authority that DENIES yields `REFUSED_NO_APPROVAL` (authorization-denied outcome preserved for future mechanisms).
- **New outcome:** `APPROVAL_AUTHORITY_UNAVAILABLE`. Audit events gain `approvalAuthority` (`'not_evaluated' | 'unavailable' | 'denied' | <method>`), metadata-only.
- **Preserved by design:** the entire Phase D.3 termination machinery remains intact and regression-tested under an authority-capable mock (`test-verified-operator`), proving the pipeline honors a verified authority decision end-to-end (pin → binding → classification → E-stop → pinned termination → post-verification). The production wiring simply has no such authority to inject yet.

**Explicitly not changed (findings documented for the record):** the exec-gate launch-approval route (`/api/execgate/approve`) shares the same self-service property — with `application.launch` baseline-true, its approval layer adds no marginal server-side restriction today; its durable value is the non-overridable CONFIRMED_MALWARE block. Correcting it would alter Phase C behavior and is outside Phase D scope (stop condition §13); it is recorded as a finding with the same root cause.

## 4. Process and evidence binding (verified intact)

Approval binds to: exact process-instance identity `{pid, creationTime, executablePath, name}` (token binding validated against the PINNED identity; any mismatch consumes the token — `REFUSED_PID_REUSED` / `REFUSED_IDENTITY_CHANGED`), executable identity (server-read through OS references at both ends), classification evidence (server-side at issuance AND containment; downgrade/staleness/failure refuse), single-use consumption, and 5-minute expiry. A change in process identity or evidence invalidates the approval (suite-asserted, sections 3–5).

## 5. Required test scenarios (task §6) — mapping

| # | Scenario | Where | Result |
|---|---|---|---|
| 1 | Authorized operator approval | §1/§11a–11c (authority-capable mock, full pipeline) | PASS |
| 2 | Unauthenticated approval request | §11d/11h + runtime 12e (no caller can obtain approval) | PASS |
| 3 | `application.launch` without independent authority | §11d–11e + runtime 12c/12e (permission granted, still refused) | PASS |
| 4 | Ordinary agent attempting approval | §11f–11g (no tool/bridge path; authority gate refuses) | PASS |
| 5 | Malware classifier attempting self-approval | §11f–11g (authority precedes classification — classifier never runs) | PASS |
| 6 | Client-supplied approval claims | §11h (injected `approved/operatorApproved/operatorId` fields inert) | PASS |
| 7 | Forged approval token | §11i (production) + §3b (capable authority) | PASS |
| 8 | Expired token | §3c | PASS |
| 9 | Replayed token | §8b | PASS |
| 10 | Concurrent token consumption | §8c | PASS |
| 11 | Approval transferred to another process | §3e/§4a | PASS |
| 12 | Process identity changed after approval | §4a–4f | PASS |
| 13 | Evidence changed after approval | §5c/§5d | PASS |
| 14 | E-stop active during approval | §2a + runtime 12j/12k (423) | PASS |
| 15 | E-stop activated after approval | §6a | PASS |
| 16 | Approval service unavailable | §11j (throws → fail-closed) + production wiring | PASS |
| 17 | Authorization service unavailable | §11k (containment path) + §11l (lost mid-flight) | PASS |

Phase D.3 guarantees re-verified in the same suite: pinning, retained handle, `TerminateProcess` against the pin, no taskkill fallback, no PID-only termination, protected-process exclusion, `IDENTITY_NOT_GUARANTEED` fail-closed, E-stop at every boundary, metadata-only auditing — all green under the authority-capable mock (114 assertions total, real pin-worker smoke test included).

## 6. Regression results (first run vs rerun, exact)

| Suite | First run | Rerun |
|---|---|---|
| **Containment (D.3 + D.4)** | 114 / 0* | 114 / 0 |
| Execution gate (C) | 41 / 0 | 41 / 0 |
| Process monitor (A) | 66 / 0 | 66 / 0 |
| Malware detection (B) | 98 / 0 | 98 / 0 |
| SPF text | 220 / 0 | 220 / 0 |
| SPF visual | 110 / **3** | 113 / 0 |
| LPV core / security / perf | 92 / 55 / 11 — 0 failed | same |
| E5 M1 | 85 / **1** | 85 / **1** (persistent while live app runs) |
| E5 M2 / M3 / H4 | 74 / 72 / 70 — 0 failed | same |
| Phase 13 / 14 / 18 | 91 / 150 / 62 — 0 failed | same |
| Agent core | 49 / 0 | 49 / 0 |
| Goal continuity | 163 / 0 | 163 / 0 |
| `tsc --noEmit` | 0 errors | 0 errors |

\* An earlier D.4 development run hit a transient runtime crash (`ECONNRESET`; the spawned test server died mid-run with the shared Vite HMR port 24678 and the global recovery pipe contended by the live Krisha instance); the formal first run and rerun are recorded above.

**Transient failures — investigated, not hidden:**
1. **SPF visual 3 failures (first run only):** the known live-server cold-start OCR boot timeout; 113/0 on rerun. Same pattern as D.1–D.3 campaigns.
2. **E5 M1 85/1 (both passes) — root cause fully identified:** the M1 suite's recovery-pipe tests require OWNERSHIP of the global named pipe `\\.\pipe\krisha-e5-recovery`. During this campaign the **live Krisha instance was running and held the pipe**, so the suite could not bind it (`EADDRINUSE`) and its two pipe-state-machine assertions failed. All isolated-store assertions passed.

## 7. E5 integrity (before/after, including the M1 pipe-collision investigation)

| File | Before (2026-11-22) | After | Verdict |
|---|---|---|---|
| install.marker | 45 B, `000FA71A` | 45 B, `000FA71A` | identical |
| stop-state.json | 225 B, `70A73C1D`, gen 26 | 225 B, `09952D2E`, gen 34 | **modified — see below** |
| audit/server-audit.jsonl | 1,212,250 B, `0F0671FA`, 4939 lines | 1,254,640 B, `6D637F7F`, 5117 lines | +178 metadata-only records |
| quarantine (data + meta) | `91555D75` / `6124A833` | same | identical |
| sandbox-journal | 4477 B, `44BA7705` | same | identical |
| Stop state | INACTIVE, no credential | INACTIVE, **no credential**, gen 34 | semantically identical |

**Investigation of the unexpected modifications (task §8):**
- **`threat_containment` records in the real store: 0** — no Phase D operation has ever touched the real E5 store; all D.3/D.4 tests ran on isolated sandboxes.
- The `e5_stop_armed` (seq 5102) → resume (seq 5103) pair and the generation advance 26→34 were caused by the **E5 M1 suite's pipe tests driving the LIVE server through the global recovery pipe** (the live instance owned the pipe, so the suite's pipe client reached it instead of its own test server). The cycle ended INACTIVE with no credential set — the stop state is semantically unchanged; the generation counter advanced by design.
- The audit growth is metadata-only: live UI `executed` records, `process_monitor_queue_overflow` counters (the live Phase A monitor under regression load — documented bounded-queue behavior), and the M1 pipe-operation records. The chain remains append-only and intact.
- **Recommendation (out of D.4 scope):** the E5 M1 pipe tests should detect foreign pipe ownership (bind probe) and skip/flag instead of exercising the live instance's state machine. Until then, E5 M1 cannot run green concurrently with the live app.

## 8. Remaining limitations

1. **No independent operator-approval capability exists in this architecture** — termination therefore remains DISABLED in production (`APPROVAL_AUTHORITY_UNAVAILABLE`). Establishing it requires a server-verified operator decision mechanism (authenticated operator session or credential-bound approval), which would be a new capability, deliberately not invented here.
2. Permission-based authorization cannot distinguish the operator's UI from any same-user process — the disclosed Phase 18 boundary, now made explicit in code (authority wiring comment) and documentation.
3. The exec-gate launch approval shares the self-service property (documented finding, unchanged behavior).
4. E5 M1 cannot run green concurrently with the live Krisha instance (global recovery-pipe contention).
5. Token consumption on any post-validation refusal requires fresh approval — deliberate fail-closed posture (unchanged from D.3).

## 9. Files modified

- `src/agent/containment/containmentTypes.ts` — `ApprovalAuthorityResult`, `APPROVAL_AUTHORITY_UNAVAILABLE`, `verifyApprovalAuthority` dependency, `approvalAuthority` audit field
- `src/agent/containment/containment.ts` — authority gate at issuance + containment entry + pre-termination re-check (tagged-decision normalization, fail-closed on infrastructure failure), audit enrichment
- `server.ts` — production authority wiring (unavailable, with explicit rationale comment)
- `scripts/test-containment.ts` — 114 assertions (authority-capable harness default + Phase D.4 section 11 + updated runtime expectations)
- `SECURITY-SYSTEM-PHASE-D4-REPORT.md` — this report
- `ARCHITECTURE.md` §39 — approval-authority subsection added

## 10. Implemented behavior vs assumptions

**Implemented and verified:** the authority gate and its placement; production refusal of all containment; no token issuance; audit of every refusal; machinery correctness under a verified authority; binding/expiry/single-use; E-stop precedence (authority never bypasses the E-stop — checked before the authority at entry, and both re-checked pre-termination); metadata-only audit; E5 isolation for all Phase D tests.

**Assumptions / theoretical:** that a future verified authority (authenticated session, credential-bound approval) would be trusted once wired — its correctness would need its own verification; that the disclosed same-user boundary remains acceptable for read-only detection surfaces (Phase A/B tools, assess routes).

## 11. Final status

**CONDITIONALLY ACCEPTED — TERMINATION DISABLED PENDING APPROVAL CAPABILITY**

Approval authority was established by source inspection: no independent operator-approval mechanism exists in this architecture, so `application.launch` (or any permission) is no longer treated as proof of operator approval anywhere in the containment pathway. Detection, classification, process-instance pinning, E-stop enforcement, and metadata-only auditing remain fully operational; termination is unreachable until a genuine verified approval capability exists and is wired into the injectable authority dependency. All required tests pass; the real E5 store holds zero containment records; TypeScript compiles clean.
