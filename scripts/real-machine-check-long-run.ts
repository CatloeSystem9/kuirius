/**
 * Real-machine verification — official Phase 19: Long-Run Autonomy.
 * Usage: npx tsx scripts/real-machine-check-long-run.ts   (needs the local server)
 *
 * Safe, disposable, local operations only (a fresh temp directory, cleaned up):
 *   1. long-running task creation + execution + per-step checkpoints
 *   2. pause (in-flight step cancelled safely, state checkpointed)
 *   3. validated resume (completed steps NOT re-executed, no duplicate side effect)
 *   4. bounded adaptive waiting on a real filesystem condition
 *   5. interruption + recovery via Phase 11 (transient failure retried once)
 *   6. failure handling (unrecoverable -> honest FAILED with reason)
 *   7. duplicate-action prevention (UNKNOWN outcome blocks resume)
 *   8. expired/revoked permission blocks the action (Phase 18)
 *   9. emergency stop blocks side effects; read-only continues; recovery works
 *  10. cancellation is terminal
 *  11. checkpoint cleanup (bounded retention)
 *  12. restart behavior: new manager over the same storage restores safely
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore } from '../src/agent/taskState';
import { MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import { LongRunManager } from '../src/agent/longrun';
import { EmergencyStop, SafetyAuditLog, SafetyGate, ScopedPermissionManager } from '../src/agent/safety';
import { FilesystemService, ApplicationService } from '../src/agent/system/systemServices';
import { HttpFsBackend, HttpAppBackend, setSystemBackendBaseUrl } from '../src/agent/system/httpSystem';
import { createSystemTools } from '../src/agent/system/systemTools';
import type { PlanStep } from '../src/agent/types';

const BASE = 'http://localhost:3000';
setSystemBackendBaseUrl(BASE);

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become healthy — start it with: npm run dev');
}

function waitUntilLocal(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const loop = () => {
      if (check()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(loop, 20);
    };
    loop();
  });
}

async function main() {
  await waitForHealth();
  console.log('server healthy');
  let failures = 0;
  const check = (condition: boolean, label: string) => {
    if (condition) console.log(`  PASS  ${label}`);
    else {
      failures++;
      console.error(`  FAIL  ${label}`);
    }
  };

  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  permissions.grant('filesystem.write');
  const audit = new SafetyAuditLog();
  const fsService = new FilesystemService({ fs: new HttpFsBackend(), events: bus });
  const apps = new ApplicationService({ fs: new HttpFsBackend(), apps: new HttpAppBackend(), events: bus });
  registry.registerAll(createSystemTools(fsService, apps));
  const planning = new PlanEngine({ registry, events: bus, permissions });
  const core = new AgentCore({
    registry,
    events: bus,
    store: new TaskStore(),
    permissions,
    planning,
    stepTimeoutMs: 30_000,
    maxAttemptsPerStep: 1,
  });
  const longRunStorage = new MemoryStorage();
  const manager = new LongRunManager(core, bus, { audit, storage: longRunStorage });
  manager.attach();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krisha-longrun-'));
  const tempFile = (name: string) => path.join(tempDir, name);
  const inject = (steps: PlanStep[], goal: string): void => {
    Object.defineProperty(core, 'planner', {
      value: { makePlan: () => ({ goal: { description: goal, rawInput: goal, kind: 'command' as const }, steps, createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null },
      configurable: true,
    });
  };

  function waitSession(taskId: string, states: string[], timeoutMs = 15_000): Promise<boolean> {
    return waitUntilLocal(() => states.includes(manager.listSessions().find((s) => s.taskId === taskId)?.state ?? ''), timeoutMs);
  }

  try {
    // 1-3: creation, execution, checkpoints.
    console.log('\n[1-3] long-run creation, execution, checkpoints');
    const plannedSteps: PlanStep[] = [
      { id: 'r1', description: 'List the temp directory', toolName: 'filesystem.list', capability: 'filesystem.list', input: { path: tempDir }, status: 'pending', attempts: 0 },
      { id: 'w1', description: 'Create the planned file', toolName: 'filesystem.create', capability: 'filesystem.create', input: { path: tempFile('planned.txt'), type: 'file', content: 'long-run planned write' }, status: 'pending', attempts: 0 },
    ];
    inject(plannedSteps, 'create planned file');
    const started = manager.start('create planned file');
    check(started.started, 'long-running session started');
    const created = await waitUntilLocal(() => fs.existsSync(tempFile('planned.txt')));
    check(created, 'planned file created on the real filesystem');
    const doneOk = await waitSession(started.taskId, ['COMPLETED']);
    check(doneOk, 'session COMPLETED');
    check(manager.checkpointCount() >= 1, 'checkpoints persisted');

    // 2-3: pause mid-task, resume with no duplicate side effect.
    console.log('\n[pause/resume] checkpoint, validated resume, no duplicates');
    let writeCalls = 0;
    let holdRelease: () => void = () => {};
    const holdPromise = new Promise<void>((r) => { holdRelease = r; });
    registry.register({
      name: 'longrun.holdwrite',
      description: 'controllable hold write',
      category: 'test',
      riskLevel: 'medium',
      capabilities: ['longrun.holdwrite'],
      permissions: ['filesystem.write'],
      timeoutMs: 60_000,
      execute: async (input: Record<string, unknown>, toolCtx: any) => {
        const p = String(input.path ?? '');
        await holdPromise;
        if (toolCtx.signal.aborted) return { success: false, error: 'cancelled before write', errorKind: 'cancelled' };
        fs.writeFileSync(p, 'written after resume');
        writeCalls++;
        return { success: true, output: { written: true, afterResume: true }, verified: true };
      },
    } as never);
    const slowSteps: PlanStep[] = [
      { id: 'r1', description: 'List the temp directory', toolName: 'filesystem.list', capability: 'filesystem.list', input: { path: tempDir }, status: 'pending', attempts: 0 },
      { id: 'w1', description: 'Held write', toolName: 'longrun.holdwrite', capability: 'longrun.holdwrite', input: { path: tempFile('slow.txt') }, status: 'pending', attempts: 0 },
      { id: 'r2', description: 'Verify the file', toolName: 'filesystem.inspect', capability: 'filesystem.inspect', input: { path: tempFile('slow.txt') }, status: 'pending', attempts: 0 },
    ];
    inject(slowSteps, 'slow planned write');
    const slow = manager.start('slow planned write');
    check(slow.started, 'slow session started');
    await waitSession(slow.taskId, ['RUNNING']);
    await new Promise((r) => setTimeout(r, 150)); // let the held write start
    const paused = manager.pause(slow.taskId, 'user pause mid-task');
    check(paused.paused, 'pause accepted mid-task');
    holdRelease();
    const pausedOk = await waitSession(slow.taskId, ['PAUSED']);
    check(pausedOk, 'session PAUSED (in-flight step cancelled safely, state checkpointed)');
    check(writeCalls === 0, 'the paused write never completed (no duplicate)');

    const resumed = await manager.resume(slow.taskId);
    check(resumed.resumed, `validated resume accepted (${resumed.reason ?? 'ok'})`);
    const resumedDone = await waitSession(slow.taskId, ['COMPLETED']);
    check(resumedDone, 'resumed session COMPLETED');
    check(writeCalls === 1, `the interrupted write executed exactly once after resume (writeCalls ${writeCalls})`);
    check(fs.existsSync(tempFile('slow.txt')), 'resumed write landed on the real filesystem');

    // Waiting: bounded adaptive wait on a real condition.
    console.log('\n[waiting] bounded adaptive wait');
    let waitPolls = 0;
    const waitSteps: PlanStep[] = [{ id: 'r1', description: 'List', toolName: 'filesystem.list', capability: 'filesystem.list', input: { path: tempDir }, status: 'pending', attempts: 0 }];
    inject(waitSteps, 'wait for condition');
    const waitSessionTask = manager.start('wait for condition');
    const waitStart = Date.now();
    const waitResult = await manager.wait(waitSessionTask.taskId, {
      description: 'until the planned file exists',
      timeoutMs: 10_000,
      pollMs: 200,
      maxPollMs: 1_000,
      check: () => { waitPolls++; return fs.existsSync(tempFile('planned.txt')); },
    });
    check(!('blocked' in waitResult) && waitResult.status === 'satisfied', 'wait satisfied on the real condition');
    check(waitPolls <= 6, `adaptive polling bounded (fixed 200ms would poll ~50; got ${waitPolls})`);
    manager.cancel(waitSessionTask.taskId);
    await waitSession(waitSessionTask.taskId, ['CANCELLED']);

    // Interruption + failure handling.
    console.log('\n[recovery/failure] Phase 11 under the session');
    let flakyCalls = 0;
    registry.register({
      name: 'longrun.flaky',
      description: 'flaky test tool',
      category: 'test',
      riskLevel: 'low',
      capabilities: ['longrun.flaky'],
      permissions: [],
      timeoutMs: 30_000,
      execute: async () => {
        flakyCalls++;
        if (flakyCalls === 1) return { success: false, error: 'operation timed out', errorKind: 'timeout' };
        return { success: true, output: { recovered: true }, verified: true };
      },
    } as never);
    const recSteps: PlanStep[] = [{ id: 'f1', description: 'Flaky operation', toolName: 'longrun.flaky', capability: 'longrun.flaky', input: {}, status: 'pending', attempts: 0 }];
    inject(recSteps, 'flaky operation');
    const recovering = manager.start('flaky operation');
    const recoveredOk = await waitSession(recovering.taskId, ['COMPLETED'], 15_000);
    check(recoveredOk && flakyCalls === 2, 'Phase 11 recovery under the session: transient failure retried once, completed');

    const failSteps: PlanStep[] = [
      { id: 'f1', description: 'Read a non-existent file (fails)', toolName: 'filesystem.read', capability: 'filesystem.read', input: { path: tempFile('never-there.txt') }, status: 'pending', attempts: 0 },
    ];
    inject(failSteps, 'failing read');
    const failing = manager.start('failing read');
    const failedOk = await waitSession(failing.taskId, ['FAILED'], 15_000);
    check(failedOk, 'unrecoverable failure -> session FAILED (honest)');
    const failedDiag = manager.listSessions().find((s) => s.taskId === failing.taskId)!;
    check((failedDiag.failureReason ?? '').length > 0, 'failure reason recorded');
    check(failedDiag.toolCalls >= 1, 'tool calls counted into the session budget');

    // Duplicate-action prevention.
    console.log('\n[duplicate] UNKNOWN outcome blocks resume');
    const unkSteps: PlanStep[] = [
      { id: 'u1', description: 'Write with failing verification', toolName: 'filesystem.create', capability: 'filesystem.create', input: { path: tempFile('unknown.txt'), type: 'file', content: 'no marker here' }, status: 'pending', attempts: 0, verification: { type: 'output_contains', expected: 'verification-marker' } },
    ];
    inject(unkSteps, 'unknown outcome write');
    const unknown = manager.start('unknown outcome write');
    await waitUntilLocal(() => manager.listSessions().find((s) => s.taskId === unknown.taskId)?.state === 'FAILED', 15_000);
    const unkCp = (manager as unknown as { checkpoints: { get: (id: string) => any; save: (c: any) => void } }).checkpoints;
    const unkCheckpoint = unkCp.get(unknown.taskId);
    check(unkCheckpoint?.lastAction?.outcome === 'UNKNOWN', 'unverified side-effecting outcome classified UNKNOWN');
    unkCp.save({ ...unkCheckpoint, lifecycle: 'RUNNING' }); // simulate the crash window
    const probeCore = new AgentCore({ registry, events: bus, store: core.store, permissions, planning: new PlanEngine({ registry, events: bus, permissions }), stepTimeoutMs: 30_000, maxAttemptsPerStep: 1 });
    const probeManager = new LongRunManager(probeCore, bus, { audit, storage: longRunStorage });
    const restoredUnknown = probeManager.listSessions().find((s) => s.taskId === unknown.taskId)!;
    check(restoredUnknown.state === 'PAUSED', 'restart restores the session PAUSED (never auto-resumed)');
    const dupRefused = await probeManager.resume(unknown.taskId);
    check(dupRefused.resumed === false && String(dupRefused.reason).includes('UNKNOWN'), 'resume refused: UNKNOWN side effect requires external verification first');

    // Permission revocation blocks the action (Phase 18 authoritative).
    console.log('\n[permission] revocation blocks the action');
    permissions.revoke('filesystem.write');
    const permSteps: PlanStep[] = [
      { id: 'p1', description: 'Create after revocation', toolName: 'filesystem.create', capability: 'filesystem.create', input: { path: tempFile('revoked.txt'), type: 'file', content: 'x' }, status: 'pending', attempts: 0 },
    ];
    inject(permSteps, 'write after revocation');
    const permSession = manager.start('write after revocation');
    const permDone = await waitUntilLocal(() => manager.listSessions().find((s) => s.taskId === permSession.taskId)?.state === 'FAILED', 15_000);
    check(permDone, 'revoked permission -> action denied -> session FAILED (no silent continuation)');
    permissions.grant('filesystem.write');

    // Emergency stop through the real gate.
    console.log('\n[emergency] stop blocks side effects');
    const scopedManager = new ScopedPermissionManager();
    const emergencyStop = new EmergencyStop(audit);
    const safetyGate = new SafetyGate({ permissions, scoped: scopedManager, emergencyStop, audit });
    registry.setSafetyGate(safetyGate);
    emergencyStop.onActivate(() => { try { core.cancelAll(); } catch {} });
    emergencyStop.activate('real-machine safety verification');
    const blockedDuring = await registry.execute('filesystem.create', { path: tempFile('blocked.txt'), type: 'file', content: 'x' }, { taskId: 'rm-emergency', stepId: 's', signal: new AbortController().signal, memory: {}, permissions });
    check(!blockedDuring.success, 'side-effecting action blocked during emergency stop');
    const readonlyDuring = await registry.execute('filesystem.list', { path: tempDir }, { taskId: 'rm-emergency', stepId: 's', signal: new AbortController().signal, memory: {}, permissions });
    check(readonlyDuring.success, 'read-only continues during emergency stop');
    emergencyStop.deactivate();
    registry.setSafetyGate(null);

    // Cancellation is terminal.
    console.log('\n[cancel] cancellation is terminal');
    const cancelSteps: PlanStep[] = [{ id: 'c1', description: 'Slow list', toolName: 'filesystem.list', capability: 'filesystem.list', input: { path: tempDir }, status: 'pending', attempts: 0 }];
    inject(cancelSteps, 'cancel me');
    const cancellable = manager.start('cancel me');
    await waitUntilLocal(() => (core as unknown as { store: { list: () => { id: string; status: string }[] } }).store.list().some((t) => t.id === cancellable.taskId && t.status === 'running'));
    manager.cancel(cancellable.taskId, 'user cancellation');
    await waitUntilLocal(() => manager.listSessions().find((s) => s.taskId === cancellable.taskId)?.state === 'CANCELLED');
    const resumeCancelled = await manager.resume(cancellable.taskId);
    check(resumeCancelled.resumed === false, 'cancelled session NEVER resumes');

    // Cleanup + restart scan.
    console.log('\n[cleanup/restart] bounded retention + safe restore');
    manager.cleanup(1);
    check(manager.checkpointCount() <= manager.listSessions().length + 2, 'checkpoint store bounded after cleanup');
    const restartManager = new LongRunManager(core, bus, { audit, storage: longRunStorage });
    check(restartManager.listSessions().every((s) => !['RUNNING', 'WAITING', 'RECOVERING'].includes(s.state)), 'restart scan leaves no session mid-run (PAUSED/BLOCKED at most)');
  } finally {
    registry.setSafetyGate(null);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  }

  console.log(`\nReal-machine check: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exit(1);
  console.log('PHASE 19 (LONG-RUN AUTONOMY) REAL-MACHINE VERIFICATION: PASS');
}

main().catch((err) => {
  console.error('real-machine check failed:', err);
  process.exit(1);
});
