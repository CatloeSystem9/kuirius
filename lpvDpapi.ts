/**
 * LPV — Dedicated Windows DPAPI bridge (Local Private Vault).
 *
 * A self-contained bridge to Windows DPAPI (CryptProtectData /
 * CryptUnprotectData via .NET's System.Security.Cryptography.ProtectedData)
 * for the Local Private Vault ONLY. It deliberately owns a SEPARATE
 * PowerShell process from the mouse/keyboard automation worker in server.ts:
 * the two subsystems share no process, no queue and no protocol, so a
 * problem in automation cannot touch vault key material and vice versa.
 *
 * Protocol (line-based, mirrors the house PowerShell-worker pattern):
 *   request  → one script line: inline handler with the request embedded as a
 *              single-quoted PowerShell string (payloads are base64 — no
 *              quote characters), followed by `REQDONE <seq>`.
 *   response → `LPV <json>` line captured until the REQDONE marker.
 *
 * Security properties:
 *   - Secrets NEVER travel in command-line arguments (visible to same-user
 *     processes via the process list): the persistent worker and the one-shot
 *     fallback BOTH pass data through stdin pipes, never argv/env.
 *   - No logging of payloads; errors carry reason kinds only.
 *   - Operations are serialized; the queue is bounded; a hung worker is
 *     killed and respawned; DPAPI failures surface as typed errors.
 *
 * Operations:
 *   identity   → current Windows account SID (account binding check)
 *   protect    → base64 plaintext  → base64 DPAPI blob (CurrentUser scope)
 *   unprotect  → base64 DPAPI blob → base64 plaintext (CurrentUser scope)
 *
 * Honest limits (do not weaken these disclosures):
 *   - DPAPI CurrentUser scope binds blobs to the Windows account on this
 *     machine; a same-user process can call the same API. The boundary is
 *     the same documented same-user trust boundary as the E5 store.
 *   - A plain JS string copy of a secret cannot be force-zeroed (GC owns
 *     it); callers pass Buffers and zero what they own.
 */
import { spawn as _spawn } from "child_process";

const DPAPI_PS_TIMEOUT_MS = 20_000;
const DPAPI_QUEUE_LIMIT = 8;
const WORKER_STDIN_LIMIT = 64 * 1024; // payloads here are tiny (32-byte keys); hard cap anyway

const DPAPI_PRELUDE =
  `if (-not ([System.Management.Automation.PSTypeName]'L.DP').Type) { Add-Type -AssemblyName System.Security }; `;

/** Per-request script. `reqJson` must be single-quote-safe (it is: base64 +
 *  fixed op names); `seq` is a positive integer.
 *  Audit hardening: .NET byte arrays that hold plaintext key material are
 *  deterministically cleared ([Array]::Clear) after the base64 conversion —
 *  unlike JS strings, these CAN be erased. The base64 STRING copies remain
 *  GC-owned (disclosed limitation). */
function dpapiRequestScript(seq: number, reqJson: string): string {
  const safe = reqJson.replace(/'/g, "''");
  return (
    DPAPI_PRELUDE +
    `try { ` +
    `$req = '${safe}' | ConvertFrom-Json; ` +
    `$out = $null; ` +
    `if ($req.op -eq 'identity') { ` +
    `$out = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ` +
    `} elseif ($req.op -eq 'protect') { ` +
    `$plain = [Convert]::FromBase64String($req.b64); ` +
    `$blob = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `$out = [Convert]::ToBase64String($blob); ` +
    `[Array]::Clear($plain, 0, $plain.Length); $plain = $null; ` +
    `} elseif ($req.op -eq 'unprotect') { ` +
    `$blob = [Convert]::FromBase64String($req.b64); ` +
    `$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `$out = [Convert]::ToBase64String($plain); ` +
    `[Array]::Clear($plain, 0, $plain.Length); $plain = $null; ` +
    `[Array]::Clear($blob, 0, $blob.Length); $blob = $null; ` +
    `} else { throw 'unknown_op' } ` +
    `Write-Output ('LPV ' + (ConvertTo-Json -Compress -InputObject @{ ok = $true; value = $out })) ` +
    `} catch { ` +
    `$m = $_.Exception.Message; if ($m.Length -gt 160) { $m = $m.Substring(0,160) }; ` +
    `Write-Output ('LPV ' + (ConvertTo-Json -Compress -InputObject @{ ok = $false; error = $m })) ` +
    `}; ` +
    `Write-Output 'REQDONE ${seq}'`
  );
}

interface DpapiOk {
  ok: true;
  value: string;
}
interface DpapiErr {
  ok: false;
  error: string;
}
type DpapiResult = DpapiOk | DpapiErr;

function parseLpvLine(line: string): DpapiResult | null {
  if (!line.startsWith("LPV ")) return null;
  try {
    const parsed = JSON.parse(line.slice(4)) as { ok?: unknown; value?: unknown; error?: unknown };
    if (parsed.ok === true && typeof parsed.value === "string") return { ok: true, value: parsed.value };
    if (parsed.ok === false && typeof parsed.error === "string") return { ok: false, error: parsed.error };
    return { ok: false, error: "malformed_dpapi_response" };
  } catch {
    return { ok: false, error: "malformed_dpapi_response" };
  }
}

/**
 * Dedicated persistent PowerShell process for DPAPI operations. Same
 * line/REQDONE protocol as the automation worker, but a separate process
 * with its own queue — never shared with mouse/keyboard automation.
 */
class LpvDpapiWorker {
  private proc: ReturnType<typeof _spawn> | null = null;
  private buffer = "";
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: { id: number; resolve: (r: DpapiResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private pendingCount = 0;
  private result: DpapiResult | null = null;

  private ensureProcess(): void {
    if (this.proc && this.proc.stdin && !this.proc.killed) return;
    this.buffer = "";
    this.result = null;
    this.proc = _spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(String(d)));
    this.proc.stderr!.on("data", () => {
      /* stderr noise ignored — results come on stdout only */
    });
    this.proc.on("exit", () => {
      this.proc = null;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        const p = this.pending;
        this.pending = null;
        p.reject(new Error("DPAPI worker exited"));
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (!this.pending) return;
    const marker = `REQDONE ${this.pending.id}`;
    const idx = this.buffer.indexOf(marker);
    if (idx < 0) return;
    const captured = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + marker.length);
    // The LAST LPV line before the marker is the result of this request.
    let found: DpapiResult | null = null;
    for (const line of captured.split(/\r?\n/)) {
      const parsed = parseLpvLine(line);
      if (parsed) found = parsed;
    }
    const p = this.pending;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(found ?? { ok: false, error: "dpapi_no_result" });
  }

  kill(): void {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }

  /** Serialize requests; overflow is REJECTED, never silently queued. */
  run(op: "identity" | "protect" | "unprotect", b64?: string): Promise<DpapiResult> {
    if (this.pendingCount >= DPAPI_QUEUE_LIMIT) {
      return Promise.reject(new Error("DPAPI worker queue full"));
    }
    const reqJson = JSON.stringify(b64 === undefined ? { op } : { op, b64 });
    if (reqJson.length > WORKER_STDIN_LIMIT) {
      return Promise.reject(new Error("DPAPI request too large"));
    }
    this.pendingCount += 1;
    const task = this.queue
      .then(() => this.runNow(reqJson))
      .finally(() => {
        this.pendingCount -= 1;
      });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private runNow(reqJson: string): Promise<DpapiResult> {
    this.ensureProcess();
    const id = ++this.seq;
    return new Promise<DpapiResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.kill(); // stuck — the next call respawns a fresh worker
        reject(new Error("DPAPI worker timed out"));
      }, DPAPI_PS_TIMEOUT_MS);
      this.pending = { id, resolve, reject, timer };
      this.proc!.stdin!.write(`${dpapiRequestScript(id, reqJson)}\n`);
    });
  }
}

const dpapiWorker = new LpvDpapiWorker();

/** One-shot fallback: the request goes through STDIN (never argv), so
 *  secrets do not appear in the process command line. Used only when the
 *  persistent worker is unavailable. */
async function runDpapiOneShot(op: "identity" | "protect" | "unprotect", b64?: string): Promise<DpapiResult> {
  const reqJson = JSON.stringify(b64 === undefined ? { op } : { op, b64 });
  const script = dpapiRequestScript(1, reqJson);
  return new Promise<DpapiResult>((resolve, reject) => {
    const proc = _spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      reject(new Error("DPAPI one-shot timed out"));
    }, DPAPI_PS_TIMEOUT_MS);
    proc.stdout!.on("data", (d: Buffer) => {
      stdout += String(d);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      let found: DpapiResult | null = null;
      for (const line of stdout.split(/\r?\n/)) {
        const parsed = parseLpvLine(line);
        if (parsed) found = parsed;
      }
      if (found) resolve(found);
      else reject(new Error("DPAPI one-shot produced no result"));
    });
    proc.stdin!.write(`${script}\n`);
    proc.stdin!.end();
  });
}

async function invoke(op: "identity" | "protect" | "unprotect", b64?: string): Promise<DpapiResult> {
  try {
    return await dpapiWorker.run(op, b64);
  } catch (err) {
    // Persistent-worker path failed structurally (queue full / dead process /
    // timeout) — one-shot via stdin keeps DPAPI available without argv leaks.
    void err;
    return runDpapiOneShot(op, b64);
  }
}

/** Current Windows account SID (used for the vault's account binding). */
export async function dpapiCurrentSid(): Promise<string> {
  const r = await invoke("identity");
  if (r.ok === false) throw new Error(`DPAPI identity check failed: ${r.error}`);
  return r.value;
}

/** DPAPI-protect bytes (CurrentUser scope). Returns the protected blob. */
export async function dpapiProtect(plain: Buffer): Promise<Buffer> {
  const r = await invoke("protect", plain.toString("base64"));
  if (r.ok === false) throw new Error(`DPAPI protect failed: ${r.error}`);
  return Buffer.from(r.value, "base64");
}

/** DPAPI-unprotect a blob (CurrentUser scope). Throws on tamper/account
 *  mismatch — callers treat that as fail-closed. */
export async function dpapiUnprotect(blob: Buffer): Promise<Buffer> {
  const r = await invoke("unprotect", blob.toString("base64"));
  if (r.ok === false) throw new Error(`DPAPI unprotect failed: ${r.error}`);
  return Buffer.from(r.value, "base64");
}

/** Probe: DPAPI usable on this machine? (identity round-trip is cheap.) */
export async function dpapiAvailable(): Promise<boolean> {
  try {
    await dpapiCurrentSid();
    return true;
  } catch {
    return false;
  }
}

/** Test hook: kill the dedicated worker process (never used in normal flow). */
export function _dpapiKillWorker(): void {
  dpapiWorker.kill();
}
