/**
 * Deterministic fake filesystem + application backends for Phase 9 tests.
 * The fake FS is an in-memory tree with real verification semantics
 * (exists checks, rename/copy/move/delete post-conditions, traversal
 * rejection) so tests exercise the same contracts as the real server.
 */
import type { AppBackend, DiscoveredApp, FsBackend, FsEntry } from './systemTypes';

interface FakeNode {
  kind: 'file' | 'directory';
  content?: string;
  modifiedAt: number;
}

export class FakeFsBackend implements FsBackend {
  tree = new Map<string, FakeNode>();
  failNext = 0;
  traversalAttempts: string[] = [];
  private counter = 0;

  constructor() {
    this.tree.set('C:\\Users\\test', { kind: 'directory', modifiedAt: Date.now() });
    this.mkdirp('C:\\Users\\test\\Documents');
  }

  private mkdirp(dir: string): void {
    const parts = dir.split('\\');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}\\${part}` : part;
      if (!this.tree.has(current)) {
        this.tree.set(current, { kind: 'directory', modifiedAt: Date.now() });
      }
    }
  }

  private resolve(p: string): string {
    // Mimic the server: resolve and reject traversal outside roots.
    const clean = p.replace(/\/+/g, '\\');
    const parts = clean.split('\\');
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (stack.length > 0) stack.pop();
        continue;
      }
      stack.push(part);
    }
    return stack.join('\\');
  }

  private checkAllowed(op: 'read' | 'write', resolved: string): void {
    // Mirror the real server: ALL operations must stay inside the allowed
    // roots; writes are additionally denied in system locations.
    if (!resolved.toLowerCase().startsWith('c:\\users\\test')) {
      this.traversalAttempts.push(resolved);
      throw new Error('Path outside the allowed filesystem roots — traversal rejected');
    }
    if (op === 'write' && resolved.toLowerCase().startsWith('c:\\windows')) {
      throw new Error('Writing to a protected system location is not allowed');
    }
  }

  private requireParent(full: string): void {
    const parent = full.slice(0, full.lastIndexOf('\\'));
    if (parent && !this.tree.has(parent)) {
      throw new Error(`Parent directory "${parent}" does not exist`);
    }
  }

  private isTextPath(full: string): boolean {
    return !/\.(xlsx?|docx?|pdf|zip|rar|7z|exe|dll|png|jpe?g|gif|bmp|mp3|mp4|avi|bin|sqlite|db)$/i.test(full);
  }

  private entry(full: string): FsEntry {
    const node = this.tree.get(full)!;
    return { name: full.split('\\').pop()!, path: full, kind: node.kind, size: node.content?.length ?? 0, modifiedAt: node.modifiedAt };
  }

  private async guard(): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Transient filesystem failure');
    }
    this.counter++;
  }

  async list(dirPath: string) {
    await this.guard();
    try {
      const resolved = this.resolve(dirPath);
      this.checkAllowed('read', resolved);
      const node = this.tree.get(resolved);
      if (!node) return { success: false, error: `"${resolved}" does not exist` };
      if (node.kind !== 'directory') return { success: false, error: 'not a directory' };
      const entries: FsEntry[] = [];
      for (const [p, n] of this.tree) {
        if (p.startsWith(resolved + '\\') && p.slice(resolved.length + 1).split('\\').length === 1) {
          entries.push({ name: p.split('\\').pop()!, path: p, kind: n.kind, size: n.content?.length ?? 0, modifiedAt: n.modifiedAt });
        }
      }
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
      return { success: true, result: { path: resolved, entries, truncated: false } };
    } catch (err: any) {
      return { success: false, error: String(err.message) };
    }
  }

  async inspect(targetPath: string) {
    await this.guard();
    try {
      const resolved = this.resolve(targetPath);
      this.checkAllowed('read', resolved);
      const node = this.tree.get(resolved);
      if (!node) return { success: false, error: `"${resolved}" does not exist` };
      return { success: true, result: { ...this.entry(resolved), isText: node.kind === 'file' && this.isTextPath(resolved) } };
    } catch (err: any) {
      return { success: false, error: String(err.message) };
    }
  }

  async search(rootPath: string, query: string) {
    await this.guard();
    try {
      const resolved = this.resolve(rootPath);
      this.checkAllowed('read', resolved);
      const matches: FsEntry[] = [];
      for (const [p, n] of this.tree) {
        if (p.startsWith(resolved) && p.split('\\').pop()!.toLowerCase().includes(query.toLowerCase())) {
          matches.push({ name: p.split('\\').pop()!, path: p, kind: n.kind, size: n.content?.length ?? 0, modifiedAt: n.modifiedAt });
        }
      }
      return { success: true, result: { root: resolved, matches, scanned: this.tree.size, truncated: false } };
    } catch (err: any) {
      return { success: false, error: String(err.message) };
    }
  }

  async read(filePath: string) {
    await this.guard();
    try {
      const resolved = this.resolve(filePath);
      this.checkAllowed('read', resolved);
      const node = this.tree.get(resolved);
      if (!node) return { success: false, error: 'does not exist' };
      if (node.kind !== 'file') return { success: false, error: 'not a file' };
      if (node.content === undefined) return { success: false, error: 'binary file not readable as text' };
      return { success: true, result: { path: resolved, content: node.content, truncated: false, size: node.content.length, offset: 0 } };
    } catch (err: any) {
      return { success: false, error: String(err.message) };
    }
  }

  async create(targetPath: string, type: 'file' | 'dir', content?: string) {
    await this.guard();
    try {
      const resolved = this.resolve(targetPath);
      this.checkAllowed('write', resolved);
      if (this.tree.has(resolved)) return { success: false, error: 'already exists — refusing to overwrite' };
      this.tree.set(resolved, { kind: type === "dir" ? ("directory" as const) : ("file" as const), content: type === 'file' ? content ?? '' : undefined, modifiedAt: Date.now() });
      return { success: true, result: this.entry(resolved) };
    } catch (err: any) {
      return { success: false, error: String(err.message) };
    }
  }

  async rename(fromPath: string, newName: string) {
    await this.guard();
    try {
      if (/[\\/:*?"<>|]/.test(newName)) return { success: false, error: 'invalid name' };
      const from = this.resolve(fromPath);
      this.checkAllowed('write', from);
      const to = this.resolve(from.slice(0, from.lastIndexOf('\\') + 1) + newName);
      if (!this.tree.has(from)) return { success: false, error: 'source does not exist' };
      if (this.tree.has(to)) return { success: false, error: 'destination exists' };
      this.tree.set(to, this.tree.get(from)!);
      this.tree.delete(from);
      return { success: true, result: this.entry(to) };
    } catch (err: any) {
      return { success: false, error: String(err.message) };
    }
  }

  async copy(fromPath: string, toPath: string, overwrite?: boolean) {
    await this.guard();
    try {
      const from = this.resolve(fromPath);
      let to = this.resolve(toPath);
      this.checkAllowed('write', to);
      const node = this.tree.get(from);
      if (!node) return { success: false, error: 'source does not exist' };
      this.requireParent(to);
      if (this.tree.has(to) && this.tree.get(to)!.kind === 'directory') to = to + '\\' + from.split('\\').pop()!;
      if (this.tree.has(to) && !overwrite) return { success: false, error: 'destination exists' };
      this.tree.set(to, { ...node });
      return { success: true, result: this.entry(to) };
    } catch (err: any) {
      return { success: false, error: String(err.message) };
    }
  }

  async move(fromPath: string, toPath: string, overwrite?: boolean) {
    const copy = await this.copy(fromPath, toPath, overwrite);
    if (!copy.success) return copy;
    const from = this.resolve(fromPath);
    this.tree.delete(from);
    return copy;
  }

  async delete(targetPath: string, recursive?: boolean) {
    await this.guard();
    try {
      const resolved = this.resolve(targetPath);
      this.checkAllowed('write', resolved);
      const node = this.tree.get(resolved);
      if (!node) return { success: false, error: 'does not exist' };
      const hasChildren = [...this.tree.keys()].some((p) => p.startsWith(resolved + '\\'));
      if (hasChildren && !recursive) return { success: false, error: 'directory not empty — recursive required' };
      for (const p of [...this.tree.keys()]) {
        if (p === resolved || p.startsWith(resolved + '\\')) this.tree.delete(p);
      }
      return { success: true, result: { path: resolved, deleted: true as const } };
    } catch (err: any) {
      return { success: false, error: String(err.message) };
    }
  }

  async openFile(filePath: string) {
    await this.guard();
    try {
      const resolved = this.resolve(filePath);
      this.checkAllowed('read', resolved);
      if (!this.tree.has(resolved)) return { success: false, error: 'does not exist' };
      return { success: true, result: resolved };
    } catch (err: any) {
      return { success: false, error: String(err.message) };
    }
  }

  get operationCount(): number {
    return this.counter;
  }
}

export class FakeAppBackend implements AppBackend {
  apps: DiscoveredApp[] = [
    { name: 'Notepad', source: 'start_menu', target: 'C:\\Windows\\notepad.exe' },
    { name: 'Calculator', source: 'start_menu', target: 'C:\\Windows\\calc.exe' },
  ];
  processes = new Map<string, number[]>();
  failLaunch = false;
  launchCount = 0;

  async discover() {
    return { success: true, result: this.apps };
  }

  async launchByName(name: string) {
    this.launchCount++;
    if (this.failLaunch) return { success: false, error: 'launch failed' };
    const app = this.apps.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!app) return { success: false, error: `No discovered application matches "${name}"` };
    const pids = this.processes.get(app.name) ?? [];
    pids.push(1000 + pids.length + Math.floor(Math.random() * 90));
    this.processes.set(app.name, pids);
    return { success: true, result: { launched: app.name, target: app.target } };
  }

  async launchByPath(path: string) {
    this.launchCount++;
    if (!path.toLowerCase().endsWith('.exe')) return { success: false, error: 'only .exe can be launched' };
    const name = path.split('\\').pop()!.replace(/\.exe$/i, '');
    const pids = this.processes.get(name) ?? [];
    pids.push(2000 + pids.length);
    this.processes.set(name, pids);
    return { success: true, result: { launched: name, target: path } };
  }

  async status(name: string) {
    const clean = name.replace(/\.exe$/i, '');
    const pids = this.processes.get(clean) ?? [];
    return { success: true, result: { name: clean, running: pids.length > 0, pids } };
  }

  async close(pid: number) {
    for (const [name, pids] of this.processes) {
      const idx = pids.indexOf(pid);
      if (idx >= 0) {
        pids.splice(idx, 1);
        return { success: true, result: { closed: true, pid } };
      }
    }
    return { success: true, result: { closed: false, pid } };
  }

  async focus(pid: number) {
    const exists = [...this.processes.values()].some((pids) => pids.includes(pid));
    return { success: true, result: { focused: exists, pid } };
  }
}
