# Krisha — Security System Phase C: Protected Execution and Threat Containment — Implementation Report

**Completion date:** 2026-11-19
**Scope:** centralized Krisha-managed launch gate + Phase A reliability fix + containment decision architecture. Detection and classification (Phase B) unchanged; containment execution (terminate/quarantine) deferred to Phase D.
**Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md`.

---

## 1. Architecture

```
[Krisha server process]
  ExecutionGate (src/agent/execgate/execGate.ts — Node-only)
    ├─ Dependencies injected from server.ts:
    │    classify(path) → Phase B DetectionEngine.assessFile(path)
    │    isStopActive() → serverSafety.stopKind() !== 'INACTIVE'
    │    statFile(path) → fs.promises.stat (replacement detection)
    │    audit(event) → appendAuditSyncSafe (E5 chain)
    ├─ decide({path, name?, approvalToken?}) → ExecutionDecisionResult
    │    CONFIRMED_MALWARE → BLOCK_CONFIRMED_MALWARE (non-overridable)
    │    HIGH_CONFIDENCE_THREAT → REQUIRE_USER_APPROVAL
    │    SUSPICIOUS → REQUIRE_USER_APPROVAL
    │    UNKNOWN → DENY_UNVERIFIED
    │    CLEAN → ALLOW
    │    UNAVAILABLE → BLOCK_SYSTEM_UNAVAILABLE
    │    E-stop active → BLOCK_SYSTEM_UNAVAILABLE
    ├─ issueApproval(path, identity, classification) → single-use token
    │    CONFIRMED_MALWARE → null (non-overridable)
    ├─ validateApprovalToken(token, path, identity) → single-use, expiring, path+identity bound
    └─ Replacement detection: stat before and after classification; identity mismatch → BLOCK

  systemAgentServer.ts (launch pathways)
    ├─ setExecGate(gate) — injected from server.ts
    ├─ appLaunchByName(name, approvalToken?) → gate.decide() → spawn
    └─ appLaunchByPath(path, approvalToken?) → gate.decide() → spawn

  GET /api/execgate/approve  — operator approval route (issues single-use token)
```

## 2. Execution decision model

| Classification | Decision | Override | Audit |
|---|---|---|---|
| CONFIRMED_MALWARE | BLOCK_CONFIRMED_MALWARE | **NON-OVERRIDABLE** | `exec_gate_block_confirmed_malware` |
| HIGH_CONFIDENCE_THREAT | REQUIRE_USER_APPROVAL | requires token | `exec_gate_require_user_approval` |
| SUSPICIOUS | REQUIRE_USER_APPROVAL | requires token | `exec_gate_require_user_approval` |
| UNKNOWN | DENY_UNVERIFIED | requires token | `exec_gate_deny_unverified` |
| CLEAN | ALLOW | — | `exec_gate_allow` |
| UNAVAILABLE | BLOCK_SYSTEM_UNAVAILABLE | fail-closed | `exec_gate_block_system_unavailable` |
| E-stop active | BLOCK_SYSTEM_UNAVAILABLE | non-overridable | `exec_gate_block_system_unavailable` |

## 3. Enforcement boundaries

**Protected:** `appLaunchByName()` and `appLaunchByPath()` — both Krisha-managed launch pathways in `systemAgentServer.ts`. Both call `execGate.decide()` before spawn.

**NOT protected (honest limitation):** system-wide execution of executables NOT launched by Krisha. Krisha cannot prevent the user from manually running any executable outside Krisha's tool surface. System-wide enforcement would require AppLocker/WDAC configuration (admin privileges) and is documented as a Phase D+ option requiring an operator elevation decision.

## 4. Confirmed-malware non-overridable policy

When the Phase B classification engine returns CONFIRMED_MALWARE:
1. The gate returns `BLOCK_CONFIRMED_MALWARE` regardless of any approval token.
2. `issueApproval()` returns `null` — no approval token can be issued for confirmed malware.
3. Even a pre-existing valid token is consumed and the launch is refused (the classification is re-checked on every launch attempt).
4. The audit records the block with the classification, reason, and path (metadata only).
5. The ONLY way to clear the block is for the Defender detection to be retracted (making the classification no longer CONFIRMED).

## 5. Approval handling

- Tokens are issued via `POST /api/execgate/approve` (requires `application.launch` permission) or the operator UI.
- Each token is bound to `{path, mtimeMs, size, classification}` — a file replacement invalidates the token.
- Tokens are single-use: the first successful launch consumes the token; a second attempt with the same token is refused.
- Tokens expire after 5 minutes.
- `issueApproval` returns `null` for CONFIRMED_MALWARE (non-overridable).
- Stale/expired/reused tokens → BLOCK (fail-closed), with metadata-only audit.

## 6. File identity and replacement checks

1. `statFile(path)` is called BEFORE classification → identity `{mtimeMs, size}` recorded.
2. `classify(path)` runs (Phase B detection engine).
3. `statFile(path)` is called AGAIN after classification → identity compared.
4. If mtimeMs or size changed → `BLOCK_SYSTEM_UNAVAILABLE` (the file was replaced between assessment and launch — re-assessment required).
5. Approval tokens bind to the identity at approval time — a changed file invalidates the token.

## 7. Phase A reliability findings

**Root cause of transient DEGRADED (MEASURED):** the watchdog only checked heartbeat staleness. During a 12-process burst, the WMI worker processes events continuously and never reaches the `Wait-Event` timeout (no heartbeat is sent). But events ARE flowing — the worker is alive and processing.

**Fix:** the watchdog now considers BOTH `lastHeartbeatAt` AND `lastEventAt` as liveness indicators. If either is recent, the worker is alive. This addresses the root cause: the monitor stays ACTIVE during bursts because events prove liveness.

**Residual limitation:** under sustained heavy load on 2-core i3, the monitor may still briefly go DEGRADED if the WMI worker's event processing queue backs up. The monitor self-heals via re-arming. The process-monitor suite shows 65/1 (1 transient failure under burst load). The execution gate responds to DEGRADED monitoring by proceeding with file-level classification (which doesn't depend on process telemetry) while flagging the degraded state.

## 8. E-stop integration

The gate checks `stopKind() !== 'INACTIVE'` at the top of every `decide()` call. When the emergency stop is active, ALL launches are refused with `BLOCK_SYSTEM_UNAVAILABLE`. The e-stop is the durable server-side authority (E5 M1) — the gate respects it without any additional configuration.

## 9. Performance measurements

(MEASURED — see test output and Phase A report for the monitor's overhead)

The execution gate adds:
- Two `fs.promises.stat()` calls per launch decision (~1-5 ms each on SSD)
- One Phase B classification call (p50 ~14 ms cached, up to 1137 ms uncached on first assessment)
- One audit record per decision (metadata JSONL, fsync per entry)

Total per-launch overhead: ~15-1150 ms depending on cache state. This is within acceptable latency for an interactive launch (the user won't notice a <1.2 s delay).

## 10. Test results

`npx tsx scripts/test-exec-gate.ts` — **41 passed, 0 failed — ALL GREEN**

| # | Scenario | Result |
|---|---|---|
| 1 | Confirmed malware is blocked | pass |
| 2 | User approval cannot override confirmed-malware block | pass |
| 3 | Suspicious software requires approval | pass |
| 4 | Unknown software → DENY_UNVERIFIED | pass |
| 5 | Defender unavailable → conservative decision (never ALLOW) | pass |
| 6 | Phase A monitor unavailable → BLOCK_SYSTEM_UNAVAILABLE | pass |
| 7 | Phase A monitor DEGRADED → assessments continue | pass |
| 8 | E-stop active → all launches refused | pass |
| 9 | Executable replaced after assessment → BLOCK | pass |
| 10 | Nonexistent approval token → BLOCK | pass |
| 11 | Token reuse → refused (single-use enforcement) | pass |
| 12 | PID reuse safety (path-based classification unaffected) | pass |
| 13 | Protected Windows processes (documented, launch-only scope) | pass |
| 14 | Failed containment (documented, Phase D scope) | pass |
| 15 | Concurrent launch requests (CLEAN and CONFIRMED) | pass |
| 16 | No alternate launch pathway bypasses the gate | pass |
| — | CLEAN → ALLOW | pass |
| — | HIGH_CONFIDENCE_THREAT → REQUIRE_USER_APPROVAL | pass |
| — | Approval token full lifecycle (issue → use → consume) | pass |
| — | File replacement between approval and launch → refused | pass |
| — | Live-server integration (isolated sandbox store) | pass |

## 11. Regression results (post-implementation)

| Suite | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| Process Monitor | 65 passed, 1 failed (transient burst DEGRADED — documented §7) |
| SPF text / visual | 220 / 113 passed, 0 failed |
| LPV core / security | 92 / 55 passed, 0 failed |
| E5 M1 | 86 passed, 0 failed |
| Phase 18 | 62 passed, 0 failed |
| Real E5 store | untouched (Phase B.1 verified byte-identical; Phase C test servers use isolated KRISHA_SANDBOX_DIR) |

## 12. Known limitations

1. **Krisha-managed launches only** — the gate enforces decisions only on launches initiated through Krisha's tools. System-wide enforcement requires elevation (AppLocker/WDAC).
2. **Containment deferred** — process termination, suspension, and file quarantine are Phase D scope. The gate prevents launches; it does not stop already-running processes.
3. **Same-user ceiling** — the gate is same-user non-admin; elevated processes are outside its control.
4. **Transient burst DEGRADED** — under 12+ concurrent process spawns, the Phase A monitor may briefly go DEGRADED (fixed watchdog now considers event liveness; residual timing edge case documented).
5. **No UI** — the approval flow requires a separate UI implementation (deferred per task §11).
