/**
 * Task-context helpers (Phase 10 — Multi-Step Autonomy).
 *
 * The task context is a small structured scratchpad that persists with the
 * task: steps store their outputs under named keys (outputKey), and later
 * steps reference those values via `{$context: 'a.b.c'}` placeholders in
 * their inputs. Conditions let the executor make task-state-driven decisions
 * (skip satisfied steps, run conditional steps) instead of blindly advancing
 * an array index.
 *
 * Bounded by design: context values larger than 4KB are truncated to a
 * preview so raw file contents / screenshots never pile up in task state.
 */

const MAX_CONTEXT_VALUE_CHARS = 4000;
const MAX_PREVIEW_CHARS = 1000;

/** Resolve a dotted path ('a.b.0.c') against the task context. */
export function resolveContextPath(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export type StepCondition = {
  kind: 'context_exists';
  key: string;
} | {
  kind: 'context_missing';
  key: string;
} | {
  kind: 'context_equals';
  key: string;
  value: unknown;
} | {
  kind: 'context_contains';
  key: string;
  value: string;
};

/** Evaluate a step's run condition against the task context. */
export function evaluateCondition(
  condition: StepCondition | undefined,
  context: Record<string, unknown>
): { run: boolean; reason: string } {
  if (!condition) return { run: true, reason: 'unconditional' };
  const value = resolveContextPath(context, condition.key);
  switch (condition.kind) {
    case 'context_exists':
      return { run: value !== undefined, reason: value !== undefined ? `context has "${condition.key}"` : `context lacks "${condition.key}"` };
    case 'context_missing':
      return { run: value === undefined, reason: value === undefined ? `context lacks "${condition.key}" (already satisfied)` : `context already has "${condition.key}"` };
    case 'context_equals':
      return { run: JSON.stringify(value) === JSON.stringify(condition.value), reason: `context["${condition.key}"] ${JSON.stringify(value) === JSON.stringify(condition.value) ? 'equals' : 'does not equal'} the expected value` };
    case 'context_contains': {
      const haystack = typeof value === 'string' ? value : JSON.stringify(value ?? '');
      const found = haystack.toLowerCase().includes(condition.value.toLowerCase());
      return { run: found, reason: found ? `context["${condition.key}"] contains "${condition.value}"` : `context["${condition.key}"] does not contain "${condition.value}"` };
    }
    default:
      return { run: true, reason: 'unknown condition kind — running' };
  }
}

/** Deeply replace `{$context: 'a.b.c'}` placeholders with context values. */
export function resolveContextRefs<T>(input: T, context: Record<string, unknown>): T {
  if (Array.isArray(input)) {
    return input.map((item) => resolveContextRefs(item, context)) as unknown as T;
  }
  if (input !== null && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.$context === 'string') {
      return resolveContextPath(context, obj.$context) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = resolveContextRefs(value, context);
    }
    return out as unknown as T;
  }
  return input;
}

/** Bound a value before storing it into the task context (no content dumps). */
export function boundContextValue(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (serialized === undefined) return undefined;
  if (serialized.length <= MAX_CONTEXT_VALUE_CHARS) return value;
  return { truncated: true, preview: serialized.slice(0, MAX_PREVIEW_CHARS) };
}
