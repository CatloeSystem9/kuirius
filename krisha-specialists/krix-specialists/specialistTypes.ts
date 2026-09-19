/**
 * specialistTypes.ts
 *
 * Universal schema for a Krix specialist definition, plus the universal
 * structured result shape a specialist returns to the Agent Core.
 *
 * This file has ZERO runtime dependencies. It is pure TypeScript types
 * plus a couple of small validation helpers. It can be copied into the
 * Krix repository unchanged.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** How risky it is for the Agent Core to act on this specialist's output. */
export type RiskLevel = "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const RISK_LEVELS: readonly RiskLevel[] = [
  "SAFE",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;

/** The 10 top-level departments. Exactly 10 specialists belong to each. */
export type Department =
  | "productivity-execution"
  | "research-knowledge"
  | "computer-digital-operations"
  | "software-engineering"
  | "security-safety-quality"
  | "writing-communication"
  | "business-strategy"
  | "data-analytics"
  | "multimodal-reasoning"
  | "language-learning-support";

export const DEPARTMENTS: readonly Department[] = [
  "productivity-execution",
  "research-knowledge",
  "computer-digital-operations",
  "software-engineering",
  "security-safety-quality",
  "writing-communication",
  "business-strategy",
  "data-analytics",
  "multimodal-reasoning",
  "language-learning-support",
] as const;

/**
 * Generic capability names a specialist may request from Krix's future
 * Tool Registry. These are NOT implementations — a specialist listing
 * "browser" does not grant it browser access. See README section on
 * "Specialist vs Tool".
 */
export type ToolCapability =
  | "browser"
  | "filesystem"
  | "screen-vision"
  | "keyboard"
  | "mouse"
  | "code-execution"
  | "document-reader"
  | "web-search"
  | "data-analysis"
  | "spreadsheet-engine"
  | "image-analysis"
  | "video-analysis"
  | "clipboard"
  | "terminal"
  | "version-control"
  | "calendar"
  | "none";

/** Suggested class of model the task is well-suited to (future routing). */
export type ModelHint = "lightweight" | "standard" | "advanced" | "coding" | "vision";

// ---------------------------------------------------------------------------
// Specialist definition schema
// ---------------------------------------------------------------------------

export interface SpecialistDefinition {
  /** Unique, stable, kebab-case identifier. e.g. "web-research" */
  id: string;

  /** Human-readable name. e.g. "Web Research Specialist" */
  name: string;

  /** One of the 10 departments. */
  department: Department;

  /** One or two sentence explanation of what the specialist does. */
  description: string;

  /** The problem this specialist exists to solve. */
  purpose: string;

  /** 3-6 concrete responsibilities. */
  responsibilities: string[];

  /** Specific things it can reason about or assist with. */
  capabilities: string[];

  /** Plain-language description of when Krix should consider invoking it. */
  activationConditions: string;

  /** Keywords/tags used by the lightweight router for matching. */
  routingTags: string[];

  /** Expertise areas required to perform the role well. */
  requiredSkills: string[];

  /**
   * Generic tool capabilities this specialist would ideally use once
   * Krix supplies them. Never an implementation, never a guarantee
   * of access.
   */
  preferredTools: ToolCapability[];

  /** What information/context the specialist expects to be given. */
  expectedInput: string;

  /** What the specialist hands back to the Agent Core. */
  expectedOutput: string;

  /** Always structured; described here for documentation purposes. */
  outputFormat: "structured-json";

  /** How risky it is to act on this specialist's output without checks. */
  riskLevel: RiskLevel;

  /** How the Agent Core should verify this specialist's result. */
  verificationRequirements: string;

  /** Explicit statement of what this specialist must NOT claim to do. */
  limitations: string[];

  /** Optional hint for future model-routing. Not required for v1. */
  modelHint?: ModelHint;
}

// ---------------------------------------------------------------------------
// Universal specialist result schema
// ---------------------------------------------------------------------------

export type SpecialistStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "UNCERTAIN"
  | "FAILED"
  | "REQUIRES_VERIFICATION";

export const SPECIALIST_STATUSES: readonly SpecialistStatus[] = [
  "SUCCESS",
  "PARTIAL",
  "UNCERTAIN",
  "FAILED",
  "REQUIRES_VERIFICATION",
] as const;

export interface SpecialistFinding {
  /** Short label for this finding. */
  label: string;
  /** The finding itself. */
  detail: string;
  /** Optional supporting evidence reference (URL, file path, quote source). */
  source?: string;
}

export interface SpecialistResult {
  /** ID of the specialist that produced this result. */
  specialistId: string;

  /** Outcome status of the specialist's work. */
  status: SpecialistStatus;

  /** One-paragraph plain-language summary for the Agent Core / user. */
  summary: string;

  /** Structured list of individual findings. */
  findings: SpecialistFinding[];

  /** Concrete suggested next actions, if any. */
  recommendations: string[];

  /** Supporting evidence references (URLs, file paths, citations). */
  evidence: string[];

  /** Specialist's self-reported confidence, 0-1. */
  confidence: number;

  /** Known gaps, ambiguities, or assumptions made. */
  uncertainties: string[];

  /** What the Agent Core (or another specialist) must still verify. */
  requiredVerification: string[];

  /** Any errors encountered during the specialist's work. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Lightweight structural validation helpers
// ---------------------------------------------------------------------------

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidKebabCase(id: string): boolean {
  return KEBAB_CASE_RE.test(id);
}

const REQUIRED_STRING_FIELDS: (keyof SpecialistDefinition)[] = [
  "id",
  "name",
  "department",
  "description",
  "purpose",
  "activationConditions",
  "expectedInput",
  "expectedOutput",
  "verificationRequirements",
];

const REQUIRED_ARRAY_FIELDS: (keyof SpecialistDefinition)[] = [
  "responsibilities",
  "capabilities",
  "routingTags",
  "requiredSkills",
  "preferredTools",
  "limitations",
];

/**
 * Validates that a specialist definition satisfies the schema.
 * Returns a list of human-readable error strings; empty array = valid.
 */
export function validateSpecialistDefinition(def: Partial<SpecialistDefinition>): string[] {
  const errors: string[] = [];

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = def[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`Missing or empty required string field: "${String(field)}"`);
    }
  }

  for (const field of REQUIRED_ARRAY_FIELDS) {
    const value = def[field] as unknown;
    if (!Array.isArray(value) || value.length === 0) {
      errors.push(`Missing or empty required array field: "${String(field)}"`);
    }
  }

  if (def.id && !isValidKebabCase(def.id)) {
    errors.push(`ID "${def.id}" is not valid kebab-case`);
  }

  if (def.department && !DEPARTMENTS.includes(def.department)) {
    errors.push(`Department "${def.department}" is not a recognized department`);
  }

  if (def.riskLevel && !RISK_LEVELS.includes(def.riskLevel)) {
    errors.push(`Risk level "${def.riskLevel}" is not valid`);
  }

  if (def.outputFormat && def.outputFormat !== "structured-json") {
    errors.push(`Output format must be "structured-json"`);
  }

  if (
    def.responsibilities &&
    (def.responsibilities.length < 3 || def.responsibilities.length > 6)
  ) {
    errors.push(
      `Responsibilities must contain between 3 and 6 items (found ${def.responsibilities.length})`
    );
  }

  return errors;
}
