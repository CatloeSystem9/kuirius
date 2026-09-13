/**
 * Deterministic fake keyboard backend for automated tests (Phase 6).
 * Records typed text, key presses, and held-key state; can simulate
 * transient failures, hangs, and uncertain delivery. No OS interaction.
 */
import type { KeyboardBackend } from './keyboardTypes';
import { ControlError } from './mouseTypes';

export class FakeKeyboardBackend implements KeyboardBackend {
  /** Concatenated buffer of everything "typed" (test assertions only). */
  typedText = '';
  keyLog: { action: 'press' | 'down' | 'up' | 'hotkey'; key: string; timestamp: number }[] = [];
  held = new Set<string>();
  /** Remaining transient failures before calls succeed again. */
  transientFailures = 0;
  /** When > 0, the next call hangs for this many ms then rejects with timeout. */
  hangMs = 0;
  /** When true, the next type() applies the text and THEN throws (uncertain delivery). */
  uncertainDelivery = false;
  /** When true, type() drops characters after position `dropAfter` (partial delivery). */
  dropAfter?: number;

  async typeText(text: string): Promise<{ sent: number }> {
    await this.guard();
    if (this.uncertainDelivery) {
      this.uncertainDelivery = false;
      this.typedText += text; // text WAS applied, then the result was lost
      throw new ControlError('timeout', 'Type result lost after dispatch (delivery uncertain)', true);
    }
    const delivered = this.dropAfter !== undefined ? text.slice(0, this.dropAfter) : text;
    this.typedText += delivered;
    return { sent: delivered.length };
  }

  async pressKey(key: string): Promise<void> {
    await this.guard();
    this.keyLog.push({ action: 'press', key, timestamp: Date.now() });
  }

  async hotkey(modifiers: string[], key: string): Promise<void> {
    await this.guard();
    this.keyLog.push({ action: 'hotkey', key: [...modifiers, key].join('+'), timestamp: Date.now() });
  }

  async keyDown(key: string): Promise<void> {
    await this.guard();
    this.held.add(key.toLowerCase());
    this.keyLog.push({ action: 'down', key, timestamp: Date.now() });
  }

  async keyUp(key: string): Promise<void> {
    await this.guard();
    this.held.delete(key.toLowerCase());
    this.keyLog.push({ action: 'up', key, timestamp: Date.now() });
  }

  private async guard(): Promise<void> {
    if (this.hangMs > 0) {
      const wait = this.hangMs;
      this.hangMs = 0;
      await new Promise((_, reject) => setTimeout(() => reject(new ControlError('timeout', 'Fake keyboard hang', true)), wait));
    }
    if (this.transientFailures > 0) {
      this.transientFailures--;
      throw new ControlError('backend_failed', 'Transient keyboard backend failure', true);
    }
  }
}
