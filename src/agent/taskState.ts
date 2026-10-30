/**
 * Task state store (Phase 1) — persistent state for every active task (spec §12).
 * Injectable storage adapter keeps the core testable under Node; the browser
 * registers a localStorage-backed adapter.
 */
import type { AgentTask, TaskId } from './types';

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory adapter (tests / SSR fallback). */
export class MemoryStorage implements StorageAdapter {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Browser adapter over localStorage. */
export const localStorageAdapter: StorageAdapter = {
  getItem(key) {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {
      // quota — non-fatal for agent operation
    }
  },
  removeItem(key) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

const TASKS_KEY = 'krisha_agent_tasks_v1';
const MAX_PERSISTED_TASKS = 50;

export class TaskStore {
  private tasks = new Map<TaskId, AgentTask>();
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter = localStorageAdapter) {
    this.storage = storage;
    this.load();
  }

  private load(): void {
    const raw = this.storage.getItem(TASKS_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const task of parsed as AgentTask[]) {
          if (task?.id) {
            // Tasks that were mid-flight when the app closed cannot be trusted
            // as "running"; they are marked interrupted (resume comes later).
            if (task.status === 'running' || task.status === 'planning') {
              task.status = 'interrupted';
            }
            this.tasks.set(task.id, task);
          }
        }
      }
    } catch {
      // corrupted state — start clean
    }
  }

  private persist(): void {
    const all = Array.from(this.tasks.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    try {
      this.storage.setItem(TASKS_KEY, JSON.stringify(all.slice(0, MAX_PERSISTED_TASKS)));
    } catch {
      // ignore
    }
  }

  create(goal: AgentTask['goal'], now: number): AgentTask {
    const task: AgentTask = {
      id: 'task_' + now + '_' + Math.random().toString(36).slice(2, 8),
      goal,
      plan: null,
      status: 'planning',
      currentStepIndex: -1,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  get(id: TaskId): AgentTask | undefined {
    return this.tasks.get(id);
  }

  update(id: TaskId, mutator: (task: AgentTask) => void): AgentTask | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    mutator(task);
    task.updatedAt = Date.now();
    this.persist();
    return task;
  }

  list(): AgentTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Bounded read-only sample for diagnostics. Unlike list(), this never sorts
   * or copies the full task collection, so health checks cannot accidentally
   * turn into a task-history scan.
   */
  sample(limit = 20): AgentTask[] {
    const max = Math.max(1, Math.min(Math.floor(limit) || 1, 50));
    const sample: AgentTask[] = [];
    for (const task of this.tasks.values()) {
      sample.push(task);
      if (sample.length >= max) break;
    }
    return sample;
  }

  clear(): void {
    this.tasks.clear();
    this.storage.removeItem(TASKS_KEY);
  }
}
