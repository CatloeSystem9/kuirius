/**
 * Multimodal analyzer (Phase 14, spec §8–§10, §14) — lazy, selective
 * gathering of current evidence from the EXISTING subsystems.
 *
 * - Screen evidence flows through Phase 13 AdaptiveObserver (no second
 *   screenshot system; permission-gated; budget-respecting).
 * - Browser evidence comes from the Phase 8 Browser Agent (CDP-first).
 * - Application evidence comes from the Phase 9 Application Service.
 * - Documents are chunked and relevant sections selected (spec §9).
 * Nothing here polls; every gather is an explicit, bounded call.
 */
import type { ScreenState } from '../vision/visionTypes';
import type { BrowserAgent } from '../browser/browserAgent';
import type { ApplicationService } from '../system/systemServices';
import type { AdaptiveObserver } from '../observation/adaptiveObserver';
import type { MultimodalLimits, ModalityType } from './multimodalTypes';
import { DEFAULT_MULTIMODAL_LIMITS } from './multimodalTypes';
import type { MultimodalContext } from './multimodalContext';
import { chunkDocument, selectRelevantChunks } from './modalityNormalizer';

export interface AnalyzerServices {
  adaptive?: AdaptiveObserver;
  browserAgent?: BrowserAgent;
  applicationService?: ApplicationService;
}

export interface GatherOptions {
  taskId?: string;
  stepId?: string;
  /** Force a fresh screen capture through Phase 13. */
  requireFreshScreen?: boolean;
  /** Per-call timeout for each service call (ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_GATHER_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export class MultimodalAnalyzer {
  private services: AnalyzerServices;
  private limits: MultimodalLimits;
  private lastScreen: ScreenState | null = null;

  constructor(services: AnalyzerServices, limits: Partial<MultimodalLimits> = {}) {
    this.services = services;
    this.limits = { ...DEFAULT_MULTIMODAL_LIMITS, ...limits };
  }

  getLastScreen(): ScreenState | null {
    return this.lastScreen;
  }

  /**
   * Gather the requested modality kinds into the context. Only the requested
   * kinds are touched (lazy + selective, spec §14). Errors per kind are
   * captured in the result — gathering failures never crash the task.
   */
  async gather(
    context: MultimodalContext,
    kinds: ModalityType[],
    options: GatherOptions = {}
  ): Promise<{ gathered: ModalityType[]; failed: Array<{ kind: ModalityType; error: string }> }> {
    const gathered: ModalityType[] = [];
    const failed: Array<{ kind: ModalityType; error: string }> = [];
    const timeoutMs = options.timeoutMs ?? DEFAULT_GATHER_TIMEOUT_MS;

    for (const kind of kinds) {
      if (options.signal?.aborted) break;
      try {
        const ok = await this.gatherOne(context, kind, options, timeoutMs);
        if (ok) gathered.push(kind);
        else failed.push({ kind, error: 'source unavailable' });
      } catch (err) {
        failed.push({ kind, error: String((err as any)?.message || err) });
      }
    }
    return { gathered, failed };
  }

  private async gatherOne(
    context: MultimodalContext,
    kind: ModalityType,
    options: GatherOptions,
    timeoutMs: number
  ): Promise<boolean> {
    const now = Date.now();
    switch (kind) {
      case 'ui_state':
      case 'screenshot': {
        const adaptive = this.services.adaptive;
        if (!adaptive) return false;
        const result = await withTimeout(
          adaptive.observe({
            trigger: options.requireFreshScreen ? 'explicit_request' : 'task_step',
            priority: options.requireFreshScreen ? 'HIGH' : 'NORMAL',
            taskId: options.taskId,
            stepId: options.stepId,
            requireFresh: options.requireFreshScreen,
          }),
          timeoutMs,
          'screen observation'
        );
        if ((result.status === 'observed' || result.status === 'reused') && result.state) {
          this.lastScreen = result.state;
          context.addInput({ type: 'ui_state', state: result.state, source: 'phase4.vision' }, now, options.stepId);
          // A screenshot observation records metadata only (no pixels).
          context.addInput(
            {
              type: 'screenshot',
              state: result.state,
              source: 'phase4.vision',
            },
            now,
            options.stepId
          );
          return true;
        }
        return false;
      }
      case 'browser_state': {
        const browserAgent = this.services.browserAgent;
        if (!browserAgent) return false;
        const state = await withTimeout(browserAgent.getState(), timeoutMs, 'browser state');
        if (!state.available || !state.page) return false;
        context.addInput({ type: 'browser_state', state, source: 'phase8.browser' }, now, options.stepId);
        return true;
      }
      case 'application_state': {
        // Gathered per-app on demand (see gatherApplication); generic kind
        // without a target has nothing to query.
        return false;
      }
      default:
        return false;
    }
  }

  /**
   * Query one application's process state through the Phase 9 service.
   * Cost: a single bounded status call (no screenshot needed).
   */
  async gatherApplication(
    context: MultimodalContext,
    name: string,
    options: GatherOptions = {}
  ): Promise<boolean> {
    const appService = this.services.applicationService;
    if (!appService) return false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_GATHER_TIMEOUT_MS;
    try {
      const result = await withTimeout(appService.status(name), timeoutMs, 'application status');
      // The service swallows errors into { verified: false } results — only
      // record VERIFIED process-table reads as evidence (never guess).
      if (result.verified !== true) return false;
      context.addInput(
        {
          type: 'application_state',
          name: result.name ?? name,
          running: result.running === true,
          pids: result.pids,
          source: 'phase9.applications',
        },
        Date.now(),
        options.stepId
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Record a structured tool result as evidence (called from the bus wiring). */
  recordToolResult(
    context: MultimodalContext,
    toolName: string,
    output: Record<string, unknown>,
    verified: boolean | undefined,
    stepId?: string
  ): void {
    context.addInput({ type: 'tool_result', toolName, output, verified, source: 'phase3.tools' }, Date.now(), stepId);
  }

  /** Add user/agent text (sensitivity-scanned). */
  addText(context: MultimodalContext, text: string, stepId?: string): void {
    context.addInput({ type: 'text', text, source: 'user' }, Date.now(), stepId);
  }

  /**
   * Add a document (spec §9): chunked, bounded, and — when a focus query is
   * given — only the most relevant chunks are retained.
   */
  addDocument(context: MultimodalContext, title: string, content: string, focusQuery?: string, stepId?: string): { chunks: number; selected: number } {
    const chunks = chunkDocument(content, this.limits.documentChunkChars, this.limits.maxDocumentChunks);
    const relevant = focusQuery ? selectRelevantChunks(chunks, focusQuery, Math.min(3, this.limits.maxDocumentChunks)) : chunks.slice(0, 1);
    const obs = context.addInput(
      { type: 'document', title, content: relevant.map((c) => c.text).join('\n\n'), source: 'user' },
      Date.now(),
      stepId
    );
    // Record true totals in metadata (payload stays bounded).
    obs.metadata['selectedChunks'] = relevant.length;
    obs.metadata['chunkIndizes'] = relevant.map((c) => c.index);
    return { chunks: chunks.length, selected: relevant.length };
  }

  /** Extract the retained chunk texts of a stored document observation. */
  documentChunks(context: MultimodalContext, observationId: string): string[] {
    const obs = context.live().find((o) => o.id === observationId);
    if (!obs || obs.payload.type !== 'document') return [];
    const chunks = obs.metadata['chunks'];
    return Array.isArray(chunks) ? (chunks as string[]) : [];
  }
}
