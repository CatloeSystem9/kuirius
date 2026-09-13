/**
 * Filesystem + Application agent types (Phase 9).
 *
 * The client services talk to the local server (real disk + Windows process
 * layer) through injectable backends; fakes provide deterministic tests.
 * Verification is evidence-based: every mutating operation re-checks state.
 */

export interface FsEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: number;
  isText?: boolean;
}

export interface FsListResult {
  path: string;
  entries: FsEntry[];
  truncated: boolean;
}

export interface FsSearchResult {
  root: string;
  matches: FsEntry[];
  scanned: number;
  truncated: boolean;
}

export interface FsReadResult {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  offset: number;
}

export interface FsVerify {
  strategy: 'exists' | 'gone' | 'state_check' | 'self_reported';
  verified: boolean;
  uncertain?: boolean;
  note: string;
}

export type FsActionKind =
  | 'list' | 'search' | 'inspect' | 'read' | 'create' | 'rename' | 'copy' | 'move' | 'delete' | 'open'
  | 'find' | 'launch' | 'status' | 'close' | 'focus';

export interface FsActionResult {
  action: FsActionKind;
  path?: string;
  entries?: FsEntry[];
  matches?: FsEntry[];
  content?: string;
  name?: string;
  running?: boolean;
  pids?: number[];
  focused?: boolean;
  pid?: number;
  verified: boolean;
  verificationNote: string;
  uncertain?: boolean;
  summary: string;
}

/** Transport for real-disk filesystem operations. */
export interface FsBackend {
  list(path: string): Promise<{ success: boolean; result?: FsListResult; error?: string }>;
  inspect(path: string): Promise<{ success: boolean; result?: FsEntry; error?: string }>;
  search(root: string, query: string, maxDepth?: number): Promise<{ success: boolean; result?: FsSearchResult; error?: string }>;
  read(path: string, offset?: number): Promise<{ success: boolean; result?: FsReadResult; error?: string }>;
  create(path: string, type: 'file' | 'dir', content?: string): Promise<{ success: boolean; result?: FsEntry; error?: string }>;
  rename(path: string, newName: string): Promise<{ success: boolean; result?: FsEntry; error?: string }>;
  copy(from: string, to: string, overwrite?: boolean): Promise<{ success: boolean; result?: FsEntry; error?: string }>;
  move(from: string, to: string, overwrite?: boolean): Promise<{ success: boolean; result?: FsEntry; error?: string }>;
  delete(path: string, recursive?: boolean): Promise<{ success: boolean; result?: { path: string; deleted: true }; error?: string }>;
  openFile(path: string): Promise<{ success: boolean; result?: string; error?: string }>;
}

// ------------------------------------------------------------- applications

export interface DiscoveredApp {
  name: string;
  source: 'start_menu' | 'path' | 'registry';
  target: string;
}

export interface AppStatus {
  name: string;
  running: boolean;
  pids: number[];
}

export interface AppActionResult {
  action: 'find' | 'launch' | 'status' | 'close' | 'focus' | 'open_file';
  name?: string;
  running?: boolean;
  pids?: number[];
  focused?: boolean;
  uncertain?: boolean;
  verified: boolean;
  verificationNote: string;
  summary: string;
}

/** Transport for Windows application discovery/control. */
export interface AppBackend {
  discover(query?: string, force?: boolean): Promise<{ success: boolean; result?: DiscoveredApp[]; error?: string }>;
  launchByName(name: string): Promise<{ success: boolean; result?: { launched: string; target: string }; error?: string }>;
  launchByPath(path: string): Promise<{ success: boolean; result?: { launched: string; target: string }; error?: string }>;
  status(name: string): Promise<{ success: boolean; result?: AppStatus; error?: string }>;
  close(pid: number, force?: boolean): Promise<{ success: boolean; result?: { closed: boolean; pid: number }; error?: string }>;
  focus(pid: number): Promise<{ success: boolean; result?: { focused: boolean; pid: number }; error?: string }>;
}
