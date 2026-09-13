/**
 * Keyboard tools (Phase 6) — Phase 3 Tool contract.
 *
 * All tools are permission-gated ('keyboard.control', default-deny), validate
 * input client-side, and verify meaningful actions through Phase 4 screen
 * observation. `computer.type` allows exactly ONE attempt (duplicate-typing
 * protection, spec §15); sensitive text is masked in every result.
 */
import type { AgentTool, ToolErrorKind, ToolResult } from '../types';
import { ok, fail } from '../types';
import type { ControlError } from './mouseTypes';
import type { KeyboardControlService } from './keyboardControl';

const ERROR_KIND_MAP: Record<string, { errorKind: ToolErrorKind; retryable: boolean }> = {
  permission_denied: { errorKind: 'permission_denied', retryable: false },
  invalid_coordinates: { errorKind: 'invalid_input', retryable: false },
  target_not_found: { errorKind: 'not_found', retryable: true },
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
  return fail(`Keyboard action failed: ${String((err as any)?.message || err)}`, { errorKind: 'execution_error', retryable: true });
}

const KEYBOARD_VERIFICATION = {
  strategy: 'state_check' as const,
  description:
    'Meaningful actions are verified through Phase 4 block-signature diffs (and expected-text matching when a text-capable provider is active); a key action with no visible change reports verified:false honestly.',
};

const TYPE_SCHEMA = {
  optional: ['text', 'verify', 'settleMs', 'expectText'],
  types: { text: 'string', verify: 'boolean', settleMs: 'number', expectText: 'string' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
};

const KEY_SCHEMA = {
  optional: ['key', 'verify', 'settleMs'],
  types: { key: 'string', verify: 'boolean', settleMs: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
};

const HOTKEY_SCHEMA = {
  optional: ['modifiers', 'key', 'verify', 'settleMs'],
  types: { modifiers: 'array', key: 'string', verify: 'boolean', settleMs: 'number' } as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
};

export function createKeyboardTools(service: KeyboardControlService): AgentTool[] {
  return [
    {
      name: 'computer.type',
      description: 'Type text into the focused application (Unicode-safe). One attempt only: uncertain delivery is reported, never blind-retried.',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.85,
      capabilities: ['keyboard.type'],
      permissions: ['keyboard.control'],
      inputSchema: TYPE_SCHEMA,
      verification: KEYBOARD_VERIFICATION,
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.type(
            String(input.text ?? ''),
            {
              verify: input.verify as boolean | undefined,
              settleMs: input.settleMs as number | undefined,
              expectText: input.expectText as string | undefined,
            },
            ctx.signal
          );
          if (result.deliveryUncertain) {
            // Duplicate-typing protection (spec §15): report uncertainty as a
            // non-retryable failure instead of pretending success.
            return fail(result.summary, { errorKind: 'execution_error', retryable: false, output: result });
          }
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.press_key',
      description: 'Press a single key (enter, escape, tab, backspace, delete, arrows, home, end, page up/down, space, letters, digits, F1-F12).',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['keyboard.press_key'],
      permissions: ['keyboard.control'],
      inputSchema: KEY_SCHEMA,
      verification: KEYBOARD_VERIFICATION,
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 2 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.pressKey(
            String(input.key ?? ''),
            { verify: input.verify as boolean | undefined, settleMs: input.settleMs as number | undefined },
            ctx.signal
          );
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.hotkey',
      description: 'Press a modifier combination (Ctrl/Alt/Shift/Win + key, e.g. Ctrl+S, Alt+Tab). Modifiers are always released, even on failure.',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.85,
      capabilities: ['keyboard.hotkey'],
      permissions: ['keyboard.control'],
      inputSchema: HOTKEY_SCHEMA,
      verification: KEYBOARD_VERIFICATION,
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.hotkey(
            Array.isArray(input.modifiers) ? (input.modifiers as string[]) : [],
            String(input.key ?? ''),
            { verify: input.verify as boolean | undefined, settleMs: input.settleMs as number | undefined },
            ctx.signal
          );
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.key_down',
      description: 'Hold a key down (explicit state; automatically released on failure/cancellation to prevent stuck keys).',
      category: 'computer',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['keyboard.key_down'],
      permissions: ['keyboard.control'],
      inputSchema: { optional: ['key'], types: { key: 'string' } },
      verification: { strategy: 'self_reported', description: 'Key state is tracked client-side and reported.' },
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.keyDown(String(input.key ?? ''), ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.key_up',
      description: 'Release a held key.',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['keyboard.key_up'],
      permissions: ['keyboard.control'],
      inputSchema: { optional: ['key'], types: { key: 'string' } },
      verification: { strategy: 'self_reported', description: 'Key state is tracked client-side and reported.' },
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(input, ctx): Promise<ToolResult> {
        try {
          const result = await service.keyUp(String(input.key ?? ''), ctx.signal);
          return ok({ output: { summary: result.summary, ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.copy',
      description: 'Copy the current selection to the clipboard (Ctrl+C).',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['keyboard.copy'],
      permissions: ['keyboard.control'],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Clipboard contents are never read, logged, or stored.' },
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 2 },
      async execute(_input, ctx): Promise<ToolResult> {
        try {
          const result = await service.copy(ctx.signal);
          return ok({ output: { summary: 'Copy shortcut (Ctrl+C) dispatched to the focused application.', ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.paste',
      description: 'Paste the clipboard into the focused application (Ctrl+V).',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['keyboard.paste'],
      permissions: ['keyboard.control'],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Clipboard contents are never read, logged, or stored.' },
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 1 },
      async execute(_input, ctx): Promise<ToolResult> {
        try {
          const result = await service.paste(ctx.signal);
          return ok({ output: { summary: 'Paste shortcut (Ctrl+V) dispatched to the focused application.', ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
    {
      name: 'computer.select_all',
      description: 'Select all content in the focused application (Ctrl+A).',
      category: 'computer',
      riskLevel: 'low',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['keyboard.select_all'],
      permissions: ['keyboard.control'],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Selection highlight is verifiable via screen observation.' },
      timeoutMs: 35_000,
      retryPolicy: { maxAttempts: 2 },
      async execute(_input, ctx): Promise<ToolResult> {
        try {
          const result = await service.selectAll(ctx.signal);
          return ok({ output: { summary: 'Select-all shortcut (Ctrl+A) dispatched to the focused application.', ...result } });
        } catch (err) {
          return mapControlError(err);
        }
      },
    },
  ];
}
