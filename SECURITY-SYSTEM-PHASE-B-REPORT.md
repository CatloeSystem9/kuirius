# Krisha — Security System Phase B: Malware Detection and Classification — Implementation Report

**Completion date:** 2026-11-15
**Scope:** detection and classification ONLY — no process termination, no file quarantine, no execution blocking, no Defender configuration changes, no external reputation lookups.
**Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md`. Phase A report: `SECURITY-SYSTEM-PHASE-A-REPORT.md`.

---

## 1. Architecture

```
[Krisha server process]
  DetectionEngine (src/agent/malwaredetect/engine.ts — Node-only)
    ├─ Phase A ProcessMonitor.onEvent() → bounded queue (≤100, drop-oldest)
    ├─ DefenderSource (read-only Get-MpComputerStatus + Get-MpThreatDetection,
    │    cached 60 s TTL; no configuration changes; unavailable → honest)
    ├─ FileEvidenceSource (local SHA-256 + Authenticode signature + location
    │    classification; bounded LRU ≤500 keyed by path|mtime|size;
    │    external reputation lookups DISABLED by design)
    ├─ classification rules (deterministic, ordered, explainable)
    └─ audit → E5 chain (SUSPICIOUS+ only, metadata only)

  GET /api/malwaredetect/status   — read-only health/defender/classifications
  POST /api/malwaredetect/assess   — on-demand file assessment (filesystem.read)
  malwareDetect.status tool        — read-only agent visibility
  malwareDetect.assessFile tool    — on-demand file assessment (filesystem.read)
```

## 2. Detection sources

| Source | Mechanism | Cache | Read-only |
|---|---|---|---|
| Microsoft Defender status | `Get-MpComputerStatus` via cached PowerShell | 60 s TTL | yes |
| Microsoft Defender detections | `Get-MpThreatDetection` (top 20, sorted by date) | 60 s TTL | yes |
| File hash | Node `crypto.createHash('sha256')` streaming read | LRU ≤500 keyed by (path\|mtime\|size) | yes |
| Authenticode signature | `Get-AuthenticodeSignature` via PowerShell | LRU (same key) | yes |
| Location classification | Pure path analysis (windows/program-files/user-apps/temp/roaming/downloads/other) | derived from hash/signature cache entry | yes |
| Process ancestry | Phase A `ProcessMonitor.lookup(pid).ppid` + engine classification map | in-memory Map | yes |
| Phase A health | `ProcessMonitor.status().health` | direct call | yes |

## 3. Classification rules

Deterministic, ordered:

1. **CONFIRMED_MALWARE** — a trusted Defender detection matches this process/file path or name. HIGH confidence.
2. **Known security tools cap** — `hydra.exe`, `nmap.exe`, `wireshark.exe`, `metasploit.exe`, etc. are capped at **UNKNOWN** by Krisha-side indicators; only a Defender detection (rule 1) can escalate to CONFIRMED.
3. **Indicators counted**:
   - `invalid-executable-signature` (Invalid/HashMismatch/NotTrusted) [strong]
   - `unusual-executable-location` (temp/roaming/downloads) [weak]
   - `suspicious-ancestry` (parent classified SUSPICIOUS+) [weak]
   - `repeated-suspicious-creation-pattern` (≥3 SUSPICIOUS+ for same path in 10 min) [weak]
4. **HIGH_CONFIDENCE_THREAT** = strong indicator + ≥1 weak, or ≥3 indicators total. MEDIUM confidence.
5. **SUSPICIOUS** = 1-2 weak indicators. LOW/MEDIUM confidence.
6. **CLEAN** = valid Authenticode signature + no detection. LOW confidence. NOT proof of harmlessness.
7. **UNKNOWN** = insufficient evidence (unsigned/unknown with no indicators, or missing path).
8. **UNAVAILABLE** = pipeline error (assessment threw, monitor FAILED with no file evidence).

No invented confidence percentages — confidence is a level (NONE/LOW/MEDIUM/HIGH) derived from evidence-source count and quality.

## 4. Confidence methodology

| Classification | Confidence basis |
|---|---|
| CONFIRMED_MALWARE | HIGH — trusted third-party (Defender) detection evidence |
| HIGH_CONFIDENCE_THREAT | MEDIUM — strong indicator + corroboration, or ≥3 independent weak indicators |
| SUSPICIOUS | LOW-MEDIUM — 1-2 weak indicators; MEDIUM if the strong indicator is present alone |
| CLEAN | LOW — no detection produced by available checks; explicitly not proof |
| UNKNOWN | LOW/NONE — insufficient evidence; honest about what's missing |
| UNAVAILABLE | NONE — pipeline error |

## 5. Defender integration

- `Get-MpComputerStatus`: AMService, real-time protection, behavior monitoring, signature ages, engine version (read-only, cached 60 s).
- `Get-MpThreatDetection`: top 20 detections sorted by date (read-only, cached 60 s).
- Operational event log is readable non-admin (Phase 1 MEASURED) — available for future Phase C correlation.
- Exclusions are admin-only (Phase 1 MEASURED) — changes are invisible to Krisha non-admin (honest limitation).
- **No Defender settings, exclusions, or policies are changed.** The real-time AV engine is Defender's; Krisha classifies and correlates but does not duplicate it.

## 6. Process-monitor integration

- Subscribes through `ProcessMonitor.onEvent()` (internal interface added in Phase A — no second monitor).
- Ancestry: the engine's `classificationByPid` map tracks classifications per PID; `monitor.lookup(pid).ppid` resolves the parent PID for ancestry rules.
- Monitor DEGRADED/FAILED: recorded as missing evidence; engine health reflects it; process-event assessments stop (file-only on-demand assessment still works).
- PID reuse: each creation event is assessed independently; no stale merge.
- Missing events: no fabricated detections; reconciliation is the monitor's responsibility (Phase A).

## 7. Privacy boundaries

- **No command lines collected or evaluated** (enforced by schema — the field is never requested).
- **No external uploads** (`EXTERNAL_REPUTATION_ENABLED = false`, guarded by constant).
- **No secret-bearing logs**: audit records carry classification, confidence level, pid, path, evidence-kind names, engine version. File contents, SHA-256 hash values, and command lines never appear (suite-asserted).
- **No LPV access** — this subsystem has zero interaction with the vault.

## 8. Performance measurements (MEASURED, real Defender + real file source)

| Metric | Measured value |
|---|---|
| 30-event burst processing | 31-61 ms |
| Burst CPU (whole test process) | 0.0 ms (defender + file sources cached) |
| Burst RSS delta | ±0.0 MB |
| Second burst (cached file evidence) | 0.0 ms (caching effective) |
| Classification count | 30/30 (all CLEAN for signed cmd.exe) |

## 9. Test results (exact)

`npx tsx scripts/test-malware-detect.ts` — **50 passed, 0 failed — ALL GREEN**:

| # | Scenario | Result |
|---|---|---|
| 1 | Defender active and healthy (MEASURED on this machine) | pass |
| 2 | Defender unavailable → UNKNOWN with honest missing-evidence | pass |
| 3 | Defender confirmed detection → CONFIRMED_MALWARE/HIGH | pass |
| 4 | Unsigned legitimate executable → UNKNOWN/SUSPICIOUS, never CONFIRMED | pass |
| 5 | Valid signed executable → CLEAN with honesty caveat | pass |
| 6 | Invalid signature → SUSPICIOUS/MEDIUM (strong alone) | pass |
| 7 | Missing executable path → honest missing-evidence | pass |
| 8 | Unknown executable → UNKNOWN | pass |
| 9 | Suspicious ancestry → SUSPICIOUS with ancestry evidence | pass |
| 10 | Corroborating indicators → HIGH_CONFIDENCE_THREAT | pass |
| 11 | False-positive resistance (system binary → CLEAN) | pass |
| 12 | Hydra dual-use classification (UNKNOWN cap) + Defender override to CONFIRMED | pass |
| 13 | PID reuse (independent classifications) | pass |
| 14 | Missing process-monitor events (no fabrication) | pass |
| 15 | Phase A DEGRADED → reflected in engine health + missing evidence | pass |
| 16 | Phase A FAILED → UNKNOWN/NONE, engine health FAILED | pass |
| 17 | File hash caching (same file → 1 hash call) | pass |
| 18 | Changed-file invalidation (mtime+size → re-hash) | pass |
| 19 | Permission boundary (filesystem.read declared; no control tools) | pass |
| 20 | Emergency-stop compatibility (status + assess callable; stop active) | pass |
| 21 | Audit metadata privacy (no command lines, no hash values, no file contents) | pass |
| 22 | Queue and cache bounds (≤5 queue, ≤10 records) | pass |
| 23 | Performance burst (30 events, CPU 0 ms, RSS ±0 MB, caching effective) | pass |
| 24 | Live-server integration (status route, assessment route, no control route) | pass |

## 10. Known limitations

1. **No external reputation lookups** — an unsigned unknown executable is UNKNOWN, not malicious; hash-based lookup services (VirusTotal etc.) are disabled by design and require a separately authorized SPF-approved design.
2. **Pattern-based detection cannot catch novel threats** — no AI/ML model is loaded; the rules are deterministic and explainable but limited to the defined indicator set.
3. **Confidence is level-based, not calibrated** — no fake percentages; a real calibration would require a labeled corpus and statistical evaluation.
4. **Defender is the real-time AV authority** — Krisha classifies and correlates but does not duplicate Defender's real-time engine.
5. **Same-user ceiling** — the engine is non-admin; same-user malware can read its source and bypass its rules.
6. **File hashing takes time on SMR HDD** for large executables — cached after first assessment but the first call can take seconds.
7. **Short-lived processes** — the Phase A WMI WITHIN-1 limitation applies: a fast-exit process may never generate a creation event and therefore never trigger an assessment.

## 11. False-positive risks

1. Legitimate unsigned software (common for indie/open-source tools) → UNKNOWN (not SUSPICIOUS unless in unusual location); a legitimate tool in a user-apps directory is UNKNOWN.
2. Legitimate security tools → capped at UNKNOWN (dual-use guard).
3. Legitimate software running from unusual locations (e.g. portable apps from Downloads) → SUSPICIOUS (1 weak indicator) — warrants review but never auto-contained.
4. Clean classification is explicitly NOT proof of harmlessness — the honesty caveat is embedded in every CLEAN record's explanation.

## 12. Remaining gaps (Phase C+ scope)

1. Process termination/suspension (containment).
2. File quarantine with controlled recovery.
3. Execution blocking (requires elevation decision).
4. Self-protection (monitor watchdog, tamper evidence of the detection engine itself).
5. External reputation lookups (requires SPF-approved design).
6. Full short-lived process coverage (requires elevated ETW).
