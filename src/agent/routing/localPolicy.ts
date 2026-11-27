/** Conservative eligibility policy for an optional 8 GB local model. */
import type { Classification } from './complexity';
import type { TaskRequirements } from './requirements';

const SENSITIVE_RE = /\b(?:password|passcode|secret|token|api[ _-]?key|credential|otp|bank|card)\b/i;

export function localModelEligible(text: string, classification: Classification, requirements: TaskRequirements): boolean {
  if (classification.tier !== 'TRIVIAL' && classification.tier !== 'SIMPLE') return false;
  if (text.trim().length > 600 || SENSITIVE_RE.test(text)) return false;
  return !requirements.vision && !requirements.toolUse && !requirements.deepReasoning &&
    !requirements.webReasoning && !requirements.coding && !requirements.minContextTokens;
}
