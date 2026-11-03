/**
 * Learned Skills v1 — deterministic skill validation.
 *
 * A candidate skill is saved ONLY when every structural, safety and
 * environment check passes. Validation is pure and local: no model calls,
 * no network, no side effects. Reuses the Phase 12 secret-detection helpers
 * so the two learning layers share exactly one definition of "secret-like".
 */
import type { ToolRegistry } from '../toolRegistry';
import { selectToolForCapability } from '../toolSelector';
import type { SkillStep, SkillValidation } from './skillTypes';
import { MAX_SKILL_STEPS } from './skillTypes';
import { SECRET_VALUE_RE } from '../learning/learningTypes';

export interface SkillDraftInput {
  goalPattern: string;
  expectedOutcome: string;
  steps: SkillStep[];
}

/** Find a step's tool: direct registry hit first, capability fallback second. */
export function resolveSkillTool(registry: ToolRegistry, step: SkillStep): ReturnType<ToolRegistry['get']> {
  const direct = registry.get(step.toolName);
  if (direct) return direct;
  if (step.capability) {
    const selection = selectToolForCapability(registry, step.capability);
    if (selection) return selection.tool;
  }
  return undefined;
}

function findSecretLike(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === 'string') return SECRET_VALUE_RE.test(value) ? value.slice(0, 12) : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSecretLike(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/password|passwd|secret|token|api[-_]?key|credential|otp|auth[-_]?code/i.test(key)) {
        // Redacted placeholders are fine; a live-looking value is not.
        const inner = findSecretLike(item, depth + 1);
        if (inner && item !== '[redacted]') return key;
        continue;
      }
      const hit = findSecretLike(item, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Validate a skill candidate. Returns a bounded SkillValidation; `errors`
 * non-empty means REJECT (the candidate is never persisted in that case).
 */
export function validateSkill(draft: SkillDraftInput, registry: ToolRegistry): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const now = Date.now();

  if (!draft.goalPattern || !draft.goalPattern.trim()) errors.push('missing goal pattern');
  if (!draft.expectedOutcome || !draft.expectedOutcome.trim()) errors.push('missing expected outcome');

  if (!Array.isArray(draft.steps) || draft.steps.length < 2) {
    errors.push(`needs at least 2 executable steps (got ${draft.steps?.length ?? 0})`);
  } else if (draft.steps.length > MAX_SKILL_STEPS) {
    errors.push(`too many steps (${draft.steps.length} > ${MAX_SKILL_STEPS})`);
  } else {
    draft.steps.forEach((step, index) => {
      const label = `step ${index + 1}`;
      if (!step || typeof step.toolName !== 'string' || !step.toolName) {
        errors.push(`${label}: missing tool name`);
        return;
      }
      if (step.toolName === 'system.note' || step.toolName === 'chat.report') {
        warnings.push(`${label}: conversational step "${step.toolName}" kept out of the executable skill`);
        return;
      }
      const tool = resolveSkillTool(registry, step);
      if (!tool) {
        errors.push(`${label}: tool "${step.toolName}" is not available in the registry`);
        return;
      }
      if (tool.riskLevel === 'high' || tool.riskLevel === 'critical') {
        errors.push(`${label}: high/critical-risk tool "${step.toolName}" may never be learned into a skill`);
        return;
      }
      const secret = findSecretLike(step.inputTemplate);
      if (secret) {
        errors.push(`${label}: secret-like value detected in step template (${secret}…)`);
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(step.inputTemplate ?? {});
      } catch {
        errors.push(`${label}: step template is not serializable`);
        return;
      }
      if (serialized.length > 4000) {
        errors.push(`${label}: step template too large (${serialized.length} chars)`);
      }
    });

    // Duplicate adjacent steps usually mean the run looped — not a clean skill.
    for (let i = 1; i < draft.steps.length; i++) {
      if (draft.steps[i].toolName === draft.steps[i - 1].toolName && JSON.stringify(draft.steps[i].inputTemplate) === JSON.stringify(draft.steps[i - 1].inputTemplate)) {
        warnings.push(`steps ${i} and ${i + 1} are identical — possible loop in the source run`);
      }
    }
  }

  return {
    status: errors.length === 0 ? 'validated' : 'rejected',
    errors: errors.slice(0, 8),
    warnings: warnings.slice(0, 8),
    checkedAt: now,
  };
}
