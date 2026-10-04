/**
 * Proactive intelligence service (Phase 15) — the facade wiring:
 * EVENT → SIGNAL → CONTEXT → DECIDE → SAFETY CHECK → OPTIONAL ACTION →
 * VERIFY → MEMORY.
 *
 * Strictly event-driven: `attach(bus)` subscribes to existing events;
 * nothing polls. The only timers are bounded one-shot delayed checks from
 * the scheduler (cancellable, expiring). Presentation happens through the
 * existing `NOTICE` event plus the service API (future UI/devtools can
 * enumerate `pendingSuggestions()`); no UI is modified.
 *
 * Safety: decisions flow through proactivePolicy + proactiveDecider; any
 * execution goes through the existing ToolRegistry with the authoritative
 * PermissionManager; LEVEL 4 categories are never executed; failures are
 * reported honestly for Phase 11 recovery and never retried in a loop.
 */
import type { AgentEvent, AgentEventBus } from '../events';
import type { ToolRegistry } from '../toolRegistry';
import type { PermissionManager } from '../permissions';
import type { MemoryService } from '../memory/memoryService';
import type { LearningService } from '../learning/learningService';
import type { MultimodalAnalyzer } from '../multimodal/multimodalAnalyzer';
import type { MultimodalContext } from '../multimodal/multimodalContext';
import { SignalDetector } from './proactiveSignals';
import { ProactiveContext, opportunityDedupKey } from './proactiveContext';
import { decide } from './proactiveDecider';
import { ProactiveScheduler, type ScheduledCheck } from './proactiveScheduler';
import { executeConfirmed, verifyAction, verifySuggestionPresented, type VerifierDeps } from './proactiveActions';
import {
  DEFAULT_BUDGET,
  DEFAULT_OPPORTUNITY_TTL_MS,
  DEFAULT_SUGGESTION_TTL_MS,
  isNeverAutomatic,
  type InterruptionBudgetConfig,
  type ProactiveDecision,
  type ProactiveEvidence,
  type ProactiveOpportunity,
  type ProactiveRiskCategory,
  type ProactiveSignal,
  type ProactiveSuggestion,
  type ProactiveSuggestedAction,
} from './proactiveTypes';

let seq = 0;
function nextId(prefix: string, now: number): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${now.toString(36)}-${seq.toString(36)}`;
}

/** Bounded opportunity ledger (oldest terminal entries pruned in sweep()). */
const MAX_OPPORTUNITIES = 100;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

export interface ProactiveServiceOptions {
  registry: ToolRegistry;
  permissions: PermissionManager;
  events: AgentEventBus;
  memory?: MemoryService;
  learning?: LearningService;
  /** Phase 14 multimodal context/analyzer — used lazily for verification evidence. */
  multimodalContext?: MultimodalContext;
  /** Injectable clock (deterministic tests). */
  now?: () => number;
  /** Custom interruption budget (deterministic tests / host tuning). */
  budget?: InterruptionBudgetConfig;
  /** Scenario A follow-up delay for unfinished tasks (one-shot, cancellable). */
  unfinishedTaskFollowUpMs?: number;
}

export interface SuggestionPresentation {
  suggestion: ProactiveSuggestion;
  decision: ProactiveDecision;
}

export class ProactiveService {
  private detector = new SignalDetector();
  private context: ProactiveContext;
  private scheduler: ProactiveScheduler;
  private opportunities = new Map<string, ProactiveOpportunity>();
  private presentedIds = new Set<string>();
  private detachFns: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly options: ProactiveServiceOptions) {
    this.context = new ProactiveContext(options.budget ?? DEFAULT_BUDGET);
    this.scheduler = new ProactiveScheduler(
      (check) => this.onScheduledFire(check),
      () => undefined
    );
  }

  private get now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  // ------------------------------------------------------------- lifecycle
  attach(bus: AgentEventBus): () => void {
    const names: AgentEvent['name'][] = [
      'TASK_STARTED',
      'TASK_COMPLETED',
      'TASK_FAILED',
      'TASK_CANCELLED',
      'TOOL_VERIFIED',
      'APP_LAUNCHED',
      'APP_CLOSED',
      'APP_STATE_CHANGED',
      'BROWSER_NAVIGATED',
      'SCREEN_CHANGED',
      'USER_CORRECTION',
      'WORKFLOW_LEARNED',
    ];
    for (const name of names) {
      const off = bus.on(name, (event: AgentEvent) => this.handleEvent(event));
      this.detachFns.push(off);
    }
    return () => this.detach();
  }

  detach(): void {
    for (const off of this.detachFns.splice(0)) off();
    this.scheduler.dispose();
    this.disposed = true;
  }

  // ------------------------------------------------------------- event flow
  /** EVENT → SIGNAL → CONTEXT → DECIDE → act. */
  private handleEvent(event: AgentEvent): void {
    if (this.disposed) return;
    const now = this.now;
    this.context.recordEvent(event, now);

    const signals = this.detector.ingest(event, now);
    if (signals.length === 0) return;
    this.context.addSignals(signals);

    for (const signal of signals) {
      const opportunity = this.formOpportunity(signal, now);
      if (!opportunity) continue;
      this.opportunities.set(opportunity.id, opportunity);
      const decision = this.evaluate(opportunity, now);
      // Unfinished-task one-shot follow-up: schedule ONLY when the immediate
      // evaluation did not already present the offer (e.g. the user was busy)
      // — otherwise the timer would be redundant work.
      if (
        opportunity.type === 'task_unfinished' &&
        decision.action !== 'SUGGEST' &&
        decision.action !== 'REQUEST_CONFIRMATION' &&
        decision.action !== 'EXECUTE_AFTER_CONFIRMATION'
      ) {
        this.scheduler.schedule(opportunity, now + (this.options.unfinishedTaskFollowUpMs ?? 90_000), 'single inactivity follow-up for unfinished task');
      }
    }
    this.sweep(now);
  }

  /** External structured signal ingestion (deadlines, other phases, tests). */
  ingestSignal(rawSignal: ProactiveSignal): void {
    if (this.disposed) return;
    const now = this.now;
    // Sanitize externally-injected signals to the same bounded/redacted
    // shape the detector produces (privacy: bounded quotes, clamped scores,
    // capped TTL — never raw hoarded content).
    const signal: ProactiveSignal = {
      ...rawSignal,
      timestamp: Math.min(Math.max(rawSignal.timestamp, 0), now),
      expiresAt: Math.min(rawSignal.expiresAt, now + 30 * 60_000),
      confidence: clamp01(rawSignal.confidence),
      importance: clamp01(rawSignal.importance),
      urgency: clamp01(rawSignal.urgency),
      evidence: rawSignal.evidence.slice(0, 4).map((e) => ({ ...e, quote: String(e.quote ?? '').slice(0, 160), confidence: clamp01(e.confidence) })),
    };
    this.detector.ingestSignal(signal);
    this.context.addSignals([signal]);
    const opportunity = this.formOpportunity(signal, now);
    if (opportunity) {
      this.opportunities.set(opportunity.id, opportunity);
      this.evaluate(opportunity, now);
    }
    this.sweep(now);
  }

  // --------------------------------------------------- opportunity formation
  private formOpportunity(signal: ProactiveSignal, now: number): ProactiveOpportunity | null {
    const base = {
      id: nextId('opp', now),
      type: signal.type,
      createdAt: now,
      confidence: signal.confidence,
      importance: signal.importance,
      urgency: signal.urgency,
      triggerSignalIds: [signal.id],
      evidence: [...signal.evidence],
      statusReasons: [] as string[],
    };
    const ttl = DEFAULT_OPPORTUNITY_TTL_MS;

    switch (signal.type) {
      case 'task_completed': {
        // Scenario A: offer a low-risk follow-up related to the finished task.
        const action: ProactiveSuggestedAction | undefined = signal.taskId
          ? {
              toolName: 'screen.observe',
              input: { question: 'Is there an obvious next step related to the completed task?' },
              description: 'Observe the screen for a possible next related step',
              category: 'observation',
              requiredPermissions: ['screen.observation'],
              reversible: true,
              minLevel: 1,
            }
          : undefined;
        return {
          ...base,
          dedupKey: opportunityDedupKey('task_completed', signal.taskId ?? 'unknown'),
          expiresAt: now + ttl,
          expectedBenefit: 0.45,
          intrusiveness: 0.25,
          risk: 'general',
          requiredPermissions: action ? action.requiredPermissions : [],
          suggestedAction: action,
          status: 'DETECTED',
        };
      }
      case 'repeated_correction': {
        // Scenario C: recurring corrections → suggest a safer approach (suggest only).
        const count = this.detector.occurrenceCount(signal.dedupKey);
        if (count < 2) return null; // single corrections are normal
        return {
          ...base,
          dedupKey: opportunityDedupKey('repeated_correction', signal.evidence[0]?.quote ?? 'correction'),
          expiresAt: now + ttl,
          confidence: Math.min(0.9, signal.confidence + 0.05 * count),
          expectedBenefit: 0.5,
          intrusiveness: 0.3,
          risk: 'general',
          requiredPermissions: [],
          suggestedAction: undefined,
          status: 'DETECTED',
        };
      }
      case 'workflow_pattern': {
        // Scenario B: learned workflow → offer automation (never auto-execute).
        return {
          ...base,
          dedupKey: opportunityDedupKey('workflow_pattern', signal.metadata['workflowId'] as string ?? signal.metadata['name'] as string ?? 'workflow'),
          expiresAt: now + 30 * 60_000,
          expectedBenefit: 0.6,
          intrusiveness: 0.3,
          risk: 'general',
          requiredPermissions: [],
          suggestedAction: undefined,
          status: 'DETECTED',
        };
      }
      case 'task_unfinished': {
        // Scenario D: one bounded, cancellable follow-up check is scheduled by
        // handleEvent ONLY when the immediate evaluation did not present the
        // offer (e.g. the user was busy) — see handleEvent.
        const opp: ProactiveOpportunity = {
          ...base,
          dedupKey: opportunityDedupKey('task_unfinished', signal.taskId ?? 'unknown'),
          expiresAt: now + 30 * 60_000,
          expectedBenefit: 0.55,
          intrusiveness: 0.35,
          risk: 'general',
          requiredPermissions: [],
          suggestedAction: undefined,
          status: 'DETECTED',
        };
        return opp;
      }
      case 'app_state_changed':
      case 'browser_navigation': {
        // Scenario E: meaningful state change — notify only when important.
        if (signal.importance < 0.5) return null;
        return {
          ...base,
          dedupKey: opportunityDedupKey(signal.type, String(signal.metadata['app'] ?? signal.metadata['host'] ?? 'entity')),
          expiresAt: now + ttl,
          expectedBenefit: 0.4,
          intrusiveness: 0.3,
          risk: 'general',
          requiredPermissions: [],
          suggestedAction: undefined,
          status: 'DETECTED',
        };
      }
      case 'verification_result': {
        // Failed verification of a task step → possible recovery-adjacent hint.
        if (signal.metadata['verified'] === true) return null;
        return {
          ...base,
          dedupKey: opportunityDedupKey('verification_result', signal.taskId ?? signal.metadata['tool'] as string ?? 'verify'),
          expiresAt: now + ttl,
          expectedBenefit: 0.5,
          intrusiveness: 0.35,
          risk: 'general',
          requiredPermissions: [],
          suggestedAction: undefined,
          status: 'DETECTED',
        };
      }
      case 'deadline_reminder':
      case 'explicit_preference':
      case 'inactivity':
      case 'file_state_changed':
      case 'context_change':
      case 'task_failed': {
        const risk: ProactiveRiskCategory = signal.type === 'task_failed' ? 'general' : 'general';
        return {
          ...base,
          dedupKey: opportunityDedupKey(signal.type, signal.taskId ?? signal.evidence[0]?.quote ?? 'entity'),
          expiresAt: now + ttl,
          expectedBenefit: 0.4,
          intrusiveness: 0.3,
          risk,
          requiredPermissions: [],
          suggestedAction: undefined,
          status: 'DETECTED',
        };
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------- evaluation
  private evaluate(opportunity: ProactiveOpportunity, now: number): ProactiveDecision {
    const granted = new Set<string>(this.options.permissions.list().filter((p) => p.granted).map((p) => p.permission));
    const activity = this.context.activityState(now);
    const memories = this.relevantMemories(opportunity);
    const decision = decide({ opportunity, activity, grantedPermissions: granted, relevantMemories: memories, now }, this.context);
    this.context.recordDecision(decision);
    this.opportunities.set(opportunity.id, decision.opportunity);

    if (decision.action === 'SUGGEST' || decision.action === 'REQUEST_CONFIRMATION' || decision.action === 'EXECUTE_AFTER_CONFIRMATION') {
      this.present(decision, now);
    }
    // RECORD_ONLY / SUPPRESS / WAIT stay internal — nothing to confirm.
    return decision;
  }

  private relevantMemories(opportunity: ProactiveOpportunity): string[] {
    if (!this.options.memory) return [];
    try {
      const query = `${opportunity.type} ${opportunity.evidence[0]?.quote ?? ''}`.slice(0, 120);
      return this.options.memory.recall(query, { limit: 3 }).map((r) => r.content.slice(0, 160));
    } catch {
      return [];
    }
  }

  private present(decision: ProactiveDecision, now: number): void {
    const opp = decision.opportunity;
    const confirmationRequired = decision.action === 'REQUEST_CONFIRMATION' || decision.level >= 2;
    const suggestion: ProactiveSuggestion = {
      id: nextId('sug', now),
      opportunityId: opp.id,
      text: this.suggestionText(opp, decision),
      level: decision.level,
      confirmationRequired,
      presentedAt: now,
      expiresAt: now + DEFAULT_SUGGESTION_TTL_MS,
      category: opp.risk,
      dedupKey: opp.dedupKey,
      suggestedAction: opp.suggestedAction,
      status: 'PRESENTED',
    };
    this.context.recordPresented(suggestion, now);
    this.presentedIds.add(suggestion.id);
    opp.status = 'PRESENTED';
    opp.statusReasons.push(`presented (${decision.action}, level ${decision.level})`);
    this.options.events.emit({
      name: 'NOTICE',
      taskId: undefined,
      payload: {
        kind: 'proactive_suggestion',
        suggestionId: suggestion.id,
        opportunityId: opp.id,
        text: suggestion.text,
        level: suggestion.level,
        confirmationRequired,
        expiresAt: suggestion.expiresAt,
        category: suggestion.category,
      },
      timestamp: now,
    });
  }

  private suggestionText(opp: ProactiveOpportunity, decision: ProactiveDecision): string {
    switch (opp.type) {
      case 'task_completed':
        return 'That task is complete. Want me to check the next related step?';
      case 'workflow_pattern':
        return 'I noticed you repeat this workflow. Want me to automate it next time?';
      case 'repeated_correction':
        return 'I noticed the same correction more than once. Want me to suggest a safer way to do this?';
      case 'task_unfinished':
      case 'inactivity':
        return 'A task was interrupted earlier. Want me to help resume it?';
      case 'verification_result':
        return 'A verification step did not pass earlier. Want me to take a closer look?';
      default:
        return decision.reason.length < 140 ? decision.reason : 'I noticed something you may want to look at.';
    }
  }

  // -------------------------------------------------------- user interaction
  /** User accepted a presented suggestion. LEVEL 2/3 → execute after confirmation. */
  async accept(suggestionId: string, signal?: AbortSignal): Promise<{ executed: boolean; verification?: Awaited<ReturnType<typeof verifyAction>>; reason?: string }> {
    const now = this.now;
    const suggestion = this.context.suggestion(suggestionId);
    if (!suggestion || suggestion.status !== 'PRESENTED') {
      return { executed: false, reason: 'suggestion not found or not open' };
    }
    if (suggestion.expiresAt <= now) {
      suggestion.status = 'EXPIRED';
      return { executed: false, reason: 'suggestion expired' };
    }
    suggestion.status = 'ACCEPTED';
    const opp = this.opportunities.get(suggestion.opportunityId);
    if (opp) opp.status = 'ACCEPTED';

    const action = suggestion.suggestedAction;
    if (!action) {
      return { executed: false, reason: 'suggestion carries no executable action (informational only)' };
    }
    // Hard safety re-check at accept time (spec §7/§13).
    if (isNeverAutomatic(action.category)) {
      opp && (opp.status = 'SUPPRESSED');
      return { executed: false, reason: `category "${action.category}" is never automatically executed` };
    }
    if (suggestion.level < 3 && !confirmationRequiredFor(action)) {
      // LEVEL 1 suggestions execute only if the user explicitly asks; accept() IS the confirmation.
    }

    const execution = await executeConfirmed(opp ?? syntheticOpp(suggestion), this.options.registry, this.options.permissions, {
      taskId: `proactive-${suggestion.id}`,
      signal: signal ?? new AbortController().signal,
    });
    if (opp) opp.status = execution.ok ? 'EXECUTED' : 'FAILED';

    // VERIFY (spec §16) — prefer independent evidence via Phase 14.
    const verification = await verifyAction(action, execution, this.verifierDeps());
    if (opp) opp.status = verification.verified ? 'VERIFIED' : execution.ok ? 'EXECUTED' : 'FAILED';
    if (!verification.verified && !execution.ok) {
      // Structured failure for Phase 11 recovery — no retry loop here.
      this.options.events.emit({
        name: 'TOOL_FAILED',
        payload: { tool: action.toolName, source: 'proactive', error: execution.reason ?? execution.result?.error ?? 'execution failed' },
        timestamp: this.now,
      });
    }
    return { executed: execution.ok, verification, reason: execution.reason };
  }

  /** User rejected a presented suggestion → record + escalate suppression. */
  reject(suggestionId: string): { suppressedUntil: number; memoryRecorded: boolean } {
    const now = this.now;
    const suggestion = this.context.suggestion(suggestionId);
    if (!suggestion) return { suppressedUntil: 0, memoryRecorded: false };
    suggestion.status = 'REJECTED';
    const opp = this.opportunities.get(suggestion.opportunityId);
    if (opp) {
      opp.status = 'REJECTED';
      opp.statusReasons.push('rejected by user');
    }
    this.context.recordRejection(suggestion, now);
    const until = this.context.rejectionSuppressionUntil(suggestion.category, now);

    // MEMORY (spec §8): only persist a validated preference after repeated rejections.
    let memoryRecorded = false;
    const count = this.context.rejectionCount(suggestion.category, now);
    if (this.options.memory && count >= this.context.budget.rejectionsBeforeMemory) {
      try {
        this.options.memory.remember(`User repeatedly declines proactive suggestions in the "${suggestion.category}" category — stop offering them unprompted.`, {
          category: 'preference',
          source: 'workflow_learning',
          importance: 0.6,
          confidence: 0.8,
          tags: ['proactive', 'rejection'],
        });
        memoryRecorded = true;
      } catch {
        memoryRecorded = false;
      }
    }
    return { suppressedUntil: until, memoryRecorded };
  }

  /** Cancel every scheduled check for a task (task restarted / user asked). */
  cancelScheduledForTask(taskId: string): number {
    return this.scheduler.cancelWhere((c) => c.opportunity.triggerSignalIds.length > 0 && (c.opportunity.evidence.some((e) => e.quote.includes(taskId)) || c.opportunity.dedupKey.includes(taskId)));
  }

  // ------------------------------------------------------------- scheduler
  private onScheduledFire(check: ScheduledCheck): void {
    // One-shot inactivity follow-up: only present if still relevant and the
    // user is not busy (Scenario D).
    const now = this.now;
    const opp = this.opportunities.get(check.id);
    if (!opp || opp.status !== 'DETECTED' || opp.expiresAt <= now) return;
    const activity = this.context.activityState(now);
    if (activity === 'BUSY') {
      opp.statusReasons.push('scheduled follow-up skipped: user busy');
      return;
    }
    const signal: ProactiveSignal = {
      id: nextId('sig', now),
      type: 'inactivity',
      dedupKey: opp.dedupKey,
      taskId: undefined,
      timestamp: now,
      expiresAt: opp.expiresAt,
      confidence: 0.6,
      importance: opp.importance,
      urgency: opp.urgency,
      evidence: opp.evidence,
      metadata: { scheduled: true, reason: check.reason },
    };
    this.ingestSignal(signal);
  }

  // ------------------------------------------------------------ verification
  private verifierDeps(): VerifierDeps {
    return {
      gatherIndependentEvidence: async (action) => {
        const out: { kind: string; supports: boolean; confidence: number; note: string }[] = [];
        // Phase 14 multimodal: application-state evidence for app-flavored actions.
        if (this.options.multimodalContext && (action.category === 'general' || action.category === 'navigation')) {
          const app = this.options.multimodalContext.byType('application_state', this.now)[0];
          if (app && app.payload.type === 'application_state') {
            out.push({
              kind: 'application_state',
              supports: app.payload.running === true,
              confidence: app.confidence,
              note: `application "${app.payload.name}" running=${app.payload.running}`,
            });
          }
          const tool = this.options.multimodalContext.byType('tool_result', this.now)[0];
          if (tool && tool.payload.type === 'tool_result') {
            out.push({
              kind: 'tool_result',
              supports: tool.payload.verified === true,
              confidence: tool.confidence,
              note: `tool ${tool.payload.toolName} verified=${tool.payload.verified}`,
            });
          }
        }
        return out;
      },
    };
  }

  // ------------------------------------------------------------------ sweep
  /** Lazy, event/API-triggered expiry — no timers. */
  sweep(nowArg?: number): number {
    const now = nowArg ?? this.now;
    let n = this.detector.sweep(now);
    for (const [, opp] of this.opportunities) {
      if (opp.expiresAt <= now && opp.status !== 'EXPIRED' && opp.status !== 'EXECUTED' && opp.status !== 'VERIFIED') {
        opp.status = 'EXPIRED';
        n++;
      }
    }
    // Bounded memory: prune oldest terminal opportunities beyond the cap.
    if (this.opportunities.size > MAX_OPPORTUNITIES) {
      const terminal = [...this.opportunities.values()]
        .filter((o) => o.status === 'EXPIRED' || o.status === 'REJECTED' || o.status === 'VERIFIED' || o.status === 'FAILED' || o.status === 'SUPPRESSED')
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const o of terminal) {
        if (this.opportunities.size <= MAX_OPPORTUNITIES) break;
        this.opportunities.delete(o.id);
      }
    }
    for (const s of this.context.liveSuggestions(now)) {
      if (s.expiresAt <= now) s.status = 'EXPIRED';
    }
    return n;
  }

  // -------------------------------------------------------------- diagnostics
  pendingSuggestions(): ProactiveSuggestion[] {
    return this.context.liveSuggestions(this.now);
  }

  presentedIdsSnapshot(): Set<string> {
    return new Set(this.presentedIds);
  }

  opportunity(id: string): ProactiveOpportunity | undefined {
    return this.opportunities.get(id);
  }

  opportunitiesSnapshot(): ProactiveOpportunity[] {
    return [...this.opportunities.values()];
  }

  budgetStatus(): { presentedInWindow: number; max: number; windowMs: number; scheduled: number } {
    const now = this.now;
    return {
      presentedInWindow: this.context.presentedWithinWindow(now).length,
      max: this.context.budget.maxPresentedPerWindow,
      windowMs: this.context.budget.windowMs,
      scheduled: this.scheduler.pending().length,
    };
  }

  activityState(): string {
    return this.context.activityState(this.now);
  }

  diagnostics(): Record<string, unknown> {
    const now = this.now;
    return {
      activity: this.context.activityState(now),
      signals: this.detector.stats(now),
      context: this.context.stats(now),
      budget: this.budgetStatus(),
      opportunities: this.opportunities.size,
      pendingSuggestions: this.pendingSuggestions().length,
    };
  }
}

function confirmationRequiredFor(action: ProactiveSuggestedAction): boolean {
  return action.minLevel >= 2 || isNeverAutomatic(action.category);
}

function syntheticOpp(suggestion: ProactiveSuggestion): ProactiveOpportunity {
  const now = Date.now();
  const evidence: ProactiveEvidence[] = [{ source: 'suggestion', quote: suggestion.text, timestamp: now, confidence: 0.7 }];
  return {
    id: suggestion.opportunityId,
    type: 'task_completed',
    dedupKey: suggestion.dedupKey,
    createdAt: now,
    expiresAt: now + 60_000,
    confidence: 0.7,
    importance: 0.5,
    urgency: 0.5,
    expectedBenefit: 0.5,
    intrusiveness: 0.3,
    risk: suggestion.category,
    requiredPermissions: suggestion.suggestedAction?.requiredPermissions ?? [],
    suggestedAction: suggestion.suggestedAction,
    triggerSignalIds: [],
    evidence,
    status: 'ACCEPTED',
    statusReasons: [],
  };
}
