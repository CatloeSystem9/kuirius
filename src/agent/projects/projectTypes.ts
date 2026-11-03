/**
 * Project Awareness v1 — types, constants and helpers.
 *
 * Krisha understands the user's software projects: identity, languages,
 * frameworks, dependencies, entry points, module structure, development
 * progress (goals / progress / blockers / completed work) and how all of it
 * changed since the last look.
 *
 * Hard boundaries:
 *  - only EXPLICITLY approved roots are ever read (never silent discovery);
 *  - indexing is strictly READ-ONLY — no file is ever modified, moved or run;
 *  - secret-shaped files (.env*, keys, credentials, …) are never indexed or
 *    read — they are counted and skipped;
 *  - metadata only: no file contents are persisted anywhere;
 *  - everything is bounded (depth, dirs, files, bytes, projects) — an i3
 *    laptop with 8 GB RAM stays comfortable, and indexing happens ONLY on
 *    explicit demand (no polling, no background scanning).
 */

// ---------------------------------------------------------------- constants

export const PROJECTS_SCHEMA_VERSION = 1;
export const PROJECTS_STORAGE_KEY = 'krisha_projects_v1';

export const MAX_PROJECTS = 10;
export const MAX_DEPTH = 6;
export const MAX_DIRS_SCANNED = 80;
export const MAX_ENTRIES_PER_DIR = 200;
/** Important files whose (bounded) metadata is persisted. */
export const MAX_IMPORTANT_FILES = 48;
export const MAX_MODULES = 24;
/** Directory digests kept for cheap change detection. */
export const MAX_DIR_DIGESTS = 80;
export const MAX_DEPENDENCIES = 40;
export const MAX_FRAMEWORKS = 12;
export const MAX_LANGUAGES = 5;
export const MAX_ENTRY_POINTS = 8;
export const MAX_CONFIG_FILES = 10;
export const MAX_BLOCKERS = 10;
export const MAX_COMPLETED = 10;
/** Manifests/configs larger than this are never read. */
export const MAX_READ_BYTES = 96 * 1024;
/** Files larger than this are never read for parsing (metadata only). */
export const MAX_PARSE_FILE_BYTES = 512 * 1024;
/** A profile older than this is reported stale (refresh is on-demand). */
export const PROJECT_STALE_MS = 30 * 60 * 1000;

/** Generated/irrelevant directories — never scanned. */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.next', '.nuxt',
  '.output', '.cache', '.turbo', '.parcel-cache', 'vendor', '__pycache__',
  '.venv', 'venv', 'env', '.pytest_cache', '.mypy_cache', 'target', 'obj',
  'bin', '.idea', '.vscode', '.gradle', '.terraform', '.expo', 'tmp',
]);

/** Secret-shaped file names — never indexed, never read. */
const SECRET_NAME_RE =
  /^\.env($|\.)|\.env\..+|(^|\/)(\.env|secrets?|credentials?|passwords?)(\.[a-z0-9]+)?$|\.pem$|\.key$|\.pfx$|\.p12$|\.keystore$|id_rsa|id_ed25519|id_ecdsa|\.htpasswd$|service-account.*\.json$|\.npmrc$|\.netrc$|\.git-credentials$/i;

const SECRET_CONTENT_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

// ---------------------------------------------------------------- records

export type ProjectKind = 'node' | 'python' | 'go' | 'rust' | 'java' | 'dotnet' | 'generic';
export type ProjectFileRole = 'manifest' | 'config' | 'entry' | 'doc' | 'source';

/** Bounded metadata for one important file (never content). */
export interface ProjectFileRecord {
  /** Project-relative path with forward slashes. */
  path: string;
  name: string;
  role: ProjectFileRole;
  size: number;
  /** Cheap change signature: `${size}:${modifiedAt}`. */
  sig: string;
}

export interface ProjectModule {
  /** Project-relative directory path ('' = root is not a module). */
  path: string;
  name: string;
  files: number;
  subdirs: number;
}

export interface DirDigest {
  path: string;
  digest: string;
}

export interface ProjectLanguageStat {
  language: string;
  files: number;
}

export interface ProjectDevStatus {
  goal?: string;
  progress?: string;
  blockers?: string[];
  completed?: string[];
  updatedAt?: number;
}

/** The indexed project profile — compact, metadata-only, bounded. */
export interface ProjectProfile {
  /** Stable id: hash of the normalized root. */
  id: string;
  /** Absolute approved root (original casing). */
  root: string;
  name: string;
  kind: ProjectKind;
  languages: ProjectLanguageStat[];
  frameworks: string[];
  /** Dependency NAMES only (never versions from lockfiles, never values). */
  dependencies: string[];
  entryPoints: string[];
  configFiles: string[];
  modules: ProjectModule[];
  importantFiles: ProjectFileRecord[];
  dirDigests: DirDigest[];
  stats: {
    filesSeen: number;
    filesSkipped: number;
    dirsScanned: number;
    secretsExcluded: number;
    dirsErrored: number;
    /** Content reads avoided by reusing unchanged signatures. */
    readsSaved: number;
  };
  dev: ProjectDevStatus;
  createdAt: number;
  updatedAt: number;
  lastIndexedAt: number;
}

/** Change report between the stored profile and a fresh scan. */
export interface ProjectChange {
  root: string;
  name: string;
  /** Directories whose content signature changed (bounded). */
  changedDirs: string[];
  added: string[];
  removed: string[];
  modified: string[];
  /** True when nothing vs the stored profile differs. */
  unchanged: boolean;
  detectedAt: number;
}

export interface ProjectStats {
  approvedRoots: number;
  projects: number;
  stale: number;
  kinds: Record<string, number>;
}

// ---------------------------------------------------------------- helpers

/** Normalize a root for comparison: backslashes forward, no trailing slash. */
export function normalizeRoot(root: string): string {
  return String(root ?? '').trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
}

/** Case-insensitive root identity (Windows-friendly). */
export function sameRoot(a: string, b: string): boolean {
  return normalizeRoot(a).toLowerCase() === normalizeRoot(b).toLowerCase();
}

export function isSecretPath(name: string): boolean {
  return SECRET_NAME_RE.test(name.replace(/\\/g, '/'));
}

export function isSecretContent(content: string): boolean {
  return SECRET_CONTENT_RE.test(content);
}

/** Cheap deterministic content signature for a file. */
export function fileSig(size: number, modifiedAt: number): string {
  return `${Math.max(0, Math.round(size))}:${Math.max(0, Math.round(modifiedAt))}`;
}

/** djb2 over the given lines — deterministic, dependency-free. */
export function digestOf(lines: string[]): string {
  let h = 5381;
  const text = lines.join('\n');
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', cs: 'C#',
  cpp: 'C++', cc: 'C++', hpp: 'C++', h: 'C/C++ header', c: 'C',
  rb: 'Ruby', php: 'PHP', swift: 'Swift', kt: 'Kotlin',
  vue: 'Vue', svelte: 'Svelte', sh: 'Shell', ps1: 'PowerShell',
  sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'SCSS',
};

export function languageForExt(ext: string): string | undefined {
  return LANGUAGE_BY_EXT[ext.toLowerCase()];
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

/** Root manifests that identify a project. */
export const PROJECT_MANIFESTS: ReadonlySet<string> = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
]);

const DOTNET_PROJECT_RE = /\.csproj$|\.fsproj$/i;

export function isManifestName(name: string): boolean {
  return PROJECT_MANIFESTS.has(name.toLowerCase()) || DOTNET_PROJECT_RE.test(name);
}

const CONFIG_EXTS = new Set(['json', 'toml', 'yaml', 'yml', 'ini', 'cfg', 'xml', 'lock']);
const DOC_NAMES = new Set(['readme.md', 'readme', 'readme.txt', 'changelog.md', 'contributing.md', 'architecture.md', 'license']);

export function roleForFile(name: string, depth: number): ProjectFileRole {
  const lower = name.toLowerCase();
  if (isManifestName(lower) || lower === 'tsconfig.json' || lower === 'vite.config.ts' || lower === 'webpack.config.js') return 'manifest';
  if (DOC_NAMES.has(lower)) return 'doc';
  if (CONFIG_EXTS.has(extOf(lower)) || lower.startsWith('.') || lower.endsWith('.config.js') || lower.endsWith('.config.ts')) return 'config';
  if (isEntryCandidate(lower, depth)) return 'entry';
  return 'source';
}

const ENTRY_NAMES = new Set([
  'index.ts', 'index.tsx', 'index.js', 'index.mjs', 'main.ts', 'main.js',
  'main.py', '__main__.py', 'app.ts', 'app.js', 'server.ts', 'server.js',
  'main.go', 'lib.rs', 'mod.rs', 'program.cs',
]);

export function isEntryCandidate(lowerName: string, depth: number): boolean {
  if (depth > 2) return false;
  return ENTRY_NAMES.has(lowerName) || lowerName === 'main.go';
}

export function isImportantRole(role: ProjectFileRole): boolean {
  return role === 'manifest' || role === 'config' || role === 'entry' || role === 'doc';
}

export function isStale(profile: ProjectProfile, now = Date.now()): boolean {
  return now - profile.lastIndexedAt > PROJECT_STALE_MS;
}
