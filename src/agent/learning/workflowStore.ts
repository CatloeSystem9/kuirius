/**
 * Learning Workflow Store (Phase 12) — bounded, versioned, corruption-tolerant
 * persistence for executable workflow templates and strategy statistics.
 *
 * This is NOT a second memory system: prose knowledge (preferences, episodic
 * records, corrections) stays in the Phase 2 MemoryService. This store holds
 * only structured, executable workflow templates (steps + input templates +
 * confidence) that the planner needs as data — the same data-vs-prose split
 * the TaskStore already uses for task state.
 *
 * Pure data only: learning never writes source code, permissions, or settings.
 */
import type { LearnedWorkflow, WorkflowEvidence, CorrectionRecord } from './learningTypes';
import type { StorageAdapter } from '../taskState';

export const LEARNING_SCHEMA_VERSION = 1;
export const LEARNING_STORAGE_KEY = 'krisha_learning_workflows_v1';

/** Hard caps keep the store lightweight on a normal laptop. */
export const MAX_WORKFLOWS = 40;
export const MAX_EVIDENCE_PER_WORKFLOW = 20;
export const MAX_CORRECTIONS_PER_WORKFLOW = 10;
export const MAX_STRATEGY_ENTRIES = 60;

export interface StrategyStat {
  capability: string;
  successCount: number;
  failureCount: number;
  lastOutcomeAt: number;
}

export interface LearningStoreSchema {
  schemaVersion: number;
  workflows: LearnedWorkflow[];
  strategyStats: StrategyStat[];
}

function clamp01(n: unknown, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function isValidWorkflow(entry: unknown): entry is LearnedWorkflow {
  if (!entry || typeof entry !== 'object') return false;
  const w = entry as Partial<LearnedWorkflow>;
  return (
    typeof w.id === 'string' &&
    w.id.length > 0 &&
    typeof w.name === 'string' &&
    !!w.trigger &&
    typeof w.trigger.goalPattern === 'string' &&
    Array.isArray(w.steps) &&
    w.steps.every((s) => s && typeof s.toolName === 'string' && typeof s.order === 'number') &&
    typeof w.confidence === 'number' &&
    typeof w.status === 'string'
  );
}

/** Repair lightly-damaged records instead of dropping them wholesale. */
function repairWorkflow(entry: Partial<LearnedWorkflow>): LearnedWorkflow | null {
  if (!entry || typeof entry.id !== 'string' || !entry.id) return null;
  if (!entry.trigger || typeof entry.trigger.goalPattern !== 'string') return null;
  if (!Array.isArray(entry.steps)) return null;
  const now = Date.now();
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name ? entry.name : entry.trigger.goalPattern.slice(0, 60),
    trigger: {
      goalPattern: entry.trigger.goalPattern,
      requiredCapabilities: Array.isArray(entry.trigger.requiredCapabilities)
        ? entry.trigger.requiredCapabilities.filter((c) => typeof c === 'string')
        : [],
      domains: Array.isArray(entry.trigger.domains)
        ? entry.trigger.domains.filter((d) => typeof d === 'string')
        : [],
    },
    steps: entry.steps.slice(0, 10),
    dependencies: Array.isArray(entry.dependencies) ? entry.dependencies : undefined,
    knownFailurePoints: Array.isArray(entry.knownFailurePoints) ? entry.knownFailurePoints : undefined,
    corrections: repairCorrections(entry.corrections),
    evidence: Array.isArray(entry.evidence)
      ? (entry.evidence.filter((e) => e && typeof e.outcome === 'string' && typeof e.at === 'number') as WorkflowEvidence[]).slice(-MAX_EVIDENCE_PER_WORKFLOW)
      : [],
    confidence: clamp01(entry.confidence, 0.4),
    status: entry.status === 'superseded' || entry.status === 'disabled' ? entry.status : 'active',
    version: typeof entry.version === 'number' && entry.version >= 1 ? entry.version : 1,
    versionHistory: Array.isArray(entry.versionHistory) ? entry.versionHistory.slice(-10) : [],
    usage: {
      totalUses: typeof entry.usage?.totalUses === 'number' ? entry.usage.totalUses : 0,
      successfulUses: typeof entry.usage?.successfulUses === 'number' ? entry.usage.successfulUses : 0,
      failedUses: typeof entry.usage?.failedUses === 'number' ? entry.usage.failedUses : 0,
      lastUsedAt: typeof entry.usage?.lastUsedAt === 'number' ? entry.usage.lastUsedAt : undefined,
      lastOutcome: typeof entry.usage?.lastOutcome === 'string' ? entry.usage.lastOutcome : undefined,
    },
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : now,
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : now,
  };
}

function repairCorrections(list: unknown): CorrectionRecord[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (c): c is CorrectionRecord =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as CorrectionRecord).id === 'string' &&
        typeof (c as CorrectionRecord).failureSummary === 'string' &&
        typeof (c as CorrectionRecord).correctedAction === 'string'
    )
    .slice(-MAX_CORRECTIONS_PER_WORKFLOW);
}

export class LearningWorkflowStore {
  workflows: LearnedWorkflow[] = [];
  strategyStats = new Map<string, StrategyStat>();
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
    this.load();
  }

  load(): void {
    const raw = this.storage.getItem(LEARNING_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<LearningStoreSchema> | LearnedWorkflow[] | null;
      if (Array.isArray(parsed)) {
        this.workflows = parsed.map((w) => repairWorkflow(w)).filter((w): w is LearnedWorkflow => !!w);
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.workflows)) {
        if ((parsed.schemaVersion as number) <= LEARNING_SCHEMA_VERSION) {
          this.workflows = parsed.workflows.map((w) => repairWorkflow(w)).filter((w): w is LearnedWorkflow => !!w);
        }
        if (Array.isArray(parsed.strategyStats)) {
          for (const stat of parsed.strategyStats) {
            if (stat && typeof stat.capability === 'string') {
              this.strategyStats.set(stat.capability, {
                capability: stat.capability,
                successCount: typeof stat.successCount === 'number' ? stat.successCount : 0,
                failureCount: typeof stat.failureCount === 'number' ? stat.failureCount : 0,
                lastOutcomeAt: typeof stat.lastOutcomeAt === 'number' ? stat.lastOutcomeAt : 0,
              });
            }
          }
        }
      }
    } catch {
      // corrupted state — start clean rather than fail
    }
  }

  persist(): void {
    // Enforce the cap: lowest-confidence, stalest workflows go first.
    if (this.workflows.length > MAX_WORKFLOWS) {
      const rank = (w: LearnedWorkflow): number => w.confidence - (Date.now() - w.updatedAt) / (1000 * 60 * 60 * 24 * 365);
      this.workflows = [...this.workflows].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_WORKFLOWS);
    }

    let stats = Array.from(this.strategyStats.values());
    if (stats.length > MAX_STRATEGY_ENTRIES) {
      stats = stats
        .sort((a, b) => b.successCount + b.failureCount - (a.successCount + a.failureCount))
        .slice(0, MAX_STRATEGY_ENTRIES);
      // Keep the in-memory map consistent with the persisted bound.
      this.strategyStats = new Map(stats.map((s) => [s.capability, s]));
    }

    try {
      const envelope: LearningStoreSchema = {
        schemaVersion: LEARNING_SCHEMA_VERSION,
        workflows: this.workflows,
        strategyStats: stats,
      };
      this.storage.setItem(LEARNING_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // storage failure — keep the in-memory state authoritative
    }
  }

  get(id: string): LearnedWorkflow | undefined {
    return this.workflows.find((w) => w.id === id);
  }

  upsert(workflow: LearnedWorkflow): void {
    const index = this.workflows.findIndex((w) => w.id === workflow.id);
    if (index >= 0) this.workflows[index] = workflow;
    else this.workflows.push(workflow);
    this.persist();
  }

  remove(id: string): boolean {
    const index = this.workflows.findIndex((w) => w.id === id);
    if (index === -1) return false;
    this.workflows.splice(index, 1);
    this.persist();
    return true;
  }

  recordStrategyOutcome(capability: string, success: boolean, at: number): void {
    if (!capability) return;
    const stat = this.strategyStats.get(capability) ?? {
      capability,
      successCount: 0,
      failureCount: 0,
      lastOutcomeAt: at,
    };
    if (success) stat.successCount += 1;
    else stat.failureCount += 1;
    stat.lastOutcomeAt = at;
    this.strategyStats.set(capability, stat);
    this.persist();
  }

  clear(): void {
    this.workflows = [];
    this.strategyStats.clear();
    this.storage.removeItem(LEARNING_STORAGE_KEY);
  }
}
