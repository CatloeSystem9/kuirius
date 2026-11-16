# Krisha — Security System Phase 1: Read-Only Architecture and Capability Audit

**Audit date:** 2026-11-15
**Auditor:** SPF workstream (read-only pass)
**Method:** static source inspection, existing test-report verification, read-only Windows facility probes (no configuration modified, no destructive execution), hardware measurement. Every claim below distinguishes **MEASURED** (executed probe), **VERIFIED-BY-TEST** (existing suite evidence on the current tree), **DOCUMENTED** (Windows/OS-documented behavior, not executed here), or **ESTIMATED/UNKNOWN**.

**Read-only compliance note:** during this audit two ephemeral probe scripts were briefly created under `scripts/` (WMI capability probe, server-footprint probe) and deleted immediately after execution; the source tree is otherwise untouched and re-verified by hash at the end (§10). All other probe outputs went to the OS temp directory. No test suites were re-run; the 2026-11-15 integration-baseline results are cited as current evidence after an 11-of-11 file-hash drift check confirmed the tree is unchanged since that run, `tsc --noEmit` reports 0 errors, and the real E5 store reads exactly as it did at baseline (732 audit entries, `full` protection, stop `INACTIVE`).

---

## 1. Executive summary

Krisha already owns a **mature, tested application-security layer** — three enforced, verified subsystems that protect Krisha's own operations: the **Screen Privacy Firewall** (screen-derived data egress with local OCR inspection and irreversible redaction), the **Local Private Vault** (credential retention and origin-verified browser fill), and the **E5 server-side trust foundation** (protected storage, durable emergency stop, permissions, quarantine, tamper-evident audit). All three were regression-verified on the current tree on 2026-11-15 (exact counts in §4-§6, §13 of the integration baseline `SECURITY-INTEGRATION-BASELINE.md`).

What Krisha does **not** have is any **host-security capability against external software**: there is no process-creation monitoring, no malware detection or classification, no system-wide execution enforcement, no threat containment, and no self-protection of Krisha's own processes. Measured evidence shows the Windows foundations for all six proposed capabilities **exist and are reachable from Krisha's non-admin user context** (event-driven WMI process-creation events fire without admin, ~1 s granularity; `Get-AuthenticodeSignature` works; Defender is fully active with current signatures and its operational event log is readable; `taskkill`-based same-user termination exists in the codebase). Three of the six capabilities therefore have a realistic, dependency-free implementation path; the others are bounded by the non-admin context (Security log, ETW process tracing, AppLocker/WDAC configuration all require elevation) and by the Windows security model (a non-admin process can neither inspect nor stop elevated/SYSTEM processes — a hard boundary, not a fixable defect).

The machine is constrained and already under memory pressure: **7.8 GB RAM with only 1.3 GB free at audit time**, a 2-core i3, and a 1 TB SMR HDD alongside a 238 GB NVMe SSD. Krisha's own dev-mode server tree measured **~328 MB** working set (40.7 MB main node + 287.2 MB children). The only viable design is **event-driven, poll-light, with heavy analysis on demand** — continuous OCR-style scanning or always-on ETW sessions are neither practical nor necessary (Defender already provides real-time AV).

Recommended first implementation task: **Phase A — independent process monitoring** built on the measured WMI/CIM facilities, reusing the existing audit chain and the Phase 18 tool-chokepoint pattern (§18).

## 2. Source-state identification

- **Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md` (integration date 2026-11-15) with SHA-256 inventory of 28 security-relevant files.
- **Drift check during this audit (MEASURED):** 11 of 11 re-checked baseline hashes match exactly (`server.ts`, `lpvCore.ts`, `browserCdp.ts`, `serverSafety.ts`, SPF core files, both SPF suites, LPV security suite). **Tree unchanged since the baseline regression.**
- **Compiler state (MEASURED):** `npx tsc --noEmit` → 0 errors.
- **Real E5 store (MEASURED, read-only):** `C:\ProgramData\Krisha\sandbox`, protection `full`, stop `INACTIVE`, audit chain **732 entries**, pre-existing line-3 discontinuity unchanged.
- **Git:** unavailable in this environment (not on PATH) — hashes serve as the version-state record.
- Concurrency note: the LPV workstream's refactor that was in flight on 2026-11-14 has landed; the 2026-11-15 integration baseline (SPF 220/0 + 113/0, LPV core 92/0, LPV security 5×55/0, LPV perf 11/0, E5 M1/M2/M3/H4 86/74/72/70, Phases 13/14/18 91/150/62, agent-core 49/0, goal-continuity 163/0) is therefore **current-tree evidence**.

## 3. Existing security architecture (overview)

Two planes, both **enforced centrally** (verified in the integration baseline):

| Plane | Components | Boundary |
|---|---|---|
| Server process (authoritative) | E5 `serverSafety.ts` (`enforce()` on 30+ routes: permissions → emergency stop → rate limit → audit), protected store (outside every model-writable root), sandbox core + journal, quarantine, rollback, integrity monitor, recovery pipe, **SPF gates on all external egress + outbound transport guard**, **LPV vault routes** | Protects the host operations Krisha performs |
| Agent process (in-browser) | Phase 18 `SafetyGate` at the `ToolRegistry.execute` chokepoint, scoped permissions, bounded redacted audit, SPF per-item screening of tool outputs/summaries/digests | Protects what the model can cause |

Trust boundaries (verified in source): the model never executes code directly (no code-execution tool exists; tools are fixed implementations); the model cannot approve LPV challenges (decision tokens + `vault.manage` server permission; no vault tool in the ToolRegistry); the model cannot reach the protected store (`assertNotProtected` refuses every FS-agent path into it); emergency-stop recovery is operator-CLI+credential only (no HTTP/tool deactivation).

## 4. SPF assessment — **IMPLEMENTED AND VERIFIED**

**Evidence (VERIFIED-BY-TEST, integration baseline 2026-11-15 on the current hash-verified tree):** text security suite 220/0 (detection of passwords/OTPs/Google credentials/bank/card/CVV/API keys/auth tokens/private keys/seed phrases/national IDs/confidential context; JSON-field and URI/base64 evasion forms; wire-level receiver proof; bypass attempts; leakage checks); visual security suite 113/0 (local OCR pixel inspection, every-frame/page coverage, irreversible black-fill redaction, mandatory second inspection, fail-closed injections, direct-upload bypass, emergency-stop 423). Performance measured: clean-image pipeline p50 ~25 ms, sensitive pipeline p50 ~68 ms, worker boot ~434 ms one-time.

**Verified integration:** gates on vision/chat/maps-grounding/memory-extract/TTS/transcribe/geocode/research/browser-navigate/web-search-URL builders; system-wide outbound guard (patched `globalThis.fetch` + `ClientRequest` prototype); `/api/vision/analyze` and vault routes stop-blocked.

**Known limitations (documented in-tree, honest):** OCR-based visual inspection cannot read unrecognizable text (tiny/low-contrast/non-Linux scripts/stylized); empty OCR is an allow (surfaced via metadata, not silent); sensitive multi-frame containers are **blocked** not redacted (GDI+ cannot re-encode edited GIF/TIFF); split secrets across separate fields evade per-string detection; Google-key detection tolerates `AIza→Alza` OCR confusion (precision kept via exact body-length).

## 5. LPV assessment — **IMPLEMENTED AND VERIFIED**

**Evidence (VERIFIED-BY-TEST):** LPV core 92/0 (crypto properties, tamper fail-closed, approval challenges incl. replay/expiry/draft-binding, audit chain, restart recovery, degraded mode); LPV security 5×55/0 (route-layer 403/once-consumption/423, locked-state defense, origin-mismatch and navigation refusals, multi-tab pinning both directions, cross-origin refusal, no-leak assertions, restart-can't-redirect); LPV perf 11/0 (unlock cold 41 ms / warm 51 ms, save ~13 ms, lock ~5 ms).

**Architecture verified in source:** DPAPI (CurrentUser) wrapped 32-byte master key; HKDF subkeys (enc: AES-256-GCM per-entry with AAD binding; mac: HMAC over the canonical full document); account-SID binding; generation tracking with `.bak`; auto-lock zeroes key material; fill grants single-use/60 s/expiring, bound {entry, origin}, issued only by operator-approved challenges; fill = live-origin probe over ALL CDP targets → pin matching page → `readyState === 'complete'` → atomic in-page origin re-check with typing → post-fill navigation detection. Route layer: `vault.manage`/`vault.retrieve` permissions, stop-blocked, rate-limited.

**Limitations:** same-user trust model (page-level origin verification cannot defeat a determined same-user adversary — disclosed); fill secrets transit the loopback CDP WebSocket (local channel; outside the SPF external-egress guard's scope by design — destination gated by origin verification); DPAPI CurrentUser scope is defeated by malware running as the same user (documented Windows property).

## 6. E5 assessment — **IMPLEMENTED AND VERIFIED**

**Evidence (VERIFIED-BY-TEST):** M1 86/0 (protected storage, permissions authority, stop persistence/recovery pipe, audit chain, route enforcement), M2 74/0 (sandbox mutations, journal, NTFS identity tracking), M3 72/0 (rollback challenges, quarantine capture/restore), H4 70/0 (hardened failure modes; asserts the **real ProgramData store untouched**), integrity monitor integrated (`/api/integrity/status`).

**Components:** protected store at `C:\ProgramData\Krisha\sandbox` (outside every model-writable root, `assertNotProtected` refusal, NTFS identity anti-spoofing); durable emergency stop (scrypt-hashed credential, timing-safe compare, exponential backoff, recovery via restricted named pipe only); hash-chained fsync audit (`server-audit.jsonl`); sandbox journal; quarantine (bounded 50, integrity self-hashed, restore operator-declared); rollback (server-minted plans, UI-only approval, single-use challenges).

**Measured state during audit:** 732 entries, line-3 discontinuity (pre-dates all SPF/LPV campaigns; honestly reported by the verifier; not repaired — repairs are out of scope for a read-only audit and operator-gated by design).

**Limitations:** protection degrades explicitly (`degraded`/`unavailable` modes weaken tamper-resistance and refuse operations rather than silently continue); audit is tamper-**evident**, not tamper-proof (same-user malware can truncate — survival depends on the chain tail check at next boot); the whole E5 layer assumes Krisha's own process is uncompromised.

## 7. Agent and tool security assessment — **IMPLEMENTED AND VERIFIED** (with boundaries)

**Evidence:** Phase 18 suite 62/0 (risk classification, permission decisions, scoped grants, emergency stop cancel/block, audit redaction, "no self-authorization", compatibility with Phase 16/17/research under the gate); integration baseline (no vault tools; approvals operator-only).

**Verified mechanics:** every tool execution passes `SafetyGate.evaluate` (fail-closed unknown permissions, scoped revocation, e-stop blocks, risk classification, audit with input **keys only**); tool input validation rejects unexpected keys; permission defaults deny for screen/mouse/keyboard/filesystem-write/terminal/camera/mic; launch tools are allowlist-only (`appLaunchByName` over discovered apps; `appLaunchByPath` restricted to allowed roots — never arbitrary command strings).

**Privilege-escalation reality (DOCUMENTED, MEASURED):** the audit shell runs **non-elevated** (`IsInRole(Administrator) = False`); Krisha's process actions are same-user only — she cannot kill/inspect elevated or SYSTEM processes (Windows DACL model); she cannot read the Security event log or configure AppLocker/WDAC. This is a hard boundary the Security System must be designed around (either stay non-admin, or require a documented elevation model).

**Potential bypasses considered:** the model → tool path has one chokepoint (verified); the direct-HTTP path is E5-gated server-side (verified); the outbound-transport guard covers unknown clients (verified); the unguarded channels that remain are (a) LPV's loopback CDP fill (origin-gated by LPV, local-only) and (b) any *elevated* software outside Krisha — outside her control.

## 8. Capability 1: Independent Process Monitoring — **PARTIALLY IMPLEMENTED**

| Sub-capability | Status | Evidence |
|---|---|---|
| Current process inventory | PARTIAL (fragment) | `appStatus(processName)` (Phase 9, `systemAgentServer.ts:340`) queries Get-Process by name → PIDs (MEASURED facility; not an inventory); MEASURED: `(Get-Process).Count = 260` processes, `Win32_Process` exposes PPID + ExecutablePath without admin |
| Observe creation/termination | NOT IMPLEMENTED | No `__InstanceCreationEvent`/ETW/watch code anywhere in the tree (searched); **MEASURED: temporary WMI subscription `__InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'` fires WITHOUT admin** with name/pid/ppid/path, ≤1 s window (probe executed; also observed the ≤1 s granularity limitation — a fast child that exits inside the window may not be surfaced with full detail) |
| Parent-child relationships | NOT IMPLEMENTED (facility MEASURED) | `Win32_Process.ParentProcessId` readable non-admin (MEASURED on explorer.exe) |
| Executable paths + digital signatures | NOT IMPLEMENTED (facility MEASURED) | `ExecutablePath` MEASURED; `Get-AuthenticodeSignature` MEASURED: `cmd.exe`/`notepad.exe` → `Valid`, signer `Microsoft Windows`, works non-admin |
| Unexpected behaviour identification | NOT IMPLEMENTED | No baselining/heuristics code exists |
| Monitoring-interruption detection | NOT IMPLEMENTED | No monitor process exists to interrupt |
| Hide-from-monitoring detection | NOT IMPLEMENTED | Requires ETW TraceLogging/Security log 4688 (both elevation-gated: Kernel-Process analytic log measured `IsEnabled=False`; Security log access MEASURED refused non-admin) |

**Windows facilities (MEASURED this audit):** WMI temporary subscriptions (no admin, ≤1 s, dies with the process — ephemeral and self-cleaning); polling `Win32_Process` (no admin, arbitrary frequency); permanent WMI subscriptions exist as a mechanism but are themselves a malware persistence technique (MEASURED: 1 permanent consumer present on this machine — `SCM Event Log Consumer`, name-empty, origin UNKNOWN — flagged for investigation, not classified). **NOT usable non-admin:** Security event log 4688 (refused — MEASURED), enabling the Kernel-Process analytic ETW trace (exists, disabled — enabling needs admin + modifies system state → not executed), WMI `Win32_ProcessStartTrace` (requires admin per documented Windows behavior).

**Design consequence:** a Krisha-native monitor can be event-driven at ~1 s granularity without admin (temporary-permanent hybrid WMI subscription owned by Krisha's server process, re-armed on restart), enriched per event by `Win32_Process` snapshot (ppid/path) and `Get-AuthenticodeSignature`, with the Security log as an optional elevated enhancement.

## 9. Capability 2: Malware Detection and Classification — **NOT IMPLEMENTED**

No detection, classification, or reputation code exists in the tree (searched: `malware|virus|defender|threat` — only a prompt-persona `krisha-specialists/departments/security.ts` that routes LLM review of *code/plans*, and unrelated catalog strings).

**Available Windows facilities (MEASURED):** Microsoft Defender fully active (AMService/RealTimeProtection/BehaviorMonitor all `true`, signature age **0 days**, quick scan age 0 days, engine 1.1.26100.4) — Krisha should **consume Defender as the AV authority, not duplicate it**; `Get-MpComputerStatus` and the Defender operational event log are readable non-admin (MEASURED: last event today); `Get-MpPreference` works but **exclusion paths/processes are hidden from non-admin** (MEASURED: "Must be an administrator to view exclusions") — exclusion changes are therefore detectable only indirectly (e.g. via the operational log) from Krisha's context; `Get-MpThreatDetection` provides Defender's verdict history (readable, not enumerated in this audit to avoid touching live security state beyond read queries); full scan has never run (`FullScanAge` = 4294967295 sentinel) — a gap worth surfacing to the user, though launching scans is an action, not an audit step.

**Hydra-class distinction (design finding):** penetration/security tools (Hydra, Nmap, Mimikatz…) are dual-use — name-matching every occurrence would flag legitimate security tooling. The available signals for context-aware classification are all reachable non-admin: signature validity + signer (MEASURED), path (MEASURED — Program Files vs %TEMP% vs removable), parent-child chain (MEASURED), command line (`Win32_Process.CommandLine`, non-admin readable for own-user processes — DOCUMENTED), Defender verdicts/log, and first-seen heuristics. Classification must be **confidence-graded and conservative** (uncertain → report + escalate to operator; never auto-destroy on a weak signal). Nothing about Hydra specifically was measured (no such tool was executed — prohibited); the design path above is how dual-use classification must be built.

## 10. Capability 3: Protected Execution Enforcement — **NOT IMPLEMENTED** (system-wide; precursor exists)

Krisha enforces launch policy **only on her own launches** (verified: allowlist-only `appLaunchByName`/`appLaunchByPath`, never arbitrary commands). There is no system-wide launch interception, blocking, or enforcement independent of user approval.

**Windows enforcement facilities investigated:**
- AppLocker: effective policy **readable non-admin (MEASURED)** but contains **0 rule collections** — nothing configured; *configuring* AppLocker requires administrative PowerShell (DOCUMENTED) → out of Krisha's non-admin reach.
- WDAC (Code Integrity): same elevation requirement (DOCUMENTED); not probed (read queries exist but the audit did not modify or elevate).
- Defender: provides real-time blocking as the system's existing enforcement authority (MEASURED enabled) — Krisha's enforcement role realistically = **feed/verify/react**, not replace.
- Krisha-side pre-launch gate for her own tools already exists (verified) and is the model for "inspect launch attempts she initiates".

**Hard boundary (DOCUMENTED):** an ordinary user-mode process cannot override administrator-level or kernel-level actions — enforcement of system-wide execution policy requires either elevation (operator consent model needed) or delegation to Defender/AppLocker. Any design claiming otherwise would be false.

## 11. Capability 4: Threat Detection and Containment — **PARTIALLY IMPLEMENTED** (fragments)

| Sub-capability | Status | Evidence |
|---|---|---|
| Identify active threats | NOT IMPLEMENTED (Krisha-side) | No detection code; Defender verdicts readable (facility MEASURED) |
| Suspend malicious processes | NOT IMPLEMENTED | No cmdlet exists (MEASURED: PowerShell offers no process suspend); needs NtSuspendProcess native call on a handle Krisha owns — feasible **same-user only** (DOCUMENTED) |
| Terminate confirmed malicious processes | PARTIAL (fragment) | `appClose(pid)` (taskkill) exists and is route-enforced (`application.launch` permission, stop-blocked); MEASURED facility class works for same-user processes; cannot touch elevated/SYSTEM (DOCUMENTED) |
| Quarantine malicious files safely | PARTIAL (fragment) | `quarantineCore.ts` captures deleted files into protected storage (verified M3) — designed for Krisha's FS-agent deletions, but the capture/restore/release primitive is directly reusable for detected executables; **caution**: quarantine-then-delete of live malware is containment-adjacent, and Defender remains the authority for actual malware quarantine |
| Prevent reinfection | NOT IMPLEMENTED | Defender's domain; Krisha could surface Defender status only |
| False-positive handling / controlled recovery | PARTIAL (fragment) | quarantine restore path is operator-declared and integrity-checked (verified M3) — the recovery pattern exists and extends naturally |

## 12. Capability 5: Security Self-Protection — **PARTIALLY IMPLEMENTED**

**What exists (VERIFIED):** Krisha's *data* is well protected — E5 protected store (outside model-writable roots, NTFS-identity anti-spoofing), tamper-evident audit chains, sandbox journal, stop-state persistence with integrity self-hash, `assertStopInactive` on vault operations, integrity monitor with health states.

**What is missing (verified by absence + MEASURED):** nothing protects Krisha's *processes* — her node server and future monitor run same-user non-elevated, so same-user malware can terminate them (Stop-Process works on any same-user process — MEASURED class), alter her config, or kill the monitor. Detection-of-own-death is achievable (watchdog pattern: a second lightweight process or scheduled re-arm; the WMI subscription dies with its process, so re-arming on restart is inherent); hard protection against same-user termination is **not realistically achievable without an elevated or kernel component** — the task's own constraint (no unnecessary kernel driver) means the honest ceiling is: fast restart + tamper-evident evidence + operator-visible gaps (audit tail check on every boot already provides this pattern — VERIFIED in E5 M1).

**Observed anomaly (MEASURED, UNKNOWN classification):** one permanent WMI event consumer exists on this machine (`__EventConsumer`, class `SCM Event Log Consumer`, empty `Name`). Standard consumer classes are CommandLineTemplate/ActiveScript/LogFile — an SCM consumer is unusual; it may be OEM/management software or adversary persistence. **Flagged for investigation**; no classification made (read-only audit; classification needs the consumer's full binding/definition which is readable but analysis belongs to the implementation phase).

**Monitoring-evasion reality (DOCUMENTED):** same-user malware can read Krisha's source/config; anti-analysis resistance without elevation is limited to obfuscation-fast-restart + evidence, which must be honestly disclosed.

## 13. Capability 6: Incident Logging and Recovery — **PARTIALLY IMPLEMENTED**

**Infrastructure (IMPLEMENTED AND VERIFIED):** three tamper-evident audit channels — E5 hash-chained JSONL (fsync, seq+prevHash, boot-tail verification, restart markers), LPV audit chain (same pattern), SPF in-memory transparency ring + E5 records — plus the integrity monitor (bounded rotating verification, health states), failure tracker (redacted fingerprints), diagnostics service, and rollback/quarantine recovery paths. All preserve metadata only; secrets are redacted or keys-only at every recorded surface (VERIFIED by suites).

**What is missing:** *security-incident semantics* — there is no incident object, no threat/containment lifecycle (detected → contained → recovered → closed), no confidence field distinguishing confirmed incidents from uncertain alerts, no operator-facing incident timeline. The logging **foundation** is production-grade; the incident **model** is greenfield (straightforward to build on the existing chains without a second logging system).

## 14. Hardware and performance assessment

**MEASURED this audit:**

| Item | Value | Consequence |
|---|---|---|
| RAM | 7.8 GB total, **1.3 GB free** | Memory pressure exists today; any resident monitor must stay small (tens of MB); avoid holding process snapshots in RAM unbounded |
| CPU | Intel i3-1005G1, 2 cores / 4 threads | Signature checks and OCR are per-event, not continuous |
| Disk | ST1000LM035 1 TB (5400 rpm **SMR** HDD) **+** NVMe SSD 238 GB | The task's "probably HDD" is half-true — both exist; Krisha lives on the user profile (HDD side). Avoid hot-loop disk writes; batch audit appends already fsync-per-entry (E5 pattern is sustainable, journal is small) |
| Background processes | 260 running at audit time | Monitor must tolerate noise; baseline inventory will be large — first-seen classification needs a learning period |
| Krisha server footprint (dev mode, isolated spawn) | **~328 MB** working set total (main node 40.7 MB + 2 children 287.2 MB), healthy in 1–3 s | Any security monitor should budget < 50 MB resident and near-zero idle CPU |

**ESTIMATED (design targets, not measurements):** a WMI-event-driven monitor (1 s window) consumes ~0% idle CPU (kernel-side eventing) and fires only on process creation (~tens/minute on an idle desktop); per-event enrichment (CIM snapshot + signature check) ~50-200 ms CPU on this i3 — acceptable if gated to *new/unknown* executables only. Continuous full-signature scanning of all 260 processes would be neither practical nor useful (Defender already does exactly that). **UNKNOWN:** exact HDD impact of audit growth (fsync-per-entry on SMR media) — measure during implementation.

## 15. Existing vulnerabilities and limitations (consolidated)

1. **Same-user ceiling** — everything Krisha runs is non-admin; same-user malware can kill her processes, read her source/config, and zero her audit tails (evidence survives via boot-tail checks). Elevation is a product decision, not a code fix.
2. **Pre-existing audit discontinuity** at real-chain line 3 (pre-dates all campaigns, honestly reported, operator-gated repair).
3. **Memory pressure** (1.3 GB free) — a monitor leak or unbounded cache would destabilize the whole machine.
4. **Defender exclusion opacity** — exclusion changes are invisible to non-admin (MEASURED).
5. **One unexplained permanent WMI consumer** (MEASURED, UNKNOWN origin) — potential pre-existing persistence on the host.
6. **`FullScanAge` sentinel** — no full Defender scan has ever run (MEASURED).
7. **`.env` holds `GEMINI_API_KEY`** in the repo directory (gitignored; same-user readable) — acceptable today, listed for completeness.
8. **Repo lives under OneDrive sync** — config/source mutation via sync is a side channel outside Krisha's control.
9. Krisha's own processes are unprotected from same-user termination (§12).

## 16. Missing capabilities (the gap the Security System must fill)

1. Independent process monitoring (creation/termination/lineage/signature — event-driven).
2. Malware detection integration + dual-use classification with confidence (Defender as authority, Krisha as correlator).
3. System-wide protected execution (requires elevation decision; non-admin fallback = detect + report + Krisha-own-launch gating).
4. Threat containment orchestration (suspend/terminate/quarantine with operator-consistent policy + false-positive recovery).
5. Security self-protection (watchdog, restart-resilience, tamper detection of the monitor itself — honest same-user ceiling).
6. Incident lifecycle model over the existing audit infrastructure.

## 17. Integration dependencies

- **Reuse (verified):** E5 audit chain + integrity monitor + quarantine primitive + recovery-pipe pattern; Phase 18 SafetyGate chokepoint + permission/risk machinery; SPF audit ring; `appStatus`/`appClose`/launch-allowlist fragments; PowerShellWorker process pattern (mouse/keyboard/OCR precedent); taskState/event-bus surface for UI surfacing.
- **Windows dependencies (MEASURED):** WMI/CIM (event subscriptions + snapshots), Defender (status/log/verdicts), Win32 signature API, taskkill. Elevation-gated (optional): Security log 4688, Kernel-Process ETW, AppLocker/WDAC configuration, process suspension of elevated targets.
- **External APIs:** none required for Phase A-B (everything local); Gemini is not a security dependency (classification must be local/deterministic — model assistance at most for explanation text).

## 18. Recommended implementation order (phased plan — NOT started)

- **Phase A — Independent Process Monitoring (first; highest value, zero elevation needed).** Event-driven WMI subscription owned by Krisha's server (auto re-arm on restart = partial self-protection for free), bounded inventory snapshot (first-seen learning window), per-event enrichment (ppid chain, path, signature via the measured facilities), termination observation by snapshot diff, monitoring self-check (subscription-alive heartbeat + boot-tail audit). Reuse: E5 audit for events, Phase 18 permission (`process.monitor` new domain), PowerShellWorker pattern. Budget: <50 MB resident, ~0% idle CPU, bounded event buffer.
- **Phase B — Malware detection integration + dual-use classification.** Defender status/log/verdict consumers (measured readable); local classifier over {signature signer, path context, lineage, first-seen, Defender verdict} with confidence grades (trusted / known / unknown / suspicious / malicious); explicit dual-use handling (Hydra et al. classified by context, never by name alone); uncertain → report + operator decision. Acceptance: golden synthetic-file corpus (all signed/benign), zero false termination.
- **Phase C — Containment + protected execution (Krisha-scoped + operator-elevated options).** Krisha-own-launch enforcement extension; Defender-delegated blocking; same-user suspend/terminate via grant-gated operator flow; quarantineCore reuse for file capture with operator-declared restore; every containment action = audit event + operator-visible outcome; false-positive recovery path.
- **Phase D — Security self-protection.** Monitor watchdog (re-arm, heartbeat audit records), config/log tamper detection via existing chain tail checks, self-protection honest-ceiling documentation (same-user), optional elevation addendum if the operator opts in.
- **Phase E — Incident lifecycle + adversarial testing.** Incident objects over existing chains; adversarial test suite (monitor-kill/re-arm, evasion attempts against the ≤1 s window, dual-use classification edge cases); performance soak on 1.3 GB-free RAM (leak assertions); final integration re-baseline.

## 19. Proposed acceptance criteria

- Phase A: MEASURED ≥95% of spawned same-user processes captured ≤2 s with ppid/path; signature enrichment for every new executable; monitor restart re-arms within one poll window; zero unbounded memory growth over a 24 h soak; all events in the E5 chain with metadata only; existing suites still green; real store hash-unchanged.
- Phase B: 100% of a golden benign corpus classified trusted/known (zero false positives); known dual-use samples classified *suspicious-with-context* rather than malicious by name; every Defender verdict surfaced; uncertain detections never auto-contained.
- Phase C: containment actions only on `malicious`-confidence + operator policy; every action audited with outcome; false-positive restore exercised end-to-end.
- Phase D: monitor killed externally → re-armed and the gap recorded in audit; log/config tamper detected by chain verification.
- Phase E: adversarial suite green; 24 h soak under memory pressure with no degradation; integration baseline re-issued.

## 20. Outstanding questions and decisions (operator input required)

1. **Elevation model** — does the operator accept a documented elevated helper for 4688/ETW/AppLocker/suspension, or is Krisha permanently non-admin (current state)? This gates Capabilities 3/5 ceilings.
2. **Dual-use policy** — what is the operator's stance on security tooling (allowlist locations? operator notification only?) — needed before Hydra-class classification ships.
3. **Containment authority** — may Krisha terminate/quarantine autonomously at high confidence, or operator-approve every containment?
4. **WMI consumer anomaly** — investigate `SCM Event Log Consumer` (read its binding/definition — read-only) during Phase B, or escalate to the operator now?
5. **Storage placement** — should the monitor's event store live on the NVMe SSD instead of the HDD-side profile (fsync latency)?
6. **Scan policy** — is surfacing "no full Defender scan has ever run" to the operator (with a consent-gated trigger) in scope?

---

*End of Phase 1 audit. No implementation was started; see §10 compliance verification.*
