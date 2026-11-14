import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { HeuristicPlanner } from '../src/agent/planner';
import { MemoryService } from '../src/agent/memory/memoryService';
import { ContextEngine } from '../src/agent/context/contextEngine';
import { SafetyGate } from '../src/agent/safety/safetyGate';
import { SafetyAuditLog } from '../src/agent/safety/auditLog';
import { EmergencyStop } from '../src/agent/safety/emergencyStop';
import { ScopedPermissionManager } from '../src/agent/safety/scopedPermissions';
import { createSystemNoteTool, createSystemTools } from '../src/agent/system/systemTools';
import { FilesystemService } from '../src/agent/system/systemServices';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'krisha-debug-'));
fs.writeFileSync(path.join(root, 'report.txt'), 'integration report body', 'utf8');
fs.writeFileSync(path.join(root, 'other.txt'), 'second file', 'utf8');

const bus = new AgentEventBus();
const registry = new ToolRegistry(bus);
const store = new TaskStore(new MemoryStorage());
const permissions = new PermissionManager();
permissions.grant('filesystem.read');

const scoped = new ScopedPermissionManager();
const audit = new SafetyAuditLog();
const emergencyStop = new EmergencyStop(audit);
const gate = new SafetyGate({ permissions, scoped, emergencyStop, audit });
registry.setSafetyGate(gate);

// LocalDisk backend inline (same as suite)
const fsMod = { ...fs } as typeof fs;
class LocalDiskFsBackend {
  async list(p: string) {
    try {
      const abs = p.replace(/^([A-Za-z]:)?[\\/]+/, '');
      const full = path.join(root, abs);
      const entries = fsMod.readdirSync(full).map((n) => ({ name: n, path: path.join(full, n), kind: fsMod.statSync(path.join(full, n)).isDirectory() ? 'directory' : 'file', size: 0, modifiedAt: 0 }));
      return { success: true, result: { path: full, entries, truncated: false } };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async read(p: string, offset = 0) {
    try {
      const full = path.join(root, p.replace(/^([A-Za-z]:)?[\\/]+/, ''));
      const content = fsMod.readFileSync(full, 'utf8');
      return { success: true, result: { path: full, content, truncated: false, size: content.length, offset } };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async inspect(p: string) {
    try {
      const full = path.join(root, p.replace(/^([A-Za-z]:)?[\\/]+/, ''));
      const st = fsMod.statSync(full);
      return { success: true, result: { name: path.basename(full), path: full, kind: st.isDirectory() ? 'directory' : 'file', size: st.size, modifiedAt: st.mtimeMs } };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  }
  async create() { return { success: false, error: 'n/a' }; }
  async rename() { return { success: false, error: 'n/a' }; }
  async copy() { return { success: false, error: 'n/a' }; }
  async move() { return { success: false, error: 'n/a' }; }
  async delete() { return { success: false, error: 'n/a' }; }
  async openFile() { return { success: false, error: 'n/a' }; }
  async search() { return { success: false, error: 'n/a' }; }
}

const filesystemService = new FilesystemService({ fs: new LocalDiskFsBackend(), events: bus } as never);
registry.registerAll(createSystemTools(filesystemService, undefined as never));
registry.register(createSystemNoteTool());

const core = new AgentCore({ registry, events: bus, store, permissions, planner: new HeuristicPlanner() });
const task = await core.submit(`list the files in ${root} and then read the file ${path.join(root, 'report.txt')}`);
console.log('STATUS:', task.status);
console.log('ERROR:', task.error);
console.log('SUMMARY:', JSON.stringify(task.summary));
for (const s of task.plan?.steps ?? []) {
  console.log('STEP', s.toolName, s.status, '| err:', s.error, '| result:', JSON.stringify(s.result?.error ?? s.result?.output?.summary ?? null).slice(0, 200));
}
console.log('--- direct tool call ---');
const direct = await registry.execute('filesystem.list', { path: root }, { taskId: 'x', stepId: 'x', signal: new AbortController().signal, memory: {}, permissions });
console.log('direct list:', JSON.stringify(direct).slice(0, 400));

// --- B debug ---
console.log('\n--- B: memory worth ---');
const mem = new MemoryService(new MemoryStorage());
const r1 = mem.remember('The deploy key for the staging server is kept in the vault', { source: 'test' });
const r2 = mem.remember('User prefers dark mode in all tools', { source: 'test' });
console.log('remember outcomes:', JSON.stringify(r1), JSON.stringify(r2));
console.log('stats:', JSON.stringify(mem.stats()));
const ke = new ContextEngine({ memory: mem, cacheStorage: new MemoryStorage() });
const pkg = ke.buildContext({ input: 'where is the staging deploy key kept?', taskId: 'tb', now: Date.now() });
console.log('requirements:', JSON.stringify(pkg.requirements));
console.log('relevantMemories:', JSON.stringify(pkg.relevantMemories));
console.log('metadata:', JSON.stringify(pkg.metadata));
const recall = mem.recall('where is the staging deploy key kept?', { limit: 8 });
console.log('direct recall:', JSON.stringify(recall.map((m) => m.content)));
process.exit(0);
