/**
 * Browser action decider (Phase 8) — turns natural-language browser goals
 * into ordered browser action intents, reusing the existing planner parsing
 * (classifyStep + classifyBrowserPhrase live in the planner; no duplicated
 * detectors). An LLM-assisted decider can replace this later without
 * touching the browser action loop.
 */
import { splitIntoClauses, classifyStep, BROWSER_USE_CAPABILITIES, classifyBrowserPhrase, isBrowserUseRequest } from '../planner';
import type { BrowserActionIntent, BrowserActionKind } from './browserTypes';

const CAPABILITY_TO_KIND: Record<string, BrowserActionKind> = {
  'browser.open_url': 'navigate',
  'browser.search': 'navigate',
  'browser.find': 'find',
  'browser.click': 'click',
  'browser.type': 'type',
  'browser.scroll': 'scroll',
  'browser.scroll_until': 'scroll_until',
  'browser.wait': 'wait',
  'browser.verify': 'wait',
  'browser.back': 'back',
  'browser.refresh': 'refresh',
};

/** True when a clause classifies into a browser action (incl. Phase 1 web tools). */
export function isBrowserActionClause(clause: string): boolean {
  const cls = classifyStep(clause);
  return Boolean(cls && cls.capability && BROWSER_USE_CAPABILITIES.has(cls.capability));
}

export { isBrowserUseRequest };

/** Build ordered browser action intents from a goal. */
export function buildBrowserIntents(goal: string): BrowserActionIntent[] {
  const clauses = splitIntoClauses(goal);
  const intents: BrowserActionIntent[] = [];

  for (const clause of clauses) {
    const cls = classifyStep(clause);
    if (!cls || !cls.capability) continue;
    const kind = CAPABILITY_TO_KIND[cls.capability];
    if (!kind) continue;
    const input = (cls.input ?? {}) as Record<string, unknown>;
    intents.push({ kind, description: cls.description, params: normalizeParams(kind, input) });
  }
  return intents;
}

function normalizeParams(kind: BrowserActionKind, input: Record<string, unknown>): Record<string, unknown> {
  switch (kind) {
    case 'navigate': {
      const action = input.action as { url?: string } | undefined;
      return { url: action?.url ?? input.url ?? input.query ?? '' };
    }
    case 'find':
    case 'scroll_until':
      return { query: input.query };
    case 'click':
      return { target: input.target, kind: 'any' };
    case 'type':
      return { text: input.text, field: input.field };
    case 'scroll':
      return { direction: input.direction, amount: input.amount };
    case 'wait':
      return { textContains: input.textContains, urlContains: input.urlContains, titleContains: input.titleContains };
    case 'press_key':
      return { key: input.key };
    case 'back':
    case 'forward':
    case 'refresh':
      return {};
    default:
      return input;
  }
}

// Keep the phrase classifier reachable from this module's import surface.
export { classifyBrowserPhrase };
