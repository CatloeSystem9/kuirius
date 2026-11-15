/**
 * SPF public API. Browser-safe (no Node APIs in any of these modules except
 * outboundGuard.ts, which is imported only by the server entrypoint/tests).
 */
export * from './spfTypes';
export { SPF_CATEGORIES, defaultDetectors, scanText, luhnValid, type SpfDetector, type ScanOptions } from './detectors';
export { applyRedactions, applyRedactionsAtLeast, redactFrameRegions, redactDataUrlRegions, redactionCoverage, countRedactionMarkers } from './redact';
export { decideText, decideUrl, decideImage, verifyRedacted, combineVerdicts } from './decision';
export { SpfAuditLog, type SpfAuditEvent, type SpfAuditListener } from './audit';
export { ScreenPrivacyFirewall, CREDENTIAL_WINDOW_TITLE_RE, CREDENTIAL_QUESTION_RE, type FirewallOptions, type ImageTransferRequest } from './firewall';

import { ScreenPrivacyFirewall } from './firewall';
import { SpfAuditLog } from './audit';

/**
 * System-wide SPF instances. Both the agent layer (tools, bridge, UI) and the
 * server entrypoint use these singletons so audit events land in one place
 * per process and no path can construct a permissive firewall.
 */
export const spfAuditLog = new SpfAuditLog(300);
export const spfFirewall = new ScreenPrivacyFirewall({ audit: spfAuditLog, deadlineMs: 200 });

/**
 * Screen one item of a larger collection (tool-output texts, digest lines,
 * summary lines). Policy: per-item REDACT when confident; per-item strip
 * (replaced by a labeled placeholder) when redaction is impossible; the
 * collection is NEVER blocked as a whole — unrelated functionality must keep
 * working (task §8) and no item is emitted with sensitive content.
 */
export function spfScreenItem(
  text: string,
  destination: string,
  observationId?: string,
  transport: 'tool-output' | 'digest' | 'summary' | 'speech' | 'memory' | 'prompt' | 'chat-history' = 'tool-output'
): { text: string; decision: 'allow' | 'redact' | 'strip'; auditId?: string } {
  const verdict = spfFirewall.inspectText(text, {
    destination,
    observationId,
    payloadKind: 'text',
    transport,
  });
  if (verdict.decision === 'allow') return { text, decision: 'allow', auditId: verdict.auditId };
  if (verdict.decision === 'redact' && verdict.redactedText !== undefined) {
    return { text: verdict.redactedText, decision: 'redact', auditId: verdict.auditId };
  }
  // BLOCK verdict for an item that cannot be safely separated: emit a
  // content-free placeholder — the original never reaches the destination.
  return {
    text: `[REDACTED-SPF:${verdict.categories[0] ?? 'sensitive'}]`,
    decision: 'strip',
    auditId: verdict.auditId,
  };
}
