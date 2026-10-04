import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { TaskStore } from '../src/agent/taskState';
import { AgentCore } from '../src/agent/agentCore';
import { PlanEngine } from '../src/agent/planning/planEngine';
import { createSystemNoteTool } from '../src/agent/system/systemTools';
import type { AgentTool, PlanStep, ToolResult } from '../src/agent/types';

let CLOCK = 1_000_000;
const now = () => CLOCK;

function flakyTool(name: string, failAfter: number, errorKind: ToolResult['errorKind'] = 'execution_error'): AgentTool {
  let calls = 0;
  return {
    name,
    description: `test ${name}`,
    category: 'test',
    riskLevel: 'low',
    permissions: [],
    timeoutMs: 1_000,
    execute: async () => {
      calls++;
      if (calls <= failAfter) return { success: true, output: { ok: true } };
      return { success: false, error: `${name} failed (call ${calls})`, errorKind };
    },
  } as unknown as AgentTool;
}

const bus = new AgentEventBus();
const registry = new ToolRegistry(bus);
registry.register(flakyTool('computer.click', 0, 'execution_error'));
registry.register(flakyTool('screen.observe', 99));
registry.register(createSystemNoteTool());
const permissions = new PermissionManager();
permissions.grant('screen.observation');
const engine = new PlanEngine({ registry, events: bus, permissions, now, limits: { maxReplansPerTask: 2, maxRepeatedFailures: 2 } });
const store = new TaskStore();
const core = new AgentCore({ registry, events: bus, store, permissions, planning: engine, stepTimeoutMs: 5_000, retryDelayMs: 1, maxAttemptsPerStep: 1 });
const task = await core.submit('do the thing');
console.log('status:', task.status);
console.log('error:', task.error);
console.log('diag:', JSON.stringify(engine.diagnostics(task.id)));
for (const e of bus.recentEvents()) {
  if (e.name.startsWith('PLAN_') || e.name === 'NOTICE') console.log(e.name, JSON.stringify(e.payload).slice(0, 160));
}
