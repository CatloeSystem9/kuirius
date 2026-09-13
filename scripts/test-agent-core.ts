/**
 * Phase 1 verification suite — runs the Agent Core under Node with mock tools.
 * Usage: npx tsx scripts/test-agent-core.ts
 * Exits non-zero on any failure.
 */
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import {
  isMultiStepRequest,
  splitIntoClauses,
  classifyStep,
  HeuristicPlanner,
  extractGoal,
} from '../src/agent/planner';
import type { AgentTool, ToolResult } from '../src/agent/types';
import { ok, fail } from '../src/agent/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function makeCore(registry: ToolRegistry, overrides: Partial<ConstructorParameters<typeof AgentCore>[0]> = {}) {
  return new AgentCore({
    registry,
    events: new AgentEventBus(),
    store: new TaskStore(new MemoryStorage()),
    ...overrides,
  });
}

function tool(name: string, execute: AgentTool['execute'], extra: Partial<AgentTool> = {}): AgentTool {
  return { name, description: name, category: 'test', riskLevel: 'low', execute, ...extra };
}

// ---------------------------------------------------------------- events bus
{
  console.log('EventBus');
  const bus = new AgentEventBus();
  const got: string[] = [];
  const off = bus.on('TASK_STARTED', (e) => got.push(e.name));
  bus.emit({ name: 'TASK_STARTED', timestamp: 1 });
  off();
  bus.emit({ name: 'TASK_STARTED', timestamp: 2 });
  assertEqual(got, ['TASK_STARTED'], 'unsubscribe stops delivery');
}

// ---------------------------------------------------------------- registry
{
  console.log('ToolRegistry');
  const registry = new ToolRegistry();
  registry.register(tool('a', async () => ok()));
  registry.register(tool('b', async () => ok()));
  assert(registry.has('a') && !registry.has('z'), 'has() reflects registrations');
  assertEqual(registry.names().sort(), ['a', 'b'], 'names()');
  assertEqual(registry.catalog().length, 2, 'catalog() lists tools');
  let threw = false;
  try {
    registry.register({ name: '', description: '', category: '', riskLevel: 'low', execute: async () => ok() });
  } catch {
    threw = true;
  }
  assert(threw, 'rejects unnamed tool');
}

// ---------------------------------------------------------------- planner
{
  console.log('Planner — decomposition');
  assert(isMultiStepRequest('Open YouTube then search lofi beats on youtube and tell me the result'), 'multi-step with then');
  assert(isMultiStepRequest('open vscode; run the tests; report the result'), 'multi-step with ;');
  assert(!isMultiStepRequest('hey then what happened'), 'question not hijacked');
  assert(!isMultiStepRequest('open youtube'), 'single command stays inline');
  assert(!isMultiStepRequest('you make me happy'), 'chat not hijacked');
  assertEqual(splitIntoClauses('Open YouTube then search lofi and tell me the result'), ['Open YouTube', 'search lofi', 'tell me the result'], 'clause split');

  const webOpen = classifyStep('open youtube');
  assertEqual(webOpen?.toolName, 'web.open_website', 'classify web open');
  const webSearch = classifyStep('search lofi beats on youtube');
  assertEqual(webSearch?.toolName, 'web.search_website', 'classify web search');
  const app = classifyStep('open calculator');
  assertEqual(app?.toolName, 'app.launch', 'classify app launch');
  const fileOpen = classifyStep('open resume.pdf');
  assertEqual(fileOpen?.toolName, 'files.open', 'classify file open');
  const scan = classifyStep('scan downloads folder');
  assertEqual(scan?.toolName, 'files.scan', 'classify folder scan');
  const loc = classifyStep('check my location');
  assertEqual(loc?.toolName, 'location.get', 'classify location');
  const report = classifyStep('tell me the result');
  assertEqual(report?.toolName, 'chat.report', 'classify report');
  const note = classifyStep('hug a cloud');
  assertEqual(note?.toolName, 'system.note', 'unclassifiable becomes note');
}

{
  console.log('Planner — plan shape');
  const planner = new HeuristicPlanner();
  const plan = planner.makePlan(extractGoal('Open YouTube then search lofi beats on youtube and tell me the result'));
  assertEqual(plan.steps.map((s) => s.toolName), ['web.open_website', 'web.search_website', 'chat.report'], 'three-step plan');
  assert(plan.steps.every((s) => s.status === 'pending'), 'steps start pending');

  const long = planner.makePlan(extractGoal(Array.from({ length: 15 }, (_, i) => `open site${i}.com`).join(' then ')));
  assert(long.steps.length <= 10, `plan capped at 10 steps (got ${long.steps.length})`);
}

// ---------------------------------------------------------------- core: happy path
{
  console.log('AgentCore — happy path');
  const registry = new ToolRegistry();
  const calls: string[] = [];
  registry.register(
    tool('web.open_website', async (input) => {
      calls.push('open:' + (input as any).action?.url);
      return ok({ output: { opened: true }, ui: [] });
    })
  );
  registry.register(tool('chat.report', async () => ok({ output: { acknowledged: true } })));

  const core = makeCore(registry);
  const events: string[] = [];
  core.events.on('TASK_PLANNED', () => events.push('planned'));
  core.events.on('TASK_STEP_COMPLETED', () => events.push('step_done'));
  core.events.on('TASK_COMPLETED', () => events.push('task_done'));

  const task = await core.submit('Open https://youtube.com then tell me the result');

  assertEqual(task.status, 'completed' as const, 'task completed');
  assertEqual(events, ['planned', 'step_done', 'step_done', 'task_done'], 'event order');
  assertEqual(calls, ['open:https://youtube.com'], 'tool executed once with right input');
  assert(task.summary!.includes('All 2 steps completed'), 'honest summary counts steps');
  assert(task.plan!.steps.every((s) => s.verified), 'all steps verified');
}

// ---------------------------------------------------------------- core: retry then success
{
  console.log('AgentCore — retry handling');
  const registry = new ToolRegistry();
  let attempts = 0;
  // 'flaky' classifies to system.note, so the mock registers under that name.
  registry.register(
    tool('system.note', async () => {
      attempts++;
      if (attempts === 1) return fail('temporary failure', { retryable: true });
      return ok({ output: { recovered: true } });
    })
  );
  const core = makeCore(registry, { retryDelayMs: 10 });
  const task = await core.submit('flaky');
  assertEqual(task.status, 'completed' as const, 'recovered after retry');
  assertEqual(task.plan!.steps[0].attempts, 2, 'two attempts recorded');
}

// ---------------------------------------------------------------- core: permanent failure
{
  console.log('AgentCore — failure stops task honestly');
  const registry = new ToolRegistry();
  registry.register(tool('system.note', async () => fail('permission denied', { retryable: false })));
  registry.register(tool('chat.report', async () => ok()));
  const core = makeCore(registry);
  const task = await core.submit('always_fails then tell me the result');
  assertEqual(task.status, 'failed' as const, 'task failed');
  assert(task.error!.includes('permission denied'), 'error surfaced');
  assert(task.plan!.steps[1].status === 'skipped', 'remaining step skipped');
  assert(task.summary!.includes('0 of 2 steps'), 'summary admits partial completion');
}

// ---------------------------------------------------------------- core: timeout
{
  console.log('AgentCore — timeout handling');
  const registry = new ToolRegistry();
  registry.register(
    tool('system.note', async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return ok();
    })
  );
  const core = makeCore(registry, { stepTimeoutMs: 60 });
  const started = Date.now();
  const task = await core.submit('hangs');
  const elapsed = Date.now() - started;
  assertEqual(task.status, 'failed' as const, 'hanging step fails');
  assert(task.error!.includes('timed out'), 'timeout error surfaced');
  assert(elapsed < 300, `failed fast (${elapsed}ms, not the full 400ms)`);
}

// ---------------------------------------------------------------- core: cancellation
{
  console.log('AgentCore — cancellation');
  const registry = new ToolRegistry();
  registry.register(
    tool('system.note', async (input, ctx) => {
      const text = String(input.text || '');
      if (text.includes('slow')) {
        return new Promise<ToolResult>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(ok()));
        });
      }
      return ok({ output: 'done' });
    })
  );
  const core = makeCore(registry);
  const cancelEvent: boolean[] = [];
  core.events.on('TASK_CANCELLED', () => cancelEvent.push(true));

  const pending = core.submit('quick then slow');
  // Give the loop time to reach the slow step, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const runningTask = core.store.list().find((t) => t.status === 'running');
  assert(Boolean(runningTask), 'task was running before cancel');
  core.cancel(runningTask!.id);
  const task = await pending;
  assertEqual(task.status, 'cancelled' as const, 'task cancelled');
  assertEqual(cancelEvent.length, 1, 'TASK_CANCELLED emitted');
  assert(task.plan!.steps[1].status === 'cancelled', 'second step marked cancelled');
  assert(task.summary!.includes('stopped'), 'cancellation summary honest');
}

// ---------------------------------------------------------------- core: unknown tool
{
  console.log('AgentCore — unknown tool fails cleanly');
  const registry = new ToolRegistry();
  const core = makeCore(registry);
  const task = await core.submit('open youtube');
  // 'open youtube' would classify via real detectors only if webActions imported —
  // in this isolated registry the planner still classifies it as web.open_website.
  assertEqual(task.status, 'failed' as const, 'task fails without tool');
  assert(task.error!.includes('Unknown tool'), 'clear unknown-tool error');
}

// ---------------------------------------------------------------- core: verification contract
{
  console.log('AgentCore — verification contract');
  const registry = new ToolRegistry();
  // 'producer' classifies to system.note, so the mock registers under that name.
  registry.register(tool('system.note', async () => ok({ output: { status: 'PENDING' } })));
  const core = makeCore(registry, { maxAttemptsPerStep: 1 });
  const task = await core.submit('producer');
  assertEqual(task.status, 'completed' as const, 'tool_success verification passes on success');
  assert(task.plan!.steps[0].verified === true, 'step marked verified');
}

// ---------------------------------------------------------------- persistence
{
  console.log('TaskStore persistence');
  const storage = new MemoryStorage();
  const store = new TaskStore(storage);
  const goal = extractGoal('Open YouTube then tell me the result');
  const task = store.create(goal, Date.now());
  store.update(task.id, (t) => {
    t.status = 'completed';
  });
  const raw = storage.getItem('krisha_agent_tasks_v1');
  assert(Boolean(raw) && raw!.includes('completed'), 'tasks serialized to storage');

  const reloaded = new TaskStore(storage);
  const restored = reloaded.get(task.id);
  assert(Boolean(restored), 'task restored after reload');
  assertEqual(restored!.status, 'completed' as const, 'terminal status survives reload');

  // A task that was mid-flight when the app closed must be marked interrupted.
  const storage2 = new MemoryStorage();
  const store2 = new TaskStore(storage2);
  const running = store2.create(extractGoal('x'), Date.now());
  store2.update(running.id, (t) => {
    t.status = 'running';
  });
  const afterReload = new TaskStore(storage2);
  assertEqual(afterReload.get(running.id)!.status, 'interrupted' as const, 'running task marked interrupted on reload');
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('PHASE 1 TESTS: ALL GREEN');
