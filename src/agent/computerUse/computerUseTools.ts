/**
 * Computer-use tool (Phase 7) — exposes the orchestrator through the Phase 3
 * Tool Registry. One Agent Core step runs the full observe/act/verify loop
 * with all three permission domains required up-front.
 */
import type { AgentTool, ToolErrorKind, ToolResult } from '../types';
import { ok, fail } from '../types';
import type { ComputerUseAgent } from './computerUseAgent';
import type { ComputerUseResult } from './computerUseTypes';

const STATUS_TO_ERROR: Partial<Record<ComputerUseResult['status'], { errorKind: ToolErrorKind; message: string }>> = {
  failed: { errorKind: 'execution_error', message: 'Computer task failed' },
  cancelled: { errorKind: 'cancelled', message: 'Computer task cancelled' },
};

export function createComputerUseTools(agent: ComputerUseAgent): AgentTool[] {
  return [
    {
      name: 'computer.use',
      description:
        'Run a multi-action computer task end-to-end: observe the screen, resolve visible targets, execute mouse/keyboard actions, verify each result, and recover safely. Requires the full goal text.',
      category: 'computer',
      riskLevel: 'medium',
      cost: 'moderate',
      reliability: 0.6,
      capabilities: ['computer.use', 'computer.autonomous'],
      permissions: ['screen.observation', 'mouse.control', 'keyboard.control'],
      inputSchema: {
        optional: ['goal', 'maxActions'],
        types: { goal: 'string', maxActions: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: {
        strategy: 'state_check',
        description:
          'Every action is verified through Phase 4 screen-change evidence; the task only reports completion when all actions executed, with honest per-action verification notes.',
      },
      timeoutMs: 180_000,
      retryPolicy: { maxAttempts: 1 }, // the loop has its own bounded recovery; core-level retry would replay the whole task
      async execute(input, ctx): Promise<ToolResult> {
        const goal = String(input.goal ?? ctx.userRequest ?? '').trim();
        if (!goal) {
          return fail('computer.use requires a goal (input.goal or the original user request)', {
            errorKind: 'invalid_input',
            retryable: false,
          });
        }
        try {
          const result = await agent.run(goal, ctx.signal);
          const statusError = STATUS_TO_ERROR[result.status];
          if (statusError && result.status === 'cancelled') {
            return fail(result.summary, { errorKind: 'cancelled', retryable: false, output: result });
          }
          if (statusError) {
            return fail(result.summary, { errorKind: 'execution_error', retryable: false, output: result });
          }
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return fail(`Computer task failed: ${String((err as any)?.message || err)}`, {
            errorKind: 'execution_error',
            retryable: false,
          });
        }
      },
    },
  ];
}
