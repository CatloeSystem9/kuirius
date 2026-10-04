/**
 * Proactive actions + verification (Phase 15).
 *
 * Execution ALWAYS goes through the existing ToolRegistry with the caller's
 * PermissionManager — Phase 3 permissions remain authoritative at the tool
 * boundary (the registry itself re-checks missing permissions). LEVEL 4
 * categories and unconfirmed LEVEL 2+ actions never reach this module.
 * Verification prefers independent evidence via the Phase 14 multimodal
 * analyzer when available; otherwise the tool result stands alone and is
 * reported honestly.
 */
import type { ToolResult, ToolContext } from '../types';
import type { ToolRegistry } from '../toolRegistry';
import type { PermissionManager } from '../permissions';
import type { ProactiveOpportunity, ProactiveSuggestedAction } from './proactiveTypes';

export interface ExecutionContextSource {
  taskId: string;
  signal: AbortSignal;
}

export interface ActionExecutionResult {
  ok: boolean;
  toolName: string;
  result?: ToolResult;
  reason?: string;
}

/** Execute a CONFIRMED low-risk action through the existing tool registry. */
export async function executeConfirmed(
  opportunity: ProactiveOpportunity,
  registry: ToolRegistry,
  permissions: PermissionManager,
  ctxSource: ExecutionContextSource
): Promise<ActionExecutionResult> {
  const action = opportunity.suggestedAction;
  if (!action) return { ok: false, toolName: '', reason: 'opportunity has no suggested action' };
  if (action.requiredPermissions.some((p) => !permissions.isGranted(p as never))) {
    return { ok: false, toolName: action.toolName, reason: `missing permissions: ${action.requiredPermissions.join(', ')}` };
  }
  const ctx: ToolContext = {
    taskId: ctxSource.taskId,
    stepId: `proactive-${opportunity.id}`,
    signal: ctxSource.signal,
    memory: {},
    permissions,
    timeoutMs: 20_000,
  };
  try {
    const result = await registry.execute(action.toolName, action.input, ctx);
    return { ok: result.success === true, toolName: action.toolName, result };
  } catch (err) {
    return { ok: false, toolName: action.toolName, reason: String((err as Error)?.message ?? err) };
  }
}

export interface VerificationOutcome {
  verified: boolean;
  verdict: 'confirmed' | 'refuted' | 'uncertain';
  reasoning: string[];
}

export interface VerifierDeps {
  /**
   * Phase 14 multimodal hook: gathers independent evidence for the action's
   * expected state (e.g. application status after a launch). Optional —
   * when absent only the tool result is available and the verdict is honest
   * about it.
   */
  gatherIndependentEvidence?: (action: ProactiveSuggestedAction) => Promise<
    { kind: string; supports: boolean; confidence: number; note: string }[]
  >;
}

/** Verify a suggestion was actually presented (suggestion-level verification). */
export function verifySuggestionPresented(suggestion: { id: string } | undefined, presentedIds: ReadonlySet<string>, now: number, expiresAt?: number): VerificationOutcome {
  const reasoning: string[] = [];
  if (!suggestion) {
    return { verified: false, verdict: 'refuted', reasoning: ['suggestion not found'] };
  }
  if (!presentedIds.has(suggestion.id)) {
    return { verified: false, verdict: 'refuted', reasoning: ['suggestion was never presented'] };
  }
  if (expiresAt !== undefined && expiresAt <= now) {
    return { verified: false, verdict: 'refuted', reasoning: ['suggestion expired before verification'] };
  }
  reasoning.push('suggestion record exists and is marked PRESENTED');
  return { verified: true, verdict: 'confirmed', reasoning };
}

/** Verify an executed action, preferring independent evidence (spec §16). */
export async function verifyAction(action: ProactiveSuggestedAction, execution: ActionExecutionResult, deps: VerifierDeps): Promise<VerificationOutcome> {
  const reasoning: string[] = [];
  if (!execution.ok) {
    reasoning.push(execution.reason ? `execution failed: ${execution.reason}` : 'execution reported failure');
    if (execution.result && execution.result.success === false) {
      reasoning.push(`tool error: ${execution.result.error ?? 'unknown'}`);
    }
    return { verified: false, verdict: 'refuted', reasoning };
  }
  reasoning.push(`tool ${action.toolName} reported success`);

  const independent = deps.gatherIndependentEvidence ? await deps.gatherIndependentEvidence(action) : [];
  if (independent.length === 0) {
    reasoning.push('no independent evidence available — verdict uncertain by design (not claiming success)');
    return { verified: false, verdict: 'uncertain', reasoning };
  }
  const supporting = independent.filter((e) => e.supports);
  for (const e of independent) reasoning.push(`${e.kind}: ${e.note} (confidence ${e.confidence.toFixed(2)})`);
  if (supporting.length >= 2) {
    return { verified: true, verdict: 'confirmed', reasoning };
  }
  if (independent.some((e) => !e.supports && e.confidence > 0.6)) {
    return { verified: false, verdict: 'refuted', reasoning };
  }
  return { verified: false, verdict: 'uncertain', reasoning };
}
