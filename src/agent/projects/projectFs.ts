/**
 * Project Awareness v1 — filesystem transport.
 *
 * One tiny read-only surface plus a browser-safe HTTP implementation that
 * wraps the EXISTING Phase 9 `FsBackend` (which talks to the local server's
 * /api/fs endpoints), so the browser-side bridge scans real disks with zero
 * new server routes. The Node implementation lives in `projectFsNode.ts`
 * (tests / server-side checks only) and is never imported into the browser
 * bundle.
 *
 * There are no write operations by design: project awareness never modifies,
 * moves, deletes or executes anything.
 */
import type { FsBackend } from '../system/systemTypes';

export interface ProjectDirEntry {
  name: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: number;
}

export interface ProjectFs {
  /** List one directory (deterministic order is the caller's job). */
  list(path: string): Promise<{ ok: boolean; entries: ProjectDirEntry[]; error?: string }>;
  /** Read up to `maxChars` characters of a text file (content is never persisted). */
  readHead(path: string, maxChars: number): Promise<{ ok: boolean; content?: string; error?: string }>;
}

/** Reuses the Phase 9 HTTP filesystem backend — no new server endpoints. */
export class HttpProjectFs implements ProjectFs {
  constructor(private backend: FsBackend) {}

  async list(path: string): Promise<{ ok: boolean; entries: ProjectDirEntry[]; error?: string }> {
    const res = await this.backend.list(path);
    if (!res.success || !res.result) return { ok: false, entries: [], error: res.error ?? 'list failed' };
    return {
      ok: true,
      entries: res.result.entries
        .filter((e) => e.kind === 'file' || e.kind === 'directory')
        .map((e) => ({ name: e.name, kind: e.kind, size: e.size, modifiedAt: e.modifiedAt })),
    };
  }

  async readHead(path: string, maxChars: number): Promise<{ ok: boolean; content?: string; error?: string }> {
    const res = await this.backend.read(path, 0);
    if (!res.success || !res.result) return { ok: false, error: res.error ?? 'read failed' };
    return { ok: true, content: res.result.content.slice(0, maxChars) };
  }
}

