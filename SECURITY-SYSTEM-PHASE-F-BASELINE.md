# Krisha — Phase F Baseline Report (produced before any Phase F changes)

**Date:** 2026-11-22. Source-verified against the current implementation (first-hand knowledge: Phases D.3/D.4/E were built in this session chain; every surface below was re-inspected today).

## Existing capabilities Phase F will REUSE (no duplication)

| Capability | Source (verified today) | Phase F use |
|---|---|---|
| Normalized security events | `SecurityEventIntel` (`intel.ts`): `events()`, `recent(n)`, `stats()`; ring bounded 2000; dedup + provenance | E.1 evidence source for incident evidence attachment |
| Correlation | `CorrelationEngine.correlate(intel)` — 7 evidence-linked rules, `directEvidence`/`statisticalOnly` | incident correlation references |
| Assessments | `AssessmentEngine.assess(intel)` — severity/confidence separated, `kind: 'inferred' | 'confirmed-by-source'`, `evidenceRefs`, `contradictingRefs`, `missingInfo` | incident assessment tracking |
| Response recommendations | `ResponseRecommender.recommendFor(assessment)` — closed action enum, forbidden-action rejection, authority-unavailable marking | response eligibility inputs |
| Containment | `ThreatContainment.issueApproval(pid, operatorCredential)` + `contain({pid, approvalToken})`; credential-backed authority (`createCredentialApprovalAuthority` over E5 enrollment); epoch staleness; pinning | containment execution via Phase D as-is (no bypass) |
| E-stop | `stopKind()`/`stopSnapshot()` authoritative; stop transitions visible in the audit funnel + intel stream | response gating at evaluation AND execution |
| Approval credential state | `containmentApprovalCredentialSet()` / `containmentApprovalEpoch()` (E5 protected file) | containment eligibility + revocation invalidation |
| E5 audit | `appendAuditSyncSafe` funnel; subsystem taps via `auditAndIngest` in server.ts | incident audit records (metadata-only) |
| Protected-store persistence | `durableWrite` + integrity self-hash pattern (`containment-approval.json`, stop-state) | incident state persistence across restart |
| Read-only reporting | `GET /api/security/situation`, `/assessments`; `securityIntel.*` tools | incident status route + tool (same pattern) |

## Gaps Phase F fills

1. **No incident entity exists anywhere** — Phase E assessments are moment-in-time; nothing tracks an evolving subject across events, assessments and responses.
2. **No restart-persistent security state** — the intel ring and assessments are in-memory; after restart the correlation context is gone (E5 audit remains the durable record but is not replayed).
3. **No coordinated response tracking** — E.5 recommendations are computed per read; nothing prevents duplicate/contradictory responses for the same subject or records which response was taken.
4. **No subject-level containment coordination** — containment attempts are tracked in Phase D's token registry (single-use) but nothing ties them to an evolving incident or prevents a new incident from re-requesting containment for an already-contained subject.
5. **No stop-transition sweep** — E-stop activation blocks per-request, but nothing marks ACTIVE incidents' prohibited responses at the moment of activation.

## Constraints carried into the design

- Phase E stays the sole intelligence/classification source; Phase F never re-classifies and never promotes UNKNOWN/SUSPICIOUS (CRITICAL continues to require a source CONFIRMED_MALWARE fact).
- Containment executes ONLY through Phase D (credential verification, epoch, pinning untouched).
- The disclosed same-user OS boundary and the operator-enrollment prerequisite carry over unchanged.
- Bounded resources: event-driven, no polling, bounded incident registry, bounded evidence per incident, no large payload copies (metadata only).
- No UI beyond a small read-only route/tool consistent with the existing pattern.

## Non-goals

No new detection/classification, no new audit authority, no SPF/LPV changes, no Defender changes, no elevation, no external uploads, no Phase G.
