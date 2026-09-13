/**
 * Browser CDP layer (Phase 8, server-side).
 *
 * Controls a Krisha-launched Chrome/Edge instance over the Chrome DevTools
 * Protocol using Node's built-in WebSocket — zero npm dependencies, no
 * heavyweight automation frameworks. The browser runs with a dedicated
 * throwaway profile so the user's own browser/profile is never touched.
 *
 * The layer never injects raw JS from the network: the endpoint layer exposes
 * typed actions (navigate / click-by-text / type-into-field / read-state) and
 * this module builds the expressions internally.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const CDP_PORT = 9223;
const CDP_HTTP_TIMEOUT_MS = 5000;

let browserProc: ReturnType<typeof spawn> | null = null;
let browserWs: WebSocket | null = null;
let wsMessageId = 0;
const pendingWs = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const EVENT_BUFFER: any[] = [];

function candidateExecutables(): string[] {
  const candidates = [
    process.env.KRISHA_BROWSER_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.filter((p): p is string => Boolean(p) && fs.existsSync(p!));
}

async function httpJson(url: string, method = 'GET'): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDP_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function isAlive(): Promise<boolean> {
  try {
    await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return true;
  } catch {
    return false;
  }
}

/** Launch a Krisha-controlled headless browser (once) and return its WS URL. */
async function ensureBrowser(): Promise<string> {
  if (browserWs && browserWs.readyState === WebSocket.OPEN) {
    return 'connected';
  }

  if (!(await isAlive())) {
    const exe = candidateExecutables()[0];
    if (!exe) {
      throw new Error('No Chrome or Edge installation found for browser automation');
    }
    const profileDir = path.join(os.tmpdir(), 'krisha-browser-profile');
    fs.mkdirSync(profileDir, { recursive: true });
    browserProc = spawn(exe, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    browserProc.on('exit', () => {
      browserProc = null;
      try { browserWs?.close(); } catch { /* ignore */ }
      browserWs = null;
    });
    // Wait for the debug endpoint.
    let up = false;
    for (let i = 0; i < 30; i++) {
      if (await isAlive()) { up = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!up) throw new Error('Browser debug endpoint did not come up');
  }

  const version = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const wsUrl: string = version.webSocketDebuggerUrl;
  browserWs = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser WebSocket connect timed out')), 5000);
    browserWs!.onopen = () => { clearTimeout(timer); resolve(); };
    browserWs!.onerror = () => { clearTimeout(timer); reject(new Error('Browser WebSocket failed')); };
  });
  browserWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(String(event.data));
      if (msg.id && pendingWs.has(msg.id)) {
        const p = pendingWs.get(msg.id)!;
        pendingWs.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
      } else if (msg.method) {
        EVENT_BUFFER.push(msg);
        if (EVENT_BUFFER.length > 100) EVENT_BUFFER.shift();
      }
    } catch { /* ignore malformed */ }
  };
  browserWs.onclose = () => { browserWs = null; };
  return 'connected';
}

/** Send a flat-protocol CDP command (optionally to an attached session). */
function cdpSend(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
      reject(new Error('Browser not connected'));
      return;
    }
    const id = ++wsMessageId;
    const timer = setTimeout(() => {
      pendingWs.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, timeoutMs);
    pendingWs.set(id, { resolve, reject, timer });
    browserWs.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

/** Evaluate an expression in the active page and return the JSON value. */
export async function browserEvaluate<T = any>(expression: string): Promise<T> {
  await ensureBrowser();
  const targets = await cdpSend('Target.getTargets');
  const page = (targets.targetInfos || []).find((t: any) => t.type === 'page');
  if (!page) throw new Error('No open page');
  const { sessionId } = await cdpSend('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const result = await cdpSend('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'Page evaluation failed');
  }
  return result.result?.value as T;
}

export async function browserNavigate(url: string): Promise<{ url: string; title: string }> {
  await ensureBrowser();
  const targets = await cdpSend('Target.getTargets');
  const page = (targets.targetInfos || []).find((t: any) => t.type === 'page');
  if (!page) throw new Error('No open page');
  const { sessionId } = await cdpSend('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await cdpSend('Page.navigate', { url }, sessionId, 30_000);
  // Bounded wait for the load event.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const ready = await cdpSend('Runtime.evaluate', {
        expression: 'JSON.stringify({ready: document.readyState, url: location.href, title: document.title})',
        returnByValue: true,
      }, sessionId);
      const v = JSON.parse(ready.result?.value || '{}');
      if (v.ready === 'complete') return { url: v.url, title: v.title };
    } catch { /* page navigating — retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Navigation timed out');
}

export async function browserListTabs(): Promise<{ id: string; title: string; url: string }[]> {
  await ensureBrowser();
  const targets = await cdpSend('Target.getTargets');
  return (targets.targetInfos || [])
    .filter((t: any) => t.type === 'page')
    .map((t: any) => ({ id: t.targetId, title: t.title, url: t.url }));
}

export async function browserStop(): Promise<void> {
  try { browserWs?.close(); } catch { /* ignore */ }
  browserWs = null;
  try { browserProc?.kill(); } catch { /* ignore */ }
  browserProc = null;
}

/** Script that extracts a bounded, structured page-state snapshot. */
const PAGE_STATE_SCRIPT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const trim = (s) => (s || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 25).map(a => ({ text: trim(a.innerText), href: a.href }));
  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit], input[type=button]')].filter(visible).slice(0, 25).map(b => ({ text: trim(b.innerText || b.value || b.getAttribute('aria-label')) }));
  const fields = [...document.querySelectorAll('input, textarea, select')].filter(visible).slice(0, 25).map(f => ({ tag: f.tagName.toLowerCase(), type: f.type || '', placeholder: trim(f.placeholder), name: f.name || '', id: f.id || '' }));
  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(visible).slice(0, 10).map(h => trim(h.innerText));
  return JSON.stringify({
    url: location.href,
    title: document.title,
    ready: document.readyState,
    links, buttons, fields, headings,
  });
})()`;

export async function browserPageState(): Promise<any> {
  const raw = await browserEvaluate<string>(PAGE_STATE_SCRIPT);
  return JSON.parse(raw);
}
