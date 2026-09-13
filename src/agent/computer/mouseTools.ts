/**
 * Mouse/cursor tools (Phase 5) — Phase 3 Tool contract.
 *
 * All tools are permission-gated ('mouse.control', default-deny), accept
 * semantic targets (preferred) or raw coordinates, and verify meaningful
 * actions through Phase 4 screen observation. The service is injected so
 * tests run against the fake backend; this module is Node-safe.
 */
import type { AgentTool, ToolErrorKind, ToolResult } from '../types';
import { ok, fail } from '../types';
import type { ControlError } from './mouseTypes';
import type { ComputerControlService } from './computerControl';

const ERROR_KIND_MAP: Record<string, { errorKind: ToolErrorKind; retryable: boolean }> = {
  permission_denied: { errorKind: 'permission_denied', retryable: false },
  invalid_coordinates: { errorKind: 'invalid_input', retryable: false },
  target_unreliable: { errorKind: 'invalid_input', retryable: false },
  target_not_found: { errorKind: 'not_found', retryable: true },
  unsupported_capture_region: { errorKind: 'execution_error', retryable: false },
  backend_failed: { errorKind: 'execution_error', retryable: true },
  backend_unavailable: { errorKind: 'execution_error', retryable: false },
  timeout: { errorKind: 'timeout', retryable: true },
  cancelled: { errorKind: 'cancelled', retryable: false },
};

function mapControlError(err: unknown): ToolResult {
  if (err instanceof Error && (err as ControlError).kind) {
    const controlErr = err as ControlError;
    const mapped = ERROR_KIND_MAP[controlErr.kind] ?? { errorKind: 'execution_error' as ToolErrorKind, retryable: true };
    return fail(controlErr.message, { errorKind: mapped.errorKind, retryable: mapped.retryable });
  }
  return fail(`Mouse action failed: ${String((err as any)?.message || err)}`, { errorKind: 'execution_error', retryable: true });
}

const SCREEN_VERIFICATION = {
  strategy: 'state_check' as const,
  description:
    'After meaningful actions the service compares Phase 4 block signatures before/after the action; a click with no visible change reports verified:false honestly instead of assuming success.',
};

/** Shared input schema for click-family tools. */
const clickSchema = {
  optional: ['target', 'coordinates', 'stateId', 'verify', 'settleMs'],
  types: { target: 'object', coordinates: 'object', stateId: 'string', verify: 'boolean', settleMs: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
};

export function createMouseTools(service: ComputerControlService): AgentTool[] {
  return [
    {
      name: 'computer.get_cursor',
      description: 'Read the current cursor position and screen bounds (no interaction).',
      category: 'computer',
      riskLevel: 'safe',
      cost: 'free',
      reliability: 0.95,
      capabilities: ['computer.cursor_position'],
      permissions: ['mouse.control'],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Position is read directly from the OS backend.' },
      timeoutMs: 8000,
      async execute(_input, ctx): Promise<ToolResult> {
        try {
          const { position, screenBounds } = await service.getCursorPosition(ctx.signal);
          return ok({
            output: {
              summary: `Cursor is at (${position.x}, ${position.y}) on a ${screenBounds.width}x${screenBounds.height} screen.`,
              position,
              screenBounds,
            },
          });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.move_cursor',
      description: 'Move the cursor to a semantic target or coordinates (deliberate single movement, no clicking).',
      category: 'computer',
      riskLevel: 'low',
      cost: 'free',
      reliability: 0.9,
      capabilities: ['computer.move_cursor'],
      permissions: ['mouse.control'],
      inputSchema: clickSchema,
      verification: { strategy: 'self_reported', description: 'Verified by the OS-reported final cursor position.' },
      timeoutMs: 30_000,
      retryPolicy: { maxAttempts: 2 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.moveTo(input, ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.click',
      description: 'Left-click a visible target found through screen vision (semantic targeting preferred) or raw coordinates; verifies through screen change detection.',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.7,
      capabilities: ['computer.click', 'computer.left_click'],
      permissions: ['mouse.control'],
      inputSchema: clickSchema,
      verification: SCREEN_VERIFICATION,
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 1 }, // failed clicks are reassessed, never blindly retried
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.click('left', input, ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.double_click',
      description: 'Double-click a visible target or coordinates; verifies through screen change detection.',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.7,
      capabilities: ['computer.double_click'],
      permissions: ['mouse.control'],
      inputSchema: clickSchema,
      verification: SCREEN_VERIFICATION,
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.click('double', input, ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.right_click',
      description: 'Right-click a visible target or coordinates (e.g. to open a context menu); verifies through screen change detection.',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.7,
      capabilities: ['computer.right_click'],
      permissions: ['mouse.control'],
      inputSchema: clickSchema,
      verification: SCREEN_VERIFICATION,
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.click('right', input, ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.scroll',
      description: 'Scroll up or down at the current/target position; verifies through screen change detection.',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.8,
      capabilities: ['computer.scroll'],
      permissions: ['mouse.control'],
      inputSchema: {
        optional: ['direction', 'amount', 'deltaY', 'coordinates', 'verify', 'settleMs'],
        types: { direction: 'string', amount: 'number', deltaY: 'number', coordinates: 'object', verify: 'boolean', settleMs: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
        validators: { direction: (v) => v === 'up' || v === 'down' },
      },
      verification: SCREEN_VERIFICATION,
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 2 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.scroll(input, ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.drag',
      description: 'Drag from one visible target/point to another (medium risk); verifies through screen change detection.',
      category: 'computer',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.65,
      capabilities: ['computer.drag'],
      permissions: ['mouse.control'],
      inputSchema: {
        optional: ['from', 'to', 'verify', 'settleMs'],
        types: { from: 'object', to: 'object', verify: 'boolean', settleMs: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
      },
      verification: SCREEN_VERIFICATION,
      timeoutMs: 40_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.drag(input, ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
  ];
}
