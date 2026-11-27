/**
 * Initiation Subsystem Coordinator
 *
 * Unifies:
 * 1. Persistent Mission Scheduler (heartbeat, morning briefing, nightly maintenance)
 * 2. Reactive Event Triggers (ProcessMonitor telemetry, Downloads completed, file changes)
 * 3. Boot-Resume Missions (cross-reboot goal continuity and startup briefing)
 *
 * The split of responsibility is deliberate:
 *
 *   THIS SIDE (Node, always on)      decides WHEN and WHAT.
 *     scheduler  ->  mission fires
 *     triggers   ->  rule matches
 *     bootResume ->  unfinished goal found
 *                    |
 *                    v
 *              InitiationQueue (durable file)  <-- survives reboot
 *                    |
 *   THE OTHER SIDE (browser)          decides HOW and WHETHER.
 *     claims the record, checks eligibility (quiet hours, user busy),
 *     executes through the agent core, delivers the result to chat.
 *
 * The executor stays in the browser on purpose: that is where the tool
 * registry and the Phase 18 permission gate live. An autonomous mission can
 * never grant itself a permission the user never gave.
 */
import { MissionScheduler, type ScheduledMission, type MissionExecutionResult } from './scheduler';
import { EventTriggerEngine, type ReactiveRule, type TriggeredEventPayload } from './eventTriggers';
import { BootResumeManager, FileGoalStorage, type BootResumeBriefing } from './bootResume';
import { InitiationQueue } from './queue';
import type { ProcessMonitor } from '../processmonitor/processMonitor';
import type { InitiationRecord, InitiationSource } from './contracts';

export interface InitiationSubsystemOptions {
  storageDir?: string;
  processMonitor?: ProcessMonitor;
  /** Directories to watch for file events (approved roots only). */
  watchDirectories?: string[];
  onInitiationEvent?: (event: InitiationEventRecord) => Promise<void> | void;
  /** Called whenever a record lands on the queue (the executor's push hook). */
  onRecordQueued?: (record: InitiationRecord) => void;
  audit?: (event: { kind: string; [key: string]: unknown }) => void;
  now?: () => number;
}

export interface InitiationEventRecord {
  id: string;
  source: 'scheduler' | 'event_trigger' | 'boot_resume';
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

export class InitiationManager {
  public readonly scheduler: MissionScheduler;
  public readonly triggers: EventTriggerEngine;
  public readonly bootResume: BootResumeManager;
  public readonly queue: InitiationQueue;

  private recentEvents: InitiationEventRecord[] = [];
  private readonly maxEvents = 50;
  private readonly onInitiationEvent?: (event: InitiationEventRecord) => Promise<void> | void;
  private readonly onRecordQueued?: (record: InitiationRecord) => void;
  private isStarted = false;

  constructor(options: InitiationSubsystemOptions = {}) {
    const storageDir = options.storageDir;
    const now = options.now || (() => Date.now());
    this.onInitiationEvent = options.onInitiationEvent;
    this.onRecordQueued = options.onRecordQueued;

    // 1. Scheduler — decides WHEN a mission fires.
    this.scheduler = new MissionScheduler({
      storagePath: storageDir ? `${storageDir}/scheduled_missions.json` : undefined,
      now,
      onMissionDue: async (mission) => this.handleMissionDue(mission),
      audit: (e) => options.audit?.({ kind: 'initiation_scheduler', ...e }),
    });

    // 2. Event Triggers — decides THAT something happened.
    this.triggers = new EventTriggerEngine({
      storagePath: storageDir ? `${storageDir}/reactive_rules.json` : undefined,
      watchDirectories: options.watchDirectories,
      now,
      onRuleFired: (payload) => this.handleRuleFired(payload),
      audit: (e) => options.audit?.({ kind: 'initiation_trigger', ...e }),
    });

    // 3. Boot Resume — cross-reboot goal continuity.
    //    The durable goal store MUST live beside the rest of the subsystem
    //    state, otherwise boot-resume reads a different file than the one the
    //    rest of the subsystem writes.
    this.bootResume = new BootResumeManager({
      storage: new FileGoalStorage(storageDir ? `${storageDir}/durable_goals.json` : undefined),
      now,
    });

    // 4. The durable handoff to the executor.
    this.queue = new InitiationQueue({
      storagePath: storageDir ? `${storageDir}/initiation_queue.json` : undefined,
      now,
      audit: (e) => options.audit?.({ kind: 'initiation_queue', ...e }),
    });

    // Wire ProcessMonitor if provided.
    if (options.processMonitor) {
      options.processMonitor.onEvent((pEvent) => {
        this.triggers.handleProcessEvent(pEvent);
      });
    }
  }

  /**
   * Start the initiation subsystem services
   */
  public start(): void {
    if (this.isStarted) return;
    this.isStarted = true;
    this.scheduler.start();
    this.triggers.startDownloadsWatcher();

    // Boot resumption: unfinished goals that survived the reboot become a
    // queued initiation the executor picks up as soon as Krisha is running.
    const bootReport = this.bootResume.inspectBootGoals();
    if (bootReport.hasUnfinishedGoals && bootReport.primaryGoal) {
      this.enqueueInitiation({
        source: 'boot_resume',
        kind: 'boot_resume',
        action: 'suggest',
        title: 'Picking up where we left off',
        message: bootReport.welcomeMessage,
        taskPrompt: this.buildBootResumePrompt(bootReport),
        payload: {
          goalId: bootReport.primaryGoal.goalId,
          description: bootReport.primaryGoal.description,
          totalOpen: bootReport.totalOpenGoals,
          remainingTasks: bootReport.primaryGoal.remainingTasks,
        },
        dedupeKey: 'boot_resume',
      });

      this.recordEvent({
        id: `boot_${Date.now()}`,
        source: 'boot_resume',
        type: 'goal_resumption_ready',
        title: 'Active Goal Resumption',
        message: bootReport.welcomeMessage,
        data: {
          goalId: bootReport.primaryGoal.goalId,
          description: bootReport.primaryGoal.description,
          totalOpen: bootReport.totalOpenGoals,
        },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Stop the initiation subsystem services cleanly
   */
  public stop(): void {
    this.isStarted = false;
    this.scheduler.stop();
    this.triggers.stopDownloadsWatcher();
    this.triggers.stopFileWatcher();
  }

  /**
   * Get subsystem health and summary status
   */
  public getStatus(): {
    isStarted: boolean;
    missionsCount: number;
    enabledMissions: number;
    reactiveRulesCount: number;
    enabledRules: number;
    bootGoalsOpen: number;
    recentEventsCount: number;
    queue: { total: number; pending: number; claimed: number; done: number; failed: number };
  } {
    const missions = this.scheduler.getMissions();
    const rules = this.triggers.getRules();
    const boot = this.bootResume.inspectBootGoals();

    return {
      isStarted: this.isStarted,
      missionsCount: missions.length,
      enabledMissions: missions.filter((m) => m.enabled).length,
      reactiveRulesCount: rules.length,
      enabledRules: rules.filter((r) => r.enabled).length,
      bootGoalsOpen: boot.totalOpenGoals,
      recentEventsCount: this.recentEvents.length,
      queue: this.queue.stats(),
    };
  }

  /**
   * Get recent initiation events
   */
  public getRecentEvents(): InitiationEventRecord[] {
    return [...this.recentEvents];
  }

  /**
   * Apply an executor's report for one record. The originating mission's
   * outcome is updated so the scheduler reflects REAL results, not just
   * "the trigger fired".
   */
  public acknowledge(id: string, success: boolean, summary?: string): boolean {
    const applied = this.queue.acknowledge({ id, success, summary });
    if (!applied) return false;

    // Reflect the executor's outcome on the mission that produced it.
    const record = this.queue.list().find((r) => r.id === id);
    const missionId = record?.payload?.missionId;
    if (typeof missionId === 'string') {
      this.scheduler.updateMission(missionId, {
        lastResult: success ? 'success' : 'failure',
        lastMessage: summary,
      });
    }
    return true;
  }

  // ------------------------------------------------------------- internals

  /**
   * A mission fired — turn it into a queued initiation.
   */
  private async handleMissionDue(mission: ScheduledMission): Promise<MissionExecutionResult> {
    const event: InitiationEventRecord = {
      id: `mission_${mission.id}_${Date.now()}`,
      source: 'scheduler',
      type: mission.kind,
      title: mission.name,
      message: mission.description,
      data: {
        missionId: mission.id,
        kind: mission.kind,
        promptInstruction: mission.promptInstruction,
      },
      timestamp: Date.now(),
    };

    this.recordEvent(event);

    const queued = this.enqueueInitiation({
      source: 'scheduler',
      kind: mission.kind,
      action: mission.action || 'suggest',
      title: mission.name,
      message: mission.description,
      taskPrompt: mission.promptInstruction,
      payload: { missionId: mission.id, kind: mission.kind },
      dedupeKey: `mission:${mission.id}`,
    });

    return queued
      ? { success: true, message: `Queued for delivery (${queued.id})` }
      : { success: false, message: 'Could not queue the mission' };
  }

  /**
   * A reactive rule matched — turn it into a queued initiation.
   */
  private handleRuleFired(payload: TriggeredEventPayload): void {
    const event: InitiationEventRecord = {
      id: `trigger_${payload.ruleId}_${payload.timestamp}`,
      source: 'event_trigger',
      type: payload.eventType,
      title: payload.title,
      message: payload.message,
      data: payload.data,
      timestamp: payload.timestamp,
    };

    this.recordEvent(event);

    this.enqueueInitiation({
      source: 'event_trigger',
      kind: payload.eventType,
      action: payload.action,
      title: payload.title,
      message: payload.message,
      taskPrompt: payload.taskPrompt,
      payload: { ...payload.data, ruleId: payload.ruleId },
      // One pending notification per rule — the latest event replaces the
      // older one instead of stacking up while the browser is closed.
      dedupeKey: `rule:${payload.ruleId}`,
    });
  }

  /**
   * Put a record on the durable queue for the executor to pick up.
   */
  private enqueueInitiation(input: {
    source: InitiationSource;
    kind: string;
    action: InitiationRecord['action'];
    title: string;
    message: string;
    taskPrompt?: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
  }): InitiationRecord | null {
    try {
      const record = this.queue.enqueue({
        id: `init_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        source: input.source,
        kind: input.kind,
        action: input.action,
        title: input.title,
        message: input.message,
        ...(input.taskPrompt ? { taskPrompt: input.taskPrompt } : {}),
        ...(input.payload ? { payload: input.payload } : {}),
        ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
        createdAt: Date.now(),
      });
      try {
        this.onRecordQueued?.(record);
      } catch (err) {
        console.warn('[InitiationManager] Queue listener error:', err);
      }
      return record;
    } catch (err) {
      console.warn('[InitiationManager] Could not queue initiation:', err);
      return null;
    }
  }

  /**
   * The prompt used when resuming an unfinished goal after a reboot.
   */
  private buildBootResumePrompt(report: BootResumeBriefing): string | undefined {
    const primary = report.primaryGoal;
    if (!primary) return undefined;
    const remaining = primary.remainingTasks.length
      ? ` Remaining work: ${primary.remainingTasks.join('; ')}.`
      : '';
    const done = primary.completedMilestones.length
      ? ` Already completed: ${primary.completedMilestones.join('; ')}.`
      : '';
    return `Continue the goal "${primary.description}".${done}${remaining} Tell me where we left off and propose the single next concrete step.`;
  }

  /**
   * Record and broadcast initiation event
   */
  private recordEvent(event: InitiationEventRecord): void {
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.maxEvents) {
      this.recentEvents = this.recentEvents.slice(0, this.maxEvents);
    }

    try {
      this.onInitiationEvent?.(event);
    } catch (err) {
      console.warn('[InitiationManager] Event listener error:', err);
    }
  }
}
