/**
 * Boot-Resume Missions & Cross-Reboot Goal Continuity
 * 
 * Ensures unfinished goals survive system reboots and browser closures.
 * When Krisha starts at Windows login or server launch, she inspects
 * durable storage for open/in-progress goals, restores context, and
 * prepares an autonomous resumption briefing.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StorageAdapter } from '../taskState';
import type { GoalRecord, GoalStatus, GoalStoreSchema } from '../goals/goalTypes';
import { GOALS_STORAGE_KEY, GOALS_SCHEMA_VERSION, GOAL_OPEN_STATUSES } from '../goals/goalTypes';

const DEFAULT_STORE_DIR = path.join(process.cwd(), '.krisha');
const DEFAULT_GOALS_FILE = 'durable_goals.json';

/**
 * Node.js filesystem-backed StorageAdapter for cross-reboot persistence
 */
export class FileGoalStorage implements StorageAdapter {
  private cache = new Map<string, string>();
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(DEFAULT_STORE_DIR, DEFAULT_GOALS_FILE);
    this.loadFromDisk();
  }

  getItem(key: string): string | null {
    return this.cache.has(key) ? this.cache.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.cache.set(key, value);
    this.saveToDisk();
  }

  removeItem(key: string): void {
    this.cache.delete(key);
    this.saveToDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') {
            this.cache.set(k, v);
          } else {
            this.cache.set(k, JSON.stringify(v));
          }
        }
      }
    } catch (err) {
      console.warn('[BootResume] Could not load durable goals from disk:', err);
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const obj: Record<string, string> = {};
      for (const [k, v] of this.cache.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.warn('[BootResume] Could not save durable goals to disk:', err);
    }
  }
}

export interface BootResumptionItem {
  goalId: string;
  description: string;
  status: GoalStatus;
  milestonesCount: number;
  completedMilestones: string[];
  remainingTasks: string[];
  lastActivityAt: number;
  timeSinceLastActivityHours: number;
}

export interface BootResumeBriefing {
  hasUnfinishedGoals: boolean;
  totalOpenGoals: number;
  primaryGoal?: BootResumptionItem;
  allOpenGoals: BootResumptionItem[];
  welcomeMessage: string;
  generatedAt: number;
}

export class BootResumeManager {
  private readonly storage: StorageAdapter;
  private readonly now: () => number;

  constructor(options: { storage?: StorageAdapter; now?: () => number } = {}) {
    this.storage = options.storage || new FileGoalStorage();
    this.now = options.now || (() => Date.now());
  }

  /**
   * Get all goals stored in durable storage
   */
  public getDurableGoals(): GoalRecord[] {
    const raw = this.storage.getItem(GOALS_STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as GoalStoreSchema;
      return Array.isArray(parsed?.goals) ? parsed.goals : [];
    } catch {
      return [];
    }
  }

  /**
   * Save goals into durable storage
   */
  public saveDurableGoals(goals: GoalRecord[]): void {
    const envelope: GoalStoreSchema = {
      schemaVersion: GOALS_SCHEMA_VERSION,
      goals,
    };
    this.storage.setItem(GOALS_STORAGE_KEY, JSON.stringify(envelope));
  }

  /**
   * Inspect unfinished goals that survived reboot
   */
  public inspectBootGoals(): BootResumeBriefing {
    const now = this.now();
    const allGoals = this.getDurableGoals();

    // Filter open goals ('active' or 'paused')
    const open = allGoals.filter((g) => GOAL_OPEN_STATUSES.includes(g.status));

    // Sort by most recently active first
    open.sort((a, b) => (b.lastActivityAt || b.updatedAt) - (a.lastActivityAt || a.updatedAt));

    const items: BootResumptionItem[] = open.map((g) => {
      const last = g.lastActivityAt || g.updatedAt || g.createdAt || now;
      const hoursAgo = Math.max(0, Math.round(((now - last) / (1000 * 60 * 60)) * 10) / 10);
      return {
        goalId: g.id,
        description: g.description,
        status: g.status,
        milestonesCount: g.milestones?.length || 0,
        completedMilestones: g.progress?.completed || [],
        remainingTasks: g.progress?.remaining || [],
        lastActivityAt: last,
        timeSinceLastActivityHours: hoursAgo,
      };
    });

    const primary = items[0];
    let welcomeMessage = '';

    if (primary) {
      const completedCount = primary.completedMilestones.length;
      if (completedCount > 0) {
        welcomeMessage = `Welcome back! I remembered our active goal: "${primary.description}". You've already completed ${completedCount} milestone${completedCount === 1 ? '' : 's'}. Would you like to resume and continue with the next steps?`;
      } else {
        welcomeMessage = `Welcome back! We have an ongoing goal: "${primary.description}". Ready to pick it back up whenever you are! 💙`;
      }
    } else {
      welcomeMessage = `Welcome back! All previous goals are completed. Let me know what you'd like to work on today! ✨`;
    }

    return {
      hasUnfinishedGoals: items.length > 0,
      totalOpenGoals: items.length,
      primaryGoal: primary,
      allOpenGoals: items,
      welcomeMessage,
      generatedAt: now,
    };
  }

  /**
   * Mark a goal as active or record resumption activity
   */
  public resumeGoal(goalId: string): GoalRecord | null {
    const goals = this.getDurableGoals();
    const target = goals.find((g) => g.id === goalId);
    if (!target) return null;

    target.status = 'active';
    target.lastActivityAt = this.now();
    target.updatedAt = this.now();

    this.saveDurableGoals(goals);
    return target;
  }
}
