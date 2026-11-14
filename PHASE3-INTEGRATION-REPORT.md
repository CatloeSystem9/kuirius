# KRISHA — PHASE 3: SYSTEM INTEGRATION AUDIT REPORT

**Date:** 2026-11-14
**Baseline commit:** `3a41d2a4d09d4f2aa42d5f39b22a3ec4a9994fd9` (main, "E5 TO H8 DONE")
**Final verdict:** **INTEGRATION VERIFIED WITH LIMITATIONS**

---

## 1. Verified baseline

| Check | Result |
| --- | --- |
| Previous remediation (E5 H1–H8, M1–M4) | All 12 suites pass; **M1 regression resolved: 86 passed / 0 failed** |
| TypeScript (`tsc --noEmit`) | exit 0, zero errors |
| Production build (`vite build` + esbuild server) | exit 0 (34.6 s; server bundle 303.2 kB; 1.98 MB renderer bundle → 541 kB gzip, chunk-size warning informational) |
| Test isolation | All suites write to `os.tmpdir()` only; production `.krisha/context-cache-v1.json` untouched by test runs (last write 2026-10-07 before any test activity) |
| Production storage protection | Protected E5 store lives at `C:\ProgramData\Krisha\sandbox` (outside the repo, outside every model-writable root); `storageProtection: "full"` |
| Git | Commit recorded above; git CLI not installed on host — state read from `.git` directly; working tree clean at baseline |

No unresolved previous blocker remained, so the audit proceeded.

---

## 2. Subsystem integration map (evidence-based)

**Composition root:** `src/agent/bridge.ts` `createAgentSystem()` — the browser-side runtime; every subsystem attaches to the single `AgentEventBus`; the `ToolRegistry` + Phase 18 `SafetyGate` is the single execution chokepoint.

```
User (App.tsx chat) ──┬─ inline chat path ──► POST /api/chat (Gemini) + memory recall (App.tsx:1444)
                      └─ delegated path (isMultiStepRequest / intent classifiers, App.tsx:826)
                            ▼
   AgentCore.submit (agentCore.ts) ─ plan (HeuristicPlanner ◄ WorkflowAwarePlanner ◄ SkillAwarePlanner)
        │   contextProvider ◄ ContextEngine (USER_MESSAGE → package; memory ◄ MemoryService)
        ▼
   runLoop: deps-check → condition-check → $context resolution → ToolRegistry.execute
        │                                     │
        │                                     ├─ SafetyGate.evaluate (risk → stop → permissions → audit)
        │                                     └─ tool → backend → local server route
        ├─ failure → RecoveryManager (classify → policy → strategy) / PlanEngine bounded replan
        ├─ terminal → finalizeTask verification (pass/uncertain/fail) → honest summary
        ▼
   Events: TASK_* / TOOL_* on the bus → Learning, Skills, Goals, KnowledgeGraph, Consolidation,
   Multimodal, Proactive, LongRun, Diagnostics, PerformanceTelemetry (all event-driven, no polling)
        ▼
   UiEffects (TASK_STEP_COMPLETED) → App.tsx action cards / modals / screen-vision panel
```

**Server side (`server.ts` + `serverSafety.ts` + `systemAgentServer.ts`):** 45+ routes (chat, tts, transcribe, maps, vision, computer mouse/keyboard, browser CDP ×9, research ×2, fs ×10, apps ×5, safety stop GET/activate, integrity, rollback ×5, quarantine ×3). Emergency stop is **server-authoritative**: `stop-state.json` with integrity self-hash under `C:\ProgramData\Krisha\sandbox`, generation counter, HTTP 423 enforcement on side-effecting routes, recovery exclusively via named pipe `\\.\pipe\krisha-e5-recovery` + operator credential (nonce-replay-protected). Audit chain is hash-sequenced (21+ entries verified by M1).

**Frontend↔backend endpoint cross-check:** every `fetch('/api/…')` in `src/` resolves to an existing server route (verified mechanically: 30 call sites, plus dynamic-template backends `/api/browser/{state,navigate,click,type,scroll,tabs,back,forward,refresh}`, `/api/research/{search,fetch}`, `/api/computer/{mouse,keyboard}`, `/api/vision/analyze`). **No orphan client calls, no orphan routes.**

**Event contract:** 120+ typed event names in `events.ts`; emitter/consumer pairs verified for the core lifecycle (TASK_STARTED/PLANNED/STEP_*/COMPLETED/FAILED/CANCELLED, TOOL_*, RECOVERY_*, SCREEN_OBSERVED). The workflow suite asserts the exact emission of lifecycle events per workflow.

---

## 3. Workflow verification matrix (execution evidence, isolated environments)

New suite: `scripts/test-phase3-workflows.ts` — real modules, real loopback HTTP stubs, real disk I/O in a tmpdir sandbox, MemoryStorage/file-backed adapters. **114/114 assertions pass.**

| WF | Path | Evidence (highlights) | Result |
| --- | --- | --- | --- |
| A | request → core → planning → execution → response | Real `HeuristicPlanner` produced `filesystem.list`+`filesystem.read`; both executed with verification; tool-grounded summary; audit records present; verification `pass` | ✅ |
| B | request → context retrieval → persistent memory → response | USER_MESSAGE → ContextEngine package carries memory; task receives `memoryContext`; restart over file-backed adapter recalls the fact | ✅ (after Defect 2 fix) |
| C | task creation → persistence → execution → completion | TaskStore `krisha_agent_tasks_v1` survives restart; mid-flight `running` → `interrupted` on reload | ✅ |
| D | permission → safety validation → tool execution → audit | Deny (permission_denied, non-retryable, audited) → grant → execute (real disk) → scoped once-grant consumed → expired grant denied → revocation kill-switch → unknown-permission fail-closed | ✅ |
| E | browser request → controller → result → response | `HttpBrowserBackend` contract over real loopback HTTP; HTTP 500 → structured failure; unreachable → `unreachable` mapping; dead-backend browser task **fails honestly** | ✅ |
| F | screen observation → vision analysis → host payload | Default-deny enforced; `getCurrentState` → `SCREEN_OBSERVED` payload → bridge handler contract (summary/texts/elements/timestamp) as App.tsx renders it | ✅ |
| G | research → retrieval → verification → response | `research.run` through the gate with injected-fetch backend; lifecycle events; low-evidence → honest low-confidence/insufficient-evidence | ✅ |
| H | emergency stop → prevention → persistence → authorized recovery | Stop during in-flight task → task cancelled; new side effects blocked (reason mentions stop); temp grants revoked; read-only continues; POST `/api/safety/stop/activate` persisted; hydration fail-closed; deactivation restores operation — **re-verified live against the real server** (HTTP 423 enforcement; pipe set-credential → recover; ×2) | ✅ |
| I | interrupted task → restart → recovery classification | Pause mid-step → `interrupted`, `completedAt` unset; resume of cancelled rejected; resume re-runs interrupted step, keeps completed ones, `TASK_RESUMED`, verification `pass` | ✅ |
| J | invalid/unauthorized → rejection → audit | Unknown tool `not_found`; invalid input `invalid_input` (authorized) vs `permission_denied` precedence (unauthorized, fail-closed order); audit carries input **keys only**; task degrades honestly | ✅ |
| K | regression: recovery retry schema-validity | Missing target → RE_RESOLVE_TARGET → retry input stays schema-valid; original cause not masked | ✅ (new) |
| L | failure propagation | Core-wrapper timeout (150 ms tool → `timeout` kind, honest fail); 2 concurrent tasks isolated; corrupted task/memory stores start clean; fresh grants don't bypass an active stop | ✅ (new) |

Live-server replication of H additionally verified: activate → `423 emergency_stop_active` on `/api/fs/delete` → operator set-credential → recover → same delete succeeds (200, quarantined per E5 M3 design).

---

## 4. Confirmed integration defects & root-cause analysis (all fixed)

### Defect 1 — Recovery strategy sabotaged its own retry (cross-subsystem)
- **Symptom:** after a target-not-found failure (`ENOENT`), recovery selected `RE_RESOLVE_TARGET` and re-ran the step — every retry failed with `Invalid input for "…": Unexpected input "_targetReResolved"`, masking the original error and failing the task.
- **Root cause:** `src/agent/recovery/recoveryStrategies.ts:187` injected a `_targetReResolved: true` marker into `modifiedInput`; `ToolRegistry.validateInvocation` rejects any undeclared key ("catch malformed requests early"). Recovery (Phase 11) and Registry (Phase 3) disagreed about the input contract; the marker was read by nothing.
- **Fix:** return `{ ...step.input }` (clean copy) + comment documenting the contract. Regression: suite section K.

### Defect 2 — Memory-referential questions never reached the memory source
- **Symptom:** "where is the staging deploy key kept?" produced `needsMemory=false` → memory source skipped → agent tasks got no memory context, while the chat path (`App.tsx:1454`) always recalls.
- **Root cause:** `contextAnalyzer.ts` gated memory retrieval on a narrow `MEMORY_PATTERNS` list ("remember", "my favorite", …); topic-referential questions didn't match.
- **Fix:** `intent === 'question'` also enables the memory source; the relevance ranker (not the intent gate) decides what is actually relevant. Bounded cost: one in-memory recall pass. Regression: suite section B.

### Defect 3 — Emergency stop had zero UI surface (mission §6 gap)
- **Symptom:** no control, indicator, or recovery-status surface anywhere in the frontend (grep across `src/App.tsx`, `src/components/*` found nothing). An operator could not see or trigger the stop from the app; §6's "Emergency-stop status visibility / Recovery status visibility" was unverifiable because the surfaces did not exist.
- **Root cause:** Phase 18 built the backend + recovery CLI; the renderer integration was never built (E5 correctly removed the privileged global, leaving no UI path).
- **Fix (guarantee-preserving):** header status pill in `App.tsx` — shows `⏹ EMERGENCY STOP ACTIVE (gen N)` (server state, refreshed on click) and an **activate** action (confirm dialog → local `emergencyStopNow` + server POST). **No deactivation** in the UI — recovery remains operator-CLI-only, per E5 M1c. Verified live: activate → gen 20 shown; reload → hydrated ACTIVE shown; CLI recovery → click → cleared.

### Defect 4 — Model-initiated web actions bypassed the gate during an active stop
- **Symptom (reproduced live):** with the stop ACTIVE (gen 11), a chat reply's `data.webAction` opened external URLs (`example.com`, `example.org`) — an external side effect outside the Phase 18 chokepoint (the inline chat path never passes the gate).
- **Root cause:** the inline chat flow predates Phase 18; only `ToolRegistry` executions are gated.
- **Fix:** `openExternalUrlIfNotStopped()` in `App.tsx` — model-initiated opens consult the local hydrated stop state and the authoritative server state before opening; user-typed opens are the operator's own action and remain available. An unreachable server does not break ordinary chat (local gate verdict still applies).

### Non-defect observations (recorded, no action)
- Gate order: permission coverage precedes input validation on unauthorized tools (fail-closed, safer than the registry header's prose — header updated wording not required; behavior asserted in section J).
- E5 M1 cannot run while a dev server holds the recovery pipe (global pipe path, no env override): the suite's pipe traffic then reaches the live server. Test-discipline constraint, not a product bug — all E5 suites pass with no live server running (final battery below). Two audit-time collision runs advanced the live `stop-state.json` generation counter (final state INACTIVE, gen 22) — reported for transparency.
- Submits during `isLoading` are silently dropped (input not disabled) — minor UX note, not a safety issue.
- Single-clause "open X" requests go to inline chat, not the agent (delegation requires multi-step/intent match) — by-design conservatism.
- Pre-existing repo-root junk files from an earlier botched write (`({`, `console.log('`, `rb.executeRollback({`, `s.taskId`, `sys.fsCreate(path.join(fsRoots`) — flagged for manual cleanup, not touched by this audit.

---

## 5. Files modified

| File | Change |
| --- | --- |
| `src/agent/recovery/recoveryStrategies.ts` | Defect 1 fix (clean retry input) |
| `src/agent/context/contextAnalyzer.ts` | Defect 2 fix (questions reach memory source) |
| `src/App.tsx` | Defects 3+4: stop-status pill + activation, `openExternalUrlIfNotStopped`, `useCallback` import |
| `scripts/test-phase3-workflows.ts` | **New** — 114-assertion workflow/regression suite (sections A–L) |

No server, safety, permission, or cancellation logic weakened. No tests weakened to pass.

## 6. Regression tests added
`scripts/test-phase3-workflows.ts` — A–J workflow sections plus K (defect-1 regression), B (defect-2 coverage), H/L4 (defect-3/4 guardrails: fresh grants don't bypass an active stop; gate precedence), L (timeout/concurrency/corruption). Exit 1 on failure; final line prints counts.

## 7. Performance measurements

| Metric | Measurement |
| --- | --- |
| Production server startup (`node dist/server.cjs` → health 200) | **89 ms** |
| Dev server startup (tsx + vite middleware) | ~20–28 s (cold transform; first page load ~27 s, warm ~5 s) |
| GET `/api/health` / `/api/safety/stop` / `/api/integrity/status` | p50 ≈ 2.9–3.0 ms, p95 ≤ 6.9 ms (n=30/30/15) |
| POST `/api/fs/list` (39-entry repo root) | p50 73 ms, p95 779 ms (OneDrive-synced path amplifies tail) |
| POST `/api/research/search` | 25 ms–1.6 s (real outbound network; error path bounded) |
| Server idle CPU (30 s window) | **0.14 %** — fully event-driven, no polling loops |
| Server memory (dev) | 87–140 MB working set (tsx + vite) |
| Renderer bundle | 1.98 MB minified / 541 kB gzip (chunk-size warning only) |
| Persistent storage ops | write-through on task mutation, bounded (50-task cap, 21-entry audit tail) |

No optimization was performed (nothing met the bar; measurements recorded for regression tracking).

## 8. Frontend/backend verification (actual application, live UI)

Executed against the real dev server with browser automation (headless Chromium; screenshots in `.audit-tmp/gui-screens/` and webcmd artifact cache). Console-error capture was not available in the runtime; visible page state was used as the error surface.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| T1 | App renders (avatar, nav, chat bar) | ✅ | t1_initial.png |
| T2 | Local greeting round trip | ✅ reply bubble + voice replay | t2_greeting_reply.png |
| T3 | `/api/chat` model round trip | ✅ HTTP 200, correct reply "4" | t3_chat_reply.png |
| T4 | Agent delegation (multi-step fs task) | ✅ no chat call; 2 steps completed; honest tool-grounded summary; TaskStore persisted | t4_agent_summary.png |
| T5 | Stop enforcement + recovery (live) | ✅ client gate denial surfaces in UI; server 423 while stopped; delete succeeds after authorized recovery | t5a/t5d screenshots |
| T6 | Memory panel + restart hydration | ✅ task outcomes, learned skill, preferences render; no stale stop state after recovery | t6_memory_panel.png |
| T7 | Screen Vision error surface | ✅ honest "choose the window…" prompt; no fabricated success | t7_screen_vision.png |
| T8 | **New** stop pill: activate / hydrated reload / recovery refresh | ✅ gen 20 shown; hydration shows ACTIVE; cleared after CLI recovery + refresh | t8a–t8d screenshots |

## 9. Remaining limitations

1. Stop-status UI is fetch-on-mount / on-click (no push channel); a stop activated elsewhere is visible after reload or pill click, not instantly.
2. E5 suites and a live server cannot share the recovery pipe (single global path); E5 batteries must run server-free.
3. Emergency-stop UI covers visibility + activation only; recovery is intentionally CLI-only (E5 M1c design).
4. Heuristic planner is conservative: file-creation phrasings route to `system.note` (not executable); single-clause browser requests stay in chat.
5. Renderer bundle exceeds the 500 kB chunk guideline (warning only).
6. Host limitations: git CLI absent (repo state read from `.git`); in-app browser pane unavailable (headless Chromium used for UI evidence); webcmd console-log capture unavailable (visible page state used).
7. Live `stop-state.json` generation counter advanced during audit testing (final INACTIVE, gen 22) — durable-stop counters are monotonic by design.

## 10. Final executed test counts (this audit)

| Suite | Result |
| --- | --- |
| `tsc --noEmit` | 0 errors |
| `npm run build` | exit 0 |
| E5 H1–H8 + M1–M4 (final battery) | **723 passed / 0 failed** (39+55+46+70+56+50+36+57+86+74+72+82) |
| `test-phase3-workflows.ts` (new) | **114 passed / 0 failed** |
| recovery-phase11 / agent-core / context-engine / planning-phase16 / goal-continuity | 83 / 49 / 98 / 102 / 163 — all 0 failed |
| Live UI test points T1–T8 | 8/8 pass with screenshot evidence |
| **Total executed assertions** | **≈ 1,332 automated + 8 manual UI points** |

No tests were blocked or unavailable; browser-vision capture (real getDisplayMedia) was not executable in a headless environment and was verified for honest error behavior instead.

---

## Final verdict

**INTEGRATION VERIFIED WITH LIMITATIONS.**

Every major subsystem boundary was reviewed; every claimed workflow (A–J) has execution evidence; four confirmed integration defects were found, root-caused, minimally fixed, and regression-tested without weakening any safety guarantee; the complete final battery (≈1,332 assertions) is green; the frontend/backend integration was verified against the running application with screenshot evidence. The limitations above are documented, bounded, and none blocks the verified workflows.
