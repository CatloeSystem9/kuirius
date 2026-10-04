/**
 * Real-machine proactive verification check (Phase 15) — safe, reversible.
 *
 * Workflow (spec §18):
 *   0. Abort if the test application is already running (never touch a
 *      window the user has open).
 *   1. Launch "Character Map" through the Phase 9 allowlist surface (same
 *      approach as the Phase 14 check — no safety layer bypassed).
 *   2. Feed real task-lifecycle events to the ProactiveService and verify a
 *      task-completion suggestion is actually PRESENTED (suggestion
 *      verification via verifySuggestionPresented). With only application.launch
 *      granted, the attached screen-observation follow-up correctly requires
 *      explicit confirmation (LEVEL 2) — the honest integrated behavior.
 *   3. Confirm NO unauthorized action occurs: accepting the suggestion is
 *      refused by the real PermissionManager (screen.observation not granted).
 *   4. LEVEL-3 flow: a read-only `application.status` opportunity against the
 *      RUNNING app produces EXECUTE_AFTER_CONFIRMATION; after the explicit
 *      confirmation step the action executes through the real ToolRegistry
 *      with real permission enforcement, and the resulting state is verified
 *      against the real process table.
 *   5. Confirm a destructive action class (filesystem.delete) is hard-blocked
 *      at LEVEL 4 even with everything granted.
 *   6. Close the test application and confirm the process is gone.
 *   7. Confirm no background polling remains (no scheduled checks, no timers).
 */
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { createSystemTools } from '../src/agent/system/systemTools';
import { ApplicationService, FilesystemService } from '../src/agent/system/systemServices';
import { HttpAppBackend, HttpFsBackend, setSystemBackendBaseUrl } from '../src/agent/system/httpSystem';
import { ProactiveService } from '../src/agent/proactive/proactiveService';
import { decide } from '../src/agent/proactive/proactiveDecider';
import { executeConfirmed, verifySuggestionPresented } from '../src/agent/proactive/proactiveActions';
import { opportunityDedupKey } from '../src/agent/proactive/proactiveContext';
import { ProactiveContext } from '../src/agent/proactive/proactiveContext';
import { DEFAULT_BUDGET } from '../src/agent/proactive/proactiveTypes';
import type { ProactiveOpportunity } from '../src/agent/proactive/proactiveTypes';

const BASE = 'http://localhost:3000';
const LAUNCH_NAME = 'Character Map';
const APP_NAME = 'charmap';

async function post(path: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become healthy (start the local server first)');
}

async function main() {
  setSystemBackendBaseUrl(BASE);
  await waitForHealth();
  console.log('server healthy');

  // 0. Guard: never touch a window the user already has open.
  const pre = await post('/api/app/status', { name: APP_NAME });
  if (pre.success && pre.result?.running === true) {
    throw new Error(`${APP_NAME} is already running — refusing to interact with an existing user window. Close it first, then re-run this check.`);
  }

  // 1. Launch through the Phase 9 allowlist surface.
  const launched = await post('/api/app/launch', { name: LAUNCH_NAME });
  if (!launched.success) throw new Error(`launch failed: ${launched.error ?? '?'}`);
  console.log(`1. ${LAUNCH_NAME} launched through the Phase 9 surface`);
  await new Promise((r) => setTimeout(r, 1500));

  const bus = new AgentEventBus();
  const permissions = new PermissionManager();
  permissions.grant('application.launch'); // explicit user grant for this check
  const appService = new ApplicationService({ fs: new HttpFsBackend(), apps: new HttpAppBackend() });
  const fsService = new FilesystemService({ fs: new HttpFsBackend() });
  const registry = new ToolRegistry(bus);
  registry.registerAll(createSystemTools(fsService, appService));
  const service = new ProactiveService({ registry, permissions, events: bus });
  const off = service.attach(bus);

  // 2. Real task lifecycle → task-completion suggestion presented.
  const t0 = Date.now();
  bus.emit({ name: 'USER_MESSAGE', timestamp: t0 });
  bus.emit({ name: 'TASK_COMPLETED', taskId: 'real-check-15', payload: { stepCount: 2 }, timestamp: t0 + 100 });
  const suggestions = service.pendingSuggestions();
  if (suggestions.length !== 1) throw new Error(`expected exactly 1 completion suggestion, got ${suggestions.length}`);
  const sug = suggestions[0];
  const sv = verifySuggestionPresented(sug, service.presentedIdsSnapshot(), Date.now());
  if (!sv.verified) throw new Error('suggestion verification failed');
  if (!sug.text.toLowerCase().includes('complete')) throw new Error(`unexpected suggestion text: "${sug.text}"`);
  if (!sug.confirmationRequired) throw new Error('expected the screen-observation follow-up to require confirmation (screen.observation not granted)');
  console.log(`2. task-completion suggestion presented and verified (level ${sug.level}, confirmation required): "${sug.text}"`);

  // 3. No unauthorized action: the real permission gate refuses the acceptance.
  const accepted = await service.accept(sug.id);
  if (accepted.executed !== false) throw new Error('suggestion accepted without permission executed an action — SAFETY VIOLATION');
  if (!(accepted.reason ?? '').includes('missing permissions')) throw new Error(`expected a permission-gate refusal, got: ${accepted.reason ?? '?'}`);
  console.log(`3. accept() refused by the real PermissionManager (${accepted.reason}) — no unauthorized action`);

  // 4. LEVEL-3: read-only status check requires explicit confirmation.
  const now = Date.now();
  const opp: ProactiveOpportunity = {
    id: 'opp-real-15',
    type: 'task_completed',
    dedupKey: opportunityDedupKey('task_completed', 'real-check-15-l3'),
    createdAt: now,
    expiresAt: now + 10 * 60_000,
    confidence: 0.9,
    importance: 0.7,
    urgency: 0.5,
    expectedBenefit: 0.6,
    intrusiveness: 0.25,
    risk: 'general',
    requiredPermissions: ['application.launch'],
    suggestedAction: {
      toolName: 'application.status',
      input: { name: APP_NAME },
      description: `Check whether ${APP_NAME} is still running (read-only process-table read)`,
      category: 'general',
      requiredPermissions: ['application.launch'],
      reversible: true,
      minLevel: 3,
    },
    triggerSignalIds: [],
    evidence: [{ source: 'task', quote: 'app launched for the proactive real-machine check', timestamp: now, confidence: 0.9 }],
    status: 'DETECTED',
    statusReasons: [],
  };
  const decision = decide({ opportunity: { ...opp }, activity: 'IDLE', grantedPermissions: new Set(['application.launch']), now }, new ProactiveContext(DEFAULT_BUDGET));
  if (decision.action !== 'EXECUTE_AFTER_CONFIRMATION') {
    throw new Error(`expected EXECUTE_AFTER_CONFIRMATION for the read-only level-3 action, got ${decision.action}`);
  }
  // Explicit confirmation (this check acts as the confirming user):
  const exec = await executeConfirmed(opp, registry, permissions, { taskId: 'real-check-15', signal: new AbortController().signal });
  if (!exec.result) throw new Error(`confirmed execution returned no result: ${exec.reason ?? '?'}`);
  if (!exec.result.success) throw new Error(`confirmed execution tool failed: ${exec.result.error ?? JSON.stringify(exec.result)}`);
  const running = (exec.result as { output?: { running?: boolean } }).output?.running;
  if (running !== true) throw new Error(`real process-table status did not confirm the running app: ${JSON.stringify(exec.result)}`);
  console.log(`4. LEVEL-3 confirmed execution verified against the real process table (running=true, pids=${JSON.stringify((exec.result as { output?: { pids?: number[] } }).output?.pids)})`);

  // 5. Destructive class hard-blocked at LEVEL 4.
  const destructive: ProactiveOpportunity = {
    ...opp,
    id: 'opp-real-15-destructive',
    dedupKey: opportunityDedupKey('task_completed', 'real-check-15-destructive'),
    risk: 'destructive',
    suggestedAction: {
      toolName: 'filesystem.delete',
      input: {},
      description: 'delete a file',
      category: 'destructive',
      requiredPermissions: [],
      reversible: false,
      minLevel: 4,
    },
  };
  const dDecision = decide({ opportunity: destructive, activity: 'IDLE', grantedPermissions: new Set(['application.launch']), now }, new ProactiveContext(DEFAULT_BUDGET));
  if (dDecision.action !== 'SUPPRESS' || dDecision.level !== 4) {
    throw new Error(`destructive action not hard-blocked: ${dDecision.action} level ${dDecision.level}`);
  }
  console.log('5. destructive action class hard-blocked at LEVEL 4 (never automatically executed)');

  off();
  service.detach();

  // 6. Cleanup: close the test application, confirm gone.
  const status = await post('/api/app/status', { name: APP_NAME });
  const pids: number[] = status.success ? (status.result?.pids ?? []) : [];
  if (pids.length > 0) {
    const closed = await post('/api/app/close', { pid: pids[0], force: true });
    if (!closed.success) throw new Error(`close failed: ${closed.error ?? '?'}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const after = await post('/api/app/status', { name: APP_NAME });
  if (after.success && after.result?.running === true) throw new Error(`${APP_NAME} still running after cleanup`);
  console.log('6. test application closed and confirmed gone (cleanup verified)');

  // 7. No background polling remains.
  const diag = service.diagnostics();
  if ((diag['budget'] as { scheduled: number }).scheduled !== 0) throw new Error('scheduled checks remain — background polling risk');
  console.log('7. no scheduled checks remain (no background polling)');

  console.log('REAL-MACHINE PROACTIVE CHECK: PASS');
}

main().catch((err) => {
  console.error('REAL-MACHINE PROACTIVE CHECK: FAIL —', err.message);
  // Safety net: never leave the test application behind.
  post('/api/app/status', { name: APP_NAME })
    .then((r) => {
      const pids: number[] = r.success && r.result?.running ? (r.result.pids ?? []) : [];
      if (pids.length > 0) return post('/api/app/close', { pid: pids[0], force: true });
      return null;
    })
    .then(() => process.exit(1));
});
