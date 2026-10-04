/**
 * Real-machine verification — official Phase 16: Advanced Planning.
 * Usage: npx tsx scripts/real-machine-check-planning.ts   (needs the local server)
 *
 * READ-ONLY verification of the hierarchical planning layer against the real
 * environment (real Agent Core, real ToolRegistry, real filesystem tools via
 * the local server):
 *   1. hierarchical plan attach + validation (PLAN_CREATED, coherent snapshot)
 *   2. real multi-domain execution: plan → act → VERIFY → complete
 *   3. adaptive replanning on a real failure: a read of a non-existent path
 *      fails → deterministic diagnosis (real directory listing) is inserted →
 *      retry fails again → repeated-failure guard refuses → honest stop with
 *      the completed work preserved (partial completion)
 * Nothing is written, renamed, or deleted — list/inspect/read only.
 */
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import { FilesystemService, ApplicationService } from '../src/agent/system/systemServices';
import { HttpFsBackend, HttpAppBackend, setSystemBackendBaseUrl } from '../src/agent/system/httpSystem';
import { createSystemTools } from '../src/agent/system/systemTools';
import type { AgentTask, PlanStep } from '../src/agent/types';

const BASE = 'http://localhost:3000';
setSystemBackendBaseUrl(BASE);

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become healthy — start it with: npm run dev');
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
  const fs = new FilesystemService({ fs: new HttpFsBackend(), events: bus });
  const apps = new ApplicationService({ fs: new HttpFsBackend(), apps: new HttpAppBackend(), events: bus });
  registry.registerAll(createSystemTools(fs, apps));

  // Real Phase 16 planning layer over the real tools.
  const engine = new PlanEngine({ registry, events: bus, permissions, limits: { maxReplansPerTask: 1, maxRepeatedFailures: 2 } });
  const store = new TaskStore(new MemoryStorage());
  const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 30_000, maxAttemptsPerStep: 1 });

  const runPlan = async (goal: string, steps: PlanStep[]): Promise<AgentTask> => {
    Object.defineProperty(core, 'planner', {
      value: { makePlan: () => ({ goal: { description: goal, rawInput: goal, kind: 'command' as const }, steps, createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null },
      configurable: true,
    });
    return core.submit(goal);
  };

  // ---- 1+2: hierarchical plan → real execution → verified completion ----
  console.log('\n[1+2] hierarchical plan, real execution, verified completion');
  const task = await runPlan('inspect the real filesystem', [
    { id: 'r1', description: 'List the working directory', toolName: 'filesystem.list', capability: 'filesystem.list', input: { path: '.' }, status: 'pending', attempts: 0 },
    {
      id: 'r2',
      description: 'Verify the listing is readable',
      toolName: 'filesystem.inspect',
      capability: 'filesystem.inspect',
      input: { path: '.' },
      status: 'pending',
      attempts: 0,
      dependsOn: ['r1'],
    },
  ]);
  console.log(`  task status: ${task.status}`);
  check(task.status === 'completed', 'hierarchical plan completed against the real environment');
  const diag = engine.diagnostics(task.id)!;
  check(diag !== undefined && diag.status === 'completed', 'plan diagnostics report completed');
  check(diag.replanCount === 0 && diag.nodeCount > 0, 'no replans needed; plan tree coherent');
  check(bus.recentEvents().some((e) => e.name === 'PLAN_CREATED'), 'PLAN_CREATED emitted');
  check(bus.recentEvents().some((e) => e.name === 'PLAN_COMPLETED'), 'PLAN_COMPLETED emitted');
  const snap = engine.snapshot(task.id)!;
  check(snap.counts.actions >= 2 && snap.counts.completed >= 2, 'snapshot: all actions completed (plan → act → VERIFY)');
  check(snap.nodes.every((n) => n.kind !== 'action' || n.status === 'completed'), 'every action node completed');
  check(snap.nodes.some((n) => n.status === 'completed' && n.verified === true), 'verification results recorded on nodes');

  // ---- 3: adaptive replanning on a real failure (read-only) ----
  console.log('\n[3] adaptive replanning on a real failure');
  const bus2 = new AgentEventBus();
  const registry2 = new ToolRegistry(bus2);
  const fs2 = new FilesystemService({ fs: new HttpFsBackend(), events: bus2 });
  const apps2 = new ApplicationService({ fs: new HttpFsBackend(), apps: new HttpAppBackend(), events: bus2 });
  registry2.registerAll(createSystemTools(fs2, apps2));
  const engine2 = new PlanEngine({ registry: registry2, events: bus2, permissions, limits: { maxReplansPerTask: 1, maxRepeatedFailures: 2 } });
  const core2 = new AgentCore({ registry: registry2, events: bus2, store, permissions, planning: engine2, stepTimeoutMs: 30_000, maxAttemptsPerStep: 1 });
  const mission = 'read a path that does not exist';
  Object.defineProperty(core2, 'planner', {
    value: {
      makePlan: () => ({
        goal: { description: mission, rawInput: mission, kind: 'command' as const },
        steps: [
          { id: 'r1', description: 'List the working directory', toolName: 'filesystem.list', capability: 'filesystem.list', input: { path: '.' }, status: 'pending' as const, attempts: 0 },
          {
            id: 'r2',
            description: 'Read the non-existent target',
            toolName: 'filesystem.read',
            capability: 'filesystem.read',
            input: { path: 'Z:\\definitely\\not\\here\\no-such-file.txt' },
            status: 'pending' as const,
            attempts: 0,
            dependsOn: ['r1'],
          },
        ],
        createdAt: Date.now(),
        revision: 1,
      }),
      proposeAlternative: () => null,
    },
    configurable: true,
  });
  const task2 = await core2.submit(mission);
  console.log(`  task status: ${task2.status}`);
  check(task2.status === 'failed', 'unfulfillable goal stops honestly (no pretend success)');
  const replanned = bus2.recentEvents().filter((e) => e.name === 'PLAN_REPLANNED');
  check(replanned.length === 1, 'deterministic diagnosis + retry inserted once (bounded replanning)');
  const started = bus2.recentEvents().filter((e) => e.name === 'PLAN_NODE_STARTED').map((e) => (e.payload as { description: string }).description);
  check(started.some((d) => d.startsWith('Diagnose:')), 'real diagnosis step executed against the real environment');
  const snap2 = engine2.snapshot(task2.id)!;
  check(snap2.counts.completed >= 1, 'completed work preserved (partial completion, no restart)');
  check(snap2.counts.failed >= 1 && snap2.counts.replans === 1, 'failure + one bounded replan recorded');
  check((engine2.diagnostics(task2.id)?.lastReplanReason ?? '').length > 0, 'replan reason recorded');

  console.log(`\nReal-machine check: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exit(1);
  console.log('PHASE 16 (ADVANCED PLANNING) REAL-MACHINE VERIFICATION: PASS');
}

main().catch((err) => {
  console.error('real-machine check failed:', err);
  process.exit(1);
});
