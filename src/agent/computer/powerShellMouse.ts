/**
 * Real Windows mouse backend (Phase 5).
 *
 * The browser page cannot move the OS cursor; Krisha's local Express server
 * can. This backend POSTs validated actions to /api/computer/mouse, where the
 * server executes them through PowerShell with user32 P/Invoke (SetCursorPos +
 * mouse_event) — zero npm dependencies, built into Windows, and portable to
 * swap for another backend later (robotJS, nut.js, a native module, ...).
 *
 * Import-safe under Node (fetch is only called at runtime), never used by
 * tests — those use FakeMouseBackend.
 */
import type { ClickKind, ControlErrorKind, MouseBackend, Point, ScreenBounds } from './mouseTypes';
import { ControlError } from './mouseTypes';

const REQUEST_TIMEOUT_MS = 25_000; // generous: cold PowerShell startup can take seconds

/** Base URL of the local server ('' = same origin, browser default). */
let BACKEND_BASE_URL = '';

/** Allow non-browser hosts (e.g. the Node real-machine check) to target the server directly. */
export function setMouseBackendBaseUrl(url: string): void {
  BACKEND_BASE_URL = url.replace(/\/$/, '');
}

interface MouseApiResponse {
  success: boolean;
  position?: Point;
  bounds?: ScreenBounds;
  error?: string;
  errorKind?: string;
}

async function callServer(payload: Record<string, unknown>): Promise<MouseApiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${BACKEND_BASE_URL}/api/computer/mouse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new ControlError('timeout', 'Mouse backend request timed out', true);
    }
    throw new ControlError('backend_unavailable', `Mouse backend unreachable: ${String(err?.message || err)}`, false);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new ControlError('backend_failed', `Mouse backend returned HTTP ${response.status}`, response.status >= 500);
  }
  let data: MouseApiResponse;
  try {
    data = await response.json();
  } catch {
    throw new ControlError('backend_failed', 'Mouse backend returned malformed JSON', true);
  }
  if (!data.success) {
    const kind = (data.errorKind as ControlErrorKind | undefined) ?? 'backend_failed';
    throw new ControlError(kind, data.error || 'Mouse action failed', kind === 'backend_failed' || kind === 'timeout');
  }
  return data;
}

export class PowerShellMouseBackend implements MouseBackend {
  async getPosition(): Promise<Point> {
    const data = await callServer({ action: 'position' });
    if (!data.position) throw new ControlError('backend_failed', 'Backend returned no cursor position', true);
    return data.position;
  }

  async getScreenBounds(): Promise<ScreenBounds> {
    const data = await callServer({ action: 'screen_bounds' });
    if (!data.bounds) throw new ControlError('backend_failed', 'Backend returned no screen bounds', true);
    return data.bounds;
  }

  async move(x: number, y: number): Promise<Point> {
    const data = await callServer({ action: 'move', x, y });
    if (!data.position) throw new ControlError('backend_failed', 'Backend returned no final cursor position', true);
    return data.position;
  }

  async click(x: number, y: number, kind: ClickKind): Promise<void> {
    await callServer({ action: kind === 'left' ? 'click' : kind === 'double' ? 'double_click' : 'right_click', x, y });
  }

  async scroll(x: number, y: number, deltaY: number): Promise<void> {
    await callServer({ action: 'scroll', x, y, deltaY });
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<Point> {
    const data = await callServer({ action: 'drag', fromX, fromY, toX, toY });
    if (!data.position) throw new ControlError('backend_failed', 'Backend returned no final cursor position', true);
    return data.position;
  }
}
