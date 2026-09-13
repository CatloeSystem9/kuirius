/**
 * Keyboard control types (Phase 6).
 *
 * Mirrors the Phase 5 mouse layer: a pluggable KeyboardBackend (PowerShell/
 * SendInput on Windows via the local server, fake for tests), client-side
 * validation so invalid keys never reach the OS layer, and structured results.
 * Text is typed with KEYEVENTF_UNICODE (no per-char key simulation, no
 * clipboard mutation); copy/paste/select-all are real Ctrl-combo hotkeys.
 */
import { ControlError } from './mouseTypes';
import type { Point } from './mouseTypes';

export type { ControlError, Point };

/** Canonical key names accepted by the keyboard layer (validated client-side). */
export const VALID_KEYS: Record<string, number> = {
  enter: 13, return: 13, escape: 27, esc: 27, tab: 9, backspace: 8, delete: 46, del: 46,
  insert: 45, space: 32, left: 37, up: 38, right: 39, down: 40,
  home: 36, end: 35, pageup: 33, pagedown: 34,
  minus: 189, equal: 187, comma: 188, period: 190, slash: 191, backquote: 192,
  bracketleft: 219, backslash: 220, bracketright: 221, semicolon: 186, quote: 222,
};

export const VALID_MODIFIERS: Record<string, number> = {
  ctrl: 17, control: 17, alt: 18, shift: 16, win: 91, cmd: 91, meta: 91,
};

// Letters (a-z → 65..90), digits (0-9 → 48..57), f1-f12 (112..123).
for (let i = 0; i < 26; i++) VALID_KEYS[String.fromCharCode(97 + i)] = 65 + i;
for (let i = 0; i < 10; i++) VALID_KEYS[String.fromCharCode(48 + i)] = 48 + i;
for (let i = 1; i <= 12; i++) VALID_KEYS[`f${i}`] = 111 + i;

/** True when the name is a known key or modifier. */
export function isKnownKey(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(VALID_KEYS, name.toLowerCase());
}

export function isKnownModifier(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(VALID_MODIFIERS, name.toLowerCase());
}

export function keyCodeFor(name: string): number | undefined {
  return VALID_KEYS[name.toLowerCase()];
}

export function modifierCodeFor(name: string): number | undefined {
  return VALID_MODIFIERS[name.toLowerCase()];
}

/** Backend interface — one OS-level keyboard primitive per method. */
export interface KeyboardBackend {
  typeText(text: string): Promise<{ sent: number }>;
  pressKey(key: string): Promise<void>;
  hotkey(modifiers: string[], key: string): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
}

export interface KeyboardActionResult {
  action: 'type' | 'press_key' | 'hotkey' | 'key_down' | 'key_up' | 'copy' | 'paste' | 'select_all';
  /** Keys involved (never the typed text itself — privacy). */
  keys?: string[];
  typedCharacters?: number;
  /** True when text may or may not have been delivered (never auto-retried). */
  deliveryUncertain?: boolean;
  /** Masked text preview — sensitive content is fully masked. */
  textPreview?: string;
  verification: {
    strategy: 'screen_state_change' | 'expect_text' | 'self_reported';
    verified: boolean;
    changedFraction?: number;
    note?: string;
  };
  activeWindow?: { title?: string; surface?: string; available: boolean };
  summary: string;
}

/** Patterns that mark text as sensitive — masked in every result/summary. */
export const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /\b(?:password|passwd|api[-_]?key|secret|token|credential|otp|2fa|auth[-_]?code)\b/i,
  /\bsk-[a-z0-9]{12,}/i,
  /\bghp_[A-Za-z0-9]{20,}/i,
  /\bAKIA[0-9A-Z]{12,}\b/,
];

export function maskSensitiveText(text: string): { masked: string; sensitive: boolean } {
  if (SENSITIVE_TEXT_PATTERNS.some((re) => re.test(text))) {
    return { masked: '[sensitive input masked]', sensitive: true };
  }
  const preview = text.length > 24 ? text.slice(0, 21) + '...' : text;
  return { masked: preview.replace(/\r?\n/g, '⏎'), sensitive: false };
}
