/**
 * Initiation Subsystem test suite.
 *
 * Covers the three features and the spine that makes them real:
 *
 *   1. Mission Scheduler  — triggers, catch-up window, one-shot semantics,
 *                           and that a fired mission reaches the QUEUE with
 *                           a real action (not a fake "success").
 *   2. Event Triggers     — process/download/file/clipboard sources, cooldown,
 *                           action dispatch, and the 'create' vs
 *                           'process_created' regression.
 *   3. Boot-Resume        — durable goals survive a restart, the primary goal
 *                           is picked, and a resumable briefing is queued.
 *
 * Plus the cross-process contract:
 *   4. Queue              — leases, expiry, deferral, persistence.
 *   5. Client             — eligibility, the three actions, and the rule that
 *                           a transient skip DEFERS rather than drops.
 *
 * Usage: npx tsx scripts/test-initiation.ts
 * Exits non-zero on any failure.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { InitiationQueue } from '../src/agent/initiation/queue';
import { MissionScheduler, calculateNextRunTime } from '../src/agent/initiation/scheduler';
import { EventTriggerEngine } from '../src/agent/initiation/eventTriggers';
import { BootResumeManager, FileGoalStorage } from '../src/agent/initiation/bootResume';
import { InitiationManager } from '../src/agent/initiation/initiationManager';
import type { InitiationRecord } from '../src/agent/initiation/contracts';
import { InitiationClient, initiationSettingsFromCompanion, isInitiationQuietHour } from '../src/utils/initiationClient';
import type { InitiationSettings } from '../src/utils/initiationClient';

// ------------------------------------------------------------------ harness

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  assert(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);
}

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(nodePath.join(nodeOs.tmpdir(), `krisha-init-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function makeRecord(overrides: Partial<InitiationRecord> = {}): InitiationRecord {
  return {
    id: `init_${Math.random().toString(36).slice(2, 10)}`,
    source: 'scheduler',
    kind: 'custom_task',
    action: 'notify',
    title: 'Test',
    message: 'Test message',
    createdAt: Date.now(),
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

// =========================================================== 1. QUEUE

console.log('\n1. Durable queue — enqueue, lease, ack, defer, persist');
{
  const dir = tempDir('queue');
  const file = nodePath.join(dir, 'queue.json');
  let clock = 1_000_000;
  const queue = new InitiationQueue({ storagePath: file, leaseMs: 1000, now: () => clock });

  const record = queue.enqueue(makeRecord({ id: 'r1', title: 'One', message: 'One' }));
  assertEqual(record.status, 'pending', 'enqueued record starts pending');
  assertEqual(queue.stats().pending, 1, 'one pending record after enqueue');

  // Claim
  const leases = queue.claim('clientA', 5);
  assertEqual(leases.length, 1, 'claim returns the pending record');
  assertEqual(leases[0].record.id, 'r1', 'claimed the right record');
  assertEqual(queue.stats().claimed, 1, 'record is claimed, not pending');

  // A second client must not get the same record while the lease holds.
  const second = queue.claim('clientB', 5);
  assertEqual(second.length, 0, 'a leased record is not handed to a second client');

  // Lease expiry returns the work.
  clock += 2000;
  const afterExpiry = queue.claim('clientB', 5);
  assertEqual(afterExpiry.length, 1, 'an expired lease returns the record to the pool');
  assertEqual(afterExpiry[0].record.id, 'r1', 'the expired record is the same one');

  // Ack
  assert(queue.acknowledge({ id: 'r1', success: true, summary: 'done' }), 'ack is applied');
  assertEqual(queue.stats().done, 1, 'the record is done after a successful ack');
  assertEqual(queue.pending().length, 0, 'nothing is pending after the ack');

  // Persistence: a fresh instance must see the same state.
  const reopened = new InitiationQueue({ storagePath: file, now: () => clock });
  assertEqual(reopened.stats().done, 1, 'the queue survives a restart');
  assertEqual(reopened.list()[0].id, 'r1', 'the record id survives a restart');
}

console.log('\n2. Queue deferral — a postponed record is not handed out early');
{
  const dir = tempDir('defer');
  const file = nodePath.join(dir, 'queue.json');
  let clock = 5_000_000;
  const queue = new InitiationQueue({ storagePath: file, leaseMs: 60_000, now: () => clock });

  queue.enqueue(makeRecord({ id: 'd1', title: 'Deferred', message: 'Deferred' }));
  queue.claim('clientA', 5);
  assert(queue.defer('d1', 30 * 60_000), 'defer succeeds');
  assertEqual(queue.claim('clientB', 5).length, 0, 'a deferred record is not handed out early');

  clock += 31 * 60_000;
  assertEqual(queue.claim('clientB', 5).length, 1, 'the deferred record is handed out once it is due');

  // The deferral budget must be finite — an endless deferral loop is a leak.
  let budget = true;
  for (let i = 0; i < 20 && budget; i++) budget = queue.defer('d1', 1000);
  assert(!budget, 'the deferral budget is exhausted rather than looping forever');
}

console.log('\n2b. Queue dedupe — repeated events collapse to one pending record');
{
  const dir = tempDir('dedupe');
  const file = nodePath.join(dir, 'queue.json');
  const queue = new InitiationQueue({ storagePath: file });

  queue.enqueue(makeRecord({ id: 'e1', dedupeKey: 'rule:vscode', title: 'First' }));
  queue.enqueue(makeRecord({ id: 'e2', dedupeKey: 'rule:vscode', title: 'Second' }));
  queue.enqueue(makeRecord({ id: 'e3', dedupeKey: 'rule:vscode', title: 'Third' }));

  assertEqual(queue.pending().length, 1, 'three events with the same key leave ONE pending record');
  assertEqual(queue.pending()[0].title, 'Third', 'the LATEST event wins');

  // A different key is a different record.
  queue.enqueue(makeRecord({ id: 'e4', dedupeKey: 'rule:terminal', title: 'Other' }));
  assertEqual(queue.pending().length, 2, 'a different key is kept separately');

  // A finished record is not replaced — history stays intact.
  queue.claim('clientA', 5);
  queue.acknowledge({ id: 'e4', success: true, summary: 'done' });
  queue.enqueue(makeRecord({ id: 'e5', dedupeKey: 'rule:terminal', title: 'Newer' }));
  const terminal = queue.list().filter((r) => r.dedupeKey === 'rule:terminal');
  assertEqual(terminal.length, 2, 'a finished record is not overwritten by a newer one');
  assert(
    terminal.some((r) => r.status === 'done') && terminal.some((r) => r.status === 'pending'),
    'the finished record keeps its outcome and the newer one is pending'
  );
}

// =========================================================== 3. SCHEDULER

console.log('\n3. Scheduler — trigger maths');
{
  const base = new Date('2026-03-10T12:00:00').getTime();

  const daily = calculateNextRunTime({ type: 'daily', time: '09:00' }, base);
  const dailyDate = new Date(daily);
  assertEqual(dailyDate.getHours(), 9, 'a daily mission lands at the target hour');
  assertEqual(dailyDate.getDate(), 11, 'a daily mission rolls to tomorrow when today has passed');
  assert(daily > base, 'the next daily run is in the future');

  const interval = calculateNextRunTime({ type: 'interval', intervalMinutes: 30 }, base);
  assertEqual(interval - base, 30 * 60_000, 'an interval mission lands one interval ahead');

  const oneShot = calculateNextRunTime({ type: 'one_shot', fireAt: 12345 }, base);
  assertEqual(oneShot, 12345, 'a one-shot mission keeps its exact fire time');
}

console.log('\n4. Scheduler — a fired mission reaches the queue with a real action');
{
  const dir = tempDir('mission');
  let clock = new Date('2026-03-10T08:59:00').getTime();
  const manager = new InitiationManager({
    storageDir: dir,
    now: () => clock,
  });

  // Fire the morning briefing by hand (deterministic, no waiting for 09:00).
  const result = await manager.scheduler.triggerNow('mission_morning_briefing');
  assert(result?.success === true, 'the mission dispatches successfully');

  const queued = manager.queue.list();
  assertEqual(queued.length, 1, 'the fired mission produced exactly one queued initiation');
  assertEqual(queued[0].source, 'scheduler', 'the record is attributed to the scheduler');
  assertEqual(queued[0].kind, 'morning_briefing', 'the record carries the mission kind');
  assert(queued[0].taskPrompt && queued[0].taskPrompt.length > 0, 'the record carries a task prompt');
  assertEqual(queued[0].action, 'suggest', 'the morning briefing proposes rather than executes');

  // The nightly mission is an execute_task mission.
  await manager.scheduler.triggerNow('mission_nightly_maintenance');
  const all = manager.queue.list();
  const nightly = all.find((r) => r.kind === 'nightly_maintenance');
  assertEqual(nightly?.action, 'execute_task', 'the nightly maintenance mission executes a task');
  assert(!!nightly?.taskPrompt, 'the nightly mission carries a task prompt');

  manager.stop();
}

console.log('\n5. Scheduler — a mission missed beyond the catch-up window is skipped');
{
  const dir = tempDir('stale');
  const now = new Date('2026-03-10T15:00:00').getTime();
  const scheduler = new MissionScheduler({
    storagePath: nodePath.join(dir, 'missions.json'),
    now: () => now,
    catchUpWindowMs: 2 * 60 * 60 * 1000,
  });

  // Force the morning briefing to be long overdue.
  const mission = scheduler.getMission('mission_morning_briefing');
  assert(!!mission, 'the default morning briefing exists');
  mission!.nextRunAt = now - 8 * 60 * 60 * 1000;

  let fired = false;
  scheduler.updateMission('mission_morning_briefing', {});
  const withSpy = new MissionScheduler({
    storagePath: nodePath.join(dir, 'missions2.json'),
    now: () => now,
    catchUpWindowMs: 2 * 60 * 60 * 1000,
    onMissionDue: async () => {
      fired = true;
      return { success: true };
    },
  });
  withSpy.getMission('mission_morning_briefing')!.nextRunAt = now - 8 * 60 * 60 * 1000;
  await withSpy.tick();
  assert(!fired, 'a badly overdue daily mission does NOT fire');
  assertEqual(
    withSpy.getMission('mission_morning_briefing')!.lastResult,
    'skipped',
    'the overdue mission is recorded as skipped'
  );
  assert(
    withSpy.getMission('mission_morning_briefing')!.nextRunAt > now,
    'the overdue mission is rescheduled into the future'
  );
}

console.log('\n6. Scheduler — a one-shot mission disables itself after running');
{
  const dir = tempDir('oneshot');
  const now = Date.now();
  const scheduler = new MissionScheduler({
    storagePath: nodePath.join(dir, 'missions.json'),
    now: () => now,
    onMissionDue: async () => ({ success: true }),
  });
  scheduler.addMission({
    id: 'once',
    name: 'One shot',
    description: 'Runs once',
    kind: 'custom_task',
    trigger: { type: 'one_shot', fireAt: now },
    action: 'notify',
    enabled: true,
  });
  await scheduler.tick();
  assertEqual(scheduler.getMission('once')!.enabled, false, 'the one-shot mission is disabled after its run');
  assertEqual(scheduler.getMission('once')!.runCount, 1, 'the one-shot mission ran exactly once');
}

// =========================================================== 7. EVENT TRIGGERS

console.log('\n7. Event triggers — process events fire (the create/delete kind fix)');
{
  const dir = tempDir('process');
  const fired: string[] = [];
  const engine = new EventTriggerEngine({
    storagePath: nodePath.join(dir, 'rules.json'),
    enableDownloadsWatcher: false,
    onRuleFired: (payload) => {
      fired.push(payload.eventType);
    },
  });

  // The monitor emits kind 'create' — the old code compared against
  // 'process_created', so process rules never fired at all.
  engine.handleProcessEvent({
    kind: 'create',
    pid: 4242,
    name: 'Code.exe',
    at: Date.now(),
    source: 'wmi-worker',
    enriched: true,
  });

  assertEqual(fired.length, 1, "a 'create' process event fires the matching rule");
  assertEqual(fired[0], 'process_started', "the rule fires as 'process_started'");
}

console.log('\n8. Event triggers — cooldown suppresses repeat fires');
{
  const dir = tempDir('cooldown');
  let clock = 1_000_000;
  let fired = 0;
  const engine = new EventTriggerEngine({
    storagePath: nodePath.join(dir, 'rules.json'),
    enableDownloadsWatcher: false,
    now: () => clock,
    onRuleFired: () => {
      fired += 1;
    },
  });

  const event = {
    kind: 'create' as const,
    pid: 1,
    name: 'Code.exe',
    at: clock,
    source: 'wmi-worker' as const,
    enriched: true,
  };
  engine.handleProcessEvent(event);
  assertEqual(fired, 1, 'the first process event fires');
  engine.handleProcessEvent(event);
  assertEqual(fired, 1, 'the second event inside the cooldown does not fire');

  clock += 20 * 60_000; // past the 15 minute VS Code cooldown
  engine.handleProcessEvent(event);
  assertEqual(fired, 2, 'the rule fires again once the cooldown has passed');
}

console.log('\n9. Event triggers — the action type reaches the payload');
{
  const dir = tempDir('action');
  let payload: { action: string; taskPrompt?: string } | null = null;
  const engine = new EventTriggerEngine({
    storagePath: nodePath.join(dir, 'rules.json'),
    enableDownloadsWatcher: false,
    onRuleFired: (p) => {
      payload = { action: p.action, taskPrompt: p.taskPrompt };
    },
  });

  engine.handleDownloadCompleted({
    filename: 'report.pdf',
    fullPath: 'C:/Users/test/Downloads/report.pdf',
    size: 1024,
    extension: '.pdf',
  });

  assertEqual(payload?.action, 'suggest', 'the download rule proposes rather than executing');
  assert(!!payload?.taskPrompt, 'the download rule carries a task prompt');
}

console.log('\n10. Event triggers — clipboard changes are detected without content');
{
  const dir = tempDir('clipboard');
  let fired = 0;
  const engine = new EventTriggerEngine({
    storagePath: nodePath.join(dir, 'rules.json'),
    enableDownloadsWatcher: false,
    onRuleFired: () => {
      fired += 1;
    },
  });

  engine.addRule({
    id: 'clip',
    name: 'Clipboard',
    description: 'Something was copied',
    source: 'clipboard',
    eventType: 'clipboard_text',
    action: { type: 'notify', title: 'Copied', messageTemplate: 'Something was copied.' },
    cooldownMs: 1000,
    enabled: true,
  });

  engine.handleClipboardChanged();
  assertEqual(fired, 1, 'the clipboard rule fires on a clipboard change');
  const records = engine.getRules().find((r) => r.id === 'clip')!;
  assertEqual(records.fireCount, 1, 'the clipboard rule counts the fire');
}

// =========================================================== 11. BOOT RESUME

console.log('\n11. Boot-resume — goals survive a restart and a briefing is queued');
{
  const dir = tempDir('boot');
  const goalsFile = nodePath.join(dir, 'durable_goals.json');

  // Seed the durable store the way the browser would.
  const storage = new FileGoalStorage(goalsFile);
  const manager = new BootResumeManager({ storage });
  const now = Date.now();
  manager.saveDurableGoals([
    {
      id: 'goal_abc',
      description: 'Finish the initiation subsystem',
      status: 'active',
      milestones: [{ text: 'design', at: now }],
      progress: { completed: ['design'], remaining: ['wire it up'], blockers: [] },
      projectRefs: [],
      blockedByGoalIds: [],
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // A fresh manager = a fresh process (reboot).
  const reopened = new BootResumeManager({ storage: new FileGoalStorage(goalsFile) });
  const report = reopened.inspectBootGoals();
  assert(report.hasUnfinishedGoals, 'the unfinished goal survived the restart');
  assertEqual(report.totalOpenGoals, 1, 'the open goal is counted');
  assertEqual(report.primaryGoal?.goalId, 'goal_abc', 'the most recent goal becomes the primary');
  assert(
    report.welcomeMessage.includes('Finish the initiation subsystem'),
    'the welcome message names the goal'
  );

  // The subsystem queues the resumption briefing at startup.
  const manager2 = new InitiationManager({ storageDir: dir });
  manager2.start();
  const queued = manager2.queue.list();
  assertEqual(queued.length, 1, 'startup queues exactly one boot-resume initiation');
  assertEqual(queued[0].source, 'boot_resume', 'the queued record is a boot-resume record');
  assert(!!queued[0].taskPrompt, 'the boot-resume record carries a resume prompt');
  assert(
    queued[0].taskPrompt!.includes('wire it up'),
    'the resume prompt includes the remaining work'
  );
  manager2.stop();
}

console.log('\n12. Boot-resume — the durable store lives beside the rest of the subsystem');
{
  const dir = tempDir('storagedir');
  const manager = new InitiationManager({ storageDir: dir });
  manager.bootResume.saveDurableGoals([
    {
      id: 'goal_1',
      description: 'Stored in the right place',
      status: 'active',
      milestones: [],
      progress: { completed: [], remaining: [], blockers: [] },
      projectRefs: [],
      blockedByGoalIds: [],
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);

  const { existsSync } = await import('node:fs');
  assert(
    existsSync(nodePath.join(dir, 'durable_goals.json')),
    'the durable goal file is written into the configured storage dir'
  );
  assertEqual(manager.bootResume.inspectBootGoals().totalOpenGoals, 1, 'the goal is readable back');
  manager.stop();
}

// =========================================================== 13. CLIENT

console.log('\n13. Client — eligibility and the three actions');

interface ClientOverrides {
  isUserActive?: () => boolean;
  isSpeaking?: () => boolean;
  settings?: Partial<InitiationSettings>;
}

function makeClient(overrides: ClientOverrides = {}) {
  const calls = {
    executed: [] as string[],
    delivered: [] as string[],
    notified: [] as string[],
    acks: [] as any[],
    deferred: [] as Array<{ id: string; delayMs: number }>,
  };
  const settings: InitiationSettings = {
    enabled: true,
    autoExecute: true,
    quietHoursEnabled: false,
    quietStartHour: 23,
    quietEndHour: 8,
    respectUserActivity: false,
    ...(overrides.settings || {}),
  };
  const client = new InitiationClient({
    getSettings: () => settings,
    isUserActive: () => overrides.isUserActive?.() ?? false,
    isSpeaking: () => overrides.isSpeaking?.() ?? false,
    executeTask: async (prompt: string) => {
      calls.executed.push(prompt);
      return { success: true, summary: 'Task finished' };
    },
    deliver: (text: string) => {
      calls.delivered.push(text);
    },
    notify: (text: string) => {
      calls.notified.push(text);
    },
    ack: async (ack: any) => {
      calls.acks.push(ack);
    },
    defer: async (id: string, delayMs: number) => {
      calls.deferred.push({ id, delayMs });
      return true;
    },
    now: () => new Date('2026-03-10T12:00:00').getTime(),
  });
  return { client, calls };
}

{
  // notify
  const { client, calls } = makeClient();
  await client.handleRecord(makeRecord({ id: 'n1', action: 'notify', message: 'Something happened' }));
  assertEqual(calls.notified.length, 1, 'a notify initiation surfaces a notice');
  assertEqual(calls.executed.length, 0, 'a notify initiation runs nothing');
  assertEqual(calls.acks[0]?.success, true, 'a notify initiation is acknowledged');

  // suggest
  const { client: c2, calls: calls2 } = makeClient();
  await c2.handleRecord(makeRecord({ id: 's1', action: 'suggest', message: 'Shall I start?' }));
  assertEqual(calls2.delivered.length, 1, 'a suggest initiation is delivered to the user');
  assertEqual(calls2.executed.length, 0, 'a suggest initiation executes nothing');
  assertEqual(calls2.acks[0]?.success, true, 'a suggest initiation is acknowledged');

  // execute_task
  const { client: c3, calls: calls3 } = makeClient();
  await c3.handleRecord(
    makeRecord({ id: 'e1', action: 'execute_task', message: 'Do it', taskPrompt: 'Do the thing' })
  );
  assertEqual(calls3.executed.length, 1, 'an execute_task initiation runs the task');
  assertEqual(calls3.executed[0], 'Do the thing', 'the task prompt is what gets executed');
  assertEqual(calls3.delivered.length, 1, 'the result is delivered to the user');
  assertEqual(calls3.acks[0]?.success, true, 'a successful task is acknowledged');
}

console.log('\n14. Client — a transient skip DEFERS, a standing state does not');
{
  // Quiet hours -> defer (the work is kept).
  const { client, calls } = makeClient();
  const quiet = new InitiationClient({
    getSettings: () => ({
      enabled: true,
      autoExecute: true,
      quietHoursEnabled: true,
      quietStartHour: 23,
      quietEndHour: 8,
      respectUserActivity: false,
    }),
    isUserActive: () => false,
    isSpeaking: () => false,
    executeTask: async () => ({ success: true, summary: '' }),
    deliver: () => {},
    notify: () => {},
    ack: async (ack: any) => {
      calls.acks.push(ack);
    },
    defer: async (id: string, delayMs: number) => {
      calls.deferred.push({ id, delayMs });
      return true;
    },
    now: () => new Date('2026-03-10T23:30:00').getTime(),
  });
  await quiet.handleRecord(makeRecord({ id: 'q1', action: 'suggest', message: 'Briefing' }));
  assertEqual(calls.deferred.length, 1, 'a quiet-hours skip defers the record');
  assertEqual(calls.acks.length, 0, 'a deferred record is NOT consumed');
  assert(calls.deferred[0].delayMs >= 30 * 60_000, 'the quiet-hours deferral is long enough to matter');
  quiet.stop();

  // Disabled -> no deferral, it is acknowledged as skipped.
  const { client: c2, calls: calls2 } = makeClient();
  const disabled = new InitiationClient({
    getSettings: () => ({
      enabled: false,
      autoExecute: true,
      quietHoursEnabled: false,
      quietStartHour: 23,
      quietEndHour: 8,
      respectUserActivity: false,
    }),
    isUserActive: () => false,
    isSpeaking: () => false,
    executeTask: async () => ({ success: true, summary: '' }),
    deliver: () => {},
    notify: () => {},
    ack: async (ack: any) => {
      calls2.acks.push(ack);
    },
    defer: async (id: string, delayMs: number) => {
      calls2.deferred.push({ id, delayMs });
      return true;
    },
    now: () => new Date('2026-03-10T12:00:00').getTime(),
  });
  await disabled.handleRecord(makeRecord({ id: 'x1', action: 'suggest', message: 'Briefing' }));
  assertEqual(calls2.deferred.length, 0, 'a disabled initiation is not deferred');
  assertEqual(calls2.acks[0]?.skipped, 'disabled', 'a disabled initiation is acknowledged as skipped');
  disabled.stop();
  client.stop();
}

console.log('\n15. Client — auto-execute off means nothing runs');
{
  const calls = { executed: [] as string[] };
  const client = new InitiationClient({
    getSettings: () => ({
      enabled: true,
      autoExecute: false,
      quietHoursEnabled: false,
      quietStartHour: 23,
      quietEndHour: 8,
      respectUserActivity: false,
    }),
    isUserActive: () => false,
    isSpeaking: () => false,
    executeTask: async (prompt: string) => {
      calls.executed.push(prompt);
      return { success: true, summary: '' };
    },
    deliver: () => {},
    notify: () => {},
    ack: async () => {},
    now: () => new Date('2026-03-10T12:00:00').getTime(),
  });
  await client.handleRecord(
    makeRecord({ id: 'ae1', action: 'execute_task', message: 'Do it', taskPrompt: 'Do the thing' })
  );
  assertEqual(calls.executed.length, 0, 'no task runs when auto-execute is off');
  client.stop();
}

console.log('\n16. Client — a user in conversation is never interrupted');
{
  const calls = { delivered: [] as string[], deferred: [] as any[] };
  const client = new InitiationClient({
    getSettings: () => ({
      enabled: true,
      autoExecute: true,
      quietHoursEnabled: false,
      quietStartHour: 23,
      quietEndHour: 8,
      respectUserActivity: true,
    }),
    isUserActive: () => true,
    isSpeaking: () => false,
    executeTask: async () => ({ success: true, summary: '' }),
    deliver: (text: string) => {
      calls.delivered.push(text);
    },
    notify: () => {},
    ack: async () => {},
    defer: async (id: string, delayMs: number) => {
      calls.deferred.push({ id, delayMs });
      return true;
    },
    now: () => new Date('2026-03-10T12:00:00').getTime(),
  });
  await client.handleRecord(makeRecord({ id: 'u1', action: 'suggest', message: 'Briefing' }));
  assertEqual(calls.delivered.length, 0, 'nothing is delivered while the user is talking');
  assertEqual(calls.deferred.length, 1, 'the initiation is postponed instead of dropped');
  client.stop();
}

console.log('\n17. Client — settings and quiet-hour helpers');
{
  const settings = initiationSettingsFromCompanion({});
  assertEqual(settings.enabled, true, 'initiation is on by default');
  assertEqual(settings.autoExecute, true, 'auto-execute is on by default');
  assertEqual(settings.quietHoursEnabled, true, 'quiet hours are on by default');

  const off = initiationSettingsFromCompanion({ initiationEnabled: false });
  assertEqual(off.enabled, false, 'the master switch can be turned off');

  assert(isInitiationQuietHour(23, 23, 8), '23:00 is inside an overnight quiet window');
  assert(isInitiationQuietHour(3, 23, 8), '03:00 is inside an overnight quiet window');
  assert(!isInitiationQuietHour(12, 23, 8), 'noon is outside the quiet window');
  assert(isInitiationQuietHour(10, 9, 17), 'a daytime quiet window includes 10:00');
  assert(isInitiationQuietHour(12, 9, 17), 'a daytime quiet window includes noon');
  assert(!isInitiationQuietHour(18, 9, 17), 'a daytime quiet window excludes the evening');
}

// =========================================================== 18. END TO END

console.log('\n18. End to end — a mission fires, reaches the queue, and is executed');
{
  const dir = tempDir('e2e');
  const manager = new InitiationManager({ storageDir: dir });

  await manager.scheduler.triggerNow('mission_nightly_maintenance');
  const queued = manager.queue.list();
  assertEqual(queued.length, 1, 'the mission produced a queued record');

  // The executor leases it from the durable queue (as the browser does).
  const leases = manager.queue.claim('browser-1', 5);
  assertEqual(leases.length, 1, 'the executor leases the record from the queue');

  const executed: string[] = [];
  const client = new InitiationClient({
    getSettings: () => ({
      enabled: true,
      autoExecute: true,
      quietHoursEnabled: false,
      quietStartHour: 23,
      quietEndHour: 8,
      respectUserActivity: false,
    }),
    isUserActive: () => false,
    isSpeaking: () => false,
    executeTask: async (prompt: string) => {
      executed.push(prompt);
      return { success: true, summary: 'Nightly pass complete.' };
    },
    deliver: () => {},
    notify: () => {},
    ack: async (ack: any) => {
      manager.acknowledge(ack.id, ack.success === true, ack.summary);
    },
    now: () => new Date('2026-03-10T12:00:00').getTime(),
  });

  await client.handleRecord(leases[0].record);
  assertEqual(executed.length, 1, 'the executor ran the task');
  assertEqual(manager.queue.stats().done, 1, 'the record is marked done after the ack');
  assertEqual(
    manager.scheduler.getMission('mission_nightly_maintenance')!.lastResult,
    'success',
    'the mission reflects the real execution outcome'
  );

  client.stop();
  manager.stop();
}

// =========================================================== 19. FILE WATCHER

console.log('\n19. File watcher — a new file in an approved directory fires the rule');
{
  const dir = tempDir('watch');
  const watched = nodePath.join(dir, 'project');
  mkdirSync(watched, { recursive: true });

  let fired = 0;
  let lastEvent: { kind: string; filename: string } | null = null;
  const engine = new EventTriggerEngine({
    storagePath: nodePath.join(dir, 'rules.json'),
    enableDownloadsWatcher: false,
    watchDirectories: [watched],
    onRuleFired: () => {
      fired += 1;
    },
  });

  // The file event arrives through the engine's own file-change path.
  engine.handleFileChange({
    kind: 'file_created',
    path: nodePath.join(watched, 'notes.md'),
    filename: 'notes.md',
    extension: '.md',
    size: 12,
    dir: watched,
  });
  assertEqual(fired, 1, 'a file_created event fires the file rule');

  const rules = engine.getRules();
  const fileRule = rules.find((r) => r.source === 'file');
  assert(!!fileRule, 'a default file rule exists');
  assertEqual(fileRule!.eventType, 'file_created', 'the default file rule watches for new files');
  assertEqual(engine.getWatchedDirectories().length, 1, 'the approved directory is watched');

  // Release the real watcher before cleanup removes the directory.
  engine.stopFileWatcher();
}

// ------------------------------------------------------------------ summary

cleanup();

console.log(`\n${'='.repeat(60)}`);
console.log(`Initiation tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailed assertions:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('All initiation tests passed.');
