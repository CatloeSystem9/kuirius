/**
 * tests/_local-harness/run.ts
 *
 * Runs specialistRegistry.test.ts using the local dependency-free harness
 * instead of vitest (used only because this sandbox has no npm registry
 * access). Compiles with `vitest` module resolution redirected to the
 * local harness via a tsconfig "paths" override — see run-tests.sh.
 */
import { __runAll } from "./vitest";
import "../specialistRegistry.test";

const { passed, failed, failures } = __runAll();

console.log(`\n${"=".repeat(60)}`);
console.log(`Krix Specialist Library — Test Results`);
console.log("=".repeat(60));
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

declare const process: { exitCode?: number } | undefined;

if (failures.length > 0) {
  console.log(`\nFailures:\n`);
  for (const f of failures) {
    console.log(`✗ ${f}\n`);
  }
  if (typeof process !== "undefined") process.exitCode = 1;
} else {
  console.log(`\nAll tests passed.`);
}
