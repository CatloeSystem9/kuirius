import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { LearningService, WorkflowAwarePlanner } from '../src/agent/learning';
import type { AgentTool, PlanStep } from '../src/agent/types';
import { ok, fail } from '../src/agent/types';

const bus = new AgentEventBus();
const registry = new ToolRegistry(bus);
const mk = (name: string, cap: string, exec: any): AgentTool => ({ name, description: name, category: 'test', riskLevel: 'low', capabilities: [cap], execute: exec });
registry.register(mk('mock.a', 'cap.a', async () => ok({ output: { opened: true } })));
registry.register(mk('mock.b', 'cap.b', async () => ok({ output: { zapped: true } })));
const storage = new MemoryStorage();
const store = new TaskStore(storage);
const learning = new LearningService({ registry, events: bus, storage, taskResolver: (id) => store.get(id) });
const steps: PlanStep[] = [
  { id: 's1', description: 'a', toolName: 'mock.a', capability: 'cap.a', input: {}, status: 'pending', attempts: 0 },
  { id: 's2', description: 'b', toolName: 'mock.b', capability: 'cap.b', input: {}, status: 'pending', attempts: 0 },
];
const core = new AgentCore({ registry, events: bus, store, planner: new WorkflowAwarePlanner({ makePlan: (g) => ({ goal: g, steps: steps.map((s) => ({ ...s })), createdAt: Date.now(), revision: 1 }), proposeAlternative: () => null }, learning) });
learning.attach();
const GOAL = 'open the widget then zap the widget file and log the widget result';
await core.submit(GOAL);
await core.submit(GOAL);
console.log('after 2 ok:', learning.list()[0].confidence, JSON.stringify(learning.list()[0].usage));
registry.unregister('mock.a');
registry.unregister('mock.b');
registry.register(mk('mock.a', 'cap.a', async () => fail('boom', { retryable: false })));
registry.register(mk('mock.b', 'cap.b', async () => fail('boom', { retryable: false })));
const t3 = await core.submit(GOAL);
console.log('run3 status:', t3.status, 'learnedFrom:', !!t3.plan?.learnedFrom, 'error:', t3.error?.slice(0, 80));
console.log('after fail1:', learning.list()[0].confidence, JSON.stringify(learning.list()[0].usage));
const t4 = await core.submit(GOAL);
console.log('run4 status:', t4.status, 'learnedFrom:', !!t4.plan?.learnedFrom, 'error:', t4.error?.slice(0, 80));
console.log('after fail2:', learning.list()[0].confidence, JSON.stringify(learning.list()[0].usage));
