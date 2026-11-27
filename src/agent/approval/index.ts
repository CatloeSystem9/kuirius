/**
 * Approval Surface — public surface.
 *
 * One unified set of operator decisions, presented wherever the operator
 * actually is: in the Krisha window, or as a Windows Action Center toast.
 *
 * See approvalTypes.ts for the action types and the auto-approval allowlist,
 * trustGate.ts for the confidence scoring, policy.ts for the
 * offline-auto / online-ask rule, and approvalRegistry.ts for the hub.
 */

export * from './approvalTypes';
export * from './trustGate';
export * from './policy';
export * from './approvalRegistry';
