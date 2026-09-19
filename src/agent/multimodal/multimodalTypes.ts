/**
 * Multimodal Intelligence types (Phase 14).
 *
 * The multimodal layer combines text, screen/UI state, browser/application
 * state, documents, images, audio transcripts, and structured tool results
 * into ONE bounded, task-scoped context that the Agent Core can reason over.
 * It owns NO pixels (screenshots stay in the Phase 4 observer's snapshot
 * cache), performs no polling, and never bypasses permissions, Phase 11
 * recovery, Phase 12 workflow safety, or Phase 13 adaptive observation.
 */
import type { ScreenState } from '../vision/visionTypes';
import type { BrowserState } from '../browser/browserTypes';
import type { FsActionResult } from '../system/systemTypes';

/** Supported modality kinds (spec §1). */
export type ModalityType =
  | 'text'
  | 'image'
  | 'screenshot'
  | 'ui_state'
  | 'browser_state'
  | 'application_state'
  | 'document'
  | 'audio_transcript'
  | 'tool_result';

/** Privacy classification (spec §13). */
export type Sensitivity = 'public' | 'normal' | 'sensitive' | 'highly_sensitive';

/**
 * Normalized observation payload per modality. NOTE: image/screenshot
 * payloads never carry pixel data — only dimensions and provenance.
 */
export type ModalityPayload =
  | { type: 'text'; text: string }
  | { type: 'image'; width?: number; height?: number; origin: string }
  | { type: 'screenshot'; summary: ScreenSummary }
  | { type: 'ui_state'; summary: ScreenSummary }
  | { type: 'browser_state'; url: string; title: string; ready?: string; headings?: string[] }
  | { type: 'application_state'; name: string; running: boolean; pids?: number[]; focused?: boolean }
  | { type: 'document'; title: string; totalChars: number; chunkCount: number }
  | { type: 'audio_transcript'; transcript: string; language?: string }
  | { type: 'tool_result'; toolName: string; output: Record<string, unknown>; verified?: boolean };

/** Bounded screen summary extracted from a Phase 4 ScreenState (no pixels). */
export interface ScreenSummary {
  stateId: string;
  timestamp: number;
  activeWindowTitle?: string;
  texts: string[];
  buttons: string[];
  links: string[];
  dialogs: string[];
  errors: string[];
  loading?: boolean;
  confidence: number;
}

/** One normalized multimodal observation stored in the task context. */
export interface ModalityObservation {
  id: string;
  type: ModalityType;
  source: string;
  timestamp: number;
  expiresAt: number;
  confidence: number;
  sensitivity: Sensitivity;
  metadata: Record<string, unknown>;
  payload: ModalityPayload;
  /** Optional Agent Core step association (spec §3). */
  stepId?: string;
  /** Superseded by fresher evidence of the same aspect (kept for audit only). */
  superseded?: boolean;
}

/** Raw inputs accepted by the normalizer (spec §2). */
export type ModalityInput =
  | { type: 'text'; text: string; source?: string }
  | { type: 'image'; width?: number; height?: number; origin: string; source?: string }
  | { type: 'screenshot'; state: ScreenState; source?: string }
  | { type: 'ui_state'; state: ScreenState; source?: string }
  | { type: 'browser_state'; state: BrowserState; source?: string }
  | { type: 'browser_url'; url: string; title?: string; ready?: string; source?: string }
  | { type: 'application_state'; name: string; running: boolean; pids?: number[]; focused?: boolean; source?: string }
  | { type: 'document'; title: string; content: string; source?: string }
  | { type: 'audio_transcript'; transcript: string; language?: string; source?: string }
  | { type: 'tool_result'; toolName: string; output: Record<string, unknown>; verified?: boolean; source?: string };

/** Reference to one observation supporting (or conflicting with) a claim. */
export interface EvidenceRef {
  observationId: string;
  type: ModalityType;
  aspect: string;
  quote?: string;
  confidence: number;
}

/** Structured conflict between two observations (spec §6). */
export interface ModalityConflict {
  kind:
    | 'browser_url_mismatch'
    | 'application_presence_mismatch'
    | 'text_vs_evidence_mismatch'
    | 'stale_state_contradiction';
  description: string;
  sourceA: EvidenceRef;
  sourceB: EvidenceRef;
  /** Which side the deterministic priority prefers ('unresolved' → verify). */
  resolution: 'prefer_A' | 'prefer_B' | 'unresolved' | 'requires_verification';
}

/** A cross-modal conclusion with explicit uncertainty (spec §7). */
export interface MultimodalConclusion {
  claim: string;
  confidence: number;
  /** 0..1 — how much of the answer rests on missing/inconclusive evidence. */
  uncertainty: number;
  supporting: EvidenceRef[];
  conflicting: EvidenceRef[];
  /** Structured conflicts detected while reasoning (spec §6). */
  conflicts: ModalityConflict[];
  /** Explicit statements of incompleteness (spec §7). */
  uncertainties: Array<{ reason: string; needsKind?: ModalityType }>;
  /** Verifications that should run before acting on this conclusion. */
  requiredVerification: string[];
  requiresVerification: boolean;
  reasoning: string[];
  /** 'local' = deterministic; 'provider' = external model assisted. */
  reasoningSource?: 'local' | 'provider';
  /** Set when an external provider enriched the answer. */
  provider?: string;
}

/** A multimodal question routed through the reasoner (spec §4). */
export interface MultimodalQuestion {
  question: string;
  taskId?: string;
  stepId?: string;
  /** Force a fresh screen observation through Phase 13 before answering. */
  requireFreshScreen?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Provider abstraction (spec §15): future external multimodal models plug in
 * here. Providers receive a BOUNDED serialization (never pixels, never
 * sensitive data) and return null when they cannot answer — the deterministic
 * local result always remains the baseline.
 */
export interface ProviderReasoningInput {
  question: string;
  boundedContext: string;
  conclusion: MultimodalConclusion;
}

export interface MultimodalReasoningProvider {
  readonly id: string;
  reason(input: ProviderReasoningInput, signal?: AbortSignal): Promise<MultimodalConclusion | null>;
}

/** Verification request (spec §12). */
export interface VerificationRequest {
  expected: string;
  taskId?: string;
  requireFreshScreen?: boolean;
  signal?: AbortSignal;
}

/** Verification verdict (spec §12). */
export type VerificationVerdict = 'confirmed' | 'refuted' | 'uncertain';

/** Context statistics (diagnostics; bounded). */
export interface MultimodalContextStats {
  total: number;
  perKind: Record<string, number>;
  stale: number;
  stepAssociations: number;
  highlySensitive: number;
}

/** Resource limits (spec §14) — all bounded, task-scoped. */
export interface MultimodalLimits {
  maxObservations: number;
  totalCharBudget: number;
  maxPerModality: number;
  defaultTtlMs: number;
  documentChunkChars: number;
  maxDocumentChunks: number;
  providerInputCharCap: number;
}

export const DEFAULT_MULTIMODAL_LIMITS: MultimodalLimits = {
  maxObservations: 48,
  totalCharBudget: 24_000,
  maxPerModality: 12,
  defaultTtlMs: 5 * 60_000,
  documentChunkChars: 1_200,
  maxDocumentChunks: 24,
  providerInputCharCap: 6_000,
};
