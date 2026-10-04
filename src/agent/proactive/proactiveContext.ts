/**
 * Proactive context (Phase 15) — bounded recent state: signals, decisions,
 * suggestions, per-category cooldown/rejection tracking, and approximate
 * user-activity classification derived from recent event history.
 * No continuous polling: state changes only when events/API calls arrive.
 */
import type { AgentEvent } from '../events';
import { shortHash } from './proactiveSignals';
import type {
  ActivityState,
  InterruptionBudgetConfig,
  ProactiveDecision,
  ProactiveOpportunity,
  ProactiveRiskCategory,
  ProactiveSuggestion,
} from './proactiveTypes';

const ACTIVITY_EVENT_WINDOW_MS = 4_000;
const IDLE_AFTER_MS = 60_000;
/** Events that indicate the user (or agent) is actively doing something. */
const ACTIVITY_EVENTS = new Set<AgentEvent['name']>([
  'USER_MESSAGE',
  'TASK_STARTED',
  'TASK_STEP_STARTED',
  'TOOL_INVOKED',
  'APP_LAUNCHED',
  'APP_CLOSED',
  'APP_STATE_CHANGED',
  'BROWSER_NAVIGATED',
  'KEYBOARD_ACTION_COMPLETED',
  'MOUSE_CLICK_COMPLETED',
  'CURSOR_MOVE_COMPLETED',
  'COMPUTER_ACTION_COMPLETED',
]);

const MAX_HISTORY = 50;

export interface RejectionRecord {
  category: ProactiveRiskCategory;
  dedupKey: string;
  at: number;
}

export class ProactiveContext {
  private signals: import('./proactiveTypes').ProactiveSignal[] = [];
  private decisions: ProactiveDecision[] = [];
  private suggestions: ProactiveSuggestion[] = [];
  private events: { name: AgentEvent['name']; at: number }[] = [];
  private categoryLastPresented = new Map<ProactiveRiskCategory, number>();
  private rejections: RejectionRecord[] = [];
  private activeTaskId: string | null = null;
  private activeTaskStartedAt = 0;

  constructor(public readonly budget: InterruptionBudgetConfig) {}

  // --- event history -------------------------------------------------------
  recordEvent(event: AgentEvent, now: number): void {
    this.events.push({ name: event.name, at: now });
    if (this.events.length > MAX_HISTORY) this.events.shift();
    if (event.name === 'TASK_STARTED' && event.taskId) {
      this.activeTaskId = event.taskId;
      this.activeTaskStartedAt = now;
    }
    if ((event.name === 'TASK_COMPLETED' || event.name === 'TASK_FAILED' || event.name === 'TASK_CANCELLED') && this.activeTaskId === event.taskId) {
      this.activeTaskId = null;
    }
  }

  // --- activity classification (deterministic, event-history based) --------
  activityState(now: number): ActivityState {
    // User-driven events define presence; system-generated events (workflow
    // learning, agent-side observations) must never make the user look
    // "active" — otherwise system events would suppress their own
    // informational suggestions.
    const recentActivity = this.events.some((e) => ACTIVITY_EVENTS.has(e.name) && now - e.at <= ACTIVITY_EVENT_WINDOW_MS);
    if (this.activeTaskId !== null) {
      // An agent task is mid-flight — treat as BUSY (never interrupt with
      // unrelated proactive suggestions during an active task).
      return 'BUSY';
    }
    if (recentActivity) return 'ACTIVE';
    const lastUserEventAt = [...this.events].reverse().find((e) => ACTIVITY_EVENTS.has(e.name))?.at ?? 0;
    if (lastUserEventAt === 0 || now - lastUserEventAt >= IDLE_AFTER_MS) return 'IDLE';
    return 'UNCERTAIN';
  }

  // --- suggestion bookkeeping ----------------------------------------------
  recordPresented(suggestion: ProactiveSuggestion, now: number): void {
    this.suggestions.push(suggestion);
    if (this.suggestions.length > MAX_HISTORY) this.suggestions.shift();
    this.categoryLastPresented.set(suggestion.category, now);
  }

  recordDecision(decision: ProactiveDecision): void {
    this.decisions.push(decision);
    if (this.decisions.length > MAX_HISTORY) this.decisions.shift();
  }

  recordRejection(suggestion: ProactiveSuggestion, now: number): RejectionRecord {
    const rec: RejectionRecord = { category: suggestion.category, dedupKey: suggestion.dedupKey, at: now };
    this.rejections.push(rec);
    if (this.rejections.length > MAX_HISTORY) this.rejections.shift();
    return rec;
  }

  /** Bounded suppression window for a category: base * 2^(n-1), capped. */
  rejectionSuppressionUntil(category: ProactiveRiskCategory, now: number): number {
    const count = this.rejections.filter((r) => r.category === category && now - r.at < this.budget.rejectionSuppressMaxMs).length;
    if (count === 0) return 0;
    const window = Math.min(this.budget.rejectionSuppressMs * Math.pow(2, count - 1), this.budget.rejectionSuppressMaxMs);
    return (this.rejections.filter((r) => r.category === category).at(-1)?.at ?? now) + window;
  }

  rejectionCount(category: ProactiveRiskCategory, now: number): number {
    return this.rejections.filter((r) => r.category === category && now - r.at < this.budget.rejectionSuppressMaxMs).length;
  }

  /** Interruption budget: presentations within the rolling window. */
  presentedWithinWindow(now: number): ProactiveSuggestion[] {
    return this.suggestions.filter((s) => now - s.presentedAt <= this.budget.windowMs && s.status !== 'EXPIRED');
  }

  lastPresentedInCategory(category: ProactiveRiskCategory): number {
    return this.categoryLastPresented.get(category) ?? 0;
  }

  /** Has this dedupKey (or its entity) already been presented recently? */
  hasPresentedRecently(dedupKey: string, now: number, withinMs: number): boolean {
    const entityKey = dedupKey.split(':').slice(0, 2).join(':');
    return this.suggestions.some(
      (s) => (s.dedupKey === dedupKey || s.dedupKey.startsWith(entityKey + ':')) && now - s.presentedAt <= withinMs
    );
  }

  suggestion(id: string): ProactiveSuggestion | undefined {
    return this.suggestions.find((s) => s.id === id);
  }

  liveSuggestions(now: number): ProactiveSuggestion[] {
    return this.suggestions.filter((s) => s.status === 'PRESENTED' && s.expiresAt > now);
  }

  // --- signals -------------------------------------------------------------
  addSignals(signals: import('./proactiveTypes').ProactiveSignal[]): void {
    this.signals.push(...signals);
    if (this.signals.length > MAX_HISTORY * 2) this.signals.splice(0, this.signals.length - MAX_HISTORY * 2);
  }

  recentSignals(now: number, withinMs: number): import('./proactiveTypes').ProactiveSignal[] {
    return this.signals.filter((s) => now - s.timestamp <= withinMs);
  }

  stats(now: number): Record<string, number> {
    return {
      signals: this.signals.length,
      decisions: this.decisions.length,
      suggestions: this.suggestions.length,
      presentedInWindow: this.presentedWithinWindow(now).length,
      rejections: this.rejections.length,
    };
  }

  reset(): void {
    this.signals = [];
    this.decisions = [];
    this.suggestions = [];
    this.events = [];
    this.categoryLastPresented.clear();
    this.rejections = [];
    this.activeTaskId = null;
  }
}

/** Stable entity key for duplicate suppression (type + entity, no volatile parts). */
export function opportunityDedupKey(type: string, entity: string): string {
  return `${type}:${shortHash(entity)}`;
}
