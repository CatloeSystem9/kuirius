/**
 * Goal Continuity v1 — persistent user objectives across sessions.
 *
 * Design (mirrors Project Awareness v1's architecture):
 * - DURABLE: a bounded, versioned goal store over the shared StorageAdapter.
 * - EVENT-DRIVEN: attaches to the shared AgentEventBus — no polling, no
 *   timers, no network calls, no embeddings. Everything is local and cheap.
 * - CONSERVATIVE: goals are created or changed only from sufficiently clear
 *   user statements; soft interest becomes a PROPOSED goal that needs an
 *   explicit confirmation; ambiguous statements with several open goals are
 *   never applied.
 * - REUSING, NOT DUPLICATING: durable facts ride the existing MemoryService
 *   (compact metadata-marked mirrors), relationships ride the existing
 *   KnowledgeGraph ('goal' nodes + 'related_to'/'blocks' edges), project
 *   association only ever references APPROVED Project Awareness roots, and
 *   skill hints come from the existing verified-only SkillEngine.
 * - RESUMPTION ≠ EXECUTION: a briefing restores context and proposes the
 *   next step; the engine never calls a tool and never performs an action.
 */
import type { AgentEventBus } from '../events';
import type { KnowledgeEdge, KnowledgeNode } from '../knowledge/knowledgeTypes';
import type { KnowledgeGraphFacade } from '../knowledge/index';
import type { MemoryRecord } from '../memory/memoryTypes';
import { similarity } from '../memory/similarity';
import type { MemoryService } from '../memory/memoryService';
import type { ProjectEngine } from '../projects/projectEngine';
import type { SkillEngine } from '../skills/skillEngine';
import type { StorageAdapter } from '../taskState';
import { localStorageAdapter } from '../taskState';
import { GoalStore, openGoals } from './goalStore';
import { detectGoalIntent, isConfirmationStatement, isSameGoalStatement, resolveGoalTarget } from './goalIntent';
import type { GoalIntent, GoalIntentKind } from './goalIntent';
import type {
  GoalBriefedPayload,
  GoalLimits,
  GoalMilestonePayload,
  GoalProjectRef,
  GoalRecord,
  GoalStats,
  GoalStatus,
  GoalStatusUpdatedPayload,
} from './goalTypes';
import {
  GOAL_BRIEF_COOLDOWN_MS,
  GOAL_BRIEF_LIMIT,
  GOAL_BRIEF_MIN_RELEVANCE,
  GOAL_PROJECT_MATCH_THRESHOLD,
  GOAL_TASK_MATCH_THRESHOLD,
  canTransitionGoal,
} from './goalTypes';

/** A skill hint is only surfaced when the match is genuinely reusable. */
const GOAL_SKILL_HINT_MIN_SCORE = 0.6;

const GOAL_CONTINUITY_SOURCE = 'goal_continuity';

export interface GoalEngineOptions {
  storage?: StorageAdapter;
  events?: AgentEventBus;
  memory?: MemoryService;
  knowledge?: KnowledgeGraphFacade;
  projects?: ProjectEngine;
  skills?: SkillEngine;
  /** Resolves a task by id for milestone tracking (like ConsolidationEngine.getTask). */
  getTask?: (id: string) => { goal?: { description?: string } } | undefined;
  now?: () => number;
  limits?: Partial<GoalLimits>;
}

/** Result of observing one user message — never an action, only state. */
export interface GoalObservation {
  matched: boolean;
  intent?: GoalIntentKind | 'confirm';
  goalId?: string;
  previousStatus?: GoalStatus;
  status?: GoalStatus;
  /** true when the statement was clear but needs the user to disambiguate. */
  needsConfirmation?: boolean;
  briefing?: string[];
  note?: string;
}

/** A resumption briefing for one goal — context restoration, never execution. */
export interface GoalBriefing {
  goalId: string;
  description: string;
  relevance: number;
  lines: string[];
}

/** Create a unique, stable goal id ('goal_' + time/base36 + entropy). */
function newGoalId(): string {
  return `goal_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function capitalize(text: string): string {
  return text.length ? text[0].toUpperCase() + text.slice(1) : text;
}

export class GoalEngine {
  readonly store: GoalStore;
  private readonly events?: AgentEventBus;
  private readonly memory?: MemoryService;
  private readonly knowledge?: KnowledgeGraphFacade;
  private readonly projects?: ProjectEngine;
  private readonly skills?: SkillEngine;
  private readonly getTask?: GoalEngineOptions['getTask'];
  private readonly now: () => number;
  private readonly limits: GoalLimits;
  /** In-memory confirmation context: the PROPOSED goal awaiting the user's yes. */
  private pendingProposedGoalId: string | null = null;

  constructor(options: GoalEngineOptions) {
    this.store = new GoalStore(options.storage ?? localStorageAdapter, options.limits, options.now);
    this.events = options.events;
    this.memory = options.memory;
    this.knowledge = options.knowledge;
    this.projects = options.projects;
    this.skills = options.skills;
    this.getTask = options.getTask;
    this.now = options.now ?? Date.now;
    this.limits = this.store.limits;
  }

  // ---------------------------------------------------------- event wiring

  /**
   * Event-driven attachment (no polling). Task completion feeds milestones;
   * task failure only bumps activity; cancellation changes NOTHING (emergency
   * stop behaviour is preserved); forgotten projects strip stale references.
   */
  attach(bus: AgentEventBus): () => void {
    const detachCompleted = bus.on('TASK_COMPLETED', (event) => this.onTaskCompleted(event));
    const detachFailed = bus.on('TASK_FAILED', (event) => this.onTaskFailed(event));
    const detachCancelled = bus.on('TASK_CANCELLED', () => {
      /* cancellation is never goal-relevant — goals stay untouched */
    });
    const detachProject = bus.on('PROJECT_STATUS_UPDATED', (event) => this.onProjectForgotten(event));
    return () => {
      detachCompleted();
      detachFailed();
      detachCancelled();
      detachProject();
    };
  }

  private onTaskCompleted(event: { taskId?: string }): void {
    try {
      const description = this.taskDescription(event.taskId);
      if (!description) return;
      for (const goal of openGoals(this.store.records)) {
        if (goal.status !== 'active') continue;
        if (similarity(description, goal.description) >= GOAL_TASK_MATCH_THRESHOLD) {
          this.recordMilestone(goal.id, description.slice(0, this.limits.maxItemChars), event.taskId, 'progress');
        }
      }
    } catch {
      // goal tracking must never break task execution
    }
  }

  private onTaskFailed(event: { taskId?: string }): void {
    try {
      const description = this.taskDescription(event.taskId);
      if (!description) return;
      for (const goal of openGoals(this.store.records)) {
        if (goal.status !== 'active') continue;
        if (similarity(description, goal.description) >= GOAL_TASK_MATCH_THRESHOLD) {
          this.store.update(goal.id, (g) => {
            g.lastActivityAt = this.now();
          });
        }
      }
    } catch {
      // non-fatal
    }
  }

  private taskDescription(taskId?: string): string | null {
    if (!taskId || !this.getTask) return null;
    const task = this.getTask(taskId);
    const description = task?.goal?.description;
    return typeof description === 'string' && description.trim() ? description.trim() : null;
  }

  private onProjectForgotten(event: { payload?: unknown }): void {
    try {
      const payload = event.payload as { root?: unknown; forgotten?: unknown } | undefined;
      if (!payload || payload.forgotten !== true || typeof payload.root !== 'string') return;
      const lower = payload.root.toLowerCase();
      for (const goal of this.store.records) {
        if (!goal.projectRefs.some((ref) => ref.root.toLowerCase() === lower)) continue;
        this.store.update(goal.id, (g) => {
          g.projectRefs = g.projectRefs.filter((ref) => ref.root.toLowerCase() !== lower);
        });
        this.mirrorGoal(this.store.get(goal.id));
      }
    } catch {
      // non-fatal
    }
  }

  // ------------------------------------------------------- message observation

  /**
   * Observe a user message for goal lifecycle statements. Pure local
   * detection; never creates goals from questions, hypotheticals or chatter;
   * never applies an ambiguous statement when several goals are open.
   */
  observeMessage(text: string): GoalObservation {
    try {
      const trimmed = text.trim();

      // A short explicit confirmation activates the pending PROPOSED goal.
      // Checked BEFORE the length guard — confirmations are short by nature.
      const pendingId = this.pendingProposedGoalId;
      if (pendingId && isConfirmationStatement(trimmed)) {
        const pending = this.store.get(pendingId);
        if (pending && pending.status === 'proposed') {
          const previous = pending.status;
          const updated = this.transition(pending.id, 'active', 'confirmed by user');
          this.pendingProposedGoalId = null;
          if (updated) {
            return {
              matched: true,
              intent: 'confirm' as GoalIntentKind,
              goalId: updated.id,
              previousStatus: previous,
              status: updated.status,
              briefing: this.briefingForGoal(updated),
            };
          }
        }
        this.pendingProposedGoalId = null;
      }

      if (trimmed.length < 6) return { matched: false };

      const intent = detectGoalIntent(trimmed, this.limits.maxDescriptionChars);
      if (!intent) return { matched: false };

      switch (intent.kind) {
        case 'create':
          return this.handleCreateIntent(intent, trimmed);
        case 'complete':
        case 'pause':
        case 'resume':
        case 'abandon':
          return this.handleLifecycleIntent(intent);
      }
      return { matched: false };
    } catch {
      return { matched: false };
    }
  }

  private handleCreateIntent(intent: GoalIntent, origin: string): GoalObservation {
    const subject = intent.subject.trim();
    if (!subject) return { matched: false };
    const description = capitalize([intent.verb, subject].filter(Boolean).join(' ')).slice(0, this.limits.maxDescriptionChars);

    // Deduplicate against open goals: a restatement refines, never duplicates.
    const open = openGoals(this.store.records);
    let best: GoalRecord | null = null;
    let bestScore = 0;
    for (const goal of open) {
      const same = isSameGoalStatement(subject, goal.description) || isSameGoalStatement(subject, goal.originMessage ?? '');
      if (!same) continue;
      const score = Math.max(similarity(subject, goal.description), similarity(subject, goal.originMessage ?? ''));
      if (score > bestScore || !best) {
        bestScore = score;
        best = goal;
      }
    }
    if (best) {
      const previous = best.status;
      const updated = this.store.update(best.id, (g) => {
        if (description.length > g.description.length) g.description = description;
        g.lastActivityAt = this.now();
        this.autoAssociateProjects(g, subject);
      });
      let final = updated;
      if (updated && updated.status === 'proposed' && intent.explicit && canTransitionGoal('proposed', 'active')) {
        final = this.transition(updated.id, 'active', 'restated with explicit commitment');
      }
      if (!final) return { matched: false };
      // Refresh both mirrors: the description (and possibly refs) just changed.
      this.mirrorGoal(final);
      return {
        matched: true,
        intent: 'create',
        goalId: final.id,
        previousStatus: previous,
        status: final.status,
        briefing: this.briefingForGoal(final),
        note: previous === final.status ? 'existing goal updated' : 'existing goal updated and activated',
      };
    }

    const status: GoalStatus = intent.explicit ? 'active' : 'proposed';
    const now = this.now();
    const record: GoalRecord = {
      id: newGoalId(),
      description,
      status,
      originMessage: origin.slice(0, this.limits.maxOriginChars),
      milestones: [],
      progress: { completed: [], remaining: [], blockers: [] },
      projectRefs: [],
      blockedByGoalIds: [],
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.autoAssociateProjects(record, subject);
    this.store.upsert(record);
    if (status === 'proposed') this.pendingProposedGoalId = record.id;
    this.emitStatus(record, undefined, status === 'proposed' ? 'proposed — awaiting user confirmation' : undefined);
    this.mirrorGoal(record);
    return {
      matched: true,
      intent: 'create',
      goalId: record.id,
      status: record.status,
      needsConfirmation: status === 'proposed',
      briefing: this.briefingForGoal(record),
    };
  }

  private handleLifecycleIntent(intent: GoalIntent): GoalObservation {
    const open = openGoals(this.store.records);
    const { goal, ambiguous } = resolveGoalTarget(intent.subject, open);
    if (ambiguous) {
      return {
        matched: true,
        intent: intent.kind,
        needsConfirmation: true,
        note: 'several goals are open — the statement needs the user to name which one',
      };
    }
    if (!goal) return { matched: false };

    const previous = goal.status;
    let next: GoalStatus;
    switch (intent.kind) {
      case 'complete': next = 'completed'; break;
      case 'pause': next = 'paused'; break;
      case 'resume': next = 'active'; break;
      case 'abandon': next = 'abandoned'; break;
      default: return { matched: false };
    }
    const updated = this.transition(goal.id, next, `${intent.kind} per user statement`);
    if (!updated) {
      return { matched: false, note: `transition ${previous} → ${next} is not valid` };
    }
    if (intent.kind === 'complete') {
      this.recordMilestone(updated.id, 'Marked completed by user', undefined, 'progress');
    }
    if (this.pendingProposedGoalId === updated.id) {
      this.pendingProposedGoalId = null;
    }
    return {
      matched: true,
      intent: intent.kind,
      goalId: updated.id,
      previousStatus: previous,
      status: updated.status,
      briefing: this.briefingForGoal(updated),
    };
  }

  // ------------------------------------------------------------- lifecycle API

  /** Create a goal programmatically (tools). Dedup-aware like observeMessage. */
  create(description: string, opts: { originMessage?: string; explicit?: boolean } = {}): GoalRecord | null {
    try {
      const subject = description.trim().slice(0, this.limits.maxDescriptionChars);
      if (!subject) return null;
      const observation = this.handleCreateIntent({ kind: 'create', subject, explicit: opts.explicit ?? true }, opts.originMessage ?? subject);
      return observation.goalId ? this.store.get(observation.goalId) ?? null : null;
    } catch {
      return null;
    }
  }

  /** Apply a lifecycle transition; invalid transitions are rejected, never guessed. */
  transition(goalId: string, to: GoalStatus, reason?: string): GoalRecord | null {
    try {
      const goal = this.store.get(goalId);
      if (!goal) return null;
      const previous = goal.status;
      if (!canTransitionGoal(previous, to)) return null;
      const updated = this.store.update(goalId, (g) => {
        g.status = to;
        g.lastActivityAt = this.now();
      });
      if (!updated) return null;
      if (to !== 'proposed') this.emitStatus(updated, previous, reason);
      this.mirrorGoal(updated);
      return updated;
    } catch {
      return null;
    }
  }

  /** Record a bounded progress milestone for a goal. */
  recordMilestone(goalId: string, text: string, sourceTaskId?: string, outcome: 'progress' | 'attempt_failed' = 'progress'): boolean {
    try {
      const trimmed = text.trim().slice(0, this.limits.maxItemChars);
      if (!trimmed) return false;
      const goal = this.store.get(goalId);
      if (!goal || goal.status === 'abandoned') return false;
      const updated = this.store.update(goalId, (g) => {
        if (g.milestones.length >= this.limits.maxMilestones) g.milestones.shift();
        g.milestones.push({ text: trimmed, at: this.now(), ...(sourceTaskId ? { sourceTaskId } : {}), outcome });
        g.lastActivityAt = this.now();
      });
      if (!updated) return false;
      const payload: GoalMilestonePayload = {
        goalId,
        milestone: trimmed,
        ...(sourceTaskId ? { sourceTaskId } : {}),
        outcome,
      };
      this.events?.emit({ name: 'GOAL_MILESTONE_RECORDED', taskId: sourceTaskId, payload, timestamp: this.now() });
      this.mirrorMemory(updated);
      return true;
    } catch {
      return false;
    }
  }

  /** Add a bounded item to completed/remaining/blockers. */
  addProgressItem(goalId: string, kind: 'completed' | 'remaining' | 'blockers', text: string): boolean {
    try {
      const trimmed = text.trim().slice(0, this.limits.maxItemChars);
      if (!trimmed) return false;
      const updated = this.store.update(goalId, (g) => {
        const list = g.progress[kind];
        if (list.includes(trimmed)) return;
        if (list.length >= this.limits.maxProgressItems) list.shift();
        list.push(trimmed);
        g.lastActivityAt = this.now();
      });
      if (!updated) return false;
      this.mirrorGoal(updated);
      return true;
    } catch {
      return false;
    }
  }

  /** Associate a goal with an APPROVED project root only (consent preserved). */
  associateProject(goalId: string, root: string): boolean {
    try {
      const normalized = root.trim();
      if (!normalized || !this.projects) return false;
      const profile = this.projects.profile(normalized);
      if (!profile) return false; // unapproved or unknown — never silently associated
      const updated = this.store.update(goalId, (g) => {
        this.addProjectRef(g, { projectId: profile.id, root: profile.root, name: profile.name });
        g.lastActivityAt = this.now();
      });
      if (!updated) return false;
      this.mirrorGoal(updated);
      return true;
    } catch {
      return false;
    }
  }

  private addProjectRef(goal: GoalRecord, ref: GoalProjectRef): void {
    if (goal.projectRefs.some((r) => r.root.toLowerCase() === ref.root.toLowerCase())) return;
    if (goal.projectRefs.length >= this.limits.maxProjectRefs) goal.projectRefs.shift();
    goal.projectRefs.push(ref);
  }

  /** Auto-associate with approved projects whose name matches the subject. */
  private autoAssociateProjects(goal: GoalRecord, subject: string): void {
    if (!this.projects) return;
    try {
      for (const profile of this.projects.listProfiles()) {
        if (goal.projectRefs.length >= this.limits.maxProjectRefs) break;
        if (similarity(subject, profile.name) >= GOAL_PROJECT_MATCH_THRESHOLD) {
          this.addProjectRef(goal, { projectId: profile.id, root: profile.root, name: profile.name });
        }
      }
    } catch {
      // association is best-effort
    }
  }

  /** Drop references to projects that are no longer approved/present. */
  private stripStaleProjectRefs(goal: GoalRecord): boolean {
    if (!this.projects || goal.projectRefs.length === 0) return false;
    try {
      const stale = goal.projectRefs.filter((ref) => !this.projects!.profile(ref.root));
      if (!stale.length) return false;
      const staleLower = new Set(stale.map((r) => r.root.toLowerCase()));
      this.store.update(goal.id, (g) => {
        g.projectRefs = g.projectRefs.filter((ref) => !staleLower.has(ref.root.toLowerCase()));
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Remove a goal and release its memory/graph mirrors (own markers only). */
  forget(goalId: string): boolean {
    try {
      const goal = this.store.get(goalId);
      if (!goal) return false;
      this.store.remove(goalId);
      if (this.pendingProposedGoalId === goalId) this.pendingProposedGoalId = null;
      this.removeMemoryMirror(goalId);
      this.pruneGraphMirror(goalId, null);
      this.events?.emit({
        name: 'GOAL_STATUS_UPDATED',
        payload: {
          goalId,
          description: goal.description,
          status: goal.status,
          previousStatus: goal.status,
          forgotten: true,
        } satisfies GoalStatusUpdatedPayload,
        timestamp: this.now(),
      });
      return true;
    } catch {
      return false;
    }
  }

  get(goalId: string): GoalRecord | undefined {
    return this.store.get(goalId);
  }

  list(status?: GoalStatus): GoalRecord[] {
    const records = this.store.records;
    return status ? records.filter((g) => g.status === status) : [...records];
  }

  stats(): GoalStats {
    const records = this.store.records;
    const stats: GoalStats = {
      total: records.length,
      proposed: 0,
      active: 0,
      paused: 0,
      blocked: 0,
      completed: 0,
      abandoned: 0,
      withProjectRefs: 0,
      milestones: 0,
    };
    for (const g of records) {
      stats[g.status] += 1;
      if (g.projectRefs.length) stats.withProjectRefs += 1;
      stats.milestones += g.milestones.length;
    }
    return stats;
  }

  // ---------------------------------------------------------- resumption

  /**
   * Resumption intelligence: the open goals relevant to the current input
   * (or, with no input, the most recently active ones) with their progress,
   * remaining work and blockers. Proposes context — never executes anything.
   */
  resumptionBriefing(input = ''): GoalBriefing[] {
    try {
      const goals = openGoals(this.store.records);
      for (const goal of goals) {
        if (this.stripStaleProjectRefs(goal)) this.mirrorGoal(this.store.get(goal.id));
      }
      const trimmed = input.trim();
      let ranked: { goal: GoalRecord; relevance: number }[];
      if (trimmed) {
        ranked = goals
          .map((goal) => ({
            goal,
            relevance: Math.max(similarity(trimmed, goal.description), similarity(trimmed, goal.originMessage ?? '')),
          }))
          .filter((entry) => entry.relevance >= GOAL_BRIEF_MIN_RELEVANCE)
          .sort((a, b) => b.relevance - a.relevance);
      } else {
        ranked = [...goals]
          .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
          .map((goal) => ({ goal, relevance: 0 }));
      }
      const briefings: GoalBriefing[] = [];
      for (const entry of ranked.slice(0, GOAL_BRIEF_LIMIT)) {
        const lines = this.briefingForGoal(entry.goal);
        briefings.push({ goalId: entry.goal.id, description: entry.goal.description, relevance: entry.relevance, lines });
        const due = !entry.goal.lastBriefedAt || this.now() - entry.goal.lastBriefedAt >= GOAL_BRIEF_COOLDOWN_MS;
        if (due) {
          this.store.update(entry.goal.id, (g) => {
            g.lastBriefedAt = this.now();
          });
          const payload: GoalBriefedPayload = {
            goalId: entry.goal.id,
            description: entry.goal.description,
            relevance: entry.relevance,
            briefing: lines,
          };
          this.events?.emit({ name: 'GOAL_RESUMPTION_BRIEFED', payload, timestamp: this.now() });
        }
      }
      return briefings;
    } catch {
      return [];
    }
  }

  /** Human-readable briefing lines for one goal (context only, no actions). */
  private briefingForGoal(goal: GoalRecord): string[] {
    const done = goal.progress.completed;
    const remaining = goal.progress.remaining;
    const blockers = goal.progress.blockers;
    const lines: string[] = [];
    lines.push(`Goal: "${goal.description}" — status: ${goal.status}${goal.status === 'proposed' ? ' (awaiting your confirmation)' : ''}`);
    const milestoneCount = goal.milestones.filter((m) => m.outcome === 'progress').length;
    if (done.length) lines.push(`Completed so far: ${done.slice(0, 3).join('; ')}`);
    else if (milestoneCount) lines.push(`Recorded progress: ${milestoneCount} milestone${milestoneCount === 1 ? '' : 's'}`);
    if (remaining.length) lines.push(`Remaining: ${remaining.slice(0, 3).join('; ')}`);
    else lines.push('Remaining: next step not yet recorded — propose one with the user');
    if (blockers.length) lines.push(`Blockers: ${blockers.slice(0, 3).join('; ')}`);
    const satisfied = goal.blockedByGoalIds.filter((id) => this.store.get(id)?.status === 'completed');
    if (goal.blockedByGoalIds.length) {
      lines.push(`Depends on ${goal.blockedByGoalIds.length} goal(s)${satisfied.length ? `, ${satisfied.length} now completed` : ''}`);
    }
    if (goal.projectRefs.length) {
      lines.push(`Project: ${goal.projectRefs.map((r) => r.name || r.root).join(', ')}`);
    }
    const hint = this.skillHint(goal);
    if (hint) lines.push(hint);
    return lines;
  }

  /** Verified learned skills may be mentioned — never executed here. */
  private skillHint(goal: GoalRecord): string | null {
    if (!this.skills) return null;
    try {
      for (const match of this.skills.match(goal.description)) {
        if (match.blockers.length === 0 && match.score >= GOAL_SKILL_HINT_MIN_SCORE) {
          return `A verified learned skill ("${match.skill.name}") is available for work like this — it would still run through the normal permission flow.`;
        }
      }
    } catch {
      // hints are best-effort
    }
    return null;
  }

  // ------------------------------------------------------------- mirrors

  /** Compact durable record through the EXISTING MemoryService (marker-owned). */
  private mirrorMemory(goal: GoalRecord): void {
    if (!this.memory) return;
    try {
      // Last 8 id chars = timestamp tail + random suffix, so two goals created
      // in the same millisecond still carry DISTINCT markers (the memory layer
      // dedups by similarity — identical markers would wrongly merge mirrors).
      const id8 = goal.id.slice(-8);
      const doneCount = goal.progress.completed.length;
      const remainingCount = goal.progress.remaining.length;
      const parts = [`[goal ${id8}] ${goal.description} — ${goal.status}`];
      if (doneCount || remainingCount) parts.push(`progress: ${doneCount} done, ${remainingCount} remaining`);
      if (goal.progress.remaining.length) parts.push(`next: ${goal.progress.remaining[0]}`);
      if (goal.progress.blockers.length) parts.push(`blockers: ${goal.progress.blockers.length}`);
      const content = parts.join('; ').slice(0, 300);
      const existing = this.findMemoryMirror(goal.id);
      if (existing) {
        this.memory.update(existing.id, content);
      } else {
        this.memory.remember(content, {
          category: 'long_term',
          source: 'conversation_extract',
          importance: 0.75,
          confidence: 0.85,
          tags: ['goal-continuity', 'goal'],
          metadata: { goalId: goal.id, kind: 'goal_continuity', status: goal.status },
        });
      }
    } catch {
      // memory must never break goal tracking
    }
  }

  private findMemoryMirror(goalId: string): MemoryRecord | null {
    if (!this.memory) return null;
    for (const record of this.memory.records) {
      const meta = record.metadata as { goalId?: unknown } | undefined;
      if (meta && meta.goalId === goalId && record.valid) return record;
    }
    return null;
  }

  /**
   * Release ONLY the memory records this engine wrote (goalId marker) —
   * user memories are never touched. Never throws.
   */
  private removeMemoryMirror(goalId: string): void {
    if (!this.memory) return;
    try {
      for (const record of [...this.memory.records]) {
        const meta = record.metadata as { goalId?: unknown } | undefined;
        if (meta && meta.goalId === goalId) this.memory.forget(record.id);
      }
    } catch {
      // non-fatal
    }
  }

  /** Refresh both mirrors for a goal (safe on partial failures). */
  private mirrorGoal(goal: GoalRecord | undefined): void {
    if (!goal) return;
    this.mirrorMemory(goal);
    this.mirrorGraph(goal);
  }

  /**
   * Graph mirror: one 'goal' node per goal plus 'related_to' edges to its
   * approved projects and 'blocks' edges for dependencies. Every node gets a
   * User --owns--> edge so snapshot-based pruning can always find it.
   */
  private mirrorGraph(goal: GoalRecord): void {
    if (!this.knowledge) return;
    try {
      this.pruneGraphMirror(goal.id, goal);
      const graph = this.knowledge.graph;
      const label = `Goal: ${goal.description}`.slice(0, 120);
      const goalNode = graph.upsertNode({
        type: 'goal',
        label,
        properties: { goalId: goal.id, status: goal.status },
      });
      if (!goalNode) return;
      const user = graph.upsertNode({ type: 'person', label: 'User' });
      if (user) {
        graph.upsertEdge({ sourceId: user.id, targetId: goalNode.id, relationship: 'owns', confidence: 0.9, source: GOAL_CONTINUITY_SOURCE });
      }
      for (const ref of goal.projectRefs) {
        const projectNode = this.findProjectNode(ref.root);
        if (projectNode) {
          graph.upsertEdge({ sourceId: goalNode.id, targetId: projectNode.id, relationship: 'related_to', confidence: 0.8, source: GOAL_CONTINUITY_SOURCE });
        }
      }
      for (const blockerId of goal.blockedByGoalIds) {
        const blocker = this.store.get(blockerId);
        if (!blocker) continue;
        const blockerNode = graph.upsertNode({
          type: 'goal',
          label: `Goal: ${blocker.description}`.slice(0, 120),
          properties: { goalId: blocker.id, status: blocker.status },
        });
        if (blockerNode) {
          graph.upsertEdge({ sourceId: blockerNode.id, targetId: goalNode.id, relationship: 'blocks', confidence: 0.8, source: GOAL_CONTINUITY_SOURCE });
        }
      }
    } catch {
      // the graph must never break goal tracking
    }
  }

  private findProjectNode(root: string): KnowledgeNode | null {
    if (!this.knowledge) return null;
    try {
      const graph = this.knowledge.graph;
      const lower = root.toLowerCase();
      for (const node of graph.getNodesByType('project', 64)) {
        if (typeof node.properties?.root === 'string' && node.properties.root.toLowerCase() === lower) return node;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Remove graph records that no longer match the goal (status changes,
   * refined descriptions, dropped project refs, or full forget). Uses ONE
   * complete edge snapshot — per-node relation queries hard-cap at
   * maxQueryResults (10), which would hide stale records and could cause
   * premature node deletion (the exact defect fixed in Project Awareness).
   * Nodes owned by OTHER systems (projects, user) are never deleted here.
   */
  private pruneGraphMirror(goalId: string, goal: GoalRecord | null): void {
    if (!this.knowledge) return;
    try {
      const graph = this.knowledge.graph;
      const allEdges = graph.getAllEdges(graph.limits.maxEdges);
      const edgesByNode = new Map<string, KnowledgeEdge[]>();
      for (const e of allEdges) {
        for (const id of [e.sourceId, e.targetId]) {
          const list = edgesByNode.get(id);
          if (list) list.push(e);
          else edgesByNode.set(id, [e]);
        }
      }
      const expectedLabel = goal ? `Goal: ${goal.description}`.slice(0, 120) : null;
      const keepProjectRoots = new Set((goal?.projectRefs ?? []).map((r) => r.root.toLowerCase()));
      const keepBlockers = new Set(goal?.blockedByGoalIds ?? []);

      for (const goalNode of this.goalGraphNodes(goalId, allEdges)) {
        for (const edge of edgesByNode.get(goalNode.id) ?? []) {
          if (edge.source !== GOAL_CONTINUITY_SOURCE) continue;
          const otherId = edge.sourceId === goalNode.id ? edge.targetId : edge.sourceId;
          const other = graph.getNode(otherId);
          let keep = false;
          if (goal && expectedLabel && goalNode.label === expectedLabel && other) {
            if (edge.relationship === 'owns' && other.type === 'person' && other.label === 'User') keep = true;
            else if (edge.relationship === 'related_to' && other.type === 'project' && typeof other.properties?.root === 'string' && keepProjectRoots.has(other.properties.root.toLowerCase())) keep = true;
            else if (edge.relationship === 'blocks' && other.type === 'goal' && typeof other.properties?.goalId === 'string' && keepBlockers.has(other.properties.goalId)) keep = true;
          }
          if (keep) continue;
          graph.deleteEdge(edge.id);
          // Only delete the opposite node when it is an engine-owned goal node
          // that nothing else references anymore (checked against the SNAPSHOT).
          const remaining = (edgesByNode.get(otherId) ?? []).filter((x) => x.id !== edge.id);
          const engineOwned = !!other && other.type === 'goal' && typeof other.properties?.goalId === 'string';
          if (engineOwned && remaining.length === 0) graph.deleteNode(otherId);
        }
        if (goal === null) {
          graph.deleteNode(goalNode.id);
        } else if (expectedLabel && goalNode.label !== expectedLabel) {
          // Stale label (refined description): every goal_continuity edge of a
          // stale node is deleted in this pass, so the node is droppable when
          // nothing OUTSIDE this engine still references it.
          const remaining = (edgesByNode.get(goalNode.id) ?? []).filter((e) => e.source !== GOAL_CONTINUITY_SOURCE);
          if (remaining.length === 0) graph.deleteNode(goalNode.id);
        }
      }
    } catch {
      // pruning must never break goal tracking or forgetting
    }
  }

  /**
   * Every goal node recorded for this goalId, found through the COMPLETE
   * edge snapshot plus the by-type listing (for edge-less nodes).
   */
  private goalGraphNodes(goalId: string, allEdges: KnowledgeEdge[]): KnowledgeNode[] {
    if (!this.knowledge) return [];
    try {
      const graph = this.knowledge.graph;
      const seen = new Set<string>();
      const found: KnowledgeNode[] = [];
      const candidates = new Set<string>();
      for (const e of allEdges) {
        candidates.add(e.sourceId);
        candidates.add(e.targetId);
      }
      for (const n of graph.getNodesByType('goal', 64)) candidates.add(n.id);
      for (const id of candidates) {
        if (seen.has(id)) continue;
        seen.add(id);
        const n = graph.getNode(id);
        if (n && n.type === 'goal' && n.properties?.goalId === goalId) found.push(n);
      }
      return found;
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------- events

  private emitStatus(goal: GoalRecord, previous: GoalStatus | undefined, reason?: string): void {
    try {
      const payload: GoalStatusUpdatedPayload = {
        goalId: goal.id,
        description: goal.description,
        status: goal.status,
        ...(previous ? { previousStatus: previous } : {}),
        ...(reason ? { reason } : {}),
      };
      this.events?.emit({ name: 'GOAL_STATUS_UPDATED', payload, timestamp: this.now() });
    } catch {
      // events must never break goal tracking
    }
  }
}
