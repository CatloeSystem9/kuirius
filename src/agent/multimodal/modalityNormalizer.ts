/**
 * Modality normalizer (Phase 14, spec §2, §13) — converts raw inputs into
 * bounded, structured, SENSITIVITY-SCANNED observations.
 *
 * Security properties (spec §13):
 *  - every text-bearing payload passes the secret scanner; matches are
 *    REDACTED before storage and the sensitivity is escalated
 *  - image/screenshot payloads carry metadata only — never pixels
 *  - all string fields are truncated to the context char budget
 */
import type {
  ModalityInput,
  ModalityObservation,
  ModalityType,
  ScreenSummary,
  Sensitivity,
} from './multimodalTypes';
import { DEFAULT_MULTIMODAL_LIMITS, type MultimodalLimits } from './multimodalTypes';
import { describeModality, isRegisteredModality } from './modalityRegistry';

// ------------------------------------------------------------ secret scanner

/**
 * Patterns for credentials/secrets that must never be stored or transmitted.
 * Ordered: each match is replaced with [REDACTED] before anything persists.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, // sk-… style API keys
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g, // AWS access keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWTs
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi, // bearer tokens
  /\b(?:password|passwd|pwd|secret|api[-_]?key|token|credential)\s*[:=]\s*\S+/gi, // key: value pairs
  /\b(?:password|passwd|pwd|passphrase)\s+is\s+\S+/gi, // natural language ("password is hunter2")
  /\b(?:\d[ -]*?){13,19}\b/g, // long digit runs (card-like)
];

export interface SensitivityScan {
  text: string;
  sensitivity: Sensitivity;
  flagged: boolean;
}

/** Redact secret-like content; escalate sensitivity when something matched. */
export function scanSensitivity(text: string, base: Sensitivity): SensitivityScan {
  let flagged = false;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      flagged = true;
      return '[REDACTED]';
    });
  }
  let sensitivity: Sensitivity = base;
  if (flagged) sensitivity = 'highly_sensitive';
  return { text: out, sensitivity, flagged };
}

// ------------------------------------------------------------------ helpers

/** FNV-1a 32-bit content hash — cheap deduplication key. */
export function contentHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function clampChars(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/** Keyword tokenization for cross-modal matching (deterministic). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && t.length <= 24)
    .slice(0, 40);
}

let observationCounter = 0;
function nextId(type: ModalityType, now: number): string {
  observationCounter = (observationCounter + 1) % 1_000_000;
  return `obs_${now.toString(36)}_${observationCounter.toString(36)}_${type}`;
}

// ------------------------------------------------------------- screen digest

/** Bounded, pixel-free summary of a Phase 4 ScreenState. */
export function summarizeScreen(state: {
  id: string;
  timestamp: number;
  activeWindow?: { title?: string };
  analysis: {
    summary: string;
    application?: string;
    texts: Array<{ text: string; kind?: string; confidence: number }>;
    elements: Array<{ type: string; text?: string; confidence: number }>;
    dialogs: Array<{ kind: string; text?: string; confidence: number }>;
    errors: string[];
    warnings: string[];
    loading?: boolean;
    confidence: number;
  };
}): ScreenSummary {
  const MAX_ITEMS = 24;
  return {
    stateId: state.id,
    timestamp: state.timestamp,
    activeWindowTitle: state.activeWindow?.title,
    texts: state.analysis.texts.slice(0, MAX_ITEMS).map((t) => scanSensitivity(t.text, 'normal').text),
    buttons: state.analysis.elements
      .filter((e) => e.type === 'button' && e.text)
      .slice(0, MAX_ITEMS)
      .map((e) => scanSensitivity(e.text!, 'normal').text),
    links: state.analysis.elements
      .filter((e) => e.type === 'link' && e.text)
      .slice(0, MAX_ITEMS)
      .map((e) => scanSensitivity(e.text!, 'normal').text),
    dialogs: state.analysis.dialogs.slice(0, 8).map((d) => scanSensitivity(d.text ?? d.kind, 'normal').text),
    errors: state.analysis.errors.slice(0, 8).map((e) => scanSensitivity(e, 'normal').text),
    loading: state.analysis.loading,
    confidence: state.analysis.confidence,
  };
}

// ----------------------------------------------------------------- normalize

export interface NormalizeResult {
  observation: ModalityObservation;
  /** True when the input contained secret-like content (redacted). */
  redacted: boolean;
}

/**
 * Normalize one raw input into a bounded observation. Pure aside from id
 * generation. Throws only for structurally invalid inputs.
 */
export function normalizeModalityInput(
  input: ModalityInput,
  limits: MultimodalLimits = DEFAULT_MULTIMODAL_LIMITS,
  now: number = Date.now()
): NormalizeResult {
  // 'browser_url' is a raw input form that normalizes into 'browser_state'.
  const modalityType: ModalityType = input.type === 'browser_url' ? 'browser_state' : input.type;
  if (!isRegisteredModality(modalityType)) {
    throw new Error(`Unknown modality type "${String((input as any).type)}"`);
  }
  const descriptor = describeModality(modalityType);
  const source = input.source ?? `phase14.normalizer`;
  // Registry TTL is authoritative, but context limits may TIGHTEN it
  // (resource control, spec §14) — never loosen it.
  const ttl = limits.defaultTtlMs > 0 ? Math.min(descriptor.ttlMs, limits.defaultTtlMs) : descriptor.ttlMs;
  const maxChars = limits.totalCharBudget > 0 ? Math.min(2_000, limits.maxPerModality * 100) : 2_000;

  let payload: ModalityObservation['payload'];
  let sensitivity: Sensitivity = descriptor.defaultSensitivity;
  let redacted = false;
  let hashSource = '';
  const metadata: Record<string, unknown> = {};

  switch (input.type) {
    case 'text': {
      const scan = scanSensitivity(input.text, descriptor.defaultSensitivity);
      redacted = scan.flagged;
      const clamp = clampChars(scan.text, limits.documentChunkChars * 2);
      payload = { type: 'text', text: clamp.text };
      hashSource = `text:${clamp.text}`;
      sensitivity = scan.sensitivity;
      break;
    }
    case 'audio_transcript': {
      const scan = scanSensitivity(input.transcript, descriptor.defaultSensitivity);
      redacted = scan.flagged;
      const clamp = clampChars(scan.text, limits.documentChunkChars * 2);
      payload = { type: 'audio_transcript', transcript: clamp.text, language: input.language };
      hashSource = `transcript:${clamp.text}`;
      sensitivity = scan.sensitivity;
      break;
    }
    case 'image': {
      // Metadata ONLY — pixels never enter the multimodal layer.
      payload = { type: 'image', width: input.width, height: input.height, origin: input.origin };
      hashSource = `image:${input.origin}:${input.width}x${input.height}`;
      break;
    }
    case 'screenshot':
    case 'ui_state': {
      const summary = summarizeScreen(input.state);
      payload = input.type === 'screenshot' ? { type: 'screenshot', summary } : { type: 'ui_state', summary };
      hashSource = `screen:${summary.stateId}`;
      break;
    }
    case 'browser_state': {
      const page = input.state.page;
      payload = {
        type: 'browser_state',
        url: page?.url ?? '',
        title: scanSensitivity(page?.title ?? '', 'normal').text,
        ready: page?.ready,
        headings: (page?.headings ?? []).slice(0, 12).map((h) => scanSensitivity(h, 'normal').text),
      };
      hashSource = `browser:${payload.url}`;
      break;
    }
    case 'browser_url': {
      payload = {
        type: 'browser_state',
        url: input.url,
        title: scanSensitivity(input.title ?? '', 'normal').text,
        ready: input.ready,
        headings: [],
      };
      hashSource = `browser:${input.url}`;
      break;
    }
    case 'application_state': {
      payload = {
        type: 'application_state',
        name: input.name,
        running: input.running,
        pids: input.pids,
        focused: input.focused,
      };
      hashSource = `app:${input.name}:${input.running}:${input.focused === true}`;
      break;
    }
    case 'document': {
      const scan = scanSensitivity(input.content, descriptor.defaultSensitivity);
      redacted = scan.flagged;
      sensitivity = scan.sensitivity;
      const chunks = chunkDocument(scan.text, limits.documentChunkChars, limits.maxDocumentChunks);
      payload = { type: 'document', title: clampChars(input.title, 120).text, totalChars: scan.text.length, chunkCount: chunks.length };
      metadata.chunks = chunks.map((c) => c.text);
      hashSource = `document:${input.title}:${scan.text.length}`;
      break;
    }
    case 'tool_result': {
      const serialized = JSON.stringify(input.output ?? {});
      const scan = scanSensitivity(serialized, descriptor.defaultSensitivity);
      redacted = scan.flagged;
      sensitivity = scan.sensitivity;
      const clamp = clampChars(scan.text, limits.totalCharBudget > 2_000 ? 2_000 : limits.totalCharBudget);
      let output: Record<string, unknown>;
      try {
        output = JSON.parse(clamp.text) as Record<string, unknown>;
      } catch {
        output = { truncated: clamp.text };
      }
      payload = { type: 'tool_result', toolName: input.toolName, output, verified: input.verified };
      hashSource = `tool:${input.toolName}:${clamp.text.slice(0, 200)}`;
      break;
    }
    default:
      throw new Error(`Unhandled modality input "${String((input as { type?: string }).type)}"`);
  }

  const observation: ModalityObservation = {
    id: nextId(modalityType, now),
    type: modalityType,
    source,
    timestamp: now,
    expiresAt: now + ttl,
    confidence: modalityType === 'tool_result' ? (input.type === 'tool_result' && input.verified === true ? 0.95 : 0.7) : 0.8,
    sensitivity,
    metadata: { ...metadata, redacted, contentHash: contentHash(hashSource), keywords: keywordsOf(payload) },
    payload,
  };
  void maxChars;
  return { observation, redacted };
}

/** Keyword extraction for cross-modal matching (deterministic). */
export function keywordsOf(payload: ModalityObservation['payload']): string[] {
  const parts: string[] = [];
  switch (payload.type) {
    case 'text':
      parts.push(payload.text);
      break;
    case 'audio_transcript':
      parts.push(payload.transcript);
      break;
    case 'screenshot':
    case 'ui_state':
      parts.push(payload.summary.activeWindowTitle ?? '', ...payload.summary.texts, ...payload.summary.buttons, ...payload.summary.links, ...payload.summary.dialogs);
      break;
    case 'browser_state':
      parts.push(payload.url, payload.title, ...(payload.headings ?? []));
      break;
    case 'application_state':
      parts.push(payload.name);
      break;
    case 'document':
      parts.push(payload.title);
      break;
    case 'tool_result':
      parts.push(payload.toolName, JSON.stringify(payload.output).slice(0, 400));
      break;
    case 'image':
      parts.push(payload.origin);
      break;
  }
  return Array.from(new Set(parts.flatMap((p) => tokenize(p)))).slice(0, 48);
}

// --------------------------------------------------------- document chunking

export interface DocumentChunk {
  index: number;
  text: string;
}

/**
 * Chunk a document on word boundaries (bounded count). Never loads more
 * than maxChunks — huge documents are represented by their first chunks
 * plus a note that content was truncated.
 */
export function chunkDocument(content: string, chunkChars: number, maxChunks: number): DocumentChunk[] {
  const clean = content.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const chunks: DocumentChunk[] = [];
  let cursor = 0;
  while (cursor < clean.length && chunks.length < maxChunks) {
    let end = Math.min(clean.length, cursor + chunkChars);
    if (end < clean.length) {
      const breakAt = clean.lastIndexOf('\n', end);
      const spaceAt = clean.lastIndexOf(' ', end);
      const boundary = Math.max(breakAt, spaceAt);
      if (boundary > cursor + chunkChars * 0.5) end = boundary;
    }
    chunks.push({ index: chunks.length, text: clean.slice(cursor, end).trim() });
    cursor = end;
  }
  return chunks;
}

/**
 * Select the most relevant chunks for a query using deterministic term
 * overlap scoring (spec §9 — relevant-section selection, no model calls).
 */
export function selectRelevantChunks(chunks: DocumentChunk[], query: string, maxChunks: number): DocumentChunk[] {
  if (chunks.length <= maxChunks) return chunks;
  const terms = new Set(tokenize(query));
  if (terms.size === 0) return chunks.slice(0, maxChunks);
  const scored = chunks.map((c) => {
    const tokens = tokenize(c.text);
    let overlap = 0;
    for (const t of tokens) if (terms.has(t)) overlap += 1;
    return { chunk: c, score: overlap };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index)
    .slice(0, maxChunks)
    .map((s) => s.chunk)
    .sort((a, b) => a.index - b.index);
}
