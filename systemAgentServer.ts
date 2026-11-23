/**
 * Filesystem + Application agent core (Phase 9, server-side).
 *
 * Real-disk operations via Node fs built-ins with strict path safety:
 * every path is resolved and must land inside an allowed root (homedir /
 * tempdir / project dir by default); mutating operations are additionally
 * denied inside Windows system locations. All operations are bounded and
 * evidence-verified. Application discovery/launch/status/close/focus runs
 * through the persistent PowerShell worker — no arbitrary shell execution
 * from tool parameters.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
// E5 M1: path-safety authority moved to serverSafety.ts (hardened resolution
// + protected-storage refusal). Re-exported for compatibility.
import { resolveSafePath, allowedRoots, assertNotProtected, isProtectedPath, OPEN_FILE_EXTENSIONS } from './serverSafety';
// E5 M2: all sandbox-managed MUTATIONS flow through sandboxCore (identity
// revalidation, parent-directory validation, E4 safe staging, in-process
// stop/permission gate). Reads keep the M1 path guards; bounded file reads
// gain identity verification.
import {
  sandboxCreateFile, sandboxCreateDir, sandboxRename, sandboxCopy, sandboxMove, sandboxDelete,
  readVerifiedFile,
} from './sandboxCore';
// E5 M3: deletions capture into E7 quarantine (retention until a valid
// release decision) via the injected hook — keeps sandboxCore free of the
// quarantine dependency while every real delete retains its data.
import { captureNode as quarantineCaptureNode } from './quarantineCore';

export { resolveSafePath, allowedRoots };

// ------------------------------------------------------------- path safety
// (resolution rules live in serverSafety.ts — hardened in E5 M1)

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb',
  'php', 'sh', 'bat', 'ps1', 'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'gitignore',
]);

export function isTextPath(p: string): boolean {
  const ext = path.extname(p).slice(1).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || path.basename(p).toLowerCase().startsWith('.');
}

export interface FsEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: number;
}

async function statEntry(fullPath: string): Promise<FsEntry> {
  const st = await fsp.stat(fullPath);
  return {
    name: path.basename(fullPath),
    path: fullPath,
    kind: st.isDirectory() ? 'directory' : 'file',
    size: st.size,
    modifiedAt: st.mtimeMs,
  };
}

// ---------------------------------------------------------------- operations

export async function fsList(dirPath: string): Promise<{ path: string; entries: FsEntry[]; truncated: boolean }> {
  const fullPath = resolveSafePath(dirPath, 'read');
  const st = await fsp.stat(fullPath);
  if (!st.isDirectory()) throw new Error(`"${fullPath}" is not a directory`);
  const names = await fsp.readdir(fullPath);
  const entries: FsEntry[] = [];
  for (const name of names.slice(0, 200)) {
    try {
      entries.push(await statEntry(path.join(fullPath, name)));
    } catch {
      // unreadable entry — skip, do not fail the listing
    }
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
  return { path: fullPath, entries, truncated: names.length > 200 };
}

export async function fsInspect(targetPath: string): Promise<FsEntry & { isText: boolean }> {
  const fullPath = resolveSafePath(targetPath, 'read');
  const entry = await statEntry(fullPath);
  return { ...entry, isText: entry.kind === 'file' ? isTextPath(fullPath) : false };
}

export async function fsSearch(rootPath: string, query: string, maxDepth = 4): Promise<{ root: string; matches: FsEntry[]; scanned: number; truncated: boolean }> {
  const root = resolveSafePath(rootPath, 'read');
  const q = query.trim().toLowerCase();
  if (!q) throw new Error('Search query is required');
  const matches: FsEntry[] = [];
  let scanned = 0;
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > maxDepth || matches.length >= 50) return;
    if (isProtectedPath(dir)) return; // E5: never enumerate protected storage
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      scanned++;
      if (scanned > 2000) {
        truncated = true;
        return;
      }
      const full = path.join(dir, name);
      if (name.toLowerCase().includes(q)) {
        try {
          matches.push(await statEntry(full));
        } catch { /* skip */ }
        if (matches.length >= 50) {
          truncated = true;
          return;
        }
      }
      if (depth < maxDepth) {
        try {
          if ((await fsp.stat(full)).isDirectory() && !['node_modules', '.git'].includes(name)) {
            await walk(full, depth + 1);
          }
        } catch { /* skip */ }
      }
    }
  };

  await walk(root, 0);
  return { root, matches, scanned, truncated };
}

const READ_MAX_BYTES = 64 * 1024;

export async function fsReadFile(filePath: string, offset = 0): Promise<{ path: string; content: string; truncated: boolean; size: number; offset: number; identityVerified: boolean }> {
  const fullPath = resolveSafePath(filePath, 'read');
  assertNotProtected(fullPath, 'read');
  if (!isTextPath(fullPath)) throw new Error(`"${path.basename(fullPath)}" is not a recognized text file — binary formats are not read`);
  const st = await fsp.stat(fullPath);
  if (st.isDirectory()) throw new Error('Path is a directory, not a file');
  const start = Math.max(0, Math.min(offset, st.size));
  const handle = await fsp.open(fullPath, 'r');
  try {
    const length = Math.min(READ_MAX_BYTES, Math.max(0, st.size - start));
    // E5 M2 — identity-verified read: the node must present the same
    // filesystem identity before and after the read for the content to be
    // reported as verified. Additive field; content behavior unchanged.
    const { content: buffer, verified } = readVerifiedFile(fullPath, () => {
      const b = Buffer.alloc(length);
      if (length > 0) {
        // readSync on the open handle keeps the read inside this sync block
        const bytesRead = fs.readSync(handle.fd, b, 0, length, start);
        if (bytesRead !== length) throw new Error('short read');
      }
      return b;
    });
    // Binary sniff: reject chunks with suspicious NUL density.
    if (buffer.subarray(0, 1024).includes(0)) throw new Error('File appears to be binary');
    return {
      path: fullPath,
      content: buffer.toString('utf8'),
      truncated: start + length < st.size,
      size: st.size,
      offset: start,
      identityVerified: verified,
    };
  } finally {
    await handle.close();
  }
}

export async function fsCreate(targetPath: string, type: 'file' | 'dir', content?: string): Promise<FsEntry> {
  // E5 M2 — staged create (journal-first, O_EXCL staging, identity-verified
  // commit) through the sandbox core.
  return type === 'dir'
    ? sandboxCreateDir(targetPath)
    : sandboxCreateFile(targetPath, typeof content === 'string' ? content : '');
}

export async function fsRename(fromPath: string, newName: string): Promise<FsEntry> {
  // E5 M2 — identity-revalidated rename with parent-directory validation.
  return sandboxRename(fromPath, newName);
}

export async function fsCopy(fromPath: string, toPath: string, overwrite = false): Promise<FsEntry> {
  // E5 M2 — two-agreeing-reads copy through verified staging.
  return sandboxCopy(fromPath, toPath, overwrite);
}

export async function fsMove(fromPath: string, toPath: string, overwrite = false): Promise<FsEntry> {
  // E5 M2 — identity-revalidated move (same-volume rename).
  return sandboxMove(fromPath, toPath, overwrite);
}

export async function fsDelete(targetPath: string, recursive = false): Promise<{ path: string; deleted: true; replacedAfterDelete?: boolean; quarantined?: boolean; quarantineId?: string; opId: string }> {
  // E5 M2 — identity-revalidated delete; E5 M3 (E7) — content is captured
  // into quarantine so a later validated rollback/release remains possible.
  return sandboxDelete(targetPath, recursive, quarantineCaptureNode);
}

/** Open a file with its OS-associated application via ShellExecute. */
export async function fsOpenWithAssociation(filePath: string): Promise<string> {
  const fullPath = resolveSafePath(filePath, 'read');
  assertNotProtected(fullPath, 'read');
  if (!fs.existsSync(fullPath)) throw new Error(`"${fullPath}" does not exist`);
  // E5 M1d — file-association execution policy (decision D8): allowlist-only.
  // Scripts, executables, interpreters, and unknown types are refused
  // UNCONDITIONALLY — no confirmation path overrides this refusal, because
  // `cmd start` executes whatever the (potentially hijacked) association
  // binds. A hijacked association for an allowlisted type is an
  // environmental residual (machine-compromise class). Text content can be
  // inspected safely through the bounded /api/fs/read preview instead.
  const ext = path.extname(fullPath).slice(1).toLowerCase();
  if (!OPEN_FILE_EXTENSIONS.has(ext)) {
    throw new Error(`Opening "${path.basename(fullPath)}" is not permitted — ".${ext || 'unknown'}" is not on the safe-open allowlist (use the text preview instead)`);
  }
  // Spawn detached via cmd start — validated path only, never arbitrary commands.
  const { spawn } = await import('child_process');
  const child = spawn('cmd.exe', ['/c', 'start', '', fullPath], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return fullPath;
}

// ------------------------------------------------------------- applications

export interface DiscoveredApp {
  name: string;
  source: 'start_menu' | 'path' | 'registry';
  target: string;
}

let discoveryCache: { apps: DiscoveredApp[]; at: number } | null = null;
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

/** Discover apps from Start Menu shortcuts + PATH — bounded and cached. */
export async function appDiscover(force = false): Promise<DiscoveredApp[]> {
  if (!force && discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.apps;
  }
  const apps: DiscoveredApp[] = [];
  const seen = new Set<string>();

  const home = os.homedir();
  const startMenuDirs = [
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
    path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const collectLinks = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || apps.length >= 120) return;
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        if (st.isDirectory()) {
          await collectLinks(full, depth + 1);
        } else if (name.toLowerCase().endsWith('.lnk') && apps.length < 120) {
          const appName = name.replace(/\.lnk$/i, '').trim();
          const key = appName.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            apps.push({ name: appName, source: 'start_menu', target: full });
          }
        }
      } catch { /* skip */ }
    }
  };
  for (const dir of startMenuDirs) {
    await collectLinks(dir, 0);
  }

  // PATH executables (bounded to a few common directories).
  const pathDirs = (process.env.PATH || '').split(';').filter(Boolean).slice(0, 12);
  for (const dir of pathDirs) {
    try {
      const names = await fsp.readdir(dir);
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.exe') || apps.length >= 150) continue;
        const appName = name.replace(/\.exe$/i, '');
        const key = appName.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          apps.push({ name: appName, source: 'path', target: path.join(dir, name) });
        }
      }
    } catch { /* skip */ }
  }

  discoveryCache = { apps, at: Date.now() };
  return apps;
}

export function appSearch(apps: DiscoveredApp[], query: string): DiscoveredApp[] {
  const q = query.trim().toLowerCase();
  if (!q) return apps.slice(0, 30);
  return apps.filter((a) => a.name.toLowerCase().includes(q)).slice(0, 30);
}

/** Launch by discovered-app name (allowlist) — never an arbitrary command string.
 *  Phase C: the execution gate decides BEFORE spawn (confirmed malware is
 *  non-overridably blocked; suspicious requires approval; unknown denied). */
export interface ExecGate {
  decide(input: { path: string; name?: string; approvalToken?: string }): Promise<{
    decision: 'ALLOW' | 'BLOCK_CONFIRMED_MALWARE' | 'REQUIRE_USER_APPROVAL' | 'DENY_UNVERIFIED' | 'BLOCK_SYSTEM_UNAVAILABLE';
    reason: string;
    classification?: string;
  }>;
  issueApproval(path: string, identity: { path: string; mtimeMs: number; size: number }, classification: string): { token: string } | null;
}

let execGate: ExecGate | null = null;
export function setExecGate(gate: ExecGate | null): void { execGate = gate; }

export async function appLaunchByName(name: string, approvalToken?: string): Promise<{ launched: string; target: string }> {
  const apps = await appDiscover();
  const match =
    apps.find((a) => a.name.toLowerCase() === name.toLowerCase()) ??
    apps.find((a) => a.name.toLowerCase().startsWith(name.toLowerCase()));
  if (!match) throw new Error(`No discovered application matches "${name.slice(0, 40)}"`);
  // Phase C execution gate: single authoritative decision before spawn.
  if (execGate) {
    const decision = await execGate.decide({ path: match.target, name: match.name, approvalToken });
    if (decision.decision !== 'ALLOW') {
      const err = new Error(`Execution gate: ${decision.decision} — ${decision.reason}`);
      (err as any).execGateDecision = decision;
      throw err;
    }
  }
  const { spawn } = await import('child_process');
  if (match.source === 'start_menu') {
    // .lnk shortcuts resolve via ShellExecute through cmd start.
    const child = spawn('cmd.exe', ['/c', 'start', '', match.target], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } else {
    const child = spawn(match.target, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  return { launched: match.name, target: match.target };
}

/** Launch a validated executable path from inside the allowed roots.
 *  Phase C: the execution gate decides BEFORE spawn. */
export async function appLaunchByPath(executablePath: string, approvalToken?: string): Promise<{ launched: string; target: string }> {
  const full = resolveSafePath(executablePath, 'read');
  if (!full.toLowerCase().endsWith('.exe')) throw new Error('Only .exe files can be launched by path');
  if (!fs.existsSync(full)) throw new Error(`"${full}" does not exist`);
  // Phase C execution gate: single authoritative decision before spawn.
  if (execGate) {
    const decision = await execGate.decide({ path: full, approvalToken });
    if (decision.decision !== 'ALLOW') {
      const err = new Error(`Execution gate: ${decision.decision} — ${decision.reason}`);
      (err as any).execGateDecision = decision;
      throw err;
    }
  }
  const { spawn } = await import('child_process');
  const child = spawn(full, [], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { launched: path.basename(full, '.exe'), target: full };
}

export async function appStatus(processName: string): Promise<{ name: string; running: boolean; pids: number[] }> {
  const clean = processName.replace(/\.exe$/i, '').replace(/[^\w.\- ]/g, '').trim();
  if (!clean) throw new Error('Process name is required');
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Name '${clean.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty Id`],
      { timeout: 15000, windowsHide: true }
    );
    const pids = stdout.split(/\r?\n/).map((l) => parseInt(l.trim(), 10)).filter((n) => Number.isFinite(n));
    return { name: clean, running: pids.length > 0, pids };
  } catch {
    return { name: clean, running: false, pids: [] };
  }
}

export async function appClose(pid: number, force = false): Promise<{ closed: boolean; pid: number }> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Valid numeric PID required');
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const flag = force ? '/F' : '';
  const args = ['/PID', String(pid), flag].filter(Boolean);
  try {
    await execFileAsync('taskkill', args, { timeout: 15000, windowsHide: true });
    return { closed: true, pid };
  } catch {
    return { closed: false, pid };
  }
}

export async function appFocus(pid: number): Promise<{ focused: boolean; pid: number }> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Valid numeric PID required');
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  try {
    // Honest verification (spec §13): AppActivate's return value alone is not
    // evidence — report focused only when the foreground window's owning
    // process is the requested PID after the activation attempt.
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);' -Name FOC -Namespace W3; ` +
          `[void](New-Object -ComObject WScript.Shell).AppActivate(${pid}); Start-Sleep -Milliseconds 400; ` +
          `$h=[W3.FOC]::GetForegroundWindow(); $fgPid=[uint32]0; [void][W3.FOC]::GetWindowThreadProcessId($h,[ref]$fgPid); ` +
          `Write-Output ("FGPID {0}" -f $fgPid)`,
      ],
      { timeout: 15000, windowsHide: true }
    );
    const m = stdout.match(/FGPID (\d+)/);
    const focused = m ? parseInt(m[1], 10) === pid : false;
    return { focused, pid };
  } catch {
    return { focused: false, pid };
  }
}
