/**
 * Real Windows keyboard backend (Phase 6).
 *
 * POSTs validated actions to /api/computer/keyboard; the local server executes
 * them through the persistent PowerShell worker using user32 SendInput:
 *  - text   → KEYEVENTF_UNICODE events (reliable for Unicode, no clipboard side effects)
 *  - keys   → virtual-key down/up pairs
 *  - hotkeys→ modifier downs, key, modifier ups in reverse
 *
 * Import-safe under Node; never used by tests (FakeKeyboardBackend instead).
 */
import type { KeyboardBackend } from './keyboardTypes';
import { ControlError } from './mouseTypes';

const REQUEST_TIMEOUT_MS = 25_000; // generous: cold PowerShell startup takes seconds

/** Base URL of the local server ('' = same origin, browser default). */
let BACKEND_BASE_URL = '';

/** Allow non-browser hosts (e.g. the Node real-machine check) to target the server directly. */
export function setKeyboardBackendBaseUrl(url: string): void {
  BACKEND_BASE_URL = url.replace(/\/$/, '');
}

async function callServer(payload: Record<string, unknown>): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${BACKEND_BASE_URL}/api/computer/keyboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new ControlError('timeout', 'Keyboard backend request timed out', true);
    }
    throw new ControlError('backend_unavailable', `Keyboard backend unreachable: ${String(err?.message || err)}`, false);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new ControlError('backend_failed', `Keyboard backend returned HTTP ${response.status}`, response.status >= 500);
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ControlError('backend_failed', 'Keyboard backend returned malformed JSON', true);
  }
  if (!data.success) {
    const kind = (data.errorKind as string) ?? 'backend_failed';
    // 'invalid_key' means the server rejected a key name — treat as invalid input.
    const controlKind: 'invalid_coordinates' | 'backend_failed' | 'timeout' =
      kind === 'invalid_key' ? 'invalid_coordinates' : kind === 'timeout' ? 'timeout' : 'backend_failed';
    throw new ControlError(controlKind, data.error || 'Keyboard action failed', controlKind !== 'invalid_coordinates');
  }
  return data;
}

export class PowerShellKeyboardBackend implements KeyboardBackend {
  async typeText(text: string): Promise<{ sent: number }> {
    const data = await callServer({ action: 'type', text });
    return { sent: typeof data.sent === 'number' ? data.sent : text.length };
  }

  async pressKey(key: string): Promise<void> {
    await callServer({ action: 'key', key });
  }

  async hotkey(modifiers: string[], key: string): Promise<void> {
    await callServer({ action: 'hotkey', modifiers, key });
  }

  async keyDown(key: string): Promise<void> {
    await callServer({ action: 'key_down', key });
  }

  async keyUp(key: string): Promise<void> {
    await callServer({ action: 'key_up', key });
  }
}
