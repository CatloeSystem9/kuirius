/**
 * Signal detection (Phase 15) — converts existing AgentEventBus events into
 * structured, bounded, deduplicated ProactiveSignals. Purely event-driven:
 * `ingest` is called from bus handlers; nothing polls.
 */
import type { AgentEvent } from '../events';
import {
  DEFAULT_SIGNAL_TTL_MS,
  type ProactiveEvidence,
  type ProactiveSignal,
  type ProactiveSignalType,
} from './proactiveTypes';

let seq = 0;
function nextId(prefix: string, now: number): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${now.toString(36)}-${seq.toString(36)}`;
}

/** Stable short hash for dedup keys (FNV-1a, deterministic). */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Metadata values must be small primitives — never objects/blobs. */
function safeMeta(meta: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === 'string') out[k] = String(v).slice(0, 120);
    else if (t === 'number' && Number.isFinite(v)) out[k] = v as number;
    else if (t === 'boolean') out[k] = v as boolean;
  }
  return out;
}

function ev(
  type: ProactiveSignalType,
  dedupKey: string,
  now: number,
  importance: number,
  urgency: number,
  confidence: number,
  evidence: ProactiveEvidence[],
  metadata: Record<string, unknown> = {},
  taskId?: string,
  ttlMs = DEFAULT_SIGNAL_TTL_MS
): ProactiveSignal {
  return {
    id: nextId('sig', now),
    type,
    dedupKey: `${type}:${dedupKey}`,
    taskId,
    timestamp: now,
    expiresAt: now + ttlMs,
    confidence,
    importance: Math.max(0, Math.min(1, importance)),
    urgency: Math.max(0, Math.min(1, urgency)),
    evidence,
    metadata: safeMeta(metadata),
  };
}

function quote(source: string, text: string, now: number, confidence: number): ProactiveEvidence {
  return { source, quote: text.slice(0, 160), timestamp: now, confidence };
}

/**
 * Signal detector with dedup. The same entity firing repeatedly inside the
 * dedup window REFRESHES the existing signal (new timestamp/TTL, evidence
 * appended, bounded) instead of creating duplicates.
 */
export class SignalDetector {
  private signals = new Map<string, ProactiveSignal>();
  private occurrences = new Map<string, number>();
  private readonly maxSignals = 50;

  constructor(
    private readonly dedupWindowMs = 5_000,
    private readonly maxEvidencePerSignal = 4
  ) {}

  /**
   * Convert a bus event into 0..1 signals. Returns [] when the event is not
   * proactive-relevant. Never throws.
   */
  ingest(event: AgentEvent, now: number): ProactiveSignal[] {
    const out: ProactiveSignal[] = [];
    const p = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.name) {
      case 'TASK_COMPLETED': {
        const stepCount = typeof p['stepCount'] === 'number' ? p['stepCount'] : 0;
        out.push(
          ev(
            'task_completed',
            `task:${event.taskId ?? 'unknown'}`,
            now,
            0.5,
            0.4,
            0.85,
            [quote('task', `task ${event.taskId ?? ''} completed (${stepCount} steps)`, now, 0.85)],
            { stepCount, taskId: event.taskId ?? '' },
            event.taskId
          )
        );
        break;
      }
      case 'TASK_FAILED': {
        const error = typeof p['error'] === 'string' ? p['error'] : 'unknown error';
        out.push(
          ev(
            'task_failed',
            `task:${event.taskId ?? 'unknown'}`,
            now,
            0.6,
            0.7,
            0.9,
            [quote('task', `task ${event.taskId ?? ''} failed: ${error}`, now, 0.9)],
            { error: error.slice(0, 120) },
            event.taskId
          )
        );
        break;
      }
      case 'TASK_CANCELLED': {
        const completed = typeof p['completedSteps'] === 'number' ? p['completedSteps'] : 0;
        if (completed > 0) {
          out.push(
            ev(
              'task_unfinished',
              `task:${event.taskId ?? 'unknown'}`,
              now,
              0.55,
              0.3,
              0.8,
              [quote('task', `task ${event.taskId ?? ''} cancelled with ${completed} completed steps`, now, 0.8)],
              { completedSteps: completed },
              event.taskId,
              10 * 60_000
            )
          );
        }
        break;
      }
      case 'TOOL_VERIFIED': {
        const verified = p['verified'] === true;
        out.push(
          ev(
            'verification_result',
            `verify:${event.stepId ?? event.taskId ?? 'unknown'}:${verified ? 'ok' : 'bad'}`,
            now,
            verified ? 0.4 : 0.7,
            verified ? 0.3 : 0.6,
            0.85,
            [quote('verification', verified ? 'verification succeeded' : 'verification FAILED', now, 0.85)],
            { verified, tool: typeof p['tool'] === 'string' ? p['tool'] : '' },
            event.taskId
          )
        );
        break;
      }
      case 'APP_LAUNCHED':
      case 'APP_CLOSED':
      case 'APP_STATE_CHANGED': {
        const app = typeof p['name'] === 'string' ? p['name'] : '';
        if (!app) break;
        out.push(
          ev(
            'app_state_changed',
            `app:${shortHash(app)}:${event.name}`,
            now,
            0.35,
            0.3,
            0.75,
            [quote('application', `${app} ${event.name === 'APP_LAUNCHED' ? 'launched' : event.name === 'APP_CLOSED' ? 'closed' : 'changed state'}`, now, 0.75)],
            { app, event: event.name },
            event.taskId
          )
        );
        break;
      }
      case 'BROWSER_NAVIGATED': {
        const url = typeof p['url'] === 'string' ? p['url'] : '';
        if (!url) break;
        out.push(
          ev(
            'browser_navigation',
            `nav:${shortHash(url)}`,
            now,
            0.3,
            0.3,
            0.7,
            [quote('browser', `navigated to ${url.slice(0, 80)}`, now, 0.7)],
            { host: safeHost(url) },
            event.taskId
          )
        );
        break;
      }
      case 'SCREEN_CHANGED': {
        const fraction = typeof p['changedFraction'] === 'number' ? p['changedFraction'] : 0;
        if (fraction < 0.2) break; // only significant changes are proactive-relevant
        out.push(
          ev(
            'screen_changed',
            'screen:significant',
            now,
            0.3,
            0.35,
            0.6,
            [quote('observation', `significant screen change (${Math.round(fraction * 100)}%)`, now, 0.6)],
            { changedFraction: fraction }
          )
        );
        break;
      }
      case 'USER_CORRECTION': {
        const text = typeof p['text'] === 'string' ? p['text'] : '';
        if (!text) break;
        out.push(
          ev(
            'repeated_correction',
            `correction:${shortHash(text.slice(0, 80).toLowerCase())}`,
            now,
            0.6,
            0.5,
            0.8,
            [quote('correction', text.slice(0, 120), now, 0.8)],
            {},
            event.taskId
          )
        );
        break;
      }
      case 'WORKFLOW_LEARNED': {
        const name = typeof p['name'] === 'string' ? p['name'] : '';
        out.push(
          ev(
            'workflow_pattern',
            `workflow:${shortHash(name || String(event.timestamp))}`,
            now,
            0.55,
            0.2,
            0.8,
            [quote('learning', `learned workflow ${name || event.taskId || ''}`.trim(), now, 0.8)],
            { name, workflowId: typeof p['workflowId'] === 'string' ? p['workflowId'] : '' },
            event.taskId,
            30 * 60_000
          )
        );
        break;
      }
      default:
        break;
    }

    for (const s of out) this.add(s);
    return out;
  }

  /** Explicit ingestion for deadline/preference/inactivity signals from other phases. */
  ingestSignal(signal: ProactiveSignal): ProactiveSignal {
    this.add(signal);
    return signal;
  }

  /** Build an inactivity signal (used by one-shot scheduled checks, not timers). */
  static inactivity(taskId: string, minutesIdle: number, now: number): ProactiveSignal {
    return ev(
      'inactivity',
      `idle:${taskId}`,
      now,
      0.45,
      0.35,
      0.6,
      [quote('activity', `no relevant activity for ~${minutesIdle}m after task ${taskId}`, now, 0.6)],
      { minutesIdle, taskId },
      taskId,
      10 * 60_000
    );
  }

  private add(signal: ProactiveSignal): void {
    // Bounded occurrence tracking: repeated signals of the same entity
    // (fresh or refreshed) accumulate so patterns like "same correction
    // repeated" stay detectable despite deduplication.
    this.occurrences.set(signal.dedupKey, (this.occurrences.get(signal.dedupKey) ?? 0) + 1);
    if (this.occurrences.size > 200) {
      const oldest = this.occurrences.keys().next().value;
      if (oldest !== undefined) this.occurrences.delete(oldest);
    }
    const existing = this.signals.get(signal.dedupKey);
    if (existing && signal.timestamp - existing.timestamp <= this.dedupWindowMs) {
      // Refresh, not duplicate.
      existing.timestamp = signal.timestamp;
      existing.expiresAt = signal.expiresAt;
      existing.confidence = Math.max(existing.confidence, signal.confidence);
      existing.importance = Math.max(existing.importance, signal.importance);
      existing.urgency = Math.max(existing.urgency, signal.urgency);
      for (const e of signal.evidence) {
        if (existing.evidence.length >= this.maxEvidencePerSignal) break;
        if (!existing.evidence.some((x) => x.quote === e.quote)) existing.evidence.push(e);
      }
      return;
    }
    this.signals.set(signal.dedupKey, signal);
    this.enforceBounds();
  }

  /** How many times a dedup key has been observed (fresh + refreshed). */
  occurrenceCount(dedupKey: string): number {
    return this.occurrences.get(dedupKey) ?? 0;
  }

  private enforceBounds(): void {
    if (this.signals.size <= this.maxSignals) return;
    const sorted = [...this.signals.values()].sort((a, b) => a.timestamp - b.timestamp);
    for (const s of sorted) {
      if (this.signals.size <= this.maxSignals) break;
      this.signals.delete(s.dedupKey);
    }
  }

  /** Live (non-expired) signals, newest first. */
  live(now: number): ProactiveSignal[] {
    this.sweep(now);
    return [...this.signals.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  byType(type: ProactiveSignalType, now: number): ProactiveSignal[] {
    return this.live(now).filter((s) => s.type === type);
  }

  sweep(now: number): number {
    let removed = 0;
    for (const [key, s] of this.signals) {
      if (s.expiresAt <= now) {
        this.signals.delete(key);
        removed++;
      }
    }
    return removed;
  }

  stats(now: number): { total: number; live: number } {
    return { total: this.signals.size, live: this.live(now).length };
  }

  clear(): void {
    this.signals.clear();
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.slice(0, 80);
  } catch {
    return url.slice(0, 60);
  }
}
