/**
 * Experience-Based Learning — analyzes task outcomes and extracts reusable
 * lessons while distinguishing environmental/external failures from genuine
 * knowledge or procedural gaps.
 */
import { hashKey } from '../routing/cache';
import type { ConceptFormation } from './conceptFormation';
import type { KnowledgeIntegration } from './knowledgeIntegration';
import type { LearningStore } from './learningStore';
import type {
  ExperienceRecord,
  LearningCandidate,
  LearningOutcome,
} from './learningTypes';

export class ExperienceLearning {
  private readonly formation: ConceptFormation;
  private readonly integration: KnowledgeIntegration;

  constructor(formation: ConceptFormation, integration: KnowledgeIntegration) {
    this.formation = formation;
    this.integration = integration;
  }

  /**
   * Process a task outcome.
   * Environmental failures (network, permissions, timeout, emergency stop)
   * are recorded as environmental experiences and NEVER falsely treated as
   * proof that the underlying knowledge/approach was wrong.
   */
  processExperience(
    record: ExperienceRecord,
    store: LearningStore
  ): Partial<LearningOutcome> {
    store.saveExperience(record);

    if (record.environmental) {
      return {
        uncertainties: [
          `Task ${record.taskId} failed due to environmental/permission constraint (${record.cause ?? 'unknown'}) — approach not invalidated.`,
        ],
      };
    }

    if (!record.lessonDerived) {
      return {};
    }

    const candidate: LearningCandidate = {
      id: `exp_cand_${hashKey(`${record.id}|${record.lessonDerived}`)}`,
      type: record.outcome === 'success' ? 'procedure' : 'new_knowledge',
      source: 'task_outcome',
      content: record.lessonDerived,
      context: {
        taskId: record.taskId,
        outcome: record.outcome,
        toolsUsed: record.toolsUsed,
      },
      confidence: record.outcome === 'success' ? 0.65 : 0.55,
      sessionId: record.taskId,
      timestamp: record.timestamp,
      idempotencyKey: `exp_${hashKey(record.lessonDerived.toLowerCase())}`,
    };

    const existing = store.getAllConcepts();
    const { concepts, uncertainties } = this.formation.extractConcepts(
      candidate,
      existing
    );
    const results = this.integration.integrate(concepts, store);

    const conceptsAcquired = results
      .filter((r) => r.action === 'created' && r.conceptId)
      .map((r) => r.conceptId!);
    const conceptsUpdated = results
      .filter((r) => (r.action === 'updated' || r.action === 'merged') && r.conceptId)
      .map((r) => r.conceptId!);

    record.conceptIds = [...conceptsAcquired, ...conceptsUpdated];
    store.saveExperience(record);

    // If a subsequent task with the same concept succeeded, validate the lesson
    if (record.outcome === 'success' && record.conceptIds.length > 0) {
      for (const cid of record.conceptIds) {
        this.validateLesson(record.id, cid, store);
      }
    }

    return {
      conceptsAcquired,
      conceptsUpdated,
      uncertainties,
    };
  }

  /**
   * Validate a previously recorded lesson when a subsequent experience
   * confirms it works.
   */
  validateLesson(
    experienceId: string,
    conceptId: string,
    store: LearningStore
  ): boolean {
    const all = store.getAllExperiences();
    const target = all.find((e) => e.id === experienceId);
    const hasConfirmingSuccess = all.some(
      (e) =>
        e.outcome === 'success' &&
        (e.conceptIds.includes(conceptId) || e.id === experienceId)
    );
    if (!hasConfirmingSuccess) return false;

    if (target) {
      target.validated = true;
      store.saveExperience(target);
    }

    const concept = store.getConcept(conceptId);
    if (concept && concept.verificationStatus === 'unverified') {
      concept.verificationStatus = 'hypothesis';
      concept.confidence = Math.min(1, concept.confidence + 0.1);
      concept.updatedAt = Date.now();
      store.saveConcept(concept);
    }

    return true;
  }
}
