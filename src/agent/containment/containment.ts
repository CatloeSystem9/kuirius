/**
 * Threat Containment (Phase D.3) — safe, verified termination of the EXACT
 * process instance that was classified and approved.
 *
 * NARROWLY SCOPED: terminates a single, identity-verified, confirmed-malicious
 * process instance. No broad kill, no name-based matching, no process-tree
 * termination, no automatic termination without operator approval.
 *
 * PHASE D.3 — PROCESS-INSTANCE PINNING (PID-reuse correction):
 *  The Phase D implementation verified identity via a WMI query and then
 *  terminated with `taskkill /PID /F`. taskkill re-resolves the PID to a
 *  process object at ITS OWN execution time, so a process that exits between
 *  verification and termination — with its PID reused by an unrelated
 *  process — could receive the termination signal. Post-termination
 *  verification cannot undo a wrong kill.
 *
 *  Correction: termination is now bound to a process-INSTANCE REFERENCE.
 *  `OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)` is
 *  called ONCE, at verification time. Identity (creation time via
 *  `GetProcessTimes`, image path via `QueryFullProcessImageName`) is read
 *  THROUGH the retained handle, and termination calls `TerminateProcess` on
 *  the SAME handle. A handle refers to the kernel process OBJECT — if the
 *  process exits and Windows reuses its PID, the handle still refers to the
 *  original (now exited) object. The termination signal can never follow
 *  PID reuse. This uses documented Win32 APIs under the SAME non-admin,
 *  same-user privilege envelope that taskkill required; no driver, no
 *  security-setting changes, no privilege escalation.
 *
 *  Where a terminate-capable reference cannot be opened (e.g. elevated or
 *  protected processes), the outcome is IDENTITY_NOT_GUARANTEED — containment
 *  is refused rather than falling back to PID-based termination. There is
 *  NO taskkill fallback anywhere in this module.
 *
 * IDENTITY VERIFICATION (all through the pin):
 *  1. The process must still exist (pin acquisition).
 *  2. Creation time must match the approved instance (PID-reuse guard).
 *  3. Executable path must match the approved identity.
 *  4. Process name must match the approved identity.
 *  Any mismatch or unavailable metadata → REFUSED (ambiguous identity fails
 *  closed; a metadata-unavailable identity is never terminated).
 *
 * AUTHORIZATION (server-side, Phase D.3):
 *  - Approval tokens are minted ONLY by issueApproval(), server-side, after
 *    the server itself reads the process identity and re-classifies the
 *    executable via the Phase B engine. Tokens are single-use, 5-minute TTL,
 *    and bound to the exact process identity {pid, creationTime, path, name}.
 *  - contain() validates the token against the PINNED identity (not against
 *    any client-supplied data). Client-supplied classification or identity
 *    fields are never trusted — the request shape carries only {pid, token}.
 *  - Approval CANNOT be replayed (single-use), transferred to another
 *    process (binding), or override an active E-stop (checked at entry and
 *    again immediately before termination).
 *  - Only CONFIRMED_MALWARE is approvable. SUSPICIOUS/UNKNOWN/CLEAN are
 *    never contained. Classification comes from the injected Phase B
 *    dependency — the classifier has no containment capability and cannot
 *    approve its own action.
 *
 * TERMINATION:
 *  - TerminateProcess on the pinned handle (same-user, non-admin).
 *  - Access-denied conditions are reported honestly.
 *  - Protected Windows processes (SYSTEM/elevated) are out of reach — the
 *    pin fails with ACCESS_DENIED and containment is refused (never retried
 *    through any other mechanism).
 *
 * NODE-ONLY: imports node:child_process — server entrypoint and tests only.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type {
  ContainmentRequest,
  ContainmentResult,
  ContainmentOutcome,
  ContainmentClassification,
  ContainmentApprovalToken,
  ContainmentApprovalIssuance,
  ContainmentAuditEvent,
  ClassificationEvidence,
  ProcessIdentity,
  PinnedProcess,
  ContainmentDependencies,
  ApprovalAuthorityResult,
} from './containmentTypes';
import { PinUnavailableError } from './containmentTypes';

export type { ContainmentDependencies } from './containmentTypes';

/** Maximum evidence age (24 hours) — stale evidence is refused. */
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

/** Approval token TTL (5 minutes) — short authorization lifetime. */
const APPROVAL_TOKEN_TTL_MS = 5 * 60 * 1000;

/** Bounded approval registry. Overflow evicts the OLDEST entry (LRU). */
const MAX_PENDING_APPROVALS = 32;

/** Windows critical process names that are NEVER terminated. */
const PROTECTED_PROCESSES = new Set([
  'system', 'idle', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'services.exe', 'lsass.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe',
  'defender.exe', 'msmpeng.exe', 'nissrv.exe', 'securityhealthservice.exe',
  'node.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'winver.exe',
]);

// Pin-worker timing (bounded so containment can never hang indefinitely).
const DEFAULT_PIN_TIMEOUT_MS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 12_000;
const DEFAULT_SESSION_MAX_MS = 60_000;
const RELEASE_GRACE_MS = 1_500;

// ---------------------------------------------------------- pin worker (PS)

/**
 * P/Invoke declarations for the pin worker. Delivered to PowerShell as a
 * single-line base64 string: multi-line here-strings DO NOT terminate
 * reliably when fed through the `-Command -` stdin reader (verified against
 * Windows PowerShell 5.1 — the REPL stalls waiting for the terminator),
 * while single-line statements and multi-line loops work.
 */
const PIN_CSHARP_SOURCE = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class KrishaPin {',
  '  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);',
  '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);',
  '  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);',
  '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr hObject);',
  '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr hProcess, out long lpCreationFileTime, out long lpExitFileTime, out long lpKernelFileTime, out long lpUserFileTime);',
  '  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);',
  '}',
].join('\n');

const PIN_CSHARP_B64 = Buffer.from(PIN_CSHARP_SOURCE, 'utf8').toString('base64');

/**
 * PowerShell worker transport. The script is delivered via -EncodedCommand
 * (base64 UTF-16LE argv): the `-Command -` stdin REPL is UNSUITABLE here —
 * the host's own stdin reader competes with the script's
 * [Console]::In.ReadLine() command loop (verified: no output, commands never
 * reach the worker). With -EncodedCommand the host consumes no stdin, so the
 * command loop reads our lines cleanly. stdin stays open for the session.
 *
 * Pin protocol:
 *   stdout:  "UNPINNABLE\t<win32err>"            — OpenProcess failed
 *            "PINNED\t<iso>\t<name>\t<path>"     — pinned, identity read
 *            "TERMOK" | "TERMFAIL\t<err>" | "TERMUNCERTAIN"
 *            "EXITED\t<waitcode>"                — 0 = exited, 258 = running
 *   stdin:   TERMINATE | ISEXITED | RELEASE
 * The handle lives ONLY inside this worker process; all identity reads and
 * the termination act on the same handle, so they always target the same
 * kernel process object.
 */
const PIN_WORKER_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
  `$src=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${PIN_CSHARP_B64}'))`,
  'Add-Type -TypeDefinition $src',
  'function Out-Line([string]$s){ [Console]::Out.WriteLine($s); [Console]::Out.Flush() }',
  '$h=[IntPtr]::Zero',
  'try {',
  '  $h=[KrishaPin]::OpenProcess(0x00001001,$false,__PID__)',
  '  if($h -eq [IntPtr]::Zero){',
  '    $e=[Runtime.InteropServices.Marshal]::GetLastWin32Error()',
  '    Out-Line ("UNPINNABLE`t"+$e)',
  '    exit 0',
  '  }',
  '  $c=[long]0;$x=[long]0;$k=[long]0;$u=[long]0',
  '  if(-not [KrishaPin]::GetProcessTimes($h,[ref]$c,[ref]$x,[ref]$k,[ref]$u)){ $c=[long]0 }',
  '  $sb=New-Object System.Text.StringBuilder 2048',
  '  $sz=[uint32]2048',
  '  $p=""',
  '  if([KrishaPin]::QueryFullProcessImageName($h,0,$sb,[ref]$sz)){ $p=$sb.ToString() }',
  '  $iso=if($c -gt 0){ [DateTime]::FromFileTimeUtc($c).ToString("o") } else { "" }',
  '  $n=if($p){ [System.IO.Path]::GetFileName($p) } else { "" }',
  '  Out-Line ("PINNED`t"+$iso+"`t"+$n+"`t"+$p)',
  '  while($true){',
  '    $line=[Console]::In.ReadLine()',
  '    if($null -eq $line){ break }',
  '    $cmd=$line.Trim()',
  '    if($cmd -eq "TERMINATE"){',
  '      $ok=[KrishaPin]::TerminateProcess($h,[uint32]1)',
  '      if(-not $ok){',
  '        $e2=[Runtime.InteropServices.Marshal]::GetLastWin32Error()',
  '        Out-Line ("TERMFAIL`t"+$e2)',
  '        break',
  '      }',
  '      $w=[KrishaPin]::WaitForSingleObject($h,[uint32]5000)',
  '      if($w -eq 0){ Out-Line "TERMOK" } else { Out-Line "TERMUNCERTAIN" }',
  '      break',
  '    } elseif($cmd -eq "ISEXITED"){',
  '      $w2=[KrishaPin]::WaitForSingleObject($h,[uint32]0)',
  '      Out-Line ("EXITED`t"+$w2)',
  '    } elseif($cmd -eq "RELEASE"){',
  '      break',
  '    }',
  '  }',
  '} finally {',
  '  if($h -ne [IntPtr]::Zero){ [void][KrishaPin]::CloseHandle($h) }',
  '}',
].join('\n');

// 0x0001 PROCESS_TERMINATE | 0x1000 PROCESS_QUERY_LIMITED_INFORMATION
const PIN_ACCESS = '0x00001001';

type OpenResult =
  | { kind: 'pinned'; identity: { name: string; creationTime: string; executablePath: string } }
  | { kind: 'not_found'; win32Error?: number }
  | { kind: 'unpinnable'; win32Error?: number }
  | { kind: 'infra' };

interface PendingLine {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One PowerShell pin session. The OS handle lives in the child process;
 * commands over stdin act on it. All waits are bounded.
 */
class PinWorkerSession {
  private proc: ReturnType<typeof spawn> | null = null;
  private buffer = '';
  private pending: PendingLine[] = [];
  private closed = false;
  private releaseCalled = false;
  readonly openPromise: Promise<OpenResult>;

  constructor(pid: number, timeoutMs: number) {
    const script = PIN_WORKER_SCRIPT.replace('__PID__', String(pid));
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const proc = this.proc;
    proc.stdout!.on('data', (d: Buffer) => {
      this.buffer += String(d);
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length > 0) this.onLine(line);
      }
    });
    proc.stderr!.on('data', () => { /* stderr noise ignored */ });
    proc.on('error', (err) => this.failAll(new PinUnavailableError('INFRASTRUCTURE', undefined, `pin worker error: ${err.message}`)));
    proc.on('close', () => {
      this.closed = true;
      this.failAll(new PinUnavailableError('INFRASTRUCTURE', undefined, 'pin worker exited before the command completed'));
    });
    const killTimer = setTimeout(() => {
      this.failAll(new PinUnavailableError('INFRASTRUCTURE', undefined, 'pin worker session exceeded its lifetime bound'));
      this.kill();
    }, timeoutMs);
    killTimer.unref?.();

    this.openPromise = new Promise<OpenResult>((resolve) => { this.openSettle = resolve; });
  }

  private openSettle!: (r: OpenResult) => void;
  private openDone = false;

  private onLine(line: string): void {
    if (!this.openDone) {
      this.openDone = true;
      const parts = line.split('\t');
      if (parts[0] === 'PINNED') {
        this.openSettle({ kind: 'pinned', identity: { creationTime: parts[1] ?? '', name: parts[2] ?? '', executablePath: parts.slice(3).join('\t') } });
      } else if (parts[0] === 'UNPINNABLE') {
        const err = Number(parts[1]);
        // 87 = ERROR_INVALID_PARAMETER (no such process); 5 = ERROR_ACCESS_DENIED.
        this.openSettle(err === 87 ? { kind: 'not_found', win32Error: err } : { kind: 'unpinnable', win32Error: err });
      } else {
        // Unexpected first line — the worker script behaved abnormally.
        this.openSettle({ kind: 'infra' });
      }
      return;
    }
    const waiter = this.pending.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  }

  private failAll(err: Error): void {
    const waiters = this.pending.splice(0, this.pending.length);
    for (const w of waiters) {
      clearTimeout(w.timer);
      try { w.reject(err); } catch { /* never throw from cleanup */ }
    }
    if (!this.openDone) {
      this.openDone = true;
      this.openSettle({ kind: 'infra' });
    }
  }

  /** Send one command and await its single response line (bounded). */
  command(cmd: string, timeoutMs: number): Promise<string> {
    if (this.closed || !this.proc) {
      return Promise.reject(new PinUnavailableError('INFRASTRUCTURE', undefined, 'pin worker is closed'));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.timer === timer);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new PinUnavailableError('INFRASTRUCTURE', undefined, `pin worker command "${cmd}" timed out`));
      }, timeoutMs);
      this.pending.push({ resolve, reject, timer });
      try {
        this.proc!.stdin!.write(cmd + '\n');
      } catch (err) {
        clearTimeout(timer);
        const i = this.pending.findIndex((p) => p.timer === timer);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new PinUnavailableError('INFRASTRUCTURE', undefined, `pin worker stdin write failed: ${String(err)}`));
      }
    });
  }

  /** Release the pin without terminating (idempotent). */
  release(): void {
    if (this.releaseCalled) return;
    this.releaseCalled = true;
    try {
      this.proc?.stdin?.write('RELEASE\n');
    } catch { /* closing */ }
    // Grace period for the child to close its own handle; then force-kill.
    setTimeout(() => this.kill(), RELEASE_GRACE_MS).unref?.();
  }

  kill(): void {
    this.closed = true;
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
  }
}

/**
 * Default pin implementation: acquire a terminate-capable OS reference to
 * the process instance currently holding `pid` and read its identity
 * THROUGH the reference. Returns null when no such process exists; throws
 * PinUnavailableError when the reference cannot be established.
 */
export function defaultPinProcess(): (pid: number) => Promise<PinnedProcess | null> {
  return (pid: number): Promise<PinnedProcess | null> => {
    if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
    const session = new PinWorkerSession(pid, DEFAULT_SESSION_MAX_MS);
    return session.openPromise.then((res) => {
      if (res.kind === 'not_found') return null;
      if (res.kind === 'infra') {
        session.release();
        throw new PinUnavailableError('INFRASTRUCTURE');
      }
      if (res.kind === 'unpinnable') {
        session.release();
        throw new PinUnavailableError('ACCESS_DENIED', res.win32Error);
      }
      const identity = res.identity;
      const pin: PinnedProcess = {
        pid,
        name: identity.name,
        creationTime: identity.creationTime,
        executablePath: identity.executablePath,
        terminate: (): Promise<boolean> =>
          session.command('TERMINATE', DEFAULT_COMMAND_TIMEOUT_MS).then((line) => {
            if (line === 'TERMOK') return true;
            return false; // TERMFAIL (win32 error) or TERMUNCERTAIN (wait timed out)
          }), // infrastructure failures REJECT — the module maps them honestly
        hasExited: (): Promise<boolean | null> =>
          session.command('ISEXITED', DEFAULT_COMMAND_TIMEOUT_MS).then((line) => {
            const parts = line.split('\t');
            if (parts[0] !== 'EXITED') return null;
            const w = Number(parts[1]);
            if (w === 0) return true;      // WAIT_OBJECT_0 — exited
            if (w === 258) return false;   // WAIT_TIMEOUT — still running
            return null;                    // WAIT_FAILED or unexpected — cannot determine
          }).catch(() => null),
        release: (): void => session.release(),
      };
      return pin;
    });
  };
}

/**
 * Default approval-time identity reader: pin + read + immediate release.
 * Identity is read through the OS reference (same source as the
 * termination-time pin), so approval binding and containment verification
 * always use the same identity format and source.
 */
export function defaultReadProcessIdentity(): (pid: number) => Promise<ProcessIdentity | null> {
  return async (pid: number): Promise<ProcessIdentity | null> => {
    const pin = await defaultPinProcess()(pid);
    if (!pin) return null;
    const identity: ProcessIdentity = {
      pid: pin.pid,
      name: pin.name,
      creationTime: pin.creationTime,
      executablePath: pin.executablePath,
    };
    pin.release();
    return identity;
  };
}

// ------------------------------------------------- credential-backed authority

export interface CredentialAuthoritySources {
  /**
   * Server-side verification of a candidate operator approval credential.
   * The PRODUCTION source is `verifyContainmentApprovalCredential` (E5
   * protected store, scrypt + timing-safe compare, shared failure backoff).
   * May throw (backoff/infrastructure) — treated as unavailable, fail-closed.
   */
  verifyCredential(code: string): boolean;
  /** Whether an operator approval credential is currently enrolled. */
  credentialSet(): boolean;
  /** Monotonic authority epoch (changes on every enrollment change). */
  approvalEpoch(): number;
}

/**
 * The PRODUCTION approval authority (Phase D completion): containment
 * approval exists ONLY when the operator has enrolled an approval credential
 * through the recovery pipe (a channel with no model/tool path). Approval
 * time verifies that credential server-side — a server-generated token is
 * never mistaken for the human decision, because a token can only be minted
 * AFTER this verification. Containment-time checks confirm the authority
 * still exists and is UNCHANGED (epoch comparison) immediately before
 * termination, so a mid-operation credential clear/rotation invalidates the
 * operation. Before enrollment the authority is unavailable — the D.4
 * disabled posture — and termination stays unreachable.
 */
export function createCredentialApprovalAuthority(sources: CredentialAuthoritySources): (input: { pid: number; operatorCredential?: string; authorityEpoch?: number }) => ApprovalAuthorityResult {
  return (input: { pid: number; operatorCredential?: string; authorityEpoch?: number }): ApprovalAuthorityResult => {
    // APPROVAL time: verify the operator's credential — THE human decision.
    if (typeof input.operatorCredential === 'string') {
      if (!sources.credentialSet()) {
        return { authorized: false, unavailable: true, reason: 'no operator approval credential is enrolled - termination disabled pending operator enrollment (set-containment-credential via the recovery pipe)' };
      }
      let ok = false;
      try {
        ok = sources.verifyCredential(input.operatorCredential);
      } catch (err) {
        return { authorized: false, unavailable: true, reason: `approval credential verification unavailable: ${String((err as Error)?.message || err)} — fail-closed` };
      }
      return ok
        ? { authorized: true, authorityId: `cap-epoch-${sources.approvalEpoch()}`, method: 'operator-approval-credential', authorityEpoch: sources.approvalEpoch() }
        : { authorized: false, unavailable: false, reason: 'operator approval credential verification FAILED — containment approval refused (the decision must be the operator\'s, proven by the credential)' };
    }
    // PRE-TERMINATION: the authority must be unchanged since issuance.
    if (input.authorityEpoch !== undefined) {
      const unchanged = sources.credentialSet() && sources.approvalEpoch() === input.authorityEpoch;
      return unchanged
        ? { authorized: true, authorityId: `cap-epoch-${sources.approvalEpoch()}`, method: 'operator-approval-credential', authorityEpoch: sources.approvalEpoch() }
        : { authorized: false, unavailable: false, reason: `approval authority changed since issuance (credential cleared or re-enrolled; issued at epoch ${input.authorityEpoch}, current ${sources.approvalEpoch()}) — termination refused (mid-operation loss of authorization)` };
    }
    // CONTAINMENT entry: an authority must exist at all.
    return sources.credentialSet()
      ? { authorized: true, authorityId: `cap-epoch-${sources.approvalEpoch()}`, method: 'operator-approval-credential', authorityEpoch: sources.approvalEpoch() }
      : { authorized: false, unavailable: true, reason: 'no operator approval credential is enrolled — termination disabled pending operator enrollment (set-containment-credential via the recovery pipe)' };
  };
}

// ------------------------------------------------------- containment engine

interface ApprovalEntry extends ContainmentApprovalToken {
  used: boolean;
}

function newRequestId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

export class ThreatContainment {
  private deps: ContainmentDependencies;
  private pending = new Map<string, ApprovalEntry>();

  constructor(deps: ContainmentDependencies) {
    this.deps = deps;
  }

  /** Expire stale approval tokens (called on status queries). */
  sweepExpiredApprovals(): void {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(key);
    }
  }

  /** Number of live (pending) approval tokens — bounded diagnostics. */
  pendingApprovalCount(): number {
    this.sweepExpiredApprovals();
    return this.pending.size;
  }

  /**
   * Issue a single-use containment approval for the process instance
   * currently holding `pid`. Server-side ONLY:
   *   - an INDEPENDENT approval-authority decision is required first (a
   *     permission is NOT an operator decision — Phase D.4); in production
   *     the authority verifies the OPERATOR'S APPROVAL CREDENTIAL (a
   *     dedicated secret enrolled through the recovery pipe) — the human
   *     decision moment;
   *   - identity is read through an OS process reference (never client data);
   *   - the executable is classified server-side via the Phase B dependency;
   *   - only CONFIRMED_MALWARE is approvable;
   *   - the token is bound to the exact process identity, carries the
   *     authority epoch, and is consumed on use.
   * When no operator credential is enrolled (production default), the
   * outcome is APPROVAL_AUTHORITY_UNAVAILABLE and no token is ever minted.
   */
  async issueApproval(pid: number, operatorCredential: string): Promise<ContainmentApprovalIssuance> {
    const requestId = newRequestId('ta');
    const state = {
      requestId,
      targetPid: pid,
      targetName: `pid:${pid}`,
      targetCreationTime: '',
      classification: 'UNAVAILABLE' as ContainmentClassification,
      confidence: 'NONE',
      evidenceSources: [] as string[],
      evidenceAgeMs: -1,
      estopActive: false,
      authorized: false,
      terminationEligible: false,
      terminationAttempted: false,
      terminationResult: 'not_attempted' as const,
      postVerifyResult: 'not_performed' as const,
      approvalAuthority: 'not_evaluated',
      hasApprovalToken: false,
    };

    const finish = (outcome: ContainmentOutcome, reason: string, extra?: { token?: ContainmentApprovalToken; identity?: ProcessIdentity; classification?: ContainmentClassification }): ContainmentApprovalIssuance => {
      state.estopActive = this.deps.isStopActive();
      this.emitAudit(requestId, outcome, reason, state);
      return { outcome, reason, token: extra?.token, identity: extra?.identity, classification: extra?.classification };
    };

    // No authorization material is minted while the emergency stop is active
    // (the approval route is also stop-blocked — defense in depth).
    state.estopActive = this.deps.isStopActive();
    if (state.estopActive) {
      return finish('REFUSED_E_STOP', 'emergency stop is active — no containment approval is issued');
    }

    // INDEPENDENT approval-authority check (Phase D.4, credential-backed): a
    // permission or an API caller is not an operator decision. In production
    // the authority verifies the OPERATOR'S APPROVAL CREDENTIAL server-side —
    // the model, an agent, or any other caller cannot approve its own
    // containment request without that secret.
    const authority = await this.resolveAuthority({ pid, operatorCredential });
    if (authority.kind !== 'authorized') {
      state.approvalAuthority = authority.kind;
      return finish(
        authority.kind === 'unavailable' ? 'APPROVAL_AUTHORITY_UNAVAILABLE' : 'REFUSED_NO_APPROVAL',
        authority.reason,
      );
    }
    state.approvalAuthority = authority.method;
    const issuedAuthorityEpoch = authority.authorityEpoch;

    let identity: ProcessIdentity | null = null;
    try {
      identity = await this.deps.readProcessIdentity(pid);
    } catch {
      return finish('REFUSED_INSUFFICIENT_EVIDENCE', 'process identity read failed — approval refused (fail-closed)');
    }
    if (!identity) {
      return finish('ALREADY_EXITED', `process ${pid} no longer exists (already exited or PID invalid)`);
    }
    state.targetName = identity.name || state.targetName;
    state.targetCreationTime = identity.creationTime;

    // Ambiguous identity fails closed (no path or no creation time).
    if (!identity.executablePath || !identity.creationTime) {
      return finish('REFUSED_IDENTITY_CHANGED', 'process identity metadata unavailable — ambiguous identity; approval refused');
    }

    // Protected Windows processes are never approvable.
    if (PROTECTED_PROCESSES.has(identity.name.toLowerCase())) {
      return finish('REFUSED_PROTECTED_PROCESS', `"${identity.name}" is a protected process — containment approval refused`);
    }

    // Server-side classification (Phase B dependency) — never client-supplied.
    const evidence = await this.deps.classify(identity.executablePath).catch(() => null);
    if (!evidence) {
      return finish('REFUSED_INSUFFICIENT_EVIDENCE', 'server-side classification unavailable — approval refused (fail-closed)');
    }
    state.classification = evidence.classification;
    state.confidence = evidence.confidence;
    state.evidenceSources = [...evidence.evidenceSources];
    state.evidenceAgeMs = Math.max(0, Date.now() - evidence.assessedAt);

    if (evidence.classification !== 'CONFIRMED_MALWARE') {
      return finish('REFUSED_INSUFFICIENT_EVIDENCE',
        `server-side classification is ${evidence.classification}, not CONFIRMED_MALWARE — containment approval exists only for confirmed malware (SUSPICIOUS/UNKNOWN/CLEAN are never contained)`);
    }
    if (state.evidenceAgeMs > MAX_EVIDENCE_AGE_MS) {
      return finish('REFUSED_STALE_EVIDENCE', `classification evidence is ${Math.round(state.evidenceAgeMs / 60000)} minutes old (max: 24 h) — stale evidence refused`);
    }

    // Mint the token (bounded registry; overflow evicts the oldest entry).
    this.sweepExpiredApprovals();
    if (this.pending.size >= MAX_PENDING_APPROVALS) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    const token: ApprovalEntry = {
      token: randomBytes(24).toString('hex'),
      pid: identity.pid,
      name: identity.name,
      creationTime: identity.creationTime,
      executablePath: identity.executablePath,
      classification: evidence.classification,
      authorityEpoch: issuedAuthorityEpoch,
      issuedAt: Date.now(),
      expiresAt: Date.now() + APPROVAL_TOKEN_TTL_MS,
      used: false,
    };
    this.pending.set(token.token, token);
    const publicToken: ContainmentApprovalToken = { ...token };
    return finish('APPROVAL_ISSUED', 'single-use containment approval issued (5-minute TTL, bound to the exact process identity)',
      { token: publicToken, identity, classification: evidence.classification });
  }

  /**
   * Attempt to contain (terminate) the approved, pinned process instance.
   * Every step is verified before action; any failure is a safe refusal.
   * The request carries ONLY {pid, approvalToken} — classification and
   * identity are established server-side.
   */
  async contain(request: ContainmentRequest): Promise<ContainmentResult> {
    const requestId = newRequestId('tc');
    const pid = request.pid;
    const state = {
      requestId,
      targetPid: pid,
      targetName: `pid:${pid}`,
      targetCreationTime: '',
      classification: 'UNAVAILABLE' as ContainmentClassification,
      confidence: 'NONE',
      evidenceSources: [] as string[],
      evidenceAgeMs: -1,
      estopActive: this.deps.isStopActive(),
      authorized: false,
      terminationEligible: false,
      terminationAttempted: false,
      terminationResult: 'not_attempted' as 'not_attempted' | 'succeeded' | 'failed' | 'unknown',
      postVerifyResult: 'not_performed' as 'not_performed' | 'exited' | 'still_running' | 'unavailable',
      approvalAuthority: 'not_evaluated',
      hasApprovalToken: !!request.approvalToken,
    };

    const finish = (outcome: ContainmentOutcome, reason: string): ContainmentResult => {
      this.emitAudit(requestId, outcome, reason, state);
      return { outcome, reason, targetPid: state.targetPid, targetName: state.targetName, audited: true };
    };

    // 1. E-stop check — containment refused while the stop is active.
    if (state.estopActive) {
      return finish('REFUSED_E_STOP', 'emergency stop is active — containment refused');
    }

    // 2. INDEPENDENT approval-authority check (Phase D.4): holding a
    //    permission (or presenting any token) is NOT proof that an operator
    //    decided. Without a verified authority, termination is unreachable —
    //    checked BEFORE token/registry/pin handling so the refusal is
    //    explicit and nothing about the target is probed.
    const authority = await this.resolveAuthority({ pid });
    if (authority.kind !== 'authorized') {
      state.approvalAuthority = authority.kind;
      return finish(
        authority.kind === 'unavailable' ? 'APPROVAL_AUTHORITY_UNAVAILABLE' : 'REFUSED_NO_APPROVAL',
        authority.reason,
      );
    }
    state.approvalAuthority = authority.method;

    // 3. Approval token shape — a real server-minted token is required.
    if (!request.approvalToken || request.approvalToken.length < 8) {
      return finish('REFUSED_NO_APPROVAL', 'operator approval token is required — containment refused without explicit authorization');
    }

    // 4. Registry pre-check (no consume yet): invalid/unknown/expired tokens
    //    are refused BEFORE any process probing (no existence oracle for
    //    unauthorized callers).
    const precheck = this.precheckApprovalToken(request.approvalToken);
    if (precheck) return finish(precheck.outcome, precheck.reason);

    // 5. Pin the process instance FIRST — the identity anchor. Identity is
    //    read THROUGH the pin; termination will use the same reference.
    let pin: PinnedProcess | null = null;
    try {
      pin = await this.deps.pinProcess(pid);
    } catch (err) {
      if (err instanceof PinUnavailableError && err.failure === 'ACCESS_DENIED') {
        return finish('IDENTITY_NOT_GUARANTEED',
          `terminate-capable process reference could not be opened for PID ${pid}${err.win32Error !== undefined ? ` (win32=${err.win32Error})` : ''} — process-instance binding not established; termination refused (no PID-based fallback exists)`);
      }
      return finish('VERIFICATION_UNAVAILABLE',
        `process-instance pinning failed for PID ${pid} — cannot establish identity; containment refused (fail-closed)`);
    }
    if (!pin) {
      return finish('ALREADY_EXITED', `process ${pid} no longer exists (already exited or PID invalid)`);
    }

    // The pin MUST be released on every path (no OS reference leaks).
    try {
      state.targetName = pin.name || state.targetName;
      state.targetCreationTime = pin.creationTime;

      // 6. Ambiguous identity fails closed — metadata must be readable
      //    through the pin (empty path/creation time is never terminated).
      if (!pin.executablePath || !pin.creationTime) {
        return finish('REFUSED_IDENTITY_CHANGED', 'process identity metadata unavailable through the pinned reference — ambiguous identity; containment refused');
      }

      // 7. Validate + consume the approval token against the PINNED identity
      //    (PID-reuse guard: creation-time mismatch refuses even when the
      //    path and name coincide). On success the token's authority epoch
      //    is captured for the pre-termination staleness re-check.
      const binding = this.validateTokenBinding(request.approvalToken, pin);
      if (binding.ok === false) return finish(binding.outcome, binding.reason);
      const approvedAuthorityEpoch = binding.authorityEpoch;
      state.authorized = true;

      // 8. Protected process check — against the PINNED name (authoritative).
      if (PROTECTED_PROCESSES.has(pin.name.toLowerCase())) {
        return finish('REFUSED_PROTECTED_PROCESS', `"${pin.name}" is a protected process — containment refused`);
      }

      // 9. Server-side classification of the pinned executable (Phase B
      //    dependency). Client labels cannot reach this decision.
      const evidence = await this.deps.classify(pin.executablePath).catch(() => null);
      if (!evidence) {
        return finish('REFUSED_INSUFFICIENT_EVIDENCE', 'server-side classification unavailable — containment refused (fail-closed)');
      }
      state.classification = evidence.classification;
      state.confidence = evidence.confidence;
      state.evidenceSources = [...evidence.evidenceSources];
      state.evidenceAgeMs = Math.max(0, Date.now() - evidence.assessedAt);
      if (evidence.classification !== 'CONFIRMED_MALWARE') {
        return finish('REFUSED_INSUFFICIENT_EVIDENCE',
          `server-side classification is ${evidence.classification}, not CONFIRMED_MALWARE — containment refused (SUSPICIOUS/UNKNOWN/CLEAN are never terminated)`);
      }
      if (state.evidenceAgeMs > MAX_EVIDENCE_AGE_MS) {
        return finish('REFUSED_STALE_EVIDENCE', `classification evidence is ${Math.round(state.evidenceAgeMs / 60000)} minutes old (max: 24 h) — stale evidence refused`);
      }

      // 10. E-stop re-check IMMEDIATELY before termination (Phase D.1 fix,
      //     preserved): no approval token can override an active E-stop.
      if (this.deps.isStopActive()) {
        state.estopActive = true;
        return finish('REFUSED_E_STOP', 'emergency stop activated between initial check and termination — containment refused');
      }

      // 10b. Approval-authority re-check IMMEDIATELY before termination:
      //      the authority epoch recorded at ISSUANCE must be unchanged —
      //      a credential cleared or re-enrolled between approval and
      //      termination invalidates the approval (mid-operation loss of
      //      authorization must prevent termination). The E-stop re-check
      //      above covers the stop itself; this covers the authority.
      const authorityRecheck = await this.resolveAuthority({ pid, authorityEpoch: approvedAuthorityEpoch });
      if (authorityRecheck.kind !== 'authorized') {
        state.approvalAuthority = authorityRecheck.kind;
        return finish(
          authorityRecheck.kind === 'unavailable' ? 'APPROVAL_AUTHORITY_UNAVAILABLE' : 'REFUSED_NO_APPROVAL',
          `approval authority invalid at termination time — ${authorityRecheck.reason}`,
        );
      }

      // 11. Terminate the PINNED instance (never follows PID reuse).
      state.terminationEligible = true;
      state.terminationAttempted = true;
      let terminated: boolean;
      try {
        terminated = await pin.terminate();
      } catch {
        state.terminationResult = 'unknown';
        state.postVerifyResult = 'unavailable';
        return finish('VERIFICATION_UNAVAILABLE', 'termination attempt failed inside the pinned reference — outcome uncertain (never reported as success)');
      }
      state.terminationResult = terminated ? 'succeeded' : 'failed';

      // 11. Post-termination verification THROUGH THE SAME PIN:
      //    a. exited → TERMINATED (verified success)
      //    b. still running → ACCESS_DENIED (termination failed)
      //    c. cannot determine → VERIFICATION_UNAVAILABLE (never success)
      const exited = await pin.hasExited();
      if (exited === true) {
        state.postVerifyResult = 'exited';
        if (terminated) {
          return finish('TERMINATED', `pinned process instance ${pid} (${pin.name}) terminated — identity bound through an OS process reference, operator-approved, post-termination verified`);
        }
        return finish('ALREADY_EXITED', `pinned process instance ${pid} has exited — the termination attempt did not need to act (exit was not caused by it)`);
      }
      if (exited === null) {
        state.postVerifyResult = 'unavailable';
        if (terminated) state.terminationResult = 'unknown';
        return finish('VERIFICATION_UNAVAILABLE', 'post-termination verification unavailable — termination attempted but outcome uncertain (never reported as success)');
      }
      state.postVerifyResult = 'still_running';
      return finish('ACCESS_DENIED', 'pinned instance still running after termination attempt — access denied or termination failed');
    } finally {
      try { pin.release(); } catch { /* never mask the primary result */ }
    }
  }

  /**
   * Resolve the independent approval-authority decision (Phase D.4,
   * credential-backed in the Phase D completion). Normalized to a tagged
   * decision so every site narrows exactly; the authority result is never
   * treated as authorization unless it explicitly says so. Infrastructure
   * failures normalize to 'unavailable' (fail-closed).
   */
  private async resolveAuthority(input: { pid: number; operatorCredential?: string; authorityEpoch?: number }): Promise<
    | { kind: 'authorized'; authorityId: string; method: string; authorityEpoch?: number }
    | { kind: 'unavailable'; reason: string }
    | { kind: 'denied'; reason: string }
  > {
    let result: ApprovalAuthorityResult;
    try {
      result = await this.deps.verifyApprovalAuthority(input);
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: `approval authority check failed (${String((err as Error)?.message || err)}) — authorization unavailable; containment refused (fail-closed)`,
      };
    }
    if (result.authorized === true) {
      return { kind: 'authorized', authorityId: result.authorityId, method: result.method, authorityEpoch: result.authorityEpoch };
    }
    return result.unavailable
      ? { kind: 'unavailable', reason: result.reason }
      : { kind: 'denied', reason: result.reason };
  }

  /** Registry pre-check WITHOUT consuming: unknown/used/expired → refusal. */
  private precheckApprovalToken(tokenStr: string): { outcome: ContainmentOutcome; reason: string } | null {
    const entry = this.pending.get(tokenStr);
    if (!entry || entry.used) {
      if (entry) this.pending.delete(tokenStr);
      return { outcome: 'REFUSED_APPROVAL_INVALID', reason: 'approval token not found, already consumed, or not server-issued (single-use registry)' };
    }
    if (Date.now() > entry.expiresAt) {
      this.pending.delete(tokenStr);
      return { outcome: 'REFUSED_APPROVAL_INVALID', reason: 'approval token expired (5-minute TTL)' };
    }
    return null;
  }

  /** Validate the token binding against the PINNED identity; consume on
   *  success and return the token's authority epoch (for the pre-termination
   *  staleness re-check). */
  private validateTokenBinding(tokenStr: string, pin: PinnedProcess): { ok: true; authorityEpoch?: number } | { ok: false; outcome: ContainmentOutcome; reason: string } {
    const entry = this.pending.get(tokenStr);
    if (!entry || entry.used) {
      if (entry) this.pending.delete(tokenStr);
      return { ok: false, outcome: 'REFUSED_APPROVAL_INVALID', reason: 'approval token not found, already consumed, or expired (single-use enforcement)' };
    }
    if (Date.now() > entry.expiresAt) {
      this.pending.delete(tokenStr);
      return { ok: false, outcome: 'REFUSED_APPROVAL_INVALID', reason: 'approval token expired (5-minute TTL)' };
    }
    if (entry.pid !== pin.pid) {
      this.pending.delete(tokenStr);
      return { ok: false, outcome: 'REFUSED_APPROVAL_INVALID', reason: 'approval token is bound to a different PID' };
    }
    if (entry.creationTime !== pin.creationTime) {
      this.pending.delete(tokenStr);
      return { ok: false, outcome: 'REFUSED_PID_REUSED',
        reason: 'pinned instance creation time differs from the approved instance — PID was reused or the approved instance exited; refusing to terminate a different process' };
    }
    if (entry.executablePath.toLowerCase() !== pin.executablePath.toLowerCase()) {
      this.pending.delete(tokenStr);
      return { ok: false, outcome: 'REFUSED_IDENTITY_CHANGED', reason: 'pinned instance executable path differs from the approved identity' };
    }
    if (entry.name.toLowerCase() !== pin.name.toLowerCase()) {
      this.pending.delete(tokenStr);
      return { ok: false, outcome: 'REFUSED_IDENTITY_CHANGED', reason: 'pinned instance process name differs from the approved identity' };
    }
    // Valid: consume the token (single-use) and proceed.
    this.pending.delete(tokenStr);
    entry.used = true;
    return { ok: true, authorityEpoch: entry.authorityEpoch };
  }

  private emitAudit(requestId: string, outcome: ContainmentOutcome, reason: string, state: {
    targetPid: number; targetName: string; targetCreationTime: string;
    classification: ContainmentClassification; confidence: string; evidenceSources: string[];
    evidenceAgeMs: number; estopActive: boolean; authorized: boolean;
    terminationEligible: boolean; terminationAttempted: boolean;
    terminationResult: 'not_attempted' | 'succeeded' | 'failed' | 'unknown';
    postVerifyResult: 'not_performed' | 'exited' | 'still_running' | 'unavailable';
    approvalAuthority: string;
    hasApprovalToken: boolean;
  }): void {
    const event: ContainmentAuditEvent = {
      kind: 'threat_containment',
      requestId,
      outcome,
      reason,
      targetPid: state.targetPid,
      targetName: state.targetName,
      targetCreationTime: state.targetCreationTime,
      classification: state.classification,
      confidence: state.confidence,
      evidenceSources: state.evidenceSources,
      evidenceAgeMs: state.evidenceAgeMs,
      estopActive: state.estopActive,
      authorized: state.authorized,
      terminationEligible: state.terminationEligible,
      terminationAttempted: state.terminationAttempted,
      terminationResult: state.terminationResult,
      postVerifyResult: state.postVerifyResult,
      approvalAuthority: state.approvalAuthority,
      hasApprovalToken: state.hasApprovalToken,
      at: Date.now(),
    };
    try {
      this.deps.audit(event);
    } catch {
      /* audit failure must not break containment reporting */
    }
  }
}
