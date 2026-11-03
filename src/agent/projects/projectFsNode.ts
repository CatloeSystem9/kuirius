/**
 * Project Awareness v1 — Node filesystem transport (tests and server-side
 * checks only; never imported into the browser bundle).
 */
import * as nodeFs from 'fs';
import * as nodePath from 'path';
import type { ProjectFs } from './projectFs';

export class NodeProjectFs implements ProjectFs {
  async list(path: string): Promise<{ ok: boolean; entries: import('./projectFs').ProjectDirEntry[]; error?: string }> {
    try {
      const raw = await nodeFs.promises.readdir(path, { withFileTypes: true });
      const entries: import('./projectFs').ProjectDirEntry[] = [];
      for (const item of raw) {
        if (item.isFile() || item.isDirectory()) {
          let size = 0;
          let modifiedAt = 0;
          try {
            const st = await nodeFs.promises.stat(nodePath.join(path, item.name));
            size = st.size;
            modifiedAt = st.mtimeMs;
          } catch {
            // stat failure keeps the entry with unknown size (sig still works)
          }
          entries.push({ name: item.name, kind: item.isDirectory() ? 'directory' : 'file', size, modifiedAt });
        }
      }
      return { ok: true, entries };
    } catch (err: any) {
      return { ok: false, entries: [], error: String(err?.message || err) };
    }
  }

  async readHead(path: string, maxChars: number): Promise<{ ok: boolean; content?: string; error?: string }> {
    try {
      const handle = await nodeFs.promises.open(path, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(maxChars, 256 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return { ok: true, content: buffer.toString('utf8', 0, bytesRead) };
      } finally {
        await handle.close();
      }
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
}
