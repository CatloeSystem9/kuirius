/**
 * Multimodal verifier (Phase 14, spec §12) — checks conclusions against
 * INDEPENDENT evidence from the bounded context.
 *
 * Verdict rules (deterministic):
 *  - 'confirmed' requires agreeing evidence, preferably from ≥2 independent
 *    modalities (e.g. application state + visible window title)
 *  - 'refuted' requires direct contradiction from fresh evidence
 *  - otherwise 'uncertain' — with the exact additional evidence required
 * Single-source confirmations are allowed only for tier-1 fresh tool
 * evidence; otherwise a single source yields 'uncertain'.
 */
import type {
  EvidenceRef,
  ModalityConflict,
  VerificationRequest,
  VerificationVerdict,
} from './multimodalTypes';
import type { MultimodalContext } from './multimodalContext';
import { detectConflicts } from './multimodalReasoner';

export interface VerificationOutcome {
  expected: string;
  verdict: VerificationVerdict;
  confidence: number;
  evidence: EvidenceRef[];
  conflicts: ModalityConflict[];
  independentEvidence: boolean;
  requiredVerification: string[];
  reasoning: string[];
}

export class MultimodalVerifier {
  /**
   * Verify an expectation against the context's evidence.
   * `gatherFresh` (optional) is called first when provided and the request
   * asks for fresh evidence — this lets callers wire Phase 13 observation
   * without the verifier owning any capture logic.
   */
  async verify(
    context: MultimodalContext,
    request: VerificationRequest,
    gatherFresh?: () => Promise<void>
  ): Promise<VerificationOutcome> {
    if (request.requireFreshScreen && gatherFresh) {
      try {
        await gatherFresh();
      } catch {
        // Fresh evidence is best-effort; verification proceeds with what exists.
      }
    }
    if (request.signal?.aborted) {
      return {
        expected: request.expected,
        verdict: 'uncertain',
        confidence: 0,
        evidence: [],
        conflicts: [],
        independentEvidence: false,
        requiredVerification: ['verification was cancelled — rerun to verify'],
        reasoning: ['cancelled before evaluation'],
      };
    }

    const now = Date.now();
    const reasoning: string[] = [];
    const parsed = parseExpectation(request.expected);

    const agreeing: EvidenceRef[] = [];
    const contradicting: EvidenceRef[] = [];

    // Evidence family 1: application/process state.
    for (const obs of context.byType('application_state', now)) {
      if (obs.payload.type !== 'application_state') continue;
      const name = obs.payload.name.toLowerCase();
      const aboutTarget = parsed.target ? name.includes(parsed.target) : true;
      if (!aboutTarget) continue;
      const ref: EvidenceRef = {
        observationId: obs.id,
        type: 'application_state',
        aspect: `process "${obs.payload.name}" running=${obs.payload.running}`,
        quote: obs.payload.name,
        confidence: obs.confidence,
      };
      if (parsed.kind === 'app_open' && obs.payload.running) agreeing.push(ref);
      else if (parsed.kind === 'app_open' && obs.payload.running === false) contradicting.push(ref);
      else if (parsed.kind === 'app_closed' && obs.payload.running === false) agreeing.push(ref);
      else if (parsed.kind === 'app_closed' && obs.payload.running) contradicting.push(ref);
      else agreeing.push(ref);
    }

    // Evidence family 2: visible screen (window title / texts / buttons).
    for (const obs of context.byType('ui_state', now).slice(0, 2)) {
      if (obs.payload.type !== 'ui_state') continue;
      const s = obs.payload.summary;
      const title = (s.activeWindowTitle ?? '').toLowerCase();
      const texts = s.texts.map((t) => t.toLowerCase());
      const buttons = s.buttons.map((b) => b.toLowerCase());
      const mentions = (needle: string): string | undefined => {
        if (!needle) return undefined;
        if (title.includes(needle)) return s.activeWindowTitle;
        const hit = texts.find((t) => t.includes(needle)) ?? buttons.find((b) => b.includes(needle));
        return hit;
      };
      if (parsed.kind === 'app_open' || parsed.kind === 'app_closed') {
        const seen = mentions(parsed.target ?? '');
        if (seen) {
          const ref: EvidenceRef = {
            observationId: obs.id,
            type: 'ui_state',
            aspect: 'visible window/text',
            quote: seen,
            confidence: obs.confidence,
          };
          if (parsed.kind === 'app_open') agreeing.push(ref);
          else contradicting.push(ref);
        } else if (parsed.kind === 'app_closed') {
          agreeing.push({ observationId: obs.id, type: 'ui_state', aspect: 'absence on screen', confidence: obs.confidence * 0.6 });
        }
      } else if ((parsed.kind === 'text_present' || parsed.kind === 'element_present' || parsed.kind === 'url') && parsed.target) {
        const needle = parsed.target.toLowerCase();
        const seen = mentions(needle);
        if (seen) {
          agreeing.push({ observationId: obs.id, type: 'ui_state', aspect: parsed.kind, quote: seen, confidence: obs.confidence });
        } else {
          contradicting.push({ observationId: obs.id, type: 'ui_state', aspect: parsed.kind, quote: `(no "${parsed.target}" visible)`, confidence: obs.confidence * 0.7 });
        }
      }
    }

    // Evidence family 3: browser-native state.
    const browser = context.latest('browser_state', now);
    if (browser && browser.payload.type === 'browser_state' && (parsed.kind === 'url' || parsed.kind === 'text_present')) {
      const needle = (parsed.target ?? '').toLowerCase();
      const matches = needle
        ? browser.payload.url.toLowerCase().includes(needle) || browser.payload.title.toLowerCase().includes(needle) || (browser.payload.headings ?? []).some((h) => h.toLowerCase().includes(needle))
        : true;
      const ref: EvidenceRef = {
        observationId: browser.id,
        type: 'browser_state',
        aspect: 'browser url/title',
        quote: `${browser.payload.url} | ${browser.payload.title}`,
        confidence: browser.confidence,
      };
      if (matches) agreeing.push(ref);
      else contradicting.push(ref);
    }

    // Evidence family 4: structured tool results.
    for (const obs of context.byType('tool_result', now).slice(0, 4)) {
      if (obs.payload.type !== 'tool_result') continue;
      const serialized = JSON.stringify(obs.payload.output).toLowerCase();
      const aboutTarget = parsed.target ? serialized.includes(parsed.target.toLowerCase()) || obs.payload.toolName.toLowerCase().includes(parsed.target.toLowerCase()) : true;
      if (!aboutTarget) continue;
      const ref: EvidenceRef = {
        observationId: obs.id,
        type: 'tool_result',
        aspect: `tool "${obs.payload.toolName}" verified=${obs.payload.verified === true}`,
        quote: obs.payload.toolName,
        confidence: obs.confidence,
      };
      if (parsed.kind === 'app_closed' && obs.payload.toolName.toLowerCase().includes('close') && obs.payload.verified === true) agreeing.push(ref);
      else if (parsed.kind === 'app_open' && obs.payload.toolName.toLowerCase().includes('launch') && obs.payload.verified === false) contradicting.push(ref);
      else if (obs.payload.verified === true) agreeing.push(ref);
      else if (obs.payload.verified === false) contradicting.push(ref);
    }

    const conflicts = detectConflicts(context, now);
    const kindsAgreeing = new Set(agreeing.map((a) => a.type));
    const independentEvidence = kindsAgreeing.size >= 2;
    reasoning.push(`${agreeing.length} agreeing evidence item(s) across ${kindsAgreeing.size} modality kind(s); ${contradicting.length} contradicting`);

    let verdict: VerificationVerdict;
    let confidence: number;

    if (contradicting.length > 0 && agreeing.length === 0) {
      verdict = 'refuted';
      confidence = Math.max(0.5, ...contradicting.map((c) => c.confidence));
      reasoning.push('all relevant evidence contradicts the expectation');
    } else if (agreeing.length > 0 && independentEvidence) {
      verdict = 'confirmed';
      confidence = Math.min(0.98, 0.55 + 0.15 * (kindsAgreeing.size - 1) + 0.1 * Math.max(...agreeing.map((a) => a.confidence)));
      reasoning.push('independent modalities agree');
    } else if (agreeing.length > 0) {
      const single = agreeing[0];
      const strongTool = single.type === 'tool_result' && single.confidence >= 0.9;
      verdict = strongTool ? 'confirmed' : 'uncertain';
      confidence = strongTool ? Math.min(0.85, single.confidence) : Math.min(0.55, single.confidence);
      reasoning.push(
        strongTool
          ? 'single fresh verified tool result supports the expectation'
          : 'only one modality agrees — independent confirmation missing'
      );
    } else {
      verdict = 'uncertain';
      confidence = 0;
      reasoning.push('no relevant evidence in the context');
    }

    if (conflicts.length > 0) {
      confidence = Math.max(0, confidence - 0.2 * conflicts.length);
      reasoning.push(`confidence reduced by ${conflicts.length} unresolved conflict(s)`);
    }

    const requiredVerification: string[] = [];
    if (verdict !== 'confirmed') {
      requiredVerification.push('capture a fresh screen observation (Phase 13) as independent visual evidence');
    }
    if (parsed.kind === 'app_open' && !independentEvidence) {
      requiredVerification.push('query the application process state (Phase 9) to corroborate the window');
    }
    if ((parsed.kind === 'text_present' || parsed.kind === 'url') && !independentEvidence) {
      requiredVerification.push('refresh browser-native state (Phase 8) to corroborate the visible text');
    }

    return {
      expected: request.expected,
      verdict,
      confidence: Number(confidence.toFixed(3)),
      evidence: [...agreeing, ...contradicting].slice(0, 8),
      conflicts,
      independentEvidence,
      requiredVerification: Array.from(new Set(requiredVerification)),
      reasoning,
    };
  }
}

interface ParsedExpectation {
  kind: 'app_open' | 'app_closed' | 'url' | 'text_present' | 'element_present' | 'value' | 'generic';
  target: string;
}

/** Deterministic expectation parsing (spec §12 examples). */
export function parseExpectation(expected: string): ParsedExpectation {
  const e = expected.toLowerCase();
  const openMatch = e.match(/(.+?)\s+(?:is\s+)?(?:open|running|launched|started)/);
  const closedMatch = e.match(/(.+?)\s+(?:is\s+)?(?:closed|not running|terminated|exited)/);
  const urlMatch = expected.match(/https?:\/\/\S+/i);
  const onScreen = e.match(/"([^"]{2,80})"\s+(?:appeared|is visible|is shown|is present)|text\s+"([^"]{2,80})"/);

  if (urlMatch) return { kind: 'url', target: urlMatch[0] };
  if (onScreen) return { kind: 'text_present', target: onScreen[1] ?? onScreen[2] ?? '' };
  if (closedMatch) return { kind: 'app_closed', target: cleanTarget(closedMatch[1]) };
  if (openMatch) return { kind: 'app_open', target: cleanTarget(openMatch[1]) };
  if (/button|link|element|field|dialog/.test(e)) {
    const target = e.match(/"([^"]{1,80})"/)?.[1] ?? '';
    return { kind: 'element_present', target };
  }
  return { kind: 'generic', target: '' };
}

function cleanTarget(raw: string): string {
  return raw
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/^(?:application|app|program|window|process)\s+/i, '')
    .replace(/["']/g, '')
    .trim();
}
