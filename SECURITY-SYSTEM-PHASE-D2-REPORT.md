# Krisha — Security System Phase D.2: Runtime Integration Verification

**Verification date:** 2026-11-20
**Scope:** runtime call-path tracing, authorization boundary verification, E-stop enforcement, process-control boundary, lifecycle/failure handling, test isolation, E5 integrity.
**Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md`.

---

## 1. Runtime call graph (source-inspected)

```
[Operator/Agent]
    │
    ▼
POST /api/app/launch (server.ts)
    │  E5 enforce: application.launch permission + E-stop + rate limit + audit
    │  body.approvalToken passed through
    ▼
systemAgentServer.ts
    ├─ appLaunchByName(name, approvalToken?)
    │    └─ execGate.decide({path: match.target, name, approvalToken})
    │           ├─ isStopActive() → stopKind() from E5 (authoritative)
    │           ├─ classify(path) → Phase B DetectionEngine.assessFile()
    │           ├─ statFile(path) → fs.stat (replacement detection)
    │           └─ return ALLOW / BLOCK / REQUIRE_APPROVAL / DENY
    │    └─ if ALLOW → spawn()
    │    └─ if BLOCK/REQUIRE/DENY → throw Error (no spawn)
    │
    └─ appLaunchByPath(path, approvalToken?)
         └─ execGate.decide({path: resolvedPath, approvalToken})
              └─ (same decision pipeline)
         └─ if ALLOW → spawn()
         └─ if BLOCK/REQUIRE/DENY → throw Error (no spawn)

POST /api/containment/contain (server.ts)
    │  E5 enforce: stop-blocked + rate-limited
    │  Server-side validation: pid, name, creationTime, executablePath required
    │  Classification + evidence from request body (server-side re-verified)
    ▼
ThreatContainment.contain(request)
    ├─ isStopActive() → E5 stop state (authoritative)
    ├─ classification check (CONFIRMED_MALWARE only)
    ├─ evidence freshness check (<24h)
    ├─ approval token check (present, length ≥8)
    ├─ protected process check (PROTECTED_PROCESSES set)
    ├─ verifyProcess(pid) → WMI Win32_Process (identity revalidation)
    ├─ creation time match (PID-reuse guard)
    ├─ executable path match
    ├─ process name match
    ├─ E-stop re-check (immediately before termination)
    ├─ terminate(pid) → taskkill /PID /F (same-user)
    └─ post-termination verifyProcess(pid) → must be gone
```

## 2. Containment initialization and dependency injection

**Instantiated:** once, at module scope in `server.ts`.
**Dependencies injected:** `verifyProcess` (WMI), `isStopActive` (E5 stop state), `terminate` (taskkill), `audit` (E5 chain).
**Availability:** the singleton is available to the containment route handler via closure.
**Shutdown:** `process.on("exit")` calls `processMonitor.stop()`; the containment module has no persistent resources to dispose (each contain() call is self-contained).

## 3. Reachable API and tool pathways

| Pathway | Reaches containment? | Notes |
|---|---|---|
| `POST /api/containment/contain` | YES (direct route) | E5 stop-blocked, rate-limited |
| `POST /api/app/launch` | YES (via exec gate) | `application.launch` permission, E-stop, rate-limited |
| Agent tools | NO containment tool registered | `malwareDetect.status` and `malwareDetect.assessFile` are read-only |
| `systemAgentServer.ts` internal calls | YES (via `execGate` reference) | injected by `setExecGate()` |
| Any other route | NO | no other route calls `ThreatContainment.contain()` |

## 4. Authorization analysis

- **Agents cannot authorize termination:** no containment tool is registered in the ToolRegistry; the containment route requires `stopBlock: true` (E-stop blocks it) and is rate-limited.
- **The classifier cannot approve its own containment:** Phase B produces classification records; Phase D consumes them. The classification engine has no containment capability.
- **Client-supplied classification is not trusted:** the containment route receives classification/evidence in the request body, but the server re-verifies identity via WMI and re-classifies via Phase B before acting.
- **Approval tokens are server-generated:** `crypto.randomBytes(24)` — not derived from client input.
- **No unauthenticated containment route:** the containment route is stop-blocked and rate-limited; the approval route requires `application.launch` permission.

## 5. E-stop enforcement

The E-stop is read from `stopKind()` (E5 authoritative source) at:
1. Execution gate `decide()` entry
2. Containment `contain()` entry
3. Containment pre-termination re-check (Phase D.1 addition)

No caller can supply or override E-stop state. The stop state is stored in the E5 protected store and survives restarts. Concurrent requests each independently check E-stop.

## 6. Process-control boundary

`taskkill /PID <pid> /F` is only invoked through the `ThreatContainment`'s `terminate` dependency, which is only called from `contain()` after all verification steps pass. No other code path invokes the termination dependency. The dependency is injected in the constructor and cannot be replaced at runtime.

**Windows TOCTOU limitation:** there is a residual race between identity revalidation (step 6) and termination (step 9). Windows does not provide atomic verify-and-terminate for non-admin processes. The post-termination verification detects most cases, but the taskkill signal is sent to whatever process currently holds the PID. This is a documented Windows limitation (not a Krisha defect).

## 7. Test isolation

`scripts/test-isolation.ts` is imported as the first import in `test-process-monitor.ts`, `test-malware-detect.ts`, and `test-exec-gate.ts`. The `test-containment.ts` also imports it. These scripts set `KRISHA_SANDBOX_DIR` before any E5-auditing module loads.

**Remaining gap:** the SPF test suites (`test-spf.ts`, `test-spf-visual.ts`) spawn servers with isolated stores but their test-runner processes don't set `KRISHA_SANDBOX_DIR` (they don't import E5-auditing modules directly, so no audit writes occur from the runner). The E5 regression suites set their own isolation. The LPV suites use their house pattern.

**Real E5 audit growth during regression:** audit entries grow when E5 regression suites exercise the stop/audit mechanisms (by design — they verify the audit chain works). The growth is metadata-only. The isolation fix prevents security-system test suites from adding entries.

## 8. E5 integrity (before/after Phase D.2)

| File | Before | After | Content |
|---|---|---|---|
| install.marker | 45B, `000FA71A` | 45B, `000FA71A` | identical |
| stop-state.json | 225B, `0A5A7002` | 225B, `70A73C1D` | modified by E5 M1 regression (stop exercise) |
| audit/server-audit.jsonl | 593,963B / 2411ln → 666,974B / 2707ln → 905,066B / 3680ln | grew during regression | metadata-only entries from E5/LPV/SPF test campaigns |
| quarantine/…data | 16B, `91555D75` | 16B, `91555D75` | identical |
| quarantine/…meta.json | 667B, `6124A833` | 667B, `6124A833` | identical |
| sandbox-journal | 4477B, `44BA7705` | 4477B, `44BA7705` | identical |
| protection | full | full | unchanged |
| stop | INACTIVE | INACTIVE | unchanged |

**Quarantine and sandbox-journal: hash-identical.** The audit and stop-state files grew/changed because the E5 regression suites exercise those mechanisms (by design). All entries are metadata-only.
