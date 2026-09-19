/**
 * specialistResult.ts
 *
 * Helpers for constructing and validating the universal SpecialistResult
 * structure specialists return to the Agent Core. Keeping this separate
 * from specialistTypes.ts keeps the pure schema file dependency-free while
 * this file can hold small runtime conveniences.
 */
import type { SpecialistResult, SpecialistStatus } from "./specialistTypes";
import { SPECIALIST_STATUSES } from "./specialistTypes";

/** Creates a well-formed empty result skeleton for a specialist to fill in. */
export function createEmptyResult(specialistId: string, status: SpecialistStatus): SpecialistResult {
  return {
    specialistId,
    status,
    summary: "",
    findings: [],
    recommendations: [],
    evidence: [],
    confidence: 0,
    uncertainties: [],
    requiredVerification: [],
    errors: [],
  };
}

/** Validates a SpecialistResult's shape. Returns a list of errors; empty = valid. */
export function validateSpecialistResult(result: Partial<SpecialistResult>): string[] {
  const errors: string[] = [];

  if (typeof result.specialistId !== "string" || !result.specialistId.trim()) {
    errors.push('Missing or empty "specialistId"');
  }

  if (!result.status || !SPECIALIST_STATUSES.includes(result.status)) {
    errors.push(`Invalid or missing "status": ${String(result.status)}`);
  }

  if (typeof result.summary !== "string") {
    errors.push('Missing "summary"');
  }

  if (!Array.isArray(result.findings)) {
    errors.push('"findings" must be an array');
  }

  if (!Array.isArray(result.recommendations)) {
    errors.push('"recommendations" must be an array');
  }

  if (!Array.isArray(result.evidence)) {
    errors.push('"evidence" must be an array');
  }

  if (
    typeof result.confidence !== "number" ||
    result.confidence < 0 ||
    result.confidence > 1 ||
    Number.isNaN(result.confidence)
  ) {
    errors.push('"confidence" must be a number between 0 and 1');
  }

  if (!Array.isArray(result.uncertainties)) {
    errors.push('"uncertainties" must be an array');
  }

  if (!Array.isArray(result.requiredVerification)) {
    errors.push('"requiredVerification" must be an array');
  }

  if (!Array.isArray(result.errors)) {
    errors.push('"errors" must be an array');
  }

  return errors;
}

/**
 * Convenience: does this result require the Agent Core to hold off on
 * treating it as final before further verification?
 */
export function requiresFurtherVerification(result: SpecialistResult): boolean {
  return (
    result.status === "UNCERTAIN" ||
    result.status === "REQUIRES_VERIFICATION" ||
    result.status === "PARTIAL" ||
    result.requiredVerification.length > 0
  );
}
