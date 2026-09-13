/**
 * Memory ↔ Agent Core bridge (Phase 2).
 *
 * Wires the MemoryService into the Phase 1 event bus:
 *  - USER_MESSAGE  → correction learning + relevance-based recall attached to the task
 *  - TASK_COMPLETED→ episodic memory + workflow-memory upsert from the executed plan
 *  - TASK_FAILED   → episodic memory of the failure (avoid repeating mistakes later)
 *
 * The Agent Core itself stays memory-agnostic; all integration happens here.
 */
import type { AgentEvent } from '../events';
import type { AgentSystem } from '../bridge';
import type { MemoryService } from './memoryService';
import { detectCorrection } from './memoryService';
import type { MemoryRecord } from './memoryTypes';

/** Similar completed episodes before a workflow memory is created/refreshed. */
const WORKFLOW_EPISODE_THRESHOLD = 1;

export interface MemoryAgentAttachment {
  detach: () => void;
}

export function attachMemoryToSystem(system: AgentSystem, memory: MemoryService): MemoryAgentAttachment {
  const offs: Array<() => void> = [];

  offs.push(
    system.bus.on('USER_MESSAGE', (event: AgentEvent) => {
      const input = String((event.payload as { input?: string } | undefined)?.input ?? '');
      const taskId = event.taskId;
      if (!input || !taskId) return;

      // 1. Learning from corrections: store only durable, reusable corrections.
      const correction = detectCorrection(input);
      if (correction.durable) {
        memory.remember(input, {
          category: 'correction',
          source: 'user_correction',
          tags: ['correction'],
        });
      }

      // 2. Relevance-based recall BEFORE planning; attach to task state.
      try {
        const relevant: MemoryRecord[] = memory.recall(input, { limit: 6 });
        if (relevant.length > 0) {
          system.core.store.update(taskId, (task) => {
            task.memoryContext = relevant.map((r) => r.content);
          });
        }
      } catch {
        // memory must never break task execution
      }
    })
  );

  offs.push(
    system.bus.on('TASK_COMPLETED', (event: AgentEvent) => {
      try {
        const task = system.core.store.get(event.taskId ?? '');
        if (!task?.plan) return;

        const toolsUsed = task.plan.steps
          .filter((s) => s.status === 'completed')
          .map((s) => s.toolName);
        const stepDescriptions = task.plan.steps.map((s) => s.description);

        // Episodic memory: what was asked and how it ended.
        memory.remember(`Task "${task.goal.description}" completed successfully (${task.plan.steps.filter((s) => s.status === 'completed').length} steps)`, {
          category: 'episodic',
          source: 'agent_task',
          importance: 0.45,
          metadata: { taskId: task.id, toolsUsed, outcome: 'completed' },
        });

        upsertWorkflow(memory, task.goal.description, stepDescriptions, toolsUsed);
      } catch {
        // ignore
      }
    })
  );

  offs.push(
    system.bus.on('TASK_FAILED', (event: AgentEvent) => {
      try {
        const task = system.core.store.get(event.taskId ?? '');
        if (!task?.plan) return;
        const toolsUsed = task.plan.steps
          .filter((s) => s.status === 'completed')
          .map((s) => s.toolName);
        memory.remember(`Task "${task.goal.description}" failed: ${task.error ?? 'unknown error'}`, {
          category: 'episodic',
          source: 'agent_task',
          importance: 0.5,
          metadata: { taskId: task.id, toolsUsed, outcome: 'failed' },
        });
      } catch {
        // ignore
      }
    })
  );

  return {
    detach: () => offs.forEach((off) => off()),
  };
}

/**
 * Workflow learning foundation: after a successful multi-step task, record the
 * procedure. Repeated successes on a similar goal strengthen the workflow
 * (confidence/successCount). Full autonomous workflow reuse arrives in Phase 12.
 */
function upsertWorkflow(
  memory: MemoryService,
  goalText: string,
  steps: string[],
  tools: string[]
): void {
  if (steps.length < 2) return; // single-step tasks are not workflows

  const existing = memory.records.find(
    (r) => r.valid && r.category === 'workflow' && workflowMatches(r, goalText)
  );

  if (existing) {
    const meta = (existing.metadata ?? {}) as { successCount?: number; lastSuccessfulAt?: number };
    memory.remember(existing.content, {
      category: 'workflow',
      source: 'workflow_learning',
      importance: Math.min(0.9, existing.importance + 0.05),
      confidence: Math.min(0.9, existing.confidence + 0.05),
      metadata: {
        steps,
        tools: Array.from(new Set([...((existing.metadata?.tools as string[]) ?? []), ...tools])),
        successCount: (meta.successCount ?? WORKFLOW_EPISODE_THRESHOLD) + 1,
        lastSuccessfulAt: Date.now(),
        trigger: goalText.slice(0, 80),
      },
    });
    return;
  }

  memory.remember(`Workflow for: ${goalText.slice(0, 100)}`, {
    category: 'workflow',
    source: 'workflow_learning',
    importance: 0.55,
    confidence: 0.5,
    metadata: {
      steps,
      tools,
      trigger: goalText.slice(0, 80),
      successCount: 1,
      lastSuccessfulAt: Date.now(),
    },
  });
}

function workflowMatches(record: MemoryRecord, goalText: string): boolean {
  const trigger = (record.metadata?.trigger as string) ?? record.content.replace(/^Workflow for:\s*/i, '');
  if (!trigger) return false;
  const a = new Set(tokenizeLower(trigger));
  const b = new Set(tokenizeLower(goalText));
  if (a.size === 0 || b.size === 0) return false;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  return overlap / Math.min(a.size, b.size) >= 0.4;
}

function tokenizeLower(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}
