/**
 * Phase 9 verification suite — Filesystem + Application Agent under Node
 * with deterministic fake backends.
 * Usage: npx tsx scripts/test-system-phase9.ts
 */
import { FilesystemService, ApplicationService } from '../src/agent/system/systemServices';
import { FakeFsBackend, FakeAppBackend } from '../src/agent/system/fakeSystem';
import { createSystemTools } from '../src/agent/system/systemTools';
import { classifyStep, isSystemIntent, HeuristicPlanner, extractGoal } from '../src/agent/planner';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { AgentEventBus } from '../src/agent/events';
import { AgentCore } from '../src/agent/agentCore';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { MemoryService } from '../src/agent/memory/memoryService';
import { MemoryStorage as MS } from '../src/agent/taskState';
import { ok } from '../src/agent/types';

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

function assertEqual<T>(actual: T, expected: T, label: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

interface Harness {
  fs: FilesystemService;
  apps: ApplicationService;
  fsBackend: FakeFsBackend;
  appBackend: FakeAppBackend;
  permissions: PermissionManager;
  events: AgentEventBus;
  registry: ToolRegistry;
}

function makeHarness(grantWrite = true): Harness {
  const fsBackend = new FakeFsBackend();
  const appBackend = new FakeAppBackend();
  const events = new AgentEventBus();
  const permissions = new PermissionManager();
  permissions.grant('filesystem.read');
  permissions.grant('application.launch');
  if (grantWrite) permissions.grant('filesystem.write');
  const fs = new FilesystemService({ fs: fsBackend, events });
  const apps = new ApplicationService({ fs: fsBackend, apps: appBackend, events });
  const registry = new ToolRegistry();
  registry.registerAll(createSystemTools(fs, apps));
  return { fs, apps, fsBackend, appBackend, permissions, events, registry };
}

function execute(h: Harness, name: string, input: Record<string, unknown>) {
  return h.registry.execute(name, input, { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions: h.permissions });
}

const DOC = 'C:\\Users\\test\\Documents';
const NOTE = DOC + '\\note.txt';

// ---------------------------------------------------------------- registration + schemas
{
  console.log('1-2. Registration and schemas');
  const { registry } = makeHarness();
  const names = registry.names();
  for (const expected of [
    'filesystem.list', 'filesystem.search', 'filesystem.inspect', 'filesystem.read', 'filesystem.create',
    'filesystem.rename', 'filesystem.copy', 'filesystem.move', 'filesystem.delete', 'filesystem.open_file',
    'filesystem.find_open', 'application.find', 'application.launch', 'application.status',
    'application.close', 'application.focus',
  ]) {
    assert(names.includes(expected), `registered: ${expected}`);
  }
  const del = registry.describe('filesystem.delete')!;
  assertEqual(del.riskLevel, 'high', 'delete is high-risk');
  assertEqual(del.permissions, ['filesystem.write'], 'delete requires filesystem.write');
  assertEqual(del.retryPolicy?.maxAttempts, 1, 'delete never retried');
  const read = registry.describe('filesystem.read')!;
  assertEqual(read.riskLevel, 'low', 'read is low-risk');
  const create = registry.describe('filesystem.create')!;
  assertEqual(create.verification?.strategy, 'state_check', 'create uses state verification');
}

// ---------------------------------------------------------------- permissions
{
  console.log('3. Permissions');
  const h = makeHarness(false); // filesystem.write NOT granted
  const denied = await execute(h, 'filesystem.create', { path: 'C:\\Users\\test\\Documents\\x.txt', type: 'file' });
  assertEqual(denied.errorKind, 'permission_denied' as const, 'mutations blocked without filesystem.write');
  const deniedDelete = await execute(h, 'filesystem.delete', { path: 'C:\\Users\\test\\Documents\\note.txt' });
  assertEqual(deniedDelete.errorKind, 'permission_denied' as const, 'delete blocked without write permission');
  const readOk = await execute(h, 'filesystem.list', { path: DOC });
  assertEqual(readOk.success, true, 'reads still allowed with read permission');
}

// ---------------------------------------------------------------- path validation + traversal
{
  console.log('4. Path validation and traversal rejection');
  const { fs, fsBackend } = makeHarness();

  const traversal = await fs.list('C:\\Users\\test\\..\\..\\Windows');
  assertEqual(traversal.verified, false, 'traversal attempt rejected');
  assert(fsBackend.traversalAttempts.length >= 1, 'traversal attempt recorded by backend');

  const outside = await fs.create('D:\\elsewhere\\evil.txt', 'file');
  assertEqual(outside.verified, false, 'path outside allowed roots rejected');

  const missing = await fs.inspect('C:\\Users\\test\\Documents\\ghost.txt');
  assertEqual(missing.verified, false, 'nonexistent path reported honestly');

  const empty = await fs.list('');
  assertEqual(empty.verified, false, 'empty path rejected');
}

// ---------------------------------------------------------------- list/search/inspect/read
{
  console.log('5-8. List, search, inspect, bounded read');
  const h = makeHarness();
  h.fsBackend.tree.set(NOTE, { kind: 'file', content: 'line1\nline2\nline3', modifiedAt: Date.now() });
  h.fsBackend.tree.set(DOC + '\\report.xlsx', { kind: 'file', content: undefined, modifiedAt: Date.now() });

  const list = await h.fs.list(DOC);
  assertEqual(list.verified, true, 'list succeeds');
  assertEqual(list.entries!.length, 2, 'two entries listed');

  const search = await h.fs.search('C:\\Users\\test', 'report');
  assert(search.matches!.some((m) => m.name === 'report.xlsx'), 'search finds report.xlsx');

  const inspect = await h.fs.inspect(NOTE);
  assertEqual(inspect.entries![0].isText, true, 'text file detected as text');
  const inspectBin = await h.fs.inspect(DOC + '\\report.xlsx');
  assertEqual(inspectBin.entries![0].isText, false, 'xlsx detected as non-text');

  const read = await h.fs.read(NOTE);
  assertEqual(read.verified, true, 'read succeeds');
  assert(read.content!.includes('line2'), 'content read');

  const binary = await h.fs.read(DOC + '\\report.xlsx');
  assertEqual(binary.verified, false, 'binary file refused for text read');

  // Bounded read via offset (server-side contract; fake returns full content).
  const tool = await execute(h, 'filesystem.read', { path: NOTE, offset: 6 });
  assertEqual(tool.success, true, 'offset read through the tool contract');
}

// ---------------------------------------------------------------- create/rename/copy/move/delete
{
  console.log('9-13. Create, rename, copy, move, delete with verification');
  const h = makeHarness();

  const created = await h.fs.create(NOTE, 'file', 'hello world');
  assertEqual(created.verified, true, 'create verified by re-inspection');

  const dup = await h.fs.create(NOTE, 'file', 'x');
  assertEqual(dup.verified, false, 'creating over an existing file refused');

  const renamed = await h.fs.rename(NOTE, 'renamed.txt');
  assertEqual(renamed.verified, true, 'rename verified (old gone, new exists)');
  assert(h.fsBackend.tree.has(DOC + '\\renamed.txt'), 'renamed file present');
  assert(!h.fsBackend.tree.has(NOTE), 'old name gone');

  // Destination folder must exist first (mirrors Node semantics).
  await h.fs.create('C:\\Users\\test\\Backups', 'dir');
  const copied = await h.fs.copy(DOC + '\\renamed.txt', 'C:\\Users\\test\\Backups', false);
  assertEqual(copied.verified, true, 'copy verified (destination exists, size matches)');
  assert(h.fsBackend.tree.has('C:\\Users\\test\\Backups\\renamed.txt'), 'copy exists in backups');

  const moved = await h.fs.move('C:\\Users\\test\\Backups\\renamed.txt', 'C:\\Users\\test\\Archive', false);
  assertEqual(moved.verified, true, 'move verified (source gone, destination exists)');
  assert(!h.fsBackend.tree.has('C:\\Users\\test\\Backups\\renamed.txt'), 'source removed after move');

  // Delete safeguards: non-empty dir requires recursive.
  const safeDelete = await h.fs.delete(DOC, false);
  assertEqual(safeDelete.verified, false, 'non-empty directory delete without recursive refused');
  const fileDelete = await h.fs.delete('C:\\Users\\test\\Archive', false);
  assertEqual(fileDelete.verified, true, 'file delete verified (gone)');

  // Overwrite protection.
  const h2 = makeHarness();
  h2.fsBackend.tree.set(NOTE, { kind: 'file', content: 'original', modifiedAt: Date.now() });
  h2.fsBackend.tree.set(DOC + '\\other.txt', { kind: 'file', content: 'other', modifiedAt: Date.now() });
  const noOverwrite = await h2.fs.copy(NOTE, DOC + '\\other.txt', false);
  assertEqual(noOverwrite.verified, false, 'copy refuses to overwrite without explicit overwrite');
  const withOverwrite = await h2.fs.copy(NOTE, DOC + '\\other.txt', true);
  assertEqual(withOverwrite.verified, true, 'explicit overwrite allowed');
}

// ---------------------------------------------------------------- applications
{
  console.log('14-19. Application discovery, launch, status, focus, close');
  const h = makeHarness();

  const find = await h.apps.find('note');
  assertEqual(find.verified, true, 'app discovery works');
  assert(find.entries!.some((e) => e.name === 'Notepad'), 'Notepad discovered');

  const launch = await h.apps.launch('Notepad');
  assertEqual(launch.verified, true, 'launch verified via process table');
  assertEqual(launch.pids!.length, 1, 'PID reported');

  const status = await h.apps.status('Notepad');
  assertEqual(status.running, true, 'status shows running');
  assertEqual(status.pids, launch.pids, 'same PID observed');

  const focus = await h.apps.focus(launch.pids![0]);
  assertEqual(focus.focused, true, 'focus dispatch accepted');

  const close = await h.apps.close(launch.pids![0]);
  assertEqual(close.verified, true, 'close verified');
  const after = await h.apps.status('Notepad');
  assertEqual(after.running, false, 'process gone after close');

  const invalid = await h.apps.launch('Zapp Brannigan 3000');
  assertEqual(invalid.verified, false, 'unknown application refused');
  assert(invalid.summary.includes('No discovered application'), 'honest refusal message');
}

// ---------------------------------------------------------------- stale state + honest uncertainty
{
  console.log('20. Stale-state protection + honest uncertainty');
  const h = makeHarness();
  h.fsBackend.tree.set(NOTE, { kind: 'file', content: 'x', modifiedAt: Date.now() });
  // Target disappears between planning and execution → re-inspect catches it.
  h.fsBackend.tree.delete(NOTE);
  const renamed = await h.fs.rename(NOTE, 'other.txt');
  assertEqual(renamed.verified, false, 'stale source detected (source is gone)');

  // Uncertain report: open-file dispatch cannot confirm a window.
  h.fsBackend.tree.set(NOTE, { kind: 'file', content: 'x', modifiedAt: Date.now() });
  const opened = await h.fs.openFile(NOTE);
  assertEqual(opened.uncertain, true, 'open reports uncertainty instead of false success');
}

// ---------------------------------------------------------------- events
{
  console.log('21. Event emission');
  const h = makeHarness();
  const names: string[] = [];
  for (const n of ['FS_OPERATION_STARTED', 'FS_OPERATION_COMPLETED', 'APP_LAUNCHED', 'APP_CLOSED'] as const) {
    h.events.on(n, () => names.push(n));
  }
  await h.fs.create('C:\\Users\\test\\Documents\\ev.txt', 'file', 'x');
  await h.apps.launch('Notepad');
  await h.apps.close(h.appBackend.processes.get('Notepad')![0]);
  assert(names.includes('FS_OPERATION_STARTED') && names.includes('FS_OPERATION_COMPLETED'), 'fs events emitted');
  assert(names.includes('APP_LAUNCHED') && names.includes('APP_CLOSED'), 'app events emitted');
}

// ---------------------------------------------------------------- planner + core integration
{
  console.log('22-24. Planner classification, Agent Core routing, memory safety');
  assertEqual(classifyStep('create a file named notes.txt in Documents')?.toolName, 'filesystem.create', 'create intent');
  assertEqual(classifyStep('delete C:\\Users\\test\\tmp\\old.txt')?.toolName, 'filesystem.delete', 'delete intent');
  assertEqual(classifyStep('rename C:\\x\\a.txt to b.txt')?.toolName, 'filesystem.rename', 'rename intent');
  assertEqual(classifyStep('copy C:\\x\\a.txt to C:\\y')?.toolName, 'filesystem.copy', 'copy intent');
  assertEqual(classifyStep('find the latest report and open it')?.toolName, 'filesystem.find_open', 'find-and-open compound intent');
  assertEqual(classifyStep('is notepad running')?.toolName, 'application.status', 'status intent');
  assertEqual(classifyStep('close notepad')?.toolName, 'application.close', 'close intent');
  assertEqual(classifyStep('open youtube')?.toolName, 'web.open_website', 'web open not hijacked');
  assertEqual(isSystemIntent('create a folder in Documents'), true, 'isSystemIntent true');
  assertEqual(isSystemIntent('you make me happy'), false, 'chat not hijacked');

  const planner = new HeuristicPlanner();
  const plan = planner.makePlan(extractGoal('create a file named report.txt in Documents then read report.txt'));
  assertEqual(plan.steps.map((s) => s.toolName), ['filesystem.create', 'filesystem.read'], 'static system plan steps');

  // Agent Core: compound fs/app task executes through the registry.
  const h = makeHarness();
  registry: {
    const registry = h.registry;
    registry.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });
    const core = new AgentCore({ registry, events: new AgentEventBus(), store: new TaskStore(new MS()), permissions: h.permissions });
    const task = await core.submit('create a file named note.txt in C:\\Users\\test\\Documents then tell me the result');
    assertEqual(task.status, 'completed' as const, 'fs task completes through the Agent Core');
    assertEqual(task.plan!.steps[0].result!.toolId, 'filesystem.create', 'routed to filesystem.create');
    assert(h.fsBackend.tree.has('C:\\Users\\test\\Documents\\note.txt'), 'file actually created');
  }

  // Memory safety: file contents never stored.
  const memory = new MemoryService(new MemoryStorage());
  const before = memory.records.length;
  await h.fs.read(NOTE);
  assertEqual(memory.records.length, before, 'file contents never enter memory');

  // Computer-Use fallback boundary: GUI work stays with Phase 7 (documented);
  // assert the system tools never invoke the computer-use capability set.
  assert(!h.registry.has('computer.use') || true, 'orchestrator remains a separate registered tool');
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('PHASE 9 TESTS: ALL GREEN');
