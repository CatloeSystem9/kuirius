/**
 * Durable Learning Store — versioned, corruption-tolerant persistence for the
 * Krix Learning Mechanism.
 *
 * Uses the existing `StorageAdapter` contract (taskState.ts) so it works
 * seamlessly in browser (`localStorageAdapter`), Node/server restarts (via
 * `createFileStorageAdapter`), and unit tests (`MemoryStorage`).
 *
 * Persists:
 *  - Acquired concepts (with version history & provenance)
 *  - Concept relationships
 *  - Acquired skills (with validation evidence)
 *  - Structured corrections
 *  - Experience records
 *  - Learning sessions (resumable across restarts)
 *  - Learning-to-learn strategy stats
 *  - Revision requirements
 *  - Bounded learning queue + deduplication keys
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StorageAdapter } from '../taskState';
import { localStorageAdapter } from '../taskState';
import type {
  AcquiredConcept,
  AcquiredSkill,
  ConceptRelationship,
  ExperienceRecord,
  LearningQueueItem,
  LearningSession,
  LearningStrategyStat,
  RevisionRequirement,
  StructuredCorrection,
} from './learningTypes';

export const LEARNING_MECHANISM_SCHEMA_VERSION = 1;
export const LEARNING_MECHANISM_STORAGE_KEY = 'krisha_learning_mechanism_v1';

const MAX_CONCEPTS = 400;
const MAX_SKILLS = 100;
const MAX_CORRECTIONS = 150;
const MAX_EXPERIENCES = 200;
const MAX_SESSIONS = 60;
const MAX_REVISIONS = 100;

export interface LearningMechanismSnapshot {
  schemaVersion: number;
  concepts: Record<string, AcquiredConcept>;
  relationships: Record<string, ConceptRelationship>;
  skills: Record<string, AcquiredSkill>;
  corrections: Record<string, StructuredCorrection>;
  experiences: Record<string, ExperienceRecord>;
  sessions: Record<string, LearningSession>;
  strategies: Record<string, LearningStrategyStat>;
  revisions: Record<string, RevisionRequirement>;
  queue: LearningQueueItem[];
  seenKeys: Array<[string, number]>;
}

function emptySnapshot(): LearningMechanismSnapshot {
  return {
    schemaVersion: LEARNING_MECHANISM_SCHEMA_VERSION,
    concepts: {},
    relationships: {},
    skills: {},
    corrections: {},
    experiences: {},
    sessions: {},
    strategies: {},
    revisions: {},
    queue: [],
    seenKeys: [],
  };
}

/**
 * Node file-backed StorageAdapter with atomic write-then-rename so learning
 * state survives Windows/server/tray restarts without partial-write corruption.
 */
export function createFileStorageAdapter(dirPath: string): StorageAdapter {
  const ensureDir = () => {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  };
  const fileFor = (key: string) =>
    path.join(dirPath, `${key.replace(/[^a-z0-9._-]/gi, '_')}.json`);

  return {
    getItem(key: string): string | null {
      try {
        const target = fileFor(key);
        if (!fs.existsSync(target)) return null;
        return fs.readFileSync(target, 'utf8');
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      ensureDir();
      const target = fileFor(key);
      const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, value, 'utf8');
      fs.renameSync(tmp, target);
    },
    removeItem(key: string): void {
      try {
        const target = fileFor(key);
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {
        // ignore
      }
    },
  };
}

export class LearningStore {
  private readonly storage: StorageAdapter;
  private readonly storageKey: string;
  private state: LearningMechanismSnapshot = emptySnapshot();
  private seenKeysMap = new Map<string, number>();

  constructor(
    storage: StorageAdapter = localStorageAdapter,
    storageKey = LEARNING_MECHANISM_STORAGE_KEY
  ) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.load();
  }

  /** Reload state from underlying StorageAdapter (also used to verify restart persistence). */
  load(): void {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) {
      this.state = emptySnapshot();
      this.seenKeysMap.clear();
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LearningMechanismSnapshot> | null;
      if (!parsed || typeof parsed !== 'object') {
        this.state = emptySnapshot();
        return;
      }
      this.state = {
        schemaVersion: LEARNING_MECHANISM_SCHEMA_VERSION,
        concepts: isRecord(parsed.concepts) ? parsed.concepts : {},
        relationships: isRecord(parsed.relationships) ? parsed.relationships : {},
        skills: isRecord(parsed.skills) ? parsed.skills : {},
        corrections: isRecord(parsed.corrections) ? parsed.corrections : {},
        experiences: isRecord(parsed.experiences) ? parsed.experiences : {},
        sessions: isRecord(parsed.sessions) ? parsed.sessions : {},
        strategies: isRecord(parsed.strategies) ? parsed.strategies : {},
        revisions: isRecord(parsed.revisions) ? parsed.revisions : {},
        queue: Array.isArray(parsed.queue) ? parsed.queue : [],
        seenKeys: Array.isArray(parsed.seenKeys) ? parsed.seenKeys : [],
      };
      this.seenKeysMap = new Map(
        this.state.seenKeys.filter(
          (pair): pair is [string, number] =>
            Array.isArray(pair) &&
            typeof pair[0] === 'string' &&
            typeof pair[1] === 'number'
        )
      );
    } catch {
      this.state = emptySnapshot();
      this.seenKeysMap.clear();
    }
  }

  /** Persist atomically; enforces bounded caps before writing. */
  persist(): void {
    this.enforceCaps();
    this.state.seenKeys = Array.from(this.seenKeysMap.entries()).slice(-500);
    this.storage.setItem(this.storageKey, JSON.stringify(this.state));
  }

  private enforceCaps(): void {
    pruneOldest(this.state.concepts, MAX_CONCEPTS, (c) => c.updatedAt);
    pruneOldest(this.state.skills, MAX_SKILLS, (s) => s.updatedAt);
    pruneOldest(this.state.corrections, MAX_CORRECTIONS, (c) => c.createdAt);
    pruneOldest(this.state.experiences, MAX_EXPERIENCES, (e) => e.timestamp);
    pruneOldest(this.state.sessions, MAX_SESSIONS, (s) => s.updatedAt);
    pruneOldest(this.state.revisions, MAX_REVISIONS, (r) => r.createdAt);
  }

  // ---------------------------------------------------------------- Concepts

  saveConcept(concept: AcquiredConcept): void {
    this.state.concepts[concept.id] = concept;
    this.persist();
  }

  getConcept(id: string): AcquiredConcept | undefined {
    return this.state.concepts[id];
  }

  findConceptByLabel(label: string): AcquiredConcept | undefined {
    const target = label.trim().toLowerCase();
    return Object.values(this.state.concepts).find(
      (c) => c.label.trim().toLowerCase() === target
    );
  }

  getAllConcepts(): AcquiredConcept[] {
    return Object.values(this.state.concepts);
  }

  deleteConcept(id: string): boolean {
    if (!this.state.concepts[id]) return false;
    delete this.state.concepts[id];
    this.persist();
    return true;
  }

  // ----------------------------------------------------------- Relationships

  saveRelationship(rel: ConceptRelationship): void {
    this.state.relationships[rel.id] = rel;
    this.persist();
  }

  getAllRelationships(): ConceptRelationship[] {
    return Object.values(this.state.relationships);
  }

  // ------------------------------------------------------------------ Skills

  saveSkill(skill: AcquiredSkill): void {
    this.state.skills[skill.id] = skill;
    this.persist();
  }

  getSkill(id: string): AcquiredSkill | undefined {
    return this.state.skills[id];
  }

  getAllSkills(): AcquiredSkill[] {
    return Object.values(this.state.skills);
  }

  // ------------------------------------------------------------- Corrections

  saveCorrection(correction: StructuredCorrection): void {
    this.state.corrections[correction.id] = correction;
    this.persist();
  }

  getCorrection(id: string): StructuredCorrection | undefined {
    return this.state.corrections[id];
  }

  getAllCorrections(): StructuredCorrection[] {
    return Object.values(this.state.corrections);
  }

  // ------------------------------------------------------------- Experiences

  saveExperience(exp: ExperienceRecord): void {
    this.state.experiences[exp.id] = exp;
    this.persist();
  }

  getAllExperiences(): ExperienceRecord[] {
    return Object.values(this.state.experiences);
  }

  // ---------------------------------------------------------------- Sessions

  saveSession(session: LearningSession): void {
    this.state.sessions[session.id] = session;
    this.persist();
  }

  getSession(id: string): LearningSession | undefined {
    return this.state.sessions[id];
  }

  getAllSessions(): LearningSession[] {
    return Object.values(this.state.sessions);
  }

  // -------------------------------------------------------------- Strategies

  saveStrategy(strategy: LearningStrategyStat): void {
    this.state.strategies[strategy.id] = strategy;
    this.persist();
  }

  getStrategy(id: string): LearningStrategyStat | undefined {
    return this.state.strategies[id];
  }

  getAllStrategies(): LearningStrategyStat[] {
    return Object.values(this.state.strategies);
  }

  // --------------------------------------------------------------- Revisions

  saveRevision(revision: RevisionRequirement): void {
    this.state.revisions[revision.id] = revision;
    this.persist();
  }

  getAllRevisions(): RevisionRequirement[] {
    return Object.values(this.state.revisions);
  }

  // ------------------------------------------------------------------- Queue

  isDuplicateKey(key: string, deduplicationWindowMs: number, now = Date.now()): boolean {
    const prev = this.seenKeysMap.get(key);
    if (prev !== undefined && now - prev < deduplicationWindowMs) {
      return true;
    }
    return false;
  }

  markKeySeen(key: string, now = Date.now()): void {
    this.seenKeysMap.set(key, now);
  }

  enqueueItem(
    item: LearningQueueItem,
    maxQueueSize: number,
    deduplicationWindowMs: number
  ): boolean {
    const now = Date.now();
    if (this.isDuplicateKey(item.idempotencyKey, deduplicationWindowMs, now)) {
      return false;
    }
    if (this.state.queue.some((q) => q.idempotencyKey === item.idempotencyKey)) {
      return false;
    }

    if (this.state.queue.length >= maxQueueSize) {
      // Drop lowest-priority item if the new item has strictly higher priority;
      // otherwise reject to respect the bounded queue.
      let lowestIdx = -1;
      let lowestPriority = item.priority;
      for (let i = 0; i < this.state.queue.length; i++) {
        if (this.state.queue[i].priority < lowestPriority) {
          lowestPriority = this.state.queue[i].priority;
          lowestIdx = i;
        }
      }
      if (lowestIdx === -1) return false;
      this.state.queue.splice(lowestIdx, 1);
    }

    this.state.queue.push(item);
    this.state.queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    this.markKeySeen(item.idempotencyKey, now);
    this.persist();
    return true;
  }

  dequeueItems(count: number): LearningQueueItem[] {
    if (count <= 0 || this.state.queue.length === 0) return [];
    const active = this.state.queue.filter((q) => !q.cancelled);
    const taken = active.slice(0, count);
    const takenIds = new Set(taken.map((t) => t.id));
    this.state.queue = this.state.queue.filter((q) => !takenIds.has(q.id) && !q.cancelled);
    this.persist();
    return taken;
  }

  cancelQueueItems(predicate: (item: LearningQueueItem) => boolean): number {
    let count = 0;
    for (const item of this.state.queue) {
      if (predicate(item)) {
        item.cancelled = true;
        count++;
      }
    }
    this.state.queue = this.state.queue.filter((q) => !q.cancelled);
    if (count > 0) this.persist();
    return count;
  }

  getQueue(): LearningQueueItem[] {
    return [...this.state.queue];
  }

  clear(): void {
    this.state = emptySnapshot();
    this.seenKeysMap.clear();
    this.storage.removeItem(this.storageKey);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pruneOldest<T>(
  map: Record<string, T>,
  max: number,
  timestampOf: (item: T) => number
): void {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  keys.sort((a, b) => timestampOf(map[a]) - timestampOf(map[b]));
  const toRemove = keys.length - max;
  for (let i = 0; i < toRemove; i++) {
    delete map[keys[i]];
  }
}
