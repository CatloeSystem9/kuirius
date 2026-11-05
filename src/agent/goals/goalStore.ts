/**
 * Goal Continuity v1 — bounded, versioned, repair-don't-drop persistence.
 *
 * Follows the shared store conventions (ProjectStore / SkillStore /
 * MemoryStore): a versioned JSON envelope over an injected StorageAdapter,
 * lazy load, per-record repair, future-schema → clean start (never guesses),
 * hard caps with deterministic eviction, synchronous write-through, and
 * write failures that never break the running system.
 */
import type { StorageAdapter } from '../taskState';
import { localStorageAdapter } from '../taskState';
import type { GoalLimits, GoalRecord, GoalStatus, GoalStoreSchema } from './goalTypes';
import { DEFAULT_GOAL_LIMITS, GOALS_SCHEMA_VERSION, GOALS_STORAGE_KEY, GOAL_OPEN_STATUSES, isTerminalGoal } from './goalTypes';

const STATUSES: GoalStatus[] = ['proposed', 'active', 'paused', 'blocked', 'completed', 'abandoned'];

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function clampStr(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.slice(0, maxChars).trim() : '';
}

function strArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const s = clampStr(item, maxChars);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Structural check before repair — cheap and total. */
function looksLikeGoal(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).id === 'string';
}

/** Salvage one persisted record (repair-don't-drop); null when unusable. */
export function repairGoal(raw: unknown, limits: GoalLimits, now: number): GoalRecord | null {
  if (!looksLikeGoal(raw)) return null;
  const rawRec = raw as Record<string, unknown>;
  const id = clampStr(rawRec.id, 64);
  if (!id.startsWith('goal_')) return null;
  const description = clampStr(rawRec.description, limits.maxDescriptionChars);
  if (!description) return null;
  const status: GoalStatus = STATUSES.includes(rawRec.status as GoalStatus) ? (rawRec.status as GoalStatus) : 'proposed';

  const milestones: GoalRecord['milestones'] = [];
  if (Array.isArray(rawRec.milestones)) {
    for (const m of rawRec.milestones) {
      if (!m || typeof m !== 'object') continue;
      const mm = m as Record<string, unknown>;
      const text = clampStr(mm.text, limits.maxItemChars);
      if (!text) continue;
      milestones.push({
        text,
        at: clampInt(mm.at, 0, Number.MAX_SAFE_INTEGER, now),
        ...(typeof mm.sourceTaskId === 'string' && mm.sourceTaskId ? { sourceTaskId: mm.sourceTaskId.slice(0, 64) } : {}),
        outcome: mm.outcome === 'attempt_failed' ? 'attempt_failed' : 'progress',
      });
      if (milestones.length >= limits.maxMilestones) break;
    }
  }

  const progressRaw = (rawRec.progress ?? {}) as Record<string, unknown>;
  const progress = {
    completed: strArray(progressRaw.completed, limits.maxProgressItems, limits.maxItemChars),
    remaining: strArray(progressRaw.remaining, limits.maxProgressItems, limits.maxItemChars),
    blockers: strArray(progressRaw.blockers, limits.maxProgressItems, limits.maxItemChars),
  };

  const projectRefs: GoalRecord['projectRefs'] = [];
  if (Array.isArray(rawRec.projectRefs)) {
    const seenRoots = new Set<string>();
    for (const ref of rawRec.projectRefs) {
      if (!ref || typeof ref !== 'object') continue;
      const rr = ref as Record<string, unknown>;
      const root = clampStr(rr.root, 512);
      if (!root || seenRoots.has(root.toLowerCase())) continue;
      seenRoots.add(root.toLowerCase());
      projectRefs.push({
        projectId: clampStr(rr.projectId, 64),
        root,
        name: clampStr(rr.name, 120),
      });
      if (projectRefs.length >= limits.maxProjectRefs) break;
    }
  }

  const blockedByGoalIds: string[] = [];
  if (Array.isArray(rawRec.blockedByGoalIds)) {
    for (const b of rawRec.blockedByGoalIds) {
      const s = clampStr(b, 64);
      if (s && s.startsWith('goal_') && !blockedByGoalIds.includes(s)) blockedByGoalIds.push(s);
      if (blockedByGoalIds.length >= limits.maxProgressItems) break;
    }
  }

  const createdAt = clampInt(rawRec.createdAt, 0, Number.MAX_SAFE_INTEGER, now);
  const updatedAt = clampInt(rawRec.updatedAt, createdAt, Number.MAX_SAFE_INTEGER, now);

  return {
    id,
    description,
    status,
    ...(clampStr(rawRec.originMessage, limits.maxOriginChars) ? { originMessage: clampStr(rawRec.originMessage, limits.maxOriginChars) } : {}),
    milestones,
    progress,
    projectRefs,
    blockedByGoalIds,
    lastActivityAt: clampInt(rawRec.lastActivityAt, createdAt, Number.MAX_SAFE_INTEGER, updatedAt),
    ...(typeof rawRec.lastBriefedAt === 'number' && Number.isFinite(rawRec.lastBriefedAt) ? { lastBriefedAt: rawRec.lastBriefedAt } : {}),
    createdAt,
    updatedAt,
  };
}

/**
 * The bounded goal store. Every accessor lazy-loads exactly once; mutations
 * persist synchronously and never throw — the in-memory state stays
 * authoritative even when storage fails.
 */
export class GoalStore {
  private goals: GoalRecord[] = [];
  private loaded = false;
  private readonly now: () => number;

  constructor(storage: StorageAdapter = localStorageAdapter, limits?: Partial<GoalLimits>, now?: () => number) {
    this.storage = storage;
    this.limits = { ...DEFAULT_GOAL_LIMITS, ...limits };
    this.now = now ?? Date.now;
  }

  private readonly storage: StorageAdapter;
  /** Bounded limits used for repair and eviction. */
  readonly limits: GoalLimits;

  get records(): GoalRecord[] {
    this.ensureLoaded();
    return this.goals;
  }

  get(id: string): GoalRecord | undefined {
    this.ensureLoaded();
    return this.goals.find((g) => g.id === id);
  }

  /** Insert or replace by id, then persist with cap eviction. */
  upsert(goal: GoalRecord): void {
    this.ensureLoaded();
    const index = this.goals.findIndex((g) => g.id === goal.id);
    if (index === -1) this.goals.push(goal);
    else this.goals[index] = goal;
    this.persist();
  }

  /** Mutate one record in place through a guarded mutator; returns the record. */
  update(id: string, mutator: (goal: GoalRecord) => void): GoalRecord | null {
    const goal = this.get(id);
    if (!goal) return null;
    mutator(goal);
    goal.updatedAt = this.now();
    this.persist();
    return goal;
  }

  remove(id: string): boolean {
    this.ensureLoaded();
    const index = this.goals.findIndex((g) => g.id === id);
    if (index === -1) return false;
    this.goals.splice(index, 1);
    this.persist();
    return true;
  }

  /** Test/diagnostics hook — wipes the store (persisted too). */
  clear(): void {
    this.ensureLoaded();
    this.goals = [];
    this.persist();
  }

  // ------------------------------------------------------------- internals

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.load();
  }

  /** Load with validation, migration, and corruption recovery. Never throws. */
  private load(): void {
    let raw: unknown = null;
    try {
      raw = this.storage.getItem(GOALS_STORAGE_KEY);
    } catch {
      return; // unreadable storage → clean start
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return; // corrupt JSON → clean start (in-memory state stays authoritative)
    }
    const now = this.now();
    let candidates: unknown[];
    if (Array.isArray(parsed)) {
      candidates = parsed; // bare array from a future tool — repair what we can
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const envelope = parsed as Record<string, unknown>;
      const version = typeof envelope.schemaVersion === 'number' ? envelope.schemaVersion : -1;
      if (version > GOALS_SCHEMA_VERSION) {
        // Future schema — do not destroy it, but start clean for this app version.
        return;
      }
      candidates = Array.isArray(envelope.goals) ? envelope.goals : [];
    } else {
      return;
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      const repaired = repairGoal(candidate, this.limits, now);
      if (!repaired || seen.has(repaired.id)) continue;
      seen.add(repaired.id);
      this.goals.push(repaired);
    }
    this.evict();
  }

  private persist(): void {
    this.evict();
    try {
      const envelope: GoalStoreSchema = { schemaVersion: GOALS_SCHEMA_VERSION, goals: this.goals };
      this.storage.setItem(GOALS_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // storage failures are non-fatal — in-memory state stays authoritative
    }
  }

  /**
   * Deterministic eviction when over cap: completed/abandoned (oldest first),
   * then stalest proposed — active/paused/blocked goals are NEVER evicted.
   */
  private evict(): void {
    if (this.goals.length <= this.limits.maxGoals) return;
    // Ascending eviction preference: terminal first, then proposed, open work last.
    const evictable = (g: GoalRecord) => (isTerminalGoal(g.status) ? 0 : g.status === 'proposed' ? 1 : 2);
    const sorted = [...this.goals].sort((a, b) => {
      const ra = evictable(a);
      const rb = evictable(b);
      if (ra !== rb) return ra - rb; // terminal first, then proposed, never open work
      return a.updatedAt - b.updatedAt; // stalest first within a rank
    });
    const excess = this.goals.length - this.limits.maxGoals;
    const removeIds = new Set(sorted.slice(0, excess).filter((g) => evictable(g) < 2).map((g) => g.id));
    if (removeIds.size) this.goals = this.goals.filter((g) => !removeIds.has(g.id));
  }
}

/** Open (non-terminal) goals of a store snapshot — the only lifecycle targets. */
export function openGoals(records: GoalRecord[]): GoalRecord[] {
  return records.filter((g) => GOAL_OPEN_STATUSES.includes(g.status));
}
