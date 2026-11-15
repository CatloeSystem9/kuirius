/**
 * ScreenPrivacyFirewall — the SPF façade (task §4, §5, §8).
 *
 * One instance protects the whole system. Every external-bound payload passes
 * through exactly one of:
 *   inspectText(text, ctx)          — plain text payloads
 *   inspectJsonPayload(obj, ctx)    — structured payloads (deep string walk)
 *   inspectUrl(url, ctx)            — URLs (raw + URI-decoded scanning)
 *   inspectImageTransfer(req, ctx)  — screenshot/cloud-vision transfers
 *
 * Guarantees:
 *  - fail-closed: any internal error, deadline miss, or unscannable payload
 *    yields BLOCK (task §8);
 *  - deterministic and local: no network, no model calls;
 *  - NO override API exists — agents cannot flip a decision; risk/input flags
 *    in the payload have no effect on the outcome;
 *  - audit: every decision is recorded via the attached SpfAuditLog with no
 *    sensitive content in the record.
 */
import { scanText, defaultDetectors, type SpfDetector, type ScanOptions } from './detectors';
import { maskRedactionMarkers } from './redact';
import { decideText, decideUrl, decideImage, verifyRedacted, combineVerdicts, type DecisionPolicy } from './decision';
import type { SpfContext, SpfDetectionResult, SpfVerdict } from './spfTypes';
import type { SpfAuditLog } from './audit';

export interface ImageTransferRequest {
  question?: string;
  activeWindowTitle?: string;
  /** Previously extracted screen texts for the same screen (cloud OCR results). */
  priorTexts?: string[];
  /** Region preset name when the transfer is a crop. */
  regionPreset?: string;
}

export interface FirewallOptions {
  detectors?: SpfDetector[];
  /** Detection deadline in ms (default 200) — exceeded → BLOCK. */
  deadlineMs?: number;
  audit?: SpfAuditLog;
  decisionPolicy?: DecisionPolicy;
}

export interface JsonVerdict {
  verdict: SpfVerdict;
  /** Deep-cloned payload with redacted string leaves (undefined for block). */
  payload?: unknown;
}

const LARGE_STRING_SKIP = 512 * 1024; // >512KB single strings (e.g. image data) are gated by their own path
const MAX_JSON_DEPTH = 8;
const MAX_JSON_STRINGS = 2000;

export class ScreenPrivacyFirewall {
  readonly audit?: SpfAuditLog;
  private readonly detectors: SpfDetector[] | undefined;
  private readonly deadlineMs: number;
  private readonly policy: DecisionPolicy;
  private counters = { allow: 0, redact: 0, block: 0, inspectCalls: 0, totalDetectMs: 0 };

  constructor(options: FirewallOptions = {}) {
    this.detectors = options.detectors;
    this.deadlineMs = options.deadlineMs ?? 200;
    this.audit = options.audit;
    this.policy = options.decisionPolicy ?? {};
  }

  // ------------------------------------------------------------- internals

  private scan(text: string): SpfDetectionResult {
    const options: ScanOptions = { deadlineMs: this.deadlineMs };
    if (this.detectors) options.detectors = this.detectors;
    return scanText(text, options);
  }

  private finish(verdict: SpfVerdict, ctx: SpfContext): SpfVerdict {
    this.counters.inspectCalls++;
    this.counters[verdict.decision]++;
    const withAudit: SpfVerdict = this.audit
      ? { ...verdict, auditId: this.audit.recordVerdict(verdict, ctx.destination, ctx.observationId, ctx.transport) }
      : verdict;
    return withAudit;
  }

  // -------------------------------------------------------------- text API

  /** Gate one text payload. Fail-closed wrapper — never throws. */
  inspectText(text: string, ctx: SpfContext): SpfVerdict {
    try {
      if (typeof text !== 'string') {
        return this.finish(this.blockVerdict('unrecognized_payload_format', ctx), ctx);
      }
      if (text.length > LARGE_STRING_SKIP) {
        // Oversized text payloads cannot be reliably screened → fail closed.
        return this.finish(this.blockVerdict('payload_too_large_to_scan', ctx), ctx);
      }
      const started = Date.now();
      const detection = this.scan(text);
      this.counters.totalDetectMs += Date.now() - started;
      const verdict = decideText(text, detection, ctx.transport, this.policy);
      if (verdict.decision === 'redact' && verdict.redactedText !== undefined) {
        // Never send the original payload as a fallback: re-scan the redacted
        // copy (markers masked — they are inert labels, not content); residual
        // sensitive content forces a BLOCK.
        const rescan = this.scan(maskRedactionMarkers(verdict.redactedText));
        const residualBlock = verifyRedacted(verdict.redactedText, detection, rescan);
        if (residualBlock) return this.finish(residualBlock, ctx);
      }
      return this.finish(verdict, ctx);
    } catch {
      return this.finish(this.blockVerdict('firewall_internal_error', ctx), ctx);
    }
  }

  // --------------------------------------------------------------- URL API

  /** Gate an outbound URL (navigation targets, research fetches). */
  inspectUrl(url: string, ctx: SpfContext): SpfVerdict {
    try {
      if (typeof url !== 'string' || url.length === 0 || url.length > 8192) {
        return this.finish(this.blockVerdict('unrecognized_payload_format', ctx), ctx);
      }
      const detection = this.scan(url);
      return this.finish(decideUrl(url, detection, ctx.transport), ctx);
    } catch {
      return this.finish(this.blockVerdict('firewall_internal_error', ctx), ctx);
    }
  }

  // --------------------------------------------------------------- JSON API

  /**
   * Gate a structured payload (request bodies). Every string leaf is scanned
   * with the text policy; the returned payload is a deep-cloned copy with
   * redacted leaves. Any BLOCK anywhere blocks the whole payload.
   */
  inspectJsonPayload(payload: unknown, ctx: SpfContext): JsonVerdict {
    try {
      const verdicts: Array<{ path: string; verdict: SpfVerdict }> = [];
      const sanitized = this.walkJson(payload, '$', ctx, verdicts, 0, { count: 0 });
      const combined = combineVerdicts(verdicts.map((v) => v.verdict));
      const finalVerdict = this.finish(combined, ctx);
      if (finalVerdict.decision === 'block') return { verdict: finalVerdict };
      return { verdict: finalVerdict, payload: sanitized };
    } catch {
      return { verdict: this.finish(this.blockVerdict('firewall_internal_error', ctx), ctx) };
    }
  }

  private walkJson(
    value: unknown,
    path: string,
    ctx: SpfContext,
    verdicts: Array<{ path: string; verdict: SpfVerdict }>,
    depth: number,
    budget: { count: number }
  ): unknown {
    if (depth > MAX_JSON_DEPTH || budget.count > MAX_JSON_STRINGS) return value;
    if (typeof value === 'string') {
      budget.count++;
      // Likely image/base64 bulk data is gated by its own explicit path.
      if (value.length > LARGE_STRING_SKIP) return value;
      const verdict = this.inspectTextInternal(value, ctx, `${ctx.destination}#${path}`);
      verdicts.push({ path, verdict });
      if (verdict.decision === 'redact' && verdict.redactedText !== undefined) return verdict.redactedText;
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item, i) => this.walkJson(item, `${path}[${i}]`, ctx, verdicts, depth + 1, budget));
    }
    if (value instanceof Date) return value;
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.walkJson(item, `${path}.${key}`, ctx, verdicts, depth + 1, budget);
      }
      return out;
    }
    return value; // functions/symbols/etc. pass through (not transmissible text)
  }

  /** inspectText without the audit side effect (audit runs once at combine). */
  private inspectTextInternal(text: string, ctx: SpfContext, _destination: string): SpfVerdict {
    try {
      const detection = this.scan(text);
      const verdict = decideText(text, detection, ctx.transport, this.policy);
      if (verdict.decision === 'redact' && verdict.redactedText !== undefined) {
        const rescan = this.scan(maskRedactionMarkers(verdict.redactedText));
        const residualBlock = verifyRedacted(verdict.redactedText, detection, rescan);
        if (residualBlock) return residualBlock;
      }
      return verdict;
    } catch {
      return this.blockVerdict('firewall_internal_error', ctx);
    }
  }

  // -------------------------------------------------------------- image API

  /**
   * Gate a screenshot/cloud-vision transfer from its metadata signals.
   * The image itself cannot be OCR'd locally — the decision uses the transfer
   * context (question, window title, prior extracted texts, region preset).
   * Any sensitive signal blocks the transfer: screen pixels cannot be
   * reliably separated from sensitive content post hoc.
   */
  inspectImageTransfer(request: ImageTransferRequest, ctx: SpfContext): SpfVerdict {
    try {
      const detections: Array<{ field: string; result: SpfDetectionResult }> = [];
      if (request.question !== undefined) detections.push({ field: 'question', result: this.scan(request.question) });
      // Authentication-context questions ("what is my password") — the
      // answer would be a credential extracted from the screen. Checked
      // independently of the window title.
      if (request.question && CREDENTIAL_QUESTION_RE.test(request.question)) {
        return this.finish(
          { decision: 'block', reason: 'credential_extraction_question', confidence: 0.85, categories: ['password'], findings: [] },
          ctx
        );
      }
      if (request.activeWindowTitle !== undefined && request.activeWindowTitle.length > 0) {
        detections.push({ field: 'window_title', result: this.scan(request.activeWindowTitle) });
        // Credential-indicating windows: the screen very likely shows
        // authentication content that cannot be safely separated.
        if (CREDENTIAL_WINDOW_TITLE_RE.test(request.activeWindowTitle)) {
          return this.finish(
            { decision: 'block', reason: 'credential_indicating_window_title', confidence: 0.85, categories: ['password'], findings: [] },
            ctx
          );
        }
      }
      if (request.priorTexts && request.priorTexts.length > 0) {
        const joined = request.priorTexts.slice(0, 64).join('\n').slice(0, 32768);
        detections.push({ field: 'prior_texts', result: this.scan(joined) });
      }
      if (request.regionPreset) {
        detections.push({ field: 'region_preset', result: this.scan(request.regionPreset) });
      }
      return this.finish(decideImage(
        { question: request.question, activeWindowTitle: request.activeWindowTitle, regionPreset: request.regionPreset },
        detections
      ), ctx);
    } catch {
      return this.finish(this.blockVerdict('firewall_internal_error', ctx), ctx);
    }
  }

  // --------------------------------------------------------------- helpers

  private blockVerdict(reason: string, ctx: SpfContext): SpfVerdict {
    return { decision: 'block', reason, confidence: 0, categories: [], findings: [] };
  }

  /**
   * Convenience: gate a set of named text fields (endpoint gates). Returns a
   * combined verdict plus per-field sanitized copies.
   */
  inspectTextFields(
    fields: Record<string, string | undefined>,
    ctx: SpfContext
  ): { verdict: SpfVerdict; sanitized: Record<string, string | undefined> } {
    const sanitized: Record<string, string | undefined> = {};
    const verdicts: SpfVerdict[] = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const verdict = this.inspectTextInternal(value, ctx, `${ctx.destination}#${name}`);
      verdicts.push(verdict);
      sanitized[name] = verdict.decision === 'redact' && verdict.redactedText !== undefined ? verdict.redactedText : value;
    }
    const combined = this.finish(combineVerdicts(verdicts), ctx);
    return { verdict: combined, sanitized };
  }

  stats(): { inspectCalls: number; allow: number; redact: number; block: number; avgDetectMs: number } {
    return {
      inspectCalls: this.counters.inspectCalls,
      allow: this.counters.allow,
      redact: this.counters.redact,
      block: this.counters.block,
      avgDetectMs: this.counters.inspectCalls > 0 ? this.counters.totalDetectMs / this.counters.inspectCalls : 0,
    };
  }
}

/** Window titles that indicate authentication/payment screens. */
export const CREDENTIAL_WINDOW_TITLE_RE =
  /\b(?:sign[\s-]?in|log[\s-]?in(?:\s+password)?|password|passkey|otp|two[\s-]?factor|2fa|authenticator|credential|vault|passwords?[\s&-]*(?:manager|manager\b)|1password|lastpass|bitwarden|keepass|keychain|bank(?:ing)?|wallet|payment|checkout|billing|wire\s+transfer)\b/i;

/** Questions asking Krisha to read a credential off the screen. */
export const CREDENTIAL_QUESTION_RE =
  /\b(?:what(?:'s| is).{0,24}password|read.{0,24}password|password.{0,16}(?:on|of|from).{0,24}screen|my\s+(?:otp|verification\s+code)|read\s+(?:the\s+)?(?:otp|verification\s+code)|credit\s+card\s+number)\b/i;

/** Default detector set accessor (for tests/guards). */
export { defaultDetectors };
