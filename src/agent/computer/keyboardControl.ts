/**
 * Keyboard Control Service (Phase 6).
 *
 * Mirrors the Phase 5 ComputerControlService:
 *  - client-side validation: unknown keys/modifiers and malformed text never
 *    reach the OS layer (spec §6)
 *  - 'keyboard.control' permission enforced here AND by the registry (spec §7)
 *  - stuck-key protection: explicit key_down holds are tracked and released
 *    automatically on any failure/cancellation — modifiers are never left
 *    logically stuck (spec §13)
 *  - duplicate-typing protection: uncertain text delivery is reported as such
 *    and never blindly retried (spec §15) — the type tool allows 1 attempt
 *  - verification through Phase 4 observation at meaningful checkpoints, with
 *    optional expected-text matching against the analysis (spec §16)
 *  - sensitive input is masked in results/summaries and never logged (spec §24)
 */
import type {
  KeyboardActionResult,
  KeyboardBackend,
} from './keyboardTypes';
import { isKnownKey, isKnownModifier, keyCodeFor, maskSensitiveText } from './keyboardTypes';
import { ControlError } from './mouseTypes';
import type { AgentEventBus } from '../events';
import type { PermissionManager } from '../permissions';
import type { ScreenObserver } from '../vision/screenObserver';

const MAX_TEXT_LENGTH = 2000;
const DEFAULT_STALE_MS = 8000;
const MAX_SETTLE_MS = 1000;

export interface TypeOptions {
  verify?: boolean;
  settleMs?: number;
  /** Text expected to appear on screen after typing (verification aid). */
  expectText?: string;
}

export interface KeyboardControlOptions {
  backend: KeyboardBackend;
  observer?: ScreenObserver;
  events?: AgentEventBus;
  permissions?: PermissionManager;
  maxStaleMs?: number;
}

export class KeyboardControlService {
  private backend: KeyboardBackend;
  private observer?: ScreenObserver;
  private events: AgentEventBus | null;
  private permissions: PermissionManager | null;
  private maxStaleMs: number;
  /** Keys currently held via explicit key_down (stuck-key protection). */
  private heldKeys = new Set<string>();

  constructor(options: KeyboardControlOptions) {
    this.backend = options.backend;
    this.observer = options.observer;
    this.events = options.events ?? null;
    this.permissions = options.permissions ?? null;
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_STALE_MS;
  }

  setObserver(observer: ScreenObserver): void {
    this.observer = observer;
  }

  // ------------------------------------------------------------- permission

  private ensureAllowed(): void {
    if (this.permissions && !this.permissions.isGranted('keyboard.control')) {
      throw new ControlError('permission_denied', 'Keyboard control is disabled: the "keyboard.control" permission is not granted');
    }
  }

  private checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ControlError('cancelled', 'Keyboard action cancelled');
    }
  }

  /** Release every key we believe we are holding (stuck-key recovery, spec §13). */
  async releaseAll(signal?: AbortSignal): Promise<string[]> {
    const released: string[] = [];
    for (const key of Array.from(this.heldKeys)) {
      try {
        await this.backend.keyUp(key);
        released.push(key);
      } catch {
        // best effort — the backend itself may be unreachable
      }
      this.heldKeys.delete(key);
    }
    return released;
  }

  // ------------------------------------------------------------- validation

  private validateKey(key: string): string {
    const clean = key?.trim().toLowerCase();
    // Modifiers are valid keys for key_down/key_up (holding Ctrl is the point).
    if (!clean || (!isKnownKey(clean) && !isKnownModifier(clean))) {
      throw new ControlError('invalid_coordinates', `Unknown key "${String(key).slice(0, 20)}"`, false);
    }
    return clean;
  }

  private validateModifiers(modifiers: string[] | undefined): string[] {
    const mods = (modifiers ?? []).map((m) => m?.trim().toLowerCase()).filter(Boolean);
    if (mods.length > 4) {
      throw new ControlError('invalid_coordinates', 'Too many modifiers in combination', false);
    }
    for (const m of mods) {
      if (!isKnownModifier(m)) {
        throw new ControlError('invalid_coordinates', `Unknown modifier "${String(m).slice(0, 20)}"`, false);
      }
    }
    return mods;
  }

  private validateText(text: string): string {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ControlError('invalid_coordinates', 'Text to type must be a non-empty string', false);
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new ControlError('invalid_coordinates', `Text exceeds the ${MAX_TEXT_LENGTH}-character limit`, false);
    }
    // Strip control characters except tab and line breaks.
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  // ---------------------------------------------------------------- verify

  private async verifyByScreenChange(
    signal: AbortSignal | undefined,
    settleMs: number | undefined,
    expectText?: string
  ): Promise<KeyboardActionResult['verification']> {
    if (!this.observer) {
      return { strategy: 'self_reported', verified: false, note: 'No screen observer available; action reported without visual verification' };
    }
    if (expectText) {
      // Expected-text matching needs a full provider analysis (signature-only
      // baselines carry no text), so take a fresh observation.
      // analyze:'local' — keyboard verification must never upload a screenshot.
      this.checkCancelled(signal);
      const state = await this.observer.getCurrentState({ maxAgeMs: 0, analyze: 'local' });
      const haystack =
        JSON.stringify(state.analysis.texts ?? []) +
        JSON.stringify((state.analysis.elements ?? []).map((e) => e.text ?? ''));
      const found = haystack.toLowerCase().includes(expectText.toLowerCase());
      return {
        strategy: 'expect_text',
        verified: found,
        note: found
          ? 'Expected text appeared on screen after the action'
          : 'Expected text was not found in the screen analysis (the active provider may not read text)',
      };
    }
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
      note: change.changed
        ? `Screen changed after the action (~${Math.round(change.changedFraction * 100)}% of blocks)`
        : 'No visible screen change detected after the action',
    };
  }

  // ---------------------------------------------------------------- actions

  async type(text: string, options: TypeOptions = {}, signal?: AbortSignal): Promise<KeyboardActionResult> {
    this.ensureAllowed();
    const clean = this.validateText(text);
    const { masked, sensitive } = maskSensitiveText(clean);
    this.events?.emit({ name: 'KEYBOARD_ACTION_STARTED', payload: { action: 'type', characters: clean.length, sensitive }, timestamp: Date.now() });

    let verification: KeyboardActionResult['verification'] = { strategy: 'self_reported', verified: false, note: 'Verification disabled' };
    let sent = 0;
    let deliveryUncertain = false;
    try {
      this.checkCancelled(signal);
      const wantsVerify = options.verify !== false && Boolean(this.observer);
      if (wantsVerify && !this.observer!.peekCurrentState()) {
        await this.observer!.detectChanges();
      }
      this.checkCancelled(signal);
      try {
        const result = await this.backend.typeText(clean);
        sent = result.sent;
      } catch (err) {
        if (err instanceof ControlError && err.kind === 'timeout') {
          // Delivery uncertainty — text may have been applied. NEVER retry here.
          deliveryUncertain = true;
        }
        throw err;
      }
      this.events?.emit({ name: 'KEYBOARD_ACTION_COMPLETED', payload: { action: 'type', characters: sent }, timestamp: Date.now() });
      if (wantsVerify && !deliveryUncertain) {
        verification = await this.verifyByScreenChange(signal, options.settleMs, options.expectText);
        this.events?.emit({
          name: verification.verified ? 'KEYBOARD_ACTION_VERIFIED' : 'KEYBOARD_ACTION_FAILED',
          payload: { action: 'type', verified: verification.verified },
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      await this.releaseAll(signal).catch(() => undefined);
      this.emitActionOutcome('type', err);
      if (deliveryUncertain) {
        // Honest partial success report — the core must not blind-retry (maxAttempts 1).
        return {
          action: 'type',
          typedCharacters: 0,
          deliveryUncertain: true,
          textPreview: masked,
          verification: { strategy: 'self_reported', verified: false, note: 'Delivery uncertain: the result was lost after dispatch; the text may already be inserted' },
          summary: `Typed ${clean.length} characters but delivery is uncertain (the result was lost after dispatch). The text may already be inserted — verify before typing again.`,
        };
      }
      throw err;
    }

    const activeWindow = this.observer?.peekCurrentState()?.activeWindow;
    return {
      action: 'type',
      typedCharacters: sent,
      deliveryUncertain: false,
      textPreview: masked,
      verification,
      activeWindow: activeWindow
        ? { title: activeWindow.title, surface: activeWindow.surface, available: activeWindow.available }
        : undefined,
      summary:
        `Typed ${sent} characters (${masked}). ` +
        (verification.verified ? verification.note ?? '' : verification.note ?? ''),
    };
  }

  async pressKey(key: string, options: { verify?: boolean; settleMs?: number } = {}, signal?: AbortSignal): Promise<KeyboardActionResult> {
    this.ensureAllowed();
    const clean = this.validateKey(key);
    this.checkCancelled(signal);
    return this.runKeyAction('press_key', 'press_key', [clean], () => this.backend.pressKey(clean), options, signal);
  }

  async hotkey(
    modifiers: string[],
    key: string,
    options: { verify?: boolean; settleMs?: number } = {},
    signal?: AbortSignal,
    actionLabel: 'hotkey' | 'copy' | 'paste' | 'select_all' = 'hotkey'
  ): Promise<KeyboardActionResult> {
    this.ensureAllowed();
    const mods = this.validateModifiers(modifiers);
    const clean = this.validateKey(key);
    if (mods.length === 0) {
      // No modifiers → it is a plain key press.
      return this.pressKey(key, options, signal);
    }
    this.checkCancelled(signal);
    return this.runKeyAction(
      actionLabel,
      'hotkey',
      [...mods, clean],
      async () => {
        await this.backend.hotkey(mods, clean);
        // Server releases modifiers within the same script; nothing to track.
      },
      options,
      signal
    );
  }

  async keyDown(key: string, signal?: AbortSignal): Promise<KeyboardActionResult> {
    this.ensureAllowed();
    const clean = this.validateKey(key);
    this.checkCancelled(signal);
    this.events?.emit({ name: 'KEYBOARD_ACTION_STARTED', payload: { action: 'key_down', key: clean }, timestamp: Date.now() });
    try {
      await withKeyboardTimeout(this.backend.keyDown(clean), signal);
      this.heldKeys.add(clean);
      this.events?.emit({ name: 'KEYBOARD_ACTION_COMPLETED', payload: { action: 'key_down', key: clean }, timestamp: Date.now() });
      return {
        action: 'key_down',
        keys: [clean],
        verification: { strategy: 'self_reported', verified: true, note: `Key "${clean}" is now held down` },
        summary: `Key "${clean}" held down. ${this.heldKeys.size} key(s) currently held — release with computer.key_up or on cancellation.`,
      };
    } catch (err) {
      await this.releaseAll(signal).catch(() => undefined);
      this.emitActionOutcome('key_down', err);
      throw err;
    }
  }

  async keyUp(key: string, signal?: AbortSignal): Promise<KeyboardActionResult> {
    this.ensureAllowed();
    const clean = this.validateKey(key);
    this.checkCancelled(signal);
    this.events?.emit({ name: 'KEYBOARD_ACTION_STARTED', payload: { action: 'key_up', key: clean }, timestamp: Date.now() });
    try {
      await withKeyboardTimeout(this.backend.keyUp(clean), signal);
      this.heldKeys.delete(clean);
      this.events?.emit({ name: 'KEYBOARD_ACTION_COMPLETED', payload: { action: 'key_up', key: clean }, timestamp: Date.now() });
      return {
        action: 'key_up',
        keys: [clean],
        verification: { strategy: 'self_reported', verified: true, note: `Key "${clean}" released` },
        summary: `Key "${clean}" released.`,
      };
    } catch (err) {
      await this.releaseAll(signal).catch(() => undefined);
      this.emitActionOutcome('key_up', err);
      throw err;
    }
  }

  async copy(signal?: AbortSignal): Promise<KeyboardActionResult> {
    return this.hotkey(['ctrl'], 'c', { verify: false }, signal, 'copy');
  }

  async paste(signal?: AbortSignal): Promise<KeyboardActionResult> {
    return this.hotkey(['ctrl'], 'v', { verify: false }, signal, 'paste');
  }

  async selectAll(signal?: AbortSignal): Promise<KeyboardActionResult> {
    return this.hotkey(['ctrl'], 'a', { verify: false }, signal, 'select_all');
  }

  /** Currently held keys (diagnostics, never sensitive). */
  getHeldKeys(): string[] {
    return Array.from(this.heldKeys);
  }

  // --------------------------------------------------------------- internals

  private async runKeyAction(
    action: KeyboardActionResult['action'],
    eventAction: string,
    keys: string[],
    execute: () => Promise<void>,
    options: { verify?: boolean; settleMs?: number },
    signal?: AbortSignal
  ): Promise<KeyboardActionResult> {
    this.events?.emit({ name: 'KEYBOARD_ACTION_STARTED', payload: { action: eventAction, keys }, timestamp: Date.now() });
    let verification: KeyboardActionResult['verification'] = { strategy: 'self_reported', verified: false, note: 'Verification disabled' };
    try {
      const wantsVerify = options.verify !== false && Boolean(this.observer);
      if (wantsVerify && !this.observer!.peekCurrentState()) {
        await this.observer!.detectChanges();
      }
      this.checkCancelled(signal);
      await withKeyboardTimeout(execute(), signal);
      this.events?.emit({ name: 'KEYBOARD_ACTION_COMPLETED', payload: { action: eventAction, keys }, timestamp: Date.now() });
      if (wantsVerify) {
        verification = await this.verifyByScreenChange(signal, options.settleMs);
        this.events?.emit({
          name: verification.verified ? 'KEYBOARD_ACTION_VERIFIED' : 'KEYBOARD_ACTION_FAILED',
          payload: { action: eventAction, verified: verification.verified },
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      // Stuck-key recovery: release anything we believe is held.
      await this.releaseAll(signal).catch(() => undefined);
      this.emitActionOutcome(eventAction, err);
      throw err;
    }

    const keyDescription = keys.join('+');
    const activeWindow = this.observer?.peekCurrentState()?.activeWindow;
    const verb =
      action === 'copy' ? 'Copy shortcut (Ctrl+C) dispatched'
      : action === 'paste' ? 'Paste shortcut (Ctrl+V) dispatched'
      : action === 'select_all' ? 'Select-all shortcut (Ctrl+A) dispatched'
      : action === 'hotkey' ? `Pressed hotkey ${keyDescription}`
      : action === 'press_key' ? `Pressed ${keyDescription}`
      : `Key action ${keyDescription}`;
    return {
      action,
      keys,
      verification,
      activeWindow: activeWindow
        ? { title: activeWindow.title, surface: activeWindow.surface, available: activeWindow.available }
        : undefined,
      summary:
        `${verb}. ` +
        (verification.verified ? verification.note ?? '' : verification.note ?? ''),
    };
  }

  private emitActionOutcome(action: string, err: unknown): void {
    if (err instanceof ControlError && err.kind === 'cancelled') {
      this.events?.emit({ name: 'KEYBOARD_ACTION_CANCELLED', payload: { action }, timestamp: Date.now() });
    } else {
      this.events?.emit({
        name: 'KEYBOARD_ACTION_FAILED',
        payload: { action, error: String((err as any)?.message || err) },
        timestamp: Date.now(),
      });
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withKeyboardTimeout<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ControlError('timeout', 'Keyboard action timed out', true)), 30_000);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ControlError('cancelled', 'Keyboard action cancelled'));
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
