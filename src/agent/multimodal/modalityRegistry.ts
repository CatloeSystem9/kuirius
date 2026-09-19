/**
 * Modality registry (Phase 14, spec §5) — deterministic modality metadata.
 *
 * Encodes the per-modality base reliability (used by source prioritization),
 * default TTLs, and sensitivity defaults. Pure data + pure functions.
 */
import type { ModalityType, Sensitivity } from './multimodalTypes';

export interface ModalityDescriptor {
  type: ModalityType;
  /** Base reliability BEFORE freshness adjustments (spec §5 ordering). */
  basePriority: number;
  /** How quickly this kind of evidence goes stale (ms). */
  ttlMs: number;
  /** Default sensitivity classification. */
  defaultSensitivity: Sensitivity;
  /** Human-readable description for telemetry. */
  description: string;
}

/**
 * Source priority (spec §5):
 *   fresh direct tool state → fresh screen/browser observation →
 *   verified structured result → recent contextual info →
 *   learned/previous info → uncertain inference.
 */
export const MODALITY_REGISTRY: Record<ModalityType, ModalityDescriptor> = {
  tool_result: {
    type: 'tool_result',
    basePriority: 100,
    ttlMs: 60_000,
    defaultSensitivity: 'normal',
    description: 'Direct structured result from an executed tool (highest reliability when fresh)',
  },
  browser_state: {
    type: 'browser_state',
    basePriority: 90,
    ttlMs: 45_000,
    defaultSensitivity: 'normal',
    description: 'Browser-native page/tab state from the Browser Agent',
  },
  application_state: {
    type: 'application_state',
    basePriority: 90,
    ttlMs: 45_000,
    defaultSensitivity: 'normal',
    description: 'Application/process state from the Application Agent',
  },
  ui_state: {
    type: 'ui_state',
    basePriority: 80,
    ttlMs: 30_000,
    defaultSensitivity: 'normal',
    description: 'Structured screen state from Phase 4 vision (no pixels)',
  },
  screenshot: {
    type: 'screenshot',
    basePriority: 80,
    ttlMs: 30_000,
    defaultSensitivity: 'sensitive',
    description: 'Screen observation metadata (dimensions/provenance only — never pixels)',
  },
  document: {
    type: 'document',
    basePriority: 55,
    ttlMs: 10 * 60_000,
    defaultSensitivity: 'normal',
    description: 'Bounded chunked document content',
  },
  image: {
    type: 'image',
    basePriority: 50,
    ttlMs: 60_000,
    defaultSensitivity: 'sensitive',
    description: 'User-provided image metadata (dimensions/origin only)',
  },
  text: {
    type: 'text',
    basePriority: 60,
    ttlMs: 5 * 60_000,
    defaultSensitivity: 'normal',
    description: 'User or conversation text',
  },
  audio_transcript: {
    type: 'audio_transcript',
    basePriority: 40,
    ttlMs: 2 * 60_000,
    defaultSensitivity: 'sensitive',
    description: 'Transcribed speech (best-effort, may contain recognition errors)',
  },
};

export function describeModality(type: ModalityType): ModalityDescriptor {
  return MODALITY_REGISTRY[type];
}

export function isRegisteredModality(type: string): type is ModalityType {
  return Object.prototype.hasOwnProperty.call(MODALITY_REGISTRY, type);
}

/**
 * Freshness-adjusted priority: fresh evidence outranks old evidence of the
 * same modality; older-than-TTL evidence drops below fresher modalities.
 * Deterministic.
 */
export function effectivePriority(descriptor: ModalityDescriptor, ageMs: number, confidence: number): number {
  const ageFactor = Math.max(0, 1 - ageMs / descriptor.ttlMs);
  return descriptor.basePriority * (0.4 + 0.4 * ageFactor + 0.2 * confidence);
}
