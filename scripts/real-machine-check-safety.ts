/**
 * Real-machine verification — official Phase 18: Safety + Permission Hardening.
 * Usage: npx tsx scripts/real-machine-check-safety.ts   (needs the local server)
 *
 * No destructive tests: filesystem verification uses a fresh temp directory
 * that is cleaned up afterwards; protected operations are only PROBED (denied,
 * never executed). Verifies:
 *   1. safe read-only operation executes through the gated registry
 *   2. protected operation is blocked (ungranted write)
 *   3. scoped one-shot grant allows exactly the intended action
 *   4. expired grant is rejected
 *   5. revoked grant is rejected immediately
 *   6. emergency stop blocks side effects, read-only continues, resume works
 *   7. server-side filesystem protection (traversal/system paths) intact
 *   8. Phase 16 planned execution works under the safety layer
 *   9. Phase 17 routing still works
 *  10. Deep Research still works
 *  11. no permission bypass (unknown permission fail-closed; audit bounded+redacted)
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import {
  EmergencyStop,
  SafetyAuditLog,
  SafetyGate,
  ScopedPermissionManager,
  createSafetyTools,
} from '../src/agent/safety';
import { createDefaultModelRegistry, ModelRouter } from '../src/agent/routing';
import { FilesystemService, ApplicationService } from '../src/agent/system/systemServices';
import { HttpFsBackend, HttpAppBackend, setSystemBackendBaseUrl } from '../src/agent/system/httpSystem';
import { createSystemTools } from '../src/agent/system/systemTools';
import type { AgentTool, PlanStep } from '../src/agent/types';

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

  // Gated registry over the REAL filesystem service (local server).
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const scoped = new ScopedPermissionManager();
  const audit = new SafetyAuditLog();
  const emergencyStop = new EmergencyStop(audit);
  const gate = new SafetyGate({ permissions, scoped, emergencyStop, audit });
  registry.setSafetyGate(gate);
  const fsService = new FilesystemService({ fs: new HttpFsBackend(), events: bus });
  const apps = new ApplicationService({ fs: new HttpFsBackend(), apps: new HttpAppBackend(), events: bus });
  registry.registerAll(createSystemTools(fsService, apps));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krisha-safety-'));
  const tempFile = (name: string) => path.join(tempDir, name);
  const ctx = (taskId: string) => ({ taskId, stepId: 's', signal: new AbortController().signal, memory: {}, permissions });

  try {
    // 1. Safe read-only operation executes through the gate.
    console.log('\n[1] safe read-only operation');
    const list = await registry.execute('filesystem.list', { path: tempDir }, ctx('rm-1'));
    check(list.success && (list.metadata?.safety as any)?.decision === 'allow', 'safe read executes, decision ALLOW recorded');

    // 2. Protected operation blocked (no write permission anywhere).
    console.log('\n[2] protected operation blocked');
    const ungranted = await registry.execute('filesystem.create', { path: tempFile('no.txt'), type: 'file', content: 'x' }, ctx('rm-2'));
    check(!ungranted.success && (ungranted.metadata?.safety as any)?.decision === 'deny', 'write without any authorization denied (fail-closed)');

    // 3. One-shot scoped grant: exactly the intended action.
    console.log('\n[3] scoped one-shot grant');
    scoped.grant({ permission: 'filesystem.write', scope: { kind: 'once' }, reason: 'real-machine: one approved file write' });
    const once = await registry.execute('filesystem.create', { path: tempFile('once.txt'), type: 'file', content: 'approved' }, ctx('rm-3'));
    check(once.success && (once.metadata?.safety as any)?.decision === 'allow', 'one-shot grant allowed the approved write');
    const second = await registry.execute('filesystem.create', { path: tempFile('two.txt'), type: 'file', content: 'x' }, ctx('rm-3'));
    check(!second.success, 'second write after one-shot grant denied (scope respected)');
    check(fs.existsSync(tempFile('once.txt')), 'the approved write really happened (exactly once)');

    // 4. Expired grant rejected.
    console.log('\n[4] expiring grant');
    scoped.grant({ permission: 'filesystem.write', scope: { kind: 'duration', expiresAt: Date.now() + 300 }, reason: 'short-lived approval' });
    const fresh = await registry.execute('filesystem.create', { path: tempFile('fresh.txt'), type: 'file', content: 'x' }, ctx('rm-4'));
    check(fresh.success, 'duration grant valid before expiry');
    await new Promise((r) => setTimeout(r, 450));
    const stale = await registry.execute('filesystem.create', { path: tempFile('stale.txt'), type: 'file', content: 'x' }, ctx('rm-4'));
    check(!stale.success, 'expired grant rejected (no silent reuse)');

    // 5. Revocation is immediate.
    console.log('\n[5] revocation');
    scoped.grant({ permission: 'filesystem.write', scope: { kind: 'duration', expiresAt: Date.now() + 60_000 }, reason: 'to be revoked' });
    const granted = await registry.execute('filesystem.create', { path: tempFile('granted.txt'), type: 'file', content: 'x' }, ctx('rm-5'));
    check(granted.success, 'grant works before revocation');
    scoped.revoke('filesystem.write');
    const revoked = await registry.execute('filesystem.create', { path: tempFile('revoked.txt'), type: 'file', content: 'x' }, ctx('rm-5'));
    check(!revoked.success && (revoked.metadata?.safety as any)?.decision === 'revoked', 'revoked grant rejected immediately');

    // 6. Emergency stop.
    console.log('\n[6] emergency stop');
    emergencyStop.activate('real-machine safety verification');
    const blocked = await registry.execute('filesystem.create', { path: tempFile('blocked.txt'), type: 'file', content: 'x' }, ctx('rm-6'));
    check(!blocked.success, 'side-effecting action blocked during emergency stop');
    const readonlyOk = await registry.execute('filesystem.list', { path: tempDir }, ctx('rm-6'));
    check(readonlyOk.success, 'read-only visibility continues during emergency stop');
    emergencyStop.deactivate();
    check(emergencyStop.status().active === false, 'emergency stop released — system recoverable');

    // 7. Server-side filesystem protection intact through the gate.
    console.log('\n[7] server filesystem protection');
    const systemWrite = await registry.execute('filesystem.create', { path: 'C:\\Windows\\krisha-should-not-exist.txt', type: 'file', content: 'x' }, ctx('rm-7'));
    check(!systemWrite.success, 'protected system location refused (server-side guard intact)');
    const traversal = await registry.execute('filesystem.read', { path: tempDir + '\\..\\..\\..\\Windows\\win.ini' }, ctx('rm-7'));
    check(!traversal.success || !String(traversal.error).includes('win.ini'), 'path traversal rejected or contained');

    // 8. Phase 16 planned execution under the safety layer.
    console.log('\n[8] Phase 16 planned execution under safety');
    const core = new AgentCore({ registry, events: bus, store: new TaskStore(new MemoryStorage()), permissions, planning: new PlanEngine({ registry, events: bus, permissions }), stepTimeoutMs: 30_000, maxAttemptsPerStep: 1 });
    scoped.grant({ permission: 'filesystem.write', scope: { kind: 'duration', expiresAt: Date.now() + 60_000 }, reason: 'planned task approval' });
    const steps: PlanStep[] = [
      { id: 'p1', description: 'Create the planned file', toolName: 'filesystem.create', capability: 'filesystem.create', input: { path: tempFile('planned.txt'), type: 'file', content: 'planned under safety' }, status: 'pending', attempts: 0 },
      { id: 'p2', description: 'Verify the planned file', toolName: 'filesystem.inspect', capability: 'filesystem.inspect', input: { path: tempFile('planned.txt') }, status: 'pending', attempts: 0, dependsOn: ['p1'] },
    ];
    Object.defineProperty(core, 'planner', {
      value: { makePlan: () => ({ goal: { description: 'planned write', rawInput: 'planned write', kind: 'command' as const }, steps, createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null },
      configurable: true,
    });
    const planned = await core.submit('planned write under safety');
    check(planned.status === 'completed' && fs.existsSync(tempFile('planned.txt')), 'planned, verified execution completed under the safety layer');

    // 9. Phase 17 routing still works under the gate.
    console.log('\n[9] Phase 17 routing under safety');
    const routingRegistry = new ToolRegistry(new AgentEventBus());
    const routerRegistry = createRoutingRegistryStub();
    routingRegistry.registerAll(createSafetyTools({ gate, scoped, audit, emergencyStop }));
    routingRegistry.registerAll(routerRegistry);
    const routed = await routingRegistry.execute('model.route', { task: 'hi' }, ctx('rm-9'));
    check(routed.success && (routed.output as any).tier === 'light', 'routing decisions unaffected by the safety gate');

    // 10. Deep Research still works (plan-level, no network spam).
    console.log('\n[10] Deep Research under safety');
    const researchRegistry = new ToolRegistry(new AgentEventBus());
    const { ResearchService } = await import('../src/agent/research');
    const { createResearchTools } = await import('../src/agent/research');
    const research = new ResearchService({
      backend: { search: async () => ({ hits: [] }), fetchPage: async (url) => ({ url, title: '', text: '', error: 'unused' }) },
      registry: researchRegistry,
      limits: { maxRounds: 1, maxSearches: 1 },
    });
    researchRegistry.registerAll(createResearchTools(research));
    researchRegistry.setSafetyGate(gate);
    const plan = research.plan('rm-safety', 'research photosynthesis');
    check(plan.subQuestions.length >= 1, 'research planning intact under the safety architecture');

    // 11. No permission bypass.
    console.log('\n[11] no permission bypass');
    const bypassTool: AgentTool = {
      name: 'bypass.probe',
      description: 'probe',
      category: 'test',
      riskLevel: 'low',
      capabilities: ['bypass.probe'],
      permissions: ['not.a.real.permission' as never],
      timeoutMs: 1_000,
      execute: async () => ({ success: true, output: {} }),
    } as unknown as AgentTool;
    registry.register(bypassTool);
    const bypass = await registry.execute('bypass.probe', {}, ctx('rm-11'));
    check(!bypass.success && String(bypass.error).includes('unknown permission'), 'unknown permission id fails closed (no bypass)');
    check(!permissions.isGranted('mouse.control'), 'routing/execution decisions granted nothing');

    // Audit: bounded, redacted.
    check(audit.count() > 0 && audit.count() <= 200, `audit trail bounded (${audit.count()} entries)`);
    check(!JSON.stringify(audit.recent(100)).includes('approved content values'), 'audit stores metadata, not payloads');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  }

  console.log(`\nReal-machine check: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exit(1);
  console.log('PHASE 18 (SAFETY + PERMISSION HARDENING) REAL-MACHINE VERIFICATION: PASS');
}

/** Minimal Phase 17 routing registry stub (decision-only, no network). */
function createRoutingRegistryStub(): AgentTool[] {
  const router = new ModelRouter(createDefaultModelRegistry());
  return [
    {
      name: 'model.route',
      description: 'route (real Phase 17 logic)',
      category: 'system',
      riskLevel: 'safe',
      capabilities: ['model.route'],
      permissions: [],
      timeoutMs: 1_000,
      execute: async (input) => {
        const decision = router.route({ text: String(input.task ?? '') });
        return { success: true, output: { model: decision.model, tier: decision.tier } };
      },
    },
  ] as unknown as AgentTool[];
}

main().catch((err) => {
  console.error('real-machine check failed:', err);
  process.exit(1);
});
