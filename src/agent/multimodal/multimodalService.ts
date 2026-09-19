/**
 * Multimodal service facade (Phase 14) — task-scoped wiring of the context,
 * analyzer, reasoner, and verifier. Event-driven lifecycle: task start/end
 * on the shared bus create and purge the context; TOOL_COMPLETED /
 * TASK_STEP_COMPLETED feed evidence. No polling, no background workers.
 */
import type { AgentEvent, AgentEventBus } from '../events';
import type { ModalityType, MultimodalConclusion, MultimodalLimits, MultimodalQuestion, VerificationRequest } from './multimodalTypes';
import { DEFAULT_MULTIMODAL_LIMITS } from './multimodalTypes';
import { MultimodalContext } from './multimodalContext';
import { MultimodalAnalyzer, type AnalyzerServices } from './multimodalAnalyzer';
import { MultimodalReasoner, type ReasonerOptions } from './multimodalReasoner';
import { MultimodalVerifier, type VerificationOutcome } from './multimodalVerifier';
import type { MultimodalReasoningProvider } from './multimodalTypes';

export class MultimodalService {
  readonly context: MultimodalContext;
  readonly analyzer: MultimodalAnalyzer;
  readonly reasoner: MultimodalReasoner;
  readonly verifier: MultimodalVerifier;
  private limits: MultimodalLimits;

  constructor(services: AnalyzerServices, limits: Partial<MultimodalLimits> = {}) {
    this.limits = { ...DEFAULT_MULTIMODAL_LIMITS, ...limits };
    this.context = new MultimodalContext(this.limits);
    this.analyzer = new MultimodalAnalyzer(services, this.limits);
    this.reasoner = new MultimodalReasoner();
    this.verifier = new MultimodalVerifier();
  }

  setProvider(provider: MultimodalReasoningProvider | null): void {
    this.reasoner.setProvider(provider);
  }

  /** Record user text (sensitivity-scanned) into the current task context. */
  addText(text: string, stepId?: string): void {
    this.analyzer.addText(this.context, text, stepId);
  }

  /** Record a structured tool result (called from bus wiring). */
  recordToolResult(toolName: string, output: Record<string, unknown>, verified: boolean | undefined, stepId?: string): void {
    this.analyzer.recordToolResult(this.context, toolName, output, verified, stepId);
  }

  /** Gather the requested modalities lazily (Phase 4/8/9 via Phase 13). */
  gather(kinds: ModalityType[], options?: { taskId?: string; requireFreshScreen?: boolean; timeoutMs?: number; signal?: AbortSignal }) {
    return this.analyzer.gather(this.context, kinds, options);
  }

  /** Cross-modal reasoning (spec §4). */
  answer(question: MultimodalQuestion, options?: ReasonerOptions): Promise<MultimodalConclusion> {
    return this.reasoner.answer(this.context, question, options);
  }

  /** Independent-evidence verification (spec §12). */
  async verify(request: VerificationRequest): Promise<VerificationOutcome> {
    return this.verifier.verify(this.context, request, async () => {
      await this.analyzer.gather(this.context, ['ui_state'], {
        taskId: request.taskId,
        requireFreshScreen: true,
      });
    });
  }

  /** Subscribe to task lifecycle + tool-completion events. Returns detacher. */
  attach(bus: AgentEventBus): () => void {
    const unsubs: Array<() => void> = [];
    const on = (name: Parameters<AgentEventBus['on']>[0], handler: (event: AgentEvent) => void) => {
      unsubs.push(bus.on(name, handler));
    };

    on('TASK_STARTED', (e) => {
      if (typeof e.taskId === 'string') this.context.beginTask(e.taskId);
    });
    const end = () => this.context.endTask();
    on('TASK_COMPLETED', end);
    on('TASK_FAILED', end);
    on('TASK_CANCELLED', end);

    on('TOOL_COMPLETED', (e) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const toolName = typeof payload.tool === 'string' ? payload.tool : 'unknown';
      const verified = payload.verified === true;
      const output: Record<string, unknown> = {};
      if (typeof payload.outputSummary === 'string') {
        try {
          const parsed = JSON.parse(payload.outputSummary) as unknown;
          if (parsed && typeof parsed === 'object') Object.assign(output, parsed);
          else output.summary = payload.outputSummary;
        } catch {
          output.summary = payload.outputSummary;
        }
      }
      for (const key of ['url', 'title', 'name', 'running']) {
        if (payload[key] !== undefined) output[key] = payload[key];
      }
      const stepId = typeof e.stepId === 'string' ? e.stepId : undefined;
      this.recordToolResult(toolName, output, verified, stepId);
    });
    on('TOOL_FAILED', (e) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      this.recordToolResult(typeof payload.tool === 'string' ? payload.tool : 'unknown', { error: String(payload.error ?? 'failed') }, false);
    });

    return () => {
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
    };
  }

  /** Diagnostics for DevTools (bounded; no payloads). */
  stats() {
    return this.context.stats();
  }
}
