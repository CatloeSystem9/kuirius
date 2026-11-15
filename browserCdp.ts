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
// Live event waiters (registered BEFORE the triggering command so the event
// cannot be missed); matched against incoming CDP events in onmessage.
interface CdpEventWaiter {
  sessionId?: string;
  method: string;
  resolve: (msg: any | null) => void;
  timer: NodeJS.Timeout;
}
const eventWaiters = new Set<CdpEventWaiter>();

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
    // Health-check the cached socket: a browser killed externally (or one
    // still dying from browserStop) can leave a nominally-open WebSocket
    // whose every command would hang until timeout. A cheap probe either
    // confirms the socket or discards it so the relaunch below runs.
    try {
      await cdpSend('Browser.getVersion', {}, undefined, 3_000);
      return 'connected';
    } catch {
      try { browserWs?.close(); } catch { /* ignore */ }
      browserWs = null;
    }
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
        // Live event waiters match FIRST (they registered before the
        // triggering command); a matched waiter consumes the event.
        for (const w of [...eventWaiters]) {
          if (w.method === msg.method && (w.sessionId === undefined || msg.sessionId === w.sessionId)) {
            eventWaiters.delete(w);
            clearTimeout(w.timer);
            w.resolve(msg);
          }
        }
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

/** Wait for ONE CDP event on (optionally) a specific session. Registers the
 *  waiter synchronously — callers MUST register before issuing the command
 *  that triggers the event. Resolves null on timeout. */
function waitForCdpEvent(method: string, sessionId: string | undefined, timeoutMs: number): Promise<any | null> {
  return new Promise((resolve) => {
    const waiter: CdpEventWaiter = {
      sessionId,
      method,
      resolve,
      timer: setTimeout(() => {
        eventWaiters.delete(waiter);
        resolve(null);
      }, timeoutMs),
    };
    eventWaiters.add(waiter);
  });
}

export async function browserNavigate(url: string): Promise<{ url: string; title: string }> {
  await ensureBrowser();
  const targets = await cdpSend('Target.getTargets');
  const page = (targets.targetInfos || []).find((t: any) => t.type === 'page');
  if (!page) throw new Error('No open page');
  const { sessionId } = await cdpSend('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  // CDP race repair: register the load-event waiter BEFORE navigating, then
  // wait for the event of the NEW document. The previous implementation
  // polled {readyState, url} immediately — the OLD document satisfies
  // readyState === 'complete' with its OLD url, so navigation() returned
  // while the transition was still in flight. Fills that followed then
  // probed a mid-navigation page, producing the nondeterministic
  // origin_mismatch / page_not_ready refusals.
  let preNavigateUrl = '';
  try {
    const pre = await cdpSend('Runtime.evaluate', {
      expression: 'JSON.stringify({ url: location.href })',
      returnByValue: true,
    }, sessionId);
    preNavigateUrl = String(JSON.parse(String(pre.result?.value || '{}')).url ?? '');
  } catch { /* no readable document yet — treated as changed */ }
  await cdpSend('Page.enable', {}, sessionId);
  const loaded = await (async () => {
    const waiter = waitForCdpEvent('Page.loadEventFired', sessionId, 30_000);
    await cdpSend('Page.navigate', { url }, sessionId, 30_000);
    return waiter;
  })();
  if (!loaded) throw new Error('Navigation timed out (no load event)');
  // The load event fired for the new document; confirm readiness and report
  // the FINAL url (redirects may land elsewhere than the request).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const ready = await cdpSend('Runtime.evaluate', {
        expression: 'JSON.stringify({ready: document.readyState, url: location.href, title: document.title})',
        returnByValue: true,
      }, sessionId);
      const v = JSON.parse(ready.result?.value || '{}');
      if (v.ready === 'complete') {
        // Failed-navigation detection: the load event may fire for an ERROR
        // page (e.g. a dead destination port) while the document stays the
        // PRE-NAVIGATION one. Callers must never mistake that for success.
        if (String(v.url ?? '') === preNavigateUrl && preNavigateUrl !== '' && preNavigateUrl !== url) {
          throw new Error(`navigation failed — the destination did not load (still on ${preNavigateUrl.slice(0, 80)})`);
        }
        return { url: v.url, title: v.title };
      }
    } catch (err) {
      if (String((err as Error)?.message || '').startsWith('navigation failed')) throw err;
      /* transitioning between documents — retry */
    }
    await new Promise((r) => setTimeout(r, 200));
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
  if (browserProc) {
    try { browserProc.kill(); } catch { /* ignore */ }
    browserProc = null;
    // CDP race repair: kill() is asynchronous — a following ensureBrowser()
    // could see the port still listening (or a WS still half-open to the
    // dying process) and race the shutdown, producing nondeterministic
    // "no open page" refusals. Bounded wait until the debug port is free.
    for (let i = 0; i < 20; i++) {
      let up = false;
      try {
        up = await isAlive();
      } catch {
        up = false;
      }
      if (!up) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Test/maintenance hook: additionally kills a STALE Krisha-controlled
 *  browser left on the debug port by a crashed previous process (matched by
 *  the listener PID of OUR debug port only — never a blanket process kill).
 *  Guarantees a fresh browser and fresh tabs for repeatable suite runs. */
export async function browserHardReset(): Promise<void> {
  await browserStop();
  let alive = true;
  try {
    alive = await isAlive();
  } catch {
    alive = false;
  }
  if (!alive) return;
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);
    // Find the PID listening on OUR debug port (CDP_PORT) and kill exactly that PID.
    const { stdout } = await run('netstat', ['-ano', '-p', 'TCP']);
    const line = stdout
      .split(/\r?\n/)
      .find((l) => l.includes(`:${CDP_PORT}`) && /LISTENING/i.test(l));
    const pid = line?.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid)) {
      await run('taskkill', ['/F', '/PID', pid]);
    }
  } catch { /* best effort — isAlive re-checks below */ }
  // Bounded wait until the port is actually free.
  for (let i = 0; i < 20; i++) {
    let up = false;
    try {
      up = await isAlive();
    } catch {
      up = false;
    }
    if (!up) return;
    await new Promise((r) => setTimeout(r, 250));
  }
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

// ---------------------------------------------------------------------------
// LPV — pinned, origin-verified fill (security audit repair D1).
//
// The generic browserEvaluate/browserPageState pair resolves "the first page
// target" on EVERY call, so two separate evaluations can land on two
// different tabs when several are open. A credential fill must never allow
// that gap: the origin decision and the typing must happen on ONE pinned
// page. browserFillFields probes each open page target's origin (bounded),
// picks the first page whose origin equals the approved origin, attaches to
// THAT target, and runs the fill expression there. The fill expression
// itself re-verifies location.origin (see lpvCore.buildFillExpression), so
// the decision and the typing are atomic within one Runtime.evaluate on one
// page. If no open page matches the approved origin, nothing is typed and a
// typed error is thrown.
// ---------------------------------------------------------------------------

const FILL_PROBE_LIMIT = 10;

function fillError(kind: string, message: string): Error {
  const err = new Error(message);
  (err as { kind?: string }).kind = kind;
  return err;
}

export async function browserFillFields(
  expectedOrigin: string,
  fillScript: string
): Promise<{ results: Array<{ secret: string; filled: boolean; matched?: string; reason?: string }>; finalUrl: string }> {
  await ensureBrowser();
  const targets = await cdpSend('Target.getTargets');
  const pages = (targets.targetInfos || []).filter((t: any) => t.type === 'page').slice(0, FILL_PROBE_LIMIT);
  if (pages.length === 0) {
    throw fillError('page_not_ready', 'no open page in the Krisha-controlled browser');
  }
  for (const page of pages) {
    try {
      const attached = await cdpSend('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      const sessionId: string = attached.sessionId;
      const probe = await cdpSend('Runtime.evaluate', {
        expression: 'JSON.stringify({ origin: location.origin, ready: document.readyState })',
        returnByValue: true,
      }, sessionId);
      if (process.env.KRISHA_LPV_DEBUG_FILL === '1') {
        console.error(`[fill-debug] probe target=${page.targetId} raw=${JSON.stringify(probe.result?.value)}`);
      }
      if (probe.result?.value) {
        const parsed = JSON.parse(String(probe.result.value));
        // Origin gate: only the page whose LIVE origin equals the approved
        // origin is ever considered. Everything else is skipped, untouched.
        if (String(parsed.origin ?? '') !== expectedOrigin) continue;
        if (parsed.ready !== 'complete') {
          throw fillError('page_not_ready', 'the matching page has not finished loading');
        }
        // Pinned session: the fill expression runs on THIS page only. The
        // expression re-verifies location.origin atomically with the typing.
        const result = await cdpSend('Runtime.evaluate', {
          expression: fillScript,
          returnByValue: true,
          awaitPromise: true,
        }, sessionId);
        if (result.exceptionDetails) {
          throw fillError('page_not_ready', result.exceptionDetails.exception?.description?.slice(0, 120) || 'page evaluation failed');
        }
        return JSON.parse(String(result.result?.value));
      }
    } catch (err) {
      if ((err as { kind?: string })?.kind) throw err; // typed errors propagate
      void err; // unattachable page — try the next candidate
    }
  }
  throw fillError('origin_mismatch', `no open page matches the approved destination (${expectedOrigin})`);
}

/** Open an additional tab in the Krisha-controlled browser (used by the
 *  multi-tab fill test; also a realistic multi-tab capability).
 *  CDP race repair: createTarget returns BEFORE the new tab loads — fills
 *  racing that load produced nondeterministic origin_mismatch refusals.
 *  Waits until the tab reports complete readyState with a STABLE url
 *  (two agreeing consecutive probes), strictly bounded. */
export async function browserCreateTab(url: string): Promise<{ targetId: string }> {
  await ensureBrowser();
  const safe = assertSafeUrlForTab(url);
  const created = await cdpSend('Target.createTarget', { url: safe });
  const targetId = String(created.targetId);
  const { sessionId } = await cdpSend('Target.attachToTarget', { targetId, flatten: true });
  const deadline = Date.now() + 30_000;
  let stableUrl = '';
  while (Date.now() < deadline) {
    try {
      const probe = await cdpSend('Runtime.evaluate', {
        expression: 'JSON.stringify({ready: document.readyState, url: location.href})',
        returnByValue: true,
      }, sessionId);
      const v = JSON.parse(probe.result?.value || '{}');
      if (v.ready === 'complete') {
        if (v.url === stableUrl) return { targetId };
        stableUrl = String(v.url ?? ''); // first complete sighting — require one agreeing repeat
      }
    } catch { /* transitioning between documents — retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('created tab did not reach a stable loaded state');
}

function assertSafeUrlForTab(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw fillError('invalid_input', 'malformed tab URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fillError('invalid_input', 'only http/https tab URLs are allowed');
  }
  return parsed.toString();
}
