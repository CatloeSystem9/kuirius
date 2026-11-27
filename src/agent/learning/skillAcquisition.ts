/**
 * Skill Acquisition — separates declarative knowledge from executable skills.
 *
 * Pathway:
 *   Validated knowledge (AcquiredConcept IDs)
 *     → AcquiredSkill (starts ALWAYS as 'unverified')
 *     → Practical ValidationEvidence (task_success / test_pass)
 *     → 'tested' (>= 2 passing practical evidences)
 *     → 'proficient' (>= 4 passing evidences across >= 2 types)
 *     → 'expert' (ONLY with explicit user_confirmation)
 *
 * Never marks a skill verified merely from plausible explanation.
 * Preserves tool permission requirements so execution always passes through
 * existing ToolRegistry + SafetyGate boundaries.
 */
import { similarity } from '../memory/similarity';
import { hashKey } from '../routing/cache';
import type { LearningStore } from './learningStore';
import type { AcquiredSkill, ValidationEvidence } from './learningTypes';

export class SkillAcquisition {
  /**
   * Propose a new skill backed by acquired knowledge concepts.
   * Mastery status ALWAYS starts as 'unverified'.
   */
  proposeSkill(
    label: string,
    description: string,
    procedure: string,
    requiredKnowledge: string[],
    store: LearningStore,
    options: {
      requiredPermissions?: string[];
      knownLimitations?: string[];
    } = {}
  ): AcquiredSkill {
    const cleanLabel = label.trim();
    const id = `acq_skill_${hashKey(cleanLabel.toLowerCase())}`;
    const existing = store.getSkill(id);
    if (existing) {
      return existing;
    }

    const prerequisites = Array.from(
      new Set(
        requiredKnowledge.flatMap(
          (cid) => store.getConcept(cid)?.prerequisites ?? []
        )
      )
    );

    const now = Date.now();
    const skill: AcquiredSkill = {
      id,
      label: cleanLabel,
      description: description.trim(),
      prerequisites,
      requiredKnowledge: [...requiredKnowledge],
      requiredPermissions: options.requiredPermissions ?? [],
      procedure: procedure.trim(),
      validationEvidence: [],
      masteryStatus: 'unverified',
      version: 1,
      knownLimitations: options.knownLimitations ?? [],
      createdAt: now,
      updatedAt: now,
    };

    store.saveSkill(skill);
    return skill;
  }

  /**
   * Record practical test/task evidence for a skill and update mastery status
   * strictly according to verified evidence thresholds.
   */
  addValidationEvidence(
    skillId: string,
    evidence: ValidationEvidence,
    store: LearningStore
  ): AcquiredSkill | null {
    const skill = store.getSkill(skillId);
    if (!skill) return null;

    const nextEvidence = [...skill.validationEvidence, evidence].slice(-30);
    const passedPractical = nextEvidence.filter(
      (e) =>
        e.passed &&
        (e.type === 'task_success' ||
          e.type === 'test_pass' ||
          e.type === 'repeated_success')
    );
    const distinctTypes = new Set(passedPractical.map((e) => e.type));
    const hasUserConfirmation = nextEvidence.some(
      (e) => e.passed && e.type === 'user_confirmation'
    );

    let nextMastery: AcquiredSkill['masteryStatus'] = 'unverified';
    if (hasUserConfirmation && passedPractical.length >= 4) {
      nextMastery = 'expert';
    } else if (passedPractical.length >= 4 && distinctTypes.size >= 2) {
      nextMastery = 'proficient';
    } else if (passedPractical.length >= 2) {
      nextMastery = 'tested';
    }

    const updated: AcquiredSkill = {
      ...skill,
      validationEvidence: nextEvidence,
      masteryStatus: nextMastery,
      lastTestedAt: evidence.timestamp,
      updatedAt: Date.now(),
    };
    store.saveSkill(updated);
    return updated;
  }

  /**
   * Retrieve verified/tested skills applicable to the current context.
   * Unverified skills are never surfaced as proven capabilities.
   */
  findApplicableSkills(
    context: string,
    store: LearningStore,
    limit = 3
  ): AcquiredSkill[] {
    const query = context.trim();
    if (!query) return [];

    return store
      .getAllSkills()
      .filter((s) => s.masteryStatus !== 'unverified')
      .map((s) => ({
        skill: s,
        score: similarity(
          query,
          `${s.label} ${s.description} ${s.procedure}`
        ),
      }))
      .filter((item) => item.score >= 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.skill);
  }
}
