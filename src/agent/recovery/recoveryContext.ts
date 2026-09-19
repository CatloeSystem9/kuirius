/**
 * Recovery Context Safety (Phase 11 — Error Recovery).
 *
 * Prevents failed or uncertain step outputs from silently corrupting
 * downstream steps in the Phase 10 runtime context scratchpad.
 */
import type { PlanStep } from '../types';
import type { ContextValidity } from './recoveryTypes';

export interface ContextMetaStore {
  validity: Record<string, ContextValidity>;
}

export class RecoveryContextManager {
  private meta: Record<string, ContextValidity> = {};

  /** Mark a context key as valid upon verified step completion. */
  markValid(key: string): void {
    this.meta[key] = 'VALID';
  }

  /** Mark a context key as invalid upon step failure. */
  markInvalid(key: string): void {
    this.meta[key] = 'INVALID';
  }

  /** Mark a context key as unknown (e.g. uncertain step result). */
  markUnknown(key: string): void {
    this.meta[key] = 'UNKNOWN';
  }

  /** Get validity of a context key. Defaults to UNKNOWN if not explicitly tracked. */
  getValidity(key: string): ContextValidity {
    return this.meta[key] ?? 'UNKNOWN';
  }

  /** Invalidate and remove a failed step's output from the task context. */
  invalidateOutput(
    context: Record<string, unknown>,
    outputKey?: string
  ): Record<string, unknown> {
    if (!outputKey) return { ...context };
    const updated = { ...context };
    delete updated[outputKey];
    this.markInvalid(outputKey);
    return updated;
  }

  /**
   * Check whether all context references required by a step are valid.
   * Returns false if any referenced key is INVALID or missing.
   */
  validateStepInputs(
    step: PlanStep,
    context: Record<string, unknown>
  ): { safe: boolean; invalidKeys: string[]; missingKeys: string[] } {
    const refs = this.extractContextRefs(step.input);
    const invalidKeys: string[] = [];
    const missingKeys: string[] = [];

    for (const ref of refs) {
      const rootKey = ref.split('.')[0];
      const validity = this.getValidity(rootKey);
      if (validity === 'INVALID') {
        invalidKeys.push(ref);
      } else if (this.resolvePath(context, ref) === undefined) {
        missingKeys.push(ref);
      }
    }

    return {
      safe: invalidKeys.length === 0 && missingKeys.length === 0,
      invalidKeys,
      missingKeys,
    };
  }

  /** Extract all `{$context: 'path'}` values from an arbitrary input object. */
  extractContextRefs(input: unknown): string[] {
    const refs: string[] = [];
    const scan = (val: unknown) => {
      if (Array.isArray(val)) {
        val.forEach(scan);
      } else if (val !== null && typeof val === 'object') {
        const obj = val as Record<string, unknown>;
        if (typeof obj.$context === 'string') {
          refs.push(obj.$context);
        }
        for (const k of Object.keys(obj)) {
          scan(obj[k]);
        }
      }
    };
    scan(input);
    return refs;
  }

  private resolvePath(obj: Record<string, unknown>, path: string): unknown {
    let cur: unknown = obj;
    for (const part of path.split('.')) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }
}
