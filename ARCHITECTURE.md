# Krisha â€” Architecture Audit (Phase 0) & Agent Integration Map

> Written 2026-09-12 as part of the phased roadmap (Phase 0). Nothing in this document
> changes behavior; it records what exists, what is reusable, and where new agent
> subsystems attach. The UI is intentionally untouched.

## 1. Current stack

| Layer | Tech |
|---|---|
| Frontend | React 19 + Vite 6, Tailwind v4, motion (Framer), lucide icons |
| Backend | Express (single `server.ts`), Gemini via `@google/genai` |
| Persistence | localStorage (settings/memories/conversations/location), IndexedDB (file index) |
| Voice | Gemini TTS server endpoint â†’ Web Speech fallback; SpeechRecognition wake-word |
| Platform target | Browser SPA served by Express (port 3000); AI Studio deployment metadata |

## 2. Existing AI / model integration

- `server.ts` â€” `/api/chat`: Gemini chat with a 3-model waterfall
  (`gemini-3.7-flash` â†’ `gemini-flash-latest` â†’ `gemini-3.1-flash-lite`),
  backoff retry on 429/503/quota, and an in-character local fallback generator when
  all models are exhausted.
- `server.ts` â€” `/api/memory/extract`: heuristic fact regexes (zero-latency) + LLM
  extraction with a 2-minute cooldown after quota failures.
- `server.ts` â€” `/api/tts`: Gemini TTS (`gemini-3.1-flash-tts-preview`) with quota
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
   `spotify:`, `ms-calculator:`â€¦), custom user apps, launch + list + search.
5. **Files**: File System Access API folder scan (depth 6), IndexedDB index with
   preview text for plain-text files, search by name/folder/extension/content,
   open in new tab / download. PDFs are opened, never read (explicit product rule).
6. **Location**: GPS-first priority chain (browser GPS â†’ GMP geocoding â†’ Nominatim â†’
   IP fallback), 15-min verified cache, IP-guess rejection, location statement
   parsing ("I am in Pune").
7. **Avatar theatrics**: dance/greet/thank/look-direction commands, parallax,
   draggable avatar, pose video clips.
8. **Server resilience**: model waterfall, TTS/memory cooldowns, geocode fallbacks.

### Missing capabilities (roadmap targets)
- No task abstraction â€” every message is one-shot; "open X, then do Y" cannot be
  represented internally.
- No tool abstraction â€” execution is inline in `App.tsx`.
- No event system, no cancellation, no client-side timeout/retry.
- No verification after actions (fire-and-forget `window.open`).
- Memory is a flat `string[]`; no importance, dedup beyond `Set`, conflicts, or
  categories. No episodic/workflow/correction memory.
- No screen observation, no camera, no mouse/keyboard control (Phases 4â€“7).
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
   `webActions.ts` (client copy is richer â€” drift risk).
3. Intents are mutually exclusive by accident; a sentence containing both an app
   launch and a web search executes partially (first detector wins inline, both
   cards may render, but sequencing is not guaranteed).
4. No honest verification: `launchLaptopApp` returns success whenever the anchor
   click doesn't throw, regardless of whether the OS handled the protocol.
5. Memory extraction appends without checking duplicates/conflicts properly.
6. `App.tsx` re-renders whole tree on every keystroke emotion change (minor perf).

## 6. Dependency map (existing)

```
main.tsx â”€> App.tsx â”€â”¬â”€> components/* (KrishaAvatar, SidebarNav, modals, cards, DirectChatInput)
                     â”œâ”€> utils/storage.ts          (localStorage)
                     â”œâ”€> utils/audio.ts            (/api/tts, Web Speech)
                     â”œâ”€> utils/sentimentEngine.ts
                     â”œâ”€> utils/webActions.ts       (window.open)
                     â”œâ”€> utils/appLauncher.ts      (protocol anchors, localStorage)
                     â”œâ”€> utils/fileSystemAccess.ts (IndexedDB, FS Access API)
                     â”œâ”€> utils/locationService.ts  (geolocation, /api/location/geocode, localStorage)
                     â””â”€> utils/wakeWordListener.ts (SpeechRecognition)

server.ts â”€â”¬â”€ /api/chat            â”€> Gemini waterfall â”€> (fallback) local generator
           â”œâ”€ /api/memory/extract   â”€> heuristics + Gemini
           â”œâ”€ /api/tts              â”€> Gemini TTS
           â”œâ”€ /api/location/geocode â”€> GMP â”€> Nominatim â”€> direct coords
           â””â”€ static /assets/videos â”€> avatar pose clips
```

## 7. Agent system integration map (where new subsystems attach)

```
                     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
 USER MESSAGE â”€â”€â”€â”€â”€â”€>â”‚ App.tsx (unchanged UI, thin delegation hook) â”‚
                     â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                            â”‚ single-step (existing)    â”‚ multi-step â†’ delegate
                            â–¼                           â–¼
                     existing inline flow        src/agent/agentCore.ts
                                                 INPUTâ†’GOALâ†’PLANâ†’TOOLâ†’RESULTâ†’VERIFYâ†’NEXT
                                                 (cancel / timeout / retry / events / state)
                                                     â”‚                â–²
                                     toolRegistry.ts â”‚                â”‚ events.ts
                                     (register tools)â”‚                â”‚ (TASK_*, TOOL_*)
                                                     â–¼                â”‚
                                         tools wrapping existing utilsâ”‚
                                         webActions / appLauncher /   â”‚
                                         fileSystemAccess / location /â”‚
                                         memory / chat.respond        â”‚
                                                          taskState.tsâ”‚ (persist/resume)
```

- `src/agent/*` is a **pure TypeScript layer** (no React, no DOM at core level) so it
  is unit-testable under Node/tsx. Browser-backed tools are registered from App.tsx;
  tests register mock tools against the same registry interface.
- **Phase 2 (memory)** lives in `src/agent/memory/` â€” see Â§8.
- **Phase 3 (tool system)** upgrades the registry/selector/contract â€” see Â§9.
- **Phase 4 (screen vision)** lives in `src/agent/vision/` â€” see Â§10.
- **Phase 5 (mouse control)** lives in `src/agent/computer/` â€” see Â§11.
- **Phase 6 (keyboard control)** extends `src/agent/computer/` â€” see Â§12.
- **Phase 7 (computer-use agent)** lives in `src/agent/computerUse/` â€” see Â§13.
- **Phase 8 (browser agent)** lives in `src/agent/browser/` + `browserCdp.ts` â€” see Â§14.
- **Phase 9 (filesystem/application agent)** lives in `src/agent/system/` + `systemAgentServer.ts` â€” see Â§15.
- Phase 10+ (multi-step autonomy) will combine the orchestrator loops through
  the same registry/planner.
- Phase 17 (model routing) will generalize `generateContentWithFallback` in server.ts
  and own vision-provider escalation.

## 8. Memory architecture (Phase 2)

```
Agent Core events (USER_MESSAGE / TASK_COMPLETED / TASK_FAILED)
        â”‚
        â–¼
memoryBridge.ts â”€â”€â”€â”€ correction learning, relevance recall (task.memoryContext),
        â”‚             episodic + workflow upsert after tasks
        â–¼
MemoryService â”€â”€ remember / recall / search / update / merge / forget /
        â”‚         invalidate / detectConflicts / rankRelevance
        â–¼
MemoryStore â”€â”€â”€â”€ schema-versioned envelope (krisha_agent_memory_v2),
        â”‚         validation + repair + legacy v1 migration, 400-record cap
        â–¼
StorageAdapter â”€â”€ localStorage (browser) | MemoryStorage (tests)
        â”‚
        â””â”€â”€ write-through mirror into legacy krisha_memories_v1 string[]
            â†’ existing MemoryModal + /api/chat prompt keep working unchanged
```

- `MemoryRecord`: id, category (short_term/long_term/preference/episodic/workflow/
  correction/semantic), content, timestamps, importance, confidence, source,
  usage tracking, valid/supersededBy, metadata (workflow: steps/tools/trigger/
  successCount/lastSuccessfulAt).
- Duplicate detection: normalization + synonym folding + Jaccard/containment
  similarity (threshold 0.62) â†’ merge instead of insert.
- Conflict handling: preference triples (prefer/avoid/use/never-use over the same
  subject/object). Authoritative or stronger new memory **supersedes** the old one;
  low-confidence contradictions keep both records, flag `conflicted`, and register
  a conflict entry â€” no silent winner.
- Retrieval is relevance-ranked (token overlap, importance, confidence, 14-day
  recency half-life, usage) with category filters and hard limits; `/api/chat`
  now receives recalled memories per message instead of the whole list.
- Secrets (API keys, tokens, private keys, passwords) are never stored;
  conversational noise is filtered by worth-assessment.

## 9. Tool system (Phase 3)

```
Agent Core (capability on each PlanStep)
        â”‚  TOOL_SELECTED (selector ranks candidates: cost â†’ risk â†’ reliability)
        â–¼
ToolRegistry.execute() â”€â”€ permission check â†’ input-schema validation â†’ execute()
        â”‚                  normalization: toolId / errorKind / retryable /
        â”‚                 timestamp / durationMs; never throws
        â–¼
ToolResult (structured) â†’ core VERIFY (step override â†’ tool strategy â†’ tool_success)
        â”‚                 TOOL_VERIFIED / TOOL_RETRIED / TOOL_CANCELLED events
        â–¼
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
  timeout, cancelled, not_found, execution_error, verification_failed â€” drives
  retryability (timeouts/execution errors retry; invalid input/permissions never).
- **Tool inventory** (13): web.open_website, web.search_website, app.launch,
  app.list, files.search/open/scan, location.get, chat.report, system.note,
  memory.remember, memory.recall, memory.search. Categories reserved as extension
  points: computer, vision, voice (Phases 4â€“7).
- New capabilities join by registering a tool with capabilities + permissions â€”
  no Agent Core or UI changes required.

## 10. Screen vision (Phase 4)

```
planner ("what's on my screen?" â†’ screen.observe capability)
        â–¼
ToolRegistry: screen.observe / screen.get_active_window /
              screen.detect_changes / screen.compare
        â–¼  permission gate: 'screen.observation' (default-deny)
ScreenObserver â”€â”€â”€â”€ capture reuse (maxAgeMs per mode), 8s capture timeout
   â”‚  CaptureSource: BrowserCaptureSource (getDisplayMedia + canvas,
   â”‚  offscreen <video>, stream reused per session)
   â”‚  or FakeCaptureSource (synthetic RGBA frames for Node tests)
   â–¼
frame â”€â”€â”¬â”€ 240px RGBA analysis buffer â†’ block signature (32Ã—18 luminance grid)
        â”‚     â†’ compareSignatures â†’ changedFraction + clustered regions
        â”œâ”€ LocalPixelVisionProvider (always available): text-like bands,
        â”‚  brightness, honest empty OCR â€” zero dependencies
        â””â”€ GeminiVisionProvider (strictly opt-in 'cloud'): downscaled JPEG â†’
           /api/vision/analyze (server rate limit 8/min) â†’ structured JSON
        â–¼
ScreenState {id, timestamp, activeWindow, size, signature, analysis,
             snapshotRef} + bounded state history (8) for compareStates
```

- **Privacy**: image data never persists â€” snapshots live in a bounded
  in-memory cache (3 entries, 60s TTL, `purgeSnapshots()`/`stop()`); tool
  results and task summaries carry summaries/lists only; screen events feed
  diagnostics, not memory storage.
- **Modes**: on_demand (always fresh) / task_monitoring (1.5s reuse window) /
  idle (minimal) â€” no polling timers; adaptive scheduling is Phase 13.
- **Honesty**: capture/analysis failures surface as classified ToolResult
  failures (permission_denied / timeout / capture_failed / provider_unavailable);
  Krisha never claims to have seen the screen when capture failed.
- **Verification path (for Phases 5â€“7)**: `app.launch â†’ screen.observe â†’
  compareStates â†’ activeWindow/application changed` is now representable;
  acceptance of that flow is Phase 7 work.
- **Debug hook**: `window.__KRISHA_AGENT__` (DevTools only, no UI) exposes
  `{core, bus, registry, permissions, screenObserver, computerControl}` for the
  manual verification procedure.

## 11. Mouse + cursor control (Phase 5)

```
planner ("click on the Save button" â†’ computer.click capability)
        â–¼
ToolRegistry: computer.get_cursor / move_cursor / click / double_click /
              right_click / scroll / drag   (all gated: 'mouse.control',
              default-deny; drag = medium risk, clicks = 1 attempt max)
        â–¼
ComputerControlService
   1. resolve target: semantic element/text bounds from Phase 4 vision
      (token matching, confidence â‰¥ 0.6) â†’ coordinates only as last resort
   2. stale protection: re-capture + re-identify when the referenced
      observation is older than 8s / stateId mismatched
   3. click point: 10%-inset center of bounds â†’ mapped to screen pixels,
      validated against virtual-screen bounds
   4. execute via MouseBackend (PowerShellMouseBackend â†’ local server â†’
      persistent PowerShell worker: user32 SetCursorPos + mouse_event;
      moves use the .NET Cursor.Position fast path)
   5. VERIFY: Phase 4 block-signature diff before/after (settle â‰¤ 1s) â†’
      verified:true/false evidence â€” never "executed = succeeded"
        â–¼
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
  (warm â‰ˆ 50â€“180ms; cold spawn â‰ˆ 4s) with automatic restart and a
  per-call execFile fallback.

## 12. Keyboard control (Phase 6)

```
planner ("type hello" / "press ctrl+s" / "copy" â†’ keyboard capabilities)
        â–¼
ToolRegistry: computer.type / press_key / hotkey / key_down / key_up /
              copy / paste / select_all   (gated: 'keyboard.control',
              default-deny; type & paste & hotkey = 1 attempt max)
        â–¼
KeyboardControlService
   1. validation: key/modifier whitelist (client-side registry), text length
      â‰¤ 2000, control chars stripped â€” invalid input never reaches the OS
   2. permission + cancellation checkpoints before dispatch
   3. execute via KeyboardBackend (PowerShellKeyboardBackend â†’ local server â†’
      persistent worker â†’ user32 SendInput: KEYEVENTF_UNICODE for text,
      virtual-key down/up for keys, modifier-guarded hotkeys with `finally`
      release)
   4. VERIFY: Phase 4 signature diff, or expected-text matching against a
      fresh provider analysis when expectText is supplied
   5. duplicate-typing protection: an uncertain type result is reported as a
      NON-retryable failure ("text may already be inserted") â€” never resent
   6. stuck-key protection: explicit key_down holds are tracked and released
      automatically on any failure/cancellation/unmount
        â–¼
KeyboardActionResult {keys, typedCharacters, deliveryUncertain, textPreview
                      (sensitive input fully masked), verification, summary}
```

- **Sensitive input** (passwords, tokens, api keys â€” pattern-detected) is
  masked in every summary/result and never logged or stored; clipboard
  contents are never read by Krisha's copy/paste tools.
- **Server**: `/api/computer/keyboard` re-validates keys against its own
  whitelist, escapes text for the PowerShell protocol, and shares the
  persistent PowerShell worker with the mouse endpoint.
- **Real-machine note**: automated end-to-end verification against a live
  desktop is only reliable when the user is not actively using the machine
  (focus contest); `scripts/real-machine-check-keyboard.ts` implements the
  Notepad workflow (focus â†’ type â†’ Enter â†’ Ctrl+A â†’ clipboard verify) with an
  active-window guard that refuses to type into an unrecognized foreground app.

## 13. Computer-use agent (Phase 7)

```
planner: compound desktop task (â‰¥2 computer-action clauses)
        â†’ single `computer.use` step (+ trailing chat.report)
        â–¼
Agent Core step (task state, step limits, timeout, cancellation,
                 permissions: screen.observation + mouse.control +
                 keyboard.control â€” all three on the tool contract)
        â–¼
ComputerUseAgent.run(goal)  â”€â”€ per action:
   1. OBSERVE  fresh capture every action cycle (observer cache reused
               only inside an action's targeting/verification)
   2. GUARD    active-window tracked; focus change â‡’ recovery re-observe
   3. PLAN     HeuristicActionDecider â†’ ordered intents (planner parsing)
   4. ACT      Phase 5/6 services (semantic targeting, validation)
   5. VERIFY   per-action screen-change evidence + bounded waitForQuiet
               (cheap signature diffs, adaptive 250/500/1000ms intervals)
   6. RECOVER  re-observe â†’ re-resolve â†’ one safe alternative (scroll);
               bounded by maxRecoveriesPerAction; then stop honestly
        â–¼
ComputerUseResult {status: completed|partial|failed|cancelled,
                   per-action records with verified evidence,
                   focusChanges, observations, honest summary}
```

- **Reuse, not duplication**: the orchestrator adds closed-loop behavior only;
  Agent Core, vision, mouse, keyboard, permissions, events, and memory are the
  Phase 1â€“6 systems unchanged.
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
planner: compound browser task (â‰¥2 browser clauses incl. â‰¥1 on-page
         interaction) â†’ single `browser.use` step (+ chat.report)
         On-page phrases ("click X on the page", "find X on this page",
         "scroll until X") classify via classifyBrowserPhrase.
        â–¼
Agent Core step ('browser.interaction' permission; state_check verification)
        â–¼
BrowserAgent.run(goal, intents)  â”€â”€ per action:
   navigate (http/https only; schemes rejected; bounded load wait;
             verified via URL/title/heading evidence)
   find     (bounded state: 25 links / 25 buttons / 25 fields / 10 headings)
   click    (element by visible text â†’ verify URL/content change)
   type     (field by placeholder/name/label; sensitive input masked)
   scroll / scroll-until / bounded wait / back / forward / refresh
        â–¼
BrowserState (url, title, ready, links, buttons, fields, headings, tabs;
              bounded, no page history) + BROWSER_* events
```

- **Transport**: `browserCdp.ts` (server-side) drives a Krisha-owned
  HEADLESS Chrome/Edge over the Chrome DevTools Protocol using Node's built-in
  WebSocket â€” zero npm dependencies, dedicated throwaway profile, the user's
  own browser is never touched. Endpoints expose TYPED actions only
  (`/api/browser/state|navigate|back|forward|refresh|click|type|scroll|tabs`);
  callers cannot inject arbitrary JS.
- **Fallback**: when the controlled browser is unavailable, desktop-level
  interaction falls back to the Phase 7 Computer-Use Agent (screen vision +
  Phase 5/6 mouse/keyboard) â€” no second mouse/keyboard implementation.
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
         is X running/close X) â†’ filesystem.* / application.* tools
         (compound "find X and open it" = one filesystem.find_open step)
        â–¼
Agent Core step â”€â”€ permission gates:
   filesystem.read  (granted)  â†’ list/search/inspect/read/open
   filesystem.write (DENIED)   â†’ create/rename/copy/move/delete
   application.launch (granted)â†’ app find/launch/status/close/focus
        â–¼
systemAgentServer.ts (server-side, Node fs built-ins)
   resolveSafePath: canonicalize â†’ allowed roots (homedir/tmp/cwd;
   relative paths resolve against TEMP) â†’ traversal rejected;
   writes denied in Windows system locations
   reads: text extensions only, 64KB bounded, binary-sniffed, offset paging
   lists/searches: bounded (200 entries / 2000 scanned / depth 4)
        â–¼
verification (evidence-based, in FilesystemService/ApplicationService):
   create â†’ re-inspect exists; rename â†’ old gone + new exists;
   copy â†’ destination size match; move â†’ source gone + dest exists;
   delete â†’ target no longer exists; launch â†’ process-table check
   (uncertain reported honestly when evidence is unavailable)
        â–¼
FS_OPERATION_* / APP_* events; transient failures retried once (reads
   only); destructive ops never retried; cancellation via tool signals
```

- **Application discovery**: Start Menu shortcuts (ProgramData + user) and
  PATH executables, bounded (150 apps) and cached (5-min TTL). Launch is
  allowlist-based by discovered name or validated .exe path â€” never an
  arbitrary command string. Status via Get-Process, close via taskkill PID,
  focus via AppActivate.
- **Screen-vision/computer-use boundary**: the system layer owns non-visual
  operations; window-visible confirmation (e.g. after open_file/launch) is
  delegated to Phase 4 observation or Phase 7 computer-use, reported as
  `uncertain` until observed.
- **Memory safety**: file contents, paths of sensitive files, and process
  details are never stored â€” the Phase 2 service only receives workflow-level
  outcomes through the standard task-completion bridge.

## 16. Multi-step autonomy (Phase 10)

```
planner: extractGoal â†’ decompose into ordered plan steps (clauses/compound)
         â–¼
Tool chaining: producer step (outputKey: "found")
               consumer step ({$context: "found.matches.0.path"})
         â–¼
Agent Core execution loop:
   1. DEPENDENCY CHECK: step.dependsOn evaluated against prior step statuses
      (unmet dependency â†’ status: 'skipped')
   2. CONDITION EVALUATION: step.condition evaluated against task.context
      (context_exists | context_missing | context_equals | context_contains
       unsatisfied â†’ status: 'skipped')
   3. CONTEXT RESOLUTION: resolveContextRefs replaces {$context: path}
      placeholders with live values from task.context
   4. STEP DISPATCH & TIMEOUT: withTimeoutAndAbort + AbortSignal,
      permission verification, retry policy
   5. VERIFICATION: evidence-based verification; honest uncertainty
      propagates (uncertain output â†’ step.status: 'uncertain', not completed)
   6. CONTEXT PERSISTENCE: boundContextValue truncates output to 4KB preview
      before storing under step.outputKey into task.context
   7. OBJECTIVE COMPLETION CHECK: plan.evidenceKey presence in context
      triggers early completion of remaining steps
         â–¼
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
        â–¼
AgentCore â†’ RecoveryManager.handleFailure
   1. GUARD     abort signal checked first; cancellation short-circuits recovery
   2. CLASSIFY  classifyFailure: error text + ToolResult.errorKind â†’ 14-part
                taxonomy (TRANSIENT, TIMEOUT, STALE_STATE, TARGET_NOT_FOUND,
                FOCUS_LOST, NAVIGATION_CHANGED, PERMISSION_DENIED,
                INVALID_INPUT, TOOL_FAILURE, VERIFICATION_FAILURE,
                DEPENDENCY_FAILURE, CONTEXT_FAILURE, UNSAFE_OPERATION, UNKNOWN)
   3. POLICY    RecoveryPolicy.evaluate â†’ RecoveryDecision
                - budgets: maxAttemptsPerStep (2), maxAttemptsPerTask (6),
                  maxRepeatedIdenticalFailures (2) â†’ SAFE_STOP when exceeded
                - non-recoverable classes (PERMISSION_DENIED, UNSAFE_OPERATION,
                  INVALID_INPUT, DEPENDENCY_FAILURE, CONTEXT_FAILURE) â†’ SAFE_STOP
                - idempotency guard: side-effecting capabilities (clicks, typing,
                  file writes, app launch/close) that TIMEOUT or fail VERIFICATION
                  are RE_OBSERVEd â€” never blindly retried
   4. EXECUTE   RecoveryStrategyExecutor runs the bounded strategy:
                RETRY Â· RE_OBSERVE (screen.observe / browser.state) Â·
                REFOCUS (application.focus) Â· RE_RESOLVE_TARGET Â·
                BROWSER_RECOVERY (browser.refresh) Â· ALTERNATIVE_TOOL Â·
                ROLLBACK (cleanupPath only) Â· SAFE_STOP â€” each with
                post-recovery verification evidence
   5. DECIDE    recovered â†’ core re-runs the step (RETRY, RE_OBSERVE, REFOCUS,
                BROWSER_RECOVERY), splices in an alternative step
                (ALTERNATIVE_TOOL), or continues;
                not recovered â†’ failed step output invalidated, task stops honestly
        â–¼
RECOVERY_* events (STARTED / CLASSIFIED / STRATEGY_SELECTED / ATTEMPTED /
                   REOBSERVED / VERIFIED / SUCCEEDED / FAILED / ABORTED),
SAFE_STOP_TRIGGERED; RecoveryAttempt history (sanitized, bounded to 500 chars)
```

- **Context safety (`RecoveryContextManager`)**: every `{$context}` reference in a
  step input is validated before execution; keys marked INVALID (failed producer)
  or missing from the task context stop the step before it runs. Failed step
  outputs are deleted from `task.context` and marked INVALID so stale values can
  never silently flow into downstream steps.
- **Bounded by design**: no strategy loops, no unbounded retries â€” every recovery
  path consumes from the same explicit budget and every attempt is recorded in the
  sanitized `RecoveryAttempt` history (passwords/tokens redacted).
- **Test suite**: `scripts/test-recovery-phase11.ts`
  (`npx tsx scripts/test-recovery-phase11.ts`) covers the classifier, policy
  budgets/idempotency, context safety, executor verification, manager state
  machine, and AgentCore integration (retry, re-observe + re-run, alternative
  step injection, safe stop on invalid context).

## 18. Learning + workflow acquisition (Phase 12)

```
TASK_COMPLETED â”€â”€â–¶ LearningService.learnFromTask
TASK_FAILED    â”‚    verified success â†’ create/reinforce workflow (confidence â–²)
USER_MESSAGE   â”‚    failure â†’ evidence against the matching workflow only
TOOL_COMPLETED â”‚                 (confidence â–¼; failures never create workflows)
TOOL_FAILED    â”€â–¶ per-capability strategy statistics
        â–¼
LearningWorkflowStore (krisha_learning_workflows_v1, schemaVersion 1,
â”‚                      repair-on-load, bounded: 40 workflows / 20 evidence /
â”‚                      10 corrections / 60 strategy entries; lowest-confidence
â”‚                      stalest evicted first)
â”‚
â”œâ”€â–¶ WorkflowAwarePlanner (thin decorator over the Phase 1 Planner):
â”‚     makePlan â†’ planFromWorkflow: is there a confident, environment-compatible
â”‚     workflow for this goal? YES â†’ instantiate steps as a plan TEMPLATE
â”‚     (plan.learnedFrom recorded); NO â†’ inner planner plans normally
â”‚
â””â”€â–¶ mirrorToMemory: reusable workflows reflected into the Phase 2
    MemoryService (category 'workflow', workflowId link only)
        â–¼
Every reused step still runs the full Agent Core stack â€” verification,
retry, recovery, permissions, cancellation, timeouts (Phase 12 adds a
memory of WHAT worked; it does not add a second execution path)
```

- **Workflow knowledge is structured data, never prose/screenshots**: goal
  pattern, required capabilities, ordered step templates (toolName/capability/
  sanitized inputTemplate/contextRefs/outputKey), evidence list, corrections,
  confidence, version + version history.
- **Confidence is deterministic and bounded** (spec Â§7): verified_success +0.1,
  unverified_success +0.01, verified_failure âˆ’0.2, unverified_failure âˆ’0.05,
  clamped [0,1]. Reuse requires the 'usable' level (â‰¥ 0.45) â€” a workflow must
  prove itself with a verified success after creation before auto-reuse.
- **Reuse ranking is local and deterministic** (no model calls): score =
  0.6Â·goalSimilarity + 0.25Â·confidence + 0.15Â·environmentCoverage; every step
  must resolve to a concrete tool in the CURRENT registry (by name, or by
  capability as adaptation); `REUSE_MIN_SCORE = 0.55` and full coverage required.
- **Corrections**: `detectCorrection` (Phase 2) on USER_MESSAGE â†’ durable
  correction attached to the matching workflow + small bounded confidence
  reduction; corrections are also stored in Phase 2 memory.
- **Adaptation**: a new verified success with a different step sequence bumps
  the workflow version (bounded history) instead of fossilizing or duplicating;
  tool replaced via capability keeps reuse alive when the environment changes.
- **Safety**: workflows containing high/critical-risk tools are never learned;
  secrets are stripped from input templates (`sanitizeTemplate` â€” sensitive
  keys and secret-like values redacted, values truncated); learning never
  writes source code, permissions, or settings (no self-modification); all
  store writes are bounded and corruption-tolerant.
- **Outcome honesty**: `unverified` outcomes barely count (+0.01/âˆ’0.05);
  failure evidence and known failure points are recorded even when the failed
  task executed fewer steps than the full plan (failed steps included in
  evidence; skipped steps are not).
- **Debug/inspection**: `learning.list() / get() / disable() / forget() /
  strategyStats() / stats()` â€” plus `window.__KRISHA_AGENT__.learning` in the
  browser (DevTools only, no UI).
- **Test suite**: `scripts/test-learning-phase12.ts`
  (`npx tsx scripts/test-learning-phase12.ts`) â€” 70 assertions covering
  preference learning, correction learning, workflow learning, reuse, failed
  strategies, environment adaptation, duplicate prevention, persistence across
  restart, learning safety, resource bounds, and planner fallback/versioning.

## 19. Adaptive screen observation (Phase 13)

```
EVENT BUS (existing Phase 1 events)
  MOUSE_CLICK_COMPLETED / KEYBOARD_ACTION_COMPLETED / BROWSER_NAVIGATED /
  APP_* / FS_OPERATION_COMPLETED / RECOVERY_* / SCREEN_CHANGED / TASK_*
        â”‚  (AdaptiveObserver.attach â€” no polling loop, no timers)
        â–¼
AdaptiveObserver â”€â”€ beginTask/endTask/stopObservation/resume
  â”‚   pending-trigger queue (bounded, TTL 5s, priority-deduped)
  â”‚   context feeds: recordAction / notifyVerification / notifyChange / notifyRecovery
  â–¼
Decision engine (pure, deterministic â€” observationDecider.decide)
  rules in order: workflow freshness + recovery + failed verification
  â†’ budget gates â†’ idle gate â†’ explicit/no-prior/stale â†’ change-awareness
  â†’ filesystem-step preference â†’ post-action â†’ default reuse
  output: OBSERVE_NOW | OBSERVE_AFTER_ACTION | OBSERVE_REGION |
          REUSE_VALID_STATE | DELAY_OBSERVATION | STOP_OBSERVATION (+reason)
  â–¼
ObservationBudgetTracker (per task: 24 captures, 6/10s window,
  3 consecutive, 4 unchanged, 2 retries â€” structured exhaustion statuses)
  â–¼
ScreenObserver (Phase 4, unchanged behavior; new optional `region` option)
  capture â†’ crop (region) â†’ local analysis â†’ bounds translated back to
  full-screen coordinates; change signatures ALWAYS computed on the full frame
```

- **New module** `src/agent/observation/`: `observationTypes.ts` (requests,
  policy, results, triggers, priorities LOWâ€“CRITICAL, modes, regions, budgets,
  changes, decisions), `observationPolicy.ts` (mode resolution: idle /
  active_task / after_action / uncertain / rapid_change / settled with
  mode-specific reuse windows â€” idle 60s â‰ˆ off, active 1.5s, rapid 400ms),
  `observationBudget.ts`, `observationDecider.ts`, `adaptiveObserver.ts`.
- **Event-driven, never polling**: no intervals, no background workers.
  Events only RECORD triggers; captures happen solely inside explicit
  `observe()` calls driven by the Agent Core / Computer-Use / Browser flows.
  HIGH/CRITICAL events (recovery, failed verification) surface as pending
  triggers consumed by the next decision â€” never as reflex captures.
- **Budgets** (spec Â§4): per-task cap, sliding rate window, consecutive-capture
  cap, unchanged-screen cap, bounded retries. Exhaustion returns structured
  statuses (`budget_exhausted` / `stopped` with machine-readable reason,
  `delayed` with retryAfterMs) â€” never an uncontrolled loop.
- **Change-awareness** (spec Â§5): signature fractions classify as none / minor
  (<2%) / relevant (<25%) / major / unknown; streaks escalate policy to
  rapid_change (tighter) or settled (looser). Unchanged + fresh â†’ reuse with
  zero captures.
- **Region-awareness** (spec Â§6): heuristic presets (browser_content,
  dialog_area, target_control, verification_region, active_application) crop
  the frame BEFORE analysis (cheaper inference); detected bounds are mapped
  back to full-screen coordinates so mouse/keyboard targeting stays correct
  (`src/agent/vision/regionCrop.ts`). Full-screen remains the default.
- **Task-awareness** (spec Â§7): filesystem-type steps prefer filesystem
  verification (`REUSE_VALID_STATE`); post-action triggers verify the result;
  browser state reads never trigger observations (CDP-first).
- **Stale-state protection** (spec Â§8): decisions consult the policy reuse
  window; recovery and failed verification always force fresh captures; a
  fresh capture clears recovery state. Observation failures return structured
  errors (`permission_denied`, `timeout`, â€¦) for Phase 11 recovery â€” never
  silent stale reuse.
- **Computer-Use integration** (spec Â§10): the Phase 7 loop's OBSERVE step now
  consults the adaptive layer (reuse when fresh, capture when stale/forced,
  fresh on focus change); action failures feed `notifyVerification('failed')`,
  recovery feeds `notifyRecovery(true)`. Closed-loop architecture unchanged.
- **Browser integration** (spec Â§11): the Phase 8 agent requests observation
  only after navigation or when CDP state is insufficient (best-effort,
  browser-native state stays authoritative).
- **Learned workflow integration** (spec Â§12): `WorkflowStep.observation`
  (`requireFresh`, optional `region`) is learned (Phase 12 `toWorkflowStep`),
  carried on `PlanStep.observation`, and enforced by the Agent Core before the
  step runs â€” reused workflows never replay stale screen state.
- **Privacy** (spec Â§13): no image data in the observation layer, no new
  persistence; task end purges the ScreenObserver snapshot cache; cropped
  frames carry no `dataUrl` copy; observation metadata is JSON-safe
  (asserted in tests).
- **Cancellation/recovery** (spec Â§14): `observe()` accepts AbortSignals and a
  hard timeout; failures are structured (`failed`/`cancelled` with kind) and
  retried at most `maxRetries` times through the retry budget.
- **Debug/inspection**: `adaptiveObserver.getDiagnostics()` /
  `budgetStatus()` / `getLastDecision()`; exposed as
  `window.__KRISHA_AGENT__.adaptiveObserver` (DevTools only, no UI).
- **Test suite**: `scripts/test-observation-phase13.ts`
  (`npx tsx scripts/test-observation-phase13.ts`) â€” 91 assertions covering
  policy/decision determinism, idle behavior, active-task behavior,
  post-action observation, change detection, unchanged-screen reuse,
  stale-state detection, budgets + exhaustion, regions, task/browser/
  computer-use/workflow/recovery integration, cancellation, timeout,
  permission failure, privacy, no-polling guarantees.
- **Real-machine check**: `scripts/real-machine-check-observation.ts`
  (needs the local server) â€” observes state, verifies unchanged-screen reuse,
  performs a harmless reversible cursor nudge via the real backend, verifies
  adaptive fresh re-observation + real change classification, verifies no
  polling, restores the original state, bounded capture counts.
- **Limitations**: region presets are heuristic rectangles (no per-window
  rects without extra OS queries); screen capture itself still requires the
  interactive browser-consent flow (Phase 4); the decider is deliberately
  rule-based (no learned observation policy yet); screenshot content is never
  persisted anywhere.

## 20. Multimodal intelligence (Phase 14)

New module `src/agent/multimodal/` â€” a unified, bounded reasoning layer that
combines evidence from multiple modalities (text, screenshots, UI state,
browser state, application state, documents, audio transcripts, structured
tool results) instead of treating each input independently. Agent Core
remains the central brain; no vision/browser/control systems were duplicated.

**Module layout**:
- `multimodalTypes.ts` â€” `ModalityType` (9 registered kinds),
  `ModalityObservation` (type, source, timestamp, confidence, metadata,
  sensitivity, freshness TTL, stepId), payloads per modality, `Sensitivity`
  (`public`/`normal`/`sensitive`/`highly_sensitive`), `MultimodalConclusion`
  (claim, confidence, supporting/contradicting evidence, uncertainties,
  conflicts, requiredVerification), `MultimodalReasoningProvider` interface
  (spec Â§15 â€” pluggable external models; the system works fully without one).
- `modalityRegistry.ts` â€” per-modality descriptors: base priority
  (fresh tool state 100 > UI/screenshot 85 > browser 80 > app 75 > document
  70 > text 60 > image 50 > transcript 45), TTL (freshness windows), default
  sensitivity, redaction flags. `effectivePriority` decays with age and low
  confidence â€” stale evidence never outranks fresh evidence.
- `modalityNormalizer.ts` â€” converts raw inputs (text, ScreenState,
  BrowserState, app status, tool outputs, URLs, transcripts, documents) into
  `ModalityObservation`s: extracts summaries/keywords, computes content
  hashes (dedup), assigns confidence, and runs the **secret scanner** â€”
  passwords, API keys, tokens, JWTs, card-like numbers are redacted
  (`[REDACTED]`) and escalate the observation to `highly_sensitive`.
- `multimodalContext.ts` â€” the task-scoped evidence store: bounded
  (`maxObservations`, `maxPerModality`, `totalCharBudget`), per-modality
  caps (newest kept), content-hash dedup (refresh not duplicate), TTL-based
  staleness (`removeStale`), step association (`forStep`), task scoping
  (`beginTask` clears, `endTask` purges), `priorityOf` (freshness Ã—
  registry Ã— confidence), and `providerSafeDigest()` â€” a bounded,
  sensitive-evidence-free string for external providers.
- `multimodalAnalyzer.ts` â€” selective, on-demand gathering: `gather(ctx,
  kinds)` only touches the requested modalities (browser gather never
  captures the screen; screen gather goes **through the Phase 13 adaptive
  observer** â€” reuse when fresh, `requireFreshScreen` forces a capture, and
  no pixel data is stored, only structured UI summaries). Also: application
  status via the Phase 9 service (unverified reads are never recorded),
  text recording, and document understanding with bounded chunking +
  keyword-scored relevant-section selection (huge documents never load
  fully). Every gather honors `timeoutMs` and `AbortSignal`.
- `multimodalReasoner.ts` â€” deterministic cross-modal reasoning:
  question classification (find-element, verify-state, active-application,
  summarize-document, continue-workflowâ€¦), target extraction, evidence
  matching across modalities, source-priority resolution, **conflict
  detection** (browser URL vs screen URL; app reported open vs absent on
  screen; text vs evidence), confidence math (multi-source bonus,
  single-source cap, conflict penalty) and honest uncertainty â€” no
  fabricated elements, zero confidence when evidence is missing, and
  `requiredVerification` steps listed. If the local answer is
  low-confidence AND an external provider is set, the provider is consulted
  with the `providerSafeDigest` (timeout- and cancellation-guarded); the
  local result stands otherwise.
- `multimodalVerifier.ts` â€” independent-evidence verification of
  expectations ("X is open", "text \"â€¦\" is visible", URL expectations):
  gathers agreeing/contradicting evidence from 4 families (application
  state, visible screen, browser-native state, structured tool results),
  requires â‰¥2 evidence kinds for `confirmed` (a single fresh verified tool
  result may also confirm), reports conflicts, and always lists the next
  verification step when independent confirmation is missing.
- `multimodalService.ts` + `index.ts` â€” the facade: task lifecycle on the
  Event Bus (TASK_STARTED opens a scope; TOOL_COMPLETED/TOOL_FAILED record
  real tool evidence with step association; TASK_COMPLETED/TASK_FAILED
  purge everything), plus the integration hook consumed by the Phase 7
  Computer-Use Agent (`multimodal.recordObservation(state)` â€” CU
  observations become queryable multimodal evidence; the CU closed loop is
  unchanged).

**Privacy (spec Â§13)**: every modality carries a sensitivity
classification; secrets are redacted at normalization time and never
persisted; `providerSafeDigest()` excludes sensitive and highly-sensitive
evidence from anything sent to an external provider; screenshot/screen
observations store structured summaries only â€” no image data, no new
persistence anywhere; task end purges all evidence.

**Resource control (spec Â§14)**: strictly on-demand â€” no background
processing, no polling (captures happen only inside explicit `gather()`
calls; the Phase 13 no-polling property is asserted in tests), bounded
context sizes, per-modality caps, TTL expiration, content-hash dedup,
selective gathering, document chunking with relevant-section selection.

**Provider abstraction (spec Â§15)**: `MultimodalReasoningProvider` is a
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
  (`npx tsx scripts/test-multimodal-phase14.ts`) â€” 150 assertions covering
  registry priorities, normalization + secret redaction, context bounds/
  dedup/staleness/step association/task scoping, document chunking +
  section selection, cross-modal reasoning, source prioritization, conflict
  detection, confidence/uncertainty math, verification (confirmed/refuted/
  uncertain + cancellation), service/bus lifecycle, Computer-Use evidence
  recording, provider enrichment/timeout/cancellation, privacy (no pixels,
  secret rejection, digest exclusion), resource discipline (no polling,
  selective gathering), gather timeout/cancellation.
- **Real-machine check**: `scripts/real-machine-check-multimodal.ts`
  (needs the local server) â€” launches Character Map through the Phase 9
  allowlist, gathers real process-table evidence via the Phase 14 analyzer,
  types a harmless phrase through the real keyboard backend (no Enter) plus
  a reversible cursor nudge, records both action results as tool evidence,
  runs a Phase 13 screen observation (synthetic cursor source, honestly
  labeled â€” real capture needs interactive consent), verifies "charmap is
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

## 21. Proactive intelligence (Phase 15)

New module `src/agent/proactive/` â€” an event-driven layer that notices
useful opportunities or important changes and decides whether proactive
assistance is appropriate. The pipeline is strictly
EVENT â†’ SIGNAL â†’ CONTEXT â†’ DECIDE â†’ SAFETY CHECK â†’ OPTIONAL ACTION â†’
VERIFY â†’ MEMORY. Krix never continuously watches the user: everything is
triggered by Event Bus events, with bounded one-shot delayed checks only
for the unfinished-task follow-up.

**Module layout**:
- `proactiveTypes.ts` â€” `ProactiveSignal` (type, dedupKey, timestamp,
  expiry, confidence/importance/urgency, â‰¤4 bounded redacted evidence
  items, taskId), `ProactiveOpportunity` (id, type, trigger, context,
  scores, `expectedBenefit`, `intrusiveness`, `risk`, `expiresAt`,
  `requiredPermissions`, optional `ProactiveSuggestedAction`, evidence,
  status), opportunity statuses (DETECTED/CONSIDERING/SUPPRESSED/
  PRESENTED/ACCEPTED/REJECTED/EXPIRED/EXECUTED/VERIFIED/FAILED),
  `ProactiveActionLevel` (0 silent â€¦ 4 never-automatic), `ActivityState`
  (IDLE/FOCUSED/ACTIVE/BUSY/UNCERTAIN), `InterruptionBudgetConfig` +
  `DEFAULT_BUDGET`, `ProactiveSuggestion`.
- `proactiveSignals.ts` â€” `ProactiveSignalDetector.ingest(event)`: turns
  bus events (TASK_COMPLETED/FAILED/CANCELLED, USER_CORRECTION,
  WORKFLOW_LEARNED, BROWSER_NAVIGATED, SCREEN_CHANGED, APP_*,
  TOOL_VERIFIED, USER_MESSAGE inactivity) into structured signals.
  Deduplication by `dedupKey` with refresh-within-window semantics (the
  same entity never accumulates duplicate signals), a bounded
  `occurrences` counter so repeated same-entity patterns (e.g. the same
  correction twice) stay detectable, and TTL expiry. `ingestSignal()`
  accepts external structured signals (deadlines, other phases) after
  sanitization (clamped scores, capped TTL, bounded quotes).
- `proactivePolicy.ts` â€” deterministic pre-decision gates: expiry,
  duplicate suppression (same `dedupKey` never re-presented),
  rejection-suppression window, per-category cooldown, daily
  interruption budget, minimum presentation confidence. Every gate
  returns a structured reason that is recorded on the opportunity.
- `proactiveContext.ts` â€” bounded shared state: event ring buffer,
  signals, opportunities (capped at 100, oldest terminal entries
  pruned by `sweep()`), presented suggestions, rejection history,
  cooldowns, and the deterministic `activityState(now)` classifier â€”
  only user-driven events define presence, so system-generated events
  (e.g. WORKFLOW_LEARNED) can never make the user look active and
  suppress their own suggestions. `ProactiveContext` also exposes the
  follow-up scheduler hooks.
- `proactiveDecider.ts` â€” the deterministic two-stage decision engine
  (spec Â§4): policy gates â†’ LEVEL-4 hard block â†’ usefulness/evidence
  strength â†’ relevance window â†’ user-busy/non-interruption â†’
  informational suggestion (no action attached; accept() honestly
  reports "no executable action") â†’ permission + reversibility check
  (missing permissions become a REQUEST_CONFIRMATION, never a bypass) â†’
  action level. Low confidence always degrades to WAIT/RECORD_ONLY â€”
  Krix never fabricates a reason to interrupt. `minimumLevelFor(risk)`
  maps risk categories to minimum action levels; `isNeverAutomatic`
  categories are hard-blocked at LEVEL 4 even with everything granted.
- `proactiveScheduler.ts` â€” lightweight event-triggered scheduling:
  only bounded one-shot delayed checks (default: single inactivity
  follow-up for unfinished tasks), each with trigger, creation time,
  expiration, reason and a cancellation path; firing respects budget
  and expiry; `dispose()` clears everything (no background polling).
- `proactiveActions.ts` â€” `executeConfirmed()` runs a confirmed LEVEL-3
  action through the existing ToolRegistry with the caller's
  PermissionManager (Phase 3 permissions remain authoritative at the
  tool boundary â€” the registry re-checks). `verifySuggestionPresented()`
  verifies a suggestion was actually presented;
  `verifyAction()` prefers independent evidence (Phase 14 hook) and
  reports `uncertain` rather than claiming success without it.
- `proactiveService.ts` â€” the facade: `attach(bus)` wires the event
  flow; opportunity formation per signal type (task completion offers a
  screen-observation follow-up requiring `screen.observation`; workflow
  recognition and repeated corrections produce informational-only
  suggestions; unfinished tasks schedule the one-shot follow-up);
  `present()` emits a structured NOTICE; `accept()` re-checks LEVEL-4
  categories, executes only through the registry, then verifies and
  emits TOOL_FAILED for Phase 11 recovery on failure (no retry loops);
  `reject()` escalates suppression and, after repeated rejections,
  persists one bounded preference memory. `ingestSignal()` sanitizes
  external signals; `diagnostics()` exposes bounded counters.
- `index.ts` â€” public surface.

**Interruption budget (spec Â§5)**: `DEFAULT_BUDGET` bounds presented
suggestions per window, per-category cooldowns, rejection-suppression
windows (`rejectionSuppressMaxMs`), rejections-before-memory, and
minimum confidence thresholds for presenting vs executing. The same
condition never generates repeated suggestions (dedup), and repeated
user rejections suppress similar suggestions for a bounded period.

**Safety boundaries (spec Â§7/Â§13)**: LEVEL 0â€“4 as specified. Destructive,
credential, financial, security and similar categories are
`isNeverAutomatic` â€” hard-blocked at LEVEL 4 regardless of granted
permissions or confidence. Irreversible non-general actions are never
proactively suggestable. Missing permissions produce a confirmation
request, never a bypass. Phase 3 permissions, Phase 11 recovery, Phase
12 learning safety, Phase 13 observation policy and Phase 14 privacy
rules all remain authoritative â€” ProactiveService executes exclusively
through the existing ToolRegistry.

**Memory + learning integration (spec Â§8/Â§9)**: relevant memories are
recalled (bounded, â‰¤3 Ã— 160 chars) for each decision; learned-workflow
signals feed workflow-recognition opportunities, but recognition never
auto-authorizes execution. Memory writes happen only after repeated
rejections (validated preference, one bounded record) â€” proactive
events are not hoarded.

**Multimodal integration (spec Â§10)**: verification prefers independent
evidence via a Phase 14 gather hook; conclusions follow Phase 14
source-priority and uncertainty rules â€” weak sources are never combined
into manufactured confidence.

- **Bridge wiring**: `ProactiveService` is constructed in
  `src/agent/bridge.ts` with the registry, PermissionManager, Event Bus,
  memory and multimodal context; exposed as
  `window.__KRISHA_AGENT__.proactive` (DevTools diagnostics only, no UI
  changes).
- **Test suite**: `scripts/test-proactive-phase15.ts`
  (`npx tsx scripts/test-proactive-phase15.ts`) â€” 107 assertions
  covering signal creation/dedup/expiry, activity classification, all
  policy gates, decision levels + safety blocks, scheduler bounds/
  cancellation, registry-gated execution + verification, service event
  flow, workflow/correction/unfinished-task scenarios, rejection
  suppression + memory, multimodal/provider-free verification, privacy,
  bounded resources and the no-polling guarantee.
- **Real-machine check**: `scripts/real-machine-check-proactive.ts`
  (needs the local server) â€” aborts if Character Map is already running,
  launches it through the Phase 9 allowlist surface, verifies a real
  task-completion suggestion is presented and gated by the real
  PermissionManager (`screen.observation` missing â†’ confirmation
  required; accept() refused â€” no unauthorized action), runs a LEVEL-3
  read-only `application.status` against the running app after explicit
  confirmation and verifies the result against the real process table,
  asserts a destructive `filesystem.delete` opportunity is hard-blocked
  at LEVEL 4, closes the app and confirms cleanup, and asserts no
  scheduled checks remain.
- **Privacy (spec Â§14)**: no screenshots or raw screen content are
  stored; evidence quotes are bounded (â‰¤160 chars, â‰¤4 items); external
  signals are sanitized (clamped scores, capped TTL); secrets are never
  persisted; memory writes are single bounded preference records.
- **Performance (spec Â§15)**: strictly event-driven â€” no screen polling,
  no multimodal processing loop, no background model, no workers;
  bounded queues/maps with sweep-based pruning; dedup + cooldowns + TTL;
  AbortSignal support, timeouts and cancellation on every execution and
  scheduled check; deterministic local reasoning always runs first.
- **Limitations**: activity classification is approximate (event-history
  based, not attention-aware); the interruption budget is heuristic and
  global (not per-user-profile); informational suggestions are
  non-executable by design (acceptance offers nothing to run); the
  follow-up scheduler only supports one-shot delayed checks, not
  calendars/reminders (deadline signals arrive via `ingestSignal`);
  verification without an independent-evidence hook reports `uncertain`
  honestly rather than confirming.



## 22. Deep research capability (additional â€” outside the numbered roadmap)

> **Roadmap position.** Deep Research is NOT roadmap Phase 16. The official
> Phase 16 is **Advanced Planning** (the hierarchical PlanEngine in
> `src/agent/planning/` with `scripts/test-planning-phase16.ts`). Official
> roadmap: 16 Advanced Planning â†’ 17 Model Routing + Performance â†’ 18 Safety +
> Permission Hardening â†’ 19 Long-Run Autonomy â†’ 20 Final Agent Integration.
> Deep Research is an additional capability built ON TOP of the Agent Core /
> Planning architecture, kept modular and isolated in `src/agent/research/` so
> it can integrate cleanly wherever the roadmap later places it.

The Deep Research capability gives Krisha genuine multi-step, citation-tracked
research: INPUT â†’
understand the goal â†’ decompose into sub-questions â†’ search â†’ inspect sources â†’
extract evidence â†’ cross-check â†’ detect gaps/conflicts â†’ follow-up rounds â†’
synthesize a cited report. Domain-agnostic by construction (no Megha-specific
agriculture/geospatial logic); the same pipeline serves technology, science,
history, current events, documentation, products and general questions.

### 22.1 Architecture

```
 HeuristicPlanner (research trigger: research/investigate/look into/
 find out/compare X and Y)                     Agent Core (single executor)
        â”‚                          â–²
        â–¼                          â”‚
   PlanStep: research.run â”€â”€â”€â”€â”€â”€â–¶ ToolRegistry.execute (Phase 3 contract:
        capability 'research.run'         validation â†’ permissions â†’ events â†’ timing)
        â”‚
        â–¼
 ResearchService.runResearch (bounded loop, no polling, AbortSignal-aware)
   plan â†’ (search â†’ select â†’ read_source â†’ extract_evidence â†’ analyze â†’
           gaps? â†’ next round)* â†’ synthesize
        â”‚                                   â”‚
        â–¼                                   â–¼
 researchPlanner (deterministic     searchBackends (injectable)
   decomposition)                     â”‚
 sourceInspector (tier/quality/       â–¼
   sentences)                       HttpResearchBackend â†’ local server
 evidenceExtractor (verbatim        /api/research/search (DDG html â†’ lite â†’ Bing RSS)
   quotes)                          /api/research/fetch (server-side fetch +
 claimVerifier (support/conflicts)    HTMLâ†’text, bounded, SSRF-guarded)
 gapDetector (coverage â†’ follow-ups)
 sourceComparator (agreement/ranking)      FakeResearchBackend (tests)
 synthesizer (report + [n] citations)      Phase 14 hook: round summaries become
                                           bounded text evidence
```

Modules live in `src/agent/research/`: researchTypes (bounded dossier model +
ResearchLimits), researchPlanner, researchBackends, sourceInspector,
evidenceExtractor, claimVerifier, gapDetector, sourceComparator, synthesizer,
researchService, researchTools (Phase 3 tools), index. The official Phase 16
planning foundation (Advanced Planning: hierarchical PlanEngine, `planning/`)
is reused unchanged: every research task runs as a validated node in the same
plan tree the Agent Core executes.

### 22.2 Tools (registered like every other capability)

- `research.plan` â€” decomposition (deterministic, no network, riskLevel safe)
- `research.search` / `research.read_source` â€” network tools, gated by the
  existing `browser.interaction` permission (revocable, default-granted)
- `research.extract_evidence` / `research.analyze` / `research.synthesize` â€”
  local dossier analysis (no permission, no network)
- `research.run` â€” the closed-loop orchestrator the planner schedules (like
  Phase 7 `computer.use` / Phase 8 `browser.use`); it executes the tools above
  THROUGH the registry so recovery, learning, multimodal and events all see it.

### 22.3 Honesty rules (spec-mandated)

- Factual statements are verbatim quotes with [n] citations â€” never paraphrased
  into anonymity; every citation resolves to an inspected URL.
- Verdicts: `supported` (â‰¥2 independent registrable domains agree),
  `single_source` (labeled uncertain, never settled fact), `conflicting`
  (numeric or negation disagreement reported side by side, never averaged),
  `unverified` (becomes an open question).
- Confidence formula: `high` ONLY when every sub-question has independent
  multi-source support; otherwise `medium`/`low`. Insufficient evidence â†’
  `RESEARCH_INSUFFICIENT_EVIDENCE` event + honest low-confidence report.
- Synthesis beyond quotes and limitation notes are labeled `inference`.

### 22.4 Bounds & performance

- Hard caps: â‰¤5 sub-questions, â‰¤3 rounds, â‰¤8 searches, â‰¤10 sources, â‰¤4 hits kept
  per search, â‰¤4 evidence quotes per source, â‰¤8 per sub-question, â‰¤320-char
  quotes, â‰¤4KB source excerpts, â‰¤6KB report, â‰¤8 dossiers (LRU by task end),
  120s wall-clock budget; every number in `DEFAULT_RESEARCH_LIMITS`.
- Strictly on-demand: no polling, no timers, no background model, no workers;
  the loop advances only on awaited backend responses and checks the
  AbortSignal between steps. Server endpoints cap responses (1.5MB raw /
  40KB text) and time out at 15s; private network targets are refused (SSRF).
- Query dedupe by normalized tokens (a query is never re-searched); source
  dedupe by URL and domain diversification (â‰¤2 sources per registrable domain).

### 22.5 Tests & verification

- `scripts/test-research.ts` (npx tsx): **179 assertions, 0 failed** â€”
  planner decomposition, source quality, evidence extraction/relevance/dedupe,
  conflict detection (numeric + negation) and support counting, gap kinds +
  follow-up generation, comparison/ranking, synthesis/citations/confidence,
  every tool (schema, permission gating, events, dossier isolation), the
  bounded loop (multi-round coverage, budget stops, all-searches-fail,
  fetch-failure disclosure, conflicts end-to-end, cancellation, LRU pruning),
  planner non-hijack guarantees, Agent Core end-to-end through the official
  Phase 16 (Advanced Planning) planning layer, Phase 14 multimodal hook, HTTP
  backend error mapping, and bounded-resource/no-polling guarantees.
  Deterministic: scripted backends.
- `scripts/real-machine-check-research.ts` (needs local server): real search
  endpoint â†’ real source fetch â†’ real bounded research run through the registry
  â†’ full Agent Core delegation. Verified PASS on the real machine with
  independent evidence (real hits, real page text, real cited report).

### 22.6 Limitations

- Web search uses public engines server-side (DuckDuckGo html/lite â†’ Bing RSS
  waterfall) which rate-limit aggressively by IP; a blocked engine degrades to
  the fallback, and a fully blocked network yields honest low-confidence
  reports rather than errors. No JS-rendered page content (server-side fetch
  reads server-rendered HTML only).
- Conflict detection is lexical (numbers/negation/overlap) â€” it cannot catch
  semantic disagreements phrased without shared vocabulary; source quality
  tiers are domain-heuristic, not authority-aware.
- The research loop is deterministic/heuristic â€” no LLM step; sub-questions,
  relevance and synthesis are computed locally, which keeps the laptop
  footprint minimal at the cost of prose polish.
- Delegation triggers on explicit research verbs only; single-page lookups
  ("search X on Y") remain Phase 1 web actions, and mixed browser+research
  compound requests split per clause.

## 23. Advanced planning â€” official Phase 16

**Phase 16 â€” Advanced Planning** (official roadmap; distinct from Â§22, which is
an additional capability outside the numbered roadmap). The planning model:

```
GOAL â†’ SUBGOALS â†’ ACTIONS â†’ VERIFICATION â†’ (on mismatch) REPLANNING
```

Planning and execution stay separated: the PlanEngine decides WHAT/WHY/ORDER/
WHAT-SUCCESS-LOOKS-LIKE and never executes; the Agent Core remains the single
executor and the ToolRegistry the only execution surface (no second loop).

### 23.1 Architecture

```
 HeuristicPlanner (flat steps)          Agent Core (single executor)
        â”‚                                     â”‚
        â–¼                                     â”‚
 PlanEngine.attachPlan                        â”‚
   â”œâ”€ clarification gate (spec Â§13)           â”‚
   â”‚    ambiguous goal â†’ PLAN_CLARIFICATION_REQUESTED + honest stop
   â”œâ”€ buildHierarchy: GOAL â†’ SUBGOAL (domain-grouped) â†’ ACTION
   â”‚    expectedOutcome per action, conditions mirrored, deps: sequential
   â”‚    + explicit (step-id â†’ node-id)
   â””â”€ validatePlan: bounds, missing tools, cycles, impossible deps,
        missing verification, invalid nodes; permission gaps â†’ BLOCKED
        (not invalid) â€” permissions stay authoritative at execution
                                     â–¼
 Agent Core executes each step â†’ ToolRegistry.execute
        â”‚
        â–¼
 PlanEngine node lifecycle: pending â†’ ready â†’ running â†’ verifying â†’
   completed (ONLY when verified) / failed / skipped / blocked / cancelled
        â”‚
        â–¼ on unrecovered failure
 proposeReplan (bounded, deterministic):
   budgets (task/node replans, node retries, repeated failures, timeout) â†’
   duplicate-plan detection â†’ permission boundaries NEVER bypassed â†’
   corrective subtree: domain diagnosis (real read-only check) + ONE retry,
   rotating to the best-ranked ALTERNATIVE tool for the same capability when
   its declared input schema is compatible (spec Â§8; failed strategies do not
   repeat themselves)
        â”‚
        â–¼
 commitReplan splices the subtree after the failed step â€” completed work is
 preserved; the loop resumes from the current state (partial completion)
```

Modules in `src/agent/planning/`: planningTypes (bounded node model, limits,
snapshot types), planBuilder, planValidator, strategySelector (cheapest-
reliable ranking, modality preferences), clarification (deterministic
ambiguity detection), planEngine, index.

### 23.2 Capability map (spec Â§1â€“16)

| Spec area | Implementation |
|---|---|
| Hierarchical decomposition | buildHierarchy â€” simple goals stay single-subgoal |
| Dependency-aware planning | sequential + explicit deps; blocked/completed/skipped/failed states; cycles and impossible (forward) deps rejected pre-execution |
| Dynamic state tracking | PlanEngine.snapshot(): current action + subgoal, per-node status/verification/attempts/expected/condition/error, counts, permission blockers |
| Action verification | expectedOutcome per action; completed ONLY when tool success AND verification pass; unverified completion degrades the task to uncertain |
| Adaptive replanning | bounded corrective subtrees (diagnose â†’ retry), environment-derived reasons, replan/refusal accounting |
| Partial completion | corrective splice after the failed step; completed nodes keep status; remaining steps skipped, never re-run |
| Conditional planning | Phase 10 StepCondition (context exists/missing/equals/contains) mirrored onto plan nodes |
| Alternative strategies | strategySelector ranking + alternative-tool rotation in corrective retries (schema-compatible, permission-checked) |
| Planning vs execution | engine never executes; registry contract enforced on every action |
| Replanning limits | maxDepth 3, maxNodes 24, maxReplansPerTask 3, maxReplansPerNode 1, maxRetriesPerNode 3, maxRepeatedFailures 2, taskTimeoutMs 10min |
| Plan validation | planValidator (errors + warnings); malformed plans never execute |
| Plan adaptation | insert (corrective/adopted splices), mark obsolete (skips, evidence key), replace strategy (tool rotation), preserve completed work |
| User clarification | detectAmbiguity â€” "open X or Y"-style materially different plans stop with PLAN_CLARIFICATION_REQUESTED instead of guessing; single-interpretation goals never ask |
| Safety integration | permissions â†’ blocked nodes; replanning refuses to bypass; registry enforces at execution; confirmation thresholds untouched |
| Agent Core integration | attachPlan gate, node lifecycle events, replan splice, finishTask with verified-completion semantics |
| Deep Research compatibility | Deep Research (Â§22, additional capability) uses attachPlan via the Agent Core â€” unchanged |

### 23.3 Tests & real-machine verification

- `scripts/test-planning-phase16.ts` (npx tsx): **102 assertions, 0 failed** â€”
  hierarchy + grouping, validation (tools/deps/cycles/size/depth/permissions),
  engine lifecycle, verified completion + honest uncertainty, cancellation,
  permission blocks, bounded replanning (task/node budgets, repeated-failure
  and duplicate-plan guards), partial completion (no restart), conditional
  branches (true/false/skip), impossible dependencies, alternative-strategy
  rotation (+ incompatible-schema refusal), node retry budget, planning
  timeout, excessive depth, plan snapshot, user clarification (ask vs don't
  ask, task-level honest stop), Agent Core E2E (plan â†’ fail â†’ replan â†’
  verified completion), Phase 15 regression. Deterministic: injected clock,
  fake tools, no timers.
- `scripts/real-machine-check-planning.ts` (needs the local server; READ-ONLY):
  real hierarchical plan over real filesystem tools (dependency-ordered list â†’
  inspect) completes verified; a real unfulfillable read triggers one real
  diagnosis (directory listing) + retry, then the repeated-failure guard stops
  honestly with completed work preserved. Verified PASS on the real machine.

### 23.4 Correctness fix shipped with this phase

`PlanEngine.attachPlan` held an ALIAS of the Agent Core's live `plan.steps`
array; `commitReplan`/`adoptSplicedSteps` bookkeeping pushes therefore
duplicated corrective steps into the executing plan â€” invisible while
corrective steps failed (duplicates were skipped after the honest stop) but
causing DOUBLE EXECUTION once a corrective retry succeeded (exposed by the
alternative-strategy tests). The engine now keeps its own copy (same step
objects), so core-side splices are the single source of execution order.

### 23.5 Limitations

Decomposition is deterministic (domain-grouped subgoals from the existing
heuristic planner â€” no LLM step; planning quality inherits the Phase 1
planner's clause classification). Ambiguity detection is deliberately
conservative (explicit "X or Y" target alternatives only). Corrective
strategies cover computer/filesystem/application domains with deterministic
diagnoses; other domains rotate tools when possible and otherwise stop
honestly (browser/desktop recovery remains with Phase 11).

## 24. Model routing + performance (Phase 17)

**Phase 17 â€” Model Routing + Performance** (official roadmap). Goal: use the
smallest/cheapest/lightest capable path that reliably completes the task, and
escalate only when necessary â€” without reducing correctness, safety or
reliability, and without any new dependency.

### 24.1 What already existed (preserved, not rewritten)

- server.ts `generateContentWithFallback`: 4-model Gemini waterfall
  (3.8-flash â†’ 3.7-flash â†’ flash-latest â†’ 3.1-flash-lite), 2 attempts/model,
  500 ms backoff on transient errors (429/RESOURCE_EXHAUSTED/503/UNAVAILABLE),
  local in-character fallback on exhaustion.
- Specialized waterfalls: maps grounding (3.5-flash + 3.8-flash + googleMaps
  tool), TTS (lite-tts â†’ tts), transcription (3.5-transcribe â†’ flash).
- Local-first heuristics everywhere: sentiment engine, heuristic planner,
  heuristic memory extraction (+2-min quota cooldown), companion fallback,
  toolSelector/strategySelector cheapest-reliable ranking, PlanEngine bounds,
  bounded contexts (chat history â‰¤16, task context â‰¤4 KB, memory recall
  bounded, research excerpts capped, vision rate-limit + cooldowns).
- No OpenRouter and no routing/telemetry layer existed â€” that was the gap.

### 24.2 New routing architecture (`src/agent/routing/`)

```
 text â”€â–¶ CachedClassifier (deterministic 5-tier classification, TTL/LRU-memoized)
          TRIVIAL â”‚ SIMPLE â”‚ MODERATE â”‚ COMPLEX â”‚ HIGH_COMPLEXITY
              â–¼
        resolveRequirements (factors + declarative capability map:
          screen.* â†’ vision+deep reasoning, browser.* â†’ tool use + web
          reasoning, research.* â†’ deep + web, â€¦)
              â–¼
        ModelRouter.route â€” smallest capable AVAILABLE model â‰¥ tier floor
          (complexity floor âˆ§ requirements floor), registry-sorted cheapest-first
              â–¼  decision only â€” nothing is executed
        escalate(decision, reason): light â†’ balanced â†’ strong â†’ null (bounded)
        fallbackFrom(model, reason): compatible alternative, never the failed
          model first; context_overflow prefers larger context; optional
          unavailability TTL; exhaustion â†’ honest null
              â–¼
        RouteDecision { model, orderedModels (FULL waterfall preserved behind
        the choice), escalationPath, recommendedTimeoutMs, attempts, history }
```

Modules: complexity.ts, modelProfiles.ts (ModelRegistry â€” profiles are
configuration data describing the repo's actual models), requirements.ts,
router.ts, cache.ts (BoundedCache + FNV-1a hashKey), coalesce.ts,
telemetry.ts, classifier.ts, routingTools.ts.

**Server integration (additive; the waterfall algorithm is untouched):**
`generateContentWithFallback` accepts an optional ordered `models` list.
/api/chat classifies the message (cached), routes, calls the waterfall in the
routed order, returns additive `route` metadata (complexity, tier, preferred,
used, orderedModels, timeout guidance) â€” also on the local-fallback path â€”
and records per-call latency/model telemetry. /api/vision/analyze coalesces
identical in-flight analyses (read-only â†’ safe to share) and records latency.
/api/health exposes the passive `perf` snapshot. /api/memory/extract,
grounding, TTS and transcription keep their existing (already specialized)
paths.

**Agent integration (bridge):** `model.route`, `perf.classify` and
`perf.metrics` are registered as SAFE/FREE/LOCAL tools â€” decisions and
metrics only, no execution surface, so routing cannot bypass permissions,
verification, plan validation or recovery (spec Â§20). Passive bus listeners
record TOOL_COMPLETED durations and TASK_COMPLETED times (bounded maps, no
new instrumentation points). `modelRouter`/`performance` exposed on the
AgentSystem and the DevTools hook.

### 24.3 Context/token efficiency (spec Â§9/Â§18)

Existing bounds were verified rather than re-invented: chat history â‰¤16
messages; task context values bounded (4 KB with preview); memory recall
relevance-bounded (Phase 2); multimodal/research/proactive evidence caps from
Phases 13â€“16. New: classification memoization avoids re-running heuristics
for repeated identical messages; vision coalescing removes duplicate
in-flight analyses; routed ordering avoids spending strong-model quota on
trivial traffic (quota saved IS fallback capacity gained).

### 24.4 Performance measurements (real machine)

- Routing overhead: 100 classify+route cycles â‰ˆ tens of ms total
  (sub-millisecond per decision; asserted < 250 ms for the 100 in tests).
- Duplicate-call prevention: identical concurrent vision analyses collapse to
  one model call (coalescer stats).
- Classification cache: repeated identical messages are pure cache hits
  (hit/miss counters in telemetry).
- Routed ordering: trivial traffic consumes light-model quota first,
  preserving strong-model quota for escalations (no behavioral claim beyond
  the measured route decisions in the real-machine check).
- Memory: all telemetry rings/stats bounded (â‰¤100 records, â‰¤64 tool stats,
  â‰¤128 classifier entries); zero timers/intervals added (verified: health
  counters do not move without traffic).

### 24.5 Safety constraints

Routing is decision-only end to end: RouteDecision carries model ids and
ordering, never an executor. Permissions, confirmation thresholds, plan
validation, recovery and verification are enforced exactly as before (tested:
a permission-gated tool stays permission_denied with routing tools present).
Escalation and fallback are bounded (tier ladder length 2; fallback ladder â‰¤
registry size âˆ’ 1; availability TTLs expire). The full 4-model waterfall
always remains behind any routed choice â€” resilience is never reduced.

### 24.6 Tests & real-machine verification

- `scripts/test-routing-phase17.ts` (npx tsx): **123 assertions, 0 failed** â€”
  classification (5 tiers, determinism, timeout guidance), registry/profiles
  (availability TTLs), requirements (capability map, satisfaction), routing
  (lightweight selection, floors, vision/tool routing, unavailability),
  escalation (bounded ladder, history), fallback (8 reason kinds, overflow
  preference, rate-limit TTL, exhaustion), caching (hit/miss/expiry/eviction),
  coalescing (sharing, independence, error propagation), telemetry (bounded
  rings, snapshot), classifier cache + overhead measurement, safety
  (decision-only, permissions untouched), integration (Agent Core, Phase 16
  validation, Deep Research compatibility). Deterministic: fake clocks.
- `scripts/real-machine-check-routing.ts` (needs the local server; â‰¤2 real
  chat calls, no provider spam): registry loads; router decisions; escalation
  + fallback; real simple chat â†’ lightweight route; real complex chat â†’
  strong route with full waterfall preserved; health perf snapshot with
  counters that do not grow without traffic; real planned task completes;
  Deep Research planning intact. Verified PASS on the real machine.

### 24.7 Known limitations

Classification is lexical/deterministic (no embedding/LLM classification by
design â€” a hard task phrased in few words routes light, and quality-based
escalation triggers only via explicit callers of `escalate()`; the server
escalates implicitly through the preserved failure waterfall). Tier/cost/
reliability profile values are curated configuration for the configured
models, not measured benchmarks. Deep Research remains fully deterministic
and local â€” it never routes to a model (nothing to route; by design, and
unchanged). Streaming behavior is unchanged (no streaming existed in the
server chat path).

## 25. Safety + permission hardening (Phase 18)

**Phase 18 â€” Safety + Permission Hardening** (official roadmap). Central
principle: Krisha knows what she is allowed to do, what requires
confirmation, what is forbidden, what scope a permission covers, and when a
permission must be re-requested â€” enforced centrally, not by tools
remembering to check.

### 25.1 What already existed (preserved, not rewritten)

Phase 3 PermissionManager (12 typed domains, session grants, RISK_ORDER +
confirmationThreshold hook) enforced by the ToolRegistry on every execution;
Phase 16 plan validation (permission gaps â†’ BLOCKED nodes; replanning refuses
to route around permissions); Phase 11 recovery (PERMISSION_DENIED â†’
SAFE_STOP; permission_denied is non-retryable); Phase 15 proactive LEVEL 1â€“4
gates (LEVEL 4 never auto-executes); Phase 9 server path safety (allowed
roots, traversal rejection, system-dir write denylist, app allowlist);
scheme/SSRF guards in browser/research; AbortSignal cancellation everywhere.

### 25.2 New architecture (`src/agent/safety/`)

```
 any caller (core, planning, recovery, proactive, research, tools)
        â”‚  registry.execute â€” THE single chokepoint
        â–¼
 SafetyGate.evaluate (deterministic, fail-closed):
   1. risk classification (classifyRisk): declared risk â†’ base class, then
      input escalations (force/overwrite flags, bulk targets >5, destructive
      tools, external side effects, sensitive path patterns) â€” classes:
      SAFE / CONFIRM / HIGH_RISK / DENY; unknown declaration â†’ fail closed
   2. unknown permission id â†’ DENY (spec Â§19: never implicit allow)
   3. scoped revocation â†’ REVOKED (kill-switch over session grants until an
      explicit new grant is made)
   4. emergency stop active â†’ side-effecting classes DENIED (read-only
      control plane stays operable)
   5. base PermissionManager coverage; scoped grants (once / task / session /
      duration) satisfy gaps â€” consumed on use, removed on expiry
   6. optional strict mode: HIGH_RISK â†’ REQUIRE_CONFIRMATION unless a
      high-risk acknowledgment grant exists (default off â€” preserves existing
      legitimate flows; switch exists for the Phase 20 confirmation UI)
        â”‚
        â–¼ structured SafetyEvaluation on EVERY result (allow AND deny)
 ToolResult.metadata.safety { decision, klass, permission, reason, factors,
        auditId } â€” denials are permission_denied + non-retryable, so Phase
        11/16 semantics (no retry, no replan around safety) apply unchanged
        â”‚
        â–¼
 SafetyAuditLog â€” bounded ring (200), redacted (reasons through redactText;
        input KEYS only, never values), passive (no polling/timers)
```

Scoped grants (`ScopedPermissionManager`): explicit scope kinds â€” one-shot
(consumed on use), task-bound (one taskId), session, duration (expiry) â€”
never broader than requested; revocation is immediate and removes all stale
grant objects; emergency revoke clears every temporary grant. Grants are made
by the embedding application/user ONLY â€” there is deliberately NO self-grant
tool.

Emergency stop (`EmergencyStop`): `activate(reason)` fires registered hooks â€”
the bridge wires `core.cancelAll()` (existing cancellation architecture) +
`scoped.revokeAllTemporary()` â€” then the gate blocks new side-effecting
actions while read-only visibility continues; `deactivate()` fully restores
permission-checked operation. Audited with the operator reason.

Safety tools: `safety.status`, `safety.emergency_stop`, `safety.audit` â€” the
control plane (status/stop/resume/audit read) classifies SAFE so it remains
operable during a stop. AgentSystem/DevTools expose `safety` (gate, scoped
grants, audit, emergencyStop, emergencyStopNow/resume).

### 25.3 Integration guarantees (spec Â§11â€“Â§14)

- **Planning**: plan validation unchanged (missing permissions â†’ BLOCKED
  nodes); execution-time gate denials are structured and non-retryable, so a
  plan still cannot execute a side-effecting step merely because the planner
  produced it.
- **Retries/replanning**: permission_denied remains non-retryable; Phase 11
  classifies PERMISSION_DENIED â†’ SAFE_STOP; Phase 16
  `proposeReplan(refusedBecause: 'not_replannable')` â€” a retry can never
  bypass a denial, and corrective strategies stay inside the permission
  boundary (Phase 16 rotation permission-checks alternative tools).
- **Model routing (Phase 17)**: routing remains decision-only; fallback and
  escalation operate under the exact same gate â€” a stronger model receives no
  additional permissions (verified by test).
- **Browser/filesystem/application**: every registered tool passes the gate;
  the server's path-safety guards remain intact behind it (verified on the
  real machine).

### 25.4 Tests & real-machine verification

- `scripts/test-safety-phase18.ts` (npx tsx): **62 assertions, 0 failed** â€”
  risk classification table (destructive/irreversible/local-external/bulk/
  force/fail-closed/determinism), permission decisions (allow/deny/
  require_confirmation/revoked/expired through the registry), scoped grants
  (once consumed, task-bound isolation, duration expiry, immediate
  revocation), agent core/planner/retry/replan safety, emergency stop
  (cancellation, signal-honoring side-effect block, read-only visibility,
  recovery), bounded redacted audit (300 â†’ 200 ring; secrets redacted),
  safety tools (no self-grant), Phase 16/17 + Deep Research compatibility,
  and byte-identical no-gate registry behavior.
- `scripts/real-machine-check-safety.ts` (needs the local server; uses a
  disposable temp directory, cleaned up afterwards; no destructive probes):
  **21/21 PASS** â€” safe read executes with ALLOW recorded; ungranted write
  denied; one-shot grant allows exactly once; expiry rejected; revocation
  immediate; emergency stop blocks side effects while read-only continues and
  recovers on resume; server path-safety guards intact through the gate;
  Phase 16 planned execution completes under the gate; Phase 17 routing and
  Deep Research unaffected; unknown-permission bypass attempt fails closed;
  audit bounded and metadata-only.

### 25.5 Known limitations

Confirmation is structured but has NO interactive UI yet: in the default
policy, CONFIRM/HIGH_RISK actions execute within their granted permission
scope (the existing session-grant architecture) and are audited; the strict
high-risk confirmation mode and the structured `require_confirmation` result
are ready for the Phase 20 confirmation UI. Sandboxing is NOT claimed: tool
execution is permission-gated and path-guarded, but not sandboxed (documented
per spec Â§16). The audit log is in-memory and bounded (not persisted across
restarts â€” a deliberate privacy/performance tradeoff). Scope kinds cover
once/task/session/duration; recurring calendars are Phase 19 territory.

## 26. Long-Run Autonomy â€” official Phase 19

**Phase 19 â€” Long-Run Autonomy** (official roadmap). Goal: give Krisha
persistent, bounded, safely-resumable task sessions so that a task that takes
longer than one interaction, suffers a transient interruption, or requires a
pause can continue safely instead of being lost.

### Architecture overview

```
AgentCore (existing, single executor â€” no second core)
    â†“  emits TASK_STEP_COMPLETED / _FAILED / RECOVERY_* / PLAN_REPLANNED /
    â†“       TASK_COMPLETED / _FAILED / _CANCELLED / TOOL_COMPLETED / _FAILED
LongRunManager (event-driven, no polling, no timers of its own)
    â†“  advances TaskSession lifecycle (deterministic state machine)
    â†“  writes lightweight CheckpointStore on meaningful step boundaries
TaskSession (deterministic state machine per task)
    SessionState: CREATED â†’ RUNNING â†’ PAUSED / WAITING / BLOCKED / RECOVERING
                                    â†’ CANCELLED / FAILED / COMPLETED / EXPIRED
    All transitions validated against a static table; invalid transitions logged
    to SafetyAuditLog and rejected â€” never silently applied.
CheckpointStore (bounded, MemoryStorage-backed or real storage)
    Persists compact SessionCheckpoint: task id, goal, plan revision, step
    statuses (id/toolName/status/attempts/verified), budget state, last-action
    outcome class. NEVER persists tool inputs/outputs, screenshots, histories,
    secrets or credentials. Bounded: MAX_PERSISTED_CHECKPOINTS = 24; oldest
    terminal entries evicted first.
waitUntil() â€” bounded adaptive polling helper
    Single timer at a time. Interval doubles from pollMs to maxPollMs (default
    500 ms â†’ 8 s). Hard poll cap (maxPolls = 60). Timeout â†’ BLOCKED.
    Optional AbortSignal for event-driven early wake.
```

### Task lifecycle

```
start(goal) â†’ CREATED â†’ RUNNING
  â”‚  checkpoint written per step completion (not on a timer)
  â”‚  budgets: maxDurationMs / maxToolCalls / maxRecoveries / maxStepCompletions
  â”‚
  â”œâ”€ pause()   â†’ PAUSED   (resumable; in-flight step cancelled, not duplicated)
  â”œâ”€ wait()    â†’ WAITING  â†’ RUNNING (satisfied) | BLOCKED (timeout)
  â”œâ”€ Recovery  â†’ RECOVERING â†’ RUNNING (Phase 11 handles the retry)
  â”‚
  â”œâ”€ cancel()  â†’ CANCELLED  (terminal â€” never auto-resumes)
  â”œâ”€ budget exhausted â†’ EXPIRED  (terminal)
  â”œâ”€ failure   â†’ FAILED    (terminal)
  â””â”€ complete  â†’ COMPLETED (terminal)
```

### Checkpoint design

Compact `SessionCheckpoint` fields:
- `schemaVersion` â€” forward-compatibility guard; incompatible â†’ BLOCKED
- `taskId`, `goal` (â‰¤ 160 chars), `lifecycle`, `planRevision`
- `steps[]` â€” id, description (â‰¤ 80 chars), toolName, status, attempts, verified
- `counts` â€” stepsCompleted, stepsFailed, toolCalls, recoveries, replans
- `budget` + `consumed` â€” runtime limits and consumption tracking
- `lastAction` â€” `{ stepId, toolName, outcome: DEFINITE_SUCCESS | DEFINITE_FAILURE | UNKNOWN }`
- `pauseReason`, `failureReason`, `blockReason` â€” human-readable, bounded

Written at: step completion/failure, pause, recovery transitions, replan,
budget exhaustion. Never on a timer; never in a tight loop.

### Resume flow

```
resume(taskId)
  1. session PAUSED or BLOCKED?
  2. validateCheckpoint(cp)         â€” structural, schema, bounds
  3. lastAction.outcome === UNKNOWN? â†’ BLOCKED (duplicate-action prevention)
  4. emergencyStop.isActive()?      â†’ refuse (spec Â§15)
  5. budgetExhaustion()?            â†’ refuse (requires fresh budget)
  6. transitionTo('RUNNING')?       â€” rejected if table forbids it
  7. core.resumeTask(taskId)        â€” Phase 18 gate re-checks every action
```

### Crash / restart recovery

`crashScan()` on construction validates every stored checkpoint:
- Corrupt/incompatible â†’ dropped (fail-closed, not executed)
- Stale beyond 24 h â†’ BLOCKED (explicit revalidation required)
- `RUNNING` / `RECOVERING` / `WAITING` â†’ downgraded to PAUSED (core died, external
  state unverified; NOT auto-resumed)
- Terminal states preserved as-is

### Interruption taxonomy

| Signal | Session state | Resumable? |
|---|---|---|
| `pause()` | PAUSED | Yes â€” after explicit validated resume |
| `cancel()` | CANCELLED | No â€” terminal |
| Emergency stop | blocks resume | No â€” until stop lifted |
| Budget exhausted | EXPIRED | No |
| Permission expired/revoked | BLOCKED (gate catches at exec time) | Yes â€” after permission restored |
| Stale checkpoint | BLOCKED | Yes â€” after revalidation |
| UNKNOWN last action | BLOCKED | Yes â€” after external state verified |

### Duplicate-action prevention (spec Â§16)

`lastAction.outcome` is classified after every step:
- `DEFINITE_SUCCESS` â€” `completed && verified === true`
- `DEFINITE_FAILURE` â€” `failed && verified === false`, or `cancelled` (aborted before side effect)
- `UNKNOWN` â€” dispatched but unverified (`uncertain`)

`resume()` refuses and transitions to BLOCKED when outcome is `UNKNOWN`.

### Resource behaviour

- **No background polling loops, no manager timers.** All advancement is
  event-driven on the shared AgentCore event bus.
- `waitUntil()` owns exactly one doubling-interval timer at a time.
- Checkpoint writes: â‰¤ one per step boundary.
- Concurrency: single active session (default); configurable via `maxActiveSessions`.
- `cleanup(keepRecent=5)` removes terminal sessions beyond the retention limit.

### Safety integration

Phase 18 SafetyGate is authoritative: every resumed or new side-effecting action
passes the gate inside `AgentCore.runStepWithRetry`. A checkpoint cannot grant
permission. Emergency stop wired via `setEmergencyProbe()`. ScopedPermissionManager
expiry/revocation caught at execution time, not by the session layer.

### Phase integrations

- **Phase 11**: `RECOVERY_STARTED/SUCCEEDED/FAILED` drive `RECOVERING` transitions.
- **Phase 16**: `PLAN_REPLANNED` increments replan counter; resumed tasks re-enter
  the core's existing plan continuation path.
- **Phase 17**: routing unchanged; long-run tasks use the same model router.
- **Phase 15**: proactive signals share the event bus; no duplicate background system.
- **Deep Research**: compatible; tool calls tracked in the session budget.

### Modules

```
src/agent/longrun/
  sessionTypes.ts   â€” SessionState machine, budget, checkpoint schema, CheckpointStore
  taskSession.ts    â€” per-task deterministic lifecycle state machine
  waiting.ts        â€” waitUntil() bounded adaptive timer
  longRunManager.ts â€” event-driven session coordinator: crash scan, pause/resume/cancel/wait
  longRunTools.ts   â€” Phase 3 tools: longrun.status / .pause / .resume / .wait
  index.ts          â€” public exports
```

### Known limitations

- Single-active-session model by default (correctness over throughput on a laptop).
- Crash recovery restores to PAUSED â€” external state must be revalidated by the
  user or a Phase 11 recovery pass before continuation.
- `AgentCore.resumeTask` resets plan from the `interrupted` state; `$context` refs
  must still be valid in the task store.
- Checkpoint store is in-memory (MemoryStorage) in the browser build; the
  server-side bridge supplies real persistence.
- The real-machine verification script requires the local dev server (`npm run dev`).

---

> **Phase 20 â€” Final Agent Integration â€” NOT STARTED**

## 26. Long-run autonomy (Phase 19)

**Phase 19 â€” Long-Run Autonomy** (official roadmap). Principle:
`PLAN â†’ ACT â†’ VERIFY â†’ CHECKPOINT â†’ CONTINUE`, with
`INTERRUPT â†’ CHECKPOINT â†’ VALIDATE â†’ RESUME` and
`RESTART â†’ LOAD â†’ VALIDATE â†’ VERIFY EXTERNAL STATE â†’ RESUME OR BLOCK`.
Long-running means persistent + recoverable + bounded + safe + resource-aware
â€” never infinite, uncontrolled, or constantly running. No second core, no
second planner, no second recovery framework: everything extends the existing
Agent Core, Phase 11, Phase 16, Phase 17 and Phase 18 systems.

### 26.1 Task lifecycle (`src/agent/longrun/`)

A TaskSession wraps an EXISTING AgentCore task. Deterministic transition
table (validated; invalid transitions rejected and audited):

```
CREATED â†’ RUNNING â†’ { PAUSED | WAITING | BLOCKED | RECOVERING } â†’ RUNNING â†’ COMPLETED
           â†˜ CANCELLED / FAILED / EXPIRED (terminal â€” never transition out;
             a cancelled task NEVER resumes)
PAUSED â†’ RUNNING (only via validated resume) | BLOCKED | CANCELLED | EXPIRED
```

AgentCore extensions: `startTask()` (detached start â€” submit without
awaiting), `resumeTask(taskId)` (revalidates the plan through Phase 16, skips
completed/skipped/uncertain steps, retries failed/cancelled ones), and
`cancel(taskId, mode)` â€” 'pause' mode stores the task as 'interrupted'
(resumable) with pending steps left 'pending'; 'cancel' remains terminally
'cancelled'. The long-run manager reads the mode AT cancellation time.

### 26.2 Checkpoints + resume

`SessionCheckpoint` (schema-versioned, â‰¤24 persisted, `krisha_agent_longrun_v1`
over the existing StorageAdapter pattern): task id, compact goal, plan
revision, step records (id/description/toolName/status/attempts/verified â€”
NO inputs, NO outputs, NO screenshots, NO secrets), counts, budget +
consumption, last-action outcome class (DEFINITE_SUCCESS / DEFINITE_FAILURE /
UNKNOWN), pause/block/failure reasons. Written at meaningful boundaries only:
one checkpoint per completed step, plus pause/failure/replan/terminal
transitions â€” event-driven, never a persistence loop.

Resume (spec Â§8) validates: checkpoint structure (corrupt â†’ dropped/failed
safe), lifecycle legality, duplicate-action safety (UNKNOWN last outcome â†’
BLOCKED â€” external verification must establish safety before a side-effecting
step is retried), budget state, and emergency-stop state. Phase 18 then
re-checks every action through the gate at execution. Crash scan (manager
construction): persisted mid-run sessions restore as PAUSED (never
auto-resumed); stale (>24h) â†’ BLOCKED; corrupt â†’ dropped.

### 26.3 Interruptions, budgets, waiting, concurrency

- Interruptions are differentiated: user pause â†’ PAUSED (resumable, event
  TASK_PAUSED); user cancel â†’ CANCELLED (terminal); emergency stop â†’ side
  effects blocked (read-only continues); failure â†’ FAILED with reason;
  budget exhaustion â†’ EXPIRED with reason + checkpoint.
- Budgets (spec Â§11): maxDurationMs (10 min default), maxToolCalls (60),
  maxRecoveries (6), maxStepCompletions (24) â€” enforced on events; exhausted â†’
  safe stop + checkpoint + EXPIRED; resume requires a fresh budget.
- Waiting (spec Â§13): `WAIT â†’ WAKE â†’ VERIFY â†’ CONTINUE` via bounded adaptive
  polling (interval doubling 500ms â†’ 8s cap, hard timeout, â‰¤60 polls, optional
  event wake); timeout â†’ BLOCKED + checkpoint. One timer at a time.
- Concurrency (spec Â§23): single-active-session model (start rejected while
  another session is active).

### 26.4 Integration

Phase 11 recovery (RECOVERY_* events â†’ RECOVERING state; failures flow through
the existing strategies), Phase 16 planning (resumeTask revalidates through
attachPlan; checkpointed plan revision; replan events counted), Phase 17
routing (untouched â€” decision-only), Phase 18 safety (gate re-evaluates every
executed or resumed action; checkpoint grants NOTHING; revocation is a
kill-switch verified on the real machine), Phase 15 proactive (no
long-run-driven autonomous loops), Deep Research (untouched additional
capability â€” its own bounded dossier behavior unchanged, regression suite
green). Cleanup: terminal checkpoints pruned beyond retention (keepRecent);
checkpoints cannot inject executable instructions (plan steps only come from
the core's validated planner; checkpoints store statuses, not code).

### 26.5 Tests & real-machine verification

- `scripts/test-longrun-phase19.ts` (npx tsx): **71 assertions, 0 failed** â€”
  transition table (valid/invalid/terminal), checkpoint validation (schema,
  corruption, staleness, bounds), full lifecycle E2E (start â†’ per-step
  checkpoints â†’ pause â†’ validated resume â†’ completion with NO re-execution of
  completed steps and NO duplicate side effect), crash/restart (restore
  PAUSED, explicit resume, corrupt dropped), duplicate prevention (UNKNOWN
  blocks, verified success skips), budgets (tool-call exhaustion â†’ EXPIRED,
  refusal without fresh budget), waiting (adaptive bounded polls, timeout â†’
  BLOCKED), safety (emergency stop blocks resume; pause â‰  cancel), single-
  active concurrency, cleanup, and compatibility (plain submit intact).
- `scripts/real-machine-check-long-run.ts` (needs the local server; disposable
  temp directory): **26/26 PASS** â€” real planned execution with per-step
  checkpoints; pause mid-task with zero completed duplicate writes; validated
  resume completing the interrupted write exactly once; bounded adaptive wait
  (1 poll for an already-true condition); Phase 11 transient-failure retry
  under the session; honest FAILED with reasons; UNKNOWN outcome blocking
  resume after a simulated restart; revoked permission â†’ FAILED; emergency
  stop; terminal cancellation; cleanup; restart scan leaving no session
  mid-run.

### 26.6 Limitations

Concurrency is deliberately single-active (correctness over throughput).
Checkpoints are in-memory-per-process in Node tests and localStorage-backed in
the browser (bounded, not a durable database â€” multi-device sync is out of
scope). Waiting predicates are function-based (real event-sourced waits arrive
with Phase 20's integration surface). Session history is bounded; very long
tasks exceeding budget require an explicit fresh-budget continuation. No
automatic crash resume (deliberate safety choice per spec Â§10).

**Phase 20 â€” Final Agent Integration â€” NOT STARTED.**

## 27. Final agent integration (Phase 20)

**Phase 20 â€” Final Agent Integration â€” COMPLETE.** Phase 20 integrates the
existing systems into one coherent agent architecture WITHOUT replacing any
of them. The pipeline:

```
INPUT â†’ UNDERSTAND â†’ MEMORY/CONTEXT â†’ GOAL â†’ CAPABILITY DISCOVERY â†’ PLAN
â†’ MODEL ROUTING â†’ SAFETY GATE â†’ TOOL/API EXECUTION â†’ RESULT â†’ VERIFY
â†’ LEARN/STORE â†’ NEXT STEP â†’ CHECKPOINT â†’ COMPLETION
```

Authorities unchanged: ToolRegistry = execution authority; Phase 16 =
planning; Phase 17 = model routing (decision-only); Phase 11 = recovery;
Phase 18 = safety (every action re-evaluated); Phase 19 = long-run sessions.

### 27.1 New capability layer (`src/agent/capabilities/`)

- `capabilityTypes.ts` â€” normalized CapabilityRecord + explicit availability
  states: cataloged / discoverable / advisory / requires_credentials /
  requires_payment / unavailable. Cataloged â‰  executable, always.
- `capabilityCatalog.ts` â€” lazy, metadata-driven index over pluggable
  CatalogSources: each source loads ONCE on first use (startup stays free of
  catalog weight); searches are bounded (â‰¤25 results) keyword/tag matches;
  failing sources degrade to an honest `unavailable` record instead of
  breaking Krisha; duplicate ids within a source are deduped;
  `modelHintToTier` maps advisory hints into the Phase 17 tier vocabulary
  (hints only â€” the Phase 17 router still decides).
- `specialistSource.ts` â€” adapts the PREPARED `krisha-specialists` library
  (100 metadata-only reasoning definitions across 10 departments, zero
  runtime dependencies) via async dynamic import â€” the package loads once,
  on first catalog use.
- `capabilityTools.ts` â€” `capability.search`, `capability.stats`,
  `capability.by_category`: SAFE/FREE/LOCAL discovery tools. They search
  metadata and report stats; they execute NOTHING and grant NOTHING â€” every
  real action still flows ToolRegistry â†’ Phase 18 gate.

### 27.2 Honest capability accounting (spec Â§23/Â§24)

- Cataloged + discoverable + advisory: **100 specialists** (krisha-specialists
  library). These reason and advise; they do not act on the world.
- The referenced **1,841-entry Public API catalog file is NOT present in the
  repository** â€” stated honestly rather than faked. The catalog layer is
  source-agnostic: such a catalog plugs in as another lazy CatalogSource and
  its records would be labeled `cataloged`/`requires_credentials`/
  `requires_payment`/`unavailable` as appropriate, never silently activated.
- Verified operational: the integrated tool set (22 tools) + capability
  discovery â€” verified on the real machine (below). **0 APIs claimed working
  without verification.**

### 27.3 Initialization order (spec Â§17)

Storage â†’ Safety (gate/audit/emergency) â†’ ToolRegistry + tools â†’ Model
Router â†’ Planner â†’ Recovery (in core) â†’ Long-Run Manager â†’ Capability
catalog (lazy) â†’ AgentCore â†’ UI bridge â†’ Proactive (event-driven). No
circular initialization; a failing catalog source degrades to an
`unavailable` record without preventing startup. Duplicate registration is
rejected by the registry (verified).

### 27.4 Observability (spec Â§18)

`capability.stats` exposes sources/availability/category breakdowns +
per-source lazy-load counts; Phase 17 telemetry records routes/model
latency/escalations/fallbacks; Phase 18 audit trail records every safety
decision (redacted, bounded); Phase 19 session diagnostics track lifecycle/
progress/budgets. All bounded, all passive, no secrets.

### 27.5 Tests & real-machine verification

- `scripts/test-integration-phase20.ts`: **45 assertions, 0 failed** â€” real
  catalog load (100/10 departments/advisory labels), search ranking +
  filters + honest empty results, model-hintâ†’tier mapping, load-once lazy
  behavior, dedupe, graceful source failure, tools through the gated
  registry (no execution surface, permissions NOT weakened, invalid input
  fails closed), full-agent integration (no duplicate registrations, long-run
  session under the integrated registry, Deep Research coexistence), and
  performance (first lazy load ~160ms one-time; 50 searches â‰ˆ instant; still
  exactly one source load).
- `scripts/real-machine-check-integration.ts` (needs the local server;
  disposable temp directory): **22/22 PASS** â€” full integrated system
  initializes in ~4ms; no duplicate registration; capability discovery with
  lazy load verified (3 control tools only, NOT one tool per capability);
  Deep Research discovers/inspects/cites a real source; filesystem
  capability functional; revoked permission + emergency stop enforced;
  long-run checkpoint/resume + terminal cancellation; no secrets in the
  audit trail; idle repeated catalog stats stay cheap (no background work).

### 27.6 Known limitations

The 1,841-entry Public API catalog is not present in the repository; when
provided, it plugs in as an additional lazy CatalogSource (the layer is
built for it) â€” until then only the 100 specialists are cataloged. Specialist
capabilities are advisory reasoning definitions: they inform planning and
model hints but do not execute (by design of the prepared library). Voice/
wake-word and globe remain UI-layer capabilities exposed through the existing
app surface (their agent-side hooks â€” globe tools â€” were already registered
in Phase 1; no new integration was required).

## 28. Self-Diagnostics v1: Runtime Health and Failure Awareness

**Self-Diagnostics v1 â€” COMPLETE.** Self-Diagnostics v1 provides an architectural
control plane that enables Krisha to inspect her own operational health, detect
runtime failures in subsystems, distinguish degraded states from complete failure,
and deliver verified diagnostic reports without altering system state or mutating
storage.

```
       SHARED AGENT EVENT BUS (Passive event listener)
  [TOOL_FAILED, TASK_FAILED, RECOVERY_FAILED, APP_LAUNCH_FAILED, ...]
                             â”‚
                             â–¼
     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
     â”‚                     FailureTracker                      â”‚
     â”‚  - Bounded (â‰¤50 records, LRU eviction)                  â”‚
     â”‚  - Deduplication via fingerprinting                     â”‚
     â”‚  - Capability impact analysis                           â”‚
     â”‚  - Fact vs. Hypothesis diagnosis categorization         â”‚
     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                                â”‚
    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
    â”‚                   DiagnosticsService                     â”‚
    â”‚  - 5-second report cache TTL (cache-first)               â”‚
    â”‚  - Dual health status: diagnosticStatus & overallStatus  â”‚
    â”‚  - Observes live operational state (tasks, e-stop)       â”‚
    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                                â”‚
   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
   â”‚                    DiagnosticRegistry                    â”‚
   â”‚  - Max 32 checks, synchronous & deterministic            â”‚
   â”‚  - Deep evidence sanitization (depth limit, redaction)   â”‚
   â”‚  - Opt-in active probe separation (passive-first)        â”‚
   â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”˜
            â”‚           â”‚           â”‚           â”‚         â”‚
          Core    Intelligence  Execution    Models  Persistence & System
```

### 28.1 Architectural Principles

1. **Strictly Passive-First & Non-Mutating**: Default diagnostic runs make NO
   storage mutations, write/delete probes, or synthetic event injections. Opt-in
   active probes (`intelligence.context_engine.probe`, `intelligence.knowledge_graph.probe`,
   `execution.planner.probe`) are read-only and explicitly filtered out unless
   `includeActiveProbes: true` is passed.
2. **Health Assessment vs. Operational State Separation**: The diagnostic verdict
   (`diagnosticStatus`) is an evidence-based assessment of health, entirely distinct
   from live operational control-plane state (`OperationalStateSnapshot`: `activeTaskCount`,
   `emergencyStopActive`, `unavailableSources`). Diagnostics never alter task lifecycle,
   trigger emergency stops, or mutate task data.
3. **Laptop-Friendly & Local-First**: Synchronous, zero background timers, zero
   polling loops, bounded memory (max 32 checks, max 50 failure records, 5-second
   cache TTL). Deterministic local checks execute in ~1ms without model or network calls.

### 28.2 Layered Subsystem Coverage (20 Default Passive Checks)

- **Core (`coreChecks.ts`)**:
  - `core.runtime.availability`: verifies task store, tool registry, permission manager, and event bus availability.
  - `core.task.lifecycle`: non-mutating sampling of task store (`store.sample(20)`) for contradictory timestamps and states.
  - `core.events.bus`: passive inspection of recent event history without synthetic emissions.
- **Intelligence (`intelligenceChecks.ts`)**:
  - `intelligence.context_engine`: verifies Context Engine cache limits and budget configurations.
  - `intelligence.knowledge_graph`: verifies node and edge bounds and drops.
  - `intelligence.semantic`: inspects local semantic expansion bounds.
  - `intelligence.memory`: validates MemoryService seed records and storage availability.
  - `intelligence.consolidation`: verifies ConsolidationEngine wiring.
  - Opt-in active probes: `intelligence.context_engine.probe` (verifies context packaging), `intelligence.knowledge_graph.probe` (verifies query statements).
- **Execution (`executionChecks.ts`)**:
  - `execution.tools.registry`: verifies standard tools (`system.note`, `chat.report`) and schema integrity.
  - `execution.planner`: verifies HeuristicPlanner wiring and fallback planning.
  - `execution.recovery`: inspects recovery manager state and strategy policies.
  - `execution.permissions`: checks permission gate state and evaluation.
  - Opt-in active probe: `execution.planner.probe` (verifies goal decomposition).
- **Models (`modelChecks.ts`)**:
  - `models.registry.profiles`: validates configured model profiles in ModelRegistry without LLM calls.
  - `models.router.wiring`: verifies ModelRouter initialization and tier resolution.
  - `models.api.keys`: inspects presence of GEMINI_API_KEY environment variable.
  - `models.telemetry`: inspects passive routing and latency performance metrics.
- **Persistence (`persistenceChecks.ts`)**:
  - `persistence.storage.adapter`: tests storage read path without writing or deleting keys.
  - `persistence.adapter.contract`: validates storage interface methods (`getItem`, `setItem`, `removeItem`).
- **System (`systemChecks.ts`)**:
  - `system.subsystem_wiring`: verifies cross-subsystem interconnections.
  - `system.cycle_traces`: inspects cycle trace store bounds and trace records.

### 28.3 Failure Awareness & Issue Diagnosis (`failureTracker.ts`)

- **Event Bus Listener**: Attaches to `TOOL_FAILED`, `TASK_FAILED`, `RECOVERY_FAILED`, `RECOVERY_SUCCEEDED`,
  `FS_OPERATION_FAILED`, and `APP_LAUNCH_FAILED`.
- **Deduplication & Fingerprinting**: `createFailureFingerprint` groups recurring errors by subsystem,
  tool, and normalized error message.
- **Fact vs. Hypothesis**: Recommendations and causes are explicitly tagged (`isHypothesis: boolean`)
  to ensure Krisha never claims a speculative diagnosis as verified fact.
- **Capability Mapping**: Inferred affected capabilities (`inferAffectedCapabilities`) map failure sources
  to concrete agent capabilities (e.g. `web.open_website` failure maps to `browser.open_url` and `browser.interaction`).

### 28.4 Agent Tools & Intent Routing (`diagnosticTools.ts`, `planner.ts`)

- `diagnostics.health`: Safe, free, read-only tool providing overall diagnostic status, subsystem health,
  operational snapshot, and active issue count.
- `diagnostics.inspect`: Safe, free, read-only tool allowing targeted inspection of individual subsystems
  (`core`, `intelligence`, `execution`, `models`, `persistence`, `system`).
- `HeuristicPlanner` & `classifyStep`: Natural language intent routing maps phrases like "check system health",
  "run diagnostics", and "inspect core subsystem" directly to the diagnostic tools.

### 28.5 Known Limitations

- **No Remote Probing**: By design, default diagnostics do not make network calls or query remote APIs;
  model checks evaluate profiles, keys, and telemetry rather than invoking billable model APIs.
- **Ephemeral Failure Ring**: In-memory failure records are bounded (â‰¤50) and reset across process restarts;
  long-term historical trends rely on the standard application audit logs.


## 28. Learned Skills v1

**Learned Skills v1 â€” COMPLETE.** Krisha can now turn genuinely verified task
executions into structured, validated, reusable skills â€” the curated tier
ABOVE the Phase 12 workflow candidates (which remain reuse *suggestions*).
A learned skill is not a saved conversation: it is validated structured data
with provenance, preconditions, an expected outcome and reliability tracking.

### 28.1 New module (`src/agent/skills/`)

- `skillTypes.ts` â€” the `LearnedSkill` data model (id, name, description,
  purpose, trigger pattern + keywords + domains, ordered steps, preconditions,
  required tools/permissions, expected outcome, sensitive flag, provenance,
  validation record, version + history, stats, EWMA reliability) plus the
  bounded constants and the reliability smoothing function.
- `skillValidator.ts` â€” deterministic validation before anything is stored:
  2â€“10 executable steps, every tool resolvable in the CURRENT registry, no
  high/critical-risk tools, secret-like values rejected, templates bounded
  and serializable. Shares the Phase 12 secret-detection definition.
- `skillStore.ts` â€” bounded (â‰¤30), schema-versioned, corruption-tolerant
  persistence under its own storage key (`krisha_skills_v1`), same
  StorageAdapter convention and repair-don't-drop philosophy as Phase 12.
- `skillEngine.ts` â€” the pipeline: observe verified completions â†’ extract â†’
  validate â†’ dedupe (identical sequence reinforces; same goal with a new
  verified sequence becomes a new VERSION â€” never a near-duplicate) â†’ store â†’
  mirror to Knowledge Graph + Memory. Retrieval ranks skills by token
  similarity + bounded Semantic Intelligence expansion + reliability +
  environment coverage, with explicit transparent blockers. `planFromSkill`
  instantiates a NORMAL plan (skillFrom marker) after re-checking
  preconditions; `recordOutcome` applies EWMA smoothing (a single failure
  never collapses a proven skill: 1.0 â†’ 0.8) and disables a skill decaying
  below 0.15; `auditStale` reports outdated/unreliable skills.
- `skillPlanner.ts` â€” `SkillAwarePlanner`, a thin decorator over the existing
  planner chain (skill reuse â†’ Phase 12 workflow reuse â†’ heuristic planning).
  No second planner loop.
- `skillTools.ts` â€” `skill.list`, `skill.search`, `skill.stats` (safe,
  read-only) and `skill.disable`, `skill.forget` (learned-data management,
  `memory.access`). There is deliberately NO create-skill-from-text tool.

### 28.2 Learning gates (safety by construction)

Skills are learned ONLY from tasks that (a) completed, (b) carry the honest
Intelligence-Loop goal verification `pass` (strict all-steps-verified
fallback), (c) contain â‰¥2 executable completed steps, (d) contain no
high/critical-risk tools, and (e) pass deterministic validation. Failures,
cancellations, timeouts, uncertain results, user messages and unverified
model plans never create skills. Sensitive workflows (medium-risk tools or
desktop/write/terminal/hardware permissions) are flagged and surfaced; the
Phase 18 gate still evaluates every reused step at execution.

### 28.3 Reuse never bypasses anything

A reused skill becomes an ordinary `AgentPlan` executed by the existing
AgentCore through the ToolRegistry and the Phase 18 SafetyGate â€” permissions,
step verification, retry, recovery, cancellation and timeouts all apply
unchanged. Preconditions (tool availability + permission state) are
re-validated immediately before instantiation, so a skill whose environment
changed is never run. Skill-driven tasks are excluded from Phase 12
re-learning (no near-duplicate artifacts).

### 28.4 Integration

Phase 12 (coexisting learning layer; shared sanitizer/secret definitions),
Semantic Intelligence (goal expansion for matching + near-duplicate
detection), Knowledge Graph (skills indexed as `component` nodes with `uses`
edges to their tools), Memory Service (compact mirrors; consolidation sees
them through the normal memory path), Self-Diagnostics (passive
`intelligence.learned_skills` check), event bus (`SKILL_LEARNED`,
`SKILL_REINFORCED`, `SKILL_UPDATED`, `SKILL_REJECTED`, `SKILL_REUSED`).

### 28.5 Verification

- `scripts/test-skills.ts`: **123 assertions, 0 failed** â€” extraction,
  failed/uncertain/timeout/cancellation rejection, no-skill-from-messages,
  validation units, high-risk refusal, secret redaction, duplicate
  reinforcement, version updates, full learnâ†’floorâ†’reuse lifecycle through
  the core, missing prerequisites, permission enforcement, semantic matching
  with explainable blockers, reliability smoothing/decay/disable/dedupe,
  persistence across restarts and corruption tolerance, Phase 12 coexistence,
  graph/memory/diagnostics integration, discovery tools, bounded store.
- `scripts/runtime-check-skills.ts`: **35 checks PASS** â€” production wiring
  (HeuristicPlanner chain + Phase 18 gate + audit + emergency stop): natural
  language â†’ plan â†’ gated execution â†’ learned skill â†’ reinforcement â†’
  skill-driven reuse (every step gate-evaluated with decision metadata),
  restart fidelity, emergency-stop semantics (side effects blocked, read-only
  work continues), revoked-permission denial, audit redaction, cheap matching.
- Full regression: **28/29 suites PASS**; TypeScript CLEAN; lint CLEAN;
  production build exit 0. The single failing suite
  (`test-intelligence-loop.ts`) is PRE-EXISTING and unrelated to skills: its
  harness expects planner intent classifiers (`answer`, "write the file X
  with content Y", `network_fetch`) that do not exist anywhere in
  `src/agent/planner.ts` â€” unimplemented Intelligence-Loop planner work that
  predates and is independent of Learned Skills v1 (proven by classification
  probe; the suite imports no skills code).

### 28.6 Known limitations

Skill inputs are reused as sanitized templates (no automatic parameter
substitution yet) â€” a skill matches goals similar to its source task, and
context-ref chaining works only where the source run used it. Reinforcement
counts same-sequence verified reruns as successful uses (honest evidence,
but not independent reuse). Voice/UI presentation of skills is not exposed
(no UI change was permitted); discovery is via tools and DevTools.

## 29. Project Awareness v1

Krisha now understands the user's software projects: identity, languages,
frameworks, dependencies, entry points, module structure, development
progress (goal / progress / blockers / completed work) and what changed
since the last look â€” while remaining strictly read-only, approval-gated,
metadata-only and bounded.

**Boundaries (hard):** only EXPLICITLY approved roots are ever read
(`project.approve_root` verifies the directory exists and is listable;
unapproved roots are refused, never silently accessed). Indexing never
modifies, moves, deletes or executes anything. Secret-shaped files
(`.env*`, keys, credentials, service accounts, â€¦) are never read or
stored â€” by name pattern AND by content probe (private-key blocks) â€” and
are only counted. Storage is metadata-only: paths, sizes, sigs, names.

**Scanning (`projectScanner.ts`):** one on-demand BFS per index â€” depth <= 6,
<= 80 dirs, <= 200 entries/dir, no file content ever persisted. Excluded
dirs: node_modules, dist, build, .git, coverage, venvs, __pycache__, ... .
Manifests (package.json, go.mod, Cargo.toml, pyproject.toml,
requirements.txt, .csproj, pom.xml) are parsed (bounded 96 KB reads) for
name, kind, frameworks, dependency NAMES and entry points. Language
histograms come from extensions. Directory digests (djb2 over bounded
entry shapes) plus size:mtime file signatures make change detection and
incrementality cheap: unchanged non-manifest files are never re-read
(readsSaved), manifests are re-read so parsed data stays correct.

**Persistence (`projectStore.ts`):** schema-versioned envelope under
`krisha_projects_v1` via the StorageAdapter convention; repair-don't-drop;
hard caps (10 projects); approvals and profiles are stored together so
`project.forget` removes both halves of consent.

**Engine (`projectEngine.ts`):** approveRoot / index / refreshIfStale /
changes / status / profile / stats / forget. Fully on-demand â€” no polling,
no timers, no background scanning. Events: PROJECT_INDEXED,
PROJECT_STATUS_UPDATED, PROJECT_CHANGES.

**Integration (no duplicates):** the engine mirrors <= 31 nodes / <= 30 edges
per project into the EXISTING Knowledge Graph (project node, modules and
key files via part_of, frameworks via uses) â€” which is also the retrieval
path, since the Context Engine already queries graph statements. Durable
identity records go through the EXISTING MemoryService. Disk access rides
the EXISTING Phase 9 /api/fs backend (`HttpProjectFs`), so zero server
routes changed. Tools pass the ToolRegistry -> Phase 18 SafetyGate like
every other capability; `NodeProjectFs` (tests / server-side only) is
kept out of the browser bundle by design.

**Tools:** project.approve_root, project.list, project.inspect,
project.changes, project.status, project.forget â€” all low/safe risk,
requiring filesystem.read or memory.access grants.

## 30. System stabilisation & integrity audit

A maintenance pass that repaired the long-standing Intelligence Loop
regression, audited Learned Skills v1 and Project Awareness v1 against their
specifications, and fixed the integration gaps it found. No UI, server, or
roadmap changes; no new dependencies.

**Intelligence Loop repair (root cause).** `test-intelligence-loop.ts`
(written 2026-10-07, untouched since) registered its mock tools under an
invented capability vocabulary (`answer`, `filesystem_write`,
`network_fetch`, `observe_screen`, `project_manage`) that matches nothing in
the production planner, which emits dotted capabilities
(`filesystem.read`, `screen.observe`, `chat.report`, ...) â€” so every
production-classified step failed tool resolution. Additionally, two
assertions passed only vacuously (the underlying tasks failed, so the
consolidation idempotency guard never saw a natural completion event), and
two fixtures predated current production bounds (cache payloads below
MIN_CACHEABLE_RESULT_CHARS; a memory question without the analyzer's
documented memory-query cue). Fixes: the harness now registers tools under
the planner's real emitted names (the same convention as
`test-agent-core.ts`), asserts consolidation through the engine's public
`task_result` path and genuinely verifies the duplicate-event guard, and
uses fixtures within production bounds. One real planner gap was closed:
"write the file X with content Y" now classifies to the EXISTING
`filesystem.create` tool (which supports content) instead of falling to an
honest "not executable yet" note â€” conservative guards (explicit 'write'
verb, path-ish target, explicit 'with content' clause) keep ordinary chat
unhijacked. Questions still route to the documented `system.note` fallback;
no network classifier was invented.

**Project Awareness integrity fixes.** (1) The Knowledge Graph mirror is now
REBUILT on every index: files/modules removed from a project are pruned from
the graph. The prune works from a COMPLETE edge snapshot
(`getAllEdges(limits.maxEdges)`) rather than per-node relation queries,
which hard-cap at `maxQueryResults` (10) â€” the cap-blind version silently
left stale records behind for projects with more than 10 indexed parts.
Deletion is reference-counted against the snapshot: a node is removed only
when nothing else in the graph still points at it, so records shared with
other systems or projects survive. `project.forget` removes the project's
graph records AND releases its durable memory records through the existing
`MemoryService.forget` API (only records carrying the engine's own metadata
markers). (2) Manifests are always re-read on incremental scans so parsed
frameworks/dependencies survive re-indexing; unchanged non-manifest files
are still never re-read. (3) The secret-name matcher also covers
`secrets.json`/`credentials.json`-style names, and a private-key CONTENT
probe excludes innocent-looking config files carrying key material. All are
regression-tested in `scripts/test-projects.ts` (218 assertions).

**Audit results.** Learned Skills v1 and Project Awareness v1 verified
against their specifications: verified-success-only learning, EWMA
reliability with honest unverified-outcome weighting, secret redaction,
precondition re-validation immediately before reuse, gated execution, bounded
persistence with repair-don't-drop, approval-gated read-only scanning,
metadata-only storage, on-demand-only work (no polling, no timers).

## 31. Goal Continuity v1

A persistent, lightweight goal-continuity subsystem: Krisha now remembers
what the user is trying to accomplish across conversations and restarts,
tracks progress and milestones, and restores context â€” proposing the next
step, never executing one on its own. No UI changes, no new dependencies, no
network calls, no embeddings, no polling or timers.

**Lifecycle.** Goals carry stable ids (`goal_` + timestamp/entropy, assigned
once), a bounded description, provenance snippet (`originMessage` â‰¤160
chars), up to 20 milestones, bounded progress lists (completed / remaining /
blockers, â‰¤10 Ã— 200 chars each), up to 3 approved-project references, and
dependency ids. Statuses: `proposed â†’ active â†” paused â†” blocked`, plus
`completed`/`abandoned` as terminals, enforced by a deterministic transition
table (invalid transitions are rejected, never guessed). Storage:
`krisha_goals_v1`, schema version 1, cap 24 goals over the shared
StorageAdapter â€” repair-don't-drop loading, future schema starts clean
(never guesses), write failures never break the engine, and eviction removes
completed/abandoned (oldest first), then stalest proposed â€” open work is
never evicted.

**Creation and updates (conservative by design).** Intent detection is
deterministic regex in the Context Engine's MEMORY_PATTERNS style: explicit
commitments ("let's build X", "I want to Y") create ACTIVE goals; soft
interest ("I'm thinking of building X") creates only a PROPOSED goal that
becomes active after an explicit short confirmation ("yes" / "go ahead");
questions, hypotheticals and chatter create nothing. Restatements update the
existing goal (similarity â‰¥ 0.62 or a full token-subset match) instead of
duplicating it; a completed goal is never silently resumed â€” a new similar
statement starts a new goal. Lifecycle statements ("we completed X", "pause
this", "that goal is finished", "let's drop that goal") resolve their target
by content similarity (â‰¥ 0.5) or, for generic references ("this objective"),
only when EXACTLY ONE goal is open â€” with several open goals the statement
is flagged, never applied. The host calls `goals.observeMessage(text)` once
per message (App.tsx, one line); the engine also attaches to the shared bus:
TASK_COMPLETED records milestones for similar ACTIVE goals (never
auto-completing), TASK_FAILED only bumps activity, TASK_CANCELLED changes
nothing (emergency-stop semantics preserved), and
`PROJECT_STATUS_UPDATED {forgotten:true}` strips stale project references
(lazily revalidated against approved profiles on briefing).

**Resumption, not execution.** `resumptionBriefing(input)` ranks open goals
by relevance (or recency with no input) and returns bounded briefings â€”
status, completed-so-far, remaining, blockers, satisfied dependencies,
project refs â€” plus a hint when a VERIFIED reusable learned skill matches
(`SkillEngine.match`, score â‰¥ 0.6, no blockers; hints are informational
only). Briefings are emitted as `GOAL_RESUMPTION_BRIEFED` events with a
per-goal 10-minute rate limit; unrelated messages brief nothing. The engine
never calls a tool; every goal mutation is exposed only through Phase 18
gates via `goal.list`/`goal.brief` (riskLevel safe) and
`goal.create`/`goal.update`/`goal.forget` (low, `memory.access`), so
emergency stop blocks goal mutations exactly like every other capability.

**Reusing existing systems (no duplicates).** Durable context rides the
existing MemoryService â€” one compact `[goal <id8>] â€¦` mirror record per goal
(metadata marker `goalId`, tag `goal-continuity`), updated on transitions
and released through `MemoryService.forget` on forgetting; the marker scans
touch only the engine's own records, never user memories. Relationships ride
the existing KnowledgeGraph: one `goal` node per goal with a `User --owns-->
goal` edge, `related_to` edges to approved project nodes and `blocks` edges
for dependencies, all tagged `goal_continuity`. Graph pruning uses one
COMPLETE edge snapshot (the cap-blindness lesson from Â§30: per-node relation
queries hard-cap at maxQueryResults=10) and reference-counted deletion;
nodes owned by other systems (projects, the user node) are never deleted.
Because mirrors live in memory/graph, chat context and agent-task context
retrieve goals through pipelines that already exist â€” no ContextEngine or
server changes. Self-Diagnostics gained a passive `intelligence.goal_continuity`
check reading the engine's bounded stats snapshot.

**Integration.** `bridge.ts` constructs the engine (storage, bus, memory,
knowledge graph, projects, skills, task resolver) and registers its tools;
`AgentSystem.goals` exposes it; `detach()` unwinds it. Regression-tested in
`scripts/test-goal-continuity.ts` (163 assertions) covering creation,
dedup, transitions, confirmation flow, multi-goal ambiguity, cap eviction,
restart persistence, corrupted/future storage, briefings and rate limiting,
project association and forgetting, memory-mirror ownership, >10-edge graph
pruning, task milestones vs cancellation, permission denial, emergency stop,
and verified-only skill hints.

## 32. Screen Privacy Firewall (SPF)

**Boundary.** SPF is a mandatory, fail-closed security boundary between screen
observation and EVERY external transmission. It is not advisory and not
agent-visible: there is no override API, and decisions run outside any tool
context. Core: `src/agent/spf/` (types, detectors, decision, redact, audit,
firewall; browser-safe, dependency-free). Full investigation and enforcement
map: `SPF-ARCHITECTURE-REPORT.md`.

**Detection** (`detectors.ts`). Local, deterministic pattern+structure
detectors: passwords/credential pairs (incl. JSON-field and HTML-input
forms), Google credentials (API keys, OAuth tokens), OTPs (keyword+digit,
G-codes, TOTP URIs), bank details (IBAN/IFSC/labeled, JSON fields), card
numbers (Luhn-validated, JSON fields), CVV, API keys/tokens (vendor
prefixes, labeled, bearer, JWT, auth headers, DB URLs), private keys, seed
phrases, national IDs (SSN, Verhoeff-validated Aadhaar, PAN, NINO),
confidential-document context. URI-decoded and base64-encoded variants are
scanned presence-only (unmappable spans force conservative decisions).
Markers emitted by SPF itself are excluded from rescans.

**Decisions** (`decision.ts`). ALLOW / REDACT / BLOCK per payload kind:
confident, delimited secrets in text are redacted (`[REDACTED-SPF:<cat>]`,
value-only spans keep JSON valid) and the redacted copy is re-scanned
(residual secrets -> BLOCK); unredactable, low-confidence, excessive-
coverage, timeout (>200ms deadline), detector-error, or unscannable payloads
BLOCK. Unknown/uncertain content defaults to BLOCK on screen-provenance
transports; chat-history (mixed provenance, screen parts sanitized upstream)
downgrades uncertain-only findings to a flagged allow. Images: any sensitive
signal, credential-indicating window title, or credential-extraction
question BLOCKs the transfer (no local OCR exists to separate pixels).

**Enforcement points.** Server (`server.ts`): /api/vision/analyze image gate
+ response-text screening (EP-1), /api/chat outbound prompt gate with
graceful blocked reply (EP-2), /api/maps/grounding (EP-3),
/api/memory/extract (EP-4), /api/tts (EP-5), /api/audio/transcribe prompt
(EP-5b), /api/location/geocode (EP-6), /api/research/search + fetch (EP-7),
/api/browser/navigate (EP-8), web-search URL builders (EP-9). Agent/browser:
`geminiVision.ts` pre-send gate + post-receive screening (EP-10),
`ScreenVisionModal` ask gate (EP-11), screen-text sanitization before chat
persistence (EP-12), per-item screening in screen tool outputs (EP-13),
task summaries (EP-14) and the multimodal provider digest (EP-15).
System-wide net (`outboundGuard.ts`, EP-16): patches `globalThis.fetch` and
the shared `node:http(s)` `ClientRequest` prototype â€” ANY outbound request
in the server process is screened (URL, non-operational headers, body);
redactable string/JSON bodies are rewritten with the sanitized copy (JSON
validity enforced), everything else is blocked/destroyed. The app's own
operational auth headers (e.g. `x-goog-api-key`) are exempt â€” SPF guards
screen-derived content, not the app's configured keys.

**Audit.** `SpfAuditLog` bounded ring (events: category, observation id,
destination, decision, reason, confidence, timestamp, non-reversible hash
prefix â€” never raw content) with listeners for the future Action
Transparency interface; server decisions additionally append to the existing
tamper-evident E5 audit chain via `appendAuditSyncSafe({kind:'spf_decision'})`.

**Tests + performance.** `scripts/test-spf.ts` (220 assertions, ALL GREEN):
all 23 task scenarios incl. wire-level outbound verification against a
controlled local receiver, live-server endpoint gates (spawned via
KRISHA_PORT=3100, blocked paths return before any model call), evasion
attempts (URI/base64/header smuggling, flag injection), no-override proof,
leakage checks, and regressions of Phase 4/13 observation and Phase 18
emergency-stop behavior. `scripts/measure-spf-performance.ts`: typical
screen-summary inspection p50 ~0.13ms, 1KB OCR ~0.25ms, 16-message chat
gate ~1.8ms, 10KB OCR ~2.6ms, bounded memory (~4MB heap delta over 13.6k
inspections). Residual risks (no local OCR â€” context-driven image gating;
split-secret fragmentation; novel secret formats) are documented in
`SPF-ARCHITECTURE-REPORT.md` Â§7.

## 33. Local Private Vault (LPV)

**Boundary.** LPV is a post-roadmap capability for retaining credentials
locally: encrypted at rest, category-gated retention, controlled retrieval,
separate from ordinary memory. It is the RETENTION authority; SPF (Â§32)
remains the EGRESS authority â€” the two decisions are independent. LPV makes
zero network calls, never feeds /api/chat or any SPF-enforced egress path,
and never returns a secret to any caller. Core: `lpvCore.ts` (server-side,
root module) + `lpvDpapi.ts` (dedicated DPAPI bridge); UI:
`LocalVaultModal.tsx` + `LpvApprovalCard.tsx`.

**Storage.** `lpv/` inside the E5 protected store (Â§E5, ProgramData default)
â€” inherits placement invariant, `assertNotProtected` refusal to the fs
agent, `fsSearch` skip, and is never OneDrive-synced. Files: `vault.json`
(entries + policy + keyed MAC), `vault.json.bak` (previous generation),
`key.blob` (DPAPI-wrapped master key, SEPARATE from the encrypted data),
`account.json` (Windows SID binding), `audit/lpv-audit.jsonl` (hash-chained,
fsync-per-entry, metadata-only records).

**Crypto.** Master key = 32 random bytes, wrapped with DPAPI
`DataProtectionScope.CurrentUser` via a DEDICATED persistent PowerShell
process (`lpvDpapi.ts` â€” separate from the mouse/keyboard worker; data
moves through stdin pipes only, never argv/env). HKDF-derived subkeys:
`enc` for per-entry AES-256-GCM (random 12-byte IV per save; AAD binds
`{id, categoryKey, updatedAt}` against relocation/splicing) and `mac` for
HMAC-SHA256 over the canonical FULL document â€” policy and plaintext
metadata included, so deliberate modification (not just accidental
corruption) is detected. Account binding: the wrapping SID is recorded at
creation and verified at every unlock. Corruption/tamper is ALWAYS
fail-closed (TAMPERED state, key material zeroed, nothing recreated) â€” the
only recovery paths are the operator's MAC-verified `restoreFromBackup`
(previous generation, with generation-consistency detection) or a
documented manual reset.

**Retention policy.** Category A (google, email_primary, banking, payment
â€” and EVERY unclassified/user-defined category by default): save requires
explicit approval (operator UI two-step confirm, or an approved challenge
for automation); never auto-saved. Category B: only categories the user
explicitly enabled (`policy.autoSaveCategories` + master toggle; disable
anytime). Category C (OTP/verification codes/CVV/temporary secrets):
explicit label-rejection table + shape rules (6â€“8 digit code in code-labeled
context, base32 TOTP-seed shape); ANY hit refuses the save â€” heuristics are
best-effort and fail-closed, never claimed complete.

**Locking.** Boot is ALWAYS locked (never persisted-unlocked). Auto-lock
after `policy.autoLockMs` (default 5 min, 30 sâ€“1 h clamp) of inactivity
where ONLY authorized activity resets the timer (mutations/unlock/fills â€”
read-only polls never do); an in-flight fill completes before locking;
lock zeroes the master key + subkeys; shutdown hooks (SIGINT/SIGTERM/
beforeExit) lock and re-raise. Locked vaults refuse every retrieval and
fill path (enforced in the route layer AND inside lpvCore); metadata list
and audit history remain readable (flagged `verified:false` while locked).

**Fill (the ONLY retrieval path).** Grants are server-minted, SINGLE-USE,
â‰¤60 s TTL, bound to {entryId, operation, approved origin}, issued ONLY by
explicit operator approval (UI click via `/api/vault/fill/request`, or an
approval challenge approved through the operator card â€” the model can
request a challenge via `/api/vault/challenge` but can never approve one;
`/api/vault/challenge/status` is the requester-side seam for future agent
integration). Fill verifies the CDP top-frame page origin against the
grant BEFORE typing, requires a real `input[type=password]` for the
password field (username: text/email/tel), ignores iframes, refuses
navigation detected between pre-check and post-check, and returns metadata
only. Secrets transit serverâ†’CDP only; buffers are zeroed after use.
Desktop-app fill via SendInput keyboard automation is a documented future
seam (interface exists; not wired).

**Permissions.** `vault.manage` (operator baseline true â€” management UI),
`vault.retrieve` (baseline FALSE everywhere, client AND server; satisfied
only by approval-issued `once` grants consumed remove-before-grant at the
route layer). Every mutating route is stop-blocked (E5 M1 enforcement,
423 while the emergency stop is ACTIVE) and rate-limited.

**Separation from ordinary memory.** No code path connects lpvCore to
prompt assembly or the memory system; `MemoryService.SECRET_PATTERNS`
rejects credential-shaped memories independently; task-context `outputKey`
cannot capture fill results (fill responses are metadata-only).

**Tests.** `scripts/test-lpv-core.ts` (80 assertions, ALL GREEN): init,
unlock/lock + key zeroing, CRUD + unique-IV/encrypted-at-rest properties,
policy bypass refusals, Category C refusals (all rules), challenge
lifecycle + replay refusal, grant lifecycle (single-use/expiry/binding),
deterministic auto-lock + in-flight deferral, MAC tamper detection,
generation inconsistency, boot-time corruption detection (children),
restart recovery (child = real module reload), degraded-mode refusal
(child), audit chain verification + tamper evidence. 
`scripts/test-lpv-security.ts` (32 assertions, ALL GREEN): route-layer
403/once-consumption/423, locked-state defense in depth, console/audit
redaction scans, MemoryService rejection, LIVE CDP fill (origin-verified,
password-field-verified, leak-free response, single-use, cross-origin
refusal, field_not_found honesty). `scripts/test-lpv-perf.ts` (11, ALL
GREEN): init 528 ms, unlock ~40 ms (warm DPAPI worker), save avg 13.3 ms
(AES-GCM + HMAC + fsync), update 13.5 ms, list 0.2 ms, lock 4 ms, auto-lock
evaluation negligible.

**Honest limits (do not weaken).** Same-user local processes remain the
documented E5 trust boundary (DPAPI narrows but does not defeat a
determined same-user actor). JS string copies of secrets are GC-owned â€”
Buffers the module owns are zeroed, strings are transient by design.
Secure delete removes ciphertext from the live document and current
backup; NTFS freed-cluster retention and system shadow copies are out of
scope. OTP/temp-secret detection is heuristic, fail-closed, not exhaustive.
The filled page necessarily receives the secret (inherent to filling).
Degraded storage disables ALL vault writes/unlock/fill â€” guarantees are
never weakened for availability.

**Post-implementation security audit (repairs D1â€“D8).** Independent audit
findings, all repaired and regression-tested:
- **D1 (high, fill TOCTOU)**: origin verification and fill execution each
  independently resolved "first page target" â€” with â‰¥2 tabs the check and
  the typing could land on different pages. Repair: `browserCdp
  .browserFillFields(expectedOrigin, script)` probes all open pages,
  pins the fill to the page whose LIVE origin equals the approved origin,
  and the fill expression re-verifies `location.origin` atomically with
  the typing (one evaluate, one page); the advisory pre-check no longer
  hard-refuses on first-page origin mismatch (multi-tab correctness).
- **D2 (medium)**: approved SAVE challenges are now bound to the exact
  approved draft (categoryKey + title) at consumption; save challenges
  without a draft are refused.
- **D3 (medium-low)**: approved challenges now expire at their original
  TTL â€” approvals cannot be redeemed after the 10-minute window.
- **D4 (low)**: unlock operations are serialized (promise chain) â€”
  concurrent unlocks can no longer orphan an unzeroed unwrapped key.
- **D5 (low)**: `requestUiFill` refuses in degraded mode (no grants that
  cannot be honored).
- **D6 (low)**: test-hook `forceLockMemory` zeroes subkeys before drop.
- **D7 (low, accuracy)**: 1â€“2-character field attributes no longer match
  bidirectionally in fill field scoring.
- **D8 (low, transparency)**: pending fill challenges resolve the display
  origin from the entry so the approval card always shows the destination
  the grant binds to.
- **DPAPI hardening**: the dedicated PowerShell worker now deterministically
  clears plaintext byte arrays (`[Array]::Clear`) after protect/unprotect.
- Tests: core 87 (+7: draft binding pos/neg, save-challenge draft
  requirement, TTL expiry, built-in-A policy immunity, card origin),
  security 35 (+3: multi-tab pinning both directions, no-match refusal).

**Security closure (approval authority, CDP race conditions, repeatability).**
Final closure repairs, all regression-tested:
- **Approval authority (human decision enforced server-side)**: fill
  challenges now carry the EXACT operation (entry + validated field specs,
  no values) and approval EXECUTES it server-side — no grant capability is
  ever created or returned to the requester, and `challenge/status` exposes
  state + metadata outcome only (never a grant). Every challenge carries a
  server-minted ONE-TIME decision token delivered ONLY through the
  operator-facing pending-approvals listing: blind `approve(challengeId)`
  calls, forged tokens and cross-challenge token substitution are refused
  (timing-safe comparison). Declined/expired/consumed challenges cannot be
  redeemed. Honest boundary: the server still cannot cryptographically
  distinguish the operator's browser from another same-user process — the
  documented E5 trust boundary, unchanged.
- **Core-level emergency-stop gate**: retrieval, approval, grant issuance
  and entry/policy mutations re-check `stopKind()` in-process (defense in
  depth alongside the route layer's stopBlock).
- **CDP race repairs (nondeterministic `origin_mismatch`/`page_not_ready`)**:
  root causes were (1) `browserNavigate` returning on the OLD document's
  `readyState==='complete'` while the navigation raced on, (2)
  `browserCreateTab` not waiting for the new tab's load, and (3) test
  infrastructure navigating to already-closed local servers. Repairs:
  navigate waits for `Page.loadEventFired` of the NEW document (registered
  before `Page.navigate`) and detects FAILED navigations (final url still
  the pre-navigation one ≠ requested → throws); createTab waits for a
  stable loaded state strictly; `ensureBrowser` health-checks the cached
  WebSocket (`Browser.getVersion`) so a dying browser is relaunched instead
  of trusted; `browserStop` waits (bounded) until the debug port is actually
  free; `browserHardReset` kills a stale port-9223 listener by PID for
  repeatable suite runs. D1 semantics preserved and strengthened: fills
  still probe all pages, pin to the matching origin, and re-verify origin
  atomically in-page.
- **Fill serialization**: all typed fills (grant path AND approval-executed)
  run through one promise chain; the in-flight counter increments at call
  time so auto-lock defers for accepted-but-queued fills too.
- Repeatability: the security suite — previously crashing ~1-in-3 runs —
  now passes CONSECUTIVE runs identically (55 assertions each). Tests: core
  92 (+5 approval-authority adversarial), security 55 (+20: approve-and-
  execute flow, blind/forged/cross-token/consumed refusals, status
  metadata-only, concurrency, restart, core-level stop gate).

## 34. SPF Visual Remediation â€” local OCR screenshot inspection

**Gap closed.** The Â§32 image gate decided from transfer metadata only; a
password rendered inside a screenshot with clean metadata could reach the
cloud. Every screenshot now passes a LOCAL pixel-inspection boundary before
any external transmission. Design and options evaluation:
`SPF-VISUAL-REMEDIATION.md`.

**Engine.** Windows.Media.Ocr (WinRT) driven through a persistent
PowerShell worker (`src/agent/spf/visualInspection.ts` â€” Node-only, same
zero-dependency pattern as the Phase 5/6 workers). Fully offline, no npm
dependencies, no cloud OCR; engine languages are the OS-installed OCR
languages; unavailability (non-Windows, no language pack, boot failure) is
fail-closed. Bounded: 8192px dimension cap, 400-line cap, per-op timeout
(4s default) kills and reboots the worker, whole-pipeline deadline (6s).

**Pipeline** (`inspectImageForTransmission`): OCR inspect (line texts +
bounding rects; text stays local, never logged/persisted/audited) â†’ the
EXISTING SPF detectors run per line â†’ matched line regions are mapped to
padded, clamped rects â†’ solid-black pixel replacement (System.Drawing,
irreversible â€” never blur) â†’ JPEG re-encode â†’ MANDATORY second OCR +
re-detection of the sanitized image (residual content, OCR error, re-encode
failure, or unchanged payload â‡’ BLOCK) â†’ only the verified payload is
returned; the endpoint forwards exactly that payload to Gemini.

**Wiring** (`server.ts`): `/api/vision/analyze` â€” metadata gate (fast fail,
never a fallback) â†’ visual pipeline â†’ on REDACT the sanitized base64
replaces the original in the coalesced model request; content-free
`spfImage` metadata on every response path (incl. model failures); durable
`spf_visual_decision` audit records (categories/counts only) + in-memory
transparency event. The route is now ENFORCED_ROUTES stop-blocked â€” cloud
image egress returns 423 while the emergency stop is active. Both client
upload paths (vision provider, ScreenVisionModal) funnel through this single
boundary; no direct image-upload path bypasses it.

**Tests** (`scripts/test-spf-visual.ts`, 93 assertions, ALL GREEN): 10
synthetic-screenshot scenarios (password, OTP, Google key, bank, card+CVV,
multi-region, boundary text, sizes/resolutions, resized/cropped derivatives,
clean), wire-level verification against a controlled local receiver (safe
images byte-identical; sensitive images arrive ONLY after redaction;
receiver-side re-OCR proves secrets unreadable; pixel sampling proves
irreversible black replacement; original captures never arrive), all
fail-closed injections (unavailable/timeout/malformed/bad-rects/redaction/
re-encode/verification/invalid-payload), direct-upload bypass, emergency
stop (423), and leakage checks. Spawned servers use isolated temporary
KRISHA_SANDBOX_DIR stores (real E5 store verified untouched before/after).
`scripts/measure-spf-visual-performance.ts`: worker boot 434ms (one-time),
OCR inspect p50 21-30ms by size, redaction p50 26ms, verification p50 26ms,
full clean-image pipeline p50 25ms, full sensitive pipeline (2 OCR passes +
redact) p50 68ms.

**Honest limitations**: OCR-based inspection is not complete â€” very small
fonts, low-contrast text, non-Latin scripts and stylized renderings may not
be recognized (a valid empty OCR result is an allow; engine failures are
never treated as "no text"); Google-key detection tolerates the engine's
AIzaâ†’Alza reading; single-language OCR coverage; Windows-only (other
platforms fail closed).

## 35. SPF + LPV Integration Baseline (consolidated)

**Reference document:** `SECURITY-INTEGRATION-BASELINE.md` (integration date
2026-11-15). This section summarizes the two security subsystems' shared
operating picture; §32/§33/§34 remain the authoritative per-subsystem
documentation.

**Boundaries.** SPF governs the TRANSMISSION of screen-derived information
across the external boundary (detection, OCR pixel inspection, irreversible
redaction, transport guard, metadata-only audit). LPV governs credential
RETENTION and authorized LOCAL retrieval (DPAPI-wrapped encrypted local
store, approval challenges, pinned origin-verified browser fills,
metadata-only responses). Neither bypasses the other: LPV secrets leave the
device only through SPF-gated channels (none do — fills ride a loopback CDP
WebSocket to the local browser), and SPF never retains credentials
(detection results are categories/counts, never values; LPV is the only
retention authority and nothing auto-saves into it).

**Credential lifecycle (LPV):** save (Category A requires operator approval;
auto-save only for opted-in Category B, secret-shaped content refused) →
DPAPI-wrapped master key + AES-256-GCM per-entry + HMAC over the full
document → unlock (Windows account-bound) → retrieval/fill only via
server-minted single-use grants bound to {entry, origin}, issued ONLY by
operator-approved challenges (decision tokens; no model-callable approval —
the model can request a challenge and nothing more) → lock/auto-lock zeroes
key material; tamper is fail-closed. Route layer: `vault.manage` /
`vault.retrieve` server permissions, stop-blocked, rate-limited; no vault
tool exists in the agent ToolRegistry.

**Screen-derived data lifecycle (SPF):** capture (on-demand, permission-
gated) → local pixel inspection (Windows.Media.Ocr worker; every frame/page
of a container; malformed/empty-transcript validation) → existing SPF
detectors per recognized line → sensitive regions irreversibly blacked out
+ re-encode → MANDATORY second inspection → only the verified payload may
continue to a model (metadata signals remain an additional fast-fail layer,
never a fallback) → response text screened before re-entering Krisha →
metadata-only audit (`spf_decision`/`spf_visual_decision` in the E5 chain
plus the in-memory transparency ring).

**Browser-fill destination verification (LPV):** probe walks ALL open CDP
page targets, pins the one whose LIVE origin equals the approved origin,
requires `readyState === 'complete'`, and the in-page expression re-verifies
`location.origin` atomically with the typing; post-fill navigation check.
A page that refuses or navigates → nothing typed.

**Emergency stop:** one durable server-side stop governs both subsystems —
SPF-enforced routes return 423 (including `/api/vision/analyze` and every
vault mutation/fill route), LPV refuses vault operations while a stop is
active (`assertStopInactive`), recovery remains operator CLI + credential
only.

**Audit & leakage protections:** both audit trails are metadata-only
(categories, routes, decisions, counts, non-reversible hash prefixes —
never values); fill responses return fill-state metadata only (asserted);
no secrets enter chat history, memory, task summaries, the activity feed or
Action Transparency (SPF gates the conversation/memory/tts/speech egress
paths; LPV emits no bus events).

**Test-isolation requirement (permanent):** every spawned test server sets
`KRISHA_SANDBOX_DIR` + `KRISHA_FS_ROOTS` to temporary directories BEFORE
module initialization; the real E5 protected store must remain byte-for-byte
unchanged across test campaigns (verified by `scripts/spf-real-store-status.ts`
before/after: audit entry count, stop kind and file hashes identical).

**Integration regression results (2026-11-15):** SPF text 220/0, SPF visual
113/0, LPV core 92/0, LPV security **5×55/0** (five consecutive runs), LPV
perf 11/0, E5 M1/M2/M3/H4 86/74/72/70 all 0 failed, Phase 13/14/18
91/150/62 all 0 failed, agent-core 49/0, goal-continuity 163/0,
`tsc --noEmit` clean; real store unchanged (hash-verified).

## 36. Security System Phase A — Independent Process Monitoring

**Status:** implemented and verified (report: `SECURITY-SYSTEM-PHASE-A-REPORT.md`).
**Boundary:** visibility ONLY — no process control exists anywhere in the
subsystem (no terminate/suspend/quarantine tool, route, or capability).

**Mechanism (all non-admin, MEASURED):** a persistent PowerShell worker
(`PowerShellWorker` pattern) registers **temporary, session-owned WMI event
subscriptions** — `__InstanceCreationEvent` / `__InstanceDeletionEvent
WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'` — and streams events to
the parent as JSON lines. No permanent WMI consumers; subscriptions die with
the worker; the worker self-exits when the parent PID disappears and Node
kills it on shutdown. Health model: STARTING → ACTIVE (both subscriptions
confirmed) → DEGRADED (partial subscriptions, stale heartbeat, re-arming) →
FAILED (retry budget exhausted) / STOPPED (intentional) — never silently
"fully monitored". Bounded re-arm backoff (1→16 s, 5 attempts).

**Inventory:** bounded PID-keyed map (≤2000, terminated-first eviction):
startup snapshot marks pre-existing processes, creation/deletion events
track lifecycle, parent-child links resolve through the inventory, PID
reuse replaces entries (counted), out-of-order deletions recorded honestly
(`unobservedTerminations`), on-demand bounded reconcile. Enrichment is
honest: a missing ExecutablePath is `unavailable`, never invented.
**No command lines are collected** (secret risk).

**Audit:** lifecycle/health events only (kinds + counts) into the E5 chain
via the injected sink; individual process events stay in the bounded
in-memory ring (≤500, drop-oldest, overflow audited). Names/paths never
enter audit records (suite-asserted).

**Surface:** `GET /api/processmonitor/status` (read-only; optional
`reconcile=1`) + ONE agent tool `processMonitor.status` (SAFE, read-only,
fetch-backed). No control tool or route exists (suite-asserted 404).

**Tests:** `scripts/test-process-monitor.ts` — 66 assertions, 0 failed,
two consecutive green runs: event semantics (creation/termination/lineage/
enrichment/PID reuse/out-of-order/overflow), boot failure → bounded retries
→ FAILED, worker crash → re-arm (mechanism-level recovery 61-64 ms),
stale-heartbeat re-arm, graceful shutdown, no-control-surface assertions,
emergency-stop compatibility, metadata-only audit (fake + real worker),
real-WMI performance (idle CPU 0-63 ms per 8 s window; detection latency
321-2703 ms for 11/12 long-lived spawned children; whole-process RSS delta
negative/neutral — monitor state is a ≤2000-entry map + ≤500-event ring),
isolated-server restart with subscription re-init.

**Known limitations (honest):** WMI `WITHIN 1` polling cannot observe
processes born and dead between polls (fast-exit coverage requires elevated
ETW — an operator decision, Phase 1 §20); ~1 s event granularity; inventory
is honest-not-complete (gaps counted and labeled); same-user ceiling (the
monitor is non-admin and cannot be defended against same-user malware
non-admin — only re-armed and evidenced); Windows-only.

**Performance note (constrained hardware):** the monitor adds no measurable
resident memory to the server process beyond the bounded structures above,
no idle CPU beyond the WMI/kernel eventing (0-63 ms per 8 s idle window
including test harness), and no periodic disk writes (lifecycle audit lines
only, on state transitions).

## 37. Security System Phase B — Malware Detection and Classification

**Status:** implemented and verified (report: `SECURITY-SYSTEM-PHASE-B-REPORT.md`).
**Boundary:** detection and classification ONLY — no process termination, no
file quarantine, no execution blocking, no Defender configuration changes,
no external reputation lookups. Control surfaces are deliberately absent.

**Architecture (modular evidence sources, deterministic rules):**
- **Microsoft Defender integration** (`defenderSource.ts`): read-only
  `Get-MpComputerStatus` + `Get-MpThreatDetection` via cached PowerShell
  (60 s TTL). No settings/exclusion/policy changes. Unavailable means
  honest `available:false`.
- **File reputation** (`fileReputation.ts`): local SHA-256 (Node crypto),
  Authenticode signature (read-only PowerShell), location classification
  (windows/program-files/user-apps/temp/roaming/downloads/other). Bounded
  LRU cache (500) keyed by `(path|mtime|size)` — unchanged files are never
  re-hashed; changed files invalidate automatically. External reputation
  lookups disabled by design (`EXTERNAL_REPUTATION_ENABLED = false`).
- **Phase A monitor integration**: subscribes through the monitor's
  `onEvent()` internal interface (no second monitor). Ancestry correlation
  through the inventory's parent-child links. Monitor DEGRADED/FAILED is
  reflected in engine health and recorded as missing evidence.
- **Detection engine** (`engine.ts`): deterministic rules — Defender match
  → CONFIRMED_MALWARE; dual-use guard caps known security tools (Hydra,
  Nmap, Wireshark, etc.) at UNKNOWN; indicator counting (invalid signature
  [strong], unusual location, suspicious ancestry, repeated pattern [weak])
  → HIGH_CONFIDENCE_THREAT (strong+1 or >=3) / SUSPICIOUS (1-2) / UNKNOWN /
  CLEAN (valid signature). Every record carries classification, confidence
  level, evidence sources, timestamp, process/file reference, explanation,
  and missing evidence.

**Dual-use classification (Hydra et al.):** known legitimate security tools
are capped at UNKNOWN by Krisha-side indicators — never classified as
malicious from name or presence alone. Only a trusted Defender detection can
escalate them to CONFIRMED_MALWARE.

**Audit:** classifications at SUSPICIOUS and above flow to the E5 chain
(metadata only: classification, confidence level, pid, path, evidence
kinds, engine version). No command lines, file contents, or hash values
appear in audit records (suite-asserted).

**Surface:** `GET /api/malwaredetect/status` (engine health, Defender
availability, recent classifications) + `POST /api/malwaredetect/assess`
(on-demand file assessment, `filesystem.read` permission-gated via
ENFORCED_ROUTES) + TWO agent tools (`malwareDetect.status`,
`malwareDetect.assessFile`). No control routes or tools exist.

**Tests:** `scripts/test-malware-detect.ts` — 54 assertions, 0 failed: 23
scenarios covering Defender integration (active/unavailable/confirmed
detection), signature assessments (unsigned/valid/invalid), missing path,
unknown executable, suspicious ancestry, corroborating indicators,
false-positive resistance, Hydra dual-use classification (UNKNOWN capped,
Defender override to CONFIRMED), PID reuse, missing events, Phase A
DEGRADED/FAILED, hash caching + invalidation, permission boundaries,
emergency-stop compatibility, audit privacy, queue/cache bounds, and
performance bursts (real Defender + real file source).

**Known limitations (honest):** no external reputation lookups (unsigned
unknown = UNKNOWN, not malicious); pattern-based detection cannot catch
novel threats (no AI/ML model loaded); classification confidence is
level-based (LOW/MEDIUM/HIGH), not calibrated percentages; Defender is the
real-time AV authority (Krisha does not duplicate it); same-user ceiling
from Phase 1 applies; file-hashing a large executable takes time on SMR HDD
(cached after first assessment); short-lived processes limited by Phase A
WMI WITHIN-1 window.

## 38. Security System Phase C — Protected Execution and Threat Containment

**Status:** implemented and verified (report: `SECURITY-SYSTEM-PHASE-C-REPORT.md`).
**Boundary:** centralized Krisha-managed launch gate — NOT system-wide
enforcement. Containment (terminate/quarantine) deferred to Phase D.

**Execution decision model:** ALLOW / BLOCK_CONFIRMED_MALWARE (non-overridable) /
REQUIRE_USER_APPROVAL / DENY_UNVERIFIED / BLOCK_SYSTEM_UNAVAILABLE.
CONFIRMED_MALWARE is only produced by trusted Defender detection evidence
(Phase B, exact normalized path matching per Phase B.1). User approval cannot
override a confirmed-malware block.

**Enforcement:** the gate is injected into `systemAgentServer.ts` via
`setExecGate()` and called before every `appLaunchByName()` / `appLaunchByPath()`
spawn. Both launch pathways pass through one centralized decision.
**No alternate Krisha launch pathway bypasses the gate.**

**File identity and replacement detection:** the decision is bound to
`(path, mtimeMs, size)`. Before launch, `stat()` re-verifies the file identity.
A changed file invalidates the prior classification and forces re-assessment.
Approval tokens bind to the identity at approval time.

**Approval tokens:** single-use, 5 min TTL, bound to `{path, mtimeMs, size,
classification}`. Issued via `POST /api/execgate/approve` (requires
`application.launch` permission). `issueApproval` returns null for
CONFIRMED_MALWARE (non-overridable). Stale/expired/reused tokens → BLOCK.

**Phase A reliability fix:** the watchdog now considers BOTH heartbeat and
event liveness (during bursts, events prove the worker is alive even without
heartbeats). This addresses the root cause of transient DEGRADED under
concurrent process spawns. Residual timing edge case documented.

**Tests:** `scripts/test-exec-gate.ts` — 41 assertions, 0 failed. Full
regression green (SPF 220/113, LPV 92/55/11, E5 86/74/72/70, Phase 18 62/0,
Process Monitor 65/1 transient, `tsc` 0 errors).

**Known limitations:** Krisha-managed launches only; containment deferred to
Phase D; same-user ceiling; transient burst DEGRADED (self-heals); no UI.

## 39. Security System Phase D — Threat Containment

**Status:** implemented, PID-reuse-corrected (Phase D.3), and verified
(reports: `SECURITY-SYSTEM-PHASE-D-REPORT.md`, `-D1-`, `-D2-`, `-D3-`).
**Boundary:** narrowly scoped defensive containment — terminates a single,
identity-verified, confirmed-malicious process instance after operator
approval. No broad kill, no name-based matching, no process-tree termination,
no automatic termination without approval, no quarantine.

**Process-instance pinning (Phase D.3 — PID-reuse correction):**
termination binds to a process-INSTANCE reference, never to a PID.
`OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)` is
acquired once at verification time; identity (creation time via
`GetProcessTimes`, image path via `QueryFullProcessImageName`) is read
THROUGH the retained handle; `TerminateProcess` acts on the same handle.
A handle refers to the kernel process OBJECT — if the process exits and
Windows reuses its PID, the handle still refers to the original object, so
the termination signal can never follow PID reuse. Documented Win32 APIs
under the same non-admin, same-user envelope taskkill required; no driver,
no security-setting changes, no `taskkill` fallback anywhere. Where a
terminate-capable reference cannot be opened (elevated/protected processes)
the outcome is `IDENTITY_NOT_GUARANTEED` — fail-closed, never PID-based.
Transport: one PowerShell worker per pin (`-EncodedCommand`; the
`-Command -` stdin REPL is unusable for stdin-reading workers — its host
reader competes with `[Console]::In.ReadLine()`), bounded timeouts on every
wait, release guaranteed on every path (`finally`).

**Identity verification (all through the pin):**
1. Pin acquisition → process must still exist (`ALREADY_EXITED` otherwise)
2. Creation time must match the approved instance (`REFUSED_PID_REUSED`)
3. Executable path must match the approved identity (`REFUSED_IDENTITY_CHANGED`)
4. Process name must match the approved identity (`REFUSED_IDENTITY_CHANGED`)
5. Metadata must be readable through the pin — empty path/creation time is
   ambiguous and fails closed (`REFUSED_IDENTITY_CHANGED`)
6. Pinned name checked against the protected-process set (authoritative)

**Authorization (Phase D.3 — server-side only):**
- Approval tokens are minted ONLY by `ThreatContainment.issueApproval(pid)`:
  the server reads the process identity through an OS reference, classifies
  the executable via the Phase B engine, and issues a single-use,
  5-minute-TTL, 24-byte-random token bound to the exact process identity
  `{pid, creationTime, executablePath, name}`. Only CONFIRMED_MALWARE is
  approvable (SUSPICIOUS/UNKNOWN/CLEAN/HIGH_CONFIDENCE_THREAT never).
- `contain()` validates the token against the PINNED identity (never against
  client data) and consumes it single-use; binding mismatches consume the
  token. Registry pre-checks reject unknown/expired tokens BEFORE any process
  probing (no existence oracle for unauthorized callers).
- The HTTP request shape carries ONLY `{pid, approvalToken}` — classification
  and identity are established server-side; the Phase D.2 client-supplied
  shape is rejected (400).
- Routes: `POST /api/containment/approve` and `POST /api/containment/contain`
  — both require the `application.launch` server permission, both are
  stop-blocked (423) and rate-limited (10/min each, separate groups). No
  agent tool reaches containment; no alternate route exists (suite-asserted
  404).
- The containment module classifies via an injected Phase B dependency — the
  classifier has no containment capability and cannot approve its own action.

**Approval authority (Phase D.4 + Phase D completion — permission is NOT an
operator decision; the credential IS):**
Source inspection established that this architecture has NO authenticated
operator identity, and approval surfaces are separated from the model only by
the browser-side gate and architectural discipline (disclosed as unenforceable
against a raw same-user caller). Correction in two stages:

1. **Phase D.4**: containment gained an independent `verifyApprovalAuthority`
   dependency and termination was DISABLED (`APPROVAL_AUTHORITY_UNAVAILABLE`)
   until a genuine authority existed.
2. **Phase D completion**: the authority became REAL — the operator enrolls a
   dedicated **containment approval credential** through the recovery pipe
   (`set-containment-credential` / `clear-containment-credential`; a channel
   with no model/tool path). The credential is a dedicated operator secret
   stored in the protected E5 store (`containment-approval.json`, scrypt +
   timing-safe compare + integrity self-hash — the same primitives as the
   stop state), deliberately SEPARATE from the episode-scoped recovery
   credential (which exists only during an active stop episode and is cleared
   on activation/recovery). Approval requires the credential to verify
   server-side — THE human decision moment; a server-generated token is never
   mistaken for it because a token can only be minted AFTER verification.
   Tokens remain single-use, 5-minute TTL, bound to the exact pinned process
   identity, and carry the **authority epoch** (bumped on every enrollment
   change): termination re-checks the epoch immediately before terminating,
   so a credential cleared or re-enrolled mid-operation refuses the
   termination. Failed approval verifications share an exponential backoff
   (no brute-force oracle); clearing the enrollment resets pacing and restores
   the D.4 disabled posture. `application.launch` remains a capability grant,
   never proof of an operator decision. The disclosed same-user OS boundary
   applies to the enrollment channel exactly as it applies to the recovery
   credential itself; the defended threat is agent self-authorization, not
   same-user malware (which can terminate processes directly without Krisha).
   Related finding (documented, unchanged — Phase C scope): the exec-gate
   launch approval shares the self-service property; its durable value is the
   non-overridable CONFIRMED_MALWARE block.

**Evidence requirements:** server-side Phase B classification of the pinned
executable, re-verified at containment time (fail-closed on assessment
failure; a downgrade between approval and containment refuses), fresh
(<24 h from the server's own assessment).

**Protected processes:** `lsass.exe`, `winlogon.exe`, `svchost.exe`,
`MsMpEng.exe`, `explorer.exe`, `node.exe`, `powershell.exe`, and other
critical processes are refused unconditionally (checked at approval AND at
containment against the pinned name).

**Termination:** `TerminateProcess` on the pinned handle (same-user,
non-admin). Access-denied / still-running reported honestly (`ACCESS_DENIED`);
uncertain outcomes are `VERIFICATION_UNAVAILABLE` — never reported as
success; post-termination verification runs through the SAME pin (exited →
`TERMINATED`; exited without successful termination → `ALREADY_EXITED`).

**Audit:** `threat_containment` events in the E5 chain — requestId, outcome,
reason, PID/name/creation time, classification, confidence, evidence
sources, evidence age, E-stop state, authorization result, termination
eligibility/attempt/result, post-verification result, token presence.
Metadata only: no token values, no executable paths, no secrets.

**Tests:** `scripts/test-containment.ts` - 142 assertions, 0 failed (Phase D completion). Covers: the credential-backed production authority end-to-end (enrollment gating, wrong-credential denial, epoch-staleness mid-operation refusal, cleared-authority fail-closed, re-enrollment restore), the E5 credential machinery (set/verify/clear/backoff/epoch on an isolated store), the full D.3 machinery (pinning, PID-reuse refusal, identity changes, ambiguous identity, IDENTITY_NOT_GUARANTEED, pin infrastructure failures, client-label injection ignored, classification downgrade, stale evidence, E-stop at entry/after-approval/pre-termination/concurrent, honest termination outcomes, single-use under concurrency, bounded token registry, audit correctness + metadata privacy), a real pin-worker smoke test (self-pin, read-only), and production-route runtime tests on an isolated store including credential enrollment through the spawned server's own recovery pipe (wrong credential denied; correct credential proceeds to identity read; benign-process approval refused by server-side classification; clearing restores the disabled posture).**Known limitations:** same-user ceiling (elevated/SYSTEM processes cannot be pinned -> IDENTITY_NOT_GUARANTEED); the approval credential defends against AGENT self-authorization - a same-user process can reach the enrollment pipe exactly as it can reach the recovery credential (the disclosed OS boundary; such a process can terminate processes directly without Krisha); containment approval requires operator enrollment - before `set-containment-credential` the D.4 disabled posture holds; permission-based (not identity-based) authorization throughout the Phase 18 doctrine; a malicious process could exit naturally before termination (reported honestly); tokens are consumed on any post-validation refusal (a refused containment requires fresh approval - deliberate fail-closed posture); WMI WITHIN-1 detection granularity for short-lived processes (Phase A); the E5 M1 recovery-pipe tests cannot run concurrently with the live app unless each process binds its own transport (fixed for all suites via KRISHA_RECOVERY_PIPE_PATH isolation).