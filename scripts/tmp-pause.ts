import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore } from '../src/agent/taskState';
import { MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import { LongRunManager } from '../src/agent/longrun';
import type { AgentTool, PlanStep } from '../src/agent/types';

const bus = new AgentEventBus();
const registry = new ToolRegistry(bus);
const permissions = new PermissionManager();
permissions.grant('filesystem.write');
const engine = new PlanEngine({ registry, events: bus, permissions });
const core = new AgentCore({ registry, events: bus, store: new TaskStore(new MemoryStorage()), permissions, planning: engine, stepTimeoutMs: 5_000, retryDelayMs: 1, maxAttemptsPerStep: 1 });
const manager = new LongRunManager(core, bus, { storage: new MemoryStorage() });
manager.attach();

let listCalls = 0;
let release: () => void = () => {};
const gate = new Promise<void>((r) => { release = r; });
const tools: AgentTool[] = [
  {
    name: 'filesystem.list', description: '', category: 'test', riskLevel: 'low', capabilities: ['filesystem.list'], permissions: [], timeoutMs: 1_000,
    execute: async () => { listCalls++; return { success: true, output: { a: 1 }, verified: true }; },
  } as unknown as AgentTool,
  {
    name: 'filesystem.create', description: '', category: 'test', riskLevel: 'medium', capabilities: ['filesystem.create'], permissions: ['filesystem.write'], timeoutMs: 1_000,
    execute: async (_i, toolCtx: any) => { await gate; if (toolCtx.signal.aborted) return { success: false, error: 'cancelled', errorKind: 'cancelled' }; return { success: true, output: {}, verified: true }; },
  } as unknown as AgentTool,
];
registry.registerAll(tools);

const steps: PlanStep[] = [
  { id: 'r1', description: 'r1', toolName: 'filesystem.list', input: {}, status: 'pending' as const, attempts: 0 },
  { id: 'w1', description: 'w1', toolName: 'filesystem.create', input: { path: 'x' }, status: 'pending' as const, attempts: 0 },
  { id: 'r2', description: 'r2', toolName: 'filesystem.list', input: { path: '.' }, status: 'pending' as const, attempts: 0 },
];
Object.defineProperty(core, 'planner', {
  value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' as const }, steps, createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null },
  configurable: true,
});

const { taskId } = manager.start('pausable');
const waitList = () => new Promise<void>((r) => { const c = () => (listCalls >= 1 ? r() : setTimeout(c, 5)); c(); });
await waitList();
const p = manager.pause(taskId, 'test pause');
console.log('pause result:', JSON.stringify(p));
release();
await new Promise((r) => setTimeout(r, 200));
const diag = manager.listSessions().find((s) => s.taskId === taskId)!;
console.log('after pause, state:', diag.state, 'lastAction:', JSON.stringify(diag.lastAction));

const resumed = await manager.resume(taskId);
console.log('resume result:', JSON.stringify(resumed));
await new Promise((r) => setTimeout(r, 200));
const done = manager.listSessions().find((s) => s.taskId === taskId)!;
console.log('final state:', done.state, 'listCalls:', listCalls, 'steps:', JSON.stringify((core as any).store.list().find((t: any) => t.id === taskId)?.plan?.steps?.map((s: any) => `${s.id}:${s.status}`)));

for (const e of bus.recentEvents().slice(-12)) console.log(e.name);
