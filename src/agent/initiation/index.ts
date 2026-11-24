/**
 * Initiation Subsystem — autonomous start without being asked.
 * 
 * Features:
 * 1. Persistent Mission Scheduler (heartbeat, morning briefing, nightly maintenance)
 * 2. Reactive Event Triggers (ProcessMonitor telemetry, completed downloads, file/clipboard)
 * 3. Boot-Resume Missions (cross-reboot goal continuity & startup context)
 */

export * from './scheduler';
export * from './eventTriggers';
export * from './bootResume';
export * from './initiationManager';
