/**
 * Deterministic risk classification (Phase 18, spec §10) — NO model calls.
 *
 * Base class comes from the tool's own Phase 3 declaration (the registry is
 * the authoritative source of tool knowledge), then input-driven factors
 * escalate: destructive verbs, force/overwrite flags, bulk targets, external
 * side effects. The same action always classifies identically.
 */
import type { SafetyClass } from './safetyTypes';

export interface RiskAssessment {
  klass: SafetyClass;
  factors: string[];
}

/** Tools whose whole purpose is destructive/irreversible — never downgraded. */
const DESTRUCTIVE_TOOLS = new Set([
  'filesystem.delete',
  'application.close',
]);

/** Input keys that signal an escalated risk. */
const FORCE_KEYS = new Set(['force', 'overwrite', 'recursive']);
const BULK_KEYS = new Set(['paths', 'files', 'targets', 'pids']);

/** Tools with EXTERNAL side effects (beyond the local machine). */
const EXTERNAL_TOOLS = new Set(['web.search_website', 'web.open_website', 'chat.report']);

/** Read-only tools — SAFE regardless of declared medium (none declared so).
 *  Includes the safety/routing CONTROL PLANE: stopping, resuming, reading
 *  status/audit has no external side effect and must stay operable during an
 *  emergency stop (spec §9). */
const READ_ONLY_TOOLS = new Set([
  'filesystem.list', 'filesystem.search', 'filesystem.inspect', 'filesystem.read',
  'application.find', 'application.status', 'application.focus',
  'screen.observe', 'screen.detect_changes', 'screen.compare',
  'browser.get_state', 'browser.find', 'browser.wait',
  'model.route', 'perf.classify', 'perf.metrics',
  'safety.status', 'safety.audit', 'safety.emergency_stop',
  'diagnostics.health', 'diagnostics.inspect',
  'system.note', 'chat.report',
  'memory.recall',
]);

function baseClassFor(declared: string | undefined, toolName: string): { klass: SafetyClass; factor?: string } {
  switch (declared) {
    case 'safe':
      return { klass: 'safe', factor: 'declared safe' };
    case 'low':
      return READ_ONLY_TOOLS.has(toolName)
        ? { klass: 'safe', factor: 'read-only tool' }
        : { klass: 'confirm', factor: 'side-effecting (declared low)' };
    case 'medium':
      return { klass: 'confirm', factor: 'declared medium risk' };
    case 'high':
    case 'critical':
      return { klass: 'high_risk', factor: `declared ${declared} risk` };
    default:
      // Unknown declaration — fail closed (spec §19).
      return { klass: 'high_risk', factor: 'unknown risk declaration — fail closed' };
  }
}

/**
 * Classify one action. Pure and deterministic: identical (tool, input, risk)
 * triples always classify identically. Escalations only ever go UP.
 */
export function classifyRisk(toolName: string, declaredRisk: string | undefined, input: Record<string, unknown> | undefined): RiskAssessment {
  const factors: string[] = [];
  let klass = baseClassFor(declaredRisk, toolName);
  if (klass.factor) factors.push(klass.factor);
  let current: SafetyClass = klass.klass;

  const order: SafetyClass[] = ['safe', 'confirm', 'high_risk', 'deny'];
  const escalateTo = (target: SafetyClass, factor: string): void => {
    factors.push(factor);
    if (order.indexOf(target) > order.indexOf(current)) current = target;
  };

  if (DESTRUCTIVE_TOOLS.has(toolName)) {
    escalateTo('high_risk', 'destructive/irreversible tool');
  }
  if (EXTERNAL_TOOLS.has(toolName)) {
    escalateTo('confirm', 'external side effect');
  }

  const inputRecord = (input ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(inputRecord)) {
    if (FORCE_KEYS.has(key) && inputRecord[key] === true) {
      escalateTo('high_risk', `force flag "${key}"`);
    }
  }

  const stringInput = JSON.stringify(inputRecord).toLowerCase();
  if (/recursive|bulk|\\windows\\|\\program files|c:\\users[^"']*\\(appdata\\roaming\\microsoft|ntuser)/.test(stringInput)) {
    escalateTo('high_risk', 'sensitive/bulk path pattern in input');
  }
  for (const key of BULK_KEYS) {
    const value = inputRecord[key];
    if (Array.isArray(value) && value.length > 5) {
      escalateTo('high_risk', `bulk operation (${value.length} targets)`);
    }
  }

  return { klass: current, factors };
}
