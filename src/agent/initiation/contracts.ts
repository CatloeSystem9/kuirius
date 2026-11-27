/**
 * Initiation Subsystem — cross-process contract.
 *
 * The trigger engine (scheduler / event triggers / boot-resume) runs in the
 * Node server so it survives reboots and keeps time while the browser is
 * closed. The EXECUTOR runs in the browser, because that is where the agent
 * core, the tool registry and the Phase 18 permission gate live — an
 * autonomous mission must never gain a permission the user did not grant.
 *
 * These types are the ONLY thing shared between the two halves, so this file
 * must stay dependency-free and browser-safe (no `fs`, no `path`).
 */

/** Where the initiation came from. */
export type InitiationSource = 'scheduler' | 'event_trigger' | 'boot_resume';

/**
 * What the executor should do with the record.
 *
 * - `notify`      — surface it (activity feed / optional voice). No task.
 * - `suggest`     — speak a proposal and let the USER decide. Never executes.
 * - `execute_task` — run a task through the agent core (permission-gated).
 */
export type InitiationAction = 'notify' | 'suggest' | 'execute_task';

/** Delivery lifecycle of a queued initiation. */
export type InitiationStatus = 'pending' | 'claimed' | 'done' | 'failed';

/** A unit of autonomous work handed from the trigger engine to the executor. */
export interface InitiationRecord {
  /** Stable id — the ack key. */
  id: string;
  /** Which subsystem produced it. */
  source: InitiationSource;
  /** Free-form kind: mission kind, event type, or 'boot_resume'. */
  kind: string;
  /** What the executor should do. */
  action: InitiationAction;
  /** Short headline (balloon / feed title). */
  title: string;
  /** Human-readable body — the message the user actually reads. */
  message: string;
  /**
   * The task to execute (for `execute_task`). Rendered from the rule/mission
   * template. Bounded — this is an instruction, not a document.
   */
  taskPrompt?: string;
  /** Structured context (event data, goal ids, mission metadata). */
  payload?: Record<string, unknown>;
  /**
   * Collapses repeats of the same kind of initiation. Two pending records
   * with the same key are one record — the newer replaces the older. This is
   * what stops a burst of process events from becoming a burst of
   * notifications when the browser reconnects.
   */
  dedupeKey?: string;
  /** Epoch ms when the trigger fired. */
  createdAt: number;
  /** Delivery state. */
  status: InitiationStatus;
  /** How many times delivery has been attempted. */
  attempts: number;
  /** Epoch ms of the current lease holder. */
  claimedAt?: number;
  /** Which client leased it. */
  clientId?: string;
  /**
   * Epoch ms before which the record must NOT be handed out. Used when an
   * initiation is deferred (quiet hours, user busy) so it is delivered later
   * instead of being silently lost.
   */
  notBefore?: number;
  /** How many times this record has been deferred. */
  deferCount?: number;
  /** Outcome reported by the executor. */
  result?: InitiationOutcome;
}

/** Honest outcome of an executed initiation. */
export interface InitiationOutcome {
  success: boolean;
  /** Short, truthful summary of what happened. */
  summary?: string;
  /** Epoch ms when the executor reported the outcome. */
  completedAt?: number;
}

/** A lease: the record was handed to a client and is in flight. */
export interface InitiationLease {
  record: InitiationRecord;
  /** Epoch ms when the lease expires and the record returns to pending. */
  expiresAt: number;
}

/** Why an initiation was not executed (client-side skip reasons). */
export type InitiationSkipReason =
  | 'disabled'
  | 'quiet_hours'
  | 'user_active'
  | 'speaking'
  | 'server_unavailable'
  | 'no_task_prompt'
  | 'lease_lost';

/** The client's report for one record. */
export interface InitiationAck {
  id: string;
  success: boolean;
  summary?: string;
  /** Set when the executor skipped the record instead of running it. */
  skipped?: InitiationSkipReason;
}
