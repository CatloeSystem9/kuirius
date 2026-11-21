# Krisha — Security System Phase B: Malware Detection and Classification — Implementation Report

**Completion date:** 2026-11-15 (verification and correction: 2026-11-18; Phase B.1 final verification: 2026-11-19)
**Scope:** detection and classification ONLY — no process termination, no file quarantine, no execution blocking, no Defender configuration changes, no external reputation lookups.
**Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md`. Phase A report: `SECURITY-SYSTEM-PHASE-A-REPORT.md`.

---

## 0. Phase B.1 — Final Security Verification (2026-11-19)

### 0.1 Defender resource-path matching correction

**Defect identified:** The Defender resource-path matching used substring containment (`.includes(normalizedPath)`), meaning a Defender detection for `C:\Apps\tool.exe.backup` would falsely trigger a CONFIRMED_MALWARE classification for `C:\Apps\tool.exe` running as a process. This violated the requirement that "a Defender resource path must not match a different executable simply because its text contains the target path."

**Correction:** Replaced substring containment with **normalized exact path equality** using `normalizeWindowsPath()` + `matchDefenderResource()`:
- Normalizes Windows paths: case-insensitive, `/` → `\`, redundant separators collapsed, `.` and `..` resolved, drive-letter case normalized, trailing separators stripped by `path.resolve()`.
- Rejects relative paths BEFORE resolution (returns `null` → ambiguous, never a match).
- Returns `'match'` (exact equality), `'no-match'` (both normalized, different), or `'ambiguous'` (one or both paths cannot be safely normalized — identity cannot be established).
- Ambiguous resources are recorded in `missingEvidence` (never silently skipped or treated as matches).
- Process-name matching is exact case-insensitive (not substring).

**False-positive prevention:** `C:\Apps\tool.exe` no longer matches Defender resources for `C:\Apps\tool.exe.backup`, `C:\Apps\tool.exe\other.exe`, `C:\Apps\other.exe`, or `C:\Other\tool.exe`. A Defender resource for `C:\Apps` (a directory) does not match `C:\Apps\tool.exe` (a file inside it).

### 0.2 Path-matching test results (25 new assertions)

| Test | Expected | Result |
|---|---|---|
| Exact same path | match | pass |
| Case-insensitive | match | pass |
| `/` vs `\` normalization | match | pass |
| Redundant separators | match | pass |
| Trailing separator on file | match (same file on Windows) | pass |
| `tool.exe.backup` vs `tool.exe` | no-match | pass |
| `tool.exe\other.exe` vs `tool.exe` | no-match | pass |
| `other.exe` vs `tool.exe` | no-match | pass |
| Different directory | no-match | pass |
| `not-evil.exe` vs `evil.exe` | no-match | pass |
| Directory prefix vs file inside | no-match | pass |
| Relative resource | ambiguous | pass |
| Empty resource | ambiguous | pass |
| Empty process path | ambiguous | pass |
| Defender `file:_` prefix stripped | match | pass |
| `..` resolution to canonical | match | pass |
| UNC exact | match | pass |
| UNC vs local | no-match | pass |
| Engine: exact resource → CONFIRMED | CONFIRMED | pass |
| Engine: case-insensitive resource → CONFIRMED | CONFIRMED | pass |
| Engine: similar filename → NOT CONFIRMED | not CONFIRMED | pass |
| Engine: directory prefix → NOT CONFIRMED | not CONFIRMED | pass |
| Engine: ambiguous resource → NOT CONFIRMED + missing evidence | not CONFIRMED | pass |
| Engine: substring prevention (not-evil.exe) | not CONFIRMED | pass |

### 0.3 E5 store integrity (byte-level)

**Method:** SHA-256 file-content hashes + sizes + line counts, captured before and after the full verification campaign (Phase B suite, Phase A suite, SPF text, SPF visual, LPV core/security/perf, E5 M1/M2/M3/H4, Phase 13/14/18, agent-core, goal-continuity, `tsc --noEmit`).

| File | Size | Lines | SHA-256 (full) |
|---|---|---|---|
| `\install.marker` | 45 | 1 | `000FA71ACA75AE1BA26378C1C19BA9109C795513C99E34442BFA21D3EE1A30FF` |
| `\stop-state.json` | 225 | 9 | `0A5A70029A449D482F20AC58A550585051452FFC0DA37BF35DF05BA605F79B49` |
| `\audit\server-audit.jsonl` | 593963 | 2411 | `6B989AB1188B826B7E8F0B105EA8A68CF86A47AC148D9938AE5C6AC80E44EF0A` |
| `\quarantine\items\697bff14-…a6.data` | 16 | 1 | `91555D75A62A219D80AFB65C0037D28DD1BCCCE9EE9BABBB5E69BF45B69AA1E8` |
| `\quarantine\items\697bff14-…a6.meta.json` | 667 | 19 | `6124A8334FC79B51CE1C2B99B626ACA110B475154EFBEDB8DD7A89FC4FFE3BA2` |
| `\sandbox-journal\journal.jsonl` | 4477 | 16 | `44BA77055F4CA21D4C5D7E1024B0E72CCBAE0D5F0C3252AB1FAB37838CE2E152` |

**Result:** all 6 files **byte-identical** before and after. Store: `full` protection, stop `INACTIVE`, 2411 audit entries, pre-existing line-3 discontinuity unchanged.

**Historical identity caveat:** no trusted pre-campaign content hash exists for the original baseline (before any SPF/LPV campaign), so historical byte-identity from the ORIGINAL creation point cannot be established. What IS established: the store was **byte-identical across the full Phase B.1 verification campaign** (all test suites, all spawned servers, all regression runs). The audit file's mtime changed (filesystem access artifact — Windows Defender scanning or NTFS metadata update), but the content hash is the same, confirming no content modification.

### 0.4 Phase B.1 test results

| Suite | Result |
|---|---|
| **Malware detection (incl. path-matching tests)** | **90 passed, 0 failed** |
| Process Monitor | 65 passed, 1 failed (transient: monitor briefly DEGRADED during 12-process burst on 2-core i3 — documented known limitation, self-heals) |
| SPF text | 220 passed, 0 failed |
| SPF visual | 113 passed, 0 failed |
| LPV core | 92 passed, 0 failed |
| LPV security | 55 passed, 0 failed |
| E5 M1 / M2 / M3 / H4 | 86 / 74 / 72 / 70 passed, 0 failed |
| Phase 13 / 14 / 18 | 91 / 150 / 62 passed, 0 failed |
| `tsc --noEmit` | 0 errors |
| Real E5 store | byte-identical before/after (§0.3) |

---

## 1. Architecture

(unchanged from the original Phase B implementation — see below)

## 2. Detection sources

(unchanged — see below)

## 3. Classification rules

**CORRECTED** — see §0.1 for the path-matching fix. The remaining rules are:

1. **CONFIRMED_MALWARE** — trusted Defender detection matching the process's executable path (normalized exact path equality) or exact process name. HIGH confidence.
2. **Known security tools cap** — `hydra.exe`, `nmap.exe`, etc. capped at UNKNOWN.
3. **HIGH_CONFIDENCE_THREAT** — invalid signature + ≥1 additional indicator, or ≥3 indicators. MEDIUM confidence.
4. **SUSPICIOUS** — 1-2 indicators (excluding mere absence of signature). LOW/MEDIUM confidence.
5. **CLEAN** — no indicators + available checks completed (Defender quiet, file exists, signature determinable). LOW confidence. NOT proof of harmlessness.
6. **UNKNOWN** — insufficient evidence (checks incomplete, missing path, Defender unavailable).
7. **UNAVAILABLE** — pipeline error.

**CONFIRMED_MALWARE evidence requirements:** ONLY a Microsoft Defender detection matching the process's executable path (normalized exact equality) or exact process name. Process names alone, file paths alone, unsigned status alone, weak indicators alone, and dual-use tool names alone can **never** produce CONFIRMED_MALWARE.

## 4. Confidence methodology

Level-based (NONE/LOW/MEDIUM/HIGH) — NOT calibrated percentages.

## 5. Defender integration

(unchanged — read-only, cached, no configuration changes)

## 6. Process-monitor integration

(unchanged — subscribes through `onEvent()`, no second monitor)

## 7. Privacy boundaries

(unchanged — metadata-only audit, no command lines, no contents)

## 8. Performance measurements

(MEASURED — see original §8 and Phase B.1 verification for the real working-set / private-bytes measurements)

## 9. Known limitations

(unchanged plus: Defender resource-path matching now uses exact normalized equality — ambiguous paths are recorded as missing evidence rather than matched or unmatched)

## 10. Remaining gaps

(unchanged — Phase C+ scope)
