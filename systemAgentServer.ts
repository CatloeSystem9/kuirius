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

// ------------------------------------------------------------- path safety

function allowedRoots(): string[] {
  const env = process.env.KRISHA_FS_ROOTS;
  const roots = env
    ? env.split(';')
    : [os.homedir(), os.tmpdir(), process.cwd()];
  return roots.map((r) => path.resolve(r.trim())).filter(Boolean);
}

const SYSTEM_WRITE_DENYLIST = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];

export function resolveSafePath(rawPath: string, operation: 'read' | 'write'): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error('Path is required');
  }
  if (/[<>|?*\x00-\x1F]/.test(rawPath)) {
    throw new Error(`Path contains invalid characters: "${rawPath.slice(0, 60)}"`);
  }
  // Relative paths (no drive letter) resolve against the TEMP directory —
  // never against the project directory, so unqualified creates are safe.
  const trimmed = rawPath.trim();
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
  const resolved = path.resolve(isAbsolute ? trimmed : path.join(os.tmpdir(), trimmed));
  const normalized = resolved.toLowerCase().replace(/[\\/]+$/, '');

  const inRoot = allowedRoots().some((root) => {
    const r = root.toLowerCase().replace(/[\\/]+$/, '');
    return normalized === r || normalized.startsWith(r + '\\') || normalized.startsWith(r + '/');
  });
  if (!inRoot) {
    throw new Error(`Path "${resolved}" is outside the allowed filesystem roots — traversal rejected`);
  }

  if (operation === 'write') {
    const denied = SYSTEM_WRITE_DENYLIST.some((dir) => normalized.startsWith(dir.toLowerCase()));
    if (denied) {
      throw new Error(`Writing to a protected system location is not allowed: ${resolved}`);
    }
  }
  return resolved;
}

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

export async function fsReadFile(filePath: string, offset = 0): Promise<{ path: string; content: string; truncated: boolean; size: number; offset: number }> {
  const fullPath = resolveSafePath(filePath, 'read');
  if (!isTextPath(fullPath)) throw new Error(`"${path.basename(fullPath)}" is not a recognized text file — binary formats are not read`);
  const st = await fsp.stat(fullPath);
  if (st.isDirectory()) throw new Error('Path is a directory, not a file');
  const start = Math.max(0, Math.min(offset, st.size));
  const handle = await fsp.open(fullPath, 'r');
  try {
    const length = Math.min(READ_MAX_BYTES, Math.max(0, st.size - start));
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    // Binary sniff: reject chunks with suspicious NUL density.
    if (buffer.subarray(0, 1024).includes(0)) throw new Error('File appears to be binary');
    return {
      path: fullPath,
      content: buffer.toString('utf8'),
      truncated: start + length < st.size,
      size: st.size,
      offset: start,
    };
  } finally {
    await handle.close();
  }
}

export async function fsCreate(targetPath: string, type: 'file' | 'dir', content?: string): Promise<FsEntry> {
  const fullPath = resolveSafePath(targetPath, 'write');
  const exists = fs.existsSync(fullPath);
  if (exists) throw new Error(`"${fullPath}" already exists — refusing to overwrite`);
  if (type === 'dir') {
    await fsp.mkdir(fullPath);
  } else {
    await fsp.writeFile(fullPath, typeof content === 'string' ? content : '', { flag: 'wx' });
  }
  return statEntry(fullPath);
}

export async function fsRename(fromPath: string, newName: string): Promise<FsEntry> {
  if (!newName || /[\\/:*?"<>|]/.test(newName)) throw new Error(`Invalid new name "${newName.slice(0, 40)}"`);
  const from = resolveSafePath(fromPath, 'write');
  const to = resolveSafePath(path.join(path.dirname(from), newName), 'write');
  if (!fs.existsSync(from)) throw new Error(`Source "${from}" does not exist`);
  if (fs.existsSync(to)) throw new Error(`Destination "${to}" already exists`);
  await fsp.rename(from, to);
  return statEntry(to);
}

async function copyOrMove(fromPath: string, toPath: string, mode: 'copy' | 'move', overwrite: boolean): Promise<FsEntry> {
  const from = resolveSafePath(fromPath, 'read');
  let to = resolveSafePath(toPath, 'write');
  if (!fs.existsSync(from)) throw new Error(`Source "${from}" does not exist`);
  const fromStat = await fsp.stat(from);
  // If the destination is an existing directory, move into it.
  if (fs.existsSync(to) && (await fsp.stat(to)).isDirectory()) {
    to = path.join(to, path.basename(from));
  }
  if (fs.existsSync(to) && !overwrite) {
    throw new Error(`Destination "${to}" already exists — set overwrite to replace it`);
  }
  if (fromStat.isDirectory() && mode === 'copy') {
    await fsp.cp(from, to, { recursive: true, force: overwrite, errorOnExist: !overwrite });
  } else if (mode === 'copy') {
    await fsp.copyFile(from, to);
  } else {
    await fsp.rename(from, to);
  }
  return statEntry(to);
}

export async function fsCopy(fromPath: string, toPath: string, overwrite = false): Promise<FsEntry> {
  return copyOrMove(fromPath, toPath, 'copy', overwrite);
}

export async function fsMove(fromPath: string, toPath: string, overwrite = false): Promise<FsEntry> {
  return copyOrMove(fromPath, toPath, 'move', overwrite);
}

export async function fsDelete(targetPath: string, recursive = false): Promise<{ path: string; deleted: true }> {
  const fullPath = resolveSafePath(targetPath, 'write');
  if (!fs.existsSync(fullPath)) throw new Error(`"${fullPath}" does not exist`);
  const st = await fsp.stat(fullPath);
  if (st.isDirectory()) {
    const remaining = await fsp.readdir(fullPath);
    if (remaining.length > 0 && !recursive) {
      throw new Error(`Directory "${fullPath}" is not empty — recursive deletion is required but must be explicitly requested`);
    }
    await fsp.rm(fullPath, { recursive });
  } else {
    await fsp.unlink(fullPath);
  }
  return { path: fullPath, deleted: true };
}

/** Open a file with its OS-associated application via ShellExecute. */
export async function fsOpenWithAssociation(filePath: string): Promise<string> {
  const fullPath = resolveSafePath(filePath, 'read');
  if (!fs.existsSync(fullPath)) throw new Error(`"${fullPath}" does not exist`);
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

/** Launch by discovered-app name (allowlist) — never an arbitrary command string. */
export async function appLaunchByName(name: string): Promise<{ launched: string; target: string }> {
  const apps = await appDiscover();
  const match =
    apps.find((a) => a.name.toLowerCase() === name.toLowerCase()) ??
    apps.find((a) => a.name.toLowerCase().startsWith(name.toLowerCase()));
  if (!match) throw new Error(`No discovered application matches "${name.slice(0, 40)}"`);
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

/** Launch a validated executable path from inside the allowed roots. */
export async function appLaunchByPath(executablePath: string): Promise<{ launched: string; target: string }> {
  const full = resolveSafePath(executablePath, 'read');
  if (!full.toLowerCase().endsWith('.exe')) throw new Error('Only .exe files can be launched by path');
  if (!fs.existsSync(full)) throw new Error(`"${full}" does not exist`);
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
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate(${pid}) | Out-Null`],
      { timeout: 15000, windowsHide: true }
    );
    return { focused: true, pid };
  } catch {
    return { focused: false, pid };
  }
}
