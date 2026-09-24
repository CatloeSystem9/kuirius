/**
 * tests/_local-harness/vitest.ts
 *
 * A minimal, dependency-free stand-in for the subset of vitest's API used
 * by specialistRegistry.test.ts (describe/it/expect). This exists ONLY so
 * the test suite can run in environments without npm registry access.
 *
 * In the real Krix repository (or any environment with network access),
 * simply `npm install vitest` and this shim is not needed — the test file
 * imports from "vitest" and works unmodified either way, because this file
 * is aliased to that specifier only in this sandbox's local run script.
 */

type TestFn = () => void | Promise<void>;

interface TestCase {
  name: string;
  fn: TestFn;
  suite: string;
}

const tests: TestCase[] = [];
let currentSuite: string[] = [];

export function describe(name: string, fn: () => void): void {
  currentSuite.push(name);
  fn();
  currentSuite.pop();
}

export function it(name: string, fn: TestFn): void {
  tests.push({ name, fn, suite: currentSuite.join(" > ") });
}

class ExpectationError extends Error {}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

export function expect(actual: unknown, message?: string) {
  const prefix = message ? `${message} — ` : "";
  return {
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new ExpectationError(
          `${prefix}expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`
        );
      }
    },
    toEqual(expected: unknown) {
      if (!deepEqual(actual, expected)) {
        throw new ExpectationError(
          `${prefix}expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`
        );
      }
    },
    toContain(expected: unknown) {
      const arr = actual as unknown[] | string;
      const contains = Array.isArray(arr) ? arr.includes(expected) : (arr as string).includes(expected as string);
      if (!contains) {
        throw new ExpectationError(`${prefix}expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new ExpectationError(`${prefix}expected ${JSON.stringify(actual)} to be null`);
      }
    },
    not: {
      toBeNull() {
        if (actual === null) {
          throw new ExpectationError(`${prefix}expected value not to be null`);
        }
      },
    },
    toBeGreaterThan(expected: number) {
      if (!((actual as number) > expected)) {
        throw new ExpectationError(`${prefix}expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number) {
      if (!((actual as number) >= expected)) {
        throw new ExpectationError(`${prefix}expected ${actual} to be >= ${expected}`);
      }
    },
    toBeLessThanOrEqual(expected: number) {
      if (!((actual as number) <= expected)) {
        throw new ExpectationError(`${prefix}expected ${actual} to be <= ${expected}`);
      }
    },
    toThrow(errorClass?: any) {
      let threw = false;
      let err: unknown;
      try {
        (actual as () => void)();
      } catch (e) {
        threw = true;
        err = e;
      }
      if (!threw) {
        throw new ExpectationError(`${prefix}expected function to throw`);
      }
      if (errorClass && !(err instanceof errorClass)) {
        throw new ExpectationError(`${prefix}expected function to throw ${errorClass.name}, got ${err}`);
      }
    },
  };
}

export function __runAll(): { passed: number; failed: number; failures: string[] } {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const t of tests) {
    try {
      const result = t.fn();
      if (result instanceof Promise) {
        throw new Error("Async tests not supported in local harness");
      }
      passed++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${t.suite} > ${t.name}\n    ${msg}`);
    }
  }

  return { passed, failed, failures };
}
