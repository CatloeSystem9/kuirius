/**
 * Screen Privacy Firewall (SPF) — shared types.
 *
 * SPF is a mandatory, fail-closed security boundary between Krisha's screen
 * observation system and every external destination. It decides, BEFORE any
 * transmission, whether a screen-derived payload may leave the device:
 * ALLOW (clean), REDACT (sensitive spans removed) or BLOCK (cannot be safely
 * separated, or classification is uncertain).
 *
 * Security properties:
 *  - no detector, verdict, audit record or error message ever carries the raw
 *    sensitive content — only categories, spans (positions), and non-reversible
 *    short hashes;
 *  - unknown or uncertain content defaults to BLOCK on screen-provenance
 *    transports;
 *  - agents have NO API to override a decision (no override method exists).
 */

/** Final transmission decision for one payload. */
export type SpfDecision = 'allow' | 'redact' | 'block';

/**
 * Severity of a finding:
 *  - never_transmit: must never leave the device as raw content (OTP,
 *    password, credential, full payment data, seed phrase, private key).
 *    Redaction MAY remove it from text payloads; images are BLOCKED.
 *  - sensitive: personal/financial identifiers redactable in text
 *    (bank details, card numbers, national IDs, confidential documents).
 *  - uncertain: weak/confidential-context signal — drives conservative
 *    handling (BLOCK on screen-provenance transports, flag on chat-history).
 */
export type SpfSeverity = 'never_transmit' | 'sensitive' | 'uncertain';

/** One detected sensitive region inside a scanned string. */
export interface SpfFinding {
  /** Detector category id (see spfCategories). */
  category: string;
  /** Stable severity driving the decision policy. */
  severity: SpfSeverity;
  /** Detector's confidence 0..1 that this really is the category. */
  confidence: number;
  /** Character span in the scanned string (positions only, no content). */
  start: number;
  end: number;
  /** Matched length in characters (size hint, no content). */
  length: number;
  /** Detector id that produced the finding. */
  detectorId: string;
}

export interface SpfDetectionResult {
  findings: SpfFinding[];
  /** Highest severity present, or null when clean. */
  maxSeverity: SpfSeverity | null;
  /** True when the deadline expired before all detectors ran → BLOCK. */
  timedOut: boolean;
  /** True when a detector threw → BLOCK (fail-closed). */
  error: boolean;
  /** Detector ids that produced findings (for audit; no content). */
  detectorIds: string[];
}

export type SpfPayloadKind =
  /** Plain text (question, query, message content, digest line). */
  | 'text'
  /** URL string — scanned raw and URI-decoded. */
  | 'url'
  /** Image transfer (JPEG/dataUrl) — decided from transfer metadata. */
  | 'image'
  /** JSON-ish structure — each string leaf scanned independently. */
  | 'json';

/**
 * Transport/provenance of the payload. Screen-provenance transports get the
 * strict policy (uncertain → BLOCK). 'chat-history' carries mixed provenance
 * (user-typed + already-SPF-sanitized screen text) and downgrades
 * uncertain-only findings to allow-with-flag; never_transmit/sensitive are
 * still redacted or blocked there.
 */
export type SpfTransport =
  | 'prompt'
  | 'chat-history'
  | 'http-body'
  | 'http-url'
  | 'tool-output'
  | 'digest'
  | 'speech'
  | 'memory'
  | 'summary';

export interface SpfContext {
  /** Where the payload would go, e.g. 'gemini:vision-analyze'. */
  destination: string;
  /** Observation/step identifier when known (audit correlation). */
  observationId?: string;
  payloadKind: SpfPayloadKind;
  transport: SpfTransport;
}

export interface SpfVerdict {
  decision: SpfDecision;
  /** Human-readable, content-free reason. */
  reason: string;
  /** Confidence of the decision itself, 0..1. */
  confidence: number;
  /** Categories involved (labels only). */
  categories: string[];
  /** Findings with spans into the ORIGINAL text (for redaction). */
  findings: SpfFinding[];
  /** Sanitized text for text payloads (unchanged for allow). */
  redactedText?: string;
  /** Coverage fraction removed by redaction (0 for allow/block). */
  redactionCoverage?: number;
  timedOut?: boolean;
  /** Audit event id, when an audit log is attached. */
  auditId?: string;
}

/** Non-reversible FNV-1a prefix hash used to correlate audit events. */
export function spfContentHashPrefix(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}
