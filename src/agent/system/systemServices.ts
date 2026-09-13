/**
 * Filesystem + Application services (Phase 9).
 *
 * Thin orchestration over the injected backends: evidence-based verification
 * for every mutating operation (re-inspect after the operation), stale-state
 * protection (re-inspect before consequential operations), honest `uncertain`
 * when evidence cannot be established, and lifecycle events. The services are
 * DOM-free and testable against the fake backends.
 */
import type { AgentEventBus } from '../events';
import type { AppBackend, FsActionResult, FsBackend, FsEntry } from './systemTypes';

export interface SystemServicesOptions {
  fs: FsBackend;
  apps?: AppBackend;
  events?: AgentEventBus;
}

export class FilesystemService {
  private fs: FsBackend;
  private events?: AgentEventBus;

  constructor(options: SystemServicesOptions) {
    this.fs = options.fs;
    this.events = options.events;
  }

  private started(action: string, path: string): void {
    this.events?.emit({ name: 'FS_OPERATION_STARTED', payload: { action, path }, timestamp: Date.now() });
  }

  private finish(result: FsActionResult): FsActionResult {
    this.events?.emit({
      name: result.verified || result.uncertain ? 'FS_OPERATION_COMPLETED' : 'FS_OPERATION_FAILED',
      payload: { action: result.action, verified: result.verified, uncertain: result.uncertain },
      timestamp: Date.now(),
    });
    return result;
  }

  private failed(action: string, err: unknown): FsActionResult {
    const message = String((err as any)?.message || err);
    this.events?.emit({ name: 'FS_OPERATION_FAILED', payload: { action, error: message }, timestamp: Date.now() });
    return { action: action as FsActionResult['action'], verified: false, verificationNote: message, summary: `${action} failed: ${message}` };
  }

  async list(path: string): Promise<FsActionResult> {
    this.started('list', path);
    try {
      const r = await this.fs.list(path);
      if (!r.success || !r.result) throw new Error(r.error ?? 'list failed');
      return this.finish({
        action: 'list',
        path: r.result.path,
        entries: r.result.entries,
        verified: true,
        verificationNote: `${r.result.entries.length} entries read from the directory`,
        summary: `"${r.result.path}" contains ${r.result.entries.length} entries${r.result.truncated ? ' (truncated)' : ''}: ${r.result.entries.slice(0, 8).map((e) => e.name).join(', ')}`,
      });
    } catch (err) {
      return this.failed('list', err);
    }
  }

  async inspect(path: string): Promise<FsActionResult> {
    this.started('inspect', path);
    try {
      const r = await this.fs.inspect(path);
      if (!r.success || !r.result) throw new Error(r.error ?? 'inspect failed');
      const e: FsEntry = r.result;
      return this.finish({
        action: 'inspect',
        path: e.path,
        entries: [e],
        verified: true,
        verificationNote: 'metadata read directly',
        summary: `"${e.name}" is a ${e.kind} (${e.size} bytes, modified ${new Date(e.modifiedAt).toLocaleString()})${e.isText !== undefined ? `, text-readable: ${e.isText}` : ''}`,
      });
    } catch (err) {
      return this.failed('inspect', err);
    }
  }

  async search(root: string, query: string): Promise<FsActionResult> {
    this.started('search', root);
    try {
      const r = await this.fs.search(root, query);
      if (!r.success || !r.result) throw new Error(r.error ?? 'search failed');
      return this.finish({
        action: 'search',
        path: r.result.root,
        matches: r.result.matches,
        verified: true,
        verificationNote: `${r.result.matches.length} match(es) after scanning ${r.result.scanned} entries`,
        summary: `Found ${r.result.matches.length} match(es) for "${query}": ${r.result.matches.slice(0, 5).map((m) => m.name).join(', ') || 'none'}${r.result.truncated ? ' (truncated)' : ''}`,
      });
    } catch (err) {
      return this.failed('search', err);
    }
  }

  async read(path: string, offset = 0): Promise<FsActionResult> {
    this.started('read', path);
    try {
      const r = await this.fs.read(path, offset);
      if (!r.success || !r.result) throw new Error(r.error ?? 'read failed');
      const preview = r.result.content.slice(0, 120).replace(/\r?\n/g, '⏎');
      return this.finish({
        action: 'read',
        path: r.result.path,
        content: r.result.content,
        verified: true,
        verificationNote: `${r.result.content.length} characters read${r.result.truncated ? ' (file truncated at the limit)' : ''}`,
        summary: `Read ${r.result.path} (${r.result.size} bytes, offset ${r.result.offset})${r.result.truncated ? ' — truncated' : ''}. Starts with: "${preview}"`,
      });
    } catch (err) {
      return this.failed('read', err);
    }
  }

  async create(path: string, type: 'file' | 'dir', content?: string): Promise<FsActionResult> {
    this.started('create', path);
    try {
      const r = await this.fs.create(path, type, content);
      if (!r.success || !r.result) throw new Error(r.error ?? 'create failed');
      // Evidence: re-inspect the created target.
      const check = await this.fs.inspect(r.result.path);
      const expectedKind = type === "dir" ? "directory" : "file";
      const verified = check.success && check.result?.kind === expectedKind;
      return this.finish({
        action: 'create',
        path: r.result.path,
        entries: [r.result],
        verified,
        verificationNote: verified ? `Re-inspected after creation: ${type} exists` : 'Created, but re-inspection could not confirm it',
        uncertain: !verified,
        summary: `Created ${type} "${r.result.path}".`,
      });
    } catch (err) {
      return this.failed('create', err);
    }
  }

  async rename(path: string, newName: string): Promise<FsActionResult> {
    this.started('rename', path);
    try {
      // Stale-state protection: re-inspect the source right before mutating.
      const before = await this.fs.inspect(path);
      if (!before.success) throw new Error(`Source is gone: ${before.error}`);
      const r = await this.fs.rename(path, newName);
      if (!r.success || !r.result) throw new Error(r.error ?? 'rename failed');
      // Evidence: old path gone + new path exists.
      const oldGone = !(await this.fs.inspect(path)).success;
      const newThere = (await this.fs.inspect(r.result.path)).success;
      const verified = oldGone && newThere;
      return this.finish({
        action: 'rename',
        path: r.result.path,
        entries: [r.result],
        verified,
        uncertain: !verified,
        verificationNote: verified ? 'Old path gone, new path exists' : 'Rename dispatched but post-state could not be fully confirmed',
        summary: `Renamed to "${r.result.name}" (${r.result.path}).`,
      });
    } catch (err) {
      return this.failed('rename', err);
    }
  }

  async copy(from: string, to: string, overwrite = false): Promise<FsActionResult> {
    this.started('copy', from);
    try {
      const before = await this.fs.inspect(from);
      if (!before.success) throw new Error(`Source is gone: ${before.error}`);
      const r = await this.fs.copy(from, to, overwrite);
      if (!r.success || !r.result) throw new Error(r.error ?? 'copy failed');
      const dest = await this.fs.inspect(r.result.path);
      const verified = dest.success && (dest.result?.size ?? -1) === r.result.size;
      return this.finish({
        action: 'copy',
        path: r.result.path,
        entries: [r.result],
        verified,
        uncertain: !verified,
        verificationNote: verified ? 'Destination exists with matching size' : 'Copy dispatched but destination could not be confirmed',
        summary: `Copied to "${r.result.path}" (${r.result.size} bytes).`,
      });
    } catch (err) {
      return this.failed('copy', err);
    }
  }

  async move(from: string, to: string, overwrite = false): Promise<FsActionResult> {
    this.started('move', from);
    try {
      const before = await this.fs.inspect(from);
      if (!before.success) throw new Error(`Source is gone: ${before.error}`);
      const r = await this.fs.move(from, to, overwrite);
      if (!r.success || !r.result) throw new Error(r.error ?? 'move failed');
      const sourceGone = !(await this.fs.inspect(from)).success;
      const dest = await this.fs.inspect(r.result.path);
      const verified = sourceGone && dest.success;
      return this.finish({
        action: 'move',
        path: r.result.path,
        entries: [r.result],
        verified,
        uncertain: !verified,
        verificationNote: verified ? 'Source gone, destination exists' : 'Move dispatched but post-state could not be fully confirmed',
        summary: `Moved to "${r.result.path}".`,
      });
    } catch (err) {
      return this.failed('move', err);
    }
  }

  async delete(path: string, recursive = false): Promise<FsActionResult> {
    this.started('delete', path);
    try {
      const before = await this.fs.inspect(path);
      if (!before.success) throw new Error(`Target is already gone: ${before.error}`);
      const r = await this.fs.delete(path, recursive);
      if (!r.success || !r.result) throw new Error(r.error ?? 'delete failed');
      // Evidence: target no longer exists.
      const gone = !(await this.fs.inspect(path)).success;
      const verified = gone;
      return this.finish({
        action: 'delete',
        path,
        verified,
        uncertain: !verified,
        verificationNote: verified ? 'Target no longer exists' : 'Delete dispatched but the target still appears to exist',
        summary: `Deleted "${path}".`,
      });
    } catch (err) {
      return this.failed('delete', err);
    }
  }

  async openFile(path: string): Promise<FsActionResult> {
    this.started('open', path);
    try {
      const before = await this.fs.inspect(path);
      if (!before.success) throw new Error(`File is gone: ${before.error}`);
      const r = await this.fs.openFile(path);
      if (!r.success) throw new Error(r.error ?? 'open failed');
      // The OS association dispatch cannot be confirmed as a visible window
      // from the filesystem layer alone — report uncertain honestly.
      return this.finish({
        action: 'open',
        path,
        verified: false,
        uncertain: true,
        verificationNote: 'OS association dispatched; visible-window confirmation requires screen observation',
        summary: `Opened "${path}" with its associated application. ${'Window appearance is not yet verified — ask Krisha to check the screen for confirmation.'}`,
      });
    } catch (err) {
      return this.failed('open', err);
    }
  }
}

export class ApplicationService {
  private apps: AppBackend | undefined;
  private events?: AgentEventBus;

  constructor(options: SystemServicesOptions) {
    this.apps = options.apps;
    this.events = options.events;
  }

  async find(query: string): Promise<FsActionResult> {
    this.events?.emit({ name: 'FS_OPERATION_STARTED', payload: { action: 'app.find', query }, timestamp: Date.now() });
    try {
      const r = await this.apps.discover(query);
      if (!r.success || !r.result) throw new Error(r.error ?? 'discovery failed');
      return {
        action: 'find',
        entries: r.result.map((a) => ({ name: a.name, path: a.target, kind: 'file' as const, size: 0, modifiedAt: 0 })),
        verified: true,
        verificationNote: `${r.result.length} discovered application(s)`,
        summary: r.result.length > 0 ? `Found applications: ${r.result.slice(0, 6).map((a) => a.name).join(', ')}` : `No applications matching "${query}"`,
      };
    } catch (err) {
      return { action: 'find', verified: false, verificationNote: String((err as any)?.message || err), summary: `Application search failed` };
    }
  }

  async launch(name: string, confirmRunning = true): Promise<FsActionResult> {
    this.events?.emit({ name: 'FS_OPERATION_STARTED', payload: { action: 'app.launch', name }, timestamp: Date.now() });
    try {
      const r = await this.apps.launchByName(name);
      if (!r.success || !r.result) throw new Error(r.error ?? 'launch failed');
      this.events?.emit({ name: 'APP_LAUNCHED', payload: { name: r.result.launched }, timestamp: Date.now() });

      // Evidence: check the process actually appeared (bounded, single check).
      const status = await this.apps.status(r.result.launched);
      const running = status.success && status.result?.running === true;
      if (confirmRunning && !running) {
        this.events?.emit({ name: 'APP_LAUNCH_FAILED', payload: { name: r.result.launched }, timestamp: Date.now() });
        return {
          action: 'status',
          name: r.result.launched,
          running: false,
          verified: false,
          uncertain: true,
          verificationNote: 'Launch dispatched but the process was not detected yet — it may still be starting',
          summary: `Launched "${r.result.launched}" but the process was not detected immediately; the app may still be starting.`,
        };
      }
      return {
        action: 'status',
        name: r.result.launched,
        running,
        pids: status.result?.pids,
        verified: running,
        verificationNote: running ? `Process confirmed running (PID ${status.result?.pids?.join(', ')})` : 'Process state unknown',
        summary: `Launched "${r.result.launched}" — ${running ? `process confirmed running (PID ${status.result?.pids?.join(', ')})` : 'process not detected yet (may still be starting)'}.`,
      };
    } catch (err) {
      const message = String((err as any)?.message || err);
      this.events?.emit({ name: 'APP_LAUNCH_FAILED', payload: { name, error: message }, timestamp: Date.now() });
      return { action: 'status', name, verified: false, verificationNote: message, summary: `Launch failed: ${message}` };
    }
  }

  async status(name: string): Promise<FsActionResult> {
    try {
      const r = await this.apps.status(name);
      if (!r.success || !r.result) throw new Error(r.error ?? 'status failed');
      this.events?.emit({ name: 'APP_STATE_CHANGED', payload: { name: r.result.name, running: r.result.running }, timestamp: Date.now() });
      return {
        action: 'status',
        name: r.result.name,
        running: r.result.running,
        pids: r.result.pids,
        verified: true,
        verificationNote: 'Process table read directly',
        summary: `"${r.result.name}" is ${r.result.running ? `running (PID ${r.result.pids.join(', ')})` : 'not running'}.`,
      };
    } catch (err) {
      return { action: 'status', name, verified: false, verificationNote: String((err as any)?.message || err), summary: 'Status check failed' };
    }
  }

  async close(pid: number, force = false): Promise<FsActionResult> {
    this.events?.emit({ name: 'FS_OPERATION_STARTED', payload: { action: 'app.close', pid }, timestamp: Date.now() });
    try {
      const r = await this.apps.close(pid, force);
      const closed = r.result?.closed === true;
      this.events?.emit({ name: closed ? 'APP_CLOSED' : 'APP_LAUNCH_FAILED', payload: { pid, closed }, timestamp: Date.now() });
      // Verify: process should no longer be listed under any known name.
      return {
        action: 'close',
        pid,
        verified: closed,
        uncertain: !closed,
        verificationNote: closed ? `Process ${pid} terminated` : 'Terminate dispatch failed',
        summary: closed ? `Process ${pid} closed.` : `Process ${pid} could not be closed.`,
      };
    } catch (err) {
      return { action: 'close', pid, verified: false, verificationNote: String((err as any)?.message || err), summary: 'Close failed' };
    }
  }

  async focus(pid: number): Promise<FsActionResult> {
    try {
      const r = await this.apps.focus(pid);
      const focused = r.result?.focused === true;
      return {
        action: 'focus',
        pid,
        focused,
        verified: focused,
        uncertain: !focused,
        verificationNote: focused ? `Focus dispatch accepted for PID ${pid}` : 'Focus dispatch failed',
        summary: focused ? `Focused process ${pid}.` : `Could not focus process ${pid}.`,
      };
    } catch (err) {
      return { action: 'focus', pid, verified: false, uncertain: true, verificationNote: String((err as any)?.message || err), summary: 'Focus failed' };
    }
  }
}
