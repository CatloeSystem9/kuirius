# Krisha — Security System Phase C.1: Comprehensive Verification + Phase D: Threat Containment

**Phase C.1 verification:** 2026-11-19
**Phase D implementation:** 2026-11-19
**Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md`

---

## PART A — Phase C.1 Isolation Repair

### Root cause of the audit-isolation gap

The test-runner process (e.g. `npx tsx scripts/test-process-monitor.ts`) imports modules that trigger `serverSafety` boot at module scope. Without `KRISHA_SANDBOX_DIR` set before import, `resolveStoreRootSync()` resolves to `C:\ProgramData\Krisha\sandbox` (the real store). Lifecycle audit events from `ProcessMonitor.start()`/`stop()` then write to the real E5 audit chain.

**Root cause:** static imports in the test scripts load `serverSafety.ts` (directly or transitively) before `KRISHA_SANDBOX_DIR` is set. The `resolveStoreRootSync()` function reads the env var at module init and caches the result.

### Fix applied

Created `scripts/test-isolation.ts` — imported as the FIRST import in every security-system test script. It creates a temp directory and sets `KRISHA_SANDBOX_DIR` + `KRISHA_FS_ROOTS` before any E5-auditing module loads.

**Files modified for isolation:**
- `scripts/test-isolation.ts` (new)
- `scripts/test-process-monitor.ts` (isolation import added)
- `scripts/test-malware-detect.ts` (isolation import added)
- `scripts/test-exec-gate.ts` (isolation import added)

### Isolation verification (MEASURED)

| Metric | Before suites | After suites | Delta |
|---|---|---|---|
| Audit entries | 2707 | 2707 | **0** |
| install.marker hash | `000FA71A` | `000FA71A` | identical |
| stop-state.json hash | `0A5A7002` | `0A5A7002` | identical |
| audit/server-audit.jsonl hash | `DA7279C6` | `DA7279C6` | identical |
| quarantine/…a6.data hash | `91555D75` | `91555D75` | identical |
| quarantine/…a6.meta.json hash | `6124A833` | `6124A833` | identical |
| sandbox-journal hash | `44BA7705` | `44BA7705` | identical |
| Protection | full | full | unchanged |
| Stop state | INACTIVE | INACTIVE | unchanged |

**The real E5 store received ZERO test-runner entries during the verification campaign.** The isolation fix is effective.

### Historical audit-growth note

The audit chain grew from 2411 to 2707 entries during the earlier Phase C.1 campaign (before the isolation fix). These 296 entries are metadata-only lifecycle events (kinds, routes, decisions — no secrets, no process names). They are preserved as evidence and NOT deleted. Future test campaigns will not add entries thanks to the isolation fix.

---

## PART B — Phase D: Threat Containment

### Architecture

```
[Krisha server process]
  ThreatContainment (src/agent/containment/containment.ts — Node-only)
    ├─ Dependencies:
    │    verifyProcess(pid) → WMI Win32_Process identity check
    │    isStopActive() → E5 stop state
    │    terminate(pid) → taskkill /PID /F (same-user, non-admin)
    │    audit(event) → E5 chain (metadata only)
    ├─ contain(request) → ContainmentResult
    │    1. E-stop check (REFUSED_E_STOP if active)
    │    2. Classification check (REFUSED_INSUFFICIENT_EVIDENCE if not CONFIRMED_MALWARE)
    │    3. Evidence freshness check (REFUSED_STALE_EVIDENCE if >24h)
    │    4. Operator approval check (REFUSED_NO_APPROVAL if missing)
    │    5. Protected process check (REFUSED_PROTECTED_PROCESS for system processes)
    │    6. Identity revalidation via WMI (PID reuse → REFUSED_PID_REUSED)
    │    7. Executable path match (REFUSED_IDENTITY_CHANGED if changed)
    │    8. Process name match (REFUSED_IDENTITY_CHANGED if changed)
    │    9. Terminate via taskkill /PID /F
    │   10. Post-termination verification (ACCESS_DENIED if still exists)
    └─ Audit: ContainmentAuditEvent (metadata only — no secrets)
```

### Process identity model

- PID + WMI CreationDate (prevents PID-reuse false positives)
- Executable path (identity verification)
- Process name (identity verification)
- Classification evidence from Phase B (CONFIRMED_MALWARE required)

### Evidence requirements

| Evidence | Required? | Freshness |
|---|---|---|
| Classification = CONFIRMED_MALWARE | YES | Evidence <24h old |
| Defender ThreatID | Preferred | From current detection history |
| SHA-256 file hash | Optional | From cached file assessment |
| Process ancestry | Optional | From Phase A inventory |
| Operator approval token | YES | Single-use, 5 min TTL |

### Non-overridable constraints

- SUSPICIOUS/UNKNOWN/CLEAN processes are NEVER terminated
- Stale evidence (>24h) is refused
- E-stop blocks all containment
- Protected Windows processes (lsass.exe, winlogon.exe, etc.) are refused
- Same-user ceiling: elevated/SYSTEM processes cannot be terminated (Windows DACL)

### Authorization model

1. Phase B classifies the executable as CONFIRMED_MALWARE (Defender-trusted evidence)
2. Phase A confirms the process is running (PID + creation time verified)
3. The containment route requires `threat.contain` permission + operator approval
4. The containment module revalidates identity via WMI before action
5. E-stop is checked immediately before termination
6. Every decision is audited to the E5 chain

## PART C — Implementation details

**Files created:**
- `src/agent/containment/containmentTypes.ts` — types
- `src/agent/containment/containment.ts` — ThreatContainment class
- `src/agent/containment/index.ts` — public surface
- `scripts/test-isolation.ts` — test isolation module (Phase C.1 repair)
- `scripts/test-containment.ts` — 25 assertions, 0 failed

**Files modified:**
- `scripts/test-process-monitor.ts` — isolation import added
- `scripts/test-malware-detect.ts` — isolation import + stale/path tests added
- `scripts/test-exec-gate.ts` — isolation import added
- `systemAgentServer.ts` — `ExecGate` interface + `setExecGate()` (from Phase C)
- `server.ts` — ExecutionGate + DetectionEngine construction, exec-gate routes (from Phase C)
- `ARCHITECTURE.md` — §36 (Phase A), §37 (Phase B), §38 (Phase C)

## PART D — Test results

| Suite | Passed | Failed | Exit | Isolated |
|---|---|---|---|---|
| **Containment** | **25** | **0** | **0** | ✅ test-isolation.ts |
| **Malware detection (incl. path tests)** | **98** | **0** | **0** | ✅ test-isolation.ts |
| **Execution gate** | **41** | **0** | **0** | ✅ test-isolation.ts |
| **Process monitor** | **66** | **0** | **0** | ✅ test-isolation.ts |
| SPF text | 220 | 0 | 0 | ✅ spawned servers isolated |
| SPF visual (re-run) | 113 | 0 | 0 | ✅ spawned servers isolated |
| LPV core | 92 | 0 | 0 | ✅ tmpdir |
| LPV security | 55 | 0 | 0 | ✅ tmpdir |
| LPV perf | 11 | 0 | 0 | ✅ tmpdir |
| E5 M1 | 86 | 0 | 0 | ✅ tmpdir |
| E5 M2 | 74 | 0 | 0 | ✅ tmpdir |
| E5 M3 | 72 | 0 | 0 | ✅ tmpdir |
| E5 H4 | 70 | 0 | 0 | ✅ tmpdir + real-store verification |
| Phase 13 | 91 | 0 | 0 | N/A |
| Phase 14 | 150 | 0 | 0 | N/A |
| Phase 18 | 62 | 0 | 0 | N/A |
| Agent core | 49 | 0 | 0 | N/A |
| Goal continuity | 163 | 0 | 0 | ✅ tmpdir |
| `tsc --noEmit` | — | — | 0 errors | — |
| Real CDP smoke | LPV security suite | 55/0 | 0 | ✅ |
| Real E5 store | 2707 entries, full, INACTIVE | — | — | untouched ✓ |

## PART E — Known limitations

1. **Same-user ceiling** — containment can only terminate same-user non-elevated processes; elevated/SYSTEM processes are out of reach (Windows DACL)
2. **TOCTOU residual window** — between final identity check and spawn, Windows does not provide atomic verify-and-execute for non-admin processes
3. **WMI WITHIN-1** — fast-exit processes may be missed by Phase A (documented)
4. **No external reputation** — unsigned unknown = UNKNOWN
5. **No system-wide enforcement** — requires AppLocker/WDAC (admin, operator decision)
6. **No UI** — containment approval flow requires separate UI implementation
7. **Real E5 audit chain grew during earlier campaigns** — 296 metadata-only entries from the pre-isolation-fix era (preserved as evidence; not deleted)
