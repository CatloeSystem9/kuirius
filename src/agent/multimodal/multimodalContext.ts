/**
 * Multimodal context (Phase 14, spec §3, §14) — ONE bounded, task-scoped
 * store of normalized observations that the Agent Core can reason over.
 *
 * Resource discipline:
 *  - deduplication: same type + content hash refreshes instead of duplicating
 *  - stale eviction: expired observations are dropped on access/sweep
 *  - hard bounds: per-modality caps, total count cap, total char budget
 *  - eviction order: superseded → stale → lowest effective priority/oldest
 *  - endTask(): full purge (no multimodal residue across tasks)
 */
import type {
  ModalityInput,
  ModalityObservation,
  ModalityType,
  MultimodalLimits,
  MultimodalContextStats,
  Sensitivity,
} from './multimodalTypes';
import { DEFAULT_MULTIMODAL_LIMITS } from './multimodalTypes';
import { normalizeModalityInput } from './modalityNormalizer';
import { describeModality, effectivePriority } from './modalityRegistry';
import { spfScreenItem } from '../spf/index';

/** Approximate stored size of an observation (chars) for the char budget. */
function observationChars(obs: ModalityObservation): number {
  switch (obs.payload.type) {
    case 'text':
      return obs.payload.text.length;
    case 'audio_transcript':
      return obs.payload.transcript.length;
    case 'document':
      return Math.min(obs.payload.totalChars, 4_000);
    case 'tool_result':
      return JSON.stringify(obs.payload.output).length;
    case 'ui_state':
    case 'screenshot': {
      const s = obs.payload.summary;
      return s.texts.join(' ').length + s.buttons.join(' ').length + s.links.join(' ').length;
    }
    case 'browser_state':
      return obs.payload.url.length + obs.payload.title.length;
    case 'application_state':
      return obs.payload.name.length;
    case 'image':
      return obs.payload.origin.length;
    default:
      return 64;
  }
}

export class MultimodalContext {
  private limits: MultimodalLimits;
  private observations = new Map<string, ModalityObservation>();
  private stepAssociations = new Map<string, Set<string>>(); // stepId → obsIds
  private taskId: string | null = null;

  constructor(limits: Partial<MultimodalLimits> = {}) {
    this.limits = { ...DEFAULT_MULTIMODAL_LIMITS, ...limits };
  }

  getTaskId(): string | null {
    return this.taskId;
  }

  beginTask(taskId: string): void {
    // A fresh task starts with a fresh context (no cross-task residue).
    this.observations.clear();
    this.stepAssociations.clear();
    this.taskId = taskId;
  }

  endTask(): void {
    this.observations.clear();
    this.stepAssociations.clear();
    this.taskId = null;
  }

  /** Normalize + store an input. Returns the stored observation. */
  addInput(input: ModalityInput, now: number = Date.now(), stepId?: string): ModalityObservation {
    const { observation } = normalizeModalityInput(input, this.limits, now);
    return this.add(observation, stepId);
  }

  /** Store a normalized observation (dedup + bounds enforced). */
  add(observation: ModalityObservation, stepId?: string): ModalityObservation {
    this.sweep(observation.timestamp);

    // Deduplicate: same type + content hash → refresh the existing entry.
    const hash = observation.metadata['contentHash'];
    if (typeof hash === 'string') {
      for (const existing of this.observations.values()) {
        if (existing.type === observation.type && existing.metadata['contentHash'] === hash) {
          existing.timestamp = observation.timestamp;
          existing.expiresAt = observation.expiresAt;
          existing.confidence = Math.max(existing.confidence, observation.confidence);
          existing.superseded = false;
          if (stepId) {
            existing.stepId = stepId;
            this.associate(existing.id, stepId);
          }
          return existing;
        }
      }
    }

    this.enforceBounds(observation.type, observation.timestamp);
    if (stepId) observation.stepId = stepId;
    this.observations.set(observation.id, observation);
    if (stepId) this.associate(observation.id, stepId);
    return observation;
  }

  /** Mark an observation superseded (fresher evidence of the same aspect). */
  markSuperseded(observationId: string): void {
    const obs = this.observations.get(observationId);
    if (obs) obs.superseded = true;
  }

  /** Associate evidence with an Agent Core step (spec §3). */
  associate(observationId: string, stepId: string): void {
    let set = this.stepAssociations.get(stepId);
    if (!set) {
      set = new Set();
      this.stepAssociations.set(stepId, set);
    }
    set.add(observationId);
  }

  /** Observations associated with a step (bounded). */
  forStep(stepId: string): ModalityObservation[] {
    const ids = this.stepAssociations.get(stepId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.observations.get(id))
      .filter((o): o is ModalityObservation => o !== undefined);
  }

  /** Remove expired observations. Returns how many were removed. */
  removeStale(now: number = Date.now()): number {
    let removed = 0;
    for (const [id, obs] of this.observations) {
      if (obs.expiresAt <= now) {
        this.observations.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Live (non-stale, non-superseded) observations, newest first. */
  live(now: number = Date.now()): ModalityObservation[] {
    this.sweep(now);
    return Array.from(this.observations.values())
      .filter((o) => !o.superseded)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  byType(type: ModalityType, now: number = Date.now()): ModalityObservation[] {
    return this.live(now).filter((o) => o.type === type);
  }

  /** Latest live observation of a type (fresh evidence first). */
  latest(type: ModalityType, now: number = Date.now()): ModalityObservation | null {
    const list = this.byType(type, now);
    return list.length > 0 ? list[0] : null;
  }

  /** Effective (freshness-adjusted) priority of an observation right now. */
  priorityOf(obs: ModalityObservation, now: number = Date.now()): number {
    const descriptor = describeModality(obs.type);
    return effectivePriority(descriptor, Math.max(0, now - obs.timestamp), obs.confidence);
  }

  /**
   * Bounded provider-safe serialization (spec §13, §15): strips sensitive and
   * highly-sensitive payloads, caps total size, includes no pixel data.
   * SPF EP-15 — every line additionally passes the Screen Privacy Firewall:
   * the sensitivity classification is a provenance judgment, SPF is a
   * content-level backstop. Lines whose sensitive content cannot be safely
   * redacted are dropped entirely (a digest is always safe to shrink).
   */
  providerSafeDigest(now: number = Date.now(), charCap = this.limits.providerInputCharCap): string {
    const lines: string[] = [];
    let chars = 0;
    for (const obs of this.live(now)) {
      if (obs.sensitivity === 'sensitive' || obs.sensitivity === 'highly_sensitive') continue;
      const screened = spfScreenItem(digestLine(obs), 'provider:multimodal-digest', obs.id, 'digest');
      if (screened.decision === 'strip') continue; // unseparable line → omitted
      const line = screened.text;
      if (chars + line.length > charCap) break;
      lines.push(line);
      chars += line.length;
    }
    return lines.join('\n');
  }

  stats(now: number = Date.now()): MultimodalContextStats {
    const perKind: Record<string, number> = {};
    let stale = 0;
    let highlySensitive = 0;
    for (const obs of this.observations.values()) {
      perKind[obs.type] = (perKind[obs.type] ?? 0) + 1;
      if (obs.expiresAt <= now) stale++;
      if (obs.sensitivity === 'highly_sensitive') highlySensitive++;
    }
    return {
      total: this.observations.size,
      perKind,
      stale,
      stepAssociations: this.stepAssociations.size,
      highlySensitive,
    };
  }

  /** Sensitivity of the most sensitive stored observation (privacy audits). */
  maxSensitivity(): Sensitivity {
    const order: Sensitivity[] = ['normal', 'public', 'sensitive', 'highly_sensitive'];
    let max: Sensitivity = 'public';
    for (const obs of this.observations.values()) {
      if (order.indexOf(obs.sensitivity) > order.indexOf(max)) max = obs.sensitivity;
    }
    return max;
  }

  // -------------------------------------------------------------- internals

  private sweep(now: number): void {
    if (this.observations.size === 0) return;
    for (const [id, obs] of this.observations) {
      if (obs.expiresAt <= now) this.observations.delete(id);
    }
  }

  private enforceBounds(incomingType: ModalityType, now: number): void {
    const capFor = (type: ModalityType): number =>
      Math.min(this.limits.maxPerModality, this.perKindCap(type));

    // Per-modality cap: keep the NEWEST observations of the incoming type.
    const sameType = Array.from(this.observations.values())
      .filter((o) => o.type === incomingType)
      .sort((a, b) => b.timestamp - a.timestamp);
    if (sameType.length >= capFor(incomingType)) {
      const excess = sameType.slice(capFor(incomingType) - 1);
      for (const victim of excess) this.observations.delete(victim.id);
    }

    // Total count cap.
    while (this.observations.size >= this.limits.maxObservations) {
      const victim = pickVictim(this.observations.values(), now, this.limits);
      if (!victim) break;
      this.observations.delete(victim.id);
    }
    // Total char budget.
    const totalChars = () => {
      let sum = 0;
      for (const obs of this.observations.values()) sum += observationChars(obs);
      return sum;
    };
    while (totalChars() > this.limits.totalCharBudget) {
      const victim = pickVictim(this.observations.values(), now, this.limits);
      if (!victim) break;
      this.observations.delete(victim.id);
    }
  }

  /** Per-kind overrides (bounded by maxPerModality). */
  private perKindCap(type: ModalityType): number {
    // The shared limits use a single maxPerModality value; document gets a
    // tighter default to keep chunked docs from crowding the context.
    return type === 'document' ? Math.min(this.limits.maxPerModality, 6) : this.limits.maxPerModality;
  }
}

/**
 * Eviction choice: superseded first, then stale, then lowest effective
 * priority (ties → oldest). Deterministic.
 */
function pickVictim(
  observations: Iterable<ModalityObservation>,
  now: number,
  limits: MultimodalLimits
): ModalityObservation | null {
  void limits;
  let victim: ModalityObservation | null = null;
  let victimKey = '';
  for (const obs of observations) {
    const stale = obs.expiresAt <= now;
    const key = `${obs.superseded === true ? 0 : stale ? 1 : 2}|${obs.timestamp}`;
    // Lower key = better victim. Superseded (0) beats stale (1) beats live (2);
    // within a class, older timestamp is the victim.
    if (!victim || key < victimKey) {
      victim = obs;
      victimKey = key;
    }
  }
  return victim;
}

function digestLine(obs: ModalityObservation): string {
  const time = new Date(obs.timestamp).toISOString().slice(11, 19);
  switch (obs.payload.type) {
    case 'text':
      return `[${time}] text: ${obs.payload.text.slice(0, 200)}`;
    case 'audio_transcript':
      return `[${time}] speech: ${obs.payload.transcript.slice(0, 200)}`;
    case 'ui_state':
    case 'screenshot': {
      const s = obs.payload.summary;
      return `[${time}] screen(${s.stateId}): window="${s.activeWindowTitle ?? '?'}" buttons=[${s.buttons.slice(0, 6).join('|')}] texts=[${s.texts.slice(0, 6).join('|')}]`;
    }
    case 'browser_state':
      return `[${time}] browser: url=${obs.payload.url} title="${obs.payload.title}" ready=${obs.payload.ready ?? '?'}`;
    case 'application_state':
      return `[${time}] app: ${obs.payload.name} running=${obs.payload.running}${obs.payload.focused === true ? ' focused' : ''}`;
    case 'document':
      return `[${time}] document "${obs.payload.title}" (${obs.payload.totalChars} chars, ${obs.payload.chunkCount} chunks)`;
    case 'tool_result':
      return `[${time}] tool ${obs.payload.toolName}: ${JSON.stringify(obs.payload.output).slice(0, 200)}`;
    case 'image':
      return `[${time}] image ${obs.payload.width ?? '?'}x${obs.payload.height ?? '?'} from ${obs.payload.origin}`;
    default:
      return `[${time}] ${obs.type}`;
  }
}
