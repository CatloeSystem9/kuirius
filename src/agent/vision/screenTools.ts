/**
 * Screen observation tools (Phase 4) — exposed through the Phase 3 Tool
 * Registry with the full standard contract. Every tool is permission-gated
 * ('screen.observation', default-deny), returns structured results, and
 * reports honestly when capture or analysis failed.
 *
 * No UI effects are produced — screen data flows to the Agent Core/report,
 * never to UI components. The observer is injected so tests can use a
 * synthetic capture source; this module itself stays Node-safe.
 */
import type { AgentTool, ToolErrorKind, ToolResult } from '../types';
import { ok, fail } from '../types';
import type { ObserverErrorKind, ScreenState } from './visionTypes';
import { ObserverError } from './visionTypes';
import type { ScreenObserver } from './screenObserver';

const SCREEN_VERIFICATION = {
  strategy: 'self_reported' as const,
  description:
    'The analysis summary reflects exactly what the selected vision provider could determine; capture or analysis failures are reported as failures, never as observations.',
};

const ERROR_KIND_MAP: Record<ObserverErrorKind, ToolErrorKind> = {
  permission_denied: 'permission_denied',
  capture_unsupported: 'execution_error',
  capture_failed: 'execution_error',
  analysis_failed: 'execution_error',
  provider_unavailable: 'not_found',
  timeout: 'timeout',
};

function mapObserverError(err: unknown): ToolResult {
  if (err instanceof ObserverError) {
    const retryable = err.kind === 'capture_failed' || err.kind === 'analysis_failed' || err.kind === 'timeout';
    return fail(err.message, { errorKind: ERROR_KIND_MAP[err.kind], retryable });
  }
  return fail(`Screen observation failed: ${String((err as any)?.message || err)}`, { errorKind: 'execution_error', retryable: true });
}

/** Compact output for a state — summaries and bounded lists, never raw image data. */
function stateOutput(state: ScreenState) {
  const visibleTexts = state.analysis.texts.slice(0, 25);
  const textSummary = visibleTexts.map((t) => t.text).filter(Boolean).join(' • ');

  return {
    summary: state.analysis.summary,
    application: state.analysis.application || state.activeWindow.title || 'Desktop / Browser Screen',
    activeWindow: state.activeWindow.available
      ? { title: state.activeWindow.title, surface: state.activeWindow.surface }
      : { available: false },
    textSummary: textSummary || undefined,
    texts: visibleTexts,
    elements: state.analysis.elements.slice(0, 20),
    dialogs: state.analysis.dialogs.slice(0, 5),
    errors: state.analysis.errors.slice(0, 5),
    warnings: state.analysis.warnings.slice(0, 5),
    loading: state.analysis.loading,
    provider: state.analysis.provider,
    confidence: state.analysis.confidence,
    capturedAt: state.timestamp,
    stateId: state.id,
    snapshotRef: state.snapshotRef,
  };
}

export function createScreenTools(observer: ScreenObserver): AgentTool[] {
  return [
    {
      name: 'screen.observe',
      description: 'Capture and visually read the user screen; returns what is visible (application, legible texts, interactive elements, dialogs, errors) as structured state.',
      category: 'vision',
      riskLevel: 'medium',
      cost: 'moderate',
      reliability: 0.8,
      capabilities: ['screen.observe', 'screen.describe'],
      permissions: ['screen.observation'],
      inputSchema: {
        optional: ['question', 'analyze', 'maxAgeMs'],
        types: { question: 'string', analyze: 'string', maxAgeMs: 'number' },
        validators: { analyze: (v) => v === 'auto' || v === 'cloud' || v === 'local' },
      },
      verification: SCREEN_VERIFICATION,
      timeoutMs: 25_000,
      retryPolicy: { maxAttempts: 1 }, // re-running a permission prompt is worse than failing
      async execute(input): Promise<ToolResult> {
        try {
          const state = await observer.getCurrentState({
            analyze: (input.analyze as 'auto' | 'cloud' | undefined) ?? 'auto',
            question: typeof input.question === 'string' ? input.question : undefined,
            maxAgeMs: typeof input.maxAgeMs === 'number' ? input.maxAgeMs : undefined,
          });
          return ok({ output: stateOutput(state), state: { lastScreenStateId: state.id } });
        } catch (err) {
          return mapObserverError(err);
        }
      },
    },
    {
      name: 'screen.get_active_window',
      description: "Report the currently visible window/screen metadata (best-effort in a browser environment; no capture when a stream already exists).",
      category: 'vision',
      riskLevel: 'low',
      cost: 'free',
      reliability: 0.9,
      capabilities: ['screen.active_window'],
      permissions: ['screen.observation'],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Reports track metadata honestly, including "unavailable".' },
      timeoutMs: 5000,
      async execute(): Promise<ToolResult> {
        try {
          const info = observer.getActiveWindow();
          return ok({
            output: {
              summary: info.available
                ? `Active window: ${info.title || info.surface || 'unknown'}`
                : 'Active window information is not available (no active screen capture).',
              available: info.available,
              title: info.title,
              surface: info.surface,
            },
          });
        } catch (err) {
          return mapObserverError(err);
        }
      },
    },
    {
      name: 'screen.detect_changes',
      description: 'Capture the screen and compare a lightweight block signature against the previous observation to determine whether anything changed.',
      category: 'vision',
      riskLevel: 'medium',
      cost: 'cheap',
      reliability: 0.9,
      capabilities: ['screen.detect_changes'],
      permissions: ['screen.observation'],
      inputSchema: {},
      verification: { strategy: 'self_reported', description: 'Signature comparison is deterministic over captured frames.' },
      timeoutMs: 12_000,
      async execute(): Promise<ToolResult> {
        try {
          const change = await observer.detectChanges();
          return ok({
            output: {
              summary: change.changed
                ? `The screen changed (~${Math.round(change.changedFraction * 100)}% of blocks) in ${change.regions.length} region(s).`
                : 'No meaningful change detected since the previous observation.',
              ...change,
            },
          });
        } catch (err) {
          return mapObserverError(err);
        }
      },
    },
    {
      name: 'screen.compare',
      description: 'Compare two cached screen observations (defaults: the two most recent) and describe the meaningful difference.',
      category: 'vision',
      riskLevel: 'low',
      cost: 'free',
      reliability: 0.9,
      capabilities: ['screen.compare'],
      permissions: ['screen.observation'],
      inputSchema: { optional: ['previousStateId', 'currentStateId'], types: { previousStateId: 'string', currentStateId: 'string' } },
      verification: { strategy: 'self_reported', description: 'Comparison is computed from stored state signatures/analyses.' },
      timeoutMs: 5000,
      async execute(input): Promise<ToolResult> {
        try {
          const states = observer.listStates();
          if (states.length < 2) {
            return fail('Need at least two observations to compare; run screen.observe or screen.detect_changes first', {
              errorKind: 'invalid_input',
              retryable: false,
            });
          }
          const previous =
            (typeof input.previousStateId === 'string' && states.find((s) => s.id === input.previousStateId)) ||
            states[states.length - 2];
          const current =
            (typeof input.currentStateId === 'string' && states.find((s) => s.id === input.currentStateId)) ||
            states[states.length - 1];
          const diff = observer.compareStates(previous, current);
          return ok({ output: { summary: diff.description, ...diff, previousStateId: previous.id, currentStateId: current.id } });
        } catch (err) {
          return mapObserverError(err);
        }
      },
    },
  ];
}
