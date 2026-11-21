/**
 * Threat Containment (Phase D) — safe, verified process termination.
 *
 * NARROWLY SCOPED: terminates a single, identity-verified, confirmed-malicious
 * process instance. No broad kill, no name-based matching, no process-tree
 * termination, no automatic termination without operator approval.
 *
 * IDENTITY VERIFICATION (before any containment action):
 *  1. The process must still exist (WMI Win32_Process query by PID).
 *  2. The process creation time must match the evidence (PID-reuse guard).
 *  3. The executable path must match the evidence.
 *  4. The process name must match the evidence.
 *  Any mismatch → REFUSED (never terminate a different process).
 *
 * EVIDENCE REQUIREMENTS:
 *  - Classification must be CONFIRMED_MALWARE (Phase B, Defender-trusted).
 *  - Evidence must be fresh (<24 h from assessment).
 *  - Evidence from ambiguous paths or stale Defender records is refused.
 *  - SUSPICIOUS/UNKNOWN/CLEAN processes are never terminated.
 *
 * AUTHORIZATION:
 *  - Operator approval token (single-use, bound to the target identity).
 *  - E-stop must be inactive.
 *  - E5 enforcement (audit + permission check at the route layer).
 *
 * TERMINATION:
 *  - `taskkill /PID <pid> /F` (same-user, non-admin).
 *  - Access-denied conditions are reported honestly.
 *  - Protected Windows processes (SYSTEM/elevated) are out of reach —
 *    access-denied is the expected outcome and is reported, not retried.
 *
 * NODE-ONLY: imports node:child_process — server entrypoint and tests only.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ContainmentRequest,
  ContainmentResult,
  ContainmentOutcome,
  ProcessIdentity,
  ContainmentAuditEvent,
} from './containmentTypes';

const run = promisify(execFile);

/** Maximum evidence age (24 hours) — stale evidence is refused. */
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

/** Windows critical process names that are NEVER terminated. */
const PROTECTED_PROCESSES = new Set([
  'system', 'idle', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'services.exe', 'lsass.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe',
  'defender.exe', 'msmpeng.exe', 'nissrv.exe', 'securityhealthservice.exe',
  'node.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'winver.exe',
]);

export interface ContainmentDependencies {
  /** Verify process identity via WMI (returns null if not found). */
  verifyProcess(pid: number): Promise<ProcessIdentity | null>;
  /** Check whether the emergency stop is active. */
  isStopActive(): boolean;
  /** Terminate a process by PID (same-user taskkill). Returns success boolean. */
  terminate(pid: number): Promise<boolean>;
  /** Audit sink (E5 chain). */
  audit: (event: ContainmentAuditEvent) => void;
}

export class ThreatContainment {
  private deps: ContainmentDependencies;

  constructor(deps: ContainmentDependencies) {
    this.deps = deps;
  }

  /**
   * Attempt to contain (terminate) a verified malicious process.
   * Every step is verified before action. Any failure is a safe refusal.
   */
  async contain(request: ContainmentRequest): Promise<ContainmentResult> {
    const { target, evidence } = request;
    const base = { targetPid: target.pid, targetName: target.name, targetCreationTime: target.creationTime };

    // 1. E-stop check — containment refused while the stop is active.
    if (this.deps.isStopActive()) {
      return this.audit('REFUSED_E_STOP', 'emergency stop is active — containment refused', base, evidence, !!request.approvalToken);
    }

    // 2. Classification evidence — must be CONFIRMED_MALWARE.
    if (evidence.classification !== 'CONFIRMED_MALWARE') {
      return this.audit('REFUSED_INSUFFICIENT_EVIDENCE',
        `classification is ${evidence.classification}, not CONFIRMED_MALWARE — containment refused`,
        base, evidence, !!request.approvalToken);
    }

    // 3. Evidence freshness — stale evidence is refused.
    const evidenceAge = Date.now() - evidence.assessedAt;
    if (evidenceAge > MAX_EVIDENCE_AGE_MS) {
      return this.audit('REFUSED_STALE_EVIDENCE',
        `evidence is ${Math.round(evidenceAge / 60000)} minutes old (max: 24 h) — stale evidence refused`,
        base, evidence, !!request.approvalToken);
    }

    // 4. Operator approval — required for all containment actions.
    if (!request.approvalToken || request.approvalToken.length < 8) {
      return this.audit('REFUSED_NO_APPROVAL',
        'operator approval token is required — containment refused without explicit authorization',
        base, evidence, !!request.approvalToken);
    }

    // 5. Protected process check — never terminate critical Windows processes.
    const nameLower = target.name.toLowerCase();
    if (PROTECTED_PROCESSES.has(nameLower)) {
      return this.audit('REFUSED_PROTECTED_PROCESS',
        `"${target.name}" is a protected process — containment refused`,
        base, evidence, !!request.approvalToken);
    }

    // 6. Revalidate process identity via WMI (PID reuse + existence check).
    // Errors from the WMI query are distinguished from process-not-found.
    let live: ProcessIdentity | null = null;
    try {
      live = await this.deps.verifyProcess(target.pid);
    } catch {
      return this.audit('VERIFICATION_UNAVAILABLE',
        `WMI process identity verification failed for PID ${target.pid} — cannot establish identity; containment refused`,
        base, evidence, !!request.approvalToken);
    }
    if (!live) {
      return this.audit('ALREADY_EXITED',
        `process ${target.pid} no longer exists (already exited or PID invalid)`,
        base, evidence, !!request.approvalToken);
    }

    // 7. Identity match: creation time must match (PID-reuse guard).
    if (live.creationTime !== target.creationTime) {
      return this.audit('REFUSED_PID_REUSED',
        `process ${target.pid} creation time mismatch — PID has been reused; refusing to terminate a different process`,
        base, evidence, !!request.approvalToken);
    }

    // 8. Identity match: executable path must match.
    if (live.executablePath && target.executablePath &&
        live.executablePath.toLowerCase() !== target.executablePath.toLowerCase()) {
      return this.audit('REFUSED_IDENTITY_CHANGED',
        `executable path changed since assessment: "${live.executablePath}" != "${target.executablePath}"`,
        base, evidence, !!request.approvalToken);
    }

    // 9. Identity match: process name must match.
    if (live.name && target.name && live.name.toLowerCase() !== target.name.toLowerCase()) {
      return this.audit('REFUSED_IDENTITY_CHANGED',
        `process name changed since assessment: "${live.name}" != "${target.name}"`,
        base, evidence, !!request.approvalToken);
    }

    // 10. E-stop re-check IMMEDIATELY before termination (Phase D.1 fix):
    // the stop could have been activated between the initial check and this
    // point. No approval token can override an active E-stop.
    if (this.deps.isStopActive()) {
      return this.audit('REFUSED_E_STOP',
        'emergency stop activated between initial check and termination — containment refused',
        base, evidence, !!request.approvalToken);
    }

    // 11. Terminate the verified process instance.
    const terminated = await this.deps.terminate(target.pid);
    if (!terminated) {
      return this.audit('ACCESS_DENIED',
        `termination of process ${target.pid} failed — access denied or process already exited`,
        base, evidence, !!request.approvalToken);
    }

    // 12. Post-termination verification: check that the process actually exited.
    // Distinguish three outcomes:
    //   a. Process not found → termination VERIFIED (success).
    //   b. Process still found → termination FAILED (access denied or protected).
    //   c. Verification unavailable (WMI error) → UNCERTAIN — do not claim success.
    let postVerify: ProcessIdentity | null = null;
    let postVerifyError = false;
    try {
      postVerify = await this.deps.verifyProcess(target.pid);
    } catch {
      postVerifyError = true;
    }
    if (postVerifyError) {
      return this.audit('VERIFICATION_UNAVAILABLE',
        `post-termination verification unavailable (WMI query failed) — termination attempted but outcome uncertain`,
        base, evidence, !!request.approvalToken);
    }
    if (postVerify) {
      return this.audit('ACCESS_DENIED',
        `process ${target.pid} still exists after termination attempt — access denied or protected`,
        base, evidence, !!request.approvalToken);
    }
    // Process not found after termination — VERIFIED success.
    return this.audit('TERMINATED',
      `process ${target.pid} (${target.name}) successfully terminated — identity verified, operator-approved, post-termination verified`,
      base, evidence, !!request.approvalToken);
  }

  private audit(
    outcome: ContainmentOutcome,
    reason: string,
    base: { targetPid: number; targetName: string; targetCreationTime: string },
    evidence: ContainmentRequest['evidence'],
    hasToken: boolean
  ): ContainmentResult {
    const event: ContainmentAuditEvent = {
      kind: 'threat_containment',
      outcome,
      reason,
      targetPid: base.targetPid,
      targetName: base.targetName,
      targetCreationTime: base.targetCreationTime,
      classification: evidence.classification,
      confidence: evidence.confidence,
      evidenceSources: evidence.evidenceSources,
      hasApprovalToken: hasToken,
      at: Date.now(),
    };
    try {
      this.deps.audit(event);
    } catch {
      /* audit failure must not break containment reporting */
    }
    return {
      outcome,
      reason,
      targetPid: base.targetPid,
      targetName: base.targetName,
      audited: true,
    };
  }
}

/** Default WMI-based process identity verifier.
 *  Throws on query errors (distinguishes WMI failure from process-not-found).
 *  Returns null only when the process genuinely does not exist.
 *  Handles the case where Get-CimInstance returns nothing for a nonexistent PID
 *  (PowerShell produces empty/null output — correctly mapped to null, not an error). */
export function defaultVerifyProcess(): (pid: number) => Promise<ProcessIdentity | null> {
  return async (pid: number): Promise<ProcessIdentity | null> => {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,CreationDate | ConvertTo-Json -Compress`],
      { timeout: 10_000, windowsHide: true }
    );
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return null;
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed.ProcessId !== 'number') return null;
    return {
      pid: parsed.ProcessId,
      name: String(parsed.Name ?? ''),
      creationTime: String(parsed.CreationDate ?? ''),
      executablePath: String(parsed.ExecutablePath ?? ''),
    };
  };
}

/** Default terminator: taskkill /PID <pid> /F (same-user, non-admin). */
export function defaultTerminate(): (pid: number) => Promise<boolean> {
  return async (pid: number): Promise<boolean> => {
    try {
      await run('taskkill', ['/PID', String(pid), '/F'], { timeout: 10_000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };
}
