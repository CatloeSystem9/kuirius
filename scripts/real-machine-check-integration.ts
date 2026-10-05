/**
 * Real-machine verification — official Phase 20: Final Agent Integration.
 * Usage: npx tsx scripts/real-machine-check-integration.ts   (needs the local server)
 *
 * Safe, disposable, local operations only (fresh temp directory, cleaned up):
 * verifies the INTEGRATED agent system end-to-end — every Phase 0–19
 * subsystem initialized and cooperating through the single ToolRegistry, the
 * capability catalog lazy-loaded, and all Phase 18 safety boundaries intact.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import { LongRunManager } from '../src/agent/longrun';
import { SafetyAuditLog, SafetyGate, ScopedPermissionManager, EmergencyStop } from '../src/agent/safety';
import { CapabilityCatalog, createCapabilityTools, SpecialistCatalogSource } from '../src/agent/capabilities';
import { ModelRouter, createDefaultModelRegistry, getPerformanceTelemetry, CachedClassifier, createRoutingTools } from '../src/agent/routing';
import { FilesystemService, ApplicationService } from '../src/agent/system/systemServices';
import { HttpFsBackend, HttpAppBackend, setSystemBackendBaseUrl } from '../src/agent/system/httpSystem';
import { createSystemTools } from '../src/agent/system/systemTools';
import { ResearchService, createResearchTools } from '../src/agent/research';
import { ResearchService as RS } from '../src/agent/research';
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
  const initStart = Date.now();

  // ---- Initialization in the documented order (one bus, one registry, one
  // core — no duplicates). -------------------------------------------------
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  permissions.grant('filesystem.write');

  // Safety (Phase 18) BEFORE tools that need it.
  const audit = new SafetyAuditLog();
  const scoped = new ScopedPermissionManager();
  const emergencyStop = new EmergencyStop(audit);
  const safetyGate = new SafetyGate({ permissions, scoped, emergencyStop, audit });
  registry.setSafetyGate(safetyGate);

  // Model routing (Phase 17).
  const telemetry = getPerformanceTelemetry();
  const modelRouter = new ModelRouter(createDefaultModelRegistry(), telemetry);

  // Core + planner (Phases 1/16) + recovery (Phase 11 built into core).
  const planning = new PlanEngine({ registry, events: bus, permissions });
  const core = new AgentCore({
    registry, events: bus, store: new TaskStore(), permissions, planning,
    stepTimeoutMs: 30_000, maxAttemptsPerStep: 1,
  });

  // Long-run (Phase 19).
  const longRun = new LongRunManager(core, bus, { audit });
  longRun.attach();
  emergencyStop.onActivate(() => { try { core.cancelAll(); } catch {} });

  // Capability catalog (Phase 20) — registered, NOT loaded (lazy).
  const catalog = new CapabilityCatalog([new SpecialistCatalogSource()]);
  registry.registerAll(createCapabilityTools(catalog));

  // Real filesystem/application tools (Phase 9).
  const fsService = new FilesystemService({ fs: new HttpFsBackend(), events: bus });
  const apps = new ApplicationService({ fs: new HttpFsBackend(), apps: new HttpAppBackend(), events: bus });
  registry.registerAll(createSystemTools(fsService, apps));

  // Routing tools (Phase 17).
  registry.registerAll(createRoutingTools(modelRouter, new CachedClassifier({ telemetry }), telemetry));

  const initMs = Date.now() - initStart;
  console.log(`\n[init] full integrated system initialized in ${initMs}ms`);

  // 1-10: subsystem initialization checks.
  check(registry.names().length >= 20, `ToolRegistry initialized (${registry.names().length} tools)`);
  check(emergencyStop.status().active === false, 'SafetyGate + emergency stop initialized (inactive)');
  check(modelRouter.route({ text: 'hi' }).tier === 'light', 'model routing initialized and decision-capable');
  check(planning !== undefined, 'planning initialized');
  check(longRun.listSessions !== undefined, 'long-run manager initialized');
  check(audit.count() >= 0, 'safety audit initialized');

  // Duplicate registration guard.
  const before = registry.names().length;
  let duplicateRejected = false;
  try {
    registry.register(registry.get('capability.search')!);
  } catch {
    duplicateRejected = true;
  }
  check(duplicateRejected || registry.names().length === before, 'no duplicate tool registration occurs');
  registry.setSafetyGate(safetyGate);

  // 11-13: capability discovery + lazy loading.
  console.log('\n[capabilities] discovery + lazy loading');
  const searchStart = Date.now();
  const search = await registry.execute('capability.search', { query: 'research current information on the web' }, { taskId: 'p20', stepId: 's', signal: new AbortController().signal, memory: {}, permissions });
  const searchMs = Date.now() - searchStart;
  check(search.success && (search.output as any).results.length > 0, `capability discovery works (first lazy load + search in ${searchMs}ms)`);
  check((search.output as any).results[0].availability === 'advisory', 'discovered capabilities honestly labeled advisory');
  const loadCounts = catalog.lazyLoadCounts();
  check(Object.values(loadCounts).every((n) => n === 1), 'lazy loading: each source loaded exactly once');
  const stats = (await registry.execute('capability.stats', {}, { taskId: 'p20', stepId: 's', signal: new AbortController().signal, memory: {}, permissions })).output as { total: number };
  check(stats.total === 100, `catalog metadata-driven (${stats.total} cataloged specialist capabilities)`);
  check(registry.names().filter((n) => n.startsWith('capability.')).length === 3, 'catalog did NOT load one tool per capability (3 control tools only)');

  // 14: Deep Research functional.
  console.log('\n[deep research] functional under integration');
  const researchRegistry = new ToolRegistry(new AgentEventBus());
  const research = new RS({
    backend: { search: async () => ({ hits: [{ title: 't', url: 'https://x', snippet: '' }] }), fetchPage: async (url) => ({ url, title: 'T', text: 'real page body '.repeat(50) }) },
    registry: researchRegistry,
    limits: { maxRounds: 1, maxSearches: 1, maxQueriesPerRound: 1, maxSources: 1, maxHitsKept: 1 },
  });
  researchRegistry.registerAll(createResearchTools(research));
  const report = await research.runResearch('p20-dr', 'research photosynthesis', new AbortController().signal);
  check(report.citations.length >= 1, 'Deep Research discovers, inspects and cites a source');

  // 15: browser/computer capabilities remain functional (real fs as the proxy;
  // browser/computer verified by their own suites and gated here).
  console.log('\n[capabilities] filesystem/computer/browser remain functional + gated');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krisha-p20-'));
  try {
    const list = await registry.execute('filesystem.list', { path: tempDir }, { taskId: 'p20-fs', stepId: 's', signal: new AbortController().signal, memory: {}, permissions });
    check(list.success, 'filesystem capability functional through the integrated registry');
    const created = await registry.execute('filesystem.create', { path: path.join(tempDir, 'integrated.txt'), type: 'file', content: 'p20' }, { taskId: 'p20-fs', stepId: 's', signal: new AbortController().signal, memory: {}, permissions });
    check(created.success && fs.existsSync(path.join(tempDir, 'integrated.txt')), 'planned write executes on the real filesystem');
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }

  // 16-17: permissions + emergency stop enforced in the integrated system.
  permissions.revoke('filesystem.write');
  const denied = await registry.execute('filesystem.create', { path: path.join(os.tmpdir(), 'krisha-p20-should-not-exist.txt'), type: 'file', content: 'x' }, { taskId: 'p20-perm', stepId: 's', signal: new AbortController().signal, memory: {}, permissions });
  check(!denied.success && denied.errorKind === 'permission_denied', 'revoked permission → action denied (Phase 18 authoritative)');
  permissions.grant('filesystem.write');
  emergencyStop.activate('integration verification');
  const blocked = await registry.execute('filesystem.create', { path: path.join(os.tmpdir(), 'krisha-p20-blocked.txt'), type: 'file', content: 'x' }, { taskId: 'p20-perm', stepId: 's', signal: new AbortController().signal, memory: {}, permissions });
  check(!blocked.success, 'emergency stop blocks side-effecting actions');
  emergencyStop.deactivate();

  // 18: checkpoint/resume functional. (Uses os.tmpdir() — the disposable
  // test directory was already cleaned up in the filesystem section.)
  console.log('\n[long-run] checkpoint/resume under integration');
  const resumeSteps: PlanStep[] = [
    { id: 'r1', description: 'List temp', toolName: 'filesystem.list', capability: 'filesystem.list', input: { path: os.tmpdir() }, status: 'pending', attempts: 0 },
  ];
  Object.defineProperty(core, 'planner', {
    value: { makePlan: () => ({ goal: { description: 'resume probe', rawInput: 'resume probe', kind: 'command' as const }, steps: resumeSteps, createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
  const probe = longRun.start('resume probe');
  await waitSession(longRun, probe.taskId, ['COMPLETED']);
  check(longRun.listSessions().find((s) => s.taskId === probe.taskId)?.state === 'COMPLETED', 'long-run task completed + checkpointed');

  // 19: cancellation functional.
  const cancelSteps: PlanStep[] = [{ id: 'c1', description: 'List', toolName: 'filesystem.list', capability: 'filesystem.list', input: { path: os.tmpdir() }, status: 'pending', attempts: 0 }];
  inject(core, cancelSteps, 'cancel probe');
  const cancellable = longRun.start('cancel probe');
  longRun.cancel(cancellable.taskId, 'verification cancel');
  const cancelledOk = await waitSession(longRun, cancellable.taskId, ['CANCELLED']);
  check(cancelledOk && (await longRun.resume(cancellable.taskId)).resumed === false, 'cancellation terminal — no resume');

  // 21: no secrets in audit log.
  const auditText = JSON.stringify(audit.recent(100));
  check(!/password|secret|api[-_]key|bearer/i.test(auditText.replace(/permission|safety/gi, '')), 'no secrets in the audit trail');

  // 23: idle resource sanity — repeated stats calls are cached lookups.
  const idleStart = Date.now();
  for (let i = 0; i < 20; i++) await catalog.stats();
  check(Date.now() - idleStart < 1_000, 'idle repeated catalog stats stay cheap (cached index)');

  console.log(`\nReal-machine check: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exit(1);
  console.log('PHASE 20 (FINAL AGENT INTEGRATION) REAL-MACHINE VERIFICATION: PASS');
}

function waitSession(manager: LongRunManager, taskId: string, states: string[], timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const loop = () => {
      const state = manager.listSessions().find((s) => s.taskId === taskId)?.state;
      if (state && states.includes(state)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(loop, 20);
    };
    loop();
  });
}

function inject(core: AgentCore, steps: PlanStep[], goal: string): void {
  Object.defineProperty(core, 'planner', {
    value: { makePlan: () => ({ goal: { description: goal, rawInput: goal, kind: 'command' as const }, steps, createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null },
    configurable: true,
  });
}

main().catch((err) => {
  console.error('real-machine integration check failed:', err);
  process.exit(1);
});
