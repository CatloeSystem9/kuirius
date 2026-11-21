/**
 * Test isolation — sets KRISHA_SANDBOX_DIR + KRISHA_FS_ROOTS to a temporary
 * directory BEFORE any E5-auditing module is loaded. Import this module
 * FIRST in any test script that directly uses ProcessMonitor, DetectionEngine,
 * ExecutionGate, or any other module whose lifecycle audit events could
 * reach the E5 audit chain.
 *
 * House pattern (cf. test-e5-m1.ts): the env vars must be set before the
 * module import that triggers serverSafety boot. Static imports are hoisted,
 * but they execute in declaration order — so importing this module first
 * ensures the env vars are set before subsequent module loads.
 *
 * The temp sandbox is cleaned up by calling `cleanupTestIsolation()` at the
 * end of the test run.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const __isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krisha-test-iso-'));
process.env.KRISHA_SANDBOX_DIR = path.join(__isoDir, 'e5store');
process.env.KRISHA_FS_ROOTS = path.join(__isoDir, 'fsroots');

export function cleanupTestIsolation(): void {
  try { fs.rmSync(__isoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
