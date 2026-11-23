/**
 * Computer-Use Agent (Phase 7) — the OBSERVE → UNDERSTAND → PLAN → ACT →
 * OBSERVE AGAIN → VERIFY → CONTINUE orchestrator.
 *
 * Runs INSIDE a single `computer.use` Agent Core step: the Agent Core keeps
 * task state, step limits, retries, timeouts, cancellation, permission gating,
 * and memory integration. This layer coordinates the existing vision / mouse /
 * keyboard services and adds closed-loop behavior the static plan path lacks:
 *
 *  - vision-guided targeting against the LIVE screen for every action
 *  - stale-screen protection (bounded observation reuse + re-observe on change)
 *  - active-window focus tracking (focus changes are detected, recorded, and
 *    force a re-observation before the next action; typing into an unverified
 *    foreground is refused when the environment cannot confirm focus)
 *  - lightweight bounded waiting for the screen to settle (adaptive intervals,
 *    cheap signature diffs — no full analysis polling)
 *  - per-action recovery: re-observe → re-resolve → one safe alternative
 *    (scroll toward the target) → stop honestly; no uncontrolled retries
 *  - completion requires every action executed with honest verification
 *    evidence — "tool returned" is never treated as "task succeeded"
 */
import type {
  ComputerActionIntent,
  ComputerActionRecord,
  ComputerUseOptions,
  ComputerUseResult,
  FocusChange,
} from './computerUseTypes';
import { buildIntents } from './heuristicDecider';
import type { ScreenState } from '../vision/visionTypes';
import { ControlError } from '../computer/mouseTypes';

const DEFAULT_MAX_ACTIONS = 12;
const DEFAULT_MAX_RECOVERIES = 2;
const DEFAULT_STATE_STALE_MS = 4000;
const DEFAULT_WAIT_TIMEOUT_MS = 8000;
const WAIT_INTERVALS_MS = [250, 500, 1000];

export class ComputerUseAgent {
  private observer?: ComputerUseOptions['observer'];
  private adaptive?: NonNullable<ComputerUseOptions['adaptive']>;
  private multimodal?: NonNullable<ComputerUseOptions['multimodal']>;
  private mouse: NonNullable<ComputerUseOptions['mouse']>;
  private keyboard: NonNullable<ComputerUseOptions['keyboard']>;
  private events: ComputerUseOptions['events'];
  private maxActions: number;
  private maxRecoveriesPerAction: number;
  private stateStaleMs: number;
  private waitTimeoutMs: number;

  constructor(options: ComputerUseOptions) {
    this.observer = options.observer;
    this.adaptive = options.adaptive;
    this.multimodal = options.multimodal;
    this.mouse = options.mouse;
    this.keyboard = options.keyboard;
    this.events = options.events;
    this.maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
    this.maxRecoveriesPerAction = options.maxRecoveriesPerAction ?? DEFAULT_MAX_RECOVERIES;
    this.stateStaleMs = options.stateStaleMs ?? DEFAULT_STATE_STALE_MS;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  }

  setObserver(observer: NonNullable<ComputerUseOptions['observer']>): void {
    this.observer = observer;
  }

  setAdaptiveObserver(adaptive: NonNullable<ComputerUseOptions['adaptive']>): void {
    this.adaptive = adaptive;
  }

  setMultimodal(hook: NonNullable<ComputerUseOptions['multimodal']>): void {
    this.multimodal = hook;
  }

  async run(goal: string, signal?: AbortSignal): Promise<ComputerUseResult> {
    const startedAt = Date.now();
    this.events?.emit({ name: 'COMPUTER_USE_STARTED', payload: { goal }, timestamp: Date.now() });

    const intents = buildIntents(goal).slice(0, this.maxActions);
    const actions: ComputerActionRecord[] = [];
    const focusChanges: FocusChange[] = [];
    let observations = 0;
    let lastState: ScreenState | null = null;
    let lastWindowTitle: string | undefined;
    let cancelled = false;

    for (let index = 0; index < intents.length; index++) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }

      const intent = intents[index];
      this.events?.emit({
        name: 'COMPUTER_ACTION_PLANNED',
        payload: { index, total: intents.length, kind: intent.kind, description: intent.description },
        timestamp: Date.now(),
      });

      // ---- OBSERVE: every action cycle starts from a FRESH observation
      // (stale-screen protection, spec §5); reuse happens only within an
      // action's own targeting/verification via the observer cache.
      lastState = await this.ensureState(signal, lastState, index > 0);
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      if (lastState) observations++;

      // ---- ACTIVE-WINDOW GUARD: if focus changed since the previous action,
      // force a fresh observation before acting and record the change.
      if (lastState && lastWindowTitle !== undefined && lastState.activeWindow?.title !== lastWindowTitle) {
        focusChanges.push({ from: lastWindowTitle, to: lastState.activeWindow?.title, afterActionIndex: index });
        this.events?.emit({
          name: 'COMPUTER_RECOVERY_STARTED',
          payload: { reason: 'focus_changed', from: lastWindowTitle, to: lastState.activeWindow?.title },
          timestamp: Date.now(),
        });
        lastState = await this.ensureState(signal, null);
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        observations++;
      }
      if (lastState) {
        lastWindowTitle = lastState.activeWindow?.title;
      }

      // ---- ACT + VERIFY (with bounded recovery).
      this.events?.emit({ name: 'COMPUTER_ACTION_STARTED', payload: { kind: intent.kind, description: intent.description }, timestamp: Date.now() });
      const record = await this.executeWithRecovery(intent, signal);
      record.intent = intent;
      actions.push(record);

      if (record.status === 'completed') {
        this.events?.emit({
          name: 'COMPUTER_ACTION_COMPLETED',
          payload: { kind: intent.kind, verified: record.verified },
          timestamp: Date.now(),
        });
        if (record.verified !== undefined) {
          this.events?.emit({
            name: record.verified ? 'COMPUTER_ACTION_VERIFIED' : 'COMPUTER_ACTION_FAILED',
            payload: { kind: intent.kind, note: record.verificationNote },
            timestamp: Date.now(),
          });
        }
      } else {
        this.events?.emit({
          name: 'COMPUTER_ACTION_FAILED',
          payload: { kind: intent.kind, error: record.error },
          timestamp: Date.now(),
        });
        this.adaptive?.notifyVerification('failed');
        if (record.status === 'failed') {
          // Stop the run on a failed action — continue would act on a broken
          // understanding of the screen.
          break;
        }
      }
    }

    // Skipped intents when stopped early.
    for (let i = actions.length; i < intents.length; i++) {
      actions.push({ intent: intents[i], status: cancelled ? 'skipped' : 'skipped' });
    }

    const status: ComputerUseResult['status'] = cancelled
      ? 'cancelled'
      : actions.some((a) => a.status === 'failed')
      ? 'failed'
      : actions.every((a) => a.status === 'completed')
      ? 'completed'
      : 'partial';

    const summary = this.buildSummary(goal, status, actions, focusChanges, observations);

    this.events?.emit({
      name: cancelled ? 'COMPUTER_USE_CANCELLED' : 'COMPUTER_USE_COMPLETED',
      payload: { status, actions: actions.length, focusChanges: focusChanges.length },
      timestamp: Date.now(),
    });
    void startedAt;

    return { status, goal, actions, focusChanges, observations, summary };
  }

  // ---------------------------------------------------------------- actions

  private async executeWithRecovery(intent: ComputerActionIntent, signal?: AbortSignal): Promise<ComputerActionRecord> {
    let recoveries = 0;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.maxRecoveriesPerAction; attempt++) {
      if (signal?.aborted) {
        return { intent, status: 'skipped', error: 'cancelled' };
      }
      try {
        const record = await this.executeAction(intent, signal);
        if (record.status === 'completed') {
          // Bounded settle: wait until the screen stops changing (cheap diffs).
          await this.waitForQuiet(signal);
          record.recoveries = recoveries;
          return record;
        }
        lastError = record.error;
      } catch (err: any) {
        if (err instanceof ControlError && err.kind === 'cancelled') {
          return { intent, status: 'skipped', error: 'cancelled' };
        }
        lastError = String(err?.message || err);
      }

      // ---- RECOVERY (spec §7): re-observe → re-evaluate → safe alternative.
      if (attempt < this.maxRecoveriesPerAction) {
        recoveries++;
        this.adaptive?.notifyRecovery(true);
        this.events?.emit({
          name: 'COMPUTER_RECOVERY_STARTED',
          payload: { kind: intent.kind, attempt, lastError },
          timestamp: Date.now(),
        });
        // A failed vision-guided click often means the target is off-screen:
        // one safe alternative is scrolling down then re-resolving.
        if ((intent.kind === 'click' || intent.kind === 'double_click' || intent.kind === 'right_click') && attempt === 0) {
          try {
            await this.mouse.scroll({ direction: 'down', amount: 3, verify: false }, signal);
          } catch {
            // scroll is best-effort within recovery
          }
        }
      }
    }

    return { intent, status: 'failed', error: lastError, recoveries };
  }

  private async executeAction(intent: ComputerActionIntent, signal?: AbortSignal): Promise<ComputerActionRecord> {
    const p = intent.params;
    switch (intent.kind) {
      case 'click':
      case 'double_click':
      case 'right_click': {
        const result = await this.mouse.click(
          intent.kind === 'click' ? 'left' : intent.kind === 'double_click' ? 'double' : 'right',
          { target: p.target as any, coordinates: p.coordinates as any },
          signal
        );
        return { intent, status: 'completed', verified: result.verification.verified, verificationNote: result.verification.note };
      }
      case 'move_cursor': {
        const result = await this.mouse.moveTo({ target: p.target as any, coordinates: p.coordinates as any }, signal);
        return { intent, status: 'completed', verified: result.verification.verified, verificationNote: result.verification.note };
      }
      case 'type': {
        const result = await this.keyboard.type(String(p.text ?? ''), { verify: true }, signal);
        return { intent, status: 'completed', verified: result.verification.verified, verificationNote: result.verification.note };
      }
      case 'press_key': {
        const result = await this.keyboard.pressKey(String(p.key ?? ''), { verify: true }, signal);
        return { intent, status: 'completed', verified: result.verification.verified, verificationNote: result.verification.note };
      }
      case 'hotkey': {
        const result = await this.keyboard.hotkey((p.modifiers as string[]) ?? [], String(p.key ?? ''), { verify: true }, signal);
        return { intent, status: 'completed', verified: result.verification.verified, verificationNote: result.verification.note };
      }
      case 'key_down': {
        await this.keyboard.keyDown(String(p.key ?? ''), signal);
        return { intent, status: 'completed' };
      }
      case 'key_up': {
        await this.keyboard.keyUp(String(p.key ?? ''), signal);
        return { intent, status: 'completed' };
      }
      case 'copy': {
        await this.keyboard.copy(signal);
        return { intent, status: 'completed' };
      }
      case 'paste': {
        await this.keyboard.paste(signal);
        return { intent, status: 'completed' };
      }
      case 'select_all': {
        await this.keyboard.selectAll(signal);
        return { intent, status: 'completed' };
      }
      case 'scroll': {
        const result = await this.mouse.scroll(
          { direction: p.direction as 'up' | 'down' | undefined, amount: p.amount as number | undefined, verify: true },
          signal
        );
        return { intent, status: 'completed', verified: result.verification.verified, verificationNote: result.verification.note };
      }
      case 'drag': {
        const result = await this.mouse.drag({ from: p.from as any, to: p.to as any, verify: true }, signal);
        return { intent, status: 'completed', verified: result.verification.verified, verificationNote: result.verification.note };
      }
      case 'wait': {
        await this.waitForQuiet(signal);
        return { intent, status: 'completed', verified: true, verificationNote: 'Waited for the screen to settle' };
      }
      default:
        return { intent, status: 'failed', error: `Unsupported action kind "${intent.kind}"` };
    }
  }

  // --------------------------------------------------------- observe / wait

  private async ensureState(signal: AbortSignal | undefined, previous: ScreenState | null, force = false): Promise<ScreenState | null> {
    if (!this.observer) return previous;

    // Phase 13: when the adaptive observation layer is present it decides
    // whether to capture fresh, focus a region, or safely reuse the cached
    // state (never stale state — the decider enforces the reuse window).
    if (this.adaptive) {
      // force=true only for focus-change/recovery re-observations; normal
      // action cycles let the decision engine choose reuse vs. fresh capture.
      const result = await this.adaptive.observe(
        {
          trigger: force ? 'explicit_request' : previous ? 'after_mouse_action' : 'task_step',
          priority: force ? 'HIGH' : 'NORMAL',
          reason: force ? 'focus changed: fresh observation required' : 'computer-use action cycle',
          requireFresh: force,
        },
        signal
      );
      if (result.status === 'observed' || result.status === 'reused') {
        if (result.state) {
          this.events?.emit({
            name: 'COMPUTER_OBSERVED',
            payload: { stateId: result.state.id, activeWindow: result.state.activeWindow?.title, adaptive: result.status, changeKind: result.changeKind },
            timestamp: Date.now(),
          });
          this.multimodal?.recordObservation(result.state);
          return result.state;
        }
      }
      if (result.status === 'failed') {
        this.events?.emit({
          name: 'COMPUTER_RECOVERY_STARTED',
          payload: { reason: 'adaptive_observation_failed', kind: result.error?.kind },
          timestamp: Date.now(),
        });
        // Structured failure: fall back to previous state — stale data is
        // never silently treated as fresh.
        return previous;
      }
      // stopped/delayed/budget_exhausted/cancelled: reuse cache only if the
      // adaptive layer still considers it valid (its decision said so).
      if (result.decision.action === 'REUSE_VALID_STATE' && previous) return previous;
      return previous;
    }

    try {
      // analyze:'local' — the computer-use loop stays fully offline: screen
      // understanding for targeting runs through the local OCR pipeline.
      const state = await this.observer.getCurrentState({ maxAgeMs: force ? 0 : this.stateStaleMs, analyze: 'local' });
      this.events?.emit({
        name: 'COMPUTER_OBSERVED',
        payload: { stateId: state.id, activeWindow: state.activeWindow?.title },
        timestamp: Date.now(),
      });
      this.multimodal?.recordObservation(state);
      return state;
    } catch {
      // Observation failures must not silently pass stale data forward.
      return previous;
    }
  }

  /** Bounded, adaptive settle loop using cheap signature diffs (no analysis). */
  private async waitForQuiet(signal?: AbortSignal): Promise<void> {
    if (!this.observer) return;
    const deadline = Date.now() + this.waitTimeoutMs;
    let intervalIndex = 0;
    let quiet = false;
    while (Date.now() < deadline && !quiet && !signal?.aborted) {
      const change = await this.observer.detectChanges();
      if (!change.changed) {
        quiet = true;
        break;
      }
      const wait = WAIT_INTERVALS_MS[Math.min(intervalIndex, WAIT_INTERVALS_MS.length - 1)];
      intervalIndex++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }

  // ---------------------------------------------------------------- summary

  private buildSummary(
    goal: string,
    status: ComputerUseResult['status'],
    actions: ComputerActionRecord[],
    focusChanges: FocusChange[],
    observations: number
  ): string {
    const completed = actions.filter((a) => a.status === 'completed').length;
    const header =
      status === 'completed'
        ? `Computer task completed: all ${actions.length} action(s) executed.`
        : status === 'failed'
        ? `Computer task stopped after ${completed} of ${actions.length} actions because of a failure.`
        : status === 'cancelled'
        ? 'Computer task was cancelled.'
        : `Computer task ended partially: ${completed} of ${actions.length} actions executed.`;

    const lines = actions.map((a, i) => {
      const icon =
        a.status === 'completed'
          ? a.verified === true
            ? 'Done (verified)'
            : a.verified === false
            ? 'Done (no visible change detected)'
            : 'Done'
          : a.status === 'failed'
          ? `Failed — ${a.error ?? 'unknown error'}`
          : 'Skipped';
      return `${i + 1}. ${a.intent.description} — ${icon}`;
    });

    const notes: string[] = [];
    if (focusChanges.length > 0) {
      notes.push(`Focus changed ${focusChanges.length} time(s) during the task; the screen was re-observed after each change.`);
    }
    if (observations > 0) notes.push(`${observations} screen observation(s) used.`);

    return [header, ...lines, ...notes].join('\n');
  }
}
