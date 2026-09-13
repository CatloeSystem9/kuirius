/**
 * HTTP browser backend (Phase 8) — talks to the local server's CDP endpoints.
 * Injectable base URL so Node-based verification can target the server
 * directly (browser default is same-origin).
 */
import type { BrowserBackend } from './browserTypes';

const REQUEST_TIMEOUT_MS = 45_000; // navigation may wait for page load

let BASE_URL = '';

export function setBrowserBackendBaseUrl(url: string): void {
  BASE_URL = url.replace(/\/$/, '');
}

async function post(action: string, payload: Record<string, unknown> = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/browser/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return { success: false, error: `Browser backend returned HTTP ${res.status}` };
    return await res.json();
  } catch (err: any) {
    if (controller.signal.aborted) return { success: false, error: 'Browser backend request timed out' };
    return { success: false, error: `Browser backend unreachable: ${String(err?.message || err)}` };
  } finally {
    clearTimeout(timer);
  }
}

export class HttpBrowserBackend implements BrowserBackend {
  async getState() {
    return post('state');
  }
  async navigate(url: string) {
    return post('navigate', { url });
  }
  async goBack() {
    return post('back');
  }
  async goForward() {
    return post('forward');
  }
  async refresh() {
    return post('refresh');
  }
  async clickText(text: string, kind?: 'link' | 'button' | 'any') {
    return post('click', { text, kind });
  }
  async typeIntoField(match: string, text: string) {
    return post('type', { match, text });
  }
  async scrollBy(deltaY: number) {
    return post('scroll', { deltaY });
  }
  async listTabs() {
    return post('tabs');
  }
}
