# Krisha — Targeted Repair Report: E5-M1 Recovery-Pipe Contention + TypeScript API Mismatch

**Date:** 2026-11-22
**Scope:** two targeted repairs documented in `SECURITY-SYSTEM-PHASE-E-REPORT.md`; no Phase E redesign, no Phase F, no security-boundary changes.
**Baseline authority:** `SECURITY-INTEGRATION-BASELINE.md`.

---

## 1. Issue 1 — E5-M1 global recovery-pipe contention

### 1.1 Root cause (independently verified — the initial diagnosis was incomplete)

The prior diagnosis ("the live application owns the pipe") was **correct but incomplete**. Source inspection established the full mechanism:

1. **Every** process importing `serverSafety` binds the recovery pipe **at module load** (`serverSafety.ts:1339` calls `startRecoveryPipe()`). That includes the live application, every E5/LPV/security test runner, and every spawned test server — all racing for ONE global name (`\\.\pipe\krisha-e5-recovery`).
2. **The bind result is asynchronous**: `server.listen()` does not throw synchronously on a Windows named-pipe name collision; `EADDRINUSE` arrives later via the `'error'` event. `recoveryAvailable` is set `true` optimistically immediately after `listen()` — so M1's skip guard (`const PIPE_OK = stopSnapshot().recoveryAvailable`) reads `true` even when the bind is about to fail.
3. **When the suite loses the race, its pipe client reaches the FOREIGN authority**: the test connected to the global pipe and its arm/recover requests were answered by the live application's state machine. Evidence: ownership probe on the global pipe returned `generation=40, storageProtection=full` (the live store) while a fresh M1 store reports generation 1–2; the failing assertion `pipe arm reached the server state machine (kind: INACTIVE)` shows the LOCAL state machine was correctly untouched while the FOREIGN one was armed. This is the same mechanism that caused the live-store generation drift documented in D.3 (34→38) and D.4 (38→40).

**Classification: incorrect test isolation** (production recovery logic functions correctly — bind failure is fail-closed and surfaced; one recovery authority per store; nonce replay protection and connection caps intact).

### 1.2 Exact reproduction

| Environment | Result | Evidence |
|---|---|---|
| Pipe owned by the live app (during regression) | **85/1** — `EADDRINUSE` logged; `pipe arm activates a credentialed stop` PASSED (foreign server answered); `pipe arm reached the server state machine` FAILED (local machine untouched) | captured in D.3/D.4/E campaigns and re-run for this repair |
| Pipe unowned (no live-app contention) | 86/0 (fresh store, gen 1) | Phase D.3-era runs |
| Ownership probe during failure | responder `generation=40, storageProtection=full` = the live application | `scripts/probe-pipe-owner.ts` |

### 1.3 Correction (smallest safe — test ownership and isolation)

The production recovery mechanism is functioning correctly, so the correction targets test ownership only:

1. **`serverSafety.ts`** — the pipe transport path honors `KRISHA_RECOVERY_PIPE_PATH` (trimmed); the default remains exactly `\\.\pipe\krisha-e5-recovery`. The recovery AUTHORITY is unchanged (this process's own stop-state machine; the pipe is only its transport — one authority per store, no second authority, no fallback path, no weakened authentication).
2. **`scripts/test-e5-m1.ts`** — binds `\\.\pipe\krisha-e5-recovery-m1-<pid>` before the dynamic `serverSafety` import, so the suite ALWAYS owns its own transport and the pipe assertions run for real (never skipped) in every environment. Added an **ownership precheck**: the pipe responder's reported generation must equal the LOCAL `stopSnapshot().generation` before any assertion runs — a foreign authority is refused with a precise reason (defense against any future collision).
3. **`scripts/test-isolation.ts`** — every runner process importing it now binds its own pipe (`...-iso-<pid>`), so security suites never race (or starve) the live application's recovery endpoint.
4. **`scripts/test-containment.ts`, `scripts/test-security-intel.ts`** — spawned test servers receive their own pipe name in their spawn env.
5. **`scripts/probe-pipe-owner.ts`** (new diagnostic, kept) — one-shot read-only ownership probe with a fresh nonce per run.

Not done (explicitly): no second recovery authority; no concurrent-recovery relaxation; no fallback recovery path; no assertion skipped — the assertions now run against the suite's own authority and pass.

### 1.4 Verification (exact before/after)

| Check | Before fix | After fix |
|---|---|---|
| M1 with the live application running | 85/1 (foreign authority answered) | **87/0** — `pipe ownership verified (responder generation 1 matches this suite's state machine)`; all pipe assertions ran |
| M1 repeat run (stale-ownership detection) | nondeterministic | **87/0** again — each fresh process binds its own pipe; no stale ownership |
| Live application's stop-state machine after M1 runs | drifted (34→38→40 across campaigns — the suite armed/resumed the live authority) | **generation unchanged at 40** — the suite no longer touches it |
| Live application health | operational | operational (`/api/health` → 200) |
| Unauthorized recovery | refused (nonce replay, wrong credential) | still refused — M1 asserts `pipe recover with wrong credential refused` and `nonce replay rejected` against its own authority; the production pipe's protections are untouched |

Note on the "controlled application shutdown and restart" check: repeated fresh-process M1 runs (each binding, verifying ownership, and exiting cleanly) cover the stale-ownership concern; the operator's live application was deliberately left running and untouched — restarting it is the operator's call, and the fix makes the suite independent of who owns the production pipe.

## 2. Issue 2 — Background Presence TypeScript API mismatch

### 2.1 Evidence established (no assumptions)

- **Git**: both files are **untracked** (`git status` → `??`) with no history — the working tree is the only state; both sides are the user's in-progress Step 3/4 work (created 07:26/08:22/08:31 during this session).
- **The mismatch as it existed** (23 errors): the test called `h.flush()` (Harness type declaration lagging the harness implementation) and destructured `generate({ inactivityMinutes, signal })` with `AbortSignal`-based cancellation, while the then-current service draft exposed `{ inactivityMinutes, aborted: boolean }` (flag-based) — a mid-edit API divergence between the two halves of the same workstream.
- **The implementation side** (`src/utils/proactiveConversation.ts`, Step 4 service) was the authoritative target API: its documentation mandates AbortSignal-based cancellation ("honor the AbortSignal (cancellation must abort in-flight requests)").

### 2.2 Resolution — resolved by the user's own concurrent work; zero edits made

While Issue 1 was being repaired, the user **completed the service** (08:22: `generate: (ctx: { inactivityMinutes: number; signal: AbortSignal })` with an internal `AbortController`; `stopNow`/cancellation abort it) and **updated the test harness** (08:35: `flush` declared on `Harness`). At that point:

- `npx tsc --noEmit` reports **zero errors repository-wide**.
- The Proactive Conversations suite runs against the REAL Step 3 tracker + Step 4 service and passes **78/0** — validating actual behavior (threshold initiation, single attempt per period, [SILENT] decisions, abort-on-user-interaction via the real `AbortSignal`, `stopNow` aborts, quiet hours, minimum interval, sleep/wake staleness, server-loss cancellation, resource discipline), not merely compilation.

Per the task's own rule (do not guess at unfinished user work), **no edits were made to either file by this repair**. Both sides of the user's work are preserved as-is.

### 2.3 Verification

| Suite | Result |
|---|---|
| Conversational Silence Detection (Step 3) | 54 / 0 |
| Proactive Conversations (Step 4) | 78 / 0 (first run and rerun) |
| Background Runtime (Step 1) | 35 / 0 |
| **Background Voice (Step 2)** | **HANGS** — see limitations |

## 3. Change inventory

| File | Change | Why |
|---|---|---|
| `serverSafety.ts` | `RECOVERY_PIPE_PATH` honors `KRISHA_RECOVERY_PIPE_PATH`; default byte-identical | transport-level test isolation; production behavior unchanged |
| `scripts/test-e5-m1.ts` | unique pipe path before import; ownership precheck; pipe section restructured under the precheck | the suite must own its transport and verify the responder is its own authority |
| `scripts/test-isolation.ts` | unique `KRISHA_RECOVERY_PIPE_PATH` for every importing runner | stop all security suites from racing the live app's recovery endpoint |
| `scripts/test-containment.ts` | spawned server env gains a unique pipe name | same isolation for spawned servers |
| `scripts/test-security-intel.ts` | spawned server env gains a unique pipe name | same isolation for spawned servers |
| `scripts/probe-pipe-owner.ts` | NEW — read-only pipe ownership diagnostic (fresh nonce per run) | reproduces/verifies pipe ownership; kept as a diagnostic utility |
| `scripts/test-proactive-conversations.ts`, `src/utils/conversationInactivity.ts`, `src/utils/proactiveConversation.ts` | **NOT modified** | the mismatch resolved via the user's own concurrent edits; verified behaviorally |

## 4. Before-and-after regression results (first run / rerun)

| Suite | First run | Rerun |
|---|---|---|
| Phase E security intelligence | 110 / 0 | 110 / 0 |
| **E5-M1** | **87 / 0** (ownership verified) | **87 / 0** |
| Containment D.3/D.4 | 114 / 0 | 114 / 0 |
| Execution gate (C) | 41 / 0 | 41 / 0 |
| Process monitor (A) | 66 / 0 | 66 / 0 |
| Malware detection (B) | 98 / 0 | 98 / 0 |
| SPF text | 220 / 0 | 220 / 0 |
| SPF visual | 113 / 0 | 113 / 0 |
| LPV core / security / perf | 92 / 55 / 11 — 0 failed | same |
| E5 M2 / M3 / H4 | 74 / 72 / 70 — 0 failed | same |
| Background Runtime (Step 1) | 35 / 0 | 35 / 0 |
| Background Voice (Step 2) | **HANGS** (no output; stopped after 3+ min twice) | not rerun (unchanged user WIP) |
| Conversational Silence Detection (Step 3) | 54 / 0 | 54 / 0 |
| Proactive Conversations (Step 4) | 78 / 0 | 78 / 0 |
| `tsc --noEmit` | **0 errors** | **0 errors** |

The one non-passing item is the **Background Voice suite hang** — the user's concurrent Step 2 WIP (untracked file, mid-development); it produces no output at all (an unresolved await in the fake-audio chain, by the file's own structure). It is outside this repair's named scope and was left untouched; it does not affect any security system.

## 5. E5 integrity (before/after this repair campaign)

| File | Before | After | Verdict |
|---|---|---|---|
| install.marker | 45 B, `000FA71A` | identical | byte-identical |
| stop-state.json | 225 B, `5512237F`, gen 40 | 225 B, `5512237F`, gen 40 | **byte-identical** — the pipe fix eliminated the cross-campaign generation drift |
| audit/server-audit.jsonl | 1,311,546 B, `9B1397DC`, 5353 lines | 1,390,467 B, `1DE167F9`, 5682 lines | expected metadata-only growth (live UI traffic) |
| quarantine (2 files) | `91555D75` / `6124A833` | identical | byte-identical |
| sandbox-journal | 4477 B, `44BA7705` | identical | byte-identical |
| Recovery generation / stop state | INACTIVE, no credential, gen 40 | INACTIVE, no credential, gen 40 | unchanged (and this time not merely semantically equal — byte-identical) |
| Real-store `threat_containment` records | 0 | **0** | termination has never touched the real store |

## 6. Security verification

- **Production termination remains disabled and unreachable** — containment suite (114/0, both passes) asserts `APPROVAL_AUTHORITY_UNAVAILABLE` on the production routes; no new termination route exists.
- **Approval authority remains fail-closed** — `verifyApprovalAuthority` wiring untouched; approval route still refuses (`7h`/runtime assertions green).
- **No bypass introduced** — the pipe change is transport-only for isolated stores; the recovery CLI and production default are byte-for-byte unchanged; no fallback recovery path exists.
- **E-stop remains authoritative** — M1's stop-state machine tests (armed/recovered via the pipe with credential checks) pass against the suite's own authority; enforcement semantics unchanged.
- **No unauthorized recovery or containment operation is possible** — recovery still requires the credential (wrong-credential refusal asserted); nonce replay protection asserted; the ownership precheck guarantees tests can never again act on a foreign authority.
- **The live application remained operational throughout** (`/api/health` → 200 before and after).

## 7. Remaining limitations

1. **Background Voice suite hangs** — user's concurrent Step 2 WIP (untracked, mid-development); unresolved await in the fake-audio chain; outside this repair's scope.
2. Other in-process suites that import `serverSafety` directly without `test-isolation.ts` (e.g., E5-M2) still log a benign fail-closed `EADDRINUSE` when they lose the bind race — harmless (no pipe tests there), but they could adopt the same one-line isolation for cleaner logs.
3. `scripts/probe-pipe-owner.ts` is a new diagnostic utility (read-only); it is not wired into any suite.
4. The live application is currently running with the stock pipe name; when it is next restarted it will re-bind cleanly — no action needed.

**Both issues are resolved within their stated boundaries. Phase E remains accepted. Phase F has not been started.**
