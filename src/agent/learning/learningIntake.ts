/**
 * Learning Intake — deterministic local filtering and classification of
 * potential learning material.
 *
 * Reuses `detectCorrection` (memoryService.ts) and `hashKey` (routing/cache.ts).
 * Filters out chitchat, greetings, secrets, and temporary output so Krisha
 * does not treat every conversation as something to learn.
 */
import { detectCorrection } from '../memory/memoryService';
import { hashKey } from '../routing/cache';
import type {
  ExperienceRecord,
  LearningCandidate,
  LearningCandidateType,
  LearningConfig,
  LearningSource,
} from './learningTypes';

const SECRET_RE =
  /\b(api[_-]?key|apikey|password|passwd|secret|token|credential)s?\b\s*[:=]|\bsk-[a-z0-9]{16,}|\bghp_[A-Za-z0-9]{20,}/i;

const TEMPORARY_NOISE_RE =
  /^(?:hi|hello|hey|ok|okay|thanks|thank you|cool|nice|great|lol|haha|yes|no|bye|good morning|good night|what time is it|weather today)[\s!.?]*$/i;

/** Sentences that are questions should not be treated as learnable facts. */
const QUESTION_RE =
  /^(?:what|where|when|who|whom|whose|which|why|how|is|are|was|were|do|does|did|can|could|should|would|will|shall|may|might|have|has|had)\b.*\?$/i;

const FACT_RE =
  /\b(?:is|are|means|refers to|defined as|consists of|uses|enables|runs on|supports)\b/i;

const PROCEDURE_RE =
  /\b(?:step\s*\d+|first[,:\s].*\bthen\b|to\s+[a-z0-9_ ]+:\s*|you\s+(?:can|should|must)\s+(?:run|use|call|configure|set))\b/i;

const RELATIONSHIP_RE =
  /\b(?:is a (?:type|kind|subset|part) of|requires|depends on|relates to|is related to|extends|inherits from|contradicts)\b/i;

const SKILL_CHANGE_RE =
  /\b(?:instead of|update the procedure|change how you|new way to|better way to)\b/i;

const ENVIRONMENTAL_CAUSE_RE =
  /\b(?:permission|denied|network|offline|timeout|timed out|rate.?limit|429|503|econnrefused|emergency.?stop|aborted|cancelled)\b/i;

export class LearningIntake {
  /**
   * Analyze incoming text and extract bounded, deduplicated learning candidates.
   * Returns an empty array for chitchat, temporary noise, or secrets.
   */
  identifyLearningCandidates(
    rawText: string,
    source: LearningSource,
    sessionId: string,
    config: LearningConfig,
    context: Record<string, unknown> = {}
  ): LearningCandidate[] {
    const trimmed = String(rawText ?? '').trim();
    if (trimmed.length < 18 || trimmed.length > 4000) return [];
    if (SECRET_RE.test(trimmed)) return [];
    if (TEMPORARY_NOISE_RE.test(trimmed)) return [];
    if (QUESTION_RE.test(trimmed)) return [];

    // Split into sentences / clauses while keeping context intact
    const segments = trimmed
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 15 && s.length <= 1500);

    const seenKeys = new Set<string>();
    const candidates: LearningCandidate[] = [];

    for (const seg of segments) {
      if (SECRET_RE.test(seg) || TEMPORARY_NOISE_RE.test(seg) || QUESTION_RE.test(seg)) continue;

      const classified = this.classifySegment(seg, source);
      if (classified.type === 'temporary' || classified.confidence < 0.4) {
        continue;
      }

      const idempotencyKey = `lc_${hashKey(`${source}|${classified.type}|${seg.toLowerCase()}`)}`;
      if (seenKeys.has(idempotencyKey)) continue;
      seenKeys.add(idempotencyKey);

      candidates.push({
        id: `cand_${Date.now()}_${hashKey(idempotencyKey).slice(0, 8)}`,
        type: classified.type,
        source,
        content: seg,
        context: { ...context, originalLength: trimmed.length },
        confidence: classified.confidence,
        sessionId,
        timestamp: Date.now(),
        idempotencyKey,
      });
    }

    // Bound to top 5 highest-confidence candidates per turn
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates.slice(0, Math.min(5, config.maxQueueSize));
  }

  private classifySegment(
    segment: string,
    source: LearningSource
  ): { type: LearningCandidateType; confidence: number } {
    if (source === 'correction' || detectCorrection(segment).isCorrection) {
      if (SKILL_CHANGE_RE.test(segment)) {
        return { type: 'skill_change', confidence: 0.78 };
      }
      return { type: 'correction', confidence: 0.82 };
    }

    if (PROCEDURE_RE.test(segment)) {
      return { type: 'procedure', confidence: source === 'academy' ? 0.85 : 0.72 };
    }

    if (RELATIONSHIP_RE.test(segment)) {
      return { type: 'relationship', confidence: source === 'academy' ? 0.85 : 0.72 };
    }

    if (FACT_RE.test(segment)) {
      const base = source === 'academy' ? 0.82 : source === 'research' ? 0.7 : 0.65;
      return { type: 'new_knowledge', confidence: base };
    }

    // Academy lessons can still carry conceptual prose without "is/are"
    if (source === 'academy' && segment.length >= 25) {
      return { type: 'new_knowledge', confidence: 0.65 };
    }

    return { type: 'temporary', confidence: 0.2 };
  }

  /**
   * Convert a completed or failed task into an ExperienceRecord, classifying
   * whether a failure was environmental (permissions/network/timeout) rather
   * than a knowledge/procedure flaw.
   */
  identifyTaskOutcome(
    taskId: string,
    success: boolean,
    description: string,
    toolsUsed: string[] = [],
    errorText?: string
  ): ExperienceRecord {
    const combined = `${description} ${errorText ?? ''}`.trim();
    const environmental = !success && ENVIRONMENTAL_CAUSE_RE.test(combined);
    const cause = success
      ? 'task_succeeded'
      : environmental
        ? 'environmental_or_permission_constraint'
        : errorText || 'execution_or_knowledge_gap';

    const lessonDerived =
      !success && !environmental && combined.length >= 15
        ? `Avoid failure in "${description.slice(0, 100)}": ${errorText ?? 'verify prerequisites and inputs'}`
        : success && toolsUsed.length > 0 && description.length >= 15
          ? `Procedure for "${description.slice(0, 100)}" succeeded using ${toolsUsed.join(', ')}`
          : undefined;

    return {
      id: `exp_${Date.now()}_${hashKey(taskId).slice(0, 8)}`,
      taskId,
      outcome: success ? 'success' : 'failure',
      environmental,
      cause,
      lessonDerived,
      validated: false,
      conceptIds: [],
      toolsUsed,
      timestamp: Date.now(),
    };
  }
}
