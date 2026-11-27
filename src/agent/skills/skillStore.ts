/**
 * Learned Skills v1 — bounded, versioned, corruption-tolerant persistence.
 *
 * Same conventions as the Phase 12 LearningWorkflowStore (StorageAdapter,
 * schema-versioned envelope, repair-don't-drop, hard caps) but a SEPARATE
 * bounded key: skills are the curated/validated tier above workflow
 * candidates, and the two stores must not interfere. Structured executable
 * data only — never prose memory, never secrets.
 */
import type { StorageAdapter } from '../taskState';
import type { LearnedSkill, SkillCandidate, SkillStats, SkillValidation, SkillVersionInfo, SkillPrecondition } from './skillTypes';
import {
  MAX_SKILLS,
  MAX_VERSION_HISTORY,
  SKILLS_STORAGE_KEY,
  SKILL_SCHEMA_VERSION,
} from './skillTypes';

export interface SkillStoreSchema {
  schemaVersion: number;
  skills: LearnedSkill[];
  candidates?: SkillCandidate[];
}

function clamp01(n: unknown, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function repairStats(entry: Partial<SkillStats> | undefined): SkillStats {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    totalUses: num(entry?.totalUses),
    successfulUses: num(entry?.successfulUses),
    failedUses: num(entry?.failedUses),
    consecutiveFailures: num(entry?.consecutiveFailures),
    reinforcements: num(entry?.reinforcements),
    lastUsedAt: typeof entry?.lastUsedAt === 'number' ? entry.lastUsedAt : undefined,
    lastOutcome: typeof entry?.lastOutcome === 'string' ? entry.lastOutcome : undefined,
    lastRecordedTaskId: typeof entry?.lastRecordedTaskId === 'string' ? entry.lastRecordedTaskId : undefined,
  };
}

function repairPreconditions(list: unknown): SkillPrecondition[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is SkillPrecondition => {
      if (!p || typeof p !== 'object') return false;
      const kind = (p as SkillPrecondition).kind;
      if (kind === 'tool_available') return typeof (p as any).tool === 'string';
      if (kind === 'permission_granted') return typeof (p as any).permission === 'string';
      return false;
    })
    .slice(0, 12);
}

function isValidSkill(entry: unknown): entry is LearnedSkill {
  if (!entry || typeof entry !== 'object') return false;
  const s = entry as Partial<LearnedSkill>;
  return (
    typeof s.id === 'string' &&
    s.id.length > 0 &&
    typeof s.trigger?.goalPattern === 'string' &&
    Array.isArray(s.steps) &&
    s.steps.every((step) => step && typeof step.toolName === 'string' && typeof step.order === 'number') &&
    typeof s.reliability === 'number' &&
    typeof s.status === 'string' &&
    !!s.validation &&
    typeof s.validation.status === 'string'
  );
}

/** Repair a lightly-damaged record instead of dropping it wholesale. */
function repairSkill(entry: Partial<LearnedSkill>): LearnedSkill | null {
  if (!entry || typeof entry.id !== 'string' || !entry.id) return null;
  if (!entry.trigger || typeof entry.trigger.goalPattern !== 'string') return null;
  if (!Array.isArray(entry.steps)) return null;
  const now = Date.now();
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name ? entry.name : entry.trigger.goalPattern.slice(0, 60),
    description: typeof entry.description === 'string' ? entry.description : '',
    purpose: typeof entry.purpose === 'string' ? entry.purpose : entry.trigger.goalPattern,
    trigger: {
      goalPattern: entry.trigger.goalPattern,
      keywords: Array.isArray(entry.trigger.keywords) ? entry.trigger.keywords.filter((k) => typeof k === 'string').slice(0, 8) : [],
      domains: Array.isArray(entry.trigger.domains) ? entry.trigger.domains.filter((d) => typeof d === 'string') : [],
    },
    steps: entry.steps.slice(0, 10),
    preconditions: repairPreconditions(entry.preconditions),
    requiredTools: Array.isArray(entry.requiredTools) ? entry.requiredTools.filter((t) => typeof t === 'string').slice(0, 10) : [],
    requiredPermissions: Array.isArray(entry.requiredPermissions) ? entry.requiredPermissions.filter((p) => typeof p === 'string').slice(0, 10) : [],
    expectedOutcome: typeof entry.expectedOutcome === 'string' ? entry.expectedOutcome : '',
    sensitive: entry.sensitive === true,
    provenance: {
      sourceTaskId: typeof entry.provenance?.sourceTaskId === 'string' ? entry.provenance.sourceTaskId : 'unknown',
      sourceWorkflowId: typeof entry.provenance?.sourceWorkflowId === 'string' ? entry.provenance.sourceWorkflowId : undefined,
      learnedAt: typeof entry.provenance?.learnedAt === 'number' ? entry.provenance.learnedAt : now,
      verificationReason: typeof entry.provenance?.verificationReason === 'string' ? entry.provenance.verificationReason.slice(0, 200) : '',
    },
    validation: {
      status: entry.validation?.status === 'validated' ? 'validated' : 'rejected',
      errors: Array.isArray(entry.validation?.errors) ? entry.validation.errors.filter((e) => typeof e === 'string').slice(0, 8) : [],
      warnings: Array.isArray(entry.validation?.warnings) ? entry.validation.warnings.filter((w) => typeof w === 'string').slice(0, 8) : [],
      checkedAt: typeof entry.validation?.checkedAt === 'number' ? entry.validation.checkedAt : now,
    },
    status: entry.status === 'disabled' ? 'disabled' : 'active',
    version: typeof entry.version === 'number' && entry.version >= 1 ? entry.version : 1,
    versionHistory: (Array.isArray(entry.versionHistory) ? entry.versionHistory : [])
      .filter((v): v is SkillVersionInfo => !!v && typeof v.version === 'number' && typeof v.createdAt === 'number')
      .slice(-MAX_VERSION_HISTORY),
    stats: repairStats(entry.stats),
    reliability: clamp01(entry.reliability, 0.55),
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : now,
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : now,
  };
}

export class SkillStore {
  skills: LearnedSkill[] = [];
  candidates: SkillCandidate[] = [];
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
    this.load();
  }

  load(): void {
    const raw = this.storage.getItem(SKILLS_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<SkillStoreSchema> | LearnedSkill[] | null;
      if (Array.isArray(parsed)) {
        this.skills = parsed.map((s) => repairSkill(s)).filter((s): s is LearnedSkill => !!s);
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.skills)) {
        // Future schema versions are never loaded (fail clean, not corrupt).
        if ((parsed.schemaVersion as number) <= SKILL_SCHEMA_VERSION) {
          this.skills = parsed.skills.map((s) => repairSkill(s)).filter((s): s is LearnedSkill => !!s);
          this.candidates = Array.isArray(parsed.candidates)
            ? parsed.candidates.filter((c): c is SkillCandidate => !!c && typeof c.id === 'string' && typeof c.goalPattern === 'string' && typeof c.stepSignature === 'string' && typeof c.successes === 'number').slice(-30)
            : [];
        }
      }
    } catch {
      // corrupted state — start clean rather than fail
    }
  }

  persist(): void {
    // Enforce the cap: least reliable and stalest skills go first.
    if (this.skills.length > MAX_SKILLS) {
      const rank = (s: LearnedSkill): number => s.reliability - (Date.now() - s.updatedAt) / (1000 * 60 * 60 * 24 * 365);
      this.skills = [...this.skills].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_SKILLS);
    }
    try {
      const envelope: SkillStoreSchema = { schemaVersion: SKILL_SCHEMA_VERSION, skills: this.skills, candidates: this.candidates.slice(-30) };
      this.storage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // storage failure — keep the in-memory state authoritative
    }
  }

  get(id: string): LearnedSkill | undefined {
    return this.skills.find((s) => s.id === id);
  }

  upsert(skill: LearnedSkill): void {
    const index = this.skills.findIndex((s) => s.id === skill.id);
    if (index >= 0) this.skills[index] = skill;
    else this.skills.push(skill);
    this.persist();
  }

  remove(id: string): boolean {
    const index = this.skills.findIndex((s) => s.id === id);
    if (index === -1) return false;
    this.skills.splice(index, 1);
    this.persist();
    return true;
  }

  /** Record a matching verified manual flow; returns its bounded evidence count. */
  recordCandidate(goalPattern: string, stepSignature: string, taskId: string): number {
    const match = this.candidates.find((c) => c.stepSignature === stepSignature && c.goalPattern === goalPattern);
    const now = Date.now();
    if (match) {
      if (match.lastTaskId !== taskId) match.successes += 1;
      match.lastTaskId = taskId;
      match.updatedAt = now;
      this.persist();
      return match.successes;
    }
    this.candidates.push({ id: `skillcand_${now}_${Math.random().toString(36).slice(2, 8)}`, goalPattern, stepSignature, successes: 1, firstTaskId: taskId, lastTaskId: taskId, createdAt: now, updatedAt: now });
    this.persist();
    return 1;
  }

  removeCandidate(goalPattern: string, stepSignature: string): void {
    this.candidates = this.candidates.filter((c) => c.goalPattern !== goalPattern || c.stepSignature !== stepSignature);
    this.persist();
  }

  clear(): void {
    this.skills = [];
    this.candidates = [];
    this.storage.removeItem(SKILLS_STORAGE_KEY);
  }
}
