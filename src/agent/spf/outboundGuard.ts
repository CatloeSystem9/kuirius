/**
 * SPF system-wide outbound transport guard (task §5).
 *
 * The LAST line of defense: patches the outbound transports of the Node
 * process (globalThis.fetch and node:http / node:https request) so that ANY
 * external request — regardless of which HTTP client, integration or service
 * issues it — is screened before leaving the machine. A request whose URL,
 * headers or body carries never-transmit sensitive content (OTP, password,
 * credentials, keys, full payment data) is destroyed and audited; it never
 * reaches its destination.
 *
 * Endpoint-level SPF gates (vision/chat/research/...) run FIRST and redact or
 * block with rich reasons; this guard scans whatever survives them and catches
 * anything that skipped a gate. Loopback destinations are screened uniformly —
 * that is exactly how the test suite verifies real outbound payloads against a
 * controlled local receiver (task §9).
 *
 * This module is Node-only (imports node:http / node:https) and must only be
 * imported by the server entrypoint and tests — never by browser code.
 */
import { createRequire } from 'node:module';
import type { ScreenPrivacyFirewall } from './firewall';
import type { SpfContext } from './spfTypes';

// The CJS module objects (mutable) — ESM namespace objects are frozen and
// cannot be patched. createRequire works under tsx and the esbuild CJS bundle.
const require_ = createRequire(import.meta.url);
type HttpModule = typeof import('node:http');
type HttpsModule = typeof import('node:https');
const nodeHttp = require_('node:http') as HttpModule;
const nodeHttps = require_('node:https') as HttpsModule;

export class SpfBlockedError extends Error {
  constructor(public readonly spfReason: string, public readonly auditId?: string) {
    // NOTE: the message deliberately carries NO payload content — errors can
    // surface in logs and UI, so they must be content-free.
    super(`Screen Privacy Firewall blocked outbound transmission (${spfReason})`);
    this.name = 'SpfBlockedError';
  }
}

export interface OutboundGuardOptions {
  /** Destinations treated as trusted internals (never blocked, still scanned for stats). */
  trustedHosts?: string[];
  /** Cap on how much of a body is buffered for scanning (default 256 KB). */
  scanBodyLimit?: number;
}

const DEFAULT_BODY_LIMIT = 256 * 1024;

interface GuardState {
  fetchWrapped: boolean;
  httpWrapped: boolean;
  httpsWrapped: boolean;
  blocked: number;
  inspected: number;
  /** Bodies rewritten at the transport level (REDACT applied on the wire). */
  rewritten: number;
}

const state: GuardState = { fetchWrapped: false, httpWrapped: false, httpsWrapped: false, blocked: 0, inspected: 0, rewritten: 0 };

function isTrustedHost(hostname: string, trustedHosts: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return trustedHosts.some((t) => host === t.toLowerCase() || host.endsWith(`.${t.toLowerCase()}`));
}

function extractHostname(url: URL): string {
  return url.hostname;
}

/**
 * Headers whose values are the app's OWN operational credentials (configured
 * keys/tokens the application legitimately presents to its services). SPF's
 * boundary is screen-derived CONTENT, not the app's own keys — screening
 * these would block every model call. Their names are still scanned as part
 * of URLs/bodies when they appear there.
 */
const OPERATIONAL_AUTH_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-goog-api-key',
  'x-api-key',
  'x-auth-token',
  'x-goog-fieldmask',
  'cookie',
  'set-cookie',
]);

/** Scan non-operational headers (custom x- headers can carry exfiltrated data). */
function headerValuesToScan(headers: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers || {})) {
    const k = key.toLowerCase();
    if (OPERATIONAL_AUTH_HEADERS.has(k)) continue;
    if (k.startsWith('x-')) {
      if (typeof value === 'string') values.push(`${key}: ${value}`);
      else if (Array.isArray(value)) values.push(...value.filter((v): v is string => typeof v === 'string').map((v) => `${key}: ${v}`));
    }
  }
  return values;
}

/**
 * Bulk-base64 bodies (screenshots, audio) are bulk binary in transit — they
 * are gated by their own endpoint paths (EP-1 vision gate), and scanning
 * megabytes of base64 would waste cycles and invite random-pattern noise.
 * A body that is >85% base64-alphabet characters and >64KB is treated as
 * bulk and skipped by the transport guard.
 */
function isBulkBase64Body(body: string): boolean {
  if (body.length < 64 * 1024) return false;
  let base64ish = 0;
  const sample = body.length > 1_000_000 ? body.slice(0, 1_000_000) : body;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61) base64ish++;
  }
  return base64ish / sample.length > 0.85;
}

function serializeBody(body: unknown, limit: number): string | null {
  try {
    if (body === undefined || body === null) return null;
    if (typeof body === 'string') return body.slice(0, limit);
    if (body instanceof URLSearchParams) return body.toString().slice(0, limit);
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body as ArrayBufferView)) return null; // binary — gated upstream
    if (typeof body === 'object') return JSON.stringify(body).slice(0, limit);
    return null;
  } catch {
    return null;
  }
}

/**
 * Core screening for one outbound request. Throws SpfBlockedError when the
 * request must not leave the machine. Returns a rewritten body when the
 * firewall's REDACT decision can be applied at the transport level — the
 * ORIGINAL payload is never sent (task §4: "Never send the original payload
 * as a fallback when redaction fails").
 */
function screenOutbound(
  firewall: ScreenPrivacyFirewall,
  method: string,
  url: URL,
  headers: Record<string, unknown>,
  rawBody: unknown,
  trustedHosts: string[],
  bodyLimit: number
): { rewrittenBody?: unknown } {
  const destination = `${url.protocol}//${url.host}`;
  const ctx: SpfContext = { destination, payloadKind: 'url', transport: 'http-url' };

  // URL scan (catches data-in-URL exfiltration, including URI-encoded).
  // URLs cannot be safely rewritten → any finding blocks.
  const urlVerdict = firewall.inspectUrl(url.toString(), ctx);
  if (urlVerdict.decision !== 'allow') {
    state.blocked++;
    throw new SpfBlockedError(urlVerdict.reason, urlVerdict.auditId);
  }

  const isTrusted = isTrustedHost(extractHostname(url), trustedHosts);
  if (isTrusted) return {}; // trusted internals: URL scanned, headers/body skipped

  // Header scan — headers cannot be meaningfully rewritten → redact blocks.
  const headerCtx: SpfContext = { destination, payloadKind: 'text', transport: 'http-body' };
  for (const headerText of headerValuesToScan(headers)) {
    const verdict = firewall.inspectText(headerText, headerCtx);
    if (verdict.decision !== 'allow') {
      state.blocked++;
      throw new SpfBlockedError(`outbound_header:${verdict.reason}`, verdict.auditId);
    }
  }

  // Body screening. String/JSON bodies are REWRITTEN with the redacted copy
  // (validated); other body kinds cannot be rewritten safely → redact blocks.
  const bodyText = serializeBody(rawBody, bodyLimit);
  if (!bodyText || isBulkBase64Body(bodyText)) return {};
  const bodyCtx: SpfContext = { destination, payloadKind: 'text', transport: 'http-body' };
  const verdict = firewall.inspectText(bodyText.slice(0, bodyLimit), bodyCtx);
  if (verdict.decision === 'allow') return {};
  if (verdict.decision === 'block') {
    state.blocked++;
    throw new SpfBlockedError(`outbound_body:${verdict.reason}`, verdict.auditId);
  }
  // REDACT at the transport level.
  const redacted = verdict.redactedText;
  if (!redacted) {
    state.blocked++;
    throw new SpfBlockedError('outbound_body:redaction_failed', verdict.auditId);
  }
  if (typeof rawBody === 'string') {
    // Preserve JSON validity: if the original parsed, the redacted copy must too.
    const wasJson = isParsableJson(rawBody);
    if (wasJson && !isParsableJson(redacted)) {
      state.blocked++;
      throw new SpfBlockedError('outbound_body:redaction_breaks_payload', verdict.auditId);
    }
    state.rewritten++;
    return { rewrittenBody: redacted };
  }
  if (rawBody && typeof rawBody === 'object' && !(rawBody instanceof URLSearchParams) && !Buffer.isBuffer(rawBody)) {
    try {
      const parsed = JSON.parse(redacted);
      state.rewritten++;
      return { rewrittenBody: parsed };
    } catch {
      state.blocked++;
      throw new SpfBlockedError('outbound_body:redaction_breaks_payload', verdict.auditId);
    }
  }
  // URLSearchParams / Buffer bodies: cannot rewrite → fail closed.
  state.blocked++;
  throw new SpfBlockedError('outbound_body:redaction_not_applicable_to_body_kind', verdict.auditId);
}

function isParsableJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** Patch globalThis.fetch. Returns the uninstall function. */
function patchFetch(firewall: ScreenPrivacyFirewall, options: Required<OutboundGuardOptions>): () => void {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    try {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = (init?.method ?? (typeof input === 'object' && input !== null && 'method' in input ? String((input as Request).method) : 'GET') ?? 'GET').toUpperCase();
      const headers = Object.assign(
        {},
        typeof input === 'object' && input !== null && !(input instanceof URL) && 'headers' in input
          ? Object.fromEntries(new Headers((input as Request).headers).entries())
          : {},
        init?.headers ? Object.fromEntries(new Headers(init.headers as HeadersInit).entries()) : {}
      ) as Record<string, unknown>;
      let rewrittenInit = init;
      if (init?.body !== undefined && method !== 'GET' && method !== 'HEAD') {
        const result = screenOutbound(firewall, method, url, headers, init.body, options.trustedHosts, options.scanBodyLimit);
        if (result.rewrittenBody !== undefined) {
          // Transport-level REDACT: the sanitized copy is what leaves.
          rewrittenInit = { ...init, body: result.rewrittenBody };
        }
      } else {
        screenOutbound(firewall, method, url, headers, undefined, options.trustedHosts, options.scanBodyLimit);
      }
      state.inspected++;
      return await originalFetch(input as Parameters<typeof originalFetch>[0], rewrittenInit);
    } catch (err) {
      if (err instanceof SpfBlockedError) throw err;
      // URL parse failure etc. → let the original fetch handle/reject it.
      return originalFetch(input as Parameters<typeof originalFetch>[0], init);
    }
  };
  globalThis.fetch = wrapped;
  state.fetchWrapped = true;
  return () => {
    globalThis.fetch = originalFetch;
    state.fetchWrapped = false;
  };
}

/**
 * Patch the SHARED ClientRequest prototype — every node:http and node:https
 * request (any import style: ESM namespace, require(), internal) funnels
 * through the one `_http_client.ClientRequest` class, so prototype patching
 * covers all creation paths. ESM namespace objects are frozen, so patching
 * `http.request` module properties alone cannot intercept ESM callers.
 */
function patchNodeHttp(firewall: ScreenPrivacyFirewall, options: Required<OutboundGuardOptions>): () => void {
  const proto = (nodeHttp.ClientRequest as unknown as { prototype: Record<string, unknown> }).prototype as unknown as {
    write: (...args: unknown[]) => boolean;
    end: (...args: unknown[]) => unknown;
  };
  const origWrite = proto.write;
  const origEnd = proto.end;

  interface BodyEntry {
    chunks: Buffer[];
    len: number;
    screened: boolean;
  }
  const entries = new WeakMap<object, BodyEntry>();
  const getEntry = (req: object): BodyEntry => {
    let e = entries.get(req);
    if (!e) {
      e = { chunks: [], len: 0, screened: false };
      entries.set(req, e);
    }
    return e;
  };

  /** Screen one ClientRequest (URL + headers + buffered body). Throws on block. */
  const screenClientRequest = (req: unknown, entry: BodyEntry): void => {
    if (entry.screened) return;
    entry.screened = true;
    const r = req as { protocol?: string; host?: string; port?: number | string; path?: string };
    try {
      const protocol = r.protocol ?? 'http:';
      const host = r.host ?? '';
      if (!host) return;
      const port = r.port ? `:${r.port}` : '';
      const path = r.path?.startsWith('/') ? r.path : `/${r.path ?? ''}`;
      const url = new URL(`${protocol}//${host}${port}${path}`);
      // Headers via the internal out-headers store (symbol lookup).
      const headers: Record<string, unknown> = {};
      const outSym = Object.getOwnPropertySymbols(req).find((s) => String(s) === 'Symbol(outHeaders)');
      if (outSym) {
        const store = (req as Record<symbol, unknown>)[outSym] as Record<string, [string, unknown]> | undefined;
        if (store) {
          for (const [key, pair] of Object.entries(store)) {
            headers[key.toLowerCase()] = Array.isArray(pair) ? pair[1] : pair;
          }
        }
      }
      screenOutbound(firewall, 'REQUEST', url, headers, undefined, options.trustedHosts, options.scanBodyLimit);
      // Body: stream bodies cannot be rewritten mid-flight → any sensitive
      // finding (redact or block) destroys the request: the original payload
      // is never transmitted.
      if (entry.len > 0) {
        const bodyText = Buffer.concat(entry.chunks).toString('utf8', 0, options.scanBodyLimit);
        if (!isBulkBase64Body(bodyText)) {
          const bodyCtx: SpfContext = { destination: `${url.protocol}//${url.host}`, payloadKind: 'text', transport: 'http-body' };
          const verdict = firewall.inspectText(bodyText, bodyCtx);
          if (verdict.decision !== 'allow') {
            state.blocked++;
            throw new SpfBlockedError(`outbound_body:${verdict.reason}`, verdict.auditId);
          }
        }
      }
      state.inspected++;
    } catch (err) {
      if (err instanceof SpfBlockedError) throw err;
      /* URL parse issues etc. — let the request proceed; fetch-style paths
         are covered by the fetch patch and endpoint gates. */
    }
  };

  const destroyBlocked = (req: unknown, err: SpfBlockedError): void => {
    const r = req as { destroy: (e?: Error) => unknown; listenerCount: (name: string) => number };
    try {
      if (r.listenerCount('error') > 0) {
        r.destroy(err);
      } else {
        // No error listener: a raised 'error' event would crash the process.
        // Destroy silently and surface the block on the console (content-free).
        r.destroy();
        console.warn(`[SPF] outbound node request blocked (${err.spfReason})`);
      }
    } catch {
      /* destroy must never throw */
    }
  };

  proto.write = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    const entry = getEntry(this as object);
    if (!entry.screened) {
      try {
        if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
          if (entry.len < options.scanBodyLimit) {
            entry.chunks.push(buf.subarray(0, Math.max(0, options.scanBodyLimit - entry.len)));
            entry.len += buf.length;
          }
        }
        screenClientRequest(this, entry);
      } catch (err) {
        if (err instanceof SpfBlockedError) {
          destroyBlocked(this, err);
          return false;
        }
      }
    }
    return origWrite.call(this, chunk, ...rest);
  };

  proto.end = function (this: unknown, ...rest: unknown[]): unknown {
    const entry = getEntry(this as object);
    if (!entry.screened) {
      try {
        const last = rest.length > 0 ? rest[rest.length - 1] : undefined;
        if (typeof last === 'string' || Buffer.isBuffer(last)) {
          const buf = typeof last === 'string' ? Buffer.from(last) : (last as Buffer);
          if (entry.len < options.scanBodyLimit) {
            entry.chunks.push(buf.subarray(0, Math.max(0, options.scanBodyLimit - entry.len)));
            entry.len += buf.length;
          }
        }
        screenClientRequest(this, entry);
      } catch (err) {
        if (err instanceof SpfBlockedError) {
          // Destroy BEFORE the original end: no headers, no body — nothing
          // leaves the machine.
          destroyBlocked(this, err);
          return this;
        }
      }
    }
    return origEnd.apply(this, rest);
  };

  state.httpWrapped = true;
  state.httpsWrapped = true;
  return () => {
    proto.write = origWrite;
    proto.end = origEnd;
    state.httpWrapped = false;
    state.httpsWrapped = false;
  };
}

export interface InstalledGuard {
  state: GuardState;
  uninstall: () => void;
}

/**
 * Install the guard on the current process. Idempotent: a second install
 * replaces nothing — it returns the existing guard's state.
 */
export function installSpfOutboundGuard(firewall: ScreenPrivacyFirewall, options: OutboundGuardOptions = {}): InstalledGuard {
  const resolved: Required<OutboundGuardOptions> = {
    trustedHosts: options.trustedHosts ?? ['spf-blocked.invalid'],
    scanBodyLimit: options.scanBodyLimit ?? DEFAULT_BODY_LIMIT,
  };
  const uninstallFetch = patchFetch(firewall, resolved);
  const uninstallNode = patchNodeHttp(firewall, resolved);
  return {
    state,
    uninstall: () => {
      uninstallFetch();
      uninstallNode();
    },
  };
}
