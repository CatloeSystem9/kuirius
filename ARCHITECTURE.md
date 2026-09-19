# Krisha — Architecture Audit (Phase 0) & Agent Integration Map

> Written 2026-09-12 as part of the phased roadmap (Phase 0). Nothing in this document
> changes behavior; it records what exists, what is reusable, and where new agent
> subsystems attach. The UI is intentionally untouched.

## 1. Current stack

| Layer | Tech |
|---|---|
| Frontend | React 19 + Vite 6, Tailwind v4, motion (Framer), lucide icons |
| Backend | Express (single `server.ts`), Gemini via `@google/genai` |
| Persistence | localStorage (settings/memories/conversations/location), IndexedDB (file index) |
| Voice | Gemini TTS server endpoint → Web Speech fallback; SpeechRecognition wake-word |
| Platform target | Browser SPA served by Express (port 3000); AI Studio deployment metadata |

## 2. Existing AI / model integration

- `server.ts` — `/api/chat`: Gemini chat with a 3-model waterfall
  (`gemini-3.7-flash` → `gemini-flash-latest` → `gemini-3.1-flash-lite`),
  backoff retry on 429/503/quota, and an in-character local fallback generator when
  all models are exhausted.
- `server.ts` — `/api/memory/extract`: heuristic fact regexes (zero-latency) + LLM
  extraction with a 2-minute cooldown after quota failures.
- `server.ts` — `/api/tts`: Gemini TTS (`gemini-3.1-flash-tts-preview`) with quota
  cooldown; returns `{fallback:true}` so the client uses browser speech.
- Client-side "intelligence" is heuristic only: `sentimentEngine.ts` keyword rules,
  regex intent detectors in `webActions.ts` / `appLauncher.ts` / `fileSystemAccess.ts`
  / `locationService.ts`.

## 3. Existing functionality inventory

### Working features (must be preserved)
1. **Chat + persona**: emotion-tagged replies (`[emotion:...]` parsed server-side),
   client sentiment merge, avatar expressions/gestures, conversation history UI.
2. **Voice**: wake word ("Krisha"/variants) with debounce + self-mute while speaking,
   chime, TTS with lip-sync callbacks.
3. **Web actions**: 14-platform registry, search/open intent parsing, external URL
   opening with anchor fallback, WebBrowserModal launcher.
4. **App launching**: 30+ preset apps via OS protocol schemes (`vscode://`,
   `spotify:`, `ms-calculator:`…), custom user apps, launch + list + search.
5. **Files**: File System Access API folder scan (depth 6), IndexedDB index with
   preview text for plain-text files, search by name/folder/extension/content,
   open in new tab / download. PDFs are opened, never read (explicit product rule).
6. **Location**: GPS-first priority chain (browser GPS → GMP geocoding → Nominatim →
   IP fallback), 15-min verified cache, IP-guess rejection, location statement
   parsing ("I am in Pune").
7. **Avatar theatrics**: dance/greet/thank/look-direction commands, parallax,
   draggable avatar, pose video clips.
8. **Server resilience**: model waterfall, TTS/memory cooldowns, geocode fallbacks.

### Missing capabilities (roadmap targets)
- No task abstraction — every message is one-shot; "open X, then do Y" cannot be
  represented internally.
- No tool abstraction — execution is inline in `App.tsx`.
- No event system, no cancellation, no client-side timeout/retry.
- No verification after actions (fire-and-forget `window.open`).
- Memory is a flat `string[]`; no importance, dedup beyond `Set`, conflicts, or
  categories. No episodic/workflow/correction memory.
- No screen observation, no camera, no mouse/keyboard control (Phases 4–7).
- No permission model beyond implicit browser prompts (Phase 18).

## 4. Reusable components (audit verdict: reuse, don't rewrite)

| Module | Reuse as |
|---|---|
| `src/utils/webActions.ts` (pure parse fns + platform registry) | future `browser` / `web.open` tool |
| `src/utils/appLauncher.ts` | future `app.launch` / `app.list` tool |
| `src/utils/fileSystemAccess.ts` | future `files.search` / `files.open` tool |
| `src/utils/locationService.ts` | future `location.get` tool |
| `src/utils/audio.ts`, `wakeWordListener.ts` | voice I/O channel of the agent |
| `src/utils/sentimentEngine.ts` | response shaping layer |
| `src/utils/storage.ts` | persistence primitives (agent adds its own keys) |
| `server.ts` chat pipeline | seed of the future model-routing layer (Phase 17) |
| All 15 components | **untouched**; agent drives them via existing props/state |

## 5. Architectural weaknesses

1. `App.tsx:handleSendMessage` (~430 lines) tangles intent detection, execution,
   chat, and state updates. Single biggest refactoring pressure point.
2. Duplicated logic: `extractServerWebAction` in `server.ts` duplicates
   `webActions.ts` (client copy is richer — drift risk).
3. Intents are mutually exclusive by accident; a sentence containing both an app
   launch and a web search executes partially (first detector wins inline, both
   cards may render, but sequencing is not guaranteed).
4. No honest verification: `launchLaptopApp` returns success whenever the anchor
   click doesn't throw, regardless of whether the OS handled the protocol.
5. Memory extraction appends without checking duplicates/conflicts properly.
6. `App.tsx` re-renders whole tree on every keystroke emotion change (minor perf).

## 6. Dependency map (existing)

```
main.tsx ─> App.tsx ─┬─> components/* (KrishaAvatar, SidebarNav, modals, cards, DirectChatInput)
                     ├─> utils/storage.ts          (localStorage)
                     ├─> utils/audio.ts            (/api/tts, Web Speech)
                     ├─> utils/sentimentEngine.ts
                     ├─> utils/webActions.ts       (window.open)
                     ├─> utils/appLauncher.ts      (protocol anchors, localStorage)
                     ├─> utils/fileSystemAccess.ts (IndexedDB, FS Access API)
                     ├─> utils/locationService.ts  (geolocation, /api/location/geocode, localStorage)
                     └─> utils/wakeWordListener.ts (SpeechRecognition)

server.ts ─┬─ /api/chat            ─> Gemini waterfall ─> (fallback) local generator
           ├─ /api/memory/extract   ─> heuristics + Gemini
           ├─ /api/tts              ─> Gemini TTS
           ├─ /api/location/geocode ─> GMP ─> Nominatim ─> direct coords
           └─ static /assets/videos ─> avatar pose clips
```

## 7. Agent system integration map (where new subsystems attach)

```
                     ┌──────────────────────────────────────────────┐
 USER MESSAGE ──────>│ App.tsx (unchanged UI, thin delegation hook) │
                     └──────┬───────────────────────────┬───────────┘
                            │ single-step (existing)    │ multi-step → delegate
                            ▼                           ▼
                     existing inline flow        src/agent/agentCore.ts
                                                 INPUT→GOAL→PLAN→TOOL→RESULT→VERIFY→NEXT
                                                 (cancel / timeout / retry / events / state)
                                                     │                ▲
                                     toolRegistry.ts │                │ events.ts
                                     (register tools)│                │ (TASK_*, TOOL_*)
                                                     ▼                │
                                         tools wrapping existing utils│
                                         webActions / appLauncher /   │
                                         fileSystemAccess / location /│
                                         memory / chat.respond        │
                                                          taskState.ts│ (persist/resume)
```

- `src/agent/*` is a **pure TypeScript layer** (no React, no DOM at core level) so it
  is unit-testable under Node/tsx. Browser-backed tools are registered from App.tsx;
  tests register mock tools against the same registry interface.
- **Phase 2 (memory)** lives in `src/agent/memory/` — see §8.
- **Phase 3 (tool system)** upgrades the registry/selector/contract — see §9.
- **Phase 4 (screen vision)** lives in `src/agent/vision/` — see §10.
- **Phase 5 (mouse control)** lives in `src/agent/computer/` — see §11.
- **Phase 6 (keyboard control)** extends `src/agent/computer/` — see §12.
- **Phase 7 (computer-use agent)** lives in `src/agent/computerUse/` — see §13.
- **Phase 8 (browser agent)** lives in `src/agent/browser/` + `browserCdp.ts` — see §14.
- **Phase 9 (filesystem/application agent)** lives in `src/agent/system/` + `systemAgentServer.ts` — see §15.
- Phase 10+ (multi-step autonomy) will combine the orchestrator loops through
  the same registry/planner.
- Phase 17 (model routing) will generalize `generateContentWithFallback` in server.ts
  and own vision-provider escalation.

## 8. Memory architecture (Phase 2)

```
Agent Core events (USER_MESSAGE / TASK_COMPLETED / TASK_FAILED)
        │
        ▼
memoryBridge.ts ──── correction learning, relevance recall (task.memoryContext),
        │             episodic + workflow upsert after tasks
        ▼
MemoryService ── remember / recall / search / update / merge / forget /
        │         invalidate / detectConflicts / rankRelevance
        ▼
MemoryStore ──── schema-versioned envelope (krisha_agent_memory_v2),
        │         validation + repair + legacy v1 migration, 400-record cap
        ▼
StorageAdapter ── localStorage (browser) | MemoryStorage (tests)
        │
        └── write-through mirror into legacy krisha_memories_v1 string[]
            → existing MemoryModal + /api/chat prompt keep working unchanged
```

- `MemoryRecord`: id, category (short_term/long_term/preference/episodic/workflow/
  correction/semantic), content, timestamps, importance, confidence, source,
  usage tracking, valid/supersededBy, metadata (workflow: steps/tools/trigger/
  successCount/lastSuccessfulAt).
- Duplicate detection: normalization + synonym folding + Jaccard/containment
  similarity (threshold 0.62) → merge instead of insert.
- Conflict handling: preference triples (prefer/avoid/use/never-use over the same
  subject/object). Authoritative or stronger new memory **supersedes** the old one;
  low-confidence contradictions keep both records, flag `conflicted`, and register
  a conflict entry — no silent winner.
- Retrieval is relevance-ranked (token overlap, importance, confidence, 14-day
  recency half-life, usage) with category filters and hard limits; `/api/chat`
  now receives recalled memories per message instead of the whole list.
- Secrets (API keys, tokens, private keys, passwords) are never stored;
  conversational noise is filtered by worth-assessment.

## 9. Tool system (Phase 3)

```
Agent Core (capability on each PlanStep)
        │  TOOL_SELECTED (selector ranks candidates: cost → risk → reliability)
        ▼
ToolRegistry.execute() ── permission check → input-schema validation → execute()
        │                  normalization: toolId / errorKind / retryable /
        │                 timestamp / durationMs; never throws
        ▼
ToolResult (structured) → core VERIFY (step override → tool strategy → tool_success)
        │                 TOOL_VERIFIED / TOOL_RETRIED / TOOL_CANCELLED events
        ▼
Agent Core continues (retry with backoff, alternative plan, or honest failure)
```

- **Contract** (`AgentTool`): name(id), description, category, capabilities,
  permissions, inputSchema (required/types/validators/unknown-key rejection),
  verification strategy (self_reported / output_contains / state_check /
  external), timeoutMs, retryPolicy, cost, reliability, riskLevel
  (safe/low/medium/high/critical).
- **Permissions** (`permissions.ts`): 12 conceptual domains; defaults grant the
  capabilities that exist today (browser, filesystem read, app launch, location,
  memory) and deny everything desktop/hardware (screen, mouse, keyboard, terminal,
  camera, mic, filesystem write). `requiresConfirmation(risk)` is the Phase 18
  enforcement hook (default threshold: high).
- **Selection** (`toolSelector.ts`): registry is authoritative; planner emits
  *capabilities* (e.g. `browser.open_url`, `memory.store`), the selector picks the
  cheapest reliable candidate and records a human-readable reason in TOOL_SELECTED.
  Direct tool-name fallback keeps Phase 1/2 mock registries working.
- **Failure classification** (`ToolErrorKind`): invalid_input, permission_denied,
  timeout, cancelled, not_found, execution_error, verification_failed — drives
  retryability (timeouts/execution errors retry; invalid input/permissions never).
- **Tool inventory** (13): web.open_website, web.search_website, app.launch,
  app.list, files.search/open/scan, location.get, chat.report, system.note,
  memory.remember, memory.recall, memory.search. Categories reserved as extension
  points: computer, vision, voice (Phases 4–7).
- New capabilities join by registering a tool with capabilities + permissions —
  no Agent Core or UI changes required.

## 10. Screen vision (Phase 4)

```
planner ("what's on my screen?" → screen.observe capability)
        ▼
ToolRegistry: screen.observe / screen.get_active_window /
              screen.detect_changes / screen.compare
        ▼  permission gate: 'screen.observation' (default-deny)
ScreenObserver ──── capture reuse (maxAgeMs per mode), 8s capture timeout
   │  CaptureSource: BrowserCaptureSource (getDisplayMedia + canvas,
   │  offscreen <video>, stream reused per session)
   │  or FakeCaptureSource (synthetic RGBA frames for Node tests)
   ▼
frame ──┬─ 240px RGBA analysis buffer → block signature (32×18 luminance grid)
        │     → compareSignatures → changedFraction + clustered regions
        ├─ LocalPixelVisionProvider (always available): text-like bands,
        │  brightness, honest empty OCR — zero dependencies
        └─ GeminiVisionProvider (strictly opt-in 'cloud'): downscaled JPEG →
           /api/vision/analyze (server rate limit 8/min) → structured JSON
        ▼
ScreenState {id, timestamp, activeWindow, size, signature, analysis,
             snapshotRef} + bounded state history (8) for compareStates
```

- **Privacy**: image data never persists — snapshots live in a bounded
  in-memory cache (3 entries, 60s TTL, `purgeSnapshots()`/`stop()`); tool
  results and task summaries carry summaries/lists only; screen events feed
  diagnostics, not memory storage.
- **Modes**: on_demand (always fresh) / task_monitoring (1.5s reuse window) /
  idle (minimal) — no polling timers; adaptive scheduling is Phase 13.
- **Honesty**: capture/analysis failures surface as classified ToolResult
  failures (permission_denied / timeout / capture_failed / provider_unavailable);
  Krisha never claims to have seen the screen when capture failed.
- **Verification path (for Phases 5–7)**: `app.launch → screen.observe →
  compareStates → activeWindow/application changed` is now representable;
  acceptance of that flow is Phase 7 work.
- **Debug hook**: `window.__KRISHA_AGENT__` (DevTools only, no UI) exposes
  `{core, bus, registry, permissions, screenObserver, computerControl}` for the
  manual verification procedure.

## 11. Mouse + cursor control (Phase 5)

```
planner ("click on the Save button" → computer.click capability)
        ▼
ToolRegistry: computer.get_cursor / move_cursor / click / double_click /
              right_click / scroll / drag   (all gated: 'mouse.control',
              default-deny; drag = medium risk, clicks = 1 attempt max)
        ▼
ComputerControlService
   1. resolve target: semantic element/text bounds from Phase 4 vision
      (token matching, confidence ≥ 0.6) → coordinates only as last resort
   2. stale protection: re-capture + re-identify when the referenced
      observation is older than 8s / stateId mismatched
   3. click point: 10%-inset center of bounds → mapped to screen pixels,
      validated against virtual-screen bounds
   4. execute via MouseBackend (PowerShellMouseBackend → local server →
      persistent PowerShell worker: user32 SetCursorPos + mouse_event;
      moves use the .NET Cursor.Position fast path)
   5. VERIFY: Phase 4 block-signature diff before/after (settle ≤ 1s) →
      verified:true/false evidence — never "executed = succeeded"
        ▼
MouseActionResult {intended, final, target, screenBounds, verification,
                   activeWindow, summary} + CURSOR_/MOUSE_* events
```

- **Safety**: permission checked at registry level AND inside the service;
  cancellation checkpoints before and after the OS action; invalid/NaN/
  out-of-bounds coordinates and low-confidence targets are refused without
  any OS interaction; failed clicks are reassessed (fresh observation +
  re-identification), never blindly retried.
- **Server**: `/api/computer/mouse` validates and clamps every parameter,
  accepts only known actions, and runs a persistent PowerShell worker
  (warm ≈ 50–180ms; cold spawn ≈ 4s) with automatic restart and a
  per-call execFile fallback.

## 12. Keyboard control (Phase 6)

```
planner ("type hello" / "press ctrl+s" / "copy" → keyboard capabilities)
        ▼
ToolRegistry: computer.type / press_key / hotkey / key_down / key_up /
              copy / paste / select_all   (gated: 'keyboard.control',
              default-deny; type & paste & hotkey = 1 attempt max)
        ▼
KeyboardControlService
   1. validation: key/modifier whitelist (client-side registry), text length
      ≤ 2000, control chars stripped — invalid input never reaches the OS
   2. permission + cancellation checkpoints before dispatch
   3. execute via KeyboardBackend (PowerShellKeyboardBackend → local server →
      persistent worker → user32 SendInput: KEYEVENTF_UNICODE for text,
      virtual-key down/up for keys, modifier-guarded hotkeys with `finally`
      release)
   4. VERIFY: Phase 4 signature diff, or expected-text matching against a
      fresh provider analysis when expectText is supplied
   5. duplicate-typing protection: an uncertain type result is reported as a
      NON-retryable failure ("text may already be inserted") — never resent
   6. stuck-key protection: explicit key_down holds are tracked and released
      automatically on any failure/cancellation/unmount
        ▼
KeyboardActionResult {keys, typedCharacters, deliveryUncertain, textPreview
                      (sensitive input fully masked), verification, summary}
```

- **Sensitive input** (passwords, tokens, api keys — pattern-detected) is
  masked in every summary/result and never logged or stored; clipboard
  contents are never read by Krisha's copy/paste tools.
- **Server**: `/api/computer/keyboard` re-validates keys against its own
  whitelist, escapes text for the PowerShell protocol, and shares the
  persistent PowerShell worker with the mouse endpoint.
- **Real-machine note**: automated end-to-end verification against a live
  desktop is only reliable when the user is not actively using the machine
  (focus contest); `scripts/real-machine-check-keyboard.ts` implements the
  Notepad workflow (focus → type → Enter → Ctrl+A → clipboard verify) with an
  active-window guard that refuses to type into an unrecognized foreground app.

## 13. Computer-use agent (Phase 7)

```
planner: compound desktop task (≥2 computer-action clauses)
        → single `computer.use` step (+ trailing chat.report)
        ▼
Agent Core step (task state, step limits, timeout, cancellation,
                 permissions: screen.observation + mouse.control +
                 keyboard.control — all three on the tool contract)
        ▼
ComputerUseAgent.run(goal)  ── per action:
   1. OBSERVE  fresh capture every action cycle (observer cache reused
               only inside an action's targeting/verification)
   2. GUARD    active-window tracked; focus change ⇒ recovery re-observe
   3. PLAN     HeuristicActionDecider → ordered intents (planner parsing)
   4. ACT      Phase 5/6 services (semantic targeting, validation)
   5. VERIFY   per-action screen-change evidence + bounded waitForQuiet
               (cheap signature diffs, adaptive 250/500/1000ms intervals)
   6. RECOVER  re-observe → re-resolve → one safe alternative (scroll);
               bounded by maxRecoveriesPerAction; then stop honestly
        ▼
ComputerUseResult {status: completed|partial|failed|cancelled,
                   per-action records with verified evidence,
                   focusChanges, observations, honest summary}
```

- **Reuse, not duplication**: the orchestrator adds closed-loop behavior only;
  Agent Core, vision, mouse, keyboard, permissions, events, and memory are the
  Phase 1–6 systems unchanged.
- **Completion honesty**: `completed` requires every action executed with
  recorded verification evidence; failures stop the run and skip the rest
  rather than acting on a broken understanding of the screen.
- **Performance**: one fresh capture per action cycle + cheap signature diffs
  for settling; no polling loops, no full-analysis polling, bounded history.
- **LLM decider extension point**: `HeuristicActionDecider` can be replaced by
  a model-backed decider (next-action from screen summary) without touching
  the loop (Phase 8+/17).

## 14. Browser agent (Phase 8)

```
planner: compound browser task (≥2 browser clauses incl. ≥1 on-page
         interaction) → single `browser.use` step (+ chat.report)
         On-page phrases ("click X on the page", "find X on this page",
         "scroll until X") classify via classifyBrowserPhrase.
        ▼
Agent Core step ('browser.interaction' permission; state_check verification)
        ▼
BrowserAgent.run(goal, intents)  ── per action:
   navigate (http/https only; schemes rejected; bounded load wait;
             verified via URL/title/heading evidence)
   find     (bounded state: 25 links / 25 buttons / 25 fields / 10 headings)
   click    (element by visible text → verify URL/content change)
   type     (field by placeholder/name/label; sensitive input masked)
   scroll / scroll-until / bounded wait / back / forward / refresh
        ▼
BrowserState (url, title, ready, links, buttons, fields, headings, tabs;
              bounded, no page history) + BROWSER_* events
```

- **Transport**: `browserCdp.ts` (server-side) drives a Krisha-owned
  HEADLESS Chrome/Edge over the Chrome DevTools Protocol using Node's built-in
  WebSocket — zero npm dependencies, dedicated throwaway profile, the user's
  own browser is never touched. Endpoints expose TYPED actions only
  (`/api/browser/state|navigate|back|forward|refresh|click|type|scroll|tabs`);
  callers cannot inject arbitrary JS.
- **Fallback**: when the controlled browser is unavailable, desktop-level
  interaction falls back to the Phase 7 Computer-Use Agent (screen vision +
  Phase 5/6 mouse/keyboard) — no second mouse/keyboard implementation.
- **Safety**: URL scheme whitelist, no submit/purchase/auth tools, no CAPTCHA
  or security bypasses; sensitive typed values masked via the Phase 6
  masking; risk: navigation low, typing medium, `browser.use` medium with all
  actions individually verified.
- **Dynamic pages**: bounded adaptive waits (300/600/1000ms) for load and
  delayed content; stale targets re-resolved from fresh state; failed actions
  stop the run honestly instead of clicking blindly.

## 15. Filesystem + application agent (Phase 9)

```
planner: classifySystemIntent (explicit verbs: create/delete/rename/
         copy|move X to Y/list/read <file.ext>/find X and open it/
         is X running/close X) → filesystem.* / application.* tools
         (compound "find X and open it" = one filesystem.find_open step)
        ▼
Agent Core step ── permission gates:
   filesystem.read  (granted)  → list/search/inspect/read/open
   filesystem.write (DENIED)   → create/rename/copy/move/delete
   application.launch (granted)→ app find/launch/status/close/focus
        ▼
systemAgentServer.ts (server-side, Node fs built-ins)
   resolveSafePath: canonicalize → allowed roots (homedir/tmp/cwd;
   relative paths resolve against TEMP) → traversal rejected;
   writes denied in Windows system locations
   reads: text extensions only, 64KB bounded, binary-sniffed, offset paging
   lists/searches: bounded (200 entries / 2000 scanned / depth 4)
        ▼
verification (evidence-based, in FilesystemService/ApplicationService):
   create → re-inspect exists; rename → old gone + new exists;
   copy → destination size match; move → source gone + dest exists;
   delete → target no longer exists; launch → process-table check
   (uncertain reported honestly when evidence is unavailable)
        ▼
FS_OPERATION_* / APP_* events; transient failures retried once (reads
   only); destructive ops never retried; cancellation via tool signals
```

- **Application discovery**: Start Menu shortcuts (ProgramData + user) and
  PATH executables, bounded (150 apps) and cached (5-min TTL). Launch is
  allowlist-based by discovered name or validated .exe path — never an
  arbitrary command string. Status via Get-Process, close via taskkill PID,
  focus via AppActivate.
- **Screen-vision/computer-use boundary**: the system layer owns non-visual
  operations; window-visible confirmation (e.g. after open_file/launch) is
  delegated to Phase 4 observation or Phase 7 computer-use, reported as
  `uncertain` until observed.
- **Memory safety**: file contents, paths of sensitive files, and process
  details are never stored — the Phase 2 service only receives workflow-level
  outcomes through the standard task-completion bridge.

## 16. Multi-step autonomy (Phase 10)

```
planner: extractGoal → decompose into ordered plan steps (clauses/compound)
         ▼
Tool chaining: producer step (outputKey: "found")
               consumer step ({$context: "found.matches.0.path"})
         ▼
Agent Core execution loop:
   1. DEPENDENCY CHECK: step.dependsOn evaluated against prior step statuses
      (unmet dependency → status: 'skipped')
   2. CONDITION EVALUATION: step.condition evaluated against task.context
      (context_exists | context_missing | context_equals | context_contains
       unsatisfied → status: 'skipped')
   3. CONTEXT RESOLUTION: resolveContextRefs replaces {$context: path}
      placeholders with live values from task.context
   4. STEP DISPATCH & TIMEOUT: withTimeoutAndAbort + AbortSignal,
      permission verification, retry policy
   5. VERIFICATION: evidence-based verification; honest uncertainty
      propagates (uncertain output → step.status: 'uncertain', not completed)
   6. CONTEXT PERSISTENCE: boundContextValue truncates output to 4KB preview
      before storing under step.outputKey into task.context
   7. OBJECTIVE COMPLETION CHECK: plan.evidenceKey presence in context
      triggers early completion of remaining steps
         ▼
Lifecycle events: TASK_STARTED / TASK_STEP_STARTED / TASK_STEP_SKIPPED /
                  TASK_COMPLETED / TASK_FAILED / TASK_CANCELLED
```

- **Task context scratchpad**: Structured runtime context persisted on `AgentTask.context`. Steps emit outputs under `outputKey`, and downstream steps consume values via `{$context: 'path.to.field'}` references without intermediate hardcoding. Context values are strictly bounded (max 4,000 characters) to prevent memory bloating from file contents or dumps.
- **Dynamic condition gating**: Steps declare optional `StepCondition` rules (`context_exists`, `context_missing`, `context_equals`, `context_contains`) evaluated against runtime context, allowing autonomous workflows to branch or skip satisfied actions dynamically without user intervention.
- **Early objective termination**: When a plan declares an `evidenceKey`, producing that evidence in the context immediately marks remaining steps as cleanly skipped and completes the task, avoiding redundant actions.
- **Honest uncertainty propagation**: Dispatched operations that succeed without definitive confirmation mark steps as `uncertain` rather than fabricated `completed`, truthfully reflected in task summaries.
- **Safe autonomy boundary**: Full lifecycle cancellation, step timeouts, and permission gates (`screen.observation`, `mouse.control`, `keyboard.control`, `filesystem.read`, `filesystem.write`) remain enforced at each step.

## 17. Error recovery (Phase 11)

```
step failure (Agent Core runStepWithRetry budget exhausted, or failed step)
        ▼
AgentCore → RecoveryManager.handleFailure
   1. GUARD     abort signal checked first; cancellation short-circuits recovery
   2. CLASSIFY  classifyFailure: error text + ToolResult.errorKind → 14-part
                taxonomy (TRANSIENT, TIMEOUT, STALE_STATE, TARGET_NOT_FOUND,
                FOCUS_LOST, NAVIGATION_CHANGED, PERMISSION_DENIED,
                INVALID_INPUT, TOOL_FAILURE, VERIFICATION_FAILURE,
                DEPENDENCY_FAILURE, CONTEXT_FAILURE, UNSAFE_OPERATION, UNKNOWN)
   3. POLICY    RecoveryPolicy.evaluate → RecoveryDecision
                - budgets: maxAttemptsPerStep (2), maxAttemptsPerTask (6),
                  maxRepeatedIdenticalFailures (2) → SAFE_STOP when exceeded
                - non-recoverable classes (PERMISSION_DENIED, UNSAFE_OPERATION,
                  INVALID_INPUT, DEPENDENCY_FAILURE, CONTEXT_FAILURE) → SAFE_STOP
                - idempotency guard: side-effecting capabilities (clicks, typing,
                  file writes, app launch/close) that TIMEOUT or fail VERIFICATION
                  are RE_OBSERVEd — never blindly retried
   4. EXECUTE   RecoveryStrategyExecutor runs the bounded strategy:
                RETRY · RE_OBSERVE (screen.observe / browser.state) ·
                REFOCUS (application.focus) · RE_RESOLVE_TARGET ·
                BROWSER_RECOVERY (browser.refresh) · ALTERNATIVE_TOOL ·
                ROLLBACK (cleanupPath only) · SAFE_STOP — each with
                post-recovery verification evidence
   5. DECIDE    recovered → core re-runs the step (RETRY, RE_OBSERVE, REFOCUS,
                BROWSER_RECOVERY), splices in an alternative step
                (ALTERNATIVE_TOOL), or continues;
                not recovered → failed step output invalidated, task stops honestly
        ▼
RECOVERY_* events (STARTED / CLASSIFIED / STRATEGY_SELECTED / ATTEMPTED /
                   REOBSERVED / VERIFIED / SUCCEEDED / FAILED / ABORTED),
SAFE_STOP_TRIGGERED; RecoveryAttempt history (sanitized, bounded to 500 chars)
```

- **Context safety (`RecoveryContextManager`)**: every `{$context}` reference in a
  step input is validated before execution; keys marked INVALID (failed producer)
  or missing from the task context stop the step before it runs. Failed step
  outputs are deleted from `task.context` and marked INVALID so stale values can
  never silently flow into downstream steps.
- **Bounded by design**: no strategy loops, no unbounded retries — every recovery
  path consumes from the same explicit budget and every attempt is recorded in the
  sanitized `RecoveryAttempt` history (passwords/tokens redacted).
- **Test suite**: `scripts/test-recovery-phase11.ts`
  (`npx tsx scripts/test-recovery-phase11.ts`) covers the classifier, policy
  budgets/idempotency, context safety, executor verification, manager state
  machine, and AgentCore integration (retry, re-observe + re-run, alternative
  step injection, safe stop on invalid context).

## 18. Learning + workflow acquisition (Phase 12)

```
TASK_COMPLETED ──▶ LearningService.learnFromTask
TASK_FAILED    │    verified success → create/reinforce workflow (confidence ▲)
USER_MESSAGE   │    failure → evidence against the matching workflow only
TOOL_COMPLETED │                 (confidence ▼; failures never create workflows)
TOOL_FAILED    ─▶ per-capability strategy statistics
        ▼
LearningWorkflowStore (krisha_learning_workflows_v1, schemaVersion 1,
│                      repair-on-load, bounded: 40 workflows / 20 evidence /
│                      10 corrections / 60 strategy entries; lowest-confidence
│                      stalest evicted first)
│
├─▶ WorkflowAwarePlanner (thin decorator over the Phase 1 Planner):
│     makePlan → planFromWorkflow: is there a confident, environment-compatible
│     workflow for this goal? YES → instantiate steps as a plan TEMPLATE
│     (plan.learnedFrom recorded); NO → inner planner plans normally
│
└─▶ mirrorToMemory: reusable workflows reflected into the Phase 2
    MemoryService (category 'workflow', workflowId link only)
        ▼
Every reused step still runs the full Agent Core stack — verification,
retry, recovery, permissions, cancellation, timeouts (Phase 12 adds a
memory of WHAT worked; it does not add a second execution path)
```

- **Workflow knowledge is structured data, never prose/screenshots**: goal
  pattern, required capabilities, ordered step templates (toolName/capability/
  sanitized inputTemplate/contextRefs/outputKey), evidence list, corrections,
  confidence, version + version history.
- **Confidence is deterministic and bounded** (spec §7): verified_success +0.1,
  unverified_success +0.01, verified_failure −0.2, unverified_failure −0.05,
  clamped [0,1]. Reuse requires the 'usable' level (≥ 0.45) — a workflow must
  prove itself with a verified success after creation before auto-reuse.
- **Reuse ranking is local and deterministic** (no model calls): score =
  0.6·goalSimilarity + 0.25·confidence + 0.15·environmentCoverage; every step
  must resolve to a concrete tool in the CURRENT registry (by name, or by
  capability as adaptation); `REUSE_MIN_SCORE = 0.55` and full coverage required.
- **Corrections**: `detectCorrection` (Phase 2) on USER_MESSAGE → durable
  correction attached to the matching workflow + small bounded confidence
  reduction; corrections are also stored in Phase 2 memory.
- **Adaptation**: a new verified success with a different step sequence bumps
  the workflow version (bounded history) instead of fossilizing or duplicating;
  tool replaced via capability keeps reuse alive when the environment changes.
- **Safety**: workflows containing high/critical-risk tools are never learned;
  secrets are stripped from input templates (`sanitizeTemplate` — sensitive
  keys and secret-like values redacted, values truncated); learning never
  writes source code, permissions, or settings (no self-modification); all
  store writes are bounded and corruption-tolerant.
- **Outcome honesty**: `unverified` outcomes barely count (+0.01/−0.05);
  failure evidence and known failure points are recorded even when the failed
  task executed fewer steps than the full plan (failed steps included in
  evidence; skipped steps are not).
- **Debug/inspection**: `learning.list() / get() / disable() / forget() /
  strategyStats() / stats()` — plus `window.__KRISHA_AGENT__.learning` in the
  browser (DevTools only, no UI).
- **Test suite**: `scripts/test-learning-phase12.ts`
  (`npx tsx scripts/test-learning-phase12.ts`) — 70 assertions covering
  preference learning, correction learning, workflow learning, reuse, failed
  strategies, environment adaptation, duplicate prevention, persistence across
  restart, learning safety, resource bounds, and planner fallback/versioning.

## 19. Adaptive screen observation (Phase 13)

```
EVENT BUS (existing Phase 1 events)
  MOUSE_CLICK_COMPLETED / KEYBOARD_ACTION_COMPLETED / BROWSER_NAVIGATED /
  APP_* / FS_OPERATION_COMPLETED / RECOVERY_* / SCREEN_CHANGED / TASK_*
        │  (AdaptiveObserver.attach — no polling loop, no timers)
        ▼
AdaptiveObserver ── beginTask/endTask/stopObservation/resume
  │   pending-trigger queue (bounded, TTL 5s, priority-deduped)
  │   context feeds: recordAction / notifyVerification / notifyChange / notifyRecovery
  ▼
Decision engine (pure, deterministic — observationDecider.decide)
  rules in order: workflow freshness + recovery + failed verification
  → budget gates → idle gate → explicit/no-prior/stale → change-awareness
  → filesystem-step preference → post-action → default reuse
  output: OBSERVE_NOW | OBSERVE_AFTER_ACTION | OBSERVE_REGION |
          REUSE_VALID_STATE | DELAY_OBSERVATION | STOP_OBSERVATION (+reason)
  ▼
ObservationBudgetTracker (per task: 24 captures, 6/10s window,
  3 consecutive, 4 unchanged, 2 retries — structured exhaustion statuses)
  ▼
ScreenObserver (Phase 4, unchanged behavior; new optional `region` option)
  capture → crop (region) → local analysis → bounds translated back to
  full-screen coordinates; change signatures ALWAYS computed on the full frame
```

- **New module** `src/agent/observation/`: `observationTypes.ts` (requests,
  policy, results, triggers, priorities LOW–CRITICAL, modes, regions, budgets,
  changes, decisions), `observationPolicy.ts` (mode resolution: idle /
  active_task / after_action / uncertain / rapid_change / settled with
  mode-specific reuse windows — idle 60s ≈ off, active 1.5s, rapid 400ms),
  `observationBudget.ts`, `observationDecider.ts`, `adaptiveObserver.ts`.
- **Event-driven, never polling**: no intervals, no background workers.
  Events only RECORD triggers; captures happen solely inside explicit
  `observe()` calls driven by the Agent Core / Computer-Use / Browser flows.
  HIGH/CRITICAL events (recovery, failed verification) surface as pending
  triggers consumed by the next decision — never as reflex captures.
- **Budgets** (spec §4): per-task cap, sliding rate window, consecutive-capture
  cap, unchanged-screen cap, bounded retries. Exhaustion returns structured
  statuses (`budget_exhausted` / `stopped` with machine-readable reason,
  `delayed` with retryAfterMs) — never an uncontrolled loop.
- **Change-awareness** (spec §5): signature fractions classify as none / minor
  (<2%) / relevant (<25%) / major / unknown; streaks escalate policy to
  rapid_change (tighter) or settled (looser). Unchanged + fresh → reuse with
  zero captures.
- **Region-awareness** (spec §6): heuristic presets (browser_content,
  dialog_area, target_control, verification_region, active_application) crop
  the frame BEFORE analysis (cheaper inference); detected bounds are mapped
  back to full-screen coordinates so mouse/keyboard targeting stays correct
  (`src/agent/vision/regionCrop.ts`). Full-screen remains the default.
- **Task-awareness** (spec §7): filesystem-type steps prefer filesystem
  verification (`REUSE_VALID_STATE`); post-action triggers verify the result;
  browser state reads never trigger observations (CDP-first).
- **Stale-state protection** (spec §8): decisions consult the policy reuse
  window; recovery and failed verification always force fresh captures; a
  fresh capture clears recovery state. Observation failures return structured
  errors (`permission_denied`, `timeout`, …) for Phase 11 recovery — never
  silent stale reuse.
- **Computer-Use integration** (spec §10): the Phase 7 loop's OBSERVE step now
  consults the adaptive layer (reuse when fresh, capture when stale/forced,
  fresh on focus change); action failures feed `notifyVerification('failed')`,
  recovery feeds `notifyRecovery(true)`. Closed-loop architecture unchanged.
- **Browser integration** (spec §11): the Phase 8 agent requests observation
  only after navigation or when CDP state is insufficient (best-effort,
  browser-native state stays authoritative).
- **Learned workflow integration** (spec §12): `WorkflowStep.observation`
  (`requireFresh`, optional `region`) is learned (Phase 12 `toWorkflowStep`),
  carried on `PlanStep.observation`, and enforced by the Agent Core before the
  step runs — reused workflows never replay stale screen state.
- **Privacy** (spec §13): no image data in the observation layer, no new
  persistence; task end purges the ScreenObserver snapshot cache; cropped
  frames carry no `dataUrl` copy; observation metadata is JSON-safe
  (asserted in tests).
- **Cancellation/recovery** (spec §14): `observe()` accepts AbortSignals and a
  hard timeout; failures are structured (`failed`/`cancelled` with kind) and
  retried at most `maxRetries` times through the retry budget.
- **Debug/inspection**: `adaptiveObserver.getDiagnostics()` /
  `budgetStatus()` / `getLastDecision()`; exposed as
  `window.__KRISHA_AGENT__.adaptiveObserver` (DevTools only, no UI).
- **Test suite**: `scripts/test-observation-phase13.ts`
  (`npx tsx scripts/test-observation-phase13.ts`) — 91 assertions covering
  policy/decision determinism, idle behavior, active-task behavior,
  post-action observation, change detection, unchanged-screen reuse,
  stale-state detection, budgets + exhaustion, regions, task/browser/
  computer-use/workflow/recovery integration, cancellation, timeout,
  permission failure, privacy, no-polling guarantees.
- **Real-machine check**: `scripts/real-machine-check-observation.ts`
  (needs the local server) — observes state, verifies unchanged-screen reuse,
  performs a harmless reversible cursor nudge via the real backend, verifies
  adaptive fresh re-observation + real change classification, verifies no
  polling, restores the original state, bounded capture counts.
- **Limitations**: region presets are heuristic rectangles (no per-window
  rects without extra OS queries); screen capture itself still requires the
  interactive browser-consent flow (Phase 4); the decider is deliberately
  rule-based (no learned observation policy yet); screenshot content is never
  persisted anywhere.

## 20. Multimodal intelligence (Phase 14)

New module `src/agent/multimodal/` — a unified, bounded reasoning layer that
combines evidence from multiple modalities (text, screenshots, UI state,
browser state, application state, documents, audio transcripts, structured
tool results) instead of treating each input independently. Agent Core
remains the central brain; no vision/browser/control systems were duplicated.

**Module layout**:
- `multimodalTypes.ts` — `ModalityType` (9 registered kinds),
  `ModalityObservation` (type, source, timestamp, confidence, metadata,
  sensitivity, freshness TTL, stepId), payloads per modality, `Sensitivity`
  (`public`/`normal`/`sensitive`/`highly_sensitive`), `MultimodalConclusion`
  (claim, confidence, supporting/contradicting evidence, uncertainties,
  conflicts, requiredVerification), `MultimodalReasoningProvider` interface
  (spec §15 — pluggable external models; the system works fully without one).
- `modalityRegistry.ts` — per-modality descriptors: base priority
  (fresh tool state 100 > UI/screenshot 85 > browser 80 > app 75 > document
  70 > text 60 > image 50 > transcript 45), TTL (freshness windows), default
  sensitivity, redaction flags. `effectivePriority` decays with age and low
  confidence — stale evidence never outranks fresh evidence.
- `modalityNormalizer.ts` — converts raw inputs (text, ScreenState,
  BrowserState, app status, tool outputs, URLs, transcripts, documents) into
  `ModalityObservation`s: extracts summaries/keywords, computes content
  hashes (dedup), assigns confidence, and runs the **secret scanner** —
  passwords, API keys, tokens, JWTs, card-like numbers are redacted
  (`[REDACTED]`) and escalate the observation to `highly_sensitive`.
- `multimodalContext.ts` — the task-scoped evidence store: bounded
  (`maxObservations`, `maxPerModality`, `totalCharBudget`), per-modality
  caps (newest kept), content-hash dedup (refresh not duplicate), TTL-based
  staleness (`removeStale`), step association (`forStep`), task scoping
  (`beginTask` clears, `endTask` purges), `priorityOf` (freshness ×
  registry × confidence), and `providerSafeDigest()` — a bounded,
  sensitive-evidence-free string for external providers.
- `multimodalAnalyzer.ts` — selective, on-demand gathering: `gather(ctx,
  kinds)` only touches the requested modalities (browser gather never
  captures the screen; screen gather goes **through the Phase 13 adaptive
  observer** — reuse when fresh, `requireFreshScreen` forces a capture, and
  no pixel data is stored, only structured UI summaries). Also: application
  status via the Phase 9 service (unverified reads are never recorded),
  text recording, and document understanding with bounded chunking +
  keyword-scored relevant-section selection (huge documents never load
  fully). Every gather honors `timeoutMs` and `AbortSignal`.
- `multimodalReasoner.ts` — deterministic cross-modal reasoning:
  question classification (find-element, verify-state, active-application,
  summarize-document, continue-workflow…), target extraction, evidence
  matching across modalities, source-priority resolution, **conflict
  detection** (browser URL vs screen URL; app reported open vs absent on
  screen; text vs evidence), confidence math (multi-source bonus,
  single-source cap, conflict penalty) and honest uncertainty — no
  fabricated elements, zero confidence when evidence is missing, and
  `requiredVerification` steps listed. If the local answer is
  low-confidence AND an external provider is set, the provider is consulted
  with the `providerSafeDigest` (timeout- and cancellation-guarded); the
  local result stands otherwise.
- `multimodalVerifier.ts` — independent-evidence verification of
  expectations ("X is open", "text \"…\" is visible", URL expectations):
  gathers agreeing/contradicting evidence from 4 families (application
  state, visible screen, browser-native state, structured tool results),
  requires ≥2 evidence kinds for `confirmed` (a single fresh verified tool
  result may also confirm), reports conflicts, and always lists the next
  verification step when independent confirmation is missing.
- `multimodalService.ts` + `index.ts` — the facade: task lifecycle on the
  Event Bus (TASK_STARTED opens a scope; TOOL_COMPLETED/TOOL_FAILED record
  real tool evidence with step association; TASK_COMPLETED/TASK_FAILED
  purge everything), plus the integration hook consumed by the Phase 7
  Computer-Use Agent (`multimodal.recordObservation(state)` — CU
  observations become queryable multimodal evidence; the CU closed loop is
  unchanged).

**Privacy (spec §13)**: every modality carries a sensitivity
classification; secrets are redacted at normalization time and never
persisted; `providerSafeDigest()` excludes sensitive and highly-sensitive
evidence from anything sent to an external provider; screenshot/screen
observations store structured summaries only — no image data, no new
persistence anywhere; task end purges all evidence.

**Resource control (spec §14)**: strictly on-demand — no background
processing, no polling (captures happen only inside explicit `gather()`
calls; the Phase 13 no-polling property is asserted in tests), bounded
context sizes, per-modality caps, TTL expiration, content-hash dedup,
selective gathering, document chunking with relevant-section selection.

**Provider abstraction (spec §15)**: `MultimodalReasoningProvider` is a
plain interface (`id`, `reason(input)`); `MultimodalReasoner.setProvider()`
installs one, `getProvider()`/`setProvider(null)` removes it. Without a
provider everything works deterministically and locally (asserted in
tests). Provider calls receive only the redacted bounded digest, are
skipped when aborted, and time out to the local result.

- **Bridge wiring**: `MultimodalService` is constructed with the Phase 13
  observer, Phase 8 browser agent, and Phase 9 application service;
  `attach(bus)` records tool evidence; `multimodal.recordObservation` is
  handed to the Computer-Use Agent; exposed as
  `window.__KRISHA_AGENT__.multimodal` (DevTools only, no UI).
- **Test suite**: `scripts/test-multimodal-phase14.ts`
  (`npx tsx scripts/test-multimodal-phase14.ts`) — 150 assertions covering
  registry priorities, normalization + secret redaction, context bounds/
  dedup/staleness/step association/task scoping, document chunking +
  section selection, cross-modal reasoning, source prioritization, conflict
  detection, confidence/uncertainty math, verification (confirmed/refuted/
  uncertain + cancellation), service/bus lifecycle, Computer-Use evidence
  recording, provider enrichment/timeout/cancellation, privacy (no pixels,
  secret rejection, digest exclusion), resource discipline (no polling,
  selective gathering), gather timeout/cancellation.
- **Real-machine check**: `scripts/real-machine-check-multimodal.ts`
  (needs the local server) — launches Character Map through the Phase 9
  allowlist, gathers real process-table evidence via the Phase 14 analyzer,
  types a harmless phrase through the real keyboard backend (no Enter) plus
  a reversible cursor nudge, records both action results as tool evidence,
  runs a Phase 13 screen observation (synthetic cursor source, honestly
  labeled — real capture needs interactive consent), verifies "charmap is
  open" with independent confirmation (application state + tool results),
  asserts the synthetic-screen corroboration gap is reported as a conflict,
  then force-closes the app and confirms the process is gone.
- **Limitations**: local reasoning is deterministic/rule-based (external
  providers enrich only); document support covers already-extracted text
  (PDF rendering remains with the existing Phase 9 surfaces); real screen
  capture still needs the interactive consent flow, so real-machine checks
  use the labeled synthetic cursor source; conflict detection covers the
  main contradiction classes (URL, app presence, text-vs-evidence) rather
  than open-world consistency; evidence older than its registry TTL is
  ignored, which can leave questions unanswered by design.


