/**
 * Persistent Rule & Mission Scheduler (Initiation Subsystem)
 * 
 * Provides time-triggered autonomous missions:
 * - Morning briefing (daily at scheduled hour e.g. 09:00)
 * - Nightly maintenance & reflection (daily at scheduled hour e.g. 23:00)
 * - Periodic downloads & workspace checks (interval e.g. every 30 mins)
 * - Custom time-triggered user/agent missions
 * 
 * Persistent across reboots via JSON store on disk.
 * Driven by an unref'd heartbeat timer so it never hangs Node processes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type MissionTrigger =
  | { type: 'daily'; time: string } // "HH:mm" 24-hour format, e.g. "09:00"
  | { type: 'interval'; intervalMinutes: number } // e.g. 30
  | { type: 'one_shot'; fireAt: number }; // timestamp ms

export type MissionKind =
  | 'morning_briefing'
  | 'nightly_maintenance'
  | 'periodic_check'
  | 'custom_task';

export interface ScheduledMission {
  id: string;
  name: string;
  description: string;
  kind: MissionKind;
  trigger: MissionTrigger;
  actionPayload?: Record<string, unknown>;
  promptInstruction?: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastResult?: 'success' | 'failure' | 'skipped';
  lastMessage?: string;
  nextRunAt: number;
  runCount: number;
}

export interface MissionExecutionResult {
  success: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface SchedulerOptions {
  storagePath?: string;
  heartbeatIntervalMs?: number;
  now?: () => number;
  onMissionDue?: (mission: ScheduledMission) => Promise<MissionExecutionResult>;
  audit?: (event: { kind: string; missionId: string; [key: string]: unknown }) => void;
}

const DEFAULT_STORE_DIR = path.join(process.cwd(), '.krisha');
const DEFAULT_STORE_FILE = 'scheduled_missions.json';

/**
 * Calculate the next execution timestamp (ms) for a given trigger
 */
export function calculateNextRunTime(trigger: MissionTrigger, now: number): number {
  if (trigger.type === 'one_shot') {
    return trigger.fireAt;
  }

  if (trigger.type === 'interval') {
    const intervalMs = Math.max(1, trigger.intervalMinutes) * 60 * 1000;
    return now + intervalMs;
  }

  if (trigger.type === 'daily') {
    const [hoursStr, minutesStr] = trigger.time.split(':');
    const targetHours = parseInt(hoursStr || '9', 10);
    const targetMinutes = parseInt(minutesStr || '0', 10);

    const d = new Date(now);
    d.setHours(targetHours, targetMinutes, 0, 0);

    if (d.getTime() <= now) {
      // Advance to tomorrow at the target time
      d.setDate(d.getDate() + 1);
    }
    return d.getTime();
  }

  return now + 60 * 60 * 1000; // default 1 hour
}

export class MissionScheduler {
  private missions = new Map<string, ScheduledMission>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly storagePath: string;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;
  private readonly onMissionDue?: (mission: ScheduledMission) => Promise<MissionExecutionResult>;
  private readonly audit?: (event: { kind: string; missionId: string; [key: string]: unknown }) => void;
  private isProcessing = false;

  constructor(options: SchedulerOptions = {}) {
    this.storagePath = options.storagePath || path.join(DEFAULT_STORE_DIR, DEFAULT_STORE_FILE);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 30_000; // 30s heartbeat
    this.now = options.now || (() => Date.now());
    this.onMissionDue = options.onMissionDue;
    this.audit = options.audit;

    this.loadMissions();
    this.ensureDefaultMissions();
  }

  /**
   * Start the heartbeat runner
   */
  public start(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      this.tick().catch((err) => {
        console.warn('[Scheduler] Heartbeat tick error:', err);
      });
    }, this.heartbeatIntervalMs);

    // Unref so the timer never prevents clean Node process shutdown
    this.heartbeatTimer.unref();

    // Run an initial tick to catch any overdue missions on startup
    this.tick().catch(() => {});
  }

  /**
   * Stop the heartbeat runner
   */
  public stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Heartbeat evaluation cycle
   */
  public async tick(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    const now = this.now();

    try {
      for (const mission of this.missions.values()) {
        if (!mission.enabled) continue;

        if (mission.nextRunAt <= now) {
          await this.executeMission(mission);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute a single due mission
   */
  public async executeMission(mission: ScheduledMission): Promise<MissionExecutionResult> {
    const now = this.now();
    this.audit?.({ kind: 'mission_started', missionId: mission.id, name: mission.name });

    let result: MissionExecutionResult = { success: true };
    try {
      if (this.onMissionDue) {
        result = await this.onMissionDue(mission);
      } else {
        result = { success: true, message: 'Heartbeat default execution' };
      }
    } catch (err: any) {
      result = { success: false, message: err?.message || String(err) };
    }

    mission.lastRunAt = now;
    mission.lastResult = result.success ? 'success' : 'failure';
    mission.lastMessage = result.message;
    mission.runCount = (mission.runCount || 0) + 1;

    // Schedule next run
    if (mission.trigger.type === 'one_shot') {
      mission.enabled = false; // Disable one-shot once executed
    } else {
      mission.nextRunAt = calculateNextRunTime(mission.trigger, now);
    }

    this.saveMissions();
    this.audit?.({
      kind: 'mission_completed',
      missionId: mission.id,
      success: result.success,
      nextRunAt: mission.nextRunAt,
    });

    return result;
  }

  /**
   * Add a new scheduled mission
   */
  public addMission(
    mission: Omit<ScheduledMission, 'createdAt' | 'nextRunAt' | 'runCount'>
  ): ScheduledMission {
    const now = this.now();
    const fullMission: ScheduledMission = {
      ...mission,
      createdAt: now,
      runCount: 0,
      nextRunAt: calculateNextRunTime(mission.trigger, now),
    };

    this.missions.set(fullMission.id, fullMission);
    this.saveMissions();
    this.audit?.({ kind: 'mission_added', missionId: fullMission.id, name: fullMission.name });
    return fullMission;
  }

  /**
   * Update an existing mission
   */
  public updateMission(id: string, updates: Partial<ScheduledMission>): ScheduledMission | null {
    const existing = this.missions.get(id);
    if (!existing) return null;

    const updated: ScheduledMission = {
      ...existing,
      ...updates,
      id: existing.id, // ID cannot be changed
    };

    if (updates.trigger) {
      updated.nextRunAt = calculateNextRunTime(updated.trigger, this.now());
    }

    this.missions.set(id, updated);
    this.saveMissions();
    return updated;
  }

  /**
   * Enable or disable a mission
   */
  public toggleMission(id: string, enabled?: boolean): boolean {
    const mission = this.missions.get(id);
    if (!mission) return false;

    mission.enabled = enabled !== undefined ? enabled : !mission.enabled;
    if (mission.enabled && mission.nextRunAt <= this.now()) {
      mission.nextRunAt = calculateNextRunTime(mission.trigger, this.now());
    }
    this.saveMissions();
    return mission.enabled;
  }

  /**
   * Delete a mission
   */
  public removeMission(id: string): boolean {
    const deleted = this.missions.delete(id);
    if (deleted) {
      this.saveMissions();
      this.audit?.({ kind: 'mission_deleted', missionId: id });
    }
    return deleted;
  }

  /**
   * Manually trigger a mission immediately
   */
  public async triggerNow(id: string): Promise<MissionExecutionResult | null> {
    const mission = this.missions.get(id);
    if (!mission) return null;
    return this.executeMission(mission);
  }

  /**
   * Get all registered missions
   */
  public getMissions(): ScheduledMission[] {
    return Array.from(this.missions.values());
  }

  /**
   * Get single mission by ID
   */
  public getMission(id: string): ScheduledMission | undefined {
    return this.missions.get(id);
  }

  /**
   * Ensure standard default missions are registered if none exist
   */
  private ensureDefaultMissions(): void {
    const now = this.now();

    // 1. Morning Briefing Mission (09:00 daily)
    if (!this.missions.has('mission_morning_briefing')) {
      const trigger: MissionTrigger = { type: 'daily', time: '09:00' };
      this.missions.set('mission_morning_briefing', {
        id: 'mission_morning_briefing',
        name: 'Morning Daily Briefing',
        description: 'Prepares morning habit check-in, agenda, and active goal briefing.',
        kind: 'morning_briefing',
        trigger,
        enabled: true,
        createdAt: now,
        nextRunAt: calculateNextRunTime(trigger, now),
        runCount: 0,
      });
    }

    // 2. Nightly Maintenance & Reflection (23:00 daily)
    if (!this.missions.has('mission_nightly_maintenance')) {
      const trigger: MissionTrigger = { type: 'daily', time: '23:00' };
      this.missions.set('mission_nightly_maintenance', {
        id: 'mission_nightly_maintenance',
        name: 'Nightly Reflection & Cleanup',
        description: 'End-of-day reflection on daily accomplishments, log rotation and memory consolidation.',
        kind: 'nightly_maintenance',
        trigger,
        enabled: true,
        createdAt: now,
        nextRunAt: calculateNextRunTime(trigger, now),
        runCount: 0,
      });
    }

    // 3. Periodic Downloads Check (every 30 minutes)
    if (!this.missions.has('mission_downloads_check')) {
      const trigger: MissionTrigger = { type: 'interval', intervalMinutes: 30 };
      this.missions.set('mission_downloads_check', {
        id: 'mission_downloads_check',
        name: 'Periodic Downloads Monitor',
        description: 'Checks Downloads directory for newly completed files and helps organize them.',
        kind: 'periodic_check',
        trigger,
        enabled: true,
        createdAt: now,
        nextRunAt: calculateNextRunTime(trigger, now),
        runCount: 0,
      });
    }

    this.saveMissions();
  }

  /**
   * Load missions from disk
   */
  private loadMissions(): void {
    try {
      if (!fs.existsSync(this.storagePath)) return;
      const raw = fs.readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const m of parsed) {
          if (m && typeof m.id === 'string') {
            this.missions.set(m.id, m);
          }
        }
      }
    } catch (err) {
      console.warn('[Scheduler] Could not load persisted missions (starting clean):', err);
    }
  }

  /**
   * Persist missions to disk atomically
   */
  private saveMissions(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(Array.from(this.missions.values()), null, 2);
      fs.writeFileSync(this.storagePath, data, 'utf8');
    } catch (err) {
      console.warn('[Scheduler] Could not save missions to disk:', err);
    }
  }
}
