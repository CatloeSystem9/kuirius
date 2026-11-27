/**
 * Learning Orchestrator — central coordinator for the Krix Learning Mechanism.
 *
 * Connects:
 *   LearningIntake → ConceptFormation → KnowledgeIntegration
 *   ExperienceLearning + ErrorAnalysis + SkillAcquisition + LearningToLearn
 *   → LearningStore (durable) + KnowledgeGraphFacade (optional mirror)
 *   → AcademyLearningService (future Krix Academy contract)
 *   → AgentCore (pre-reasoning retrieval + event-driven post-task learning)
 *
 * Resource & safety guarantees:
 *  - Event-driven only (no background polling timers).
 *  - Bounded queue (`maxQueueSize`), bounded concurrency (`maxConcurrentTasks`),
 *    deduplication window (`deduplicationWindowMs`), and explicit cancellation.
 *  - Normal conversation and task execution remain non-blocking.
 */
import type { AgentEvent, AgentEventBus } from '../events';
import type { KnowledgeGraphFacade } from '../knowledge';
import { similarity } from '../memory/similarity';
import { hashKey } from '../routing/cache';
import type { SemanticIntelligence } from '../semantic';
import type { StorageAdapter } from '../taskState';
import { localStorageAdapter } from '../taskState';
import type { AgentTask } from '../types';
import type {
  AcademyLearningService,
  AssessmentResult,
  GapExplanation,
  GuidedSessionConfig,
  LessonMaterial,
  PracticeResult,
  ResourceBudget,
  UserCorrection,
} from './academyContract';
import { ConceptFormation } from './conceptFormation';
import { formatLearningContext } from './contextFormatter';
import { ErrorAnalysis } from './errorAnalysis';
import { ExperienceLearning } from './experienceLearning';
import { KnowledgeIntegration } from './knowledgeIntegration';
import { LearningIntake } from './learningIntake';
import { LearningStore } from './learningStore';
import { LearningToLearn } from './learningToLearn';
import type {
  AcquiredConcept,
  AcquiredSkill,
  ConceptContradiction,
  LearningCandidate,
  LearningConfig,
  LearningOutcome,
  LearningQueueItem,
  LearningSession,
  LearningSource,
  StructuredCorrection,
} from './learningTypes';
import { DEFAULT_LEARNING_CONFIG } from './learningTypes';
import { SkillAcquisition } from './skillAcquisition';

export interface LearningOrchestratorOptions {
  storage?: StorageAdapter;
  storageKey?: string;
  config?: Partial<LearningConfig>;
  semantic?: SemanticIntelligence;
  knowledgeGraph?: KnowledgeGraphFacade;
  taskResolver?: (taskId: string) => AgentTask | undefined;
}

export class LearningOrchestrator {
  readonly store: LearningStore;
  readonly config: LearningConfig;
  readonly intake: LearningIntake;
  readonly formation: ConceptFormation;
  readonly integration: KnowledgeIntegration;
  readonly experience: ExperienceLearning;
  readonly errorAnalysis: ErrorAnalysis;
  readonly skillAcquisition: SkillAcquisition;
  readonly learningToLearn: LearningToLearn;

  private readonly taskResolver?: (taskId: string) => AgentTask | undefined;
  private activeCount = 0;
  private cancelled = false;
  private detachFns: Array<() => void> = [];

  constructor(options: LearningOrchestratorOptions = {}) {
    this.config = { ...DEFAULT_LEARNING_CONFIG, ...options.config };
    this.store = new LearningStore(
      options.storage ?? localStorageAdapter,
      options.storageKey
    );
    this.intake = new LearningIntake();
    this.formation = new ConceptFormation(options.semantic);
    this.integration = new KnowledgeIntegration(
      this.formation,
      options.knowledgeGraph
    );
    this.experience = new ExperienceLearning(this.formation, this.integration);
    this.errorAnalysis = new ErrorAnalysis(this.formation, this.integration);
    this.skillAcquisition = new SkillAcquisition();
    this.learningToLearn = new LearningToLearn();
    this.taskResolver = options.taskResolver;
  }

  // ------------------------------------------------------- Event Bus Wiring

  /**
   * Subscribe to AgentEventBus for non-blocking, event-driven learning.
   * Never polls; returns a detach function.
   */
  attach(bus: AgentEventBus): () => void {
    this.detach();
    this.cancelled = false;

    this.detachFns.push(
      bus.on('USER_MESSAGE', (event: AgentEvent) => {
        const input = String(
          (event.payload as { input?: string } | undefined)?.input ?? ''
        );
        if (!input) return;
        this.enqueueConversation(
          input,
          event.taskId ?? `session_${Date.now()}`,
          'conversation'
        );
      })
    );

    this.detachFns.push(
      bus.on('TASK_COMPLETED', (event: AgentEvent) => {
        const task = event.taskId ? this.taskResolver?.(event.taskId) : undefined;
        if (!task) return;
        const tools = (task.plan?.steps ?? [])
          .map((s) => s.toolName)
          .filter(Boolean);
        this.enqueueTaskOutcome(
          task.id,
          true,
          task.goal.description,
          tools
        );
      })
    );

    this.detachFns.push(
      bus.on('TASK_FAILED', (event: AgentEvent) => {
        const task = event.taskId ? this.taskResolver?.(event.taskId) : undefined;
        if (!task) return;
        const tools = (task.plan?.steps ?? [])
          .map((s) => s.toolName)
          .filter(Boolean);
        this.enqueueTaskOutcome(
          task.id,
          false,
          task.goal.description,
          tools,
          task.error
        );
      })
    );

    return () => this.detach();
  }

  detach(): void {
    for (const off of this.detachFns) off();
    this.detachFns = [];
  }

  /** Cancel pending queued items and prevent new batch runs until resumed. */
  cancelPending(): number {
    this.cancelled = true;
    return this.store.cancelQueueItems(() => true);
  }

  resumeQueue(): void {
    this.cancelled = false;
  }

  // ------------------------------------------------ Intake & Queueing (Async)

  /**
   * Detect learning candidates from text and enqueue them (bounded + deduped).
   * Schedules microtask processing so the conversation pipeline never blocks.
   */
  enqueueConversation(
    text: string,
    sessionId: string,
    source: LearningSource = 'conversation',
    context: Record<string, unknown> = {}
  ): LearningCandidate[] {
    const candidates = this.intake.identifyLearningCandidates(
      text,
      source,
      sessionId,
      this.config,
      context
    );

    const accepted: LearningCandidate[] = [];
    for (const cand of candidates) {
      const enqueued = this.store.enqueueItem(
        {
          id: `qi_${cand.id}`,
          type: 'intake',
          payload: cand,
          priority: source === 'correction' || source === 'academy' ? 2 : 1,
          createdAt: Date.now(),
          attempts: 0,
          maxAttempts: 2,
          idempotencyKey: cand.idempotencyKey,
        },
        this.config.maxQueueSize,
        this.config.deduplicationWindowMs
      );
      if (enqueued) accepted.push(cand);
    }

    if (accepted.length > 0 && !this.cancelled) {
      queueMicrotask(() => {
        void this.drainQueueCycle();
      });
    }
    return accepted;
  }

  enqueueTaskOutcome(
    taskId: string,
    success: boolean,
    description: string,
    toolsUsed: string[] = [],
    errorText?: string
  ): boolean {
    if (!this.config.enableExperienceLearning) return false;
    const record = this.intake.identifyTaskOutcome(
      taskId,
      success,
      description,
      toolsUsed,
      errorText
    );
    const enqueued = this.store.enqueueItem(
      {
        id: `qi_${record.id}`,
        type: 'experience',
        payload: record,
        priority: success ? 1 : 2,
        createdAt: Date.now(),
        attempts: 0,
        maxAttempts: 2,
        idempotencyKey: `exp_${hashKey(`${taskId}|${success}|${description}`)}`,
      },
      this.config.maxQueueSize,
      this.config.deduplicationWindowMs
    );
    if (enqueued && !this.cancelled) {
      queueMicrotask(() => {
        void this.drainQueueCycle();
      });
    }
    return enqueued;
  }

  /**
   * Process up to `maxConcurrentTasks` items from the bounded queue.
   * Exposed for deterministic testing and explicit flush.
   */
  async drainQueueCycle(): Promise<number> {
    if (this.cancelled) return 0;
    const availableSlots = Math.max(
      0,
      this.config.maxConcurrentTasks - this.activeCount
    );
    if (availableSlots === 0) return 0;

    const batch = this.store.dequeueItems(availableSlots);
    if (batch.length === 0) return 0;

    this.activeCount += batch.length;
    try {
      await Promise.all(
        batch.map(async (item) => {
          try {
            if (item.type === 'intake') {
              this.processCandidate(item.payload as LearningCandidate);
            } else if (item.type === 'experience') {
              this.experience.processExperience(item.payload as any, this.store);
            }
          } catch {
            // Isolated per-item failure: never corrupts other queued items
          }
        })
      );
      return batch.length;
    } finally {
      this.activeCount = Math.max(0, this.activeCount - batch.length);
    }
  }

  // ----------------------------------------- Synchronous Learning & Retrieval

  /**
   * Synchronously process a learning text (used by Academy lessons & direct
   * teaching flows) and return a structured LearningOutcome.
   */
  learnFromText(
    text: string,
    source: LearningSource,
    sessionId: string,
    context: Record<string, unknown> = {}
  ): LearningOutcome {
    const candidates = this.intake.identifyLearningCandidates(
      text,
      source,
      sessionId,
      this.config,
      context
    );
    const outcome = emptyOutcome(sessionId);

    for (const cand of candidates) {
      if (this.store.isDuplicateKey(cand.idempotencyKey, this.config.deduplicationWindowMs)) {
        continue;
      }
      this.store.markKeySeen(cand.idempotencyKey);
      const stepOutcome = this.processCandidate(cand);
      mergeOutcomes(outcome, stepOutcome);
    }

    this.store.persist();
    return outcome;
  }

  /** Process a single LearningCandidate through ConceptFormation + KnowledgeIntegration. */
  processCandidate(candidate: LearningCandidate): LearningOutcome {
    const outcome = emptyOutcome(candidate.sessionId);
    const existing = this.store.getAllConcepts();
    const { concepts, uncertainties } = this.formation.extractConcepts(
      candidate,
      existing
    );
    outcome.uncertainties.push(...uncertainties);

    const results = this.integration.integrate(concepts, this.store);
    for (const res of results) {
      if (res.action === 'created' && res.conceptId) {
        outcome.conceptsAcquired.push(res.conceptId);
        outcome.understood.push(res.reason);
        this.learningToLearn.trackAttempt(
          'concept_extraction',
          candidate.source,
          true,
          res.conceptId,
          this.store
        );
      } else if (
        (res.action === 'updated' || res.action === 'merged') &&
        res.conceptId
      ) {
        outcome.conceptsUpdated.push(res.conceptId);
        outcome.understood.push(res.reason);
        this.learningToLearn.trackAttempt(
          'concept_extraction',
          candidate.source,
          true,
          res.conceptId,
          this.store
        );
      } else if (res.action === 'flagged_conflict' && res.conflict) {
        outcome.conflicts.push(res.conflict);
        outcome.uncertainties.push(res.reason);
        this.learningToLearn.trackAttempt(
          'concept_extraction',
          candidate.source,
          false,
          res.conceptId ?? '',
          this.store
        );
      } else {
        outcome.conceptsRejected.push(res.reason);
      }
    }

    for (const c of concepts) {
      if (c.knowledgeGaps.length > 0) {
        outcome.remainingGaps.push(...c.knowledgeGaps);
      }
      if (
        c.verificationStatus === 'user_provided' ||
        c.verificationStatus === 'fact'
      ) {
        outcome.validatedItems.push(c.id);
      }
    }

    return outcome;
  }

  /** Record and analyze a mistake correction. */
  processCorrection(
    mistake: string,
    correction: string,
    context = ''
  ): StructuredCorrection {
    return this.errorAnalysis.analyzeError(
      mistake,
      correction,
      context,
      this.store
    );
  }

  /**
   * Fast pre-reasoning retrieval for Agent Core.
   * Considers concept definitions, relationships, and confidence.
   */
  retrieveRelevantKnowledge(query: string, limit = 5): AcquiredConcept[] {
    const clean = query.trim();
    if (!clean) return [];

    const all = this.store.getAllConcepts();
    const scored = all
      .map((c) => {
        const directSim = similarity(clean, `${c.label} ${c.definition}`);
        const labelHit = clean.toLowerCase().includes(c.label.toLowerCase())
          ? 0.25
          : 0;
        const score = directSim * 0.8 + labelHit + c.confidence * 0.1;
        return { concept: c, score };
      })
      .filter((item) => item.score >= 0.16)
      .sort((a, b) => b.score - a.score || b.concept.confidence - a.concept.confidence)
      .slice(0, limit);

    return scored.map((s) => s.concept);
  }

  retrieveCorrections(context: string, limit = 5): StructuredCorrection[] {
    return this.errorAnalysis.findRelevantCorrections(
      context,
      this.store,
      limit
    );
  }

  retrieveApplicableSkills(context: string, limit = 3): AcquiredSkill[] {
    return this.skillAcquisition.findApplicableSkills(
      context,
      this.store,
      limit
    );
  }

  /** Build the compact, traceable context block for Agent Core pre-reasoning. */
  buildReasoningContext(query: string): {
    formatted: string;
    concepts: AcquiredConcept[];
    corrections: StructuredCorrection[];
    skills: AcquiredSkill[];
    gaps: string[];
  } {
    const concepts = this.retrieveRelevantKnowledge(query, 5);
    const corrections = this.retrieveCorrections(query, 4);
    const skills = this.retrieveApplicableSkills(query, 3);
    const gaps = Array.from(
      new Set(concepts.flatMap((c) => c.knowledgeGaps))
    ).slice(0, 5);

    const formatted = formatLearningContext(concepts, corrections, skills, gaps);
    return { formatted, concepts, corrections, skills, gaps };
  }

  // ------------------------------------------------ Academy Contract Factory

  getAcademyService(): AcademyLearningService {
    return {
      submitLesson: async (material: LessonMaterial): Promise<LearningOutcome> => {
        const sessionId = `acad_lesson_${Date.now()}`;
        const outcome = this.learnFromText(
          material.content,
          'academy',
          sessionId,
          {
            topic: material.topic,
            difficulty: material.difficulty,
            prerequisites: material.prerequisites,
            sourceId: material.sourceId,
          }
        );
        return outcome;
      },

      startGuidedSession: async (
        config: GuidedSessionConfig
      ): Promise<LearningSession> => {
        const now = Date.now();
        const sessionId = `acad_guided_${now}_${hashKey(config.topic).slice(0, 6)}`;
        const session: LearningSession = {
          id: sessionId,
          startedAt: now,
          updatedAt: now,
          mode: 'guided',
          topic: config.topic,
          source: 'academy',
          candidates: [],
          status: 'active',
          resumeToken: `resume_${sessionId}`,
          apiCallsUsed: 0,
        };
        const aggregated = emptyOutcome(sessionId);
        for (const lesson of config.lessons) {
          const out = this.learnFromText(lesson.content, 'academy', sessionId, {
            topic: lesson.topic,
            prerequisites: lesson.prerequisites,
          });
          mergeOutcomes(aggregated, out);
        }
        session.outcome = aggregated;
        session.status = 'completed';
        session.updatedAt = Date.now();
        this.store.saveSession(session);
        return session;
      },

      startIndependentSession: async (
        topic: string,
        budget: ResourceBudget
      ): Promise<LearningSession> => {
        const now = Date.now();
        const sessionId = `acad_indep_${now}_${hashKey(topic).slice(0, 6)}`;
        const session: LearningSession = {
          id: sessionId,
          startedAt: now,
          updatedAt: now,
          mode: 'independent',
          topic,
          source: 'academy',
          candidates: [],
          status: 'active',
          resumeToken: `resume_${sessionId}`,
          apiCallsUsed: Math.min(0, budget.maxApiCalls),
        };
        this.store.saveSession(session);
        return session;
      },

      submitPracticeResult: async (
        sessionId: string,
        result: PracticeResult
      ): Promise<LearningOutcome> => {
        const outcome = emptyOutcome(sessionId);
        this.learningToLearn.trackAttempt(
          'practice',
          'academy',
          result.passed,
          result.conceptId,
          this.store
        );

        if (result.skillId) {
          const updated = this.skillAcquisition.addValidationEvidence(
            result.skillId,
            {
              type: 'test_pass',
              description: `Practice score ${result.score}`,
              timestamp: result.timestamp,
              passed: result.passed,
            },
            this.store
          );
          if (updated) outcome.skillsUpdated.push(updated.id);
        }

        if (result.passed) {
          outcome.validatedItems.push(result.conceptId);
        } else {
          outcome.failedAssessments.push(result.conceptId);
          outcome.remainingGaps.push(...result.mistakes);
        }
        return outcome;
      },

      submitAssessmentResult: async (
        sessionId: string,
        result: AssessmentResult
      ): Promise<LearningOutcome> => {
        const outcome = emptyOutcome(sessionId);
        for (const cid of result.conceptIds) {
          this.learningToLearn.trackAttempt(
            'assessment',
            'academy',
            result.passed,
            cid,
            this.store
          );
          const concept = this.store.getConcept(cid);
          if (concept && result.passed) {
            concept.verificationStatus = 'fact';
            concept.confidence = Math.min(1, concept.confidence + 0.1);
            concept.updatedAt = Date.now();
            this.store.saveConcept(concept);
            outcome.validatedItems.push(cid);
          } else if (!result.passed) {
            outcome.failedAssessments.push(cid);
          }
        }
        outcome.remainingGaps.push(...result.weakAreas);
        return outcome;
      },

      explainKnowledgeGap: async (
        conceptId: string
      ): Promise<GapExplanation> => {
        const concept = this.store.getConcept(conceptId);
        if (!concept) {
          return {
            conceptId,
            label: conceptId,
            missingPrerequisites: [],
            unresolvedContradictions: [],
            suggestedMaterials: [],
            explanation: `Concept "${conceptId}" is not yet in Krix's acquired knowledge.`,
          };
        }
        const unresolved = concept.contradictions
          .filter((c) => !c.resolved)
          .map((c) => c.description);
        return {
          conceptId: concept.id,
          label: concept.label,
          missingPrerequisites: concept.knowledgeGaps,
          unresolvedContradictions: unresolved,
          suggestedMaterials: concept.knowledgeGaps.map(
            (g) => `Review prerequisite: ${g}`
          ),
          explanation:
            concept.knowledgeGaps.length > 0 || unresolved.length > 0
              ? `"${concept.label}" has ${concept.knowledgeGaps.length} missing prerequisite(s) and ${unresolved.length} unresolved conflict(s).`
              : `"${concept.label}" has no detected prerequisite gaps (status: ${concept.verificationStatus}).`,
        };
      },

      submitCorrection: async (
        correction: UserCorrection
      ): Promise<StructuredCorrection> => {
        return this.processCorrection(
          correction.originalText,
          correction.correctionText,
          correction.context
        );
      },

      consolidateKnowledge: async (
        sessionId: string
      ): Promise<LearningOutcome> => {
        await this.drainQueueCycle();
        const session = this.store.getSession(sessionId);
        return session?.outcome ?? emptyOutcome(sessionId);
      },

      queryKnowledge: async (
        query: string,
        limit = 5
      ): Promise<AcquiredConcept[]> => {
        return this.retrieveRelevantKnowledge(query, limit);
      },

      querySkillMastery: async (
        skillId: string
      ): Promise<AcquiredSkill | null> => {
        return this.store.getSkill(skillId) ?? null;
      },

      resumeSession: async (sessionId: string): Promise<LearningSession> => {
        const existing = this.store.getSession(sessionId);
        if (!existing) {
          throw new Error(`Learning session "${sessionId}" not found`);
        }
        if (existing.status === 'paused') {
          existing.status = 'active';
          existing.updatedAt = Date.now();
          this.store.saveSession(existing);
        }
        return existing;
      },
    };
  }
}

function emptyOutcome(sessionId: string): LearningOutcome {
  return {
    sessionId,
    understood: [],
    conceptsAcquired: [],
    conceptsUpdated: [],
    conceptsRejected: [],
    skillsAcquired: [],
    skillsUpdated: [],
    conflicts: [],
    uncertainties: [],
    validatedItems: [],
    failedAssessments: [],
    remainingGaps: [],
    capabilityChanges: [],
  };
}

function mergeOutcomes(target: LearningOutcome, part: LearningOutcome): void {
  target.understood.push(...part.understood);
  target.conceptsAcquired.push(...part.conceptsAcquired);
  target.conceptsUpdated.push(...part.conceptsUpdated);
  target.conceptsRejected.push(...part.conceptsRejected);
  target.skillsAcquired.push(...part.skillsAcquired);
  target.skillsUpdated.push(...part.skillsUpdated);
  target.conflicts.push(...part.conflicts);
  target.uncertainties.push(...part.uncertainties);
  target.validatedItems.push(...part.validatedItems);
  target.failedAssessments.push(...part.failedAssessments);
  target.remainingGaps.push(...part.remainingGaps);
  target.capabilityChanges.push(...part.capabilityChanges);
}
