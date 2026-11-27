/**
 * Initiation Subsystem — file system watcher.
 *
 * Emits `file_created` / `file_modified` events for APPROVED directories so
 * reactive rules can react to work happening on disk (a build finishing, a
 * report being dropped, a dataset landing).
 *
 * Rules of engagement:
 * - Only directories the user has approved are watched. Nothing is scanned
 *   speculatively and no file CONTENT is ever read — only names, sizes and
 *   extensions.
 * - Editor/OS scratch files (`.tmp`, `~$*`, `.swp`) are ignored.
 * - Events are debounced per path so a single save does not storm the rules.
 */
import * as fs from 'fs';
import * as path from 'path';

export type FileEventKind = 'file_created' | 'file_modified';

export interface FileChangeEvent {
  kind: FileEventKind;
  /** Full path of the changed file. */
  path: string;
  /** Base name. */
  filename: string;
  /** Extension including the dot (may be empty). */
  extension: string;
  /** Size in bytes at the time of the event (0 when unknown). */
  size: number;
  /** The watched directory the change was seen in. */
  dir: string;
}

export interface FileWatcherOptions {
  /** Directories to watch. Missing directories are skipped, never created. */
  directories?: string[];
  /** Debounce window per path (ms). */
  debounceMs?: number;
  now?: () => number;
  onEvent?: (event: FileChangeEvent) => void;
}

/** Scratch/partial files that are never interesting. */
function isNoiseFile(filename: string): boolean {
  return (
    filename.startsWith('~$') ||
    filename.startsWith('.') ||
    filename.endsWith('.tmp') ||
    filename.endsWith('.swp') ||
    filename.endsWith('.crdownload') ||
    filename.endsWith('.part') ||
    filename.endsWith('.opdownload')
  );
}

export class FileChangeWatcher {
  private watchers: fs.FSWatcher[] = [];
  /** Paths seen before — a path in this set is a modification, not a creation. */
  private known = new Set<string>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly directories: string[];
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (event: FileChangeEvent) => void;
  private running = false;

  constructor(options: FileWatcherOptions = {}) {
    this.directories = options.directories || [];
    this.debounceMs = options.debounceMs ?? 750;
    this.now = options.now || (() => Date.now());
    this.onEvent = options.onEvent;
  }

  /** Begin watching. Safe to call twice. */
  public start(): void {
    if (this.running) return;
    this.running = true;

    for (const dir of this.directories) {
      try {
        if (!fs.existsSync(dir)) continue;
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) continue;

        // Seed the known set so pre-existing files are not reported as created.
        try {
          for (const entry of fs.readdirSync(dir)) {
            this.known.add(path.join(dir, entry).toLowerCase());
          }
        } catch {
          // unreadable directory — still watch for events
        }

        const watcher = fs.watch(dir, (_eventType, filename) => {
          if (!filename) return;
          this.onRawChange(dir, filename);
        });
        (watcher as any)?.unref?.();
        this.watchers.push(watcher);
      } catch (err) {
        console.warn(`[FileWatcher] Could not watch ${dir}:`, err);
      }
    }
  }

  /** Stop watching and clear pending debounce timers. */
  public stop(): void {
    this.running = false;
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  /** Add a directory at runtime (e.g. a project the user just approved). */
  public addDirectory(dir: string): void {
    if (this.directories.includes(dir)) return;
    this.directories.push(dir);
    if (this.running) {
      this.stop();
      this.running = true;
      this.start();
    }
  }

  /** Directories currently watched. */
  public getWatchedDirectories(): string[] {
    return [...this.directories];
  }

  // ------------------------------------------------------------- internals

  private onRawChange(dir: string, filename: string): void {
    if (isNoiseFile(filename)) return;
    const fullPath = path.join(dir, filename);

    // Debounce per path — a single editor save fires several raw events.
    const existing = this.debounceTimers.get(fullPath.toLowerCase());
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(fullPath.toLowerCase());
      this.emitChange(dir, fullPath);
    }, this.debounceMs);
    (timer as any)?.unref?.();
    this.debounceTimers.set(fullPath.toLowerCase(), timer);
  }

  private emitChange(dir: string, fullPath: string): void {
    let size = 0;
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) return;
      size = stat.size;
    } catch {
      // deleted between the event and the debounce — nothing to report
      return;
    }

    const key = fullPath.toLowerCase();
    const kind: FileEventKind = this.known.has(key) ? 'file_modified' : 'file_created';
    this.known.add(key);

    try {
      this.onEvent?.({
        kind,
        path: fullPath,
        filename: path.basename(fullPath),
        extension: path.extname(fullPath),
        size,
        dir,
      });
    } catch (err) {
      console.warn('[FileWatcher] Event handler error:', err);
    }
  }
}
