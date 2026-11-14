/**
 * Activity feed (Action Transparency) — a tiny bounded store that turns REAL
 * agent-system events into short, understandable sentences for the live
 * activity stream above the composer.
 *
 * Rules implemented here (do not bypass in UI code):
 *  - Every sentence is derived from an actual event; nothing is invented.
 *  - A running activity stays visible (sticky) until its terminal event
 *    arrives, even if its start message would otherwise have expired.
 *  - Approval requests and important errors persist until dismissed/resolved.
 *  - Non-sticky entries fade after ~5 s.
 *  - A bounded session archive (separate from the visible stream) preserves
 *    recent actions for inspection; the authoritative audit record remains
 *    the server-side SafetyAuditLog.
 */
import type { AgentEvent, AgentEventBus } from '../agent/events';

export type ActivityKind = 'info' | 'success' | 'error' | 'approval' | 'running';

export interface ActivityEntry {
  id: number;
  text: string;
  kind: ActivityKind;
  at: number;
  /** Stays visible until resolved/dismissed (running actions, approvals, important errors). */
  sticky?: boolean;
  /** Key for sticky entries so terminal events can resolve them (e.g. taskId). */
  key?: string;
}

const FADE_MS = 5000; // visible ≈ 5 s, then fades
const EXIT_MS = 550; // matches the exit transition duration
const MAX_VISIBLE = 4;
const MAX_ARCHIVE = 300;
const DEDUPE_MS = 2000;
const TEXT_LIMIT = 90;

export interface ActivityFeed {
  push(text: string, kind?: ActivityKind, opts?: { sticky?: boolean; key?: string }): void;
  resolve(key: string): void;
  dismiss(id: number): void;
  subscribe(fn: (entries: ActivityEntry[], archive: ActivityEntry[]) => void): () => void;
  detachAll(): void;
}

export function createActivityFeed(): ActivityFeed {
  let nextId = 1;
  let visible: ActivityEntry[] = [];
  const archive: ActivityEntry[] = [];
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(entries: ActivityEntry[], archive: ActivityEntry[]) => void>();
  let lastText = '';
  let lastAt = 0;

  const emit = () => {
    for (const fn of Array.from(listeners)) {
      try {
        fn([...visible], [...archive]);
      } catch {
        // listener errors never break the feed
      }
    }
  };

  const archivePush = (entry: ActivityEntry) => {
    archive.push(entry);
    if (archive.length > MAX_ARCHIVE) archive.splice(0, archive.length - MAX_ARCHIVE);
  };

  const scheduleFade = (entry: ActivityEntry) => {
    if (entry.sticky) return;
    const timer = setTimeout(() => {
      timers.delete(entry.id);
      visible = visible.filter((e) => e.id !== entry.id);
      emit();
    }, FADE_MS);
    timers.set(entry.id, timer);
  };

  const push = (text: string, kind: ActivityKind = 'info', opts?: { sticky?: boolean; key?: string }) => {
    const clean = String(text ?? '').trim().slice(0, TEXT_LIMIT);
    if (!clean) return;
    const now = Date.now();
    // Coalesce identical consecutive messages (rapid bursts must not duplicate).
    if (clean === lastText && now - lastAt < DEDUPE_MS) return;
    lastText = clean;
    lastAt = now;

    // A sticky entry with the same key replaces the previous one (e.g. task restart).
    if (opts?.key && opts.sticky) {
      visible = visible.filter((e) => !(e.key === opts.key && e.sticky));
    }

    const entry: ActivityEntry = { id: nextId++, text: clean, kind, at: now, sticky: opts?.sticky, key: opts?.key };
    visible = [...visible, entry];
    archivePush(entry);

    // Bound the visible stream; drop the oldest non-sticky entry when full.
    if (visible.length > MAX_VISIBLE) {
      const oldest = visible.find((e) => !e.sticky);
      if (oldest) {
        const t = timers.get(oldest.id);
        if (t) {
          clearTimeout(t);
          timers.delete(oldest.id);
        }
        visible = visible.filter((e) => e.id !== oldest.id);
      } else {
        visible = visible.slice(visible.length - MAX_VISIBLE);
      }
    }

    scheduleFade(entry);
    emit();
  };

  const resolve = (key: string) => {
    const before = visible.length;
    visible = visible.filter((e) => !(e.key === key && e.sticky));
    if (visible.length !== before) emit();
  };

  const dismiss = (id: number) => {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
    visible = visible.filter((e) => e.id !== id);
    emit();
  };

  const detachAll = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    listeners.clear();
    visible = [];
  };

  return { push, resolve, dismiss, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, detachAll };
}

const truncate = (s: unknown, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/**
 * Attach the feed to the agent system's REAL event bus. Every mapping below
 * corresponds to an event the subsystems actually emit — no invented activity.
 * Returns a detach function.
 */
export function attachActivityFeedToSystem(feed: ActivityFeed, bus: AgentEventBus): () => void {
  const detachments: Array<() => void> = [];
  const on = (name: AgentEvent['name'], fn: (event: AgentEvent) => void) => {
    detachments.push(bus.on(name, fn));
  };

  // Task lifecycle — the single executor's real transitions.
  on('TASK_STARTED', (e) => {
    const goal = (e.payload as any)?.goal?.description;
    feed.push(`Working on: ${truncate(goal || 'your request', 72)}`, 'running', { sticky: true, key: `task:${e.taskId}` });
  });
  on('TASK_RESUMED', (e) => {
    const goal = (e.payload as any)?.goal?.description;
    feed.push(`Resuming: ${truncate(goal || 'task', 72)}`, 'running', { sticky: true, key: `task:${e.taskId}` });
  });
  on('TASK_PLANNED', (e) => {
    const steps = (e.payload as any)?.steps;
    feed.push(Array.isArray(steps) ? `Planned ${steps.length} step${steps.length === 1 ? '' : 's'}.` : 'Planning the steps…');
  });
  on('TASK_STEP_STARTED', (e) => {
    const desc = (e.payload as any)?.description;
    feed.push(`${truncate(desc || 'Working on a step', 70)}…`);
  });
  on('TASK_STEP_COMPLETED', (e) => {
    const desc = (e.payload as any)?.description;
    const uncertain = (e.payload as any)?.uncertain === true;
    feed.push(uncertain ? `Done, but needs checking: ${truncate(desc, 60)}` : `Done: ${truncate(desc, 64)}`, 'success');
  });
  on('TASK_STEP_SKIPPED', (e) => {
    const reason = (e.payload as any)?.reason;
    feed.push(`Skipped a step${reason ? ` — ${truncate(reason, 60)}` : ''}.`);
  });
  on('TASK_STEP_FAILED', (e) => {
    feed.push(`A step failed: ${truncate((e.payload as any)?.error, 66)}`, 'error');
  });
  on('TASK_COMPLETED', (e) => {
    if (e.taskId) feed.resolve(`task:${e.taskId}`);
    const verification = (e.payload as any)?.verification;
    feed.push(verification === 'uncertain' ? 'Task finished — some evidence was incomplete.' : 'Task completed.', verification === 'uncertain' ? 'info' : 'success');
  });
  on('TASK_FAILED', (e) => {
    if (e.taskId) feed.resolve(`task:${e.taskId}`);
    feed.push(`Task failed: ${truncate((e.payload as any)?.error, 66)}`, 'error', { sticky: true, key: `fail:${e.taskId}` });
  });
  on('TASK_CANCELLED', (e) => {
    if (e.taskId) feed.resolve(`task:${e.taskId}`);
    feed.push('Task stopped.');
  });

  // Safety — real gate decisions and stop transitions.
  on('SAFE_STOP_TRIGGERED', (e) => {
    feed.push(`Safety stop: ${truncate((e.payload as any)?.reason, 66)}`, 'error');
  });
  on('TOOL_FAILED', (e) => {
    const err = String((e.payload as any)?.error ?? '');
    const tool = (e.payload as any)?.tool;
    if (/require_confirmation/i.test(err)) {
      feed.push(`Confirmation needed: ${truncate(tool, 40)}`, 'approval', { sticky: true, key: `approval:${e.taskId}:${tool}` });
    }
  });

  // Screen vision — real observations (coalesced by the feed's dedupe).
  on('SCREEN_OBSERVED', () => {
    feed.push('Looked at the screen.');
  });

  // Research lifecycle.
  on('RESEARCH_STARTED', () => feed.push('Starting research…', 'running', { sticky: true, key: 'research:run' }));
  on('RESEARCH_COMPLETED', () => {
    feed.resolve('research:run');
    feed.push('Research completed.', 'success');
  });
  on('RESEARCH_FAILED', () => {
    feed.resolve('research:run');
    feed.push('Research failed.', 'error');
  });
  on('RESEARCH_INSUFFICIENT_EVIDENCE', () => {
    feed.resolve('research:run');
    feed.push('Research finished with too little evidence.', 'info');
  });

  // Goal continuity.
  on('GOAL_RESUMPTION_BRIEFED', () => feed.push('Brought back what we were working towards.'));

  return () => {
    for (const d of detachments) d();
    detachments.length = 0;
  };
}
