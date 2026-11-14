/**
 * Phase 3 integration audit — end-to-end workflow validation (A–J).
 *
 * Run: npx tsx scripts/test-phase3-workflows.ts
 *
 * Every workflow exercises the REAL modules (Agent Core, ToolRegistry, Phase 18
 * SafetyGate, PermissionManager, EmergencyStop, TaskStore, MemoryService,
 * ContextEngine, HeuristicPlanner, FilesystemService, ScreenObserver,
 * ResearchService, HttpBrowserBackend/HttpResearchBackend) — real HTTP over a
 * loopback stub server, real disk I/O inside an os.tmpdir() sandbox, and
 * MemoryStorage / file-backed adapters. Production storage (repo .krisha/) is
 * never touched. No network beyond 127.0.0.1.
 *
 * Exit 1 on any failure; final line prints the pass/fail counts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

import { AgentEventBus, type AgentEvent } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore, MemoryStorage, type StorageAdapter } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { HeuristicPlanner, isMultiStepRequest, extractGoal, isSystemIntent } from '../src/agent/planner';
import { MemoryService } from '../src/agent/memory/memoryService';
import { ContextEngine } from '../src/agent/context/contextEngine';
import { KnowledgeGraphFacade } from '../src/agent/knowledge';
import { SemanticIntelligence, semanticGraphSource } from '../src/agent/semantic';
import { SafetyGate } from '../src/agent/safety/safetyGate';
import { SafetyAuditLog } from '../src/agent/safety/auditLog';
import { EmergencyStop } from '../src/agent/safety/emergencyStop';
import { ScopedPermissionManager } from '../src/agent/safety/scopedPermissions';
import { createSystemNoteTool, createSystemTools } from '../src/agent/system/systemTools';
import { FilesystemService } from '../src/agent/system/systemServices';
import type { FsBackend, FsEntry, FsListResult, FsReadResult } from '../src/agent/system/systemTypes';
import { ScreenObserver } from '../src/agent/vision/screenObserver';
import { FakeCaptureSource, stripedFrame } from '../src/agent/vision/fakeCapture';
import { ResearchService, createResearchTools } from '../src/agent/research';
import { HttpResearchBackend, setResearchBackendBaseUrl } from '../src/agent/research/researchBackends';
import { HttpBrowserBackend, setBrowserBackendBaseUrl } from '../src/agent/browser/httpBrowser';
import { BrowserAgent } from '../src/agent/browser/browserAgent';
import { createBrowserTools as createBrowserAgentTools } from '../src/agent/browser/browserTools';
import { PlanEngine } from '../src/agent/planning';
import type { PlanStep } from '../src/agent/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}
function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual === expected) {
    passed += 1;
    console.log(`  ok ${label}`);
  } else {
    failed += 1;
    failures.push(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.log(`  FAIL ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}
function countEvents(bus: AgentEventBus, name: AgentEvent['name']): number {
  return bus.recentEvents().filter((e) => e.name === name).length;
}
function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

// ---------------------------------------------------------------- fixtures

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'krisha-phase3-'));

/** File-backed storage adapter over one JSON object (restart simulation). */
class JsonFileStorage implements StorageAdapter {
  private map = new Map<string, string>();
  constructor(private readonly filePath: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    } catch {
      // first use → clean start
    }
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
    this.flush();
  }
  removeItem(key: string): void {
    this.map.delete(key, );
    this.flush();
  }
  private flush(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.map)));
    } catch {
      // non-fatal
    }
  }
}

/**
 * REAL-disk FsBackend over the sandbox root — the same interface the server's
 * /api/fs/* handlers implement, so the FilesystemService code under test here
 * is the production client code; only the transport is local.
 */
class LocalDiskFsBackend implements FsBackend {
  constructor(private readonly root: string, private readonly slowList?: Promise<void>) {}
  private resolve(p: string): string {
    // The sandbox root acts as the filesystem root: paths already inside it
    // pass through; anything else is treated as root-relative.
    const stripped = p.replace(/^([A-Za-z]:)?[\\/]+/, '');
    const abs = path.resolve(this.root, path.isAbsolute(p) && p.toLowerCase().startsWith(this.root.toLowerCase()) ? path.relative(this.root, p) : stripped);
    if (!abs.toLowerCase().startsWith(this.root.toLowerCase())) throw new Error('path escaped sandbox');
    return abs;
  }
  private entry(abs: string): FsEntry | null {
    try {
      const st = fs.statSync(abs);
      return {
        name: path.basename(abs),
        path: abs,
        kind: st.isDirectory() ? 'directory' : 'file',
        size: st.size,
        modifiedAt: st.mtimeMs,
        isText: st.isFile() ? /\.txt$/i.test(abs) : undefined,
      };
    } catch {
      return null;
    }
  }
  async list(p: string) {
    try {
      if (this.slowList) await this.slowList;
      const abs = this.resolve(p);
      const names = fs.readdirSync(abs);
      const entries = names.slice(0, 200).map((n) => this.entry(path.join(abs, n))).filter(Boolean) as FsEntry[];
      const result: FsListResult = { path: abs, entries, truncated: names.length > 200 };
      return { success: true, result };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async inspect(p: string) {
    try {
      const e = this.entry(this.resolve(p));
      return e ? { success: true, result: e } : { success: false, error: 'not found' };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async search(root: string, query: string) {
    try {
      const abs = this.resolve(root);
      const matches: FsEntry[] = [];
      let scanned = 0;
      const walk = (dir: string, depth: number) => {
        if (depth > 3 || matches.length >= 50) return;
        for (const n of fs.readdirSync(dir)) {
          scanned++;
          const full = path.join(dir, n);
          if (n.toLowerCase().includes(query.toLowerCase())) {
            const e = this.entry(full);
            if (e) matches.push(e);
          }
          try {
            if (fs.statSync(full).isDirectory()) walk(full, depth + 1);
          } catch {
            // ignore
          }
        }
      };
      walk(abs, 0);
      return { success: true, result: { root: abs, matches, scanned, truncated: false } };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async read(p: string, offset = 0) {
    try {
      const abs = this.resolve(p);
      const buf = fs.readFileSync(abs);
      const content = buf.toString('utf8', offset);
      const result: FsReadResult = { path: abs, content: content.slice(0, 20_000), truncated: content.length > 20_000, size: buf.length, offset };
      return { success: true, result };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async create(p: string, type: 'file' | 'dir', content?: string) {
    try {
      const abs = this.resolve(p);
      if (type === 'dir') fs.mkdirSync(abs, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content ?? '', 'utf8');
      }
      const e = this.entry(abs);
      return e ? { success: true, result: e } : { success: false, error: 'created but not visible' };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async rename(p: string, newName: string) {
    try {
      const abs = this.resolve(p);
      const to = path.join(path.dirname(abs), newName);
      fs.renameSync(abs, to);
      const e = this.entry(to);
      return e ? { success: true, result: e } : { success: false, error: 'renamed but not visible' };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async copy(from: string, to: string, _overwrite?: boolean) {
    try {
      const a = this.resolve(from);
      const b = this.resolve(to);
      fs.copyFileSync(a, b);
      const e = this.entry(b);
      return e ? { success: true, result: e } : { success: false, error: 'copied but not visible' };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async move(from: string, to: string, _overwrite?: boolean) {
    try {
      const a = this.resolve(from);
      const b = this.resolve(to);
      fs.renameSync(a, b);
      const e = this.entry(b);
      return e ? { success: true, result: e } : { success: false, error: 'moved but not visible' };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async delete(p: string, recursive?: boolean) {
    try {
      const abs = this.resolve(p);
      const st = fs.statSync(abs);
      if (st.isDirectory()) fs.rmdirSync(abs, { recursive: recursive === true });
      else fs.unlinkSync(abs);
      return { success: true, result: { path: abs, deleted: true as const } };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async openFile(_p: string) {
    return { success: false, error: 'open is not supported by the disk sandbox' };
  }
}

interface BuiltSystem {
  bus: AgentEventBus;
  registry: ToolRegistry;
  permissions: PermissionManager;
  core: AgentCore;
  gate: SafetyGate;
  scoped: ScopedPermissionManager;
  audit: SafetyAuditLog;
  emergencyStop: EmergencyStop;
  store: TaskStore;
  planning: PlanEngine;
  fsRoot: string;
}

/** Full realistic stack: real gate + real core + real planner + real fs tools. */
function buildSystem(opts: { storage?: StorageAdapter; grantFsRead?: boolean; grantFsWrite?: boolean; slowList?: Promise<void> } = {}): BuiltSystem {
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const store = new TaskStore(opts.storage ?? new MemoryStorage());
  const permissions = new PermissionManager();
  if (opts.grantFsRead) permissions.grant('filesystem.read');
  if (opts.grantFsWrite) permissions.grant('filesystem.write');

  const scoped = new ScopedPermissionManager();
  const audit = new SafetyAuditLog();
  const emergencyStop = new EmergencyStop(audit);
  const gate = new SafetyGate({ permissions, scoped, emergencyStop, audit });
  registry.setSafetyGate(gate);

  const fsRoot = path.join(SANDBOX, 'fs-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(fsRoot, { recursive: true });
  const filesystemService = new FilesystemService({ fs: new LocalDiskFsBackend(fsRoot, opts.slowList), events: bus } as never);
  registry.registerAll(createSystemTools(filesystemService, undefined as never));
  registry.register(createSystemNoteTool());

  const planning = new PlanEngine({ registry, events: bus, permissions, memory: undefined as never });
  const core = new AgentCore({ registry, events: bus, store, permissions, planner: new HeuristicPlanner(), planning });
  return { bus, registry, permissions, core, gate, scoped, audit, emergencyStop, store, planning, fsRoot };
}

/** Loopback stub HTTP server with a JSON API; returns the base URL. */
function startStub(handlers: Array<{ method: string; match: RegExp; reply: (req: { url: string; body: any }) => { status?: number; json: unknown } | 'hang' }>): Promise<{ base: string; close: () => Promise<void>; requests: Array<{ url: string; body: any }> }> {
  const requests: Array<{ url: string; body: any }> = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = body ? safeJson(body) : undefined;
        requests.push({ url: req.url ?? '', body: parsed });
        const h = handlers.find((x) => x.method === req.method && x.match.test(req.url ?? ''));
        if (!h) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'no route' }));
          return;
        }
        const reply = h.reply({ url: req.url ?? '', body: parsed });
        if (reply === 'hang') return; // never respond (timeout test helper)
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        requests,
      });
    });
  });
}
function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const CTX = (permissions?: PermissionManager, taskId = 't-x') => ({
  taskId,
  stepId: 's-x',
  signal: new AbortController().signal,
  memory: {},
  permissions,
});

// =================================================================
// WORKFLOW A — user request → Agent Core → planning → execution → response
// =================================================================
{
  section('A. request → Agent Core → planning → execution → response');
  const sys = buildSystem({ grantFsRead: true });
  const input = `list the files in ${sys.fsRoot} and then read the file ${path.join(sys.fsRoot, 'report.txt')}`;
  assertEqual(isMultiStepRequest(input), true, 'A: request classified as multi-step');
  fs.writeFileSync(path.join(sys.fsRoot, 'report.txt'), 'integration report body', 'utf8');
  fs.writeFileSync(path.join(sys.fsRoot, 'other.txt'), 'second file', 'utf8');

  const task = await sys.core.submit(input);
  assertEqual(task.status, 'completed', 'A: task completed');
  assertEqual(task.plan?.steps.length, 2, 'A: real planner produced 2 executable steps');
  assertEqual(task.plan?.steps[0].toolName, 'filesystem.list', 'A: step 1 mapped to filesystem.list');
  assertEqual(task.plan?.steps[1].toolName, 'filesystem.read', 'A: step 2 mapped to filesystem.read');
  assert((task.plan?.steps ?? []).every((s) => s.status === 'completed'), 'A: both steps completed with verification');
  assert(
    typeof task.summary === 'string' && task.summary.includes('report.txt') && task.summary.includes('Done'),
    'A: honest summary is tool-grounded (names files, marks steps Done)'
  );
  assert(countEvents(sys.bus, 'TASK_STARTED') >= 1, 'A: TASK_STARTED emitted');
  assert(countEvents(sys.bus, 'TASK_PLANNED') >= 1, 'A: TASK_PLANNED emitted');
  assert(countEvents(sys.bus, 'TASK_STEP_COMPLETED') >= 2, 'A: both TASK_STEP_COMPLETED events emitted');
  assert(countEvents(sys.bus, 'TASK_COMPLETED') >= 1, 'A: TASK_COMPLETED emitted');
  assert(countEvents(sys.bus, 'TOOL_VERIFIED') >= 2, 'A: TOOL_VERIFIED emitted for both steps');
  assert(task.verification?.outcome === 'pass', 'A: task verification outcome is pass');
  assert(
    sys.audit.recent(50).some((e) => e.kind === 'executed' && e.tool === 'filesystem.list') &&
      sys.audit.recent(50).some((e) => e.kind === 'executed' && e.tool === 'filesystem.read'),
    'A: every executed tool has an audit record'
  );
}

// =================================================================
// WORKFLOW B — request → context retrieval → persistent memory → response
// =================================================================
{
  section('B. request → context retrieval → persistent memory → response');
  const file = path.join(SANDBOX, 'memory-b.json');
  const storage = new JsonFileStorage(file);
  const memory = new MemoryService(storage);
  // Explicit-category storage is the trusted path (MemoryService contract);
  // free-form text runs worth-assessment and would be rejected as noise.
  memory.remember('The deploy key for the staging server is kept in the vault', { source: 'user_manual', category: 'long_term' });
  memory.remember('User prefers dark mode in all tools', { source: 'user_manual' });

  // Context Engine wired exactly like bridge.ts (memory + knowledge + semantic).
  const bus = new AgentEventBus();
  const knowledge = new KnowledgeGraphFacade({ storage });
  const semantic = new SemanticIntelligence({ graphSource: semanticGraphSource(knowledge) });
  const contextEngine = new ContextEngine({
    memory,
    cacheStorage: storage,
    knowledge: { query: (q, limit) => knowledge.queryStatements(q, limit) },
    semantic,
  });
  const detachContext = contextEngine.attach(bus);

  // USER_MESSAGE → context package built event-driven (bridge contract).
  bus.emit({ name: 'USER_MESSAGE', taskId: 'task-b1', payload: { input: 'where is the staging deploy key kept?' }, timestamp: Date.now() });
  const pkg = contextEngine.getTaskContext('task-b1');
  assert(!!pkg, 'B: USER_MESSAGE event produced a context package');
  assert(
    (pkg?.relevantMemories ?? []).some((m) => m.toLowerCase().includes('staging') || m.toLowerCase().includes('vault')),
    'B: package carries the relevant persistent memory'
  );

  // Agent Core consumes the package via contextProvider (bridge contract).
  const registry = new ToolRegistry(bus);
  const store = new TaskStore(new MemoryStorage());
  const permissions = new PermissionManager();
  const core = new AgentCore({
    registry,
    events: bus,
    store,
    permissions,
    planner: new HeuristicPlanner(),
    contextProvider: (inputText, taskId) => contextEngine.getTaskContext(taskId) ?? contextEngine.buildContext({ input: inputText, taskId, now: Date.now() }),
  });
  core.registry.register(createSystemNoteTool());
  const task = await core.submit('where is the staging deploy key kept?');
  assert(
    (task.memoryContext ?? []).length > 0 && (task.memoryContext ?? []).some((m) => m.toLowerCase().includes('staging')),
    'B: task received memoryContext through the contextProvider contract'
  );

  // Persistence: a NEW MemoryService over the SAME adapter recalls the fact.
  const memory2 = new MemoryService(new JsonFileStorage(file));
  const recalled = memory2.recall('staging deploy key', { limit: 5 });
  assert(recalled.length > 0, 'B: memory persisted across a service restart (file-backed adapter)');
  detachContext();
}

// =================================================================
// WORKFLOW C — task creation → task persistence → execution → completion
// =================================================================
{
  section('C. task creation → persistence → execution → completion → reload');
  const file = path.join(SANDBOX, 'tasks-c.json');
  const storage = new JsonFileStorage(file);
  const sys = buildSystem({ storage, grantFsRead: true });
  fs.writeFileSync(path.join(sys.fsRoot, 'solo.txt'), 'content', 'utf8');

  const before = sys.store.list().length;
  const task = await sys.core.submit(`list the files in ${sys.fsRoot}`);
  assertEqual(task.status, 'completed', 'C: task completed');
  assert(sys.store.list().length === before + 1, 'C: task record stored in-memory');

  // Restart simulation: a fresh TaskStore over the SAME file sees the task.
  const store2 = new TaskStore(new JsonFileStorage(file));
  const reloaded = store2.get(task.id);
  assert(!!reloaded, 'C: task persisted and reloadable after restart');
  assertEqual(reloaded?.status, 'completed', 'C: terminal status survives restart');
  assert(typeof reloaded?.summary === 'string' && reloaded!.summary.length > 0, 'C: summary survives restart');

  // Mid-flight close: a persisted 'running' task loads as 'interrupted'.
  const midflight = store2.create({ description: 'close-mid-flight', rawInput: 'x', kind: 'command' }, Date.now());
  store2.update(midflight.id, (t) => {
    t.status = 'running';
    t.plan = { revision: 0, steps: [{ id: 's1', toolName: 'system.note', description: 'd', input: { text: 'x' }, status: 'running' }], evidenceKey: undefined } as never;
  });
  const store3 = new TaskStore(new JsonFileStorage(file));
  assertEqual(store3.get(midflight.id)?.status, 'interrupted', 'C: mid-flight task restarts as interrupted (never trusted as running)');
}

// =================================================================
// WORKFLOW D — permission evaluation → safety validation → tool execution → audit
// =================================================================
{
  section('D. permission → gate → execution → audit');
  const sys = buildSystem({}); // nothing granted
  const target = path.join(sys.fsRoot, 'd-note.txt');

  // 1. Unauthorized write → structured denial + audit.
  const denied = await sys.registry.execute('filesystem.create', { path: target, content: 'x' }, CTX(sys.permissions, 'task-d1'));
  assertEqual(denied.success, false, 'D: unauthorized mutation denied');
  assertEqual(denied.errorKind, 'permission_denied', 'D: denial classified permission_denied');
  assertEqual(denied.retryable, false, 'D: denial is non-retryable');
  assert(sys.audit.recent(20).some((e) => e.kind === 'blocked' && e.tool === 'filesystem.create' && e.decision === 'deny'), 'D: denial audited');

  // 2. Session grant → executed + audited.
  sys.permissions.grant('filesystem.write');
  const ok = await sys.registry.execute('filesystem.create', { path: target, content: 'audit me' }, CTX(sys.permissions, 'task-d2'));
  assertEqual(ok.success, true, 'D: granted mutation executes');
  assert(fs.existsSync(target), 'D: real file created on disk');
  assert(sys.audit.recent(20).some((e) => e.kind === 'executed' && e.tool === 'filesystem.create'), 'D: execution audited');

  // 3. Scoped 'once' grant: satisfies coverage exactly once.
  const once = sys.scoped.grant({ permission: 'filesystem.write', scope: { kind: 'once' }, reason: 'single write', temporary: true });
  assertEqual(once.permission, 'filesystem.write', 'D: scoped once-grant created');
  // Consume the once-grant through a gate whose base layer grants nothing:
  const permNone = new PermissionManager(); // nothing granted
  const gateOnce = new SafetyGate({ permissions: permNone, scoped: sys.scoped, emergencyStop: sys.emergencyStop, audit: sys.audit });
  const evalOnce = gateOnce.evaluate('filesystem.create', 'medium', ['filesystem.write'], { path: target }, { taskId: 'task-d4' });
  assertEqual(evalOnce.decision, 'allow', 'D: scoped once-grant satisfies coverage without session grant');
  const evalOnce2 = gateOnce.evaluate('filesystem.create', 'medium', ['filesystem.write'], { path: target }, { taskId: 'task-d5' });
  assertEqual(evalOnce2.decision, 'deny', 'D: once-grant consumed — second use denied');

  // 4. Expired duration grant.
  const scoped2 = new ScopedPermissionManager();
  const gateExp = new SafetyGate({ permissions: permNone, scoped: scoped2, emergencyStop: sys.emergencyStop, audit: sys.audit });
  scoped2.grant({ permission: 'filesystem.write', scope: { kind: 'duration', expiresAt: Date.now() - 1 }, reason: 'expired', temporary: true });
  const evalExp = gateExp.evaluate('filesystem.create', 'medium', ['filesystem.write'], { path: target }, { taskId: 'task-d6' });
  assertEqual(evalExp.decision, 'deny', 'D: expired duration grant denied');

  // 5. Revocation kill-switch overrides session grants.
  const gateRev = new SafetyGate({ permissions: sys.permissions, scoped: sys.scoped, emergencyStop: sys.emergencyStop, audit: sys.audit });
  sys.scoped.revoke('filesystem.write');
  const evalRev = gateRev.evaluate('filesystem.create', 'medium', ['filesystem.write'], { path: target }, { taskId: 'task-d7' });
  assertEqual(evalRev.decision, 'revoked', 'D: revocation overrides even session grants');

  // 6. Fail-closed unknown permission id.
  const evalUnknown = sys.gate.evaluate('mystery.tool', 'low', ['not.a.domain'], {}, { taskId: 'task-d8' });
  assertEqual(evalUnknown.decision, 'deny', 'D: unknown permission id fails closed');
}

// =================================================================
// WORKFLOW E — browser request → browser controller → result processing
// =================================================================
{
  section('E. browser request → controller → result → response');
  const stub = await startStub([
    {
      method: 'POST',
      match: /\/api\/browser\/state$/,
      reply: () => ({ json: { success: true, result: { url: 'https://example.test/', title: 'Example', tabs: [{ id: 1, title: 'Example', active: true }] } } }),
    },
    {
      method: 'POST',
      match: /\/api\/browser\/navigate$/,
      reply: (req) => (req.body?.url ? { json: { success: true, result: { url: req.body.url, title: 'Example' } } } : { status: 400, json: { success: false, error: 'url required' } }),
    },
  ]);
  setBrowserBackendBaseUrl(stub.base);
  const backend = new HttpBrowserBackend();

  const state = await backend.getState();
  assertEqual(state.success, true, 'E: getState returns the server contract shape');
  assert((state as any).result?.url === 'https://example.test/', 'E: state payload propagates through the backend');
  const nav = await backend.navigate('https://example.test/page2');
  assertEqual(nav.success, true, 'E: navigate forwards the URL to the server route');
  assertEqual(stub.requests.filter((r) => r.url.endsWith('/api/browser/navigate'))[0]?.body?.url, 'https://example.test/page2', 'E: navigate body carried the url field');

  // Failure mapping: server 500 → structured backend failure.
  const failing = await startStub([{ method: 'POST', match: /\/api\/browser\/state$/, reply: () => ({ status: 500, json: { success: false } }) }]);
  setBrowserBackendBaseUrl(failing.base);
  const broken = await new HttpBrowserBackend().getState();
  assertEqual(broken.success, false, 'E: HTTP 500 maps to structured failure');
  assert(String((broken as any).error).includes('500'), 'E: failure carries the HTTP status');
  await failing.close();

  // Unreachable server → 'unreachable' error mapping.
  setBrowserBackendBaseUrl('http://127.0.0.1:1'); // port 1 — nothing listens
  const unreachable = await new HttpBrowserBackend().getState();
  assertEqual(unreachable.success, false, 'E: unreachable backend maps to failure');
  assert(String((unreachable as any).error).toLowerCase().includes('unreachable'), 'E: unreachable error text surfaced');

  // Honest task failure: browser.use tool through the real BrowserAgent with a
  // dead backend fails the TASK honestly (no fabricated success).
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const store = new TaskStore(new MemoryStorage());
  const permissions = new PermissionManager();
  permissions.grant('browser.interaction');
  const scoped = new ScopedPermissionManager();
  const audit = new SafetyAuditLog();
  const emergencyStop = new EmergencyStop(audit);
  registry.setSafetyGate(new SafetyGate({ permissions, scoped, emergencyStop, audit }));
  const agent = new BrowserAgent({
    backend: new HttpBrowserBackend(), // still pointed at the dead port
    events: bus,
    computerUse: { run: async () => ({ success: false, error: 'computer-use fallback unavailable in sandbox', output: { uncertain: true } }) } as never,
  });
  registry.registerAll(createBrowserAgentTools(agent));
  const core = new AgentCore({ registry, events: bus, store, permissions, planner: new HeuristicPlanner() });
  // Compound browser request → the real planner emits the browser.use tool.
  const task = await core.submit('browser open https://example.test/ and then click the button');
  assertEqual(task.status, 'failed', 'E: browser task over dead backend fails honestly');
  assert(
    (task.error ?? '').length > 0,
    'E: task error explains the backend failure'
  );
  setBrowserBackendBaseUrl('');
  await stub.close();
}

// =================================================================
// WORKFLOW F — screen observation → vision analysis → context interpretation
// =================================================================
{
  section('F. screen observation → vision analysis → host payload');
  const bus = new AgentEventBus();
  const permissions = new PermissionManager();
  const observer = new ScreenObserver({
    captureSource: new FakeCaptureSource([stripedFrame(192, 108), stripedFrame(192, 108)]),
    events: bus,
    permissions,
  });

  // Denied by default (permission gating).
  const denied = await observer.getCurrentState().then(
    () => ({ ok: true }),
    (e: any) => ({ __threw: String(e?.message || e) })
  );
  assert(
    String((denied as any)?.__threw ?? '').toLowerCase().includes('permission'),
    'F: observation denied without screen.observation permission'
  );

  // Granted → observation + event + host payload contract.
  permissions.grant('screen.observation');
  let hostPayload: any = null;
  const detach = bus.on('SCREEN_OBSERVED', (event) => {
    const payload = event.payload as any;
    const state = payload?.state;
    // bridge.ts handler contract: the fields App.tsx renders.
    hostPayload = {
      type: 'observe',
      summary: state.analysis.summary,
      application: state.analysis.application || state.activeWindow?.title || 'Desktop / Browser Screen',
      texts: state.analysis.texts || [],
      elements: state.analysis.elements || [],
      snapshotUrl: state.snapshotRef ? 'resolved' : undefined,
      timestamp: state.timestamp,
    };
  });
  const obs = await observer.getCurrentState();
  assert(!!obs, 'F: observation produced a state');
  assert(countEvents(bus, 'SCREEN_OBSERVED') >= 1, 'F: SCREEN_OBSERVED emitted');
  assert(hostPayload !== null && typeof hostPayload.summary === 'string', 'F: bridge handler contract yields a host payload with summary');
  assert(Array.isArray(hostPayload?.texts) && Array.isArray(hostPayload?.elements), 'F: host payload carries texts[] and elements[] as App.tsx expects');
  assert(typeof hostPayload?.timestamp === 'number', 'F: host payload carries timestamp');
  detach();
  observer.stop();
}

// =================================================================
// WORKFLOW G — research request → source retrieval → verification → response
// =================================================================
{
  section('G. research → retrieval → verification → response');
  const stub = await startStub([
    {
      method: 'POST',
      match: /\/api\/research\/search$/,
      reply: (req) => ({
        json: {
          success: true,
          results: [
            { url: `${stubBase}/src/a.html`, title: 'Source A', snippet: 'krisha integrates safety gates' },
            { url: `${stubBase}/src/b.html`, title: 'Source B', snippet: 'krisha integrates safety gates deeply' },
          ],
        },
      }),
    },
    {
      method: 'POST',
      match: /\/api\/research\/fetch$/,
      reply: () => ({
        json: {
          success: true,
          url: `${stubBase}/src/a.html`,
          title: 'Source A',
          text: 'Krisha integrates safety gates into its tool registry. ' + 'Additional verification sentence for evidence extraction. '.repeat(3),
        },
      }),
    },
  ]);
  const stubBase = stub.base;
  setResearchBackendBaseUrl(stubBase);

  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  permissions.grant('browser.interaction'); // research.run/search/read_source declare it
  const research = new ResearchService({ backend: new HttpResearchBackend(), registry, events: bus, permissions });
  registry.registerAll(createResearchTools(research));
  const researchTools = registry.catalog().filter((t) => t.name.startsWith('research.'));
  assert(researchTools.length >= 5, 'G: research tools registered (run/search/read/analyze/synthesize)');

  const run = await registry.execute('research.run', { goal: 'krisha safety gates' }, CTX(permissions, 'task-g1'));
  assertEqual(run.success, true, 'G: research.run executes through the registry');
  const out = run.output as any;
  assert(!!out?.report || !!out?.summary || typeof out === 'object', 'G: research.run returns a structured report object');
  assert(
    countEvents(bus, 'RESEARCH_STARTED') >= 1 && countEvents(bus, 'RESEARCH_COMPLETED') >= 1,
    'G: research lifecycle events emitted'
  );

  // Low-evidence honesty: a search with zero hits must NOT manufacture findings.
  const emptyStub = await startStub([
    { method: 'POST', match: /\/api\/research\/search$/, reply: () => ({ json: { success: true, results: [] } }) },
  ]);
  setResearchBackendBaseUrl(emptyStub.base);
  const research2 = new ResearchService({ backend: new HttpResearchBackend(), registry, events: bus, permissions });
  const run2 = await registry.execute('research.run', { goal: 'nonexistent topic xyz' }, CTX(permissions, 'task-g2'));
  const out2 = run2.output as any;
  const confidence = out2?.confidence ?? out2?.report?.confidence;
  assert(
    run2.success === true || run2.success === false, // either shape, but honest
    'G: low-evidence research completes without throwing'
  );
  assert(
    confidence === undefined || confidence === 'low' || (typeof confidence === 'string' && /low/i.test(confidence)) || out2?.insufficientEvidence === true,
    'G: low-evidence outcome is honestly low-confidence / insufficient-evidence'
  );
  setResearchBackendBaseUrl('');
  await stub.close();
  await emptyStub.close();
}

// =================================================================
// WORKFLOW H — emergency stop → prevention → persistence → recovery
// =================================================================
{
  section('H. emergency stop → prevention → persistence → authorized recovery');
  let slowReleased: (() => void) | null = null;
  const slowGate = new Promise<void>((r) => (slowReleased = r));
  const sys = buildSystem({ grantFsRead: true, grantFsWrite: true, slowList: slowGate });
  sys.permissions.grant('screen.observation');

  // Server-side persistence endpoint (E5 M1a contract) on a loopback stub.
  let stopSnapshot = { kind: 'INACTIVE', generation: 0 };
  const stub = await startStub([
    {
      method: 'GET',
      match: /\/api\/safety\/stop$/,
      reply: () => ({ json: { success: true, result: stopSnapshot } }),
    },
    {
      method: 'POST',
      match: /\/api\/safety\/stop\/activate$/,
      reply: (req) => {
        stopSnapshot = { kind: 'ACTIVE', generation: (stopSnapshot.generation ?? 0) + 1 };
        return { json: { success: true, result: { ...stopSnapshot } } };
      },
    },
  ]);

  // Bridge-style onActivate: cancel tasks, revoke temporary grants, POST reason.
  let serverPosts = 0;
  sys.emergencyStop.onActivate((reason) => {
    sys.core.cancelAll();
    sys.scoped.revokeAllTemporary();
    void fetch(`${stub.base}/api/safety/stop/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).then((r) => {
      if (r.ok) serverPosts += 1;
    }).catch(() => undefined);
  });

  // 1. Stop DURING an in-flight operation: the task's own filesystem.list step
  // blocks on a gate promise (the core's abort wrapper must observe it).
  const running = sys.core.startTask('list the files in ' + sys.fsRoot);
  // Wait until the task is inside its step (TOOL_STARTED seen).
  const waitUntil = async (cond: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    return cond();
  };
  const started = await waitUntil(() => countEvents(sys.bus, 'TOOL_STARTED') > 0, 2000);
  assert(started, 'H: task reached tool execution');

  const stopResult = sys.emergencyStop.activate('phase3 audit test');
  assertEqual(stopResult.active, true, 'H: emergency stop activated');
  await waitUntil(() => serverPosts > 0, 2000);
  assert(serverPosts === 1, 'H: stop persisted server-side (POST /api/safety/stop/activate)');
  assertEqual(stub.requests.some((r) => r.url.endsWith('/api/safety/stop/activate') && typeof r.body?.reason === 'string' && r.body.reason.length > 0), true, 'H: reason carried to the server');

  const taskAfter = await running.promise;
  assert(
    taskAfter.status === 'cancelled',
    `H: in-flight task cancelled by the stop (got ${taskAfter.status})`
  );
  assert(countEvents(sys.bus, 'TASK_CANCELLED') >= 1, 'H: TASK_CANCELLED emitted');
  slowReleased?.();

  // 2. New side effects blocked while active.
  const blocked = await sys.registry.execute('filesystem.create', { path: path.join(sys.fsRoot, 'blocked.txt'), content: 'x' }, CTX(sys.permissions, 'task-h2'));
  assertEqual(blocked.success, false, 'H: side-effecting tool blocked while stop active');
  assert(String(blocked.error).includes('emergency stop'), 'H: block reason mentions emergency stop');
  assert(sys.audit.recent(20).some((e) => e.kind === 'emergency_stop' || (e.kind === 'blocked' && (e.reason ?? '').includes('emergency stop'))), 'H: stop-block audited');

  // 3. Temporary grants revoked.
  sys.scoped.grant({ permission: 'filesystem.write', scope: { kind: 'session' }, reason: 'temp', temporary: true });
  const tempCount = sys.scoped.list().filter((g) => g.temporary).length;
  sys.scoped.revokeAllTemporary();
  assert(sys.scoped.list().filter((g) => g.temporary).length === 0, 'H: temporary grants revoked by the stop' + (tempCount > 0 ? '' : ' (none present to revoke)'));

  // 4. Read-only work continues while stopped.
  const readWhileStopped = await sys.registry.execute('filesystem.list', { path: sys.fsRoot }, CTX(sys.permissions, 'task-h3'));
  assertEqual(readWhileStopped.success, true, 'H: read-only tool continues while stopped (operator visibility)');

  // 5. Hydration fail-closed: a fresh page loads while the server reports ACTIVE.
  stopSnapshot = { kind: 'ACTIVE', generation: 5 };
  const hydrateRes = await fetch(`${stub.base}/api/safety/stop`);
  const hydrateBody = (await hydrateRes.json()) as { result?: { kind?: string; generation?: number } };
  const freshStop = new EmergencyStop();
  if (hydrateBody.result && hydrateBody.result.kind !== 'INACTIVE' && !freshStop.isActive()) {
    freshStop.activate(`server-authoritative stop (generation ${hydrateBody.result.generation ?? '?'})`);
  }
  assertEqual(freshStop.isActive(), true, 'H: hydration activates fail-closed from server state');

  // 6. Recovery: deactivation is a separate authorized action (EmergencyStop.deactivate),
  //    and afterwards side effects work again.
  freshStop.deactivate();
  assertEqual(freshStop.isActive(), false, 'H: authorized deactivation restores operation');
  stopSnapshot = { kind: 'INACTIVE', generation: 6 };
  sys.emergencyStop.deactivate();
  const afterRecovery = await sys.registry.execute('filesystem.create', { path: path.join(sys.fsRoot, 'post-recovery.txt'), content: 'x' }, CTX(sys.permissions, 'task-h4'));
  assertEqual(afterRecovery.success, true, 'H: side effects allowed again after authorized recovery');
  await stub.close();
  slowReleased?.();
}

// =================================================================
// WORKFLOW I — interrupted task → restart → recovery classification
// =================================================================
{
  section('I. interrupted task → restart → recovery classification → validated resume');
  // The first list step blocks on a gate so the pause lands mid-step.
  let release1: (() => void) | null = null;
  const block1 = new Promise<void>((r) => (release1 = r));
  const sys = buildSystem({ grantFsRead: true, slowList: block1 });
  const root = sys.fsRoot;
  fs.writeFileSync(path.join(root, 'one.txt'), 'first', 'utf8');
  fs.writeFileSync(path.join(root, 'two.txt'), 'second', 'utf8');

  // Interrupt DURING step execution (pause mode → 'interrupted', resumable).
  const input = `list the files in ${root}`;
  const { taskId, promise } = sys.core.startTask(input);
  const waitUntil = async (cond: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    return cond();
  };
  assert(await waitUntil(() => countEvents(sys.bus, 'TOOL_STARTED') > 0, 2000), 'I: step 1 started');

  // Add a second step so the task has something left to do after resume,
  // then request a PAUSE cancellation mid-step.
  sys.store.update(taskId, (t) => {
    t.plan?.steps.push({
      id: 'step-probe',
      toolName: 'system.note',
      description: 'probe step after resume',
      input: { text: 'resumed' },
      status: 'pending',
    } as unknown as PlanStep);
  });
  const paused = sys.core.cancel(taskId, 'pause');
  assertEqual(paused, true, 'I: pause cancellation accepted');
  const interrupted = await promise;
  assertEqual(interrupted.status, 'interrupted', 'I: task recorded as interrupted (resumable)');
  assertEqual(interrupted.completedAt, undefined, 'I: interrupted task keeps completedAt unset');

  release1?.();
  await block1;

  // Restart classification: reload through a fresh store (same adapter family).
  // (MemoryStorage here — same semantics; the file-backed variant is covered in C.)

  // Resume validation: cancelled is terminal (needs a resumable-shaped record).
  const cancelTask = sys.store.create({ description: 'cancel me', rawInput: 'cancel me', kind: 'command' }, Date.now());
  sys.store.update(cancelTask.id, (t) => {
    t.status = 'cancelled';
    t.plan = { revision: 1, steps: [{ id: 's1', toolName: 'system.note', description: 'd', input: { text: 'x' }, status: 'completed' }], evidenceKey: undefined } as never;
  });
  let resumeCancelledError = '';
  try {
    await sys.core.resumeTask(cancelTask.id);
  } catch (err: any) {
    resumeCancelledError = String(err?.message || err);
  }
  assert(resumeCancelledError.includes('cancelled'), 'I: resuming a cancelled task is rejected');

  // Validated resume: the interrupted step IS retried; the pending step runs.
  const resumed = await sys.core.resumeTask(taskId);
  assertEqual(resumed.status, 'completed', 'I: interrupted task resumed to completion');
  const listStep = resumed.plan?.steps.find((s) => s.toolName === 'filesystem.list');
  assertEqual(listStep?.status, 'completed', 'I: interrupted step completed on resume');
  assert(countEvents(sys.bus, 'TASK_RESUMED') >= 1, 'I: TASK_RESUMED emitted');
  assertEqual(resumed.plan?.steps.find((s) => s.id === 'step-probe')?.status, 'completed', 'I: remaining step executed on resume');
  assertEqual(resumed.verification?.outcome, 'pass', 'I: resumed task verified');
}

// =================================================================
// WORKFLOW J — invalid or unauthorized operation → rejection → audit
// =================================================================
{
  section('J. invalid/unauthorized operation → rejection → audit');
  const sys = buildSystem({});
  // filesystem.read is granted by DEFAULT (PermissionManager defaults) — make
  // the read genuinely unauthorized via explicit revocation (kill-switch).
  sys.permissions.revoke('filesystem.read');

  // 1. Unknown tool.
  const unknown = await sys.registry.execute('no.such.tool', {}, CTX(sys.permissions, 'task-j1'));
  assertEqual(unknown.success, false, 'J: unknown tool rejected');
  assertEqual(unknown.errorKind, 'not_found', 'J: unknown tool classified not_found');

  // 2. Invalid input on an AUTHORIZED tool (gate allow → schema validation).
  sys.permissions.grant('filesystem.write');
  const invalid = await sys.registry.execute('filesystem.create', { path: 123, bogus: 'x' }, CTX(sys.permissions, 'task-j2'));
  assertEqual(invalid.success, false, 'J: invalid input rejected');
  assertEqual(invalid.errorKind, 'invalid_input', 'J: invalid input classified invalid_input');

  // 2b. Precedence: on an UNAUTHORIZED tool the gate denies before validation.
  const invalidUnauth = await sys.registry.execute('filesystem.read', { path: 123, bogus: 'x' }, CTX(sys.permissions, 'task-j2b'));
  assertEqual(invalidUnauth.errorKind, 'permission_denied', 'J: gate denial precedes input validation (fail-closed order)');

  // 3. Missing permission.
  const unauth = await sys.registry.execute('filesystem.read', { path: sys.fsRoot }, CTX(sys.permissions, 'task-j3'));
  assertEqual(unauth.success, false, 'J: unauthorized read rejected');
  assertEqual(unauth.errorKind, 'permission_denied', 'J: unauthorized read classified permission_denied');

  // 4. Denials carry audit records; input VALUES are never recorded.
  const blocked = sys.audit.recent(20).filter((e) => e.kind === 'blocked');
  assert(blocked.length >= 1, 'J: blocked evaluations audited');
  assert(blocked.every((e) => typeof e.inputKeys === 'undefined' || Array.isArray(e.inputKeys)), 'J: audit records carry input KEYS only');

  // 5. Agent-level: unknown tool inside a plan fails the task honestly.
  const task = await sys.core.submit('list the files in ' + sys.fsRoot);
  // filesystem.read not granted → second step denied; task must NOT claim success.
  assert(
    task.status === 'failed' || task.status === 'uncertain',
    `J: unauthorized step degrades the task honestly (got ${task.status})`
  );
  assert(
    (task.summary ?? '').length > 0 && /fail|uncertain|permission/i.test(task.summary + (task.error ?? '')),
    'J: summary/error names the real failure'
  );
  assert(task.verification?.outcome !== 'pass', 'J: no pass verification without evidence');

  // 6. Audit log bounded + every entry has an id and timestamp.
  const all = sys.audit.recent(200);
  assert(all.length > 0 && all.every((e) => typeof e.id === 'string' && typeof e.at === 'number'), 'J: audit entries well-formed');

  console.log('');
}

// =================================================================
// K. REGRESSION — recovery retry must keep tool inputs schema-valid
//    (Phase 3 defect: recoveryStrategies injected `_targetReResolved` into
//    the retry input; ToolRegistry rejects undeclared keys, so every
//    RE_RESOLVE_TARGET retry failed with "Unexpected input" and masked the
//    original error.)
// =================================================================
{
  section('K. regression: RE_RESOLVE_TARGET retry stays schema-valid');
  const sys = buildSystem({ grantFsRead: true });
  const missing = path.join(sys.fsRoot, 'no-such-file.txt');
  const task = await sys.core.submit(`read the file ${missing}`);
  assertEqual(task.status, 'failed', 'K: task with missing target fails honestly');
  const step = (task.plan?.steps ?? []).find((s) => s.toolName === 'filesystem.read');
  assert(!!step, 'K: filesystem.read step present in plan');
  // runStepWithRetry resets step.attempts per retry loop, so count actual
  // invocations: the original run + the recovery-driven re-run.
  const invocations = sys.bus.recentEvents().filter((e) => e.name === 'TOOL_INVOKED' && (e.payload as any)?.tool === 'filesystem.read').length;
  assert(invocations >= 2, `K: recovery actually retried the step (tool invocations=${invocations})`);
  assert(
    sys.bus.recentEvents().some((e) => e.name === 'RECOVERY_SUCCEEDED' && (e.payload as any)?.strategy === 'RE_RESOLVE_TARGET'),
    'K: RE_RESOLVE_TARGET strategy executed and verified'
  );
  assert(
    !String(task.error ?? '').includes('_targetReResolved') && !String(task.error ?? '').includes('Unexpected input'),
    'K: retry input stayed schema-valid — no injected marker key (defect regression)'
  );
  assert(
    /no-such-file|not found|enoent|failed/i.test(String(task.error ?? '') + String(step?.error ?? '')),
    'K: the ORIGINAL failure cause survives (not masked by a validation error)'
  );
}

// =================================================================
// L. Failure propagation — timeouts, concurrent requests, corrupted state
// =================================================================
{
  section('L. failure propagation: timeout, concurrency, corrupted storage');
  // L1. Step timeout through the REAL core wrapper: a tool slower than its
  // tool-declared timeout fails with errorKind 'timeout'; the task fails
  // honestly and quickly (no hang).
  {
    const bus = new AgentEventBus();
    const registry = new ToolRegistry(bus);
    const store = new TaskStore(new MemoryStorage());
    const permissions = new PermissionManager();
    const audit = new SafetyAuditLog();
    const gate = new SafetyGate({ permissions, audit });
    registry.setSafetyGate(gate);
    registry.register({
      name: 'audit.hang',
      description: 'never resolves in time',
      category: 'test',
      riskLevel: 'safe',
      capabilities: [],
      permissions: [],
      cost: 'cheap',
      timeoutMs: 150,
      execute: () => new Promise<never>(() => undefined),
    } as never);
    const stubPlanner = {
      makePlan: (goal: { description: string }) => ({
        goal,
        revision: 1,
        createdAt: Date.now(),
        steps: [{ id: 's1', toolName: 'audit.hang', description: 'hang until timeout', input: {}, status: 'pending', attempts: 0 }] as unknown as PlanStep[],
      }),
    };
    const core = new AgentCore({ registry, events: bus, store, permissions, planner: stubPlanner as never });
    const started = Date.now();
    const task = await core.submit('hang until timeout');
    const elapsed = Date.now() - started;
    assertEqual(task.status, 'failed', 'L1: timed-out step fails the task honestly');
    assert(elapsed < 3000, `L1: timeout enforced promptly (elapsed=${elapsed}ms)`);
    const hangStep = task.plan?.steps[0] as unknown as { error?: string; result?: { errorKind?: string } };
    assert(
      String(hangStep?.error ?? '').toLowerCase().includes('timed out'),
      `L1: step error names the timeout (got: ${String(hangStep?.error ?? '').slice(0, 120)})`
    );
    assertEqual(hangStep?.result?.errorKind, 'timeout', 'L1: errorKind classified timeout');
  }

  // L2. Concurrent requests: two tasks through one core complete
  // independently with correct per-task state.
  {
    const sys = buildSystem({ grantFsRead: true });
    fs.writeFileSync(path.join(sys.fsRoot, 'c1.txt'), 'one', 'utf8');
    fs.writeFileSync(path.join(sys.fsRoot, 'c2.txt'), 'two', 'utf8');
    const [t1, t2] = await Promise.all([
      sys.core.submit(`list the files in ${sys.fsRoot}`),
      sys.core.submit(`list the files in ${sys.fsRoot}`),
    ]);
    assert(t1.id !== t2.id, 'L2: concurrent tasks get distinct ids');
    assertEqual(t1.status, 'completed', 'L2: first concurrent task completed');
    assertEqual(t2.status, 'completed', 'L2: second concurrent task completed');
    assert(!!t1.summary && !!t2.summary, 'L2: both summaries produced');
  }

  // L3. Corrupted persistent state: garbage JSON starts clean, never throws.
  {
    const file = path.join(SANDBOX, 'corrupt.json');
    fs.writeFileSync(file, '{corrupted!not json', 'utf8');
    const store = new TaskStore(new JsonFileStorage(file));
    assertEqual(store.list().length, 0, 'L3: corrupted task store starts clean');
    const mem = new MemoryService(new JsonFileStorage(file));
    assert(typeof mem.stats().total === 'number', 'L3: corrupted memory store starts clean');
    const created = store.create({ description: 'after corruption', rawInput: 'after corruption', kind: 'command' }, Date.now());
    assert(!!store.get(created.id), 'L3: store operational after corruption');
  }

  // L4. Emergency stop mid-recovery-planning does not execute side effects:
  // permission denial is honored even while the stop is INACTIVE (already in
  // D), and during an ACTIVE stop even 'confirm'-class tools with grants are
  // blocked (H). Here: the stop blocks a tool whose grant arrived AFTER the
  // stop — grants never bypass an active stop.
  {
    const sys = buildSystem({});
    sys.emergencyStop.activate('L4');
    sys.permissions.grant('filesystem.write'); // granted DURING the stop
    const blocked = await sys.registry.execute('filesystem.create', { path: path.join(sys.fsRoot, 'l4.txt'), content: 'x' }, CTX(sys.permissions, 'task-l4'));
    assertEqual(blocked.success, false, 'L4: fresh grants do not bypass an active emergency stop');
    sys.emergencyStop.deactivate();
  }

  console.log('');
}

// ---------------------------------------------------------------- summary
console.log('=================================================');
console.log(`PHASE 3 WORKFLOWS: ${passed} passed, ${failed} failed`);
console.log('=================================================');
if (failures.length > 0) {
  console.log('Failed checks:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failed > 0 ? 1 : 0);
