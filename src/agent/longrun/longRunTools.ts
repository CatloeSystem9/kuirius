/**
 * Long-run tools (Phase 19) — operator/task control + bounded waiting through
 * the Phase 3 contract. All are control-plane (SAFE): pause/resume/status
 * execute no side effects themselves, and every RESUMED action still passes
 * the Phase 18 gate. The wait tool re-executes a REGISTERED tool on an
 * adaptive bounded schedule — each poll passes the safety gate, polls are
 * capped, and timeouts BLOCK rather than loop forever.
 */
import type { AgentTool } from '../types';
import type { LongRunManager } from './longRunManager';

export interface LongRunToolsDeps {
  manager: LongRunManager;
  /** Polls execute through the SAME registry (gate-checked) — provided by the bridge. */
  pollExecutor: (toolName: string, input: Record<string, unknown>, ctx: any) => Promise<any>;
}

export function createLongRunTools(deps: LongRunToolsDeps): AgentTool[] {
  const { manager, pollExecutor } = deps;
  return [
    {
      name: 'longrun.status',
      description: 'Read long-running task sessions: lifecycle state, progress, budgets, last action outcome, pause/block/failure reasons. Read-only.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.99,
      capabilities: ['longrun.status'],
      permissions: [],
      inputSchema: { optional: ['taskId'], types: { taskId: 'string' } },
      verification: { strategy: 'self_reported', description: 'Direct read of live session diagnostics.' },
      timeoutMs: 2_000,
      async execute(input): Promise<any> {
        const sessions = manager.listSessions();
        const filtered = input.taskId ? sessions.filter((s) => s.taskId === String(input.taskId)) : sessions;
        return {
          success: true,
          output: {
            summary: `${filtered.length} session(s); ${filtered.map((s) => `${s.state} (${s.taskId.slice(-6)})`).join(', ') || 'none active'}.`,
            sessions: filtered,
            checkpointsStored: manager.checkpointCount(),
          },
        };
      },
    },
    {
      name: 'longrun.pause',
      description: 'Pause a long-running task: the in-flight step is cancelled safely, state is checkpointed, and the session becomes resumable. Paused tasks never auto-resume.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.95,
      capabilities: ['longrun.pause'],
      permissions: [],
      inputSchema: { optional: ['taskId', 'reason'], types: { taskId: 'string', reason: 'string' } },
      verification: { strategy: 'self_reported', description: 'The PAUSED lifecycle state is the verifiable effect; audited.' },
      timeoutMs: 5_000,
      async execute(input, ctx): Promise<any> {
        const taskId = String(input.taskId ?? ctx.taskId ?? '');
        const result = manager.pause(taskId, String(input.reason ?? 'user pause'));
        return result.paused
          ? { success: true, output: { summary: `Task ${taskId.slice(-6)} paused — state checkpointed, resumable after validation.` } }
          : { success: false, error: result.reason ?? 'pause refused', errorKind: 'invalid_input', retryable: false };
      },
    },
    {
      name: 'longrun.resume',
      description: 'Resume a paused long-running task after validation: checkpoint integrity, lifecycle, duplicate-action safety, budgets and emergency-stop state are re-checked before continuing.',
      category: 'system',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.9,
      capabilities: ['longrun.resume'],
      permissions: [],
      inputSchema: { optional: ['taskId'], types: { taskId: 'string' } },
      verification: { strategy: 'self_reported', description: 'Resume only proceeds when validation passes; refusals carry structured reasons.' },
      timeoutMs: 5_000,
      async execute(input): Promise<any> {
        const taskId = String(input.taskId ?? '');
        if (!taskId) return { success: false, error: 'longrun.resume requires a taskId', errorKind: 'invalid_input', retryable: false };
        const result = await manager.resume(taskId);
        return result.resumed
          ? { success: true, output: { summary: `Task ${taskId.slice(-6)} resumed after full validation.` } }
          : { success: false, error: result.reason ?? 'resume refused', errorKind: 'invalid_input', retryable: false };
      },
    },
    {
      name: 'longrun.wait',
      description: 'Bounded adaptive wait until a registered tool\'s result satisfies an expectation (polls with doubling intervals, hard timeout, every poll passes the safety gate). Times out into BLOCKED — never loops forever.',
      category: 'system',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.85,
      capabilities: ['longrun.wait'],
      permissions: [],
      inputSchema: {
        required: ['toolName', 'timeoutMs'],
        optional: ['input', 'expectText', 'pollMs', 'maxPollMs'],
        types: { toolName: 'string', input: 'object', expectText: 'string', timeoutMs: 'number', pollMs: 'number', maxPollMs: 'number' },
      },
      verification: { strategy: 'self_reported', description: 'Waits only on real tool results; every poll is safety-gated; timeout is bounded.' },
      timeoutMs: 130_000,
      async execute(input, ctx): Promise<any> {
        const toolName = String(input.toolName ?? '');
        const timeoutMs = Math.max(250, Math.min(Number(input.timeoutMs ?? 30_000), 120_000));
        const pollMs = Math.max(100, Number(input.pollMs ?? 500));
        const maxPollMs = Math.max(pollMs, Number(input.maxPollMs ?? 8_000));
        const expectText = input.expectText ? String(input.expectText).toLowerCase() : undefined;
        const toolInput = (input.input ?? {}) as Record<string, unknown>;

        const result = await manager.wait(ctx.taskId, {
          description: `until ${toolName} ${expectText ? `contains "${expectText.slice(0, 40)}"` : 'succeeds'}`,
          timeoutMs,
          pollMs,
          maxPollMs,
          check: async () => {
            const execution = await pollExecutor(toolName, toolInput, ctx);
            if (!execution.success) return false;
            if (!expectText) return true;
            return JSON.stringify(execution.output ?? '').toLowerCase().includes(expectText);
          },
        });
        if ('blocked' in result) {
          return { success: false, error: result.reason, errorKind: 'invalid_input', retryable: false };
        }
        if (result.status === 'satisfied') {
          return { success: true, output: { summary: `Wait satisfied after ${result.polls} poll(s) (${result.elapsedMs}ms).`, ...result } };
        }
        return {
          success: false,
          error: `Wait timed out after ${result.elapsedMs}ms (${result.polls} polls) — session BLOCKED until conditions change`,
          errorKind: 'timeout',
          retryable: false,
          output: result,
        };
      },
    },
  ];
}
