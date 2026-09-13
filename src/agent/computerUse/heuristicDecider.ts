/**
 * Heuristic action decider (Phase 7).
 *
 * Turns a natural-language computer-use goal into an ordered list of action
 * intents by reusing the existing planner classification (the planner remains
 * the single source of intent parsing — no duplicated detectors). An
 * LLM-assisted decider can implement the same interface later (Phase 8+)
 * without touching the loop.
 */
import { splitIntoClauses, classifyStep } from '../planner';
import type { ComputerActionIntent, ComputerActionKind } from './computerUseTypes';

const TOOL_TO_KIND: Record<string, ComputerActionKind> = {
  'computer.click': 'click',
  'computer.double_click': 'double_click',
  'computer.right_click': 'right_click',
  'computer.move_cursor': 'move_cursor',
  'computer.scroll': 'scroll',
  'computer.drag': 'drag',
  'keyboard.type': 'type',
  'keyboard.press_key': 'press_key',
  'keyboard.hotkey': 'hotkey',
  'keyboard.key_down': 'key_down',
  'keyboard.key_up': 'key_up',
  'keyboard.copy': 'copy',
  'keyboard.paste': 'paste',
  'keyboard.select_all': 'select_all',
};

/** True when a clause classifies into a computer-use action. */
export function isComputerActionClause(clause: string): boolean {
  const cls = classifyStep(clause);
  return Boolean(cls && cls.capability && TOOL_TO_KIND[cls.capability]);
}

/** True when the goal is a compound desktop task (≥2 computer-action clauses and nothing non-computer). */
export function isComputerUseRequest(text: string): boolean {
  const clauses = splitIntoClauses(text);
  if (clauses.length < 2) return false;
  let computer = 0;
  for (const clause of clauses) {
    const cls = classifyStep(clause);
    if (!cls) continue;
    if (cls.capability && TOOL_TO_KIND[cls.capability]) {
      computer++;
    } else if (cls.toolName !== 'chat.report') {
      return false; // mixes non-computer work → keep the static plan path
    }
  }
  return computer >= 2;
}

/** Build the ordered action intents for a goal. */
export function buildIntents(goal: string): ComputerActionIntent[] {
  const clauses = splitIntoClauses(goal);
  const intents: ComputerActionIntent[] = [];

  for (const clause of clauses) {
    const cls = classifyStep(clause);
    if (!cls || !cls.capability) continue;
    const kind = TOOL_TO_KIND[cls.capability];
    if (!kind) continue;
    const input = cls.input as Record<string, unknown>;
    intents.push({ kind, description: cls.description, params: normalizeParams(kind, input) });
  }
  return intents;
}

function normalizeParams(kind: ComputerActionKind, input: Record<string, unknown>): Record<string, unknown> {
  switch (kind) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move_cursor':
      return { target: input.target, coordinates: input.coordinates };
    case 'type':
      return { text: input.text };
    case 'press_key':
      return { key: input.key };
    case 'hotkey':
      return { modifiers: input.modifiers ?? [], key: input.key };
    case 'scroll':
      return { direction: input.direction, amount: input.amount };
    case 'drag':
      return { from: input.from, to: input.to };
    case 'key_down':
    case 'key_up':
      return { key: input.key };
    case 'copy':
    case 'paste':
    case 'select_all':
    case 'wait':
      return {};
    default:
      return input;
  }
}
