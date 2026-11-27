/**
 * Error Analysis & Correction — structured mistake → cause → concept link →
 * validated correction → future reuse.
 *
 * Avoids saving duplicate corrections and links each correction to the
 * underlying concepts and evidence.
 */
import { similarity } from '../memory/similarity';
import { hashKey } from '../routing/cache';
import type { ConceptFormation } from './conceptFormation';
import type { KnowledgeIntegration } from './knowledgeIntegration';
import type { LearningStore } from './learningStore';
import type {
  LearningCandidate,
  StructuredCorrection,
} from './learningTypes';

const DUPLICATE_CORRECTION_THRESHOLD = 0.8;

export class ErrorAnalysis {
  private readonly formation: ConceptFormation;
  private readonly integration: KnowledgeIntegration;

  constructor(formation: ConceptFormation, integration: KnowledgeIntegration) {
    this.formation = formation;
    this.integration = integration;
  }

  /**
   * Analyze a demonstrable mistake, form a structured correction, deduplicate
   * against existing corrections, link affected concepts, and persist.
   */
  analyzeError(
    mistake: string,
    correction: string,
    context: string,
    store: LearningStore
  ): StructuredCorrection {
    const cleanMistake = mistake.trim();
    const cleanCorrection = correction.trim();
    const existingCorrections = store.getAllCorrections();

    // Prevent saving nearly identical corrections repeatedly
    const dup = existingCorrections.find(
      (c) =>
        similarity(c.originalMistake, cleanMistake) >= DUPLICATE_CORRECTION_THRESHOLD &&
        similarity(c.correctedKnowledge, cleanCorrection) >= DUPLICATE_CORRECTION_THRESHOLD
    );
    if (dup) {
      return dup;
    }

    const cause = this.inferCause(cleanMistake, cleanCorrection, context);

    // Find affected concepts in store
    const relatedConcepts = store
      .getAllConcepts()
      .filter(
        (c) =>
          cleanMistake.toLowerCase().includes(c.label.toLowerCase()) ||
          cleanCorrection.toLowerCase().includes(c.label.toLowerCase()) ||
          similarity(`${c.label} ${c.definition}`, `${cleanMistake} ${cleanCorrection}`) >= 0.3
      );

    // Form or update the corrected knowledge concept
    const candidate: LearningCandidate = {
      id: `corr_cand_${hashKey(`${cleanMistake}|${cleanCorrection}`)}`,
      type: 'correction',
      source: 'correction',
      content: cleanCorrection,
      context: { topic: relatedConcepts[0]?.label ?? context, mistake: cleanMistake },
      confidence: 0.85,
      sessionId: `correction_${Date.now()}`,
      timestamp: Date.now(),
      idempotencyKey: `corr_${hashKey(cleanCorrection.toLowerCase())}`,
    };

    const { concepts } = this.formation.extractConcepts(
      candidate,
      store.getAllConcepts()
    );
    const integrationResults = this.integration.integrate(concepts, store);
    const affectedIds = Array.from(
      new Set([
        ...relatedConcepts.map((c) => c.id),
        ...integrationResults
          .map((r) => r.conceptId)
          .filter((id): id is string => Boolean(id)),
      ])
    );

    const record: StructuredCorrection = {
      id: `scorr_${Date.now()}_${hashKey(`${cleanMistake}|${cleanCorrection}`).slice(0, 8)}`,
      originalMistake: cleanMistake,
      cause,
      correctedKnowledge: cleanCorrection,
      evidence: context ? [`Context: ${context}`] : [],
      validatedAt: Date.now(),
      appliedCount: 0,
      conceptIds: affectedIds,
      createdAt: Date.now(),
    };

    store.saveCorrection(record);
    return record;
  }

  /** Add validation evidence to an existing correction. */
  validateCorrection(
    correctionId: string,
    evidence: string,
    store: LearningStore
  ): StructuredCorrection | null {
    const record = store.getCorrection(correctionId);
    if (!record) return null;
    if (!record.evidence.includes(evidence)) {
      record.evidence.push(evidence);
    }
    record.validatedAt = record.validatedAt ?? Date.now();
    store.saveCorrection(record);
    return record;
  }

  /** Retrieve relevant corrections for Agent Core before reasoning/acting. */
  findRelevantCorrections(
    context: string,
    store: LearningStore,
    limit = 5
  ): StructuredCorrection[] {
    const query = context.trim();
    if (!query) return [];

    const scored = store
      .getAllCorrections()
      .map((c) => {
        const text = `${c.originalMistake} ${c.correctedKnowledge}`;
        const sim = similarity(query, text);
        return { record: c, score: sim };
      })
      .filter((item) => item.score >= 0.14)
      .sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt)
      .slice(0, limit);

    return scored.map((s) => s.record);
  }

  private inferCause(
    mistake: string,
    correction: string,
    context: string
  ): StructuredCorrection['cause'] {
    const combined = `${mistake} ${correction} ${context}`.toLowerCase();
    if (/\b(?:instead of|step|procedure|order|first|then|run|call)\b/.test(combined)) {
      return 'wrong_procedure';
    }
    if (/\b(?:context|situation|only when|depends on|case)\b/.test(combined)) {
      return 'misunderstood_context';
    }
    if (/\b(?:forgot|didn't know|missing|unknown)\b/.test(combined)) {
      return 'missing_knowledge';
    }
    return 'incorrect_knowledge';
  }
}
