/**
 * Project Awareness v1 — bounded, versioned, corruption-tolerant persistence.
 *
 * Same conventions as the Phase 12 workflow store and Learned Skills store
 * (StorageAdapter, schema envelope, repair-don't-drop, hard caps), under its
 * own key. Stores ONLY metadata: paths, sizes, signatures, names — never
 * file contents, never secret files.
 */
import type { StorageAdapter } from '../taskState';
import type { DirDigest, ProjectDevStatus, ProjectFileRecord, ProjectKind, ProjectLanguageStat, ProjectModule, ProjectProfile } from './projectTypes';
import {
  MAX_BLOCKERS,
  MAX_COMPLETED,
  MAX_CONFIG_FILES,
  MAX_DEPENDENCIES,
  MAX_DIR_DIGESTS,
  MAX_ENTRY_POINTS,
  MAX_FRAMEWORKS,
  MAX_IMPORTANT_FILES,
  MAX_MODULES,
  MAX_PROJECTS,
  PROJECTS_SCHEMA_VERSION,
  PROJECTS_STORAGE_KEY,
  normalizeRoot,
} from './projectTypes';

export interface ProjectStoreSchema {
  schemaVersion: number;
  /** Explicitly approved directory roots — the ONLY directories ever read. */
  approvedRoots: string[];
  projects: ProjectProfile[];
}

const KINDS: ReadonlySet<string> = new Set(['node', 'python', 'go', 'rust', 'java', 'dotnet', 'generic']);

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function strList(v: unknown, max: number, itemMax = 120): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((s) => s.slice(0, itemMax)) : [];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function repairFiles(list: unknown): ProjectFileRecord[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((f): f is ProjectFileRecord => !!f && typeof f.path === 'string' && typeof f.name === 'string' && typeof f.sig === 'string')
    .slice(0, MAX_IMPORTANT_FILES)
    .map((f) => ({
      path: f.path.slice(0, 200),
      name: f.name.slice(0, 120),
      role: f.role === 'manifest' || f.role === 'config' || f.role === 'entry' || f.role === 'doc' ? f.role : 'source',
      size: num(f.size),
      sig: f.sig.slice(0, 60),
    }));
}

function repairModules(list: unknown): ProjectModule[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m): m is ProjectModule => !!m && typeof m.path === 'string' && typeof m.name === 'string')
    .slice(0, MAX_MODULES)
    .map((m) => ({ path: m.path.slice(0, 200), name: m.name.slice(0, 120), files: num(m.files), subdirs: num(m.subdirs) }));
}

function repairDigests(list: unknown): DirDigest[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((d): d is DirDigest => !!d && typeof d.path === 'string' && typeof d.digest === 'string')
    .slice(0, MAX_DIR_DIGESTS)
    .map((d) => ({ path: d.path.slice(0, 200), digest: d.digest.slice(0, 40) }));
}

function repairLanguages(list: unknown): ProjectLanguageStat[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((l): l is ProjectLanguageStat => !!l && typeof l.language === 'string')
    .slice(0, 8)
    .map((l) => ({ language: l.language.slice(0, 30), files: num(l.files) }));
}

function repairDev(v: unknown): ProjectDevStatus {
  const dev = (v ?? {}) as ProjectDevStatus;
  const out: ProjectDevStatus = {};
  const goal = str(dev.goal, 200);
  const progress = str(dev.progress, 400);
  if (goal) out.goal = goal;
  if (progress) out.progress = progress;
  const blockers = strList(dev.blockers, MAX_BLOCKERS, 200);
  const completed = strList(dev.completed, MAX_COMPLETED, 200);
  if (blockers.length) out.blockers = blockers;
  if (completed.length) out.completed = completed;
  if (typeof dev.updatedAt === 'number') out.updatedAt = dev.updatedAt;
  return out;
}

function repairProfile(entry: unknown): ProjectProfile | null {
  if (!entry || typeof entry !== 'object') return null;
  const p = entry as Partial<ProjectProfile>;
  if (typeof p.id !== 'string' || !p.id || typeof p.root !== 'string' || !p.root) return null;
  const now = Date.now();
  const kind: ProjectKind = typeof p.kind === 'string' && KINDS.has(p.kind) ? (p.kind as ProjectKind) : 'generic';
  return {
    id: p.id,
    root: p.root,
    name: str(p.name, 60) || normalizeRoot(p.root).split('/').pop() || 'project',
    kind,
    languages: repairLanguages(p.languages),
    frameworks: strList(p.frameworks, MAX_FRAMEWORKS, 40),
    dependencies: strList(p.dependencies, MAX_DEPENDENCIES, 80),
    entryPoints: strList(p.entryPoints, MAX_ENTRY_POINTS),
    configFiles: strList(p.configFiles, MAX_CONFIG_FILES),
    modules: repairModules(p.modules),
    importantFiles: repairFiles(p.importantFiles),
    dirDigests: repairDigests(p.dirDigests),
    stats: {
      filesSeen: num(p.stats?.filesSeen),
      filesSkipped: num(p.stats?.filesSkipped),
      dirsScanned: num(p.stats?.dirsScanned),
      secretsExcluded: num(p.stats?.secretsExcluded),
      dirsErrored: num(p.stats?.dirsErrored),
      readsSaved: num(p.stats?.readsSaved),
    },
    dev: repairDev(p.dev),
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : now,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : now,
    lastIndexedAt: typeof p.lastIndexedAt === 'number' ? p.lastIndexedAt : now,
  };
}

export class ProjectStore {
  approvedRoots: string[] = [];
  projects: ProjectProfile[] = [];
  private storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
    this.load();
  }

  load(): void {
    const raw = this.storage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<ProjectStoreSchema> | null;
      if (!parsed || typeof parsed !== 'object') return;
      if ((parsed.schemaVersion as number) > PROJECTS_SCHEMA_VERSION) return; // future schema → clean start
      this.approvedRoots = strList(parsed.approvedRoots, MAX_PROJECTS, 300).map((r) => normalizeRoot(r));
      this.projects = (Array.isArray(parsed.projects) ? parsed.projects : [])
        .map((p) => repairProfile(p))
        .filter((p): p is ProjectProfile => !!p)
        .slice(0, MAX_PROJECTS);
    } catch {
      // corrupted state — start clean rather than fail
    }
  }

  persist(): void {
    if (this.projects.length > MAX_PROJECTS) {
      // Least-recently-indexed projects go first.
      this.projects = [...this.projects]
        .sort((a, b) => b.lastIndexedAt - a.lastIndexedAt)
        .slice(0, MAX_PROJECTS);
    }
    if (this.approvedRoots.length > MAX_PROJECTS) {
      this.approvedRoots = this.approvedRoots.slice(0, MAX_PROJECTS);
    }
    try {
      const envelope: ProjectStoreSchema = {
        schemaVersion: PROJECTS_SCHEMA_VERSION,
        approvedRoots: this.approvedRoots,
        projects: this.projects,
      };
      this.storage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // storage failure — in-memory state stays authoritative
    }
  }

  isApproved(root: string): boolean {
    const normalized = normalizeRoot(root).toLowerCase();
    return this.approvedRoots.some((r) => r.toLowerCase() === normalized);
  }

  approve(root: string): boolean {
    const normalized = normalizeRoot(root);
    if (!normalized || this.isApproved(normalized)) return false;
    this.approvedRoots.push(normalized);
    if (this.approvedRoots.length > MAX_PROJECTS) this.approvedRoots.shift();
    this.persist();
    return true;
  }

  revoke(root: string): boolean {
    const normalized = normalizeRoot(root).toLowerCase();
    const before = this.approvedRoots.length;
    this.approvedRoots = this.approvedRoots.filter((r) => r.toLowerCase() !== normalized);
    if (this.approvedRoots.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  get(root: string): ProjectProfile | undefined {
    const normalized = normalizeRoot(root).toLowerCase();
    return this.projects.find((p) => p.root.toLowerCase() === normalized);
  }

  getById(id: string): ProjectProfile | undefined {
    return this.projects.find((p) => p.id === id);
  }

  upsert(profile: ProjectProfile): void {
    const index = this.projects.findIndex((p) => p.id === profile.id);
    if (index >= 0) this.projects[index] = profile;
    else this.projects.push(profile);
    this.persist();
  }

  remove(root: string): boolean {
    const normalized = normalizeRoot(root).toLowerCase();
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.root.toLowerCase() !== normalized);
    if (this.projects.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  clear(): void {
    this.projects = [];
    this.approvedRoots = [];
    this.storage.removeItem(PROJECTS_STORAGE_KEY);
  }
}
