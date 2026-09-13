/**
 * Phase 3 verification suite — tool system under Node with mock tools.
 * Usage: npx tsx scripts/test-tools-phase3.ts
 * Exits non-zero on any failure.
 */
import { ToolRegistry } from '../src/agent/toolRegistry';
import { selectToolForCapability, rankToolsForCapability } from '../src/agent/toolSelector';
import { PermissionManager } from '../src/agent/permissions';
import { AgentEventBus } from '../src/agent/events';
import { AgentCore } from '../src/agent/agentCore';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { HeuristicPlanner } from '../src/agent/planner';
import { createBrowserTools } from '../src/agent/browserTools';
import { MemoryService } from '../src/agent/memory/memoryService';
import type { AgentTool, ToolResult } from '../src/agent/types';
import { ok, fail } from '../src/agent/types';
import type { AgentSystem } from '../src/agent/bridge';
import { attachMemoryToSystem } from '../src/agent/memory/memoryBridge';

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
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/** Minimal legacy-style tool (Phase 1 shape — no extra metadata). */
function legacyTool(name: string, execute: AgentTool['execute']): AgentTool {
  return { name, description: name, category: 'system', riskLevel: 'low', execute };
}

/** Fully-declared tool (Phase 3 shape). */
function fullTool(overrides: Partial<AgentTool> & { name: string; execute: AgentTool['execute'] }): AgentTool {
  return {
    description: overrides.name,
    category: 'system',
    riskLevel: 'low',
    ...overrides,
  } as AgentTool;
}

// ---------------------------------------------------------------- 1-3. registration, duplicates, lookup
{
  console.log('1-3. Registration, duplicates, lookup');
  const bus = new AgentEventBus();
  const registered: string[] = [];
  bus.on('TOOL_REGISTERED', (e) => registered.push(String((e.payload as any)?.tool)));
  const registry = new ToolRegistry(bus);

  registry.register(legacyTool('legacy.a', async () => ok()));
  registry.register(
    fullTool({
      name: 'full.a',
      execute: async () => ok(),
      category: 'web',
      capabilities: ['browser.open_url'],
      permissions: ['browser.interaction'],
      cost: 'cheap',
      timeoutMs: 1234,
    })
  );

  assertEqual(registered.sort(), ['full.a', 'legacy.a'], 'TOOL_REGISTERED emitted per registration');

  let dupThrew = false;
  try {
    registry.register(legacyTool('legacy.a', async () => ok()));
  } catch {
    dupThrew = true;
  }
  assert(dupThrew, 'duplicate registration rejected');

  assert(Boolean(registry.get('legacy.a')), 'get() by name');
  assertEqual(registry.has('nope'), false, 'has() false for unknown');

  const described = registry.describe('full.a');
  assert(described !== null && described.timeoutMs === 1234 && described.capabilities.includes('browser.open_url'), 'describe() exposes contract');
  assertEqual(registry.describe('nope'), null, 'describe() null for unknown');

  assertEqual(registry.findByCategory('web').map((t) => t.name), ['full.a'], 'findByCategory');
  assertEqual(registry.findByCapability('browser.open_url').map((t) => t.name), ['full.a'], 'findByCapability');

  const unreg = new ToolRegistry();
  unreg.register(legacyTool('x', async () => ok()));
  assert(unreg.unregister('x') === true && unreg.unregister('x') === false, 'unregister returns true once');
}

// ---------------------------------------------------------------- 4. input validation
{
  console.log('4. Input validation');
  const registry = new ToolRegistry();
  registry.register(
    fullTool({
      name: 'validator',
      execute: async () => ok(),
      inputSchema: {
        required: ['text'],
        optional: ['limit'],
        types: { text: 'string', limit: 'number' },
        validators: { limit: (v) => (v as number) > 0 },
      },
    })
  );

  assert(registry.validateInvocation('validator', { text: 'hello', limit: 2 }).valid, 'valid input passes');
  assertEqual(registry.validateInvocation('validator', {}).errors.length, 1, 'missing required detected');
  assert(
    registry.validateInvocation('validator', { text: 'x', limit: 'two' }).errors.some((e) => e.includes('must be number')),
    'type mismatch detected'
  );
  assertEqual(registry.validateInvocation('validator', { text: 'x', limit: -1 }).errors.length, 1, 'custom validator applied');
  assertEqual(registry.validateInvocation('validator', { text: 'x', rogue: 1 }).errors.length, 1, 'unexpected key rejected');
  assertEqual(registry.validateInvocation('ghost', {}).valid, false, 'unknown tool invalid');

  const result = await registry.execute('validator', {});
  assertEqual(result.success, false, 'invalid input never reaches execute()');
  assertEqual(result.errorKind, 'invalid_input' as const, 'invalid_input classification');
  assertEqual(result.retryable, false, 'invalid input not retryable');
}

// ---------------------------------------------------------------- 5-6. permissions & risk
{
  console.log('5-6. Permissions and risk metadata');
  const registry = new ToolRegistry();
  registry.register(
    fullTool({
      name: 'guarded',
      execute: async () => ok({ output: 'ran' }),
      permissions: ['filesystem.write'],
      riskLevel: 'high',
    })
  );
  const permissions = new PermissionManager();

  assert(permissions.isGranted('browser.interaction'), 'default grant: browser');
  assert(!permissions.isGranted('filesystem.write'), 'default deny: filesystem.write');

  const denied = await registry.execute('guarded', {}, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assertEqual(denied.success, false, 'denied tool does not execute');
  assertEqual(denied.errorKind, 'permission_denied' as const, 'permission_denied classification');
  assertEqual(denied.retryable, false, 'permission failure not retryable');

  permissions.grant('filesystem.write');
  const allowed = await registry.execute('guarded', {}, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions,
  });
  assertEqual(allowed.success, true, 'granted tool executes');

  assertEqual(permissions.missing(['filesystem.write', 'camera.access']), ['camera.access'], 'missing() reports only ungranted');
  assert(permissions.requiresConfirmation('high') && permissions.requiresConfirmation('critical'), 'confirmation policy: high+');
  assert(!permissions.requiresConfirmation('medium'), 'confirmation policy: medium exempt');
  assert(registry.findAvailable(permissions).some((t) => t.name === 'guarded'), 'findAvailable includes granted tool');

  permissions.revoke('filesystem.write');
  assert(!registry.findAvailable(permissions).some((t) => t.name === 'guarded'), 'findAvailable excludes revoked tool');
}

// ---------------------------------------------------------------- 7. successful execution & normalization
{
  console.log('7. Normalized successful result');
  const registry = new ToolRegistry();
  // The planner classifies bare text as a system.note step, so the mock tool
  // registers under that name and declares an output_contains strategy.
  registry.register(
    fullTool({
      name: 'system.note',
      execute: async () => ok({ output: { status: 'COMPLETED', file: 'report.txt' } }),
      verification: { strategy: 'output_contains', expectedOutput: 'COMPLETED' },
    })
  );
  const result = await registry.execute('system.note', { text: 'x' });
  assertEqual(result.success, true, 'success');
  assertEqual(result.toolId, 'system.note', 'toolId attached');
  assert(typeof result.timestamp === 'number' && typeof result.durationMs === 'number', 'timestamp + duration attached');
  assert(result.verified !== true, 'registry does not claim verification (core verifies)');

  // Core-side verification of the declared output_contains strategy.
  const core = new AgentCore({
    registry,
    events: new AgentEventBus(),
    store: new TaskStore(new MemoryStorage()),
    permissions: new PermissionManager(),
  });
  const task = await core.submit('producer');
  assertEqual(task.status, 'completed' as const, 'task completed with declared verification');
  assert(task.plan!.steps[0].verified === true, 'verified flag set');
}

// ---------------------------------------------------------------- 8-9. failures & retries
{
  console.log('8-9. Failure classification and retry policies');
  // Scenario A: tool declares retryPolicy.maxAttempts = 3 and recovers on attempt 3.
  const registryA = new ToolRegistry();
  let attempts = 0;
  registryA.register(
    fullTool({
      name: 'system.note',
      execute: async () => {
        attempts++;
        if (attempts < 3) return fail('network timeout while fetching', { retryable: true });
        return ok({ output: 'finally' });
      },
      retryPolicy: { maxAttempts: 3 },
    })
  );
  const core1 = new AgentCore({
    registry: registryA, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()),
    retryDelayMs: 5,
  });
  const t1 = await core1.submit('flaky.network');
  assertEqual(t1.status, 'completed' as const, 'tool retryPolicy.maxAttempts respected (recovered on attempt 3)');
  assertEqual(t1.plan!.steps[0].attempts, 3, 'three attempts recorded');

  // Scenario B: a tool that throws — registry normalizes the rejection.
  const registryB = new ToolRegistry();
  registryB.register(
    fullTool({
      name: 'always.throws',
      execute: async () => {
        throw new Error('disk exploded');
      },
    })
  );
  const result = await registryB.execute('always.throws', {});
  assertEqual(result.success, false, 'thrown error normalized to failure (no throw escapes)');
  assertEqual(result.errorKind, 'execution_error' as const, 'execution_error classification');
  assertEqual(result.retryable, true, 'execution_error retryable by classification');

  // Scenario C: tool declares its failure non-retryable — core must respect that.
  const registryC = new ToolRegistry();
  registryC.register(
    fullTool({
      name: 'system.note',
      execute: async () => fail('bad request shape', { retryable: false, errorKind: 'invalid_input' }),
    })
  );
  const core2 = new AgentCore({
    registry: registryC, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()),
    maxAttemptsPerStep: 3, retryDelayMs: 5,
  });
  const retried: number[] = [];
  core2.events.on('TOOL_RETRIED', () => retried.push(1));
  const t2 = await core2.submit('never.retries');
  assertEqual(t2.status, 'failed' as const, 'non-retryable failure stops task');
  assertEqual(t2.plan!.steps[0].attempts, 1, 'non-retryable not retried despite core maxAttempts=3');
  assertEqual(retried.length, 0, 'no TOOL_RETRIED for non-retryable failure');
}

// ---------------------------------------------------------------- 10. cancellation
{
  console.log('10. Cancellation');
  const registry = new ToolRegistry();
  registry.register(
    fullTool({
      name: 'system.note',
      execute: async (_input, ctx) =>
        new Promise<ToolResult>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(ok()));
        }),
    })
  );
  const core = new AgentCore({
    registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()),
  });
  const cancelledEvents: string[] = [];
  core.events.on('TOOL_CANCELLED', (e) => cancelledEvents.push(String((e.payload as any)?.tool)));

  const pending = core.submit('slow.cooperative');
  await new Promise((r) => setTimeout(r, 80));
  const running = core.store.list().find((t) => t.status === 'running');
  core.cancel(running!.id);
  const task = await pending;
  assertEqual(task.status, 'cancelled' as const, 'task cancelled');
  assertEqual(cancelledEvents, ['system.note'], 'TOOL_CANCELLED emitted with tool id');
}

// ---------------------------------------------------------------- 11. tool-specific timeout
{
  console.log('11. Tool-specific timeout');
  const registry = new ToolRegistry();
  registry.register(
    fullTool({
      name: 'system.note',
      execute: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return ok();
      },
      timeoutMs: 80,
    })
  );
  const core = new AgentCore({
    registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()),
    stepTimeoutMs: 30000, // core default would allow it; tool override must win
  });
  const started = Date.now();
  const task = await core.submit('slow.tool');
  const elapsed = Date.now() - started;
  assertEqual(task.status, 'failed' as const, 'tool timeout enforced over core default');
  assert(elapsed < 400, `timed out at tool timeout (${elapsed}ms)`);
  assert(task.error!.includes('timed out'), 'timeout error surfaced');
}

// ---------------------------------------------------------------- 12-13. events & selection observability
{
  console.log('12-13. Tool events and selection observability');
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  registry.register(
    fullTool({
      name: 'cap.web',
      execute: async () => ok({ output: { opened: true } }),
      capabilities: ['browser.open_url'],
      cost: 'cheap',
    })
  );
  registry.register(
    fullTool({
      name: 'cap.web.alt',
      execute: async () => ok({ output: { opened: true } }),
      capabilities: ['browser.open_url'],
      cost: 'moderate', // more expensive — must lose selection
    })
  );

  const selection = selectToolForCapability(registry, 'browser.open_url');
  assertEqual(selection!.tool.name, 'cap.web', 'cheapest tool selected');
  assert(selection!.reason.includes('capability "browser.open_url" matched cap.web'), 'selection reason explains choice');
  assertEqual(selection!.candidatesConsidered, 2, 'candidate count recorded');

  const core = new AgentCore({
    registry, events: bus, store: new TaskStore(new MemoryStorage()),
  });
  const events: string[] = [];
  bus.on('TOOL_SELECTED', (e) => events.push('selected:' + String((e.payload as any)?.tool)));
  bus.on('TOOL_STARTED', () => events.push('started'));
  bus.on('TOOL_COMPLETED', () => events.push('completed'));
  bus.on('TOOL_VERIFIED', () => events.push('verified'));

  const task = await core.submit('open https://example.com then tell me the result');
  // Step 1 resolves via capability; step 2 (chat.report) has no registered tool with that
  // capability → direct-name fallback fails → task fails after step 1.
  assert(events.includes('selected:cap.web'), 'TOOL_SELECTED emitted with chosen tool');
  const idxSelected = events.indexOf('selected:cap.web');
  const idxStarted = events.indexOf('started');
  const idxCompleted = events.indexOf('completed');
  const idxVerified = events.indexOf('verified');
  assert(idxSelected !== -1 && idxStarted !== -1 && idxCompleted !== -1 && idxVerified !== -1, 'lifecycle events emitted');
  assert(idxSelected < idxStarted && idxStarted < idxCompleted && idxCompleted < idxVerified, 'event ordering: selected → started → completed → verified');
  assertEqual(task.plan!.steps[0].result!.toolId, 'cap.web', 'result carries resolved toolId');
}

// ---------------------------------------------------------------- 14. selection respects permissions
{
  console.log('14. Selection with permission constraints');
  const registry = new ToolRegistry();
  registry.register(
    fullTool({
      name: 'web.free',
      execute: async () => ok(),
      capabilities: ['browser.open_url'],
      permissions: [], // no permission needed
      cost: 'cheap',
    })
  );
  registry.register(
    fullTool({
      name: 'web.blocked',
      execute: async () => ok(),
      capabilities: ['browser.open_url'],
      permissions: ['terminal.execution'], // denied by default
      cost: 'free', // cheaper, but unavailable
    })
  );
  const permissions = new PermissionManager();
  const selection = selectToolForCapability(registry, 'browser.open_url');
  // Selection ranks on cost/risk metadata; permission enforcement happens at execution.
  assertEqual(selection!.tool.name, 'web.blocked', 'cheapest candidate selected (permission enforcement is at execution)');

  const core = new AgentCore({
    registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), permissions,
  });
  const t = await core.submit('open https://example.com');
  assertEqual(t.status, 'failed' as const, 'task fails when the selected tool lacks permissions');
  assert(t.plan!.steps[0].result!.errorKind === 'permission_denied', 'permission failure surfaced in step result');
}

// ---------------------------------------------------------------- 15. discovery via planner → capability end-to-end
{
  console.log('15. Planner emits capabilities; registry resolves them');
  const planner = new HeuristicPlanner();
  const plan = planner.makePlan({ description: 'x', rawInput: 'Open YouTube then search lofi on youtube and tell me the result', kind: 'command' });
  assertEqual(plan.steps.map((s) => s.capability), ['browser.open_url', 'browser.search', 'communication.report'], 'capabilities emitted');
  assertEqual(plan.steps.map((s) => s.toolName), ['web.open_website', 'web.search_website', 'chat.report'], 'fallback tool names kept');
}

// ---------------------------------------------------------------- 16. legacy tool compatibility through the core
{
  console.log('16. Legacy (Phase 1 minimal) tools still work');
  const registry = new ToolRegistry();
  // Minimal Phase 1-shaped tool, registered under the name the planner picks.
  registry.register(legacyTool('system.note', async () => ok({ output: 'works' })));
  const core = new AgentCore({
    registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()),
  });
  const task = await core.submit('minimal.thing');
  assertEqual(task.status, 'completed' as const, 'minimal tool executes (direct-name fallback)');
  assertEqual(task.plan!.steps[0].result!.toolId, 'system.note', 'toolId normalized even for legacy tools');
}

// ---------------------------------------------------------------- 17. memory integration via tools
{
  console.log('17. Memory tools (Phase 2 integration)');
  const memory = new MemoryService(new MemoryStorage());
  const registry = new ToolRegistry();
  registry.registerAll(createBrowserTools(memory));

  assert(registry.findByCategory('memory').length === 3, 'memory tools registered under memory category');
  assert(registry.findByCategory('web').length === 2, 'web tools under web category');

  const remember = await registry.execute('memory.remember', { text: 'User prefers window seats on flights' });
  assertEqual(remember.success, true, 'memory.remember stores');
  assertEqual(String((remember.output as any)?.action), 'created', 'store outcome reported');

  const duplicate = await registry.execute('memory.remember', { text: 'The user prefers window seats on flights' });
  assertEqual(String((duplicate.output as any)?.action), 'merged', 'duplicate merged via Phase 2 dedup');

  const secret = await registry.execute('memory.remember', { text: 'my api key = sk-abcdefghij1234567890' });
  assertEqual(secret.success, false, 'secret rejected through tool contract');
  assertEqual(secret.errorKind, 'invalid_input' as const, 'secret rejection classified as invalid input');

  const recall = await registry.execute('memory.recall', { query: 'window seats on flights' });
  assertEqual(recall.success, true, 'memory.recall runs');
  assert(((recall.output as any)?.memories as string[]).some((m) => m.includes('window seats')), 'recalled memory contains fact');

  // Agent Core consumes memory through the execution context; "remember that ..."
  // classifies to the memory.remember tool via the planner.
  const core = new AgentCore({
    registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()),
    permissions: new PermissionManager(),
  });
  const system: AgentSystem = { core, bus: core.events, registry, permissions: core.permissions, detach: () => {} };
  const attachment = attachMemoryToSystem(system, memory);
  const task = await core.submit('remember that I enjoy rooftop gardening');
  assertEqual(task.status, 'completed' as const, 'memory task completed');
  assertEqual(task.plan!.steps[0].result!.toolId, 'memory.remember', 'remember command routed to memory tool');
  assert(memory.records.some((r) => r.content.includes('rooftop gardening')), 'fact stored through the task');
  attachment.detach();
}

// ---------------------------------------------------------------- 18. no sensitive data in validation errors
{
  console.log('18. Observability does not leak input payloads');
  const registry = new ToolRegistry();
  registry.register(
    fullTool({
      name: 'strict',
      execute: async () => ok(),
      inputSchema: { required: ['text'] },
    })
  );
  // Missing required key + an unexpected key carrying a secret value: the error
  // must name keys, never values.
  const result = await registry.execute('strict', { rogue: 'MY_SECRET_TOKEN_VALUE' });
  assertEqual(result.success, false, 'missing required key fails');
  assert(result.error!.includes('rogue'), 'error names the offending key');
  assert(!JSON.stringify(result).includes('MY_SECRET_TOKEN_VALUE'), 'validation error does not echo input values');
}

// ---------------------------------------------------------------- 19. tool catalog completeness (browser set)
{
  console.log('19. Browser tool catalog declares full contract');
  const memory = new MemoryService(new MemoryStorage());
  const registry = new ToolRegistry();
  registry.registerAll(createBrowserTools(memory));

  const catalog = registry.catalog();
  const requiredTools = [
    'web.open_website', 'web.search_website', 'app.launch', 'app.list',
    'files.search', 'files.open', 'files.scan', 'location.get', 'chat.report',
    'system.note', 'memory.remember', 'memory.recall', 'memory.search',
  ];
  for (const name of requiredTools) {
    const entry = catalog.find((t) => t.name === name);
    assert(Boolean(entry), `catalog contains ${name}`);
    assert(Boolean(entry?.description && entry.riskLevel), `${name} declares description + risk`);
  }

  const appLaunch = registry.describe('app.launch')!;
  assertEqual(appLaunch.permissions, ['application.launch'], 'app.launch declares application.launch permission');
  assertEqual(appLaunch.verification?.strategy, 'self_reported', 'app.launch verification is honest self_reported');
  assert(appLaunch.verification!.description!.includes('Phase 4'), 'verification description admits vision gap');

  const webOpen = registry.describe('web.open_website')!;
  assert(webOpen.capabilities.includes('browser.open_url'), 'web.open_website declares browser.open_url capability');

  // Selector prefers the cheapest, lowest-risk browser.open_url tool.
  const ranked = rankToolsForCapability(registry, 'browser.open_url');
  assert(ranked.length >= 2, 'multiple browser.open_url candidates exist');
  assertEqual(ranked[0].name, 'web.open_website', 'ranking deterministic (cost, risk, reliability)');
}

// ---------------------------------------------------------------- 20. core + memory bridge regression guard
{
  console.log('20. Core-level integration guard (core + registry + memory events)');
  const memory = new MemoryService(new MemoryStorage());
  const registry = new ToolRegistry();
  registry.registerAll(createBrowserTools(memory));
  const permissions = new PermissionManager();
  const core = new AgentCore({
    registry,
    events: new AgentEventBus(),
    store: new TaskStore(new MemoryStorage()),
    permissions,
    stepTimeoutMs: 5000,
  });
  // location.get requires location.access (granted by default) — with permission revoked it must fail cleanly.
  permissions.revoke('location.access');
  const task = await core.submit('check my location');
  assertEqual(task.status, 'failed' as const, 'revoked permission fails the task honestly');
  assert(task.error!.toLowerCase().includes('permission'), 'permission error surfaced');

  permissions.grant('location.access');
  const t2 = await core.submit('open https://example.com then tell me the result');
  assertEqual(t2.plan!.steps[0].result!.toolId, 'web.open_website', 'web step resolved through capability in full registry');
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('PHASE 3 TESTS: ALL GREEN');
