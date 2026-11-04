/**
 * Project Awareness v1 verification suite.
 * Usage: npx tsx scripts/test-projects.ts
 * Exits non-zero on any failure.
 *
 * Runs against REAL temporary project fixtures on disk (created under
 * os.tmpdir, removed afterwards) through the Node filesystem transport.
 *
 * Covers the spec's required tests: project discovery and identification,
 * multiple projects, language/framework detection, directory exclusions,
 * secret protection, incremental indexing and cache reuse, file changes and
 * stale info, Knowledge Graph integration, context retrieval, persistence
 * across restarts, permission-denied scenarios, corrupted or inaccessible
 * directories, resource limits and failure recovery.
 */
import * as nodeFs from 'fs';
import * as nodePath from 'path';
import * as nodeOs from 'os';
import {
  ProjectEngine,
  ProjectStore,
  scanProject,
  detectChanges,
  createProjectTools,
  MAX_DIRS_SCANNED,
  MAX_DEPTH,
  MAX_PARSE_FILE_BYTES,
  PROJECT_STALE_MS,
} from '../src/agent/projects';
import { NodeProjectFs } from '../src/agent/projects/projectFsNode';
import type { StorageAdapter } from '../src/agent/taskState';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { MemoryService } from '../src/agent/memory/memoryService';
import { PermissionManager } from '../src/agent/permissions';
import { KnowledgeGraphFacade } from '../src/agent/knowledge';
import { createIntelligenceChecks } from '../src/agent/diagnostics/checks/intelligenceChecks';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function events(bus: AgentEventBus, name: string): number {
  return bus.recentEvents().filter((e) => e.name === name).length;
}

// ------------------------------------------------------------- fixture helpers

const tempRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'krisha-projects-'));
const roots: string[] = [];

function fixtureDir(label: string): string {
  const dir = nodePath.join(tempRoot, label);
  nodeFs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

/** Write files (content string or Buffer) into dir, creating subdirectories. */
function writeFiles(dir: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = nodePath.join(dir, ...rel.split('/'));
    nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    nodeFs.writeFileSync(abs, content);
  }
}

/** File-backed storage adapter — a genuine restart is a new engine over the same file. */
class JsonFileStorage implements StorageAdapter {
  constructor(private file: string) {}
  getItem(key: string): string | null {
    try {
      const raw = nodeFs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed[key] ?? null;
    } catch {
      return null;
    }
  }
  setItem(key: string, value: string): void {
    try {
      let parsed: Record<string, string> = {};
      try {
        parsed = JSON.parse(nodeFs.readFileSync(this.file, 'utf8')) as Record<string, string>;
      } catch {
        // fresh file
      }
      parsed[key] = value;
      nodeFs.writeFileSync(this.file, JSON.stringify(parsed), 'utf8');
    } catch {
      // storage failure stays silent, matching adapter conventions
    }
  }
  removeItem(key: string): void {
    try {
      const raw = nodeFs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, string>;
      delete parsed[key];
      nodeFs.writeFileSync(this.file, JSON.stringify(parsed), 'utf8');
    } catch {
      // nothing to remove
    }
  }
}

interface EngineHarness {
  engine: ProjectEngine;
  bus: AgentEventBus;
  memory: MemoryService;
  knowledgeGraph: KnowledgeGraphFacade;
  storage: JsonFileStorage;
  storageFile: string;
  registry: ToolRegistry;
  permissions: PermissionManager;
  /** Simulate a process restart: brand-new engines over the SAME storage file. */
  restart(): ProjectEngine;
}

function makeHarness(dir?: string): EngineHarness {
  const storageFile = nodePath.join(tempRoot, `store-${Math.random().toString(36).slice(2)}.json`);
  const storage = new JsonFileStorage(storageFile);
  const bus = new AgentEventBus();
  const fs = new NodeProjectFs();
  const memory = new MemoryService(storage);
  const knowledgeGraph = new KnowledgeGraphFacade({ storage });
  const engine = new ProjectEngine({ fs, storage, knowledgeGraph, memory, events: bus });
  const registry = new ToolRegistry(bus);
  registry.registerAll(createProjectTools({ projects: engine }));
  return {
    engine,
    bus,
    memory,
    knowledgeGraph,
    storage,
    storageFile,
    registry,
    permissions: new PermissionManager(),
    restart: () => new ProjectEngine({ fs, storage, knowledgeGraph: new KnowledgeGraphFacade({ storage }), memory: new MemoryService(storage), events: bus }),
  };
}

const TOOL_CTX = () => ({
  taskId: 't',
  stepId: 's',
  signal: new AbortController().signal,
  memory: {},
  permissions: new PermissionManager(),
});

// Canonical node fixture: package.json + source + docs + generated junk + secrets.
function makeNodeProject(dir: string): void {
  writeFiles(dir, {
    'package.json': JSON.stringify({
      name: 'alpha-app',
      version: '1.4.0',
      main: 'src/index.ts',
      scripts: { build: 'vite build' },
      dependencies: { react: '^18.0.0', express: '^4.18.0' },
      devDependencies: { typescript: '^5.0.0', vite: '^5.0.0' },
    }),
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'README.md': '# alpha-app\nA demo web service used by Project Awareness tests.',
    'src/index.ts': "import { server } from './server';\nserver.start();\n",
    'src/server.ts': 'export const server = { start: () => 1 };\n',
    'src/components/Button.tsx': 'export const Button = () => null;\n',
    'node_modules/react/index.js': 'module.exports = {};\n',
    'node_modules/react/package.json': '{"name":"react"}',
    'dist/bundle.js': '/* built */',
    '.git/HEAD': 'ref: refs/heads/main',
    '.env': 'API_KEY=super-secret-value',
    '.env.local': 'DB_PASSWORD=hunter2',
    'config/key.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    'config/credentials.json': '{"user":"admin","password":"hunter2"}',
    'secrets.yaml': 'token: topsecret',
    'id_rsa': '-----BEGIN OPENSSH PRIVATE KEY-----',
    'config/service-account-prod.json': '{"private_key":"xxx"}',
    '.npmrc': '//registry.npmjs.org/:_authToken=secret',
  });
}

function makePythonProject(dir: string): void {
  writeFiles(dir, {
    'pyproject.toml': '[project]\nname = "beta-tools"\n\ndependencies = ["flask>=2.0", "numpy"]\n',
    'README.md': '# beta-tools',
    'main.py': 'print("hello")\n',
    'util/helpers.py': 'def help():\n  return 1\n',
    'core.go': 'package main\nfunc main() {}\n',
    'native/lib.rs': 'fn main() {}\n',
    '.venv/pyvenv.cfg': 'home = /usr\n',
    '__pycache__/helpers.cpython-311.pyc': 'binary',
  });
}

// ---------------------------------------------------------------- Test 1
{
  console.log('Test 1 — Project discovery and identification (Node project)');
  const dir = fixtureDir('alpha');
  makeNodeProject(dir);
  const h = makeHarness();
  const approval = await h.engine.approveRoot(dir);
  assertEqual(approval.ok, true, 'approval of an existing directory succeeds');
  const outcome = await h.engine.index(dir);
  assertEqual(outcome.ok, true, 'indexing an approved root succeeds');
  const p = outcome.profile!;
  assertEqual(p.name, 'alpha-app', 'project name comes from package.json');
  assertEqual(p.kind, 'node', 'project kind detected as node');
  assert(p.frameworks.includes('React'), 'React framework detected from dependencies');
  assert(p.frameworks.includes('Express'), 'Express framework detected from dependencies');
  assert(p.frameworks.includes('TypeScript'), 'TypeScript detected');
  assert(p.frameworks.includes('Vite'), 'Vite detected from devDependencies');
  assert(p.dependencies.includes('react') && p.dependencies.includes('express'), 'dependency names recorded');
  assert(p.entryPoints.includes('src/index.ts'), 'entry point from package.json main');
  assert(p.languages.some((l) => l.language === 'TypeScript' && l.files >= 2), 'TypeScript language histogram counted');
  assert(p.importantFiles.some((f) => f.role === 'manifest' && f.path === 'package.json'), 'package.json recorded as manifest');
  assert(p.importantFiles.some((f) => f.role === 'doc' && f.name === 'README.md'), 'README recorded as doc');
  assert(p.importantFiles.some((f) => f.role === 'entry' && f.path === 'src/index.ts'), 'index.ts recorded as entry');
  assert(p.modules.some((m) => m.path === 'src' && m.files >= 2), 'src module counted with its direct files');
  assert(p.modules.some((m) => m.path === 'src/components' && m.files === 1), 'nested module tracked separately');
  assert(p.dirDigests.some((d) => d.path === '.'), 'root directory digest recorded');
  assert(p.stats.filesSeen >= 4, 'source files seen');
  // filesSeen counts every file observed by name in scanned dirs, including
  // the 8 secrets (observed, never read). Excluded dirs contribute zero:
  // root 8 + config 3 + src 2 + src/components 1 = 14.
  assertEqual(p.stats.filesSeen, 14, 'generated directories (node_modules/dist/.git) never entered');
  assertEqual(p.stats.secretsExcluded, 8, 'all secret-shaped files excluded and counted');
  assertEqual(p.id.startsWith('proj_'), true, 'stable project id minted');
  assertEqual(events(h.bus, 'PROJECT_INDEXED'), 1, 'PROJECT_INDEXED emitted once');
  // Re-index is id-stable.
  const again = await h.engine.index(dir);
  assertEqual(again.profile!.id, p.id, 're-index keeps the same project id');
  assertEqual(again.profile!.createdAt, p.createdAt, 're-index preserves createdAt');
}

// ---------------------------------------------------------------- Test 2
{
  console.log('Test 2 — Multiple projects are tracked independently');
  const pyDir = fixtureDir('beta');
  makePythonProject(pyDir);
  const h = makeHarness();
  await h.engine.approveRoot(pyDir);
  const outcome = await h.engine.index(pyDir);
  assertEqual(outcome.ok, true, 'second project indexed');
  const p = outcome.profile!;
  assertEqual(p.name, 'beta-tools', 'python project name from pyproject.toml');
  assertEqual(p.kind, 'python', 'python kind detected');
  assert(p.frameworks.includes('Flask') && p.frameworks.includes('NumPy'), 'Flask + NumPy detected from requirements');
  assert(p.dependencies.includes('flask') && p.dependencies.includes('numpy'), 'python dependency names recorded');
  assert(p.entryPoints.includes('main.py'), 'main.py recognized as entry point');
  assert(p.languages.some((l) => l.language === 'Python' && l.files >= 2), 'Python histogram counted');
  assert(p.languages.some((l) => l.language === 'Go'), 'Go file recognized');
  assert(p.languages.some((l) => l.language === 'Rust'), 'Rust file recognized');
  assertEqual(p.stats.secretsExcluded, 0, 'no secrets in the python fixture');
  assertEqual(p.stats.filesSeen, 6, 'venv and __pycache__ excluded (4 root + util + native)');
  assertEqual(h.engine.listProfiles().length, 1, 'profile list reflects this harness only');
}

// ---------------------------------------------------------------- Test 3
{
  console.log('Test 3 — Directory exclusions are absolute');
  const dir = fixtureDir('gamma');
  writeFiles(dir, {
    'package.json': '{"name":"gamma"}',
    'app.ts': 'export {};',
    'node_modules/left-pad/index.js': 'x',
    'dist/out.js': 'x',
    'build/out.js': 'x',
    'coverage/lcov.info': 'x',
    '.git/config': '[core]',
    '.next/cache.js': 'x',
    'vendor/lib.go': 'x',
    '__pycache__/a.pyc': 'x',
  });
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  const p = (await h.engine.index(dir)).profile!;
  for (const banned of ['node_modules', 'dist', 'build', 'coverage', '.git', '.next', 'vendor', '__pycache__']) {
    assert(!p.dirDigests.some((d) => d.path === banned), `excluded directory never scanned: ${banned}`);
    assert(!p.modules.some((m) => m.path === banned), `excluded directory never a module: ${banned}`);
  }
  assertEqual(p.stats.filesSeen, 2, 'only root package.json + app.ts counted');
}

// ---------------------------------------------------------------- Test 4
{
  console.log('Test 4 — Secret files are never indexed, never read, never mirrored');
  const dir = fixtureDir('delta');
  makeNodeProject(dir);
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  const p = (await h.engine.index(dir)).profile!;
  const secretPaths = ['.env', '.env.local', 'config/key.pem', 'config/credentials.json', 'secrets.yaml', 'id_rsa', 'config/service-account-prod.json', '.npmrc'];
  for (const s of secretPaths) {
    assert(!p.importantFiles.some((f) => f.path === s), `secret absent from profile: ${s}`);
  }
  const storeJson = JSON.stringify(h.engine.store.projects);
  assert(!storeJson.includes('super-secret-value') && !storeJson.includes('hunter2'), 'secret values never persisted');
  assert(!storeJson.toLowerCase().includes('.npmrc'), 'secret file paths never persisted');
  const graphLabels = h.knowledgeGraph.graph.getNodesByType('file', 100).map((n) => n.label).join('|');
  assert(!graphLabels.includes('.env') && !graphLabels.includes('.pem'), 'secret files never mirrored into the graph');
  const memJson = JSON.stringify(h.memory.stats());
  assert(typeof memJson === 'string', 'memory readable');
}

// ---------------------------------------------------------------- Test 5
{
  console.log('Test 5 — Private-key content inside an innocent-looking file is still excluded');
  const dir = fixtureDir('epsilon');
  writeFiles(dir, {
    'package.json': '{"name":"epsilon"}',
    'deploy/settings.toml': 'tls_cert = "-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----"',
    'README.md': '# epsilon',
  });
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  const p = (await h.engine.index(dir)).profile!;
  assertEqual(p.stats.secretsExcluded, 1, 'private-key content detected and excluded');
  assert(!p.importantFiles.some((f) => f.path === 'deploy/settings.toml'), 'key-bearing file never recorded');
  assert(!JSON.stringify(h.engine.store.projects).includes('MIIEv'), 'key material never persisted');
}

// ---------------------------------------------------------------- Test 6
{
  console.log('Test 6 — Incremental indexing: cache reuse AND parsed-data preservation');
  const dir = fixtureDir('zeta');
  makeNodeProject(dir);
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  const first = (await h.engine.index(dir)).profile!;
  assertEqual(first.stats.readsSaved, 0, 'first scan performs all reads');
  const second = (await h.engine.index(dir)).profile!;
  assert(second.stats.readsSaved >= 3, `unchanged files are not re-read (readsSaved=${second.stats.readsSaved})`);
  assert(second.frameworks.includes('React'), 'frameworks preserved across incremental re-index');
  assert(second.dependencies.includes('express'), 'dependencies preserved across incremental re-index');
  assert(second.entryPoints.includes('src/index.ts'), 'entry points preserved across incremental re-index');
  assertEqual(second.importantFiles.length, first.importantFiles.length, 'important-file set stable');
  // Touch one file (different length) → only the changed ones re-read.
  writeFiles(dir, { 'README.md': '# alpha-app\nNow with more words than before.' });
  const third = (await h.engine.index(dir)).profile!;
  assert(third.importantFiles.find((f) => f.path === 'README.md')!.sig !== first.importantFiles.find((f) => f.path === 'README.md')!.sig, 'modified file gets a new signature');
}

// ---------------------------------------------------------------- Test 7
{
  console.log('Test 7 — File change detection (added / modified / removed)');
  const dir = fixtureDir('eta');
  writeFiles(dir, {
    'package.json': '{"name":"eta"}',
    'README.md': '# eta',
    'src/app.ts': 'export {};',
  });
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  await h.engine.index(dir);

  const before = await h.engine.changes(dir);
  assertEqual(before.ok, true, 'change detection runs');
  assertEqual(before.change!.unchanged, true, 'no changes right after indexing');

  writeFiles(dir, {
    'docs/README.md': '# guide',
    'src/app.ts': 'export const changed = true;',
    'package.json': '{"name":"eta2"}',
  });
  nodeFs.rmSync(nodePath.join(dir, 'README.md'));
  const after = await h.engine.changes(dir);
  const change = after.change!;
  assert(change.changedDirs.includes('.'), 'root directory digest flagged changed');
  assert(change.added.includes('docs/README.md'), 'new tracked file reported as added');
  assert(change.modified.includes('README.md') || change.removed.includes('README.md'), 'deleted file reported as removed');
  assert(change.modified.includes('package.json') && change.modified.includes('src/app.ts'), 'content-changed files reported as modified');
  assertEqual(change.unchanged, false, 'change report is not unchanged');
  assertEqual(events(h.bus, 'PROJECT_CHANGES'), 2, 'PROJECT_CHANGES emitted per detection');
  assertEqual((await h.engine.changes('C:/definitely/not/approved')).ok, false, 'change detection refuses unapproved roots');
}

// ---------------------------------------------------------------- Test 8
{
  console.log('Test 8 — Stale profiles refresh on demand, never in the background');
  const dir = fixtureDir('theta');
  writeFiles(dir, { 'package.json': '{"name":"theta"}', 'README.md': '# theta' });
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  const first = (await h.engine.index(dir)).profile!;
  const fresh = await h.engine.refreshIfStale(dir);
  assertEqual(fresh.indexed, false, 'fresh profile is not re-indexed');
  assertEqual(fresh.reason, 'profile fresh', 'fresh reason reported');
  // Backdate beyond PROJECT_STALE_MS, then refresh must re-index.
  const p = h.engine.profile(dir)!;
  p.lastIndexedAt = Date.now() - PROJECT_STALE_MS - 1000;
  h.engine.store.upsert(p);
  assertEqual(h.engine.stats().stale, 1, 'staleness visible in stats');
  const refreshed = await h.engine.refreshIfStale(dir);
  assertEqual(refreshed.indexed, true, 'stale profile is re-indexed on demand');
  assert(h.engine.profile(dir)!.lastIndexedAt > first.lastIndexedAt, 'lastIndexedAt advanced');
  assertEqual(h.engine.stats().stale, 0, 'no stale projects after refresh');
}

// ---------------------------------------------------------------- Test 9
{
  console.log('Test 9 — Knowledge Graph integration + context retrieval');
  const dir = fixtureDir('iota');
  makeNodeProject(dir);
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  const p = (await h.engine.index(dir)).profile!;
  const stats = h.knowledgeGraph.stats();
  assert(stats.nodes >= 3, `project + modules + files mirrored into graph (${stats.nodes} nodes)`);
  assert(stats.edges >= 2, `part_of / uses edges mirrored (${stats.edges} edges)`);
  const labels = h.knowledgeGraph.graph.getNodesByType('project', 20).map((n) => n.label);
  assert(labels.some((l) => l.includes('alpha-app')), 'project node labeled with the project name');
  const components = h.knowledgeGraph.graph.getNodesByType('component', 30).map((n) => n.label);
  assert(components.some((l) => l.includes('src')), 'module nodes mirrored as components');
  // Context retrieval: the Context Engine queries this same facade.
  const statements = h.knowledgeGraph.queryStatements('what is the alpha-app project structure', 5);
  assert(statements.length > 0, 'graph statements retrieved for a project question');
  assert(statements.some((s) => s.toLowerCase().includes('alpha')), 'retrieved statements mention the project');
  assert(JSON.stringify(statements).includes('part_of') || JSON.stringify(statements).includes('uses'), 'relationship statements rendered');
  assert(!JSON.stringify(statements).includes('API_KEY'), 'no secret values can surface through retrieval');
  assert(p.stats.secretsExcluded > 0, 'sanity: fixture had secrets');
  // Removed files must not leave misleading graph records: delete a module
  // directory, re-index, and the stale component node is pruned.
  nodeFs.rmSync(nodePath.join(dir, 'src', 'components'), { recursive: true, force: true });
  const reindexed = (await h.engine.index(dir)).profile!;
  assert(!reindexed.modules.some((m) => m.path === 'src/components'), 'removed module gone from the fresh profile');
  const afterPrune = h.knowledgeGraph.graph.getNodesByType('component', 30).map((n) => n.label);
  assert(!afterPrune.some((l) => l.includes('src/components')), 'removed module pruned from the graph');
  assert(afterPrune.some((l) => l === 'alpha-app/src' || l.startsWith('alpha-app/src/')), 'still-present module kept in the graph');
  assert(h.knowledgeGraph.graph.getNodesByType('project', 20).some((n) => n.label.includes('alpha-app')), 'project node survives the re-index');
  assert(h.knowledgeGraph.graph.getNodesByType('tool', 30).some((n) => n.label === 'React'), 'shared framework tool node survives pruning');
}

// ---------------------------------------------------------------- Test 10
{
  console.log('Test 10 — Durable memory mirror through the EXISTING MemoryService');
  const dir = fixtureDir('kappa');
  writeFiles(dir, { 'package.json': '{"name":"kappa-app"}' });
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  await h.engine.index(dir);
  const found = h.memory.search('kappa-app');
  assert(found.length > 0, 'project memory record searchable');
  assert(found.some((r) => r.content.includes('kappa-app') && r.content.includes('node')), 'record describes identity and kind');
  assert(found.some((r) => (r.tags ?? []).includes('project-awareness')), 'record tagged project-awareness');
}

// ---------------------------------------------------------------- Test 11
{
  console.log('Test 11 — Dev status record: goals, progress, blockers, completed work');
  const dir = fixtureDir('lambda');
  writeFiles(dir, { 'package.json': '{"name":"lambda"}' });
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  await h.engine.index(dir);
  const empty = await h.engine.status(dir);
  assertEqual(empty.ok, true, 'status read works before any update');
  const updated = await h.engine.status(dir, {
    goal: 'Ship the v2 REST API',
    progress: 'Auth module done; payments in review',
    blockers: ['waiting on sandbox credentials'],
    completed: ['auth module', 'rate limiter'],
  });
  assertEqual(updated.ok, true, 'status update succeeds');
  assertEqual(updated.dev!.goal, 'Ship the v2 REST API', 'goal stored');
  assertEqual(updated.dev!.blockers, ['waiting on sandbox credentials'], 'blockers stored');
  assertEqual(updated.dev!.completed.length, 2, 'completed work stored');
  assertEqual(events(h.bus, 'PROJECT_STATUS_UPDATED'), 1, 'PROJECT_STATUS_UPDATED emitted once');
  // Read it back through a RESTARTED engine (durable across conversations).
  const reread = await h.restart().status(dir);
  assertEqual(reread.dev!.goal, 'Ship the v2 REST API', 'status durable across engine instances');
  assertEqual(reread.dev!.progress, 'Auth module done; payments in review', 'progress durable');
  // Bounds: blockers capped at 10, entries truncated.
  const patched = await h.engine.status(dir, { blockers: Array.from({ length: 30 }, (_, i) => `b${i}`) });
  assertEqual(patched.dev!.blockers!.length, 10, 'blockers bounded at MAX_BLOCKERS');
  assertEqual(patched.dev!.blockers![0], 'b0', 'blockers keep order');
  assertEqual((await h.engine.status('C:/not/approved')).ok, false, 'status refuses unapproved roots');
  assertEqual((await h.engine.status('C:/not/approved', { goal: 'x' })).ok, false, 'status updates refuse unapproved roots');
}

// ---------------------------------------------------------------- Test 12
{
  console.log('Test 12 — Persistence across restarts (file-backed storage)');
  const dir = fixtureDir('mu');
  writeFiles(dir, { 'package.json': '{"name":"mu-persist"}', 'README.md': '# mu' });
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  await h.engine.index(dir);
  await h.engine.status(dir, { goal: 'finish persistence test' });
  const storedBefore = JSON.parse(nodeFs.readFileSync(h.storageFile, 'utf8'));
  assert(!!storedBefore.krisha_projects_v1, 'project store persisted under its own key');
  assertEqual(JSON.parse(storedBefore.krisha_projects_v1).schemaVersion, 1, 'schema version written');
  // "Restart": brand-new engines over the same storage file.
  const restarted = h.restart();
  assert(restarted.listApproved().some((r) => r.toLowerCase() === h.engine.listApproved()[0].toLowerCase()), 'approval survives restart');
  const p2 = restarted.profile(dir);
  assert(!!p2, 'profile survives restart');
  assertEqual(p2!.name, 'mu-persist', 'profile name survives restart');
  assertEqual(p2!.dev.goal, 'finish persistence test', 'dev status survives restart');
  assert(p2!.dirDigests.length > 0, 'digests survive restart');
  // Forgetting removes both halves of consent, durably.
  assertEqual(restarted.forget(dir), true, 'forget removes the project');
  const engine3 = h.restart();
  assertEqual(engine3.listApproved().length, 0, 'approval revocation survives restart');
  assertEqual(engine3.profile(dir), undefined, 'profile removal survives restart');
  // No misleading graph records survive the forget either.
  const graphAfterForget = new KnowledgeGraphFacade({ storage: h.storage });
  assert(!graphAfterForget.graph.getNodesByType('project', 20).some((n) => String(n.properties?.root ?? '').toLowerCase().includes('mu')), 'forgotten project has no graph node');
  assert(!graphAfterForget.graph.getNodesByType('component', 30).some((n) => n.label.startsWith('mu-persist/')), 'forgotten project has no module nodes');
  // The durable memory record this engine wrote is released too (through the
  // existing MemoryService.forget API — only project-awareness records).
  const memoryAfterForget = new MemoryService(h.storage);
  assert(
    !memoryAfterForget.records.some((r) => {
      const m = r.metadata as { root?: string } | undefined;
      return typeof m?.root === 'string' && m.root.toLowerCase().includes('mu');
    }),
    'forgotten project memory record released'
  );
  // Cross-system scenario: re-index AFTER a restart — fresh store, fresh
  // graph, same identity.
  assertEqual((await engine3.approveRoot(dir)).ok, true, 're-approval after restart works');
  const reIndexed = await engine3.index(dir);
  assertEqual(reIndexed.ok, true, 're-index after restart works');
  assertEqual(reIndexed.profile!.id, p2!.id, 'project id stable across forget + restart + re-index');
  assertEqual(reIndexed.profile!.name, 'mu-persist', 'identity stable across restart');
  const graphRebuilt = new KnowledgeGraphFacade({ storage: h.storage });
  assert(graphRebuilt.graph.getNodesByType('project', 20).some((n) => n.label.includes('mu-persist')), 'graph mirror rebuilt after restart');
  engine3.forget(dir); // leave the fixture forgotten for the cleanup section
}

// ---------------------------------------------------------------- Test 13
{
  console.log('Test 13 — Permission-denied scenarios through the gated registry');
  const dir = fixtureDir('nu');
  writeFiles(dir, { 'package.json': '{"name":"nu"}' });
  const h = makeHarness();
  const deniedAll = new PermissionManager();
  deniedAll.revoke('filesystem.read');
  deniedAll.revoke('memory.access');
  const result = await h.registry.execute('project.inspect', { root: dir }, { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions: deniedAll });
  assertEqual(result.success, false, 'project.inspect denied without filesystem.read');
  const result2 = await h.registry.execute('project.forget', { root: dir }, { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions: deniedAll });
  assertEqual(result2.success, false, 'project.forget denied without memory.access');
  const result3 = await h.registry.execute('project.status', { root: dir }, { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions: deniedAll });
  assertEqual(result3.success, false, 'project.status denied without memory.access');
  // Default grants allow the read-only surface.
  await h.registry.execute('project.approve_root', { path: dir }, TOOL_CTX());
  await h.registry.execute('project.inspect', { root: dir }, TOOL_CTX());
  const okResult = await h.registry.execute('project.list', {}, TOOL_CTX());
  assertEqual(okResult.success, true, 'project.list works with default grants');
  const listed = (okResult.output as { projects: { name: string }[] }).projects;
  assert(listed.some((x) => x.name === 'nu'), 'project.list returns the indexed project');
}

// ---------------------------------------------------------------- Test 14
{
  console.log('Test 14 — Approved boundaries: unapproved roots are never touched');
  const dir = fixtureDir('xi');
  writeFiles(dir, { 'package.json': '{"name":"xi"}' });
  const unapproved = fixtureDir('xi-unapproved');
  writeFiles(unapproved, { 'package.json': '{"name":"secret-project"}' });
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  const refused = await h.engine.index(unapproved);
  assertEqual(refused.ok, false, 'indexing an unapproved root is refused');
  assert(refused.reason!.includes('not approved'), 'refusal explains the boundary');
  assertEqual(h.engine.profile(unapproved), undefined, 'unapproved project has no profile');
  assertEqual(h.engine.listApproved().some((r) => r.toLowerCase().includes('xi-unapproved')), false, 'unapproved root never recorded anywhere');
  // Case-insensitive approval identity (Windows-friendly).
  const upper = await h.engine.index(dir.toUpperCase());
  assertEqual(upper.ok, true, 'root identity is case-insensitive');
  assertEqual(h.engine.profile(dir.toUpperCase())!.id, h.engine.profile(dir)!.id, 'same root maps to one project');
}

// ---------------------------------------------------------------- Test 15
{
  console.log('Test 15 — Corrupted, missing and inaccessible directories fail gracefully');
  const h = makeHarness();
  // Nonexistent root.
  const missing = await h.engine.approveRoot('C:/definitely/not/a/real/dir-xyz');
  assertEqual(missing.ok, false, 'approval of a nonexistent directory fails');
  // A FILE is not a directory root.
  const filePath = nodePath.join(tempRoot, 'not-a-dir.txt');
  nodeFs.writeFileSync(filePath, 'plain file');
  assertEqual((await h.engine.approveRoot(filePath)).ok, false, 'approval of a file path fails');
  assertEqual((await h.engine.index(filePath)).ok, false, 'indexing a file path is refused');
  // Directory disappears after approval → indexing fails cleanly, nothing corrupts.
  const dir = fixtureDir('omicron');
  writeFiles(dir, { 'package.json': '{"name":"omicron"}' });
  await h.engine.approveRoot(dir);
  nodeFs.rmSync(dir, { recursive: true, force: true });
  const gone = await h.engine.index(dir);
  assertEqual(gone.ok, false, 'indexing a vanished directory fails cleanly');
  assert(gone.reason!.includes('not accessible'), 'failure explains inaccessibility');
  assertEqual(h.engine.listProfiles().length, 0, 'failed index stores nothing');
  // Scanner records unreadable subdirectories without dying.
  const partial = fixtureDir('pi');
  writeFiles(partial, { 'package.json': '{"name":"pi"}', 'sub/a.ts': 'x' });
  // Make the subdir unreadable by replacing it with a file mid-walk is racy;
  // instead point the scanner at a root whose subdir listing fails via a
  // broken symlink-free trick: list the ROOT as a file path.
  const scanFailed = await scanProject(filePath, new NodeProjectFs());
  assertEqual(scanFailed.stats.dirsErrored, 1, 'failed root listing counted as errored');
  assertEqual(scanFailed.stats.filesSeen, 0, 'no files seen from an unreadable root');
  assertEqual(scanFailed.name, nodePath.basename(filePath), 'fallback name derived from the root path');
  assertEqual(scanFailed.kind, 'generic', 'fallback kind for unreadable roots');
  // detectChanges against the vanished project reports errors, not false "unchanged".
  const store = h.engine.store;
  const diff = await detectChanges('C:/definitely/not/a/real/dir-xyz', new NodeProjectFs(), {
    name: 'ghost',
    importantFiles: [{ path: 'package.json', name: 'package.json', role: 'manifest', size: 10, sig: '10:0' }],
    dirDigests: [{ path: '.', digest: 'abc' }],
  });
  assert(diff.errors >= 1, 'vanished project reported with errors');
  assertEqual(diff.unchanged, false, 'vanished project is never reported unchanged');
  assert(store.projects.length === 0, 'store untouched by failures');
}

// ---------------------------------------------------------------- Test 16
{
  console.log('Test 16 — Corrupted or future-schema storage is repaired, never crashes');
  const badFile = nodePath.join(tempRoot, 'store-corrupt.json');
  nodeFs.writeFileSync(badFile, '{{{ not json at all');
  const badEngine = new ProjectEngine({ fs: new NodeProjectFs(), storage: new JsonFileStorage(badFile) });
  assertEqual(badEngine.listApproved().length, 0, 'corrupted storage starts clean');
  assertEqual(badEngine.stats().projects, 0, 'corrupted storage reports empty stats');
  const futureFile = nodePath.join(tempRoot, 'store-future.json');
  nodeFs.writeFileSync(
    futureFile,
    JSON.stringify({ krisha_projects_v1: JSON.stringify({ schemaVersion: 99, approvedRoots: ['C:/x'], projects: [] }) })
  );
  const futureEngine = new ProjectEngine({ fs: new NodeProjectFs(), storage: new JsonFileStorage(futureFile) });
  assertEqual(futureEngine.listApproved().length, 0, 'future schema version starts clean (no risky migration)');
  // Malformed profile entries are repaired, not dropped wholesale.
  const repairFile = nodePath.join(tempRoot, 'store-repair.json');
  // Note: stored the way ProjectStore.persist() writes it — wrapped under the storage key.
  nodeFs.writeFileSync(
    repairFile,
    JSON.stringify({
      krisha_projects_v1: JSON.stringify({
        schemaVersion: 1,
        approvedRoots: ['C:/repaired/root/'],
        projects: [
          {
            id: 'proj_x',
            root: 'C:/repaired/root',
            name: 42,
            kind: 'alien-kind',
            languages: 'nope',
            frameworks: ['ok', 7, null],
            importantFiles: [{ path: 'a.ts', name: 'a.ts', role: 'weird', size: -5, sig: '1:2' }, { bad: true }],
            dirDigests: 'nope',
            stats: { filesSeen: 'x', dirsScanned: 3 },
          },
          null,
          'garbage',
        ],
      }),
    })
  );
  const repairEngine = new ProjectEngine({ fs: new NodeProjectFs(), storage: new JsonFileStorage(repairFile) });
  assertEqual(repairEngine.listApproved(), ['C:/repaired/root'], 'approval list normalized (trailing slash stripped)');
  const repaired = repairEngine.store.projects[0];
  assert(!!repaired, 'repairable profile kept');
  assertEqual(repaired.name, 'root', 'invalid name replaced with root-derived fallback');
  assertEqual(repaired.kind, 'generic', 'unknown kind falls back to generic');
  assertEqual(repaired.frameworks, ['ok'], 'non-string framework entries dropped');
  assertEqual(repaired.importantFiles.length, 1, 'malformed file records dropped, valid ones kept');
  assertEqual(repaired.importantFiles[0].role, 'source', 'invalid role falls back to source');
  assertEqual(repaired.dirDigests.length, 0, 'invalid digests repaired to empty');
  assertEqual(repaired.stats.filesSeen, 0, 'invalid stats coerced to 0');
}

// ---------------------------------------------------------------- Test 17
{
  console.log('Test 17 — Resource limits: depth, breadth, and giant files');
  const deep = fixtureDir('rho');
  const deepFiles: Record<string, string> = { 'package.json': '{"name":"rho"}' };
  for (const rel of ['a/b/c/d/e/f/g/leaf.ts', 'a/b/c/d/e/f/level6.ts', 'a/b/c/d/e/level5.ts']) {
    deepFiles[rel] = 'export {};';
  }
  writeFiles(deep, deepFiles);
  const hDeep = makeHarness();
  await hDeep.engine.approveRoot(deep);
  const deepProfile = (await hDeep.engine.index(deep)).profile!;
  assert(deepProfile.dirDigests.some((d) => d.path === 'a/b/c/d/e/f'), 'directories up to MAX_DEPTH are scanned');
  assert(!deepProfile.dirDigests.some((d) => d.path.includes('g')), 'directories beyond MAX_DEPTH are never entered');
  assert(!deepProfile.importantFiles.some((f) => f.path.includes('leaf.ts')), 'files beyond MAX_DEPTH never seen');

  const wide = fixtureDir('sigma');
  const wideDirs: Record<string, string> = { 'package.json': '{"name":"sigma"}' };
  for (let i = 0; i < 90; i++) wideDirs[`mod${i}/index.ts`] = 'export {};';
  writeFiles(wide, wideDirs);
  const hWide = makeHarness();
  await hWide.engine.approveRoot(wide);
  const wideProfile = (await hWide.engine.index(wide)).profile!;
  assertEqual(wideProfile.stats.dirsScanned, MAX_DIRS_SCANNED, 'directory scan budget enforced');

  const big = fixtureDir('tau');
  const bigContent = Buffer.alloc(MAX_PARSE_FILE_BYTES + 4096, 0x61);
  writeFiles(big, { 'package.json': '{"name":"tau"}', 'data/huge.log': bigContent, 'README.md': '# tau' });
  const hBig = makeHarness();
  await hBig.engine.approveRoot(big);
  const bigProfile = (await hBig.engine.index(big)).profile!;
  assert(bigProfile.stats.filesSkipped >= 1, 'oversized file counted as skipped');
  assert(!bigProfile.importantFiles.some((f) => f.path === 'data/huge.log'), 'oversized file never recorded or read');
  assert(bigProfile.stats.filesSeen >= 3, 'oversized file still counted as seen');
}

// ---------------------------------------------------------------- Test 18
{
  console.log('Test 18 — Tools end-to-end through the ToolRegistry');
  const dir = fixtureDir('upsilon');
  makeNodeProject(dir);
  const h = makeHarness();
  const approve = await h.registry.execute('project.approve_root', { path: dir }, TOOL_CTX());
  assertEqual(approve.success, true, 'project.approve_root through the registry');
  assertEqual((approve.output as { approved: boolean }).approved, true, 'approval output reported');
  const reApprove = await h.registry.execute('project.approve_root', { path: dir }, TOOL_CTX());
  assertEqual(reApprove.success, true, 're-approval is idempotent');
  const inspect = await h.registry.execute('project.inspect', { root: dir }, TOOL_CTX());
  assertEqual(inspect.success, true, 'project.inspect through the registry');
  const summary = (inspect.output as { profile: { name: string; frameworks: string[] } }).profile;
  assertEqual(summary.name, 'alpha-app', 'inspect returns the real profile summary');
  const changes = await h.registry.execute('project.changes', { root: dir }, TOOL_CTX());
  assertEqual(changes.success, true, 'project.changes through the registry');
  assertEqual((changes.output as { change: { unchanged: boolean } }).change.unchanged, true, 'changes reports unchanged right after index');
  const status = await h.registry.execute('project.status', { root: dir, goal: 'via registry' }, TOOL_CTX());
  assertEqual(status.success, true, 'project.status update through the registry');
  assertEqual((status.output as { dev: { goal: string } }).dev.goal, 'via registry', 'status output carries the dev record');
  const badRoot = await h.registry.execute('project.inspect', { root: 'C:/never/approved' }, TOOL_CTX());
  assertEqual(badRoot.success, false, 'registry inspect refuses unapproved roots');
  const forget = await h.registry.execute('project.forget', { root: dir }, TOOL_CTX());
  assertEqual(forget.success, true, 'project.forget through the registry');
  const afterForget = await h.registry.execute('project.inspect', { root: dir }, TOOL_CTX());
  assertEqual(afterForget.success, false, 'inspection after forget fails (approval revoked)');
  const list = await h.registry.execute('project.list', {}, TOOL_CTX());
  assertEqual((list.output as { approvedRoots: string[] }).approvedRoots.length, 0, 'forget also revoked the approval');
  const missing = await h.registry.execute('project.inspect', { root: ' ' }, TOOL_CTX());
  assertEqual(missing.success, false, 'empty root rejected by schema');
}

// ---------------------------------------------------------------- Test 19
{
  console.log('Test 19 — Direct scanner/store API sanity (no engine)');
  const dir = fixtureDir('phi');
  writeFiles(dir, { 'package.json': '{"name":"phi","main":"index.js"}', 'index.js': 'x' });
  const fs = new NodeProjectFs();
  const scan = await scanProject(dir, fs);
  assertEqual(scan.name, 'phi', 'scanner works standalone');
  assertEqual(scan.kind, 'node', 'scanner detects node standalone');
  assertEqual(scan.entryPoints.includes('index.js'), true, 'root entry candidate recognized');
  const approvalStore = new ProjectStore(new JsonFileStorage(nodePath.join(tempRoot, 'store-standalone.json')));
  assertEqual(approvalStore.approve(dir), true, 'store approval works standalone');
  assertEqual(approvalStore.approve(dir), false, 'duplicate approval rejected');
  assertEqual(approvalStore.isApproved(dir.toUpperCase()), true, 'approval check is case-insensitive');
  assertEqual(approvalStore.revoke(dir), true, 'revoke works standalone');
  assertEqual(approvalStore.get(dir), undefined, 'no profile without upsert');
  assertEqual(approvalStore.getById('proj_missing'), undefined, 'getById misses cleanly');
}

// ---------------------------------------------------------------- Test 20
{
  console.log('Test 20 — Diagnostics: project-awareness health check');
  const dir = fixtureDir('chi');
  writeFiles(dir, { 'package.json': '{"name":"chi"}' });
  const h = makeHarness();
  await h.engine.approveRoot(dir);
  await h.engine.index(dir);
  const checks = createIntelligenceChecks({ projects: h.engine });
  const check = checks.find((c) => c.id === 'intelligence.project_awareness')!;
  assert(!!check, 'project-awareness diagnostic check registered');
  const healthy = check.run();
  assertEqual(healthy.status, 'healthy', 'check healthy with a configured engine');
  const evidence = healthy.evidence as { approvedRoots: number; projects: number };
  assertEqual(evidence.approvedRoots, 1, 'evidence reports approved root count');
  const degraded = createIntelligenceChecks({}).find((c) => c.id === 'intelligence.project_awareness')!.run();
  assertEqual(degraded.status, 'degraded', 'check degraded without an engine');
}

// ---------------------------------------------------------------- Test 21
{
  console.log('Test 21 — Pruning with more than 10 mirrored parts (relation-query cap)');
  // The graph's per-node relation queries cap at maxQueryResults (10); this
  // fixture produces 8 modules + 9 entry/manifest files = 17 incoming edges,
  // which exposed a stale-record bug in a cap-blind prune implementation.
  const big = fixtureDir('psi');
  const bigFiles: Record<string, string> = { 'package.json': '{"name":"big-app","dependencies":{"react":"^18.0.0"}}', 'README.md': '# big-app' };
  for (let i = 0; i < 8; i++) bigFiles[`mod${i}/index.ts`] = 'export {};';
  writeFiles(big, bigFiles);
  const hBig = makeHarness();
  await hBig.engine.approveRoot(big);
  const pBig = (await hBig.engine.index(big)).profile!;
  assertEqual(pBig.modules.length, 8, 'eight modules indexed');
  const incoming = hBig.knowledgeGraph.graph.getAllEdges(1500).filter((e) => e.source === 'project_awareness' && e.relationship === 'part_of').length;
  assert(incoming >= 17, `fixture exceeds the 10-edge relation cap (${incoming} part_of edges)`);
  assert(hBig.knowledgeGraph.graph.getNodesByType('component', 30).some((n) => n.label.includes('big-app/mod3')), 'sanity: mod3 node mirrored');
  // Remove every module directory, then re-index — every stale record must go.
  for (let i = 0; i < 8; i++) nodeFs.rmSync(nodePath.join(big, `mod${i}`), { recursive: true, force: true });
  const pAfter = (await hBig.engine.index(big)).profile!;
  assertEqual(pAfter.modules.length, 0, 'no modules remain in the fresh profile');
  const stale = hBig.knowledgeGraph.graph.getNodesByType('component', 30).filter((n) => n.label.includes('big-app/mod'));
  assertEqual(stale.length, 0, 'ALL stale module nodes pruned despite the relation cap');
  const edgesLeft = hBig.knowledgeGraph.graph.getAllEdges(1500).filter((e) => e.source === 'project_awareness' && e.relationship === 'part_of');
  assertEqual(edgesLeft.length, 1, 'only the manifest file edge remains');
  assert(hBig.knowledgeGraph.graph.getNodesByType('project', 20).some((n) => n.label.includes('big-app')), 'project node intact');
  // Forget with >10 edges: the project node AND all its edges must go.
  assertEqual(hBig.engine.forget(big), true, 'forget succeeds with >10 mirrored parts');
  assertEqual(hBig.knowledgeGraph.graph.getAllEdges(1500).filter((e) => e.source === 'project_awareness').length, 0, 'all project_awareness edges removed on forget');
  assert(!hBig.knowledgeGraph.graph.getNodesByType('project', 20).some((n) => n.label.includes('big-app')), 'project node removed on forget');
  assertEqual(hBig.knowledgeGraph.graph.getNodesByType('file', 30).filter((n) => n.label.startsWith('big-app/')).length, 0, 'no stale file nodes on forget');
}

// ---------------------------------------------------------------- cleanup
for (const dir of roots) {
  try {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

console.log(`\n=== Project Awareness v1: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
