/**
 * Project Awareness v1 — deterministic project scanner.
 *
 * One pass over an approved root builds a bounded, metadata-only profile:
 * identity (manifests), languages (extension histogram), frameworks and
 * dependencies (manifest NAMES only), entry points, module structure
 * (first two directory levels), important-file records and per-directory
 * content digests for cheap change detection.
 *
 * Incremental: unchanged files (same size+mtime signature) are never re-read;
 * only manifests/configs/entries/docs worth persisting are read at all, and
 * never beyond MAX_READ_BYTES. Secrets are counted and skipped untouched.
 * Generated directories (node_modules, dist, .git, …) are never entered.
 */
import type { ProjectFs, ProjectDirEntry } from './projectFs';
import type {
  DirDigest,
  ProjectFileRecord,
  ProjectFileRole,
  ProjectKind,
  ProjectLanguageStat,
  ProjectModule,
} from './projectTypes';
import {
  EXCLUDED_DIRS,
  MAX_DEPENDENCIES,
  MAX_DEPTH,
  MAX_DIRS_SCANNED,
  MAX_DIR_DIGESTS,
  MAX_ENTRIES_PER_DIR,
  MAX_FRAMEWORKS,
  MAX_IMPORTANT_FILES,
  MAX_LANGUAGES,
  MAX_MODULES,
  MAX_PARSE_FILE_BYTES,
  MAX_READ_BYTES,
  digestOf,
  extOf,
  fileSig,
  isEntryCandidate,
  isManifestName,
  isSecretContent,
  isSecretPath,
  languageForExt,
  roleForFile,
} from './projectTypes';

const NODE_FRAMEWORKS: Record<string, string> = {
  react: 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte',
  '@angular/core': 'Angular', express: 'Express', fastify: 'Fastify',
  '@nestjs/core': 'NestJS', vite: 'Vite', webpack: 'Webpack', electron: 'Electron',
  'react-native': 'React Native', tailwindcss: 'Tailwind CSS',
  '@prisma/client': 'Prisma', jest: 'Jest', vitest: 'Vitest',
  '@playwright/test': 'Playwright', typescript: 'TypeScript', eslint: 'ESLint',
};

const PY_FRAMEWORKS: Record<string, string> = {
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI', numpy: 'NumPy',
  pandas: 'pandas', torch: 'PyTorch', tensorflow: 'TensorFlow',
};

const RUST_FRAMEWORKS: Record<string, string> = {
  tokio: 'Tokio', actix: 'Actix', actix_web: 'Actix Web', serde: 'Serde',
};

export interface ScanResult {
  name: string;
  kind: ProjectKind;
  languages: ProjectLanguageStat[];
  frameworks: string[];
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
    readsSaved: number;
  };
}

interface PackageJsonShape {
  name?: string;
  main?: string;
  bin?: string | Record<string, string>;
  module?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ManifestParse {
  projectName?: string;
  kind?: ProjectKind;
  frameworks: string[];
  dependencies: string[];
  entryPoints: string[];
}

function sortEntries(entries: ProjectDirEntry[]): ProjectDirEntry[] {
  return [...entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
}

function pushBounded(list: string[], value: string, max: number): void {
  if (!list.includes(value)) {
    list.push(value);
    if (list.length > max) list.length = max;
  }
}

/** Parse one bounded manifest read into profile contributions. */
function parseManifest(kindHint: ProjectKind, name: string, content: string): ManifestParse {
  const out: ManifestParse = { frameworks: [], dependencies: [], entryPoints: [] };
  try {
    if (name.toLowerCase() === 'package.json') {
      const pkg = JSON.parse(content) as PackageJsonShape;
      if (pkg.name && typeof pkg.name === 'string') out.projectName = pkg.name.slice(0, 60);
      out.kind = 'node';
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const dep of Object.keys(deps).slice(0, MAX_DEPENDENCIES)) {
        out.dependencies.push(dep);
        const framework = NODE_FRAMEWORKS[dep];
        if (framework) out.frameworks.push(framework);
      }
      for (const ep of [pkg.main, pkg.module, typeof pkg.bin === 'string' ? pkg.bin : undefined]) {
        if (typeof ep === 'string' && ep) out.entryPoints.push(ep.slice(0, 120));
      }
      return out;
    }
    if (name.toLowerCase() === 'go.mod') {
      out.kind = 'go';
      const moduleMatch = content.match(/^module\s+(\S+)/m);
      if (moduleMatch) out.projectName = moduleMatch[1].split('/').pop();
      for (const m of content.matchAll(/^require\s+(?:\(\s*)?([^\s]+)/gm)) {
        out.dependencies.push(m[1]);
      }
      return out;
    }
    if (name.toLowerCase() === 'cargo.toml') {
      out.kind = 'rust';
      const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (nameMatch) out.projectName = nameMatch[1];
      for (const m of content.matchAll(/^([\w-]+)\s*=\s*"?/gm)) {
        if (!['package', 'dependencies', 'dev-dependencies', 'lib', 'bin'].includes(m[1].toLowerCase())) out.dependencies.push(m[1]);
        const framework = RUST_FRAMEWORKS[m[1].toLowerCase()];
        if (framework) out.frameworks.push(framework);
      }
      return out;
    }
    if (name.toLowerCase() === 'pyproject.toml') {
      out.kind = 'python';
      const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (nameMatch) out.projectName = nameMatch[1];
      // PEP 621: dependencies live inside a TOML array — parse the quoted entries.
      const depsBlock = content.match(/dependencies\s*=\s*\[([^\]]*)\]/s);
      if (depsBlock) {
        for (const m of depsBlock[1].matchAll(/"([^"]+)"/g)) {
          const dep = m[1].split(/[><=~^!\s[;]/)[0].trim();
          if (!dep) continue;
          out.dependencies.push(dep);
          const framework = PY_FRAMEWORKS[dep.toLowerCase()];
          if (framework) out.frameworks.push(framework);
        }
      }
      return out;
    }
    if (name.toLowerCase() === 'setup.py' || name.toLowerCase() === 'setup.cfg') {
      out.kind = 'python';
      const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (nameMatch) out.projectName = nameMatch[1];
      for (const m of content.matchAll(/^\s*([a-zA-Z0-9_.-]+?)(?:\[.*?\])?\s*[><=~^]\s*=?\s*[\d.]/gm)) {
        out.dependencies.push(m[1]);
        const framework = PY_FRAMEWORKS[m[1].toLowerCase()];
        if (framework) out.frameworks.push(framework);
      }
      return out;
    }
    if (name.toLowerCase() === 'requirements.txt') {
      out.kind = 'python';
      for (const line of content.split('\n')) {
        const dep = line.trim().split(/[><=~^!\s[#]/)[0];
        if (dep && !dep.startsWith('#') && !dep.startsWith('-')) out.dependencies.push(dep);
        const framework = PY_FRAMEWORKS[dep?.toLowerCase() ?? ''];
        if (framework) out.frameworks.push(framework);
      }
      return out;
    }
    if (/\.csproj$/i.test(name)) {
      out.kind = 'dotnet';
      const nameMatch = content.match(/<AssemblyName>([^<]+)<\/AssemblyName>|<RootNamespace>([^<]+)<\/RootNamespace>/);
      if (nameMatch) out.projectName = (nameMatch[1] ?? nameMatch[2]).slice(0, 60);
      return out;
    }
    if (name.toLowerCase() === 'pom.xml') {
      out.kind = 'java';
      const artifact = content.match(/<artifactId>([^<]+)<\/artifactId>/);
      if (artifact) out.projectName = artifact[1].slice(0, 60);
      for (const m of content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
        out.dependencies.push(m[1]);
      }
      return out;
    }
    if (kindHint === 'node' || name.endsWith('.json')) {
      // Best-effort JSON config: no throw on malformed content.
      JSON.parse(content);
    }
  } catch {
    // corrupted manifest — contribute nothing, never fail the scan
  }
  return out;
}

/**
 * Scan an approved root. `previous` enables incrementality: important files
 * with unchanged signatures are not re-read (readsSaved). Never throws.
 */
export async function scanProject(root: string, fs: ProjectFs, previous?: { importantFiles: ProjectFileRecord[] }): Promise<ScanResult> {
  const languages = new Map<string, number>();
  const frameworks: string[] = [];
  const dependencies: string[] = [];
  const entryPoints: string[] = [];
  const configFiles: string[] = [];
  const modules: ProjectModule[] = [];
  const importantFiles: ProjectFileRecord[] = [];
  const dirDigests: DirDigest[] = [];
  const stats = { filesSeen: 0, filesSkipped: 0, dirsScanned: 0, secretsExcluded: 0, dirsErrored: 0, readsSaved: 0 };
  let projectName: string | undefined;
  let kind: ProjectKind = 'generic';
  const prevByPath = new Map((previous?.importantFiles ?? []).map((f) => [f.path, f]));

  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  while (queue.length > 0 && stats.dirsScanned < MAX_DIRS_SCANNED) {
    const { rel, depth } = queue.shift()!;
    const abs = rel ? `${root}/${rel}` : root;
    const listing = await fs.list(abs);
    if (!listing.ok) {
      stats.dirsErrored += 1;
      continue;
    }
    stats.dirsScanned += 1;

    const entries = sortEntries(listing.entries).slice(0, MAX_ENTRIES_PER_DIR);
    // Directory digest over the bounded, sorted entry shapes.
    dirDigests.push({
      path: rel || '.',
      digest: digestOf(entries.map((e) => `${e.kind}:${e.name}:${e.size}:${Math.round(e.modifiedAt / 1000)}`)),
    });

    const fileCount = entries.filter((e) => e.kind === 'file').length;
    const subdirCount = entries.filter((e) => e.kind === 'directory').length;
    if (rel && modules.length < MAX_MODULES) {
      const segs = rel.split('/');
      if (segs.length <= 2) {
        modules.push({ path: rel, name: segs[segs.length - 1], files: fileCount, subdirs: subdirCount });
      }
    }

    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        if (depth < MAX_DEPTH && !EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
          queue.push({ rel: childRel, depth: depth + 1 });
        }
        continue;
      }

      stats.filesSeen += 1;
      if (isSecretPath(entry.name) || isSecretPath(childRel)) {
        stats.secretsExcluded += 1;
        continue;
      }
      if (entry.size > MAX_PARSE_FILE_BYTES) {
        stats.filesSkipped += 1;
        const lang = languageForExt(extOf(entry.name));
        if (lang) languages.set(lang, (languages.get(lang) ?? 0) + 1);
        continue;
      }

      const role: ProjectFileRole = roleForFile(entry.name, depth);
      const lang = languageForExt(extOf(entry.name));
      if (lang) languages.set(lang, (languages.get(lang) ?? 0) + 1);

      const sig = fileSig(entry.size, entry.modifiedAt);
      const important = role === 'manifest' || role === 'doc' || role === 'entry' || isManifestName(entry.name) || isEntryCandidate(entry.name.toLowerCase(), depth);
      const wantsParse = isManifestName(entry.name) || entry.name.toLowerCase() === 'package.json';
      const wantsRecord = important || role === 'config';

      if (wantsRecord && importantFiles.length < MAX_IMPORTANT_FILES) {
        const prev = prevByPath.get(childRel);
        let content: string | undefined;
        if (entry.size <= MAX_READ_BYTES && (wantsParse || role === 'manifest' || !prev || prev.sig !== sig)) {
          if (prev && prev.sig === sig && !wantsParse && role !== 'manifest') {
            stats.readsSaved += 1;
          } else {
            const read = await fs.readHead(abs + '/' + entry.name, MAX_READ_BYTES);
            if (read.ok) {
              if (isSecretContent(read.content ?? '')) {
                // Private-key-shaped content: treat the file as a secret —
                // never record it, never keep its content.
                stats.secretsExcluded += 1;
                continue;
              }
              content = read.content;
            }
          }
        } else if (prev && prev.sig === sig) {
          stats.readsSaved += 1;
        }
        importantFiles.push({ path: childRel, name: entry.name, role, size: entry.size, sig });
        if (role === 'config' && configFiles.length < 10) configFiles.push(childRel);
        if (content !== undefined) {
          const parsed = parseManifest(kind, entry.name, content);
          if (parsed.projectName && !projectName) projectName = parsed.projectName;
          if (parsed.kind && kind === 'generic') kind = parsed.kind;
          for (const f of parsed.frameworks) if (frameworks.length < MAX_FRAMEWORKS) pushBounded(frameworks, f, MAX_FRAMEWORKS);
          for (const d of parsed.dependencies) if (dependencies.length < MAX_DEPENDENCIES) pushBounded(dependencies, d, MAX_DEPENDENCIES);
          for (const e of parsed.entryPoints) if (entryPoints.length < 8) pushBounded(entryPoints, e, 8);
        }
        // Root package.json name doubles as the project name for node projects.
        if (!projectName && rel === '' && entry.name.toLowerCase() === 'package.json' && content) {
          try {
            const pkg = JSON.parse(content) as PackageJsonShape;
            if (pkg.name) projectName = pkg.name.slice(0, 60);
          } catch {
            // handled above
          }
        }
      } else {
        stats.filesSkipped += 1;
      }

      // Known entry-point file names become entry points even without a manifest.
      if (isEntryCandidate(entry.name.toLowerCase(), depth) && entryPoints.length < 8) {
        pushBounded(entryPoints, childRel, 8);
      }
    }
  }

  if (!projectName) projectName = root.split(/[\\/]/).filter(Boolean).pop() || 'project';

  const languagesOut: ProjectLanguageStat[] = [...languages.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_LANGUAGES)
    .map(([language, files]) => ({ language, files }));

  return {
    name: projectName,
    kind,
    languages: languagesOut,
    frameworks: frameworks.slice(0, MAX_FRAMEWORKS),
    dependencies: dependencies.slice(0, MAX_DEPENDENCIES),
    entryPoints: entryPoints.slice(0, 8),
    configFiles: configFiles.slice(0, 10),
    modules: modules.slice(0, MAX_MODULES),
    importantFiles: importantFiles.slice(0, MAX_IMPORTANT_FILES),
    dirDigests: dirDigests.slice(0, MAX_DIR_DIGESTS),
    stats,
  };
}

/**
 * Cheap change detection against a stored profile: fresh directory digests
 * plus a diff over the important-file signatures. Never throws; a failed
 * listing reports the directory as errored rather than changed.
 */
export async function detectChanges(
  root: string,
  fs: ProjectFs,
  stored: { name: string; importantFiles: ProjectFileRecord[]; dirDigests: DirDigest[] }
): Promise<{ changedDirs: string[]; added: string[]; removed: string[]; modified: string[]; unchanged: boolean; errors: number }> {
  const prevDirs = new Map(stored.dirDigests.map((d) => [d.path, d.digest]));
  const prevFiles = new Map(stored.importantFiles.map((f) => [f.path, f.sig]));
  const changedDirs: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  let errors = 0;

  // Re-walk with the same bounds, comparing digests; important-file sigs diff.
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  let scanned = 0;
  const seenPaths = new Set<string>();
  while (queue.length > 0 && scanned < MAX_DIRS_SCANNED) {
    const { rel, depth } = queue.shift()!;
    const abs = rel ? `${root}/${rel}` : root;
    const listing = await fs.list(abs);
    if (!listing.ok) {
      errors += 1;
      continue;
    }
    scanned += 1;
    const entries = sortEntries(listing.entries).slice(0, MAX_ENTRIES_PER_DIR);
    const digest = digestOf(entries.map((e) => `${e.kind}:${e.name}:${e.size}:${Math.round(e.modifiedAt / 1000)}`));
    const dirKey = rel || '.';
    if (prevDirs.get(dirKey) !== digest) changedDirs.push(dirKey);

    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        if (depth < MAX_DEPTH && !EXCLUDED_DIRS.has(entry.name.toLowerCase())) queue.push({ rel: childRel, depth: depth + 1 });
        continue;
      }
      if (isSecretPath(entry.name) || isSecretPath(childRel)) continue;
      const sig = fileSig(entry.size, entry.modifiedAt);
      if (!prevFiles.has(childRel)) {
        // Newly appeared file that WOULD be tracked (important role).
        const role = roleForFile(entry.name, depth);
        if (role === 'manifest' || role === 'doc' || role === 'entry' || role === 'config' || isManifestName(entry.name)) {
          added.push(childRel);
        }
        continue;
      }
      seenPaths.add(childRel);
      if (prevFiles.get(childRel) !== sig) modified.push(childRel);
    }
  }

  for (const [path] of prevFiles) {
    if (!seenPaths.has(path)) removed.push(path);
  }
  // Important files the walk never recorded before are additions (only for
  // tracked roles — approximated by the modified/removed sets plus new digests).
  const unchanged = changedDirs.length === 0 && modified.length === 0 && removed.length === 0 && errors === 0;
  return { changedDirs: changedDirs.slice(0, 40), added: added.slice(0, 40), removed: removed.slice(0, 40), modified: modified.slice(0, 40), unchanged, errors };
}
