/**
 * User clarification (Phase 16, spec §13) — deterministic ambiguity detection.
 *
 * When a goal admits MULTIPLE MATERIALLY DIFFERENT executable plans, the
 * planner refuses to guess: it returns a structured ClarificationRequest so
 * the task stops honestly with a concrete question instead of blindly picking
 * one interpretation. Precision over recall: only tight, verifiable patterns
 * trigger a request — a reasonable single interpretation never asks.
 *
 * Pure functions, no I/O, no model calls.
 */
import type { StepClassification } from '../planner';
import { classifyStep } from '../planner';

export interface ClarificationRequest {
  /** The question to put to the user (bounded). */
  question: string;
  /** The materially different interpretations (bounded, ≤4). */
  options: string[];
  /** Deterministic trigger that fired. */
  reason: 'alternative_targets';
}

/** Imperative verbs that take a concrete target and admit alternatives. */
const ALTERNATIVE_VERB_RE = /^(open|launch|start|play|run)\b/i;
const TOP_LEVEL_OR_RE = /\s+or\s+/i;
const EITHER_PREFIX_RE = /^(?:either\s+)/i;

/** Stable, bounded identity of a classified action (tool + target). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function actionIdentity(cls: StepClassification): string {
  return `${cls.toolName}|${stableStringify(cls.input).slice(0, 400)}`;
}

/**
 * Detect "open X or Y"-style ambiguity where each alternative resolves to a
 * CONCRETE but DIFFERENT action. Everything else returns null — chat, search
 * queries containing "or", compound sequential requests, and any goal with a
 * single executable interpretation never ask.
 */
export function detectAmbiguity(goalDescription: string): ClarificationRequest | null {
  const text = goalDescription.trim();
  if (text.length < 8 || text.length > 300) return null;
  if (!ALTERNATIVE_VERB_RE.test(text)) return null;
  if (!TOP_LEVEL_OR_RE.test(text)) return null;

  const verb = (text.match(/^(open|launch|start|play|run)\b/i) as RegExpMatchArray)[1];
  const parts = text.split(TOP_LEVEL_OR_RE).map((p) => p.trim().replace(/[?.!]+$/, '').trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return null;

  // Normalize every alternative into a full imperative clause so each one can
  // be classified the same way the planner would classify it ("open spotify or
  // netflix" → "open spotify" / "open netflix").
  const classifications: StepClassification[] = [];
  for (let i = 0; i < parts.length; i++) {
    const clause = i === 0 ? parts[i] : `${verb} ${parts[i]}`;
    const normalized = clause.replace(EITHER_PREFIX_RE, '');
    const cls = classifyStep(normalized);
    // Only CONCRETE, executable alternatives count — system.note fallbacks are
    // not materially different plans.
    if (!cls || cls.toolName === 'system.note' || cls.toolName === 'chat.report') continue;
    classifications.push(cls);
  }

  if (classifications.length < 2) return null;

  // Materially different = different tool or different target.
  const identities = new Set(classifications.map(actionIdentity));
  if (identities.size < 2) return null;

  const options = classifications.slice(0, 4).map((c) => c.description);
  return {
    question: `Did you mean: ${options.join(' — or — ')}?`,
    options,
    reason: 'alternative_targets',
  };
}

/** Bounded, user-readable refusal reason surfaced in the task summary. */
export function clarificationReason(request: ClarificationRequest): string {
  return `clarification needed: ${request.question.slice(0, 200)}`;
}
