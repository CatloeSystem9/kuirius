/**
 * Initiation Subsystem — autonomous start without being asked.
 *
 * Features:
 * 1. Persistent Mission Scheduler (heartbeat, morning briefing, nightly maintenance)
 * 2. Reactive Event Triggers (ProcessMonitor telemetry, completed downloads, file/clipboard)
 * 3. Boot-Resume Missions (cross-reboot goal continuity & startup context)
 *
 * The trigger engine runs in the Node server so it keeps time across reboots;
 * the executor runs in the browser where the agent core and the Phase 18
 * permission gate live. `contracts.ts` is the only shared surface.
 */

export * from './contracts';
export * from './queue';
export * from './fileWatcher';
export * from './scheduler';
export * from './eventTriggers';
export * from './bootResume';
export * from './initiationManager';
