/**
 * Consolidation Rules (v1) — deterministic candidate extraction, classification
 * and gating. Conservative by design: speculation, chitchat, temporary output,
 * secrets and oversized content never become candidates. Reuses the existing
 * MemoryService worth-assessment (assessWorth / extractPreferenceTriples) and
 * similarity normalization — no second safety or dedup implementation.
 */
import { assessWorth, extractPreferenceTriples, detectCorrection } from '../memoryService';
import { normalizeText } from '../similarity';
import { hashKey } from '../../routing/cache';
import type { ConsolidationClassification, ConsolidationSource, StructuredRelation } from './consolidationTypes';
import { CONSOLIDATION_CONFIDENCE } from './consolidationTypes';

/** Speculation markers — a guess must never become permanent knowledge. */
const SPECULATION_RE =
  /\b(?:maybe|perhaps|might\s+be|possibly|probably|i\s+think|i\s+guess|i\s+believe|not\s+sure|seems\s+like|sort\s+of|kind\s+of)\b/i;

/** Temporary content: arithmetic-only lines and code/prompt fragments. */
const ARITHMETIC_ONLY_RE = /^[\d\s+\-*/=().,%^]+$/;
const CODE_LIKE_RE = /^(?:\$\s|>{3,}|```|>>>\s)/;

/** Durable completion statements (task-confirmed project facts). */
const COMPLETION_RE =
  /\b(?:is|are)\s+(?:now\s+)?(?:complete|completed|done|finished|working|stable)\b/i;

/** Explicit decisions — durable directives. */
const DECISION_RE =
  /\b(?:decided|decision\s+is|from\s+now\s+on|we\s+will|we\s+should|krisha\s+will|krisha\s+should)\b/i;

/** Structured relation patterns — conservative, explicit wordings only.
 *  Subjects must be proper-noun-like (every word capitalized, ≤3 words), so
 *  generic phrases like "The system" never become graph entities. */
const RELATION_PATTERNS: Array<{ re: RegExp; relation: StructuredRelation['relation'] }> = [
  { re: /^([A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*){0,2})\s+prefers?\s+([^.!?\n]{3,60})\.?$/i, relation: 'prefers' },
  { re: /^([A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*){0,2})\s+(?:will\s+)?uses?\s+([^.!?\n]{3,60})\.?$/i, relation: 'uses' },
  { re: /^([A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*){0,2})\s+(?:is|are)\s+part\s+of\s+([^.!?\n]{3,60})\.?$/i, relation: 'part_of' },
  { re: /^([A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*){0,2})\s+depends\s+on\s+([^.!?\n]{3,60})\.?$/i, relation: 'depends_on' },
];

/** Sanitize raw input into a bounded candidate string ('' when unusable). */
export function sanitizeCandidate(text: unknown, maxChars: number): string {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.slice(0, Math.max(1, maxChars));
}

export function isSpeculative(text: string): boolean {
  return SPECULATION_RE.test(text);
}

export function isTemporary(text: string): boolean {
  return ARITHMETIC_ONLY_RE.test(text) || CODE_LIKE_RE.test(text);
}

/** True when the text is a durable user correction (drives stronger memory source). */
export function isDurableCorrection(text: string): boolean {
  return detectCorrection(text).durable;
}

/**
 * Classify a sanitized candidate. Returns null when the candidate must NOT be
 * consolidated (speculation, noise, secrets, no durable signal). Confidence is
 * fixed per rule — never a function of text length or repetition here
 * (recurrence is the engine's job).
 */
export function classifyCandidate(text: string, source: ConsolidationSource): ConsolidationClassification | null {
  const clean = String(text ?? '');
  if (!clean) return null;
  if (isSpeculative(clean)) return null; // never persist guesses
  if (isTemporary(clean)) return null; // calculations / code fragments

  // Secrets are always rejected — even if they also look like a durable fact.
  const worth = assessWorth(clean);
  if (worth.reason === 'looks like a secret/credential') return null;

  const completion = COMPLETION_RE.test(clean);
  const structured = extractStructuredRelation(clean);
  const decision = DECISION_RE.test(clean);
  if (!worth.worth && !completion && !structured && !decision) return null; // chitchat / one-offs

  if (source === 'user_message') {
    if (decision) return { kind: 'decision', confidence: CONSOLIDATION_CONFIDENCE.explicitUserStatement, reason: 'explicit_user_decision' };
    if (extractPreferenceTriples(clean).length > 0) return { kind: 'preference', confidence: CONSOLIDATION_CONFIDENCE.explicitUserStatement, reason: 'explicit_preference' };
    if (worth.category === 'correction') return { kind: 'decision', confidence: CONSOLIDATION_CONFIDENCE.explicitUserStatement, reason: 'explicit_correction' };
    if (worth.category === 'long_term') return { kind: 'project_fact', confidence: CONSOLIDATION_CONFIDENCE.explicitUserFact, reason: 'explicit_user_statement' };
    if (completion) return { kind: 'project_fact', confidence: CONSOLIDATION_CONFIDENCE.explicitUserFact, reason: 'explicit_user_statement' };
    // An explicit statement of a structured relation is itself a durable fact
    // ("Krisha depends on the Context Engine") even without directive wording.
    if (structured) return { kind: 'project_fact', confidence: CONSOLIDATION_CONFIDENCE.explicitUserFact, reason: 'explicit_user_statement' };
    return null;
  }

  // task_result: only tool-confirmed outcomes and stated relations are durable.
  if (source === 'task_result') {
    if (completion) return { kind: 'project_fact', confidence: CONSOLIDATION_CONFIDENCE.taskConfirmedOutcome, reason: 'task_confirmed_outcome' };
    if (structured) return { kind: 'project_fact', confidence: CONSOLIDATION_CONFIDENCE.taskConfirmedOutcome, reason: 'task_confirmed_relation' };
    if (decision) return { kind: 'decision', confidence: CONSOLIDATION_CONFIDENCE.taskConfirmedOutcome, reason: 'task_confirmed_decision' };
    // A preference voiced inside a task summary is weaker evidence than an
    // explicit user statement — inferred tier (recurrence may promote).
    if (extractPreferenceTriples(clean).length > 0) return { kind: 'preference', confidence: CONSOLIDATION_CONFIDENCE.inferredFromTask, reason: 'inferred_preference_from_task' };
    return null;
  }
  return null;
}

/** Extract a conservative structured relation (entity → relation → entity). */
export function extractStructuredRelation(text: string): StructuredRelation | null {
  const clean = String(text ?? '').trim();
  if (!clean || clean.length > 120) return null;
  for (const { re, relation } of RELATION_PATTERNS) {
    const m = clean.match(re);
    if (!m) continue;
    const subject = m[1].trim().replace(/\s+/g, ' ');
    // The pattern's /i flag cannot enforce capitalization — validate it here:
    // every subject word must start uppercase (proper-noun-like), so generic
    // phrases like "The system" never become graph entities.
    if (!subject.split(/\s+/).every((w) => /^[A-Z]/.test(w))) continue;
    const object = m[2].trim().replace(/\s+/g, ' ').split(/\s+/).slice(0, 8).join(' ');
    if (subject.length < 2 || object.length < 3) continue;
    if (subject.toLowerCase() === object.toLowerCase()) continue;
    return { subject, relation, object };
  }
  return null;
}

/** Conservative entity type for a structured subject. */
export function entityTypeForSubject(subject: string): 'person' | 'project' | 'resource' {
  const s = String(subject ?? '').toLowerCase();
  if (/^(user|me|i|we|us|they)\b/.test(s)) return 'person';
  if (/krisha|project/.test(s)) return 'project';
  return 'resource';
}

/** Deterministic dedup/recurrence key for a candidate. */
export function candidateKey(text: string): string {
  return hashKey(normalizeText(String(text ?? '')));
}
