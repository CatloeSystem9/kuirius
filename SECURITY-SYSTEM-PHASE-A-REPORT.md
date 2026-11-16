# Krisha — Security System Phase A: Independent Process Monitoring — Implementation Report

**Completion date:** 2026-11-15
**Scope:** event-driven host process visibility (Phase A of the Security System plan in `SECURITY-SYSTEM-PHASE-1-AUDIT.md`). Monitoring ONLY — no process control, no malware classification, no execution blocking.
**Task:** A1. Baseline authority: `SECURITY-INTEGRATION-BASELINE.md`.

---

## 1. Architecture

```
[Krisha server process]
  ProcessMonitor (src/agent/processmonitor/processMonitor.ts — Node-only)
    ├─ PowerShellTransport ── persistent PowerShell worker (PowerShellWorker
    │    pattern, like the Phase 5/6 mouse/keyboard and SPF OCR workers)
    │      ├─ Register-CimIndicationEvent  __InstanceCreationEvent  WITHIN 1
    │      │         WHERE TargetInstance ISA 'Win32_Process'   (temporary,
    │      │         session-owned — dies with the worker)
    │      ├─ Register-CimIndicationEvent  __InstanceDeletionEvent WITHIN 1 ...
    │      ├─ KPM_READY create=N delete=N   (subscription confirmation)
    │      ├─ KPM {json event} per process creation/termination
    │      ├─ KPM_HEARTBEAT every 15 s idle (liveness)
    │      └─ self-exit when parent PID disappears (orphan prevention)
    ├─ watchdog: heartbeat-staleness detection → re-arm (bounded backoff)
    ├─ bounded inventory (PID-keyed Map, ≤2000 entries): creation/termination
    │    tracking, parent-child links, PID-reuse handling, out-of-order
    │    (delete-before-create) handling, startup snapshot for pre-existing
    │    processes, oldest-eviction
    ├─ bounded event ring (≤500 events, drop-oldest + overflow counter)
    └─ lifecycle/health audit → E5 chain (metadata only)

  GET /api/processmonitor/status  — read-only health/counters/recent events
                                    (optional reconcile=1 drift correction)
  processMonitor.status tool      — ONE read-only visibility tool in the
                                    agent registry (fetch-backed; SAFE class)
```

## 2. Windows APIs and mechanisms used

| Mechanism | Use | Privilege | Evidence |
|---|---|---|---|
| `Register-CimIndicationEvent` `__InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'` | process creation events | none (non-admin verified) | Phase 1 probe + Phase A live tests |
| `Register-CimIndicationEvent` `__InstanceDeletionEvent WITHIN 1 ...` | process termination events | none | live test |
| `Win32_Process` snapshot (`Get-CimInstance ... | ConvertTo-Json`) | startup inventory + reconcile | none | startup snapshot populated (test-verified) |
| `Get-AuthenticodeSignature` | (Phase B enrichment — not in Phase A) | none | Phase 1 MEASURED |
| Explicit `kill()` on shutdown + worker parent-PID self-probe | orphan prevention | none | worker exits when parent dies (implemented; worker script probe each idle cycle) |

**Not used (and required not to be):** permanent WMI consumers, persistent machine-wide subscriptions, Security-log 4688, kernel drivers, Defender configuration changes, admin elevation. The Phase-1-identified unexplained WMI consumer (`SCM Event Log Consumer`) was left untouched.

## 3. Subscription lifecycle

1. `start()` → worker spawned (`powershell.exe -NoProfile -NonInteractive -Command -`), script written to stdin (stdin stays open — ending it would EOF-exit the host after bootstrap; lesson recorded in code).
2. Worker registers both subscriptions; emits `KPM_READY create=N delete=N` within the boot budget (15 s). Partial success → DEGRADED (honest).
3. Health ACTIVE only when both subscriptions confirmed. Events stream as `KPM {json}` lines; `KPM_HEARTBEAT` every 15 s idle proves liveness.
4. Failure paths: boot timeout/failure, worker exit, stale heartbeat (watchdog every ≤20 s vs 50 s threshold) → kill + re-arm with backoff (1/2/4/8/16 s, 5 attempts) → FAILED when exhausted (never silently unmonitored).
5. Disposal: `stop()` kills the worker and clears timers; `process.on('exit')` hook in server.ts; worker self-exits on parent death. Temporary subscriptions die with the worker — verified conceptually by mechanism (in-session registration) and by clean-shutdown tests.

## 4. Event schema

- Create: `{kind:'create', pid, name?, ppid?, sessionId?, path?, at, source:'wmi-worker', enriched}` — `path` absent ⇒ `enrichment:'unavailable'` in inventory (honest: WMI may snapshot a fast-exiting process without a path; MEASURED in Phase 1 and Phase A).
- Delete: `{kind:'delete', pid, name?, at, source:'wmi-worker', previouslyObserved}`.
- **No command-line arguments are collected** (password/token risk, task §4) — enforced by schema (the field is never requested from WMI).

## 5. Inventory design

- PID-keyed bounded Map (≤2000, oldest-evicted, terminated-first).
- Origins: `startup` (boot snapshot), `observed` (creation event), `unobserved` (deletion seen for an unknown PID — recorded honestly with `unobservedTerminations` counter).
- States: `running` / `terminated-unconfirmed` (telemetry cannot absolutely confirm exit — naming is honest).
- PID reuse: a later creation for a live-known PID with a different image replaces the entry and increments `pidReuses`.
- Out-of-order: delete-before-create recorded, then attached when the late creation arrives.
- Reconciliation: on-demand (`?reconcile=1`) bounded snapshot diff — corrects drift (missed terminations, missed creations) only when someone asks; no periodic disk/CPU churn.
- The monitor NEVER claims a complete inventory: `preexistingCount`, `unobservedTerminations`, and health are all reported so gaps are visible.

## 6. Permission boundaries

- Phase 18 convention: one read-only tool (`processMonitor.status`, SAFE class, no permission requirement — matching the diagnostics-tool convention), registered at the ToolRegistry chokepoint. **No control tool exists** (asserted: no terminate/suspend/quarantine tool or capability in the registry).
- HTTP surface: one read-only GET route (`/api/processmonitor/status`, ungated read-only per the `/api/integrity/status` convention, reconcile parameter included) — **no control routes** (asserted: POST `/api/processmonitor/kill` → 404).
- Emergency stop: the monitor is read-only visibility and remains ACTIVE under a stop (visibility is safety-positive); the status tool remains callable while stopped (gate classifies it allow — tested).

## 7. Failure handling

- Boot failure / worker exit / stale heartbeat → bounded re-arm (backoff 1→16 s, 5 attempts) → FAILED with reason; monitoring state never silently degrades to "fully monitored".
- Queue overflow → drop-oldest with counter + audited overflow event.
- Malformed worker lines → ignored (never invented into events).
- Audit-sink failures cannot break monitoring (swallowed at the boundary).
- Worker death → automatic re-arm (MEASURED 61-64 ms mechanism-level with 30 ms backoff).

## 8. Test results (exact)

`npx tsx scripts/test-process-monitor.ts` — **66 passed, 0 failed — ALL GREEN** (final run):

| # | Scenario | Result |
|---|---|---|
| 1 | Creation detection | pass |
| 2 | Termination detection (previouslyObserved) | pass |
| 3 | PID/PPID lineage tracking | pass |
| 4 | Executable path enrichment | pass |
| 5 | Missing path → honest 'unavailable' | pass |
| 6 | PID reuse (replace + counter) | pass |
| 7 | Out-of-order delete-before-create + late attach | pass |
| 8 | Queue overflow (bounded buffer, drop-oldest, audited) | pass |
| 9 | Subscription/boot failure → bounded retries → FAILED | pass |
| 10 | Worker crash → automatic re-arm → events resume | pass |
| 11 | Server restart → subscriptions re-initialized (real servers, isolated stores) + real creation detection + control-route absence (404) + startup snapshot | pass |
| 11a | Heartbeat staleness → re-arm | pass |
| 12 | Graceful shutdown (STOPPED, no processing after stop, double-stop safe) | pass |
| 13 | No process-control tool/capability in the agent surface | pass |
| 14 | Emergency-stop compatibility (status tool allowed, stop state untouched) | pass |
| 15 | Metadata-only audit (no process names/paths in any lifecycle record; fake + real worker) | pass |
| 16 | Performance (measured, §9) | pass |

## 9. Performance measurements (MEASURED, real worker, live WMI)

| Metric | Measured value | Target | Verdict |
|---|---|---|---|
| Idle CPU (8 s window, whole test process incl. harness) | **63 ms** (≈0.8 % of one thread) | negligible | met |
| Total CPU across boot + idle + 12-process burst | **547 ms** | bounded | met |
| RSS delta (boot → post-burst, whole test process incl. harness) | **−6.3 MB** (GC-dominated; monitor adds negligible resident) | <50 MB | met (monitor-increment not separately measurable in-process; the monitor's own state is a ≤2000-entry Map + ≤500-event ring, low single-digit MB by construction) |
| Detection latency, long-lived children (n=11/12) | **561–1466 ms** | event-driven, ~1 s WMI window | met (bounded by the WITHIN-1 window) |
| Burst robustness | 12 spawns, monitor stayed ACTIVE, queue bounded | — | met |
| Short-lived (fast-exit) children | **2/12 observed** in the first measurement design; host-wide churn (incl. short-lived system processes such as conhost) IS observed | honest limitation | documented (§11) |
| Recovery after worker failure (mechanism-level, 30 ms backoff) | **61–64 ms** | bounded | met |
| Disk writes | lifecycle audit events only (metadata, fsync-per-entry, tiny JSONL lines; counts asserted, contents asserted name/path-free) | minimal HDD writes | met |
| Server boot → monitor ACTIVE | within the healthy-boot window (1–3 s measured for the server; monitor ACTIVE within ~1.5 s of boot) | — | met |

## 10. Files created and modified

**Created:** `src/agent/processmonitor/monitorTypes.ts`, `src/agent/processmonitor/processMonitor.ts`, `src/agent/processmonitor/tools.ts`, `src/agent/processmonitor/index.ts`, `scripts/test-process-monitor.ts`, this report.
**Modified:** `server.ts` (import, monitor singleton with E5 audit sink, `exit` disposal hook, `GET /api/processmonitor/status`), `src/agent/bridge.ts` (one additive registration: `createProcessMonitorTools()`), `ARCHITECTURE.md` (§36 below).
**Baseline preservation:** SPF/LPV subsystem files untouched; integration baseline not rewritten.

## 11. Known limitations

1. **Fast-exit processes:** WMI `WITHIN 1` polling cannot observe a process born and dead between polls (MEASURED: 2/12 fast-exit children in the first design; host churn including short-lived system helpers like conhost IS observed — 25 events in a 3.5 s window). Full short-lived coverage requires elevated ETW (`Win32_ProcessStartTrace`) — an operator-elevation decision deferred per Phase 1 §20.
2. **~1 s event granularity** (the WITHIN window) — fine for visibility, insufficient for microsecond forensics.
3. **Inventory is honest, not complete**: unobserved terminations and pre-existing processes are counted and labeled; the monitor never claims a complete inventory.
4. **Same-user ceiling** (Phase 1 §12): the monitor is same-user non-admin; nothing here defends against same-user malware.
5. **Windows-only** — the mechanism is WMI; non-Windows hosts have no monitor (no stub pretending otherwise).
6. The unexplained `SCM Event Log Consumer` WMI consumer from Phase 1 remains untouched/unclassified (task §8).

## 12. Remaining security risks

1. Same-user malware can still kill the monitor (visibility gap is then detectable: FAILED/DEGRADED state + audit gap, but not preventable non-admin).
2. WMI itself can be attacked (consumer/subscriber tampering) — mitigated only by the session-scoped design (no persistent consumers to tamper with) + restart re-arming.
3. Short-lived malware execution can evade this monitor (Phase 1 limitation; needs the elevation decision).
4. The monitor adds no defense against kernel-level threats (out of scope by task §8).

## 13. Definition-of-done verification

Independent monitoring works (live WMI, both directions) ✓; creation/termination tracked ✓; no Task Manager dependency ✓; temporary subscriptions, cleaned up ✓; restart/failure recovery ✓ (tested); permission enforcement tested (no control surface; e-stop compatibility) ✓; E5 audit integration metadata-only ✓; performance measured ✓ (all Phase A targets met); SPF/LPV/E5/agent regressions pass (re-run after implementation — §13 below) ✓; TypeScript clean ✓; real E5 store integrity preserved ✓; documentation complete ✓.

---

## 13b. Post-implementation regression (run on the integrated tree after Phase A)

| Suite | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| Process Monitor suite | **66 passed, 0 failed** (two consecutive green runs; exit code 0) |
| SPF text security | **220 passed, 0 failed** |
| SPF visual security | **113 passed, 0 failed** |
| LPV core | **92 passed, 0 failed** |
| LPV security | **55 passed, 0 failed** |
| LPV performance | **11 passed, 0 failed** |
| E5 M1 / M2 / M3 / H4 | **86 / 74 / 72 / 70 passed, 0 failed** |
| Phase 13 / 14 / 18 | **91 / 150 / 62 passed, 0 failed** |
| Agent core | **49 passed, 0 failed** |
| Goal continuity | **163 passed, 0 failed** |
| Real E5 store | status + all six file SHA-256 hashes **identical before and after** the full campaign (732 entries, `full`, `INACTIVE`) |
