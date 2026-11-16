/**
 * Process monitor types (Phase A — visibility only).
 *
 * The monitor observes process creation/termination on the host and keeps a
 * bounded inventory. It is METADATA-ONLY: no command lines, no credentials,
 * no window titles, no user data. It performs no process control whatsoever
 * (no terminate/suspend/inject) — Phase A is visibility only.
 */

export type MonitorHealth = 'STARTING' | 'ACTIVE' | 'DEGRADED' | 'STOPPED' | 'FAILED';

export interface ProcessCreateEvent {
  kind: 'create';
  pid: number;
  name?: string;
  ppid?: number;
  sessionId?: number;
  /** Executable path when the snapshot provided one — absent is honest, never invented. */
  path?: string;
  at: number;
  source: 'wmi-worker';
  enriched: boolean;
}

export interface ProcessDeleteEvent {
  kind: 'delete';
  pid: number;
  name?: string;
  at: number;
  source: 'wmi-worker';
  /** True when the deleted process existed in the inventory (was observed). */
  previouslyObserved: boolean;
}

export type ProcessEvent = ProcessCreateEvent | ProcessDeleteEvent;

export type InventoryOrigin = 'startup' | 'observed' | 'unobserved';
export type InventoryState = 'running' | 'terminated-unconfirmed';

export interface InventoryEntry {
  pid: number;
  name?: string;
  path?: string;
  ppid?: number;
  sessionId?: number;
  /** startup = present in the boot snapshot; observed = creation event seen; unobserved = deletion seen for an unknown pid. */
  origin: InventoryOrigin;
  /** running = live per telemetry; terminated-unconfirmed = delete seen or reconciliation suggests exit. */
  state: InventoryState;
  firstSeenAt: number;
  terminatedAt?: number;
  /** 'unavailable' when the telemetry provided no executable path (honest handling of races). */
  enrichment: 'available' | 'unavailable';
  /** Set when a later creation reused this PID for a different image. */
  reused?: boolean;
}

export interface MonitorStatus {
  health: MonitorHealth;
  healthReason?: string;
  startedAt?: number;
  /** Confirmed-registered WMI subscriptions (false while STARTING/DEGRADED). */
  subscriptions: { creation: boolean; deletion: boolean };
  workerRestarts: number;
  eventsReceived: number;
  eventsDropped: number;
  queueSize: number;
  inventorySize: number;
  preexistingCount: number;
  unobservedTerminations: number;
  pidReuses: number;
  lastEventAt?: number;
  lastHeartbeatAt?: number;
}

/** Transport abstraction so tests can inject a scripted worker. */
export interface MonitorTransport {
  /** Write a control line to the worker's stdin (unused after boot; kept for protocol symmetry). */
  write?(data: string): void;
  kill(): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (hadError: boolean) => void): void;
}
