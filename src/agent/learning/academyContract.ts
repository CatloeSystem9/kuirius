/**
 * Academy Integration Contract — stable TypeScript interfaces for the future
 * Krix Academy.
 *
 * The Academy itself (curriculum, dashboard, UI) is NOT implemented here.
 * This contract defines the exact boundary between Krix's Learning Mechanism
 * and the future Academy.
 */
import type {
  AcquiredConcept,
  AcquiredSkill,
  LearningOutcome,
  LearningSession,
  StructuredCorrection,
} from './learningTypes';

export interface LessonMaterial {
  topic: string;
  content: string;
  difficulty?: number;
  prerequisites?: string[];
  sourceId?: string;
}

export interface GuidedSessionConfig {
  topic: string;
  lessons: LessonMaterial[];
  assessmentEnabled: boolean;
}

export interface ResourceBudget {
  maxApiCalls: number;
  maxDurationMs: number;
}

export interface PracticeResult {
  sessionId: string;
  conceptId: string;
  skillId?: string;
  score: number;
  passed: boolean;
  mistakes: string[];
  timestamp: number;
}

export interface AssessmentResult {
  sessionId: string;
  conceptIds: string[];
  passed: boolean;
  score: number;
  weakAreas: string[];
}

export interface GapExplanation {
  conceptId: string;
  label: string;
  missingPrerequisites: string[];
  unresolvedContradictions: string[];
  suggestedMaterials: string[];
  explanation: string;
}

export interface UserCorrection {
  originalText: string;
  correctionText: string;
  context: string;
  timestamp: number;
}

export interface AcademyLearningService {
  submitLesson(material: LessonMaterial): Promise<LearningOutcome>;
  startGuidedSession(config: GuidedSessionConfig): Promise<LearningSession>;
  startIndependentSession(
    topic: string,
    budget: ResourceBudget
  ): Promise<LearningSession>;
  submitPracticeResult(
    sessionId: string,
    result: PracticeResult
  ): Promise<LearningOutcome>;
  submitAssessmentResult(
    sessionId: string,
    result: AssessmentResult
  ): Promise<LearningOutcome>;
  explainKnowledgeGap(conceptId: string): Promise<GapExplanation>;
  submitCorrection(correction: UserCorrection): Promise<StructuredCorrection>;
  consolidateKnowledge(sessionId: string): Promise<LearningOutcome>;
  queryKnowledge(query: string, limit?: number): Promise<AcquiredConcept[]>;
  querySkillMastery(skillId: string): Promise<AcquiredSkill | null>;
  resumeSession(sessionId: string): Promise<LearningSession>;
}
