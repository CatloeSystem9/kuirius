/**
 * Initiation Subsystem Coordinator
 * 
 * Unifies:
 * 1. Persistent Mission Scheduler (heartbeat, morning briefing, nightly maintenance)
 * 2. Reactive Event Triggers (ProcessMonitor telemetry, Downloads completed, file changes)
 * 3. Boot-Resume Missions (cross-reboot goal continuity and startup briefing)
 */

import { MissionScheduler, type ScheduledMission, type MissionExecutionResult } from './scheduler';
import { EventTriggerEngine, type ReactiveRule, type TriggeredEventPayload } from './eventTriggers';
import { BootResumeManager, type BootResumeBriefing } from './bootResume';
import type { ProcessMonitor } from '../processmonitor/processMonitor';

export interface InitiationSubsystemOptions {
  storageDir?: string;
  processMonitor?: ProcessMonitor;
  onInitiationEvent?: (event: InitiationEventRecord) => Promise<void> | void;
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

  private recentEvents: InitiationEventRecord[] = [];
  private readonly maxEvents = 50;
  private readonly onInitiationEvent?: (event: InitiationEventRecord) => Promise<void> | void;
  private isStarted = false;

  constructor(options: InitiationSubsystemOptions = {}) {
    const storageDir = options.storageDir;
    const now = options.now || (() => Date.now());
    this.onInitiationEvent = options.onInitiationEvent;

    // 1. Scheduler
    this.scheduler = new MissionScheduler({
      storagePath: storageDir ? `${storageDir}/scheduled_missions.json` : undefined,
      now,
      onMissionDue: async (mission) => this.handleMissionDue(mission),
      audit: (e) => options.audit?.({ kind: 'initiation_scheduler', ...e }),
    });

    // 2. Event Triggers
    this.triggers = new EventTriggerEngine({
      storagePath: storageDir ? `${storageDir}/reactive_rules.json` : undefined,
      now,
      onRuleFired: (payload) => this.handleRuleFired(payload),
      audit: (e) => options.audit?.({ kind: 'initiation_trigger', ...e }),
    });

    // 3. Boot Resume
    this.bootResume = new BootResumeManager({
      now,
    });

    // Wire ProcessMonitor if provided
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

    // Check for any boot resumption missions on startup
    const bootReport = this.bootResume.inspectBootGoals();
    if (bootReport.hasUnfinishedGoals && bootReport.primaryGoal) {
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
    };
  }

  /**
   * Get recent initiation events
   */
  public getRecentEvents(): InitiationEventRecord[] {
    return [...this.recentEvents];
  }

  /**
   * Internal handler when a scheduled mission fires
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
    return { success: true, message: `Mission "${mission.name}" initiated` };
  }

  /**
   * Internal handler when a reactive rule fires
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
