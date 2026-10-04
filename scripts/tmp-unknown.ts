import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore } from '../src/agent/taskState';
import { MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning';
import { LongRunManager, CheckpointStore } from '../src/agent/longrun';
import type { AgentTool, PlanStep } from '../src/agent/types';

const bus = new AgentEventBus();
const registry = new ToolRegistry(bus);
const permissions = new PermissionManager();
permissions.grant('filesystem.write');
const engine = new PlanEngine({ registry, events: bus, permissions });
const core = new AgentCore({ registry, events: bus, store: new TaskStore(new MemoryStorage()), permissions, planning: engine, stepTimeoutMs: 5_000, retryDelayMs: 1, maxAttemptsPerStep: 1 });
const manager = new LongRunManager(core, bus, { storage: new MemoryStorage() });
manager.attach();

registry.register({
  name: 'filesystem.create', description: '', category: 't', riskLevel: 'medium', capabilities: ['filesystem.create'], permissions: ['filesystem.write'], timeoutMs: 1_000,
  execute: async () => ({ success: true, output: { created: true } }),
  verification: { type: 'output_contains', expected: 'verification-marker' },
} as unknown as AgentTool);

const steps: PlanStep[] = [{ id: 'w1', description: 'w1', toolName: 'filesystem.create', input: { path: 'x' }, status: 'pending' as const, attempts: 0 }];
Object.defineProperty(core, 'planner', {
  value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' as const }, steps, createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null },
  configurable: true,
});

const { taskId } = manager.start('uncertain outcome task');
await new Promise((r) => setTimeout(r, 300));
const task = (core as any).store.list().find((t: any) => t.id === taskId);
console.log('task status:', task.status, 'step:', JSON.stringify(task.plan?.steps?.map((s: any) => ({ s: s.status, v: s.verified }))));
const session = manager.listSessions().find((s) => s.taskId === taskId)!;
console.log('session:', session.state, 'lastAction:', JSON.stringify(session.lastAction));
const cpStore = (manager as unknown as { checkpoints: CheckpointStore }).checkpoints;
const cp = cpStore.get(taskId)!;
console.log('cp.lastAction:', JSON.stringify(cp.lastAction));
