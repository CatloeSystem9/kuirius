/**
 * Context Formatter — builds a compact, traceable, budget-bounded block of
 * learned concepts, validated corrections, verified skills, and knowledge gaps
 * for Agent Core reasoning.
 */
import type {
  AcquiredConcept,
  AcquiredSkill,
  StructuredCorrection,
} from './learningTypes';

const MAX_CONTEXT_CHARS = 3000;

export function formatLearningContext(
  concepts: AcquiredConcept[],
  corrections: StructuredCorrection[],
  skills: AcquiredSkill[],
  gaps: string[] = []
): string {
  const usableConcepts = concepts.filter((c) => c.confidence >= 0.45);
  const validCorrections = corrections.filter((c) => Boolean(c.validatedAt));
  const verifiedSkills = skills.filter((s) => s.masteryStatus !== 'unverified');

  if (
    usableConcepts.length === 0 &&
    validCorrections.length === 0 &&
    verifiedSkills.length === 0 &&
    gaps.length === 0
  ) {
    return '';
  }

  const lines: string[] = ['[KRIX LEARNED KNOWLEDGE]'];

  for (const c of usableConcepts.slice(0, 6)) {
    const source = c.provenance[0]?.source ?? 'unknown';
    const conflictNote =
      c.contradictions.some((ct) => !ct.resolved) ? ' [CONFLICT FLAGGED]' : '';
    lines.push(
      `• ${c.label}: ${c.definition} (status: ${c.verificationStatus}, confidence: ${c.confidence.toFixed(2)}, source: ${source})${conflictNote}`
    );
  }

  if (validCorrections.length > 0) {
    lines.push('[KRIX CORRECTIONS]');
    for (const corr of validCorrections.slice(0, 4)) {
      lines.push(
        `• Avoid "${corr.originalMistake.slice(0, 90)}" → Instead: ${corr.correctedKnowledge.slice(0, 140)}`
      );
    }
  }

  if (verifiedSkills.length > 0) {
    lines.push('[KRIX VERIFIED SKILLS]');
    for (const sk of verifiedSkills.slice(0, 3)) {
      lines.push(
        `• ${sk.label} (${sk.masteryStatus}): ${sk.procedure.slice(0, 150)}`
      );
    }
  }

  if (gaps.length > 0) {
    lines.push(`[KNOWLEDGE GAPS] ${gaps.slice(0, 4).join('; ')}`);
  }

  lines.push('[/KRIX LEARNED KNOWLEDGE]');

  const joined = lines.join('\n');
  return joined.length <= MAX_CONTEXT_CHARS
    ? joined
    : joined.slice(0, MAX_CONTEXT_CHARS - 3) + '...';
}
