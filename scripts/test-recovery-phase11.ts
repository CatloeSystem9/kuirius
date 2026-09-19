/**
 * Phase 11 verification suite — Error Recovery subsystem.
 * Usage: npx tsx scripts/test-recovery-phase11.ts
 * Exits non-zero on any failure.
 *
 * Covers: failure classifier (14-part taxonomy), recovery policy (budgets,
 * idempotency guard, strategy mapping), context safety (validity tracking,
 * reference validation), recovery tools (record creation + sanitization),
 * strategy executor verification, recovery manager state machine, and the
 * full AgentCore integration (retry / re-observe / alternative step /
 * safe stop / stale-output invalidation).
 */
import {
  classifyFailure,
  RecoveryPolicy,
  RecoveryContextManager,
  RecoveryStrategyExecutor,
  RecoveryManager,
  createRecoveryRecord,
  sanitizeAction,
  isRecoverable,
} from '../src/agent/recovery';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import type { AgentGoal, AgentPlan, AgentTool, PlanStep, ToolResult } from '../src/agent/types';
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

function makeStep(partial: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 's1',
    description: 'test step',
    toolName: 'system.note',
    input: {},
    status: 'failed',
    attempts: 1,
    ...partial,
  };
}

function tool(name: string, execute: AgentTool['execute'], extra: Partial<AgentTool> = {}): AgentTool {
  return { name, description: name, category: 'test', riskLevel: 'low', execute, ...extra };
}

function staticPlanner(steps: PlanStep[]): { makePlan(goal: AgentGoal): AgentPlan; proposeAlternative(step: PlanStep, error: string): PlanStep | null } {
  return {
    makePlan: (goal: AgentGoal) => ({ goal, steps, createdAt: Date.now(), revision: 1 }),
    proposeAlternative: () => null,
  };
}

// ---------------------------------------------------------------- classifier
{
  console.log('Classifier — 14-part taxonomy');
  assertEqual(classifyFailure({ error: 'Permission denied: missing keyboard.control' }), 'PERMISSION_DENIED', 'permission');
  assertEqual(classifyFailure({ error: 'unauthorized access' }), 'PERMISSION_DENIED', 'unauthorized');
  assertEqual(classifyFailure({ error: 'This is unsafe and destructive' }), 'UNSAFE_OPERATION', 'unsafe');
  assertEqual(classifyFailure({ error: 'Step timed out after 30000ms' }), 'TIMEOUT', 'timeout');
  assertEqual(classifyFailure({ error: 'the foreground window changed' }), 'FOCUS_LOST', 'focus lost');
  assertEqual(classifyFailure({ error: 'stale signature mismatch' }), 'STALE_STATE', 'stale state');
  assertEqual(classifyFailure({ error: 'url mismatch after navigation' }), 'NAVIGATION_CHANGED', 'navigation');
  assertEqual(classifyFailure({ error: 'ENOENT: no such file' }), 'TARGET_NOT_FOUND', 'target not found');
  assertEqual(classifyFailure({ error: 'Invalid input for "x": missing required field' }), 'INVALID_INPUT', 'invalid input');
  assertEqual(classifyFailure({ error: 'unmet dependencies for step' }), 'DEPENDENCY_FAILURE', 'dependency');
  assertEqual(classifyFailure({ error: 'unresolved context reference' }), 'CONTEXT_FAILURE', 'context failure');
  assertEqual(classifyFailure({ error: 'ECONNREFUSED 127.0.0.1:3000' }), 'TRANSIENT', 'transient');
  assertEqual(classifyFailure({ error: 'tool failed with exception' }), 'TOOL_FAILURE', 'tool failure');
  assertEqual(classifyFailure({ error: 'weird unrelated error text' }), 'UNKNOWN', 'unknown');
  // errorKind takes priority over message text
  const kindResult: ToolResult = { success: false, error: 'something else', errorKind: 'permission_denied' };
  assertEqual(classifyFailure({ error: 'something else', result: kindResult }), 'PERMISSION_DENIED', 'errorKind overrides text');
  // success + unverified → verification failure
  assertEqual(
    classifyFailure({ error: 'x', result: { success: true, verified: false } }),
    'VERIFICATION_FAILURE',
    'verified:false result → verification failure'
  );
}

// ---------------------------------------------------------------- policy
{
  console.log('Policy — non-recoverable failures safe-stop immediately');
  const policy = new RecoveryPolicy({ maxAttemptsPerStep: 3, maxAttemptsPerTask: 10, maxRepeatedIdenticalFailures: 3 });
  const ctx = {
    taskId: 't1',
    step: makeStep(),
    error: 'e',
    stepAttemptCount: 1,
    taskRecoveryCount: 1,
    history: [],
  };
  assertEqual(policy.evaluate('PERMISSION_DENIED', ctx).strategy, 'SAFE_STOP', 'permission denied stops');
  assertEqual(policy.evaluate('UNSAFE_OPERATION', ctx).strategy, 'SAFE_STOP', 'unsafe op stops');
  assertEqual(policy.evaluate('INVALID_INPUT', ctx).strategy, 'SAFE_STOP', 'invalid input stops');
  assertEqual(policy.evaluate('DEPENDENCY_FAILURE', ctx).strategy, 'SAFE_STOP', 'dependency failure stops');
  assertEqual(policy.evaluate('CONTEXT_FAILURE', ctx).strategy, 'SAFE_STOP', 'context failure stops');

  console.log('Policy — recoverable failures map to bounded strategies');
  assertEqual(policy.evaluate('STALE_STATE', ctx).strategy, 'RE_OBSERVE', 'stale → re-observe');
  assertEqual(policy.evaluate('FOCUS_LOST', ctx).strategy, 'REFOCUS', 'focus lost → refocus');
  assertEqual(policy.evaluate('NAVIGATION_CHANGED', ctx).strategy, 'BROWSER_RECOVERY', 'navigation → browser recovery');
  assertEqual(policy.evaluate('TARGET_NOT_FOUND', ctx).strategy, 'RE_RESOLVE_TARGET', 'target missing → re-resolve');
  assertEqual(policy.evaluate('TRANSIENT', ctx).strategy, 'RETRY', 'transient → retry');

  console.log('Policy — idempotency guard on side-effecting tools');
  const clickStep = makeStep({ toolName: 'computer.click', capability: 'computer.click' });
  const clickCtx = { ...ctx, step: clickStep };
  assertEqual(policy.evaluate('TIMEOUT', clickCtx).strategy, 'RE_OBSERVE', 'side-effecting timeout re-observes (never blind retry)');
  assertEqual(policy.evaluate('TIMEOUT', ctx).strategy, 'RETRY', 'read-only timeout retries');
  assertEqual(policy.evaluate('VERIFICATION_FAILURE', clickCtx).strategy, 'RE_OBSERVE', 'side-effecting verification failure re-observes');
}

{
  console.log('Policy — budgets');
  const policy = new RecoveryPolicy({ maxAttemptsPerStep: 2, maxAttemptsPerTask: 6, maxRepeatedIdenticalFailures: 2 });
  const base = { taskId: 't1', step: makeStep(), error: 'e' };

  assertEqual(
    policy.evaluate('TRANSIENT', { ...base, stepAttemptCount: 2, taskRecoveryCount: 1, history: [] }).strategy,
    'SAFE_STOP',
    'step budget exhausted stops'
  );
  assertEqual(
    policy.evaluate('TRANSIENT', { ...base, stepAttemptCount: 1, taskRecoveryCount: 6, history: [] }).strategy,
    'SAFE_STOP',
    'task budget exhausted stops'
  );

  const hist = [
    createRecoveryRecord({ failureType: 'TRANSIENT', sourceTool: 'system.note', taskId: 't1', stepId: 's1', originalAction: 'a', attemptNumber: 1, recoveryStrategy: 'RETRY', recoveryResult: 'failed', safeToContinue: false }),
    createRecoveryRecord({ failureType: 'TRANSIENT', sourceTool: 'system.note', taskId: 't1', stepId: 's1', originalAction: 'a', attemptNumber: 2, recoveryStrategy: 'RETRY', recoveryResult: 'failed', safeToContinue: false }),
  ];
  assertEqual(
    policy.evaluate('TRANSIENT', { ...base, stepAttemptCount: 1, taskRecoveryCount: 1, history: hist }).strategy,
    'SAFE_STOP',
    'repeated identical failures stop'
  );
}

// ---------------------------------------------------------------- context safety
{
  console.log('Context manager — validity tracking');
  const cm = new RecoveryContextManager();
  const context: Record<string, unknown> = { found: { matches: ['a'] } };
  assertEqual(cm.invalidateOutput(context, 'found').found, undefined, 'invalidateOutput removes key');
  assertEqual(cm.getValidity('found'), 'INVALID', 'key marked INVALID after invalidation');
  cm.markValid('found');
  assertEqual(cm.getValidity('found'), 'VALID', 'markValid works');
  cm.markUnknown('other');
  assertEqual(cm.getValidity('other'), 'UNKNOWN', 'markUnknown reports UNKNOWN');
  assertEqual(cm.getValidity('never-seen'), 'UNKNOWN', 'untracked keys default to UNKNOWN');
}

{
  console.log('Context manager — step input validation');
  const cm = new RecoveryContextManager();
  const step = makeStep({ input: { path: { $context: 'found.matches.0.path' } } as Record<string, unknown> });
  const context: Record<string, unknown> = { found: { matches: [{ path: '/tmp/x' }] } };
  assertEqual(cm.extractContextRefs(step.input), ['found.matches.0.path'], 'extracts $context refs');
  const good = cm.validateStepInputs(step, context);
  assert(good.safe, 'valid refs pass validation');

  const missing = cm.validateStepInputs(step, { found: { matches: [] } });
  assert(!missing.safe && missing.missingKeys.length === 1, 'missing ref path fails validation');

  cm.markInvalid('found');
  const invalid = cm.validateStepInputs(step, context);
  assert(!invalid.safe && invalid.invalidKeys.length === 1, 'INVALID key fails validation');
}

// ---------------------------------------------------------------- recovery tools
{
  console.log('Recovery tools — sanitization');
  assertEqual(sanitizeAction('password=hunter2 and more'), '[REDACTED] and more', 'passwords redacted');
  assert(sanitizeAction('Authorization: Bearer abc123.def456').includes('[REDACTED]'), 'bearer tokens redacted');
  assert(sanitizeAction('x'.repeat(1000)).length <= 500, 'long text truncated');

  const rec = createRecoveryRecord({
    failureType: 'TIMEOUT',
    sourceTool: 'computer.click',
    taskId: 't1',
    stepId: 's1',
    originalAction: 'click the button with password=secret123',
    attemptNumber: 1,
    recoveryStrategy: 'RE_OBSERVE',
    recoveryResult: 'failed',
    safeToContinue: false,
    details: 'token=abc123',
  });
  assert(rec.originalAction.includes('[REDACTED]'), 'record originalAction sanitized');
  assert(rec.details!.includes('[REDACTED]'), 'record details sanitized');
  assert(rec.recoveryResult === 'failed' && rec.recoveryStrategy === 'RE_OBSERVE', 'record fields preserved');

  assert(!isRecoverable('permission denied'), 'permission errors are not recoverable');
  assert(!isRecoverable('invalid input given'), 'invalid input is not recoverable');
  assert(isRecoverable('timed out'), 'timeouts are recoverable');
  assert(isRecoverable('enoent no such file'), 'missing targets are recoverable');
}

// ---------------------------------------------------------------- strategy executor
{
  console.log('Strategy executor — verification');
  const registry = new ToolRegistry();
  let focusCalls = 0;
  registry.register(
    tool('application.focus', async () => {
      focusCalls++;
      return ok({ output: { focused: true } });
    })
  );
  registry.register(tool('screen.observe', async () => ok({ output: { summary: 'fresh screen' } })));
  registry.register(tool('browser.refresh', async () => ok({ output: { refreshed: true } })));

  const executor = new RecoveryStrategyExecutor();
  const baseCtx = {
    taskId: 't1',
    step: makeStep({ input: { app: 'notepad' } }),
    decision: { strategy: 'REFOCUS' as const, reason: '', failureType: 'FOCUS_LOST' as const, safeStop: false },
  };

  const refocus = await executor.execute({ ...baseCtx, registry });
  assert(refocus.success && refocus.verified, 'refocus succeeds with application.focus available');
  assertEqual(focusCalls, 1, 'refocus called focus tool once');

  const reobserve = await executor.execute({
    ...baseCtx,
    decision: { strategy: 'RE_OBSERVE' as const, reason: '', failureType: 'STALE_STATE' as const, safeStop: false },
    registry,
  });
  assert(reobserve.success && reobserve.verified, 're-observe succeeds with screen.observe available');

  const browserRecovery = await executor.execute({
    ...baseCtx,
    decision: { strategy: 'BROWSER_RECOVERY' as const, reason: '', failureType: 'NAVIGATION_CHANGED' as const, safeStop: false },
    registry,
  });
  assert(browserRecovery.success && browserRecovery.verified, 'browser recovery succeeds with browser.refresh available');

  const retry = await executor.execute({
    ...baseCtx,
    decision: { strategy: 'RETRY' as const, reason: '', failureType: 'TRANSIENT' as const, safeStop: false },
    registry,
  });
  assert(retry.success && retry.verified, 'retry prepares a controlled re-run');

  const noTool = await executor.execute({
    taskId: 't1',
    step: makeStep({ input: {} }),
    decision: { strategy: 'REFOCUS' as const, reason: '', failureType: 'FOCUS_LOST' as const, safeStop: false },
    registry,
  });
  assert(!noTool.success && !noTool.verified, 'refocus fails honestly without app name');

  // Abort signal respected
  const abortController = new AbortController();
  abortController.abort();
  const aborted = await executor.execute({
    ...baseCtx,
    registry,
    signal: abortController.signal,
  });
  assert(!aborted.success && !aborted.verified, 'aborted recovery does nothing');
}

// ---------------------------------------------------------------- recovery manager
{
  console.log('Recovery manager — state machine & history');
  const events = new AgentEventBus();
  const emitted: string[] = [];
  events.on('RECOVERY_SUCCEEDED', () => emitted.push('succeeded'));
  events.on('SAFE_STOP_TRIGGERED', () => emitted.push('safe_stop'));

  const manager = new RecoveryManager({ events, maxAttemptsPerStep: 2, maxRepeatedIdenticalFailures: 2 });
  assertEqual(manager.getState(), 'NORMAL', 'starts NORMAL');

  // Unrecoverable → SAFE_STOP
  const stop = await manager.handleFailure({
    taskId: 't1',
    step: makeStep(),
    error: 'Permission denied',
  });
  assertEqual(stop.state, 'FAILED' as const, 'safe stop → FAILED state');
  assert(stop.safeStop === true, 'safeStop flagged');
  assert(emitted.includes('safe_stop'), 'SAFE_STOP_TRIGGERED emitted');

  // Recoverable, no tools → RE_OBSERVE fallback verification succeeds
  const manager2 = new RecoveryManager({ events });
  const rec2 = await manager2.handleFailure({
    taskId: 't2',
    step: makeStep(),
    error: 'stale state',
  });
  assertEqual(rec2.state, 'RECOVERED' as const, 're-observe recovery without tools verifies');
  assertEqual(rec2.strategy, 'RE_OBSERVE', 'stale state → re-observe');
  assertEqual(manager2.getState(), 'RECOVERED' as const, 'state machine reached RECOVERED');
  assertEqual(emitted.filter((e) => e === 'succeeded').length, 1, 'RECOVERY_SUCCEEDED emitted');
  assertEqual(manager2.getHistory().length, 1, 'attempt recorded in history');

  // Budget enforcement through handleFailure
  const manager3 = new RecoveryManager({ events, maxAttemptsPerStep: 1 });
  const budgetStop = await manager3.handleFailure({
    taskId: 't3',
    step: makeStep({ id: 's1' }),
    error: 'timed out',
  });
  assert(budgetStop.safeStop, 'budget exhausted on first failure when maxAttemptsPerStep=1');
  assertEqual(manager3.getState(), 'FAILED' as const, 'budget stop → FAILED');

  // resetTask clears per-task tracking
  manager3.resetTask('t3');
  assertEqual(manager3.getState(), 'NORMAL' as const, 'resetTask returns to NORMAL');

  // Abort signal
  const controller = new AbortController();
  controller.abort();
  const manager4 = new RecoveryManager({ events });
  const abortedRun = await manager4.handleFailure({
    taskId: 't4',
    step: makeStep(),
    error: 'timed out',
    signal: controller.signal,
  });
  assertEqual(abortedRun.state, 'ABORTED' as const, 'aborted signal → ABORTED state');
}

// ---------------------------------------------------------------- core integration
{
  console.log('AgentCore — recovery: transient failure → RETRY re-runs the step');
  const registry = new ToolRegistry();
  let calls = 0;
  registry.register(
    tool('system.note', async () => {
      calls++;
      if (calls <= 2) return fail('temporary network error', { retryable: true });
      return ok({ output: { recovered: true } });
    })
  );
  const core = new AgentCore({
    registry,
    events: new AgentEventBus(),
    store: new TaskStore(new MemoryStorage()),
    retryDelayMs: 10,
    recovery: new RecoveryManager({ registry }),
  });
  const task = await core.submit('flaky');
  assertEqual(task.status, 'completed' as const, 'task completes after recovery retry');
  assertEqual(calls, 3, 'two failed attempts + recovery re-run');
}

{
  console.log('AgentCore — recovery: side-effecting failure → RE_OBSERVE then re-run');
  const registry = new ToolRegistry();
  let clicks = 0;
  let observed = false;
  registry.register(
    tool('computer.click', async () => {
      clicks++;
      if (clicks === 1) return fail('element moved, signature mismatch', { retryable: false });
      return ok({ output: { clicked: true } });
    })
  );
  registry.register(
    tool('screen.observe', async () => {
      observed = true;
      return ok({ output: { summary: 'fresh state' } });
    })
  );
  const core = new AgentCore({
    registry,
    events: new AgentEventBus(),
    store: new TaskStore(new MemoryStorage()),
    recovery: new RecoveryManager({ registry }),
    planner: staticPlanner([
      makeStep({ id: 'click1', toolName: 'computer.click', description: 'click the target', input: { target: 'button' }, status: 'pending', attempts: 0 }),
    ]),
  });
  const task = await core.submit('click the button');
  assertEqual(task.status, 'completed' as const, 'stale click recovered via re-observe + re-run');
  assertEqual(clicks, 2, 'click re-run exactly once after recovery');
  assert(observed, 'screen re-observed before re-run');
  assert(task.plan!.steps[0].verified === true, 're-run step verified');
}

{
  console.log('AgentCore — recovery: alternative step injected and executed');
  const registry = new ToolRegistry();
  const executed: string[] = [];
  registry.register(tool('system.note', async () => fail('hard failure', { retryable: false })));
  registry.register(
    tool('chat.report', async () => {
      executed.push('report');
      return ok({ output: { acknowledged: true } });
    })
  );

  const planner = {
    makePlan: (goal: AgentGoal): AgentPlan => ({
      goal,
      steps: [
        { id: 'a1', description: 'doomed', toolName: 'system.note', input: {}, status: 'pending' as const, attempts: 0 },
        { id: 'a2', description: 'report', toolName: 'chat.report', input: {}, status: 'pending' as const, attempts: 0 },
      ],
      createdAt: Date.now(),
      revision: 1,
    }),
    proposeAlternative: (step: PlanStep): PlanStep | null => {
      if (step.id !== 'a1') return null;
      return {
        id: 'a1-alt',
        description: 'alternative rescue step',
        toolName: 'chat.report',
        input: {},
        status: 'pending' as const,
        attempts: 0,
      };
    },
  };

  const core = new AgentCore({
    registry,
    events: new AgentEventBus(),
    store: new TaskStore(new MemoryStorage()),
    planner,
    recovery: new RecoveryManager({ registry }),
  });
  const task = await core.submit('always fails then report');
  assertEqual(task.status, 'completed' as const, 'alternative strategy rescues the task');
  assertEqual(executed, ['report', 'report'], 'original report + injected alternative both ran');
  assert(task.plan!.steps.some((s) => s.id === 'a1-alt'), 'alternative step present in plan');
  assert(task.plan!.steps[0].status !== 'completed', 'failed step not marked completed');
}

{
  console.log('AgentCore — recovery: invalid context ref stops safely');
  const registry = new ToolRegistry();
  registry.register(tool('chat.report', async () => ok()));
  const core = new AgentCore({
    registry,
    events: new AgentEventBus(),
    store: new TaskStore(new MemoryStorage()),
    planner: staticPlanner([
      makeStep({
        id: 'c1',
        toolName: 'chat.report',
        description: 'consume missing context',
        input: { path: { $context: 'missing.key.path' } } as Record<string, unknown>,
        status: 'pending',
        attempts: 0,
      }),
    ]),
    recovery: new RecoveryManager({ registry }),
  });
  const task = await core.submit('broken context task');
  assertEqual(task.status, 'failed' as const, 'invalid context reference fails the task safely');
  assert(
    (task.error || '').includes('context value is missing') || (task.error || '').includes('Context reference invalid'),
    'context failure surfaced honestly'
  );
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
