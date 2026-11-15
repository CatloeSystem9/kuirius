/**
 * SPF decision engine — converts detection results into ALLOW/REDACT/BLOCK.
 *
 * Policy (task §4, SPF-ARCHITECTURE-REPORT.md §5):
 *  - fail-closed: detection error, timeout, unmappable secret, or unscannable
 *    payload → BLOCK;
 *  - OTPs / passwords / credentials / full payment data / seed phrases /
 *    private keys are NEVER transmitted raw: redacted from text payloads when
 *    confidently delimited, otherwise the payload is BLOCKED;
 *  - unknown or uncertain content defaults to BLOCK on screen-provenance
 *    transports; chat-history (mixed provenance, screen parts already
 *    sanitized upstream) downgrades uncertain-only findings to a flagged
 *    allow so ordinary conversation is never disabled by a weak heuristic;
 *  - excessive redaction coverage (payload dominated by secrets) → BLOCK,
 *    because the remaining context can no longer be safely interpreted.
 */
import type { SpfDecision, SpfFinding, SpfDetectionResult, SpfPayloadKind, SpfTransport, SpfVerdict } from './spfTypes';
import { applyRedactions, redactionCoverage } from './redact';

export interface DecisionPolicy {
  /** Above this removed-fraction a text payload is blocked instead of redacted. */
  maxRedactionCoverage?: number;
  /** Minimum detector confidence to treat a span as safely removable. */
  minRedactableConfidence?: number;
  /** Uncertain-only handling: strict (screen provenance) vs flagged (chat). */
  uncertainPolicy?: 'block' | 'allow_flagged';
}

export const DEFAULT_MAX_REDACTION_COVERAGE = 0.6;
export const DEFAULT_MIN_REDACTABLE_CONFIDENCE = 0.7;

/** Severity ordering helper. */
function severityAtLeast(a: SpfFinding['severity'], b: SpfFinding['severity']): boolean {
  const order: SpfFinding['severity'][] = ['uncertain', 'sensitive', 'never_transmit'];
  return order.indexOf(a) >= order.indexOf(b);
}

/**
 * Decide for a TEXT payload. Returns the verdict with redactedText when the
 * decision is redact (or allow with no changes).
 */
export function decideText(
  text: string,
  detection: SpfDetectionResult,
  transport: SpfTransport,
  policy: DecisionPolicy = {}
): SpfVerdict {
  const maxCoverage = policy.maxRedactionCoverage ?? DEFAULT_MAX_REDACTION_COVERAGE;
  const minConfidence = policy.minRedactableConfidence ?? DEFAULT_MIN_REDACTABLE_CONFIDENCE;
  const uncertainPolicy = policy.uncertainPolicy ?? (transport === 'chat-history' ? 'allow_flagged' : 'block');

  const categories = Array.from(new Set(detection.findings.map((f) => f.category)));
  const confidence = detection.findings.length
    ? Math.max(...detection.findings.map((f) => f.confidence))
    : 1;

  // Fail-closed fundamentals first.
  if (detection.error) {
    return blockVerdict('detection_error', categories, 0.0, detection.findings, detection.timedOut);
  }
  if (detection.timedOut) {
    return blockVerdict('classification_timeout', categories, 0.0, detection.findings, true);
  }
  if (detection.findings.length === 0) {
    return { decision: 'allow', reason: 'no_sensitive_content_detected', confidence: 1, categories: [], findings: [] };
  }

  const hasNeverTransmit = detection.findings.some((f) => f.severity === 'never_transmit');
  const hasSensitive = detection.findings.some((f) => f.severity === 'sensitive');
  const onlyUncertain = !hasNeverTransmit && !hasSensitive;

  if (onlyUncertain) {
    if (uncertainPolicy === 'allow_flagged') {
      return {
        decision: 'allow',
        reason: 'uncertain_confidential_context_flagged',
        confidence: 0.5,
        categories,
        findings: detection.findings,
      };
    }
    return blockVerdict('uncertain_content_default_block', categories, confidence, detection.findings, detection.timedOut);
  }

  // Never-transmit / sensitive content present. Redact confident spans.
  const redactable = detection.findings.filter(
    (f) => severityAtLeast(f.severity, 'sensitive') && f.confidence >= minConfidence
  );
  const unredactable = detection.findings.filter(
    (f) => severityAtLeast(f.severity, 'sensitive') && f.confidence < minConfidence
  );

  if (unredactable.length > 0) {
    // Sensitive content we cannot confidently delimit → cannot safely separate.
    return blockVerdict('sensitive_content_not_separably_delimited', categories, confidence, detection.findings, detection.timedOut);
  }

  const redacted = applyRedactions(text, redactable);
  const coverage = redactionCoverage(text, redacted);

  if (coverage > maxCoverage) {
    return blockVerdict('redaction_coverage_exceeds_safe_context', categories, confidence, detection.findings, detection.timedOut);
  }
  if (redacted === text) {
    // Redaction produced no change — never fall back to the original payload.
    return blockVerdict('redaction_failed', categories, confidence, detection.findings, detection.timedOut);
  }

  return {
    decision: 'redact',
    reason: `redacted:${categories.join('+')}`,
    confidence,
    categories,
    findings: detection.findings,
    redactedText: redacted,
    redactionCoverage: coverage,
    timedOut: detection.timedOut,
  };
}

/** Post-redaction verification — residual findings force a BLOCK. */
export function verifyRedacted(redactedText: string, detection: SpfDetectionResult, rescan: SpfDetectionResult): SpfVerdict | null {
  const residual = rescan.findings.filter((f) => severityAtLeast(f.severity, 'sensitive'));
  if (residual.length > 0 || rescan.error || rescan.timedOut) {
    return blockVerdict(
      rescan.error ? 'detection_error' : rescan.timedOut ? 'classification_timeout' : 'residual_sensitive_content_after_redaction',
      Array.from(new Set(residual.map((f) => f.category))),
      0,
      detection.findings,
      rescan.timedOut
    );
  }
  return null;
}

function blockVerdict(reason: string, categories: string[], confidence: number, findings: SpfFinding[], timedOut?: boolean): SpfVerdict {
  return { decision: 'block', reason, confidence, categories, findings, timedOut };
}

/**
 * Decide for a URL payload. URLs are opaque transports — any sensitive
 * finding blocks the URL (no in-place redaction of navigation targets).
 */
export function decideUrl(url: string, detection: SpfDetectionResult, transport: SpfTransport): SpfVerdict {
  const categories = Array.from(new Set(detection.findings.map((f) => f.category)));
  if (detection.error) return blockVerdict('detection_error', categories, 0, detection.findings, detection.timedOut);
  if (detection.timedOut) return blockVerdict('classification_timeout', categories, 0, detection.findings, true);
  if (detection.findings.length === 0) {
    return { decision: 'allow', reason: 'no_sensitive_content_detected', confidence: 1, categories: [], findings: [] };
  }
  const strong = detection.findings.some((f) => severityAtLeast(f.severity, 'sensitive'));
  if (!strong) {
    // Uncertain context markers inside a URL → strict (screen provenance)
    // transports block; chat-opened URLs are flagged.
    if (transport === 'chat-history') {
      return { decision: 'allow', reason: 'uncertain_confidential_context_flagged', confidence: 0.5, categories, findings: detection.findings };
    }
    return blockVerdict('uncertain_content_default_block', categories, 0.6, detection.findings, detection.timedOut);
  }
  return blockVerdict('sensitive_content_in_url', categories, 0.9, detection.findings, detection.timedOut);
}

/**
 * Decide for an IMAGE transfer from its metadata signals. Images cannot be
 * reliably cleaned after the fact (no local OCR): any sensitive signal blocks
 * the whole transfer unless region redaction was already applied upstream.
 */
export function decideImage(
  signals: { question?: string; activeWindowTitle?: string; priorTexts?: string[]; regionPreset?: string },
  detections: { field: string; result: SpfDetectionResult }[]
): SpfVerdict {
  const categories: string[] = [];
  let worstReason: string | null = null;
  let confidence = 0;
  const findings: SpfFinding[] = [];

  for (const { field, result } of detections) {
    if (result.error) {
      return blockVerdict('detection_error', [field], 0, [], result.timedOut);
    }
    if (result.timedOut) {
      return blockVerdict('classification_timeout', [field], 0, [], true);
    }
    for (const f of result.findings) {
      findings.push(f);
      if (!categories.includes(f.category)) categories.push(f.category);
      if (severityAtLeast(f.severity, 'sensitive') || (f.severity === 'uncertain' && !worstReason)) {
        if (!worstReason) worstReason = `sensitive_content_in_${field}`;
        confidence = Math.max(confidence, f.confidence);
      }
    }
  }

  if (findings.length === 0) {
    return { decision: 'allow', reason: 'image_metadata_clean', confidence: 1, categories: [], findings: [] };
  }

  // Uncertain-only findings block images too: a confidential document visible
  // on screen cannot be safely separated from its pixels.
  return blockVerdict(worstReason ?? 'image_content_not_separably_verifiable', categories, confidence, findings);
}

/** Utility: merge per-payload-kind verdicts (used by JSON walkers). */
export function combineVerdicts(verdicts: SpfVerdict[]): SpfVerdict {
  const blocked = verdicts.find((v) => v.decision === 'block');
  if (blocked) return blocked;
  const redacts = verdicts.filter((v) => v.decision === 'redact');
  if (redacts.length > 0) {
    return {
      decision: 'redact',
      reason: `redacted:${redacts.flatMap((v) => v.categories).join('+')}`,
      confidence: Math.max(...redacts.map((v) => v.confidence)),
      categories: Array.from(new Set(redacts.flatMap((v) => v.categories))),
      findings: redacts.flatMap((v) => v.findings),
    };
  }
  const flagged = verdicts.find((v) => v.reason === 'uncertain_confidential_context_flagged');
  if (flagged) return flagged;
  return { decision: 'allow', reason: 'no_sensitive_content_detected', confidence: 1, categories: [], findings: [] };
}

export function decisionForPayloadKind(kind: SpfPayloadKind): 'text' | 'url' | 'image' {
  if (kind === 'url') return 'url';
  if (kind === 'image') return 'image';
  return 'text';
}
