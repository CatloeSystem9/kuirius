/**
 * Knowledge Indexer (v1) — deterministic relationship extraction from
 * information Krisha already has. NO model calls, NO NLP pipeline, NO
 * polling: the indexer reacts to bus events (USER_MESSAGE / TASK_COMPLETED)
 * and only records relationships it can establish with reasonable confidence.
 *
 * Confidence model:
 *  - explicit user decisions/preferences in the message → 0.9 (never
 *    overwritten by later ambiguous data — upsert merge semantics),
 *  - tool usage from executed plan steps → 0.8,
 *  - task→result derivation → 0.7.
 *
 * Every edge retains source + confidence metadata. Extraction is bounded per
 * event (maxExtractionsPerEvent) and deduplicated by stable graph ids:
 * re-indexing identical information is a deterministic no-op.
 */
import type { AgentEvent, AgentEventBus } from '../events';
import type { EntityType, RelationshipType } from './knowledgeTypes';
import type { KnowledgeGraph } from './knowledgeGraph';
import { clampLabel } from './knowledgeValidator';

const CONFIDENCE_USER = 0.9;
const CONFIDENCE_TOOLS = 0.8;
const CONFIDENCE_DERIVED = 0.7;

/** Deterministic patterns — conservative, high-precision only. */
const DECISION_PATTERN = /\b(?:decided|decision(?: is)?|from now on|we should|krisha should|always|never)\b([^.!?\n]{3,140})/i;
const PREFERENCE_PATTERN = /\b(?:i prefer|prefers?|my favorite|i like|i love|i hate|avoid)\b([^.!?\n]{3,140})/i;

export interface KnowledgeIndexerDeps {
  /** Existing TaskStore — used for TASK_COMPLETED extraction only. */
  getTask?: (id: string) =>
    | {
        goal?: { description?: string };
        summary?: string;
        plan?: { steps?: Array<{ toolName?: string; status?: string; description?: string }> } | null;
      }
    | undefined;
}

/** A planned edge references planned nodes by index (type-safe, no strings). */
interface PlannedEdge {
  sourceIndex: number | 'user';
  targetIndex: number;
  relationship: RelationshipType;
  confidence: number;
  sourceTag: string;
}

interface ExtractionPlan {
  nodes: Array<{ type: EntityType; label: string; properties?: Record<string, unknown> }>;
  edges: PlannedEdge[];
}

export class KnowledgeIndexer {
  constructor(
    private readonly graph: KnowledgeGraph,
    private readonly deps: KnowledgeIndexerDeps = {}
  ) {}

  /** Event-driven attachment (no polling). Returns a detach function. */
  attach(bus: AgentEventBus): () => void {
    const offs: Array<() => void> = [];
    offs.push(
      bus.on('USER_MESSAGE', (event: AgentEvent) => {
        try {
          const input = String((event.payload as { input?: string } | undefined)?.input ?? '');
          if (input) this.indexUserMessage(input);
        } catch {
          // extraction must never break task execution
        }
      })
    );
    offs.push(
      bus.on('TASK_COMPLETED', (event: AgentEvent) => {
        try {
          if (!event.taskId) return;
          const task = this.deps.getTask?.(event.taskId);
          if (task) this.indexTaskCompletion(task);
        } catch {
          // ignore
        }
      })
    );
    return () => offs.forEach((off) => off());
  }

  /** Extract explicit user decisions/preferences from a message. */
  indexUserMessage(input: string): ExtractionPlan {
    const plan: ExtractionPlan = { nodes: [], edges: [] };
    const text = String(input ?? '').slice(0, 1000);

    const decision = text.match(DECISION_PATTERN);
    if (decision) {
      const decisionLabel = clampLabel(`Decision: ${decision[0].trim()}`, this.graph.limits.maxLabelChars);
      const conceptLabel = clampLabel(decision[1].trim().split(/\s+/).slice(0, 8).join(' '), this.graph.limits.maxLabelChars);
      if (conceptLabel) {
        const decisionIndex = plan.nodes.push({ type: 'decision', label: decisionLabel, properties: { explicit: true } }) - 1;
        const conceptIndex = plan.nodes.push({ type: 'resource', label: conceptLabel }) - 1;
        plan.edges.push({ sourceIndex: decisionIndex, targetIndex: conceptIndex, relationship: 'supports', confidence: CONFIDENCE_USER, sourceTag: 'user_decision' });
      }
    }

    const preference = text.match(PREFERENCE_PATTERN);
    if (preference) {
      const conceptLabel = clampLabel(preference[1].trim().split(/\s+/).slice(0, 8).join(' '), this.graph.limits.maxLabelChars);
      if (conceptLabel) {
        const conceptIndex = plan.nodes.push({ type: 'resource', label: conceptLabel }) - 1;
        plan.edges.push({ sourceIndex: 'user', targetIndex: conceptIndex, relationship: 'prefers', confidence: CONFIDENCE_USER, sourceTag: 'user_preference' });
      }
    }

    this.apply(plan);
    return plan;
  }

  /** Extract task → result and task → tool relationships after completion. */
  indexTaskCompletion(task: {
    goal?: { description?: string };
    summary?: string;
    plan?: { steps?: Array<{ toolName?: string; status?: string; description?: string }> };
  }): ExtractionPlan {
    const plan: ExtractionPlan = { nodes: [], edges: [] };
    const goal = task?.goal?.description ? clampLabel(task.goal.description, this.graph.limits.maxLabelChars) : '';
    if (!goal) return plan;

    const taskIndex = plan.nodes.push({ type: 'task', label: goal }) - 1;
    if (task.summary && task.summary.length >= 20) {
      const resultLabel = clampLabel(task.summary.slice(0, 120), this.graph.limits.maxLabelChars);
      const resultIndex = plan.nodes.push({ type: 'result', label: resultLabel }) - 1;
      plan.edges.push({ sourceIndex: taskIndex, targetIndex: resultIndex, relationship: 'produces', confidence: CONFIDENCE_DERIVED, sourceTag: 'task_result' });
    }
    const tools = Array.from(
      new Set(
        (task.plan?.steps ?? [])
          .filter((s) => s.status === 'completed' && s.toolName)
          .map((s) => String(s.toolName))
      )
    ).slice(0, 4);
    for (const tool of tools) {
      const toolIndex = plan.nodes.push({ type: 'tool', label: tool }) - 1;
      plan.edges.push({ sourceIndex: taskIndex, targetIndex: toolIndex, relationship: 'uses', confidence: CONFIDENCE_TOOLS, sourceTag: 'task_tools' });
    }

    this.apply(plan);
    return plan;
  }

  /**
   * Apply a bounded plan: materialize nodes first (upsert — merges, never
   * overwrites explicit decisions), then create edges by resolving typed
   * references. Node+edge operations together respect maxExtractionsPerEvent.
   */
  private apply(plan: ExtractionPlan): void {
    const budget = this.graph.limits.maxExtractionsPerEvent;
    let ops = 0;
    const ids: Array<string | undefined> = [];
    for (const n of plan.nodes) {
      if (ops >= budget) break;
      const node = this.graph.upsertNode(n);
      ids.push(node?.id);
      if (node) ops++;
    }
    for (const e of plan.edges) {
      if (ops >= budget) break;
      let sourceId: string | undefined;
      if (e.sourceIndex === 'user') {
        sourceId = this.graph.upsertNode({ type: 'person', label: 'User' })?.id;
      } else {
        sourceId = ids[e.sourceIndex];
      }
      const targetId = ids[e.targetIndex];
      if (!sourceId || !targetId) continue;
      this.graph.upsertEdge({
        sourceId,
        targetId,
        relationship: e.relationship,
        confidence: e.confidence,
        source: e.sourceTag,
      });
      ops++;
    }
  }
}
