/**
 * HTTP transports (Phase 9) — talk to the local server's /api/fs and /api/app
 * endpoints. Injectable base URL so Node-based verification targets the
 * server directly (browser default is same-origin).
 */
import type { AppBackend, DiscoveredApp, AppStatus, FsBackend, FsEntry, FsListResult, FsReadResult, FsSearchResult } from './systemTypes';

const REQUEST_TIMEOUT_MS = 45_000;

let BASE_URL = '';

export function setSystemBackendBaseUrl(url: string): void {
  BASE_URL = url.replace(/\/$/, '');
}

async function post<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return { success: false, error: `Server returned HTTP ${res.status}` } as T;
    return (await res.json()) as T;
  } catch (err: any) {
    if (controller.signal.aborted) return { success: false, error: 'Request timed out' } as T;
    return { success: false, error: `Server unreachable: ${String(err?.message || err)}` } as T;
  } finally {
    clearTimeout(timer);
  }
}

type FsOp<T> = { success: boolean; result?: T; error?: string };

export class HttpFsBackend implements FsBackend {
  async list(path: string): Promise<FsOp<FsListResult>> {
    return post('/api/fs/list', { path });
  }
  async inspect(path: string): Promise<FsOp<FsEntry>> {
    return post('/api/fs/inspect', { path });
  }
  async search(root: string, query: string, maxDepth?: number): Promise<FsOp<FsSearchResult>> {
    return post('/api/fs/search', { root, query, maxDepth });
  }
  async read(path: string, offset?: number): Promise<FsOp<FsReadResult>> {
    return post('/api/fs/read', { path, offset });
  }
  async create(path: string, type: 'file' | 'dir', content?: string): Promise<FsOp<FsEntry>> {
    return post('/api/fs/create', { path, type, content });
  }
  async rename(path: string, newName: string): Promise<FsOp<FsEntry>> {
    return post('/api/fs/rename', { path, newName });
  }
  async copy(from: string, to: string, overwrite?: boolean): Promise<FsOp<FsEntry>> {
    return post('/api/fs/copy', { from, to, overwrite });
  }
  async move(from: string, to: string, overwrite?: boolean): Promise<FsOp<FsEntry>> {
    return post('/api/fs/move', { from, to, overwrite });
  }
  async delete(path: string, recursive?: boolean): Promise<FsOp<{ path: string; deleted: true }>> {
    return post('/api/fs/delete', { path, recursive });
  }
  async openFile(path: string): Promise<FsOp<string>> {
    return post('/api/fs/open', { path });
  }
}

type AppOp<T> = { success: boolean; result?: T; error?: string };

export class HttpAppBackend implements AppBackend {
  async discover(query?: string, force?: boolean): Promise<AppOp<DiscoveredApp[]>> {
    return post('/api/app/discover', { query, force });
  }
  async launchByName(name: string): Promise<AppOp<{ launched: string; target: string }>> {
    return post('/api/app/launch', { name });
  }
  async launchByPath(path: string): Promise<AppOp<{ launched: string; target: string }>> {
    return post('/api/app/launch', { path });
  }
  async status(name: string): Promise<AppOp<AppStatus>> {
    return post('/api/app/status', { name });
  }
  async close(pid: number, force?: boolean): Promise<AppOp<{ closed: boolean; pid: number }>> {
    return post('/api/app/close', { pid, force });
  }
  async focus(pid: number): Promise<AppOp<{ focused: boolean; pid: number }>> {
    return post('/api/app/focus', { pid });
  }
}
