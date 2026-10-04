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
bus.on('TASK_CHECKPOINTED', (e) => console.log('  EVT CHECKPOINT', JSON.stringify(e.payload)));
bus.on('TASK_PAUSED', (e) => console.log('  EVT PAUSED'));
bus.on('TASK_CANCELLED', (e) => console.log('  EVT TASK_CANCELLED'));
bus.on('TASK_COMPLETED', (e) => console.log('  EVT TASK_COMPLETED'));
bus.on('TOOL_COMPLETED', (e) => console.log('  EVT TOOL_COMPLETED taskId=' + String(e.taskId)));
bus.on('TASK_BUDGET_EXHAUSTED', (e) => console.log('  EVT BUDGET', JSON.stringify(e.payload)));

registry.registerAll([
  { name: 'filesystem.list', description: '', category: 't', riskLevel: 'low', capabilities: ['filesystem.list'], permissions: [], timeoutMs: 1_000, execute: async () => ({ success: true, output: { ok: true }, verified: true }) } as unknown as AgentTool,
  { name: 'filesystem.create', description: '', category: 't', riskLevel: 'medium', capabilities: ['filesystem.create'], permissions: ['filesystem.write'], timeoutMs: 1_000, execute: async () => ({ success: true, output: { created: true }, verified: true }) } as unknown as AgentTool,
]);

// --- budget case ---
const steps: PlanStep[] = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, description: `r${i}`, toolName: 'filesystem.list', input: { p: i }, status: 'pending' as const, attempts: 0 }));
Object.defineProperty(core, 'planner', {
  value: { makePlan: () => ({ goal: { description: 'g', rawInput: 'g', kind: 'command' as const }, steps, createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null },
  configurable: true,
});
const { taskId } = manager.start('bounded', { budget: { maxToolCalls: 2, maxDurationMs: 60_000 } });
await new Promise((r) => setTimeout(r, 200));
const diag = manager.listSessions().find((s) => s.taskId === taskId)!;
console.log('budget session state:', diag.state, 'toolCalls:', diag.toolCalls, 'failureReason:', diag.failureReason);
const resumeAttempt = await manager.resume(taskId);
console.log('resume of expired:', JSON.stringify(resumeAttempt));
