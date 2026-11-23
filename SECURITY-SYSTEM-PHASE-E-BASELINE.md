# Krisha — Phase E Baseline Report (produced before any Phase E changes)

**Date:** 2026-11-22. Source-verified against the current implementation (not historical reports).

## Existing capabilities verified for reuse (no duplication)

| Capability | Source of truth (verified) | Phase E reuse |
|---|---|---|
| Process lifecycle events | `ProcessMonitor` (Phase A): `onEvent(cb): () => void` subscription; `ProcessCreateEvent {kind:'create', pid, name?, ppid?, sessionId?, path?, at, source:'wmi-worker', enriched}` / `ProcessDeleteEvent {kind:'delete', pid, name?, at, previouslyObserved}`; `status()` health telemetry (STARTING/ACTIVE/DEGRADED/STOPPED/FAILED) | **Direct subscription** — E.1 ingests raw events; E.4 reads health. No new monitor |
| Malware classification | `DetectionEngine` (Phase B): audits `malware_classification` (SUSPICIOUS and above only; metadata: classification, confidence, pid, path, processName, evidence, explanation, missingEvidence, engineVersion); `health()` engine health; `assessFile()` on-demand; Defender data via cached `defenderSource` | **Audit-funnel ingestion** — E.1 consumes its audit records; E.4 reads cached health/defender availability. No re-classification anywhere in Phase E |
| Execution gate decisions | `ExecutionGate` (Phase C): audits `exec_gate_allow/block/...` (decision, reason, path, name, classification, confidence, hasApprovalToken); `health()` | **Audit-funnel ingestion** |
| Containment decisions | `ThreatContainment` (Phase D.3/D.4): audits `threat_containment` (requestId, outcome, reason, pid/name/creationTime, classification, evidence age, E-stop state, authorization, termination fields, `approvalAuthority`); production approval authority = `authorized:false, unavailable:true` (D.4) | **Audit-funnel ingestion**; E.5 marks any authority-requiring action `unavailable`. Termination stays disabled — Phase E adds no control surface |
| SPF decisions | `spfAuditDurable()` in `server.ts` writes `spf_decision` records to the E5 chain | **Wrapped at the same call site** for ingestion |
| LPV security decisions | `lpvCore.appendLpvAudit` writes to LPV's OWN hash-chained audit file — **not** the E5 funnel | Minimal additive observer hook (`setLpvSecurityEventSink`) so E.1 can consume LPV decision metadata; LPV security behavior untouched (verified by full LPV suites) |
| E-stop state / transitions | `stopKind()` / `stopSnapshot()` (in-memory, authoritative); transitions audited through the E5 funnel (`e5_stop_armed`, `emergency_resume`, `e5_stop_blocked`) — including pipe-driven ones | E.4 reads `stopSnapshot()` directly (authoritative, UNKNOWN on uncertainty); E.1 observes transitions via a ≤5 s change sampler as a completeness backstop (pipe-driven transitions already appear in the funnel) |
| E5 protection / audit health | `getStorageInfo()` (protection: full/degraded/unavailable), `auditDegraded` flag | E.4 read-only |
| Agent tool contract | `AgentTool` (browser-side `fetch` wrappers over read-only server routes); registration in `bridge.ts` (`registry.registerAll(createProcessMonitorTools())` pattern) | New read-only `securityIntel.status` / `securityIntel.assessments` tools + `GET /api/security/situation`, `GET /api/security/assessments` routes (no control surface) |
| Agent/memory/event systems | ToolRegistry (`registerAll`), Phase 2 memory, context engine — none duplicated; Phase E is a separate additive subsystem | Out of scope for ingestion |

## Facts and constraints carried into the design

1. The E5 audit funnel (`appendAuditSyncSafe`) is the single chokepoint for monitor metadata, malware classifications, exec-gate decisions, containment attempts, SPF decisions, enforcement blocks, and E-stop transitions — all ingestible **without touching E5 internals** by wrapping the subsystem audit callbacks in `server.ts`.
2. LPV is the one exception (own audit file) → minimal additive sink hook.
3. Defender telemetry must NOT be polled (PowerShell/WMI cost). E.4 uses the engine's cached availability; explicit `UNKNOWN` when never assessed. `RECHECK_DEFENDER` exists only as a recommendation.
4. Production termination is disabled by the D.4 authority gate; Phase E must not add any control surface.
5. The classification precedence (Phase B) is inviolable: correlation may corroborate but never promote UNKNOWN→CONFIRMED_MALWARE, and never re-classifies.
6. Bounded resources on target hardware (i3/8GB): event-driven ingestion only, ring buffer (≤2000 events), dedup window, on-demand correlation/assessment with a short memo cache, no continuous loops beyond a 5 s unref'd state sampler.

## Gaps Phase E fills (and explicit non-goals)

- No unified schema across A–D security metadata today (each subsystem audits its own shape).
- No correlation across subsystem events.
- No severity/confidence-separated assessment view.
- No aggregated situation view (each subsystem exposes only its own status).
- No safe-response recommendation layer (D.4 made termination unreachable; operators have no machine-generated "what next" signal).
- Non-goals: no new monitor/classifier, no UI, no termination pathway, no new authentication, no external transmission.
