/**
 * Context Builder (Context Engine v1) — assembles scored + budgeted items
 * into a deterministic ContextPackage the Agent Core / chat pipeline consumes
 * (spec §8). Also renders the compact labeled text form used by the model.
 */
import type { ContextItem, ContextPackage, ContextRequest, ContextRequirements } from './contextTypes';
import type { BudgetOutcome } from './contextTypes';

function lines(items: ContextItem[], source: ContextItem['source'], max = 5): string[] {
  return items
    .filter((i) => i.source === source)
    .slice(0, max)
    .map((i) => i.content);
}

/** Assemble the package from budgeted items. Pure — never throws on optional gaps. */
export function buildPackage(
  request: ContextRequest,
  requirements: ContextRequirements,
  outcome: BudgetOutcome,
  extras: { skippedSources: ContextPackage['metadata']['skippedSources']; now: number }
): ContextPackage {
  const kept = outcome.kept;
  const staleCount = kept.filter((i) => i.stale).length;
  const taskState = kept.find((i) => i.source === 'task_state');

  return {
    request: request.input,
    currentGoal: taskState?.content.replace(/^Active task:\s*/i, ''),
    activeTaskId: request.taskId,
    requirements,
    relevantMemories: lines(kept, 'memory'),
    relevantConversation: lines(kept, 'conversation'),
    relevantFiles: lines(kept, 'project_files'),
    relevantToolState: lines(kept, 'tool_state'),
    environmentState: lines(kept, 'environment'),
    cachedKnowledge: kept
      .filter((i) => i.source === 'cached_knowledge')
      .slice(0, 3)
      .map((i) => (i.stale ? `[stale] ${i.content}` : i.content)),
    knowledgeGraph: lines(kept, 'knowledge_graph', 3),
    constraints: lines(kept, 'constraints', 4),
    metadata: {
      generatedAt: extras.now,
      networkRequired: requirements.networkNeed === 'required',
      networkReason: requirements.networkReason,
      staleTolerant: requirements.staleTolerant,
      candidatesConsidered: outcome.kept.length + outcome.dropped.length,
      itemsKept: kept.length,
      itemsDropped: outcome.dropped.length,
      charsUsed: outcome.charsUsed,
      budgetCap: 0, // filled by the engine (config value)
      staleCount,
      skippedSources: extras.skippedSources,
    },
  };
}

/**
 * Compact deterministic text rendering (used by the chat pipeline to inject
 * ONLY selected, budgeted context into the model prompt).
 */
export function renderPackageText(pkg: ContextPackage): string {
  const sections: string[] = [];
  if (pkg.constraints.length > 0) sections.push(`[CONSTRAINTS]:\n${pkg.constraints.map((c) => `- ${c}`).join('\n')}`);
  if (pkg.currentGoal) sections.push(`[ACTIVE TASK]: ${pkg.currentGoal}`);
  if (pkg.knowledgeGraph && pkg.knowledgeGraph.length > 0) sections.push(`[KNOWLEDGE GRAPH]:\n${pkg.knowledgeGraph.map((c) => `- ${c}`).join('\n')}`);
  if (pkg.relevantToolState.length > 0) sections.push(`[TOOL STATE]:\n${pkg.relevantToolState.map((c) => `- ${c}`).join('\n')}`);
  if (pkg.relevantMemories.length > 0) sections.push(`[RELEVANT MEMORIES]:\n${pkg.relevantMemories.map((c) => `- ${c}`).join('\n')}`);
  if (pkg.cachedKnowledge.length > 0) sections.push(`[CACHED KNOWLEDGE]:\n${pkg.cachedKnowledge.map((c) => `- ${c}`).join('\n')}`);
  if (pkg.relevantConversation.length > 0) sections.push(`[RECENT CONVERSATION]:\n${pkg.relevantConversation.map((c) => `- ${c}`).join('\n')}`);
  return sections.join('\n\n');
}
