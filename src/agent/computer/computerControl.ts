/**
 * Computer Control Service (Phase 5) — the dedicated mouse/cursor layer.
 *
 * Flow per meaningful action:
 *   OBSERVE → IDENTIFY TARGET → VALIDATE → MOVE → CLICK → OBSERVE AGAIN →
 *   COMPARE STATE → VERIFY
 *
 * - Semantic targeting first (Phase 4 element/text bounds), raw coordinates
 *   only as a last resort (spec §5).
 * - Stale-observation protection: targets from old observations are
 *   re-identified on a fresh capture (spec §16).
 * - Verification through Phase 4 change detection after meaningful actions
 *   (clicks, drags, scrolls) — never "executed = succeeded" (spec §13).
 * - Cancellation checkpoints before the OS action and before verification
 *   (spec §21). No polling, no per-movement captures (spec §24).
 */
import type {
  ClickKind,
  DragInput,
  MouseActionResult,
  MouseBackend,
  Point,
  ScreenBounds,
  ScrollInput,
  SemanticTarget,
  TargetInput,
} from './mouseTypes';
import { ControlError } from './mouseTypes';
import type { AgentEventBus } from '../events';
import type { PermissionManager } from '../permissions';
import type { Bounds, ScreenState } from '../vision/visionTypes';
import { ObserverError } from '../vision/visionTypes';
import type { ScreenObserver } from '../vision/screenObserver';

const TARGET_MIN_CONFIDENCE = 0.6;
const DEFAULT_STALE_MS = 8000;
const MAX_SETTLE_MS = 1000;
const BOUNDS_CACHE_TTL_MS = 60_000;

export interface ComputerControlOptions {
  backend: MouseBackend;
  observer?: ScreenObserver;
  events?: AgentEventBus;
  permissions?: PermissionManager;
  maxStaleMs?: number;
}

export class ComputerControlService {
  private backend: MouseBackend;
  private observer?: ScreenObserver;
  private events: AgentEventBus | null;
  private permissions: PermissionManager | null;
  private maxStaleMs: number;
  private boundsCache: { bounds: ScreenBounds; at: number } | null = null;

  constructor(options: ComputerControlOptions) {
    this.backend = options.backend;
    this.observer = options.observer;
    this.events = options.events ?? null;
    this.permissions = options.permissions ?? null;
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_STALE_MS;
  }

  setObserver(observer: ScreenObserver): void {
    this.observer = observer;
  }

  // -------------------------------------------------------------- permission

  private ensureAllowed(): void {
    if (this.permissions && !this.permissions.isGranted('mouse.control')) {
      throw new ControlError('permission_denied', 'Mouse control is disabled: the "mouse.control" permission is not granted');
    }
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ControlError('cancelled', 'Mouse action cancelled');
    }
  }

  /** Unified failure/cancellation event emission for every action path. */
  private emitActionOutcome(action: string, err: unknown): void {
    if (err instanceof ControlError && err.kind === 'cancelled') {
      this.events?.emit({ name: 'MOUSE_ACTION_CANCELLED', payload: { action }, timestamp: Date.now() });
    } else {
      this.events?.emit({
        name: 'MOUSE_ACTION_FAILED',
        payload: { action, error: String((err as any)?.message || err) },
        timestamp: Date.now(),
      });
    }
  }

  // ----------------------------------------------------------- screen bounds

  private async getScreenBounds(): Promise<ScreenBounds> {
    if (this.boundsCache && Date.now() - this.boundsCache.at < BOUNDS_CACHE_TTL_MS) {
      return this.boundsCache.bounds;
    }
    const bounds = await this.backend.getScreenBounds();
    if (!isFiniteNumber(bounds.width) || !isFiniteNumber(bounds.height) || bounds.width <= 0 || bounds.height <= 0) {
      throw new ControlError('backend_failed', 'Backend reported invalid screen bounds', true);
    }
    this.boundsCache = { bounds, at: Date.now() };
    return bounds;
  }

  // --------------------------------------------------------------- targeting

  /** Find a semantic target in a state's elements/texts. */
  private findTargetInState(state: ScreenState, query: SemanticTarget): SemanticTarget | null {
    const text = query.text?.trim().toLowerCase();
    const type = query.type?.trim().toLowerCase();
    // Token-based matching so "save button" finds an element labeled "Save".
    const queryWords = text ? text.split(/\s+/).filter((w) => w.length > 1) : [];

    const matchesText = (candidate: string): boolean => {
      const c = candidate.toLowerCase();
      if (!text) return true;
      if (!c) return false;
      if (c.includes(text)) return true;
      return queryWords.some((w) => c.includes(w));
    };

    let best: SemanticTarget | null = null;
    let bestScore = 0;

    for (const element of state.analysis.elements) {
      if (element.type === 'text_line') continue; // lines are context, not controls
      const typeMatch = !type || element.type === type;
      const textMatch = matchesText(element.text ?? '');
      if (!typeMatch || !textMatch || !element.bounds) continue;
      if (text && !element.text) continue;
      const score = (element.confidence ?? 0.5) + (textMatch && text ? 0.2 : 0) + (typeMatch && type ? 0.1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { text: element.text, type: element.type, bounds: element.bounds, confidence: element.confidence };
      }
    }
    if (best) return best;

    for (const detected of state.analysis.texts) {
      if (!matchesText(detected.text ?? '')) continue;
      if (detected.bounds) {
        const score = (detected.confidence ?? 0.5) + 0.1;
        if (score > bestScore) {
          bestScore = score;
          best = { text: detected.text, type: 'unknown', bounds: detected.bounds, confidence: detected.confidence };
        }
      }
    }
    return best;
  }

  /** Resolve the input to concrete screen coordinates (spec §4–6, §16). */
  private async resolveTargetPoint(
    input: { target?: SemanticTarget; coordinates?: Point; stateId?: string },
    signal?: AbortSignal
  ): Promise<{ intended: Point; target?: MouseActionResult['target'] }> {
    this.checkCancelled(signal);
    const screenBounds = await this.getScreenBounds();

    // A request must name a target (or coordinates) — never click blind.
    const hasTarget =
      input.coordinates ||
      input.target?.bounds ||
      (input.target && (input.target.text || input.target.type));
    if (!hasTarget) {
      throw new ControlError('invalid_coordinates', 'Mouse action requires a semantic target or explicit coordinates');
    }

    // 1. Raw coordinates — last resort, validated against screen bounds.
    if (input.coordinates) {
      const { x, y } = input.coordinates;
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
        throw new ControlError('invalid_coordinates', 'Coordinates must be finite numbers');
      }
      const point = { x: Math.round(x), y: Math.round(y) };
      this.validateInScreen(point, screenBounds);
      return { intended: point, target: { source: 'coordinates' } };
    }

    // 2. Explicitly provided bounds (e.g. re-clicking a known element).
    if (input.target?.bounds) {
      const target = input.target;
      const confidence = target.confidence ?? 0.7;
      if (confidence < TARGET_MIN_CONFIDENCE) {
        throw new ControlError('target_unreliable', `Target confidence ${confidence.toFixed(2)} is below the ${TARGET_MIN_CONFIDENCE} threshold`, false);
      }
      const point = this.clickPointFromBounds(target.bounds, screenBounds);
      return {
        intended: point,
        target: { source: 'semantic_element', text: target.text, type: target.type, confidence, bounds: target.bounds },
      };
    }

    // 3. Semantic target by text/type — resolved through screen vision.
    if (!this.observer) {
      throw new ControlError('target_not_found', 'No screen observer available to resolve a semantic target', true);
    }

    const existing = this.observer.peekCurrentState();
    const referencedState = input.stateId ? this.observer.listStates().find((s) => s.id === input.stateId) : undefined;
    const stateIsStale =
      !existing ||
      (input.stateId ? !referencedState || referencedState.id !== existing.id : false) ||
      Date.now() - existing.timestamp > this.maxStaleMs;

    let searchState: ScreenState | null = existing;
    let reidentified = false;
    if (stateIsStale) {
      // Stale-screen protection: capture a fresh observation before clicking.
      // analyze:'local' — computer use must never send a screenshot online.
      try {
        searchState = await this.observer.getCurrentState({ maxAgeMs: 0, analyze: 'local' });
        reidentified = true;
      } catch (err) {
        throw mapObserverError(err);
      }
    }
    if (!searchState) {
      throw new ControlError('target_not_found', 'No screen observation available', true);
    }

    let found = this.findTargetInState(searchState, input.target ?? {});
    if (!found && !stateIsStale) {
      // One fresh attempt before giving up.
      try {
        searchState = await this.observer.getCurrentState({ maxAgeMs: 0, analyze: 'local' });
        reidentified = true;
        found = this.findTargetInState(searchState, input.target ?? {});
      } catch (err) {
        throw mapObserverError(err);
      }
    }
    if (!found) {
      throw new ControlError('target_not_found', `No visible target matched "${input.target?.text ?? input.target?.type ?? 'the request'}" on the current screen`, true);
    }
    if ((found.confidence ?? 0) < TARGET_MIN_CONFIDENCE && found.confidence !== undefined) {
      throw new ControlError('target_unreliable', `Target "${found.text ?? found.type}" confidence ${(found.confidence ?? 0).toFixed(2)} is below ${TARGET_MIN_CONFIDENCE} — not clicking`, false);
    }

    const point = this.clickPointFromBounds(found.bounds!, screenBounds);
    return {
      intended: point,
      target: {
        source: found.type === 'unknown' ? 'semantic_text' : 'semantic_element',
        text: found.text,
        type: found.type,
        confidence: found.confidence,
        bounds: found.bounds,
        capturedAt: searchState.timestamp,
        reidentified,
      },
    };
  }

  /** Safe click point: center of the usable area, mapped to screen pixels. */
  private clickPointFromBounds(bounds: Bounds, screenBounds: ScreenBounds): Point {
    const { x, y, width, height } = bounds;
    if (![x, y, width, height].every((v) => isFiniteNumber(v)) || width <= 0 || height <= 0) {
      throw new ControlError('invalid_coordinates', 'Target bounds are malformed');
    }
    if (x < -0.01 || y < -0.01 || x + width > 1.01 || y + height > 1.01) {
      throw new ControlError('invalid_coordinates', 'Target bounds fall outside the captured screen');
    }
    // Center with a 10% inset so edge click targets stay inside the control.
    const nx = x + width * 0.5;
    const ny = y + height * 0.5;
    const point = {
      x: Math.round(screenBounds.x + nx * screenBounds.width),
      y: Math.round(screenBounds.y + ny * screenBounds.height),
    };
    this.validateInScreen(point, screenBounds);
    return point;
  }

  private validateInScreen(point: Point, screenBounds: ScreenBounds): void {
    if (
      point.x < screenBounds.x ||
      point.y < screenBounds.y ||
      point.x > screenBounds.x + screenBounds.width ||
      point.y > screenBounds.y + screenBounds.height
    ) {
      throw new ControlError('invalid_coordinates', `Point (${point.x}, ${point.y}) is outside the screen bounds (${screenBounds.width}x${screenBounds.height})`);
    }
  }

  // ------------------------------------------------------------ verification

  private async verifyByScreenChange(signal: AbortSignal | undefined, settleMs: number | undefined): Promise<VerificationEvidenceLike> {
    if (!this.observer) {
      return { strategy: 'self_reported', verified: false, note: 'No screen observer available; action reported without visual verification' };
    }
    // Baseline: a signature to compare against (cheap capture, no analysis).
    if (!this.observer.peekCurrentState()) {
      await this.observer.detectChanges();
    }
    this.checkCancelled(signal);
    await delay(Math.min(Math.max(settleMs ?? 300, 0), MAX_SETTLE_MS));
    this.checkCancelled(signal);
    const change = await this.observer.detectChanges();
    return {
      strategy: 'screen_state_change',
      verified: change.changed,
      changedFraction: change.changedFraction,
      regions: change.regions.length,
      note: change.changed
        ? `Screen changed after the action (~${Math.round(change.changedFraction * 100)}% of blocks)`
        : 'No visible screen change detected after the action; it may have had no visible effect',
    };
  }

  // --------------------------------------------------------------- actions

  async getCursorPosition(signal?: AbortSignal): Promise<{ position: Point; screenBounds: ScreenBounds }> {
    this.ensureAllowed();
    this.checkCancelled(signal);
    const [position, screenBounds] = await Promise.all([this.backend.getPosition(), this.getScreenBounds()]);
    return { position, screenBounds };
  }

  async moveTo(input: TargetInput, signal?: AbortSignal): Promise<MouseActionResult> {
    this.ensureAllowed();
    let resolved: { intended: Point; target?: MouseActionResult['target'] };
    try {
      resolved = await this.resolveTargetPoint(input, signal);
      this.checkCancelled(signal);
      this.events?.emit({ name: 'CURSOR_MOVE_STARTED', payload: { to: resolved.intended }, timestamp: Date.now() });
    } catch (err) {
      this.emitActionOutcome('move', err);
      throw err;
    }
    const { intended, target } = resolved;
    let final: Point;
    try {
      final = await withControlTimeout(this.backend.move(intended.x, intended.y), signal);
    } catch (err) {
      this.emitActionOutcome('move', err);
      throw err;
    }
    this.events?.emit({ name: 'CURSOR_MOVE_COMPLETED', payload: { to: final }, timestamp: Date.now() });

    const screenBounds = await this.getScreenBounds();
    const reached = Math.abs(final.x - intended.x) <= 2 && Math.abs(final.y - intended.y) <= 2;
    const verification: VerificationEvidenceLike = {
      strategy: 'self_reported',
      verified: reached,
      note: reached
        ? `Cursor confirmed at (${final.x}, ${final.y})`
        : `Cursor reported at (${final.x}, ${final.y}) instead of the intended (${intended.x}, ${intended.y})`,
    };
    return this.buildResult('move', intended, final, target, screenBounds, verification);
  }

  async click(kind: ClickKind, input: TargetInput, signal?: AbortSignal): Promise<MouseActionResult> {
    this.ensureAllowed();
    const actionName = kind === 'left' ? 'click' : kind === 'double' ? 'double_click' : 'right_click';
    let resolved: { intended: Point; target?: MouseActionResult['target'] };
    try {
      resolved = await this.resolveTargetPoint(input, signal);
    } catch (err) {
      this.emitActionOutcome(actionName, err);
      throw err;
    }
    const { intended, target } = resolved;
    this.checkCancelled(signal);
    this.events?.emit({ name: 'MOUSE_CLICK_STARTED', payload: { kind, at: intended }, timestamp: Date.now() });

    // Baseline before the action when verification will be requested.
    const wantVerify = input.verify !== false && Boolean(this.observer);
    let verification: VerificationEvidenceLike = { strategy: 'self_reported', verified: false, note: 'Verification disabled' };
    try {
      if (wantVerify && !this.observer!.peekCurrentState()) {
        await this.observer!.detectChanges();
      }
      this.checkCancelled(signal);
      await withControlTimeout(this.backend.click(intended.x, intended.y, kind), signal);
      this.events?.emit({ name: 'MOUSE_CLICK_COMPLETED', payload: { kind, at: intended }, timestamp: Date.now() });
      if (wantVerify) {
        verification = await this.verifyByScreenChange(signal, input.settleMs);
        this.events?.emit({
          name: verification.verified ? 'MOUSE_ACTION_VERIFIED' : 'MOUSE_ACTION_FAILED',
          payload: { action: actionName, verified: verification.verified, note: verification.note },
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.emitActionOutcome(actionName, err);
      throw err;
    }

    const final = await this.backend.getPosition();
    const screenBounds = await this.getScreenBounds();
    return this.buildResult(actionName, intended, final, target, screenBounds, verification);
  }

  async scroll(input: ScrollInput, signal?: AbortSignal): Promise<MouseActionResult> {
    this.ensureAllowed();
    let deltaY: number;
    if (isFiniteNumber(input.deltaY)) {
      deltaY = Math.round(input.deltaY);
    } else {
      const amount = isFiniteNumber(input.amount) ? Math.min(Math.max(Math.round(input.amount), 1), 20) : 3;
      deltaY = input.direction === 'up' ? 120 * amount : -(120 * amount);
    }
    if (deltaY === 0) {
      throw new ControlError('invalid_coordinates', 'Scroll delta must be non-zero');
    }

    const pointInput = { coordinates: input.coordinates, target: undefined, stateId: input.stateId };
    let at: { intended: Point; target?: MouseActionResult['target'] };
    try {
      at = input.coordinates
        ? await this.resolveTargetPoint(pointInput, signal)
        : await this.resolveTargetPoint({ ...pointInput, coordinates: await this.centerPoint() }, signal);
    } catch (err) {
      this.emitActionOutcome('scroll', err);
      throw err;
    }
    this.checkCancelled(signal);
    this.events?.emit({ name: 'MOUSE_CLICK_STARTED', payload: { kind: 'scroll', at: at.intended, deltaY }, timestamp: Date.now() });

    const wantVerify = input.verify !== false && Boolean(this.observer);
    let verification: VerificationEvidenceLike = { strategy: 'self_reported', verified: false, note: 'Verification disabled' };
    try {
      if (wantVerify && !this.observer!.peekCurrentState()) {
        await this.observer!.detectChanges();
      }
      this.checkCancelled(signal);
      await withControlTimeout(this.backend.scroll(at.intended.x, at.intended.y, deltaY), signal);
      this.events?.emit({ name: 'MOUSE_CLICK_COMPLETED', payload: { kind: 'scroll', deltaY }, timestamp: Date.now() });
      if (wantVerify) {
        verification = await this.verifyByScreenChange(signal, input.settleMs);
        this.events?.emit({
          name: verification.verified ? 'MOUSE_ACTION_VERIFIED' : 'MOUSE_ACTION_FAILED',
          payload: { action: 'scroll', verified: verification.verified },
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.emitActionOutcome('scroll', err);
      throw err;
    }

    const final = await this.backend.getPosition();
    const screenBounds = await this.getScreenBounds();
    return this.buildResult('scroll', at.intended, final, at.target, screenBounds, {
      ...verification,
      note: `${verification.note ?? ''} (scroll delta ${deltaY})`.trim(),
    });
  }

  async drag(input: DragInput, signal?: AbortSignal): Promise<MouseActionResult> {
    this.ensureAllowed();
    let fromResolved: { intended: Point; target?: MouseActionResult['target'] };
    let toResolved: { intended: Point; target?: MouseActionResult['target'] };
    try {
      fromResolved = await this.resolvePointLike(input.from, 'from', signal);
      this.checkCancelled(signal);
      toResolved = await this.resolvePointLike(input.to, 'to', signal);
    } catch (err) {
      this.emitActionOutcome('drag', err);
      throw err;
    }
    this.checkCancelled(signal);
    this.events?.emit({ name: 'MOUSE_CLICK_STARTED', payload: { kind: 'drag', at: fromResolved.intended }, timestamp: Date.now() });

    const wantVerify = input.verify !== false && Boolean(this.observer);
    let verification: VerificationEvidenceLike = { strategy: 'self_reported', verified: false, note: 'Verification disabled' };
    try {
      if (wantVerify && !this.observer!.peekCurrentState()) {
        await this.observer!.detectChanges();
      }
      this.checkCancelled(signal);
      const final = await withControlTimeout(this.backend.drag(fromResolved.intended.x, fromResolved.intended.y, toResolved.intended.x, toResolved.intended.y), signal);
      this.events?.emit({ name: 'MOUSE_CLICK_COMPLETED', payload: { kind: 'drag', at: final }, timestamp: Date.now() });
      if (wantVerify) {
        verification = await this.verifyByScreenChange(signal, input.settleMs);
        this.events?.emit({
          name: verification.verified ? 'MOUSE_ACTION_VERIFIED' : 'MOUSE_ACTION_FAILED',
          payload: { action: 'drag', verified: verification.verified },
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.emitActionOutcome('drag', err);
      throw err;
    }

    const final = await this.backend.getPosition();
    const screenBounds = await this.getScreenBounds();
    return this.buildResult('drag', fromResolved.intended, final, fromResolved.target, screenBounds, {
      ...verification,
      note: `${verification.note ?? ''} (drag to ${toResolved.intended.x}, ${toResolved.intended.y})`.trim(),
    });
  }

  private async resolvePointLike(pointLike: SemanticTarget | Point | undefined, label: string, signal?: AbortSignal) {
    if (!pointLike) {
      throw new ControlError('invalid_coordinates', `Drag requires a "${label}" target`);
    }
    if (isFiniteNumber((pointLike as Point).x) && isFiniteNumber((pointLike as Point).y)) {
      return this.resolveTargetPoint({ coordinates: pointLike as Point }, signal);
    }
    return this.resolveTargetPoint({ target: pointLike as SemanticTarget }, signal);
  }

  private async centerPoint(): Promise<Point> {
    const bounds = await this.getScreenBounds();
    return {
      x: bounds.x + Math.round(bounds.width / 2),
      y: bounds.y + Math.round(bounds.height / 2),
    };
  }

  private buildResult(
    action: MouseActionResult['action'],
    intended: Point,
    final: Point,
    target: MouseActionResult['target'],
    screenBounds: ScreenBounds,
    verification: VerificationEvidenceLike
  ): MouseActionResult {
    const activeWindow = this.observer?.peekCurrentState()?.activeWindow;
    const targetDescription = target?.text ?? target?.type ?? `(${intended.x}, ${intended.y})`;
    const summary =
      `${action === 'double_click' ? 'Double-clicked' : action === 'right_click' ? 'Right-clicked' : action === 'move' ? 'Moved the cursor to' : action === 'scroll' ? 'Scrolled at' : action === 'drag' ? 'Dragged from' : 'Clicked'} ` +
      `${targetDescription} at (${intended.x}, ${intended.y}). ` +
      (verification.verified ? verification.note ?? 'Verified.' : verification.note ?? '');
    return {
      action,
      intended,
      final,
      target,
      screenBounds,
      verification,
      activeWindow: activeWindow
        ? { title: activeWindow.title, surface: activeWindow.surface, available: activeWindow.available }
        : undefined,
      summary,
    };
  }
}

// ------------------------------------------------------------------ helpers

interface VerificationEvidenceLike {
  strategy: 'screen_state_change' | 'self_reported';
  verified: boolean;
  changedFraction?: number;
  regions?: number;
  note?: string;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withControlTimeout<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ControlError('timeout', 'Mouse action timed out', true)), 9000);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ControlError('cancelled', 'Mouse action cancelled'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

export function mapObserverError(err: unknown): ControlError {
  if (err instanceof ControlError) return err;
  if (err instanceof ObserverError) {
    switch (err.kind) {
      case 'permission_denied':
        return new ControlError('permission_denied', err.message, false);
      case 'timeout':
        return new ControlError('timeout', err.message, true);
      case 'provider_unavailable':
        return new ControlError('target_not_found', `Screen analysis unavailable while targeting: ${err.message}`, true);
      default:
        return new ControlError('target_not_found', `Screen observation failed while targeting: ${err.message}`, true);
    }
  }
  return new ControlError('backend_failed', String((err as any)?.message || err), true);
}

export type { VerificationEvidenceLike };
