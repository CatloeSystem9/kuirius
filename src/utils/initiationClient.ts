/**
 * Initiation Client — the executor half of the initiation subsystem.
 *
 * The server-side trigger engine (src/agent/initiation) decides WHEN and
 * WHAT. This client decides WHETHER and HOW:
 *
 *   server queue  ->  SSE push  ->  eligibility  ->  execute  ->  deliver  ->  ack
 *
 * Deliberate design decisions:
 *
 * - Execution goes through `system.core.submit(...)`, NOT `runAgentTask(...)`.
 *   `runAgentTask` grants mouse/keyboard/filesystem permissions based on the
 *   TEXT of a request, which is correct for a user request but wrong for an
 *   autonomous mission — a mission must never grant itself a permission the
 *   user never gave. Autonomous tasks run with the DEFAULT permission set and
 *   fail honestly when a tool needs more.
 *
 * - Eligibility is checked here, not on the server, because only the browser
 *   knows whether the user is present, speaking, or inside quiet hours. A
 *   skipped initiation is acked as skipped, never silently dropped.
 *
 * - The client never reads the clipboard, the filesystem or the process list
 *   on its own. It only reacts to events the server already produced.
 */
import type { InitiationAck, InitiationRecord, InitiationSkipReason } from '../agent/initiation/contracts';

export interface InitiationSettings {
  /** Master switch — no initiation runs while this is off. */
  enabled: boolean;
  /** Allow `execute_task` initiations to actually run a task. */
  autoExecute: boolean;
  /** Skip everything inside the quiet-hours window. */
  quietHoursEnabled: boolean;
  quietStartHour: number;
  quietEndHour: number;
  /** Defer an initiation while the user is actively in conversation. */
  respectUserActivity: boolean;
}

export const DEFAULT_INITIATION_SETTINGS: InitiationSettings = {
  enabled: true,
  autoExecute: true,
  quietHoursEnabled: true,
  quietStartHour: 23,
  quietEndHour: 8,
  respectUserActivity: true,
};

/** Build settings from stored companion settings (bounded/clamped). */
export function initiationSettingsFromCompanion(s: {
  initiationEnabled?: boolean;
  initiationAutoExecute?: boolean;
  initiationQuietHoursEnabled?: boolean;
  initiationQuietHoursStart?: number;
  initiationQuietHoursEnd?: number;
  initiationRespectUserActivity?: boolean;
}): InitiationSettings {
  const clampHour = (v: number | undefined, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(23, Math.floor(v))) : fallback;
  return {
    enabled: s.initiationEnabled ?? DEFAULT_INITIATION_SETTINGS.enabled,
    autoExecute: s.initiationAutoExecute ?? DEFAULT_INITIATION_SETTINGS.autoExecute,
    quietHoursEnabled: s.initiationQuietHoursEnabled ?? DEFAULT_INITIATION_SETTINGS.quietHoursEnabled,
    quietStartHour: clampHour(s.initiationQuietHoursStart, DEFAULT_INITIATION_SETTINGS.quietStartHour),
    quietEndHour: clampHour(s.initiationQuietHoursEnd, DEFAULT_INITIATION_SETTINGS.quietEndHour),
    respectUserActivity:
      s.initiationRespectUserActivity ?? DEFAULT_INITIATION_SETTINGS.respectUserActivity,
  };
}

/** Is `hour` (0–23) inside the quiet window (overnight windows supported)? */
export function isInitiationQuietHour(hour: number, start: number, end: number): boolean {
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return false;
  const s = Math.max(0, Math.min(23, Math.floor(start)));
  const e = Math.max(0, Math.min(23, Math.floor(end)));
  if (s === e) return false;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

export interface InitiationClientDeps {
  /** Current settings — read fresh on every decision, never cached stale. */
  getSettings: () => InitiationSettings;
  /** Whether the user is currently in an active conversation. */
  isUserActive: () => boolean;
  /** Whether Krisha is currently speaking (never interrupt playback). */
  isSpeaking: () => boolean;
  /**
   * Run a task through the agent core. Returns an honest summary.
   * MUST NOT grant permissions on the task's behalf.
   */
  executeTask: (prompt: string) => Promise<{ success: boolean; summary: string }>;
  /** Deliver a message to the user (conversation + optional voice). */
  deliver: (text: string, opts: { title?: string; speak?: boolean }) => void;
  /** Surface a short notice (activity feed). */
  notify: (text: string, level?: 'info' | 'success' | 'error') => void;
  /** Report the outcome back to the server. */
  ack: (ack: InitiationAck) => Promise<void>;
  /** Postpone a record that could not be delivered right now. */
  defer?: (id: string, delayMs: number) => Promise<boolean>;
  /** Push the current goal snapshot to the server (cross-reboot continuity). */
  syncGoals?: (goals: unknown[]) => Promise<void>;
  /** The goals to sync (read at call time). */
  getGoals?: () => unknown[];
  /** Silent nightly audit reflection; writes only through MemoryService. */
  reflectNightly?: () => Promise<{ success: boolean; summary: string }>;
  now?: () => number;
  /** Override the stream URL (tests). */
  streamUrl?: string;
}

/** Bounded reconnect attempts — a dead server must not spin the client forever. */
const MAX_RECONNECT_ATTEMPTS = 12;

/** Diagnostics for the settings/diagnostics UI. */
export interface InitiationClientDiagnostics {
  connected: boolean;
  received: number;
  executed: number;
  skipped: number;
  failed: number;
  lastError?: string;
  lastReceivedAt?: number;
}

export class InitiationClient {
  private deps: InitiationClientDeps;
  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = true;
  private readonly clientId: string;
  private readonly nowFn: () => number;
  private readonly streamUrl: string;
  /** Records currently in flight — guards against double execution. */
  private readonly inFlight = new Set<string>();

  private diagnostics: InitiationClientDiagnostics = {
    connected: false,
    received: 0,
    executed: 0,
    skipped: 0,
    failed: 0,
  };

  constructor(deps: InitiationClientDeps) {
    this.deps = deps;
    this.nowFn = deps.now ?? (() => Date.now());
    this.clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
    this.streamUrl = deps.streamUrl ?? '/api/initiation/stream';
  }

  /** Open the stream and start consuming initiations. */
  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    void this.syncGoalsToServer();
  }

  /** Close the stream. */
  public stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.source?.close();
    } catch {
      // already closed
    }
    this.source = null;
    this.diagnostics.connected = false;
  }

  public getDiagnostics(): InitiationClientDiagnostics {
    return { ...this.diagnostics };
  }

  /**
   * Handle one initiation. Exposed so a non-SSE transport (or a test) can
   * feed records in directly.
   */
  public async handleRecord(record: InitiationRecord): Promise<void> {
    if (!record || typeof record.id !== 'string') return;
    if (this.inFlight.has(record.id)) return;
    this.inFlight.add(record.id);
    this.diagnostics.received += 1;
    this.diagnostics.lastReceivedAt = this.nowFn();

    try {
      const skip = record.kind === 'nightly_maintenance' ? null : this.eligibilitySkip(record);
      if (skip) {
        this.diagnostics.skipped += 1;
        // A TRANSIENT skip must not lose the work: quiet hours and a busy
        // user are both temporary. Postpone instead of dropping.
        if (await this.postpone(record, skip)) {
          return;
        }
        await this.report({ id: record.id, success: false, skipped: skip });
        return;
      }

      switch (record.action) {
        case 'notify': {
          this.deps.notify(record.message, 'info');
          await this.report({ id: record.id, success: true, summary: 'notified' });
          return;
        }
        case 'suggest': {
          // A proposal — Krisha speaks and the USER decides. Nothing runs.
          this.deps.deliver(record.message, { title: record.title, speak: true });
          await this.report({ id: record.id, success: true, summary: 'proposed' });
          return;
        }
        case 'execute_task': {
          // Nightly reflection is a bounded local-memory job, not a chat task:
          // it may run quietly during quiet hours and never speaks or grants
          // tools/permissions to itself.
          if (record.kind === 'nightly_maintenance' && this.deps.reflectNightly) {
            const result = await this.deps.reflectNightly();
            if (result.success) this.diagnostics.executed += 1;
            else this.diagnostics.failed += 1;
            await this.report({ id: record.id, success: result.success, summary: result.summary });
            return;
          }
          if (!this.deps.getSettings().autoExecute) {
            this.diagnostics.skipped += 1;
            await this.report({ id: record.id, success: false, skipped: 'disabled' });
            return;
          }
          const prompt = record.taskPrompt || record.message;
          if (!prompt) {
            this.diagnostics.skipped += 1;
            await this.report({ id: record.id, success: false, skipped: 'no_task_prompt' });
            return;
          }
          const result = await this.deps.executeTask(prompt);
          if (result.success) {
            this.diagnostics.executed += 1;
            this.deps.deliver(result.summary || record.message, { title: record.title, speak: true });
          } else {
            this.diagnostics.failed += 1;
            this.deps.notify(`${record.title}: ${result.summary || 'the task did not complete'}`, 'error');
          }
          await this.report({
            id: record.id,
            success: result.success,
            summary: result.summary,
          });
          return;
        }
        default: {
          this.diagnostics.skipped += 1;
          await this.report({ id: record.id, success: false, skipped: 'disabled' });
        }
      }
    } catch (err: any) {
      this.diagnostics.failed += 1;
      this.diagnostics.lastError = err?.message || String(err);
      try {
        await this.report({ id: record.id, success: false, summary: this.diagnostics.lastError });
      } catch {
        // reporting must never throw out of the handler
      }
    } finally {
      this.inFlight.delete(record.id);
    }
  }

  /** Push the current goals to the server so boot-resume survives a reboot. */
  public async syncGoalsToServer(): Promise<void> {
    if (!this.deps.syncGoals || !this.deps.getGoals) return;
    try {
      const goals = this.deps.getGoals() || [];
      await this.deps.syncGoals(goals);
    } catch (err: any) {
      this.diagnostics.lastError = err?.message || String(err);
    }
  }

  // ------------------------------------------------------------- internals

  /**
   * Should this initiation be skipped right now? Returns the reason, or null
   * when it may proceed.
   */
  private eligibilitySkip(record: InitiationRecord): InitiationSkipReason | null {
    const s = this.deps.getSettings();
    if (!s.enabled) return 'disabled';

    if (s.quietHoursEnabled) {
      const hour = new Date(this.nowFn()).getHours();
      if (isInitiationQuietHour(hour, s.quietStartHour, s.quietEndHour)) return 'quiet_hours';
    }

    // Never interrupt playback, and never talk over an active conversation.
    if (this.deps.isSpeaking()) return 'speaking';
    if (s.respectUserActivity && this.deps.isUserActive()) return 'user_active';

    return null;
  }

  private async report(ack: InitiationAck): Promise<void> {
    try {
      await this.deps.ack(ack);
    } catch (err: any) {
      this.diagnostics.lastError = err?.message || String(err);
    }
  }

  /**
   * Postpone a record whose delivery is merely early. Returns false when the
   * skip is permanent or the deferral budget is exhausted — the caller then
   * completes the record as skipped.
   */
  private async postpone(record: InitiationRecord, reason: InitiationSkipReason): Promise<boolean> {
    if (!this.deps.defer) return false;
    // 'disabled' is a standing state, not a transient one — nothing to wait for.
    if (reason !== 'quiet_hours' && reason !== 'user_active' && reason !== 'speaking') return false;

    const delayMs = reason === 'quiet_hours' ? 30 * 60_000 : 10 * 60_000;
    try {
      const deferred = await this.deps.defer(record.id, delayMs);
      return deferred === true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    if (typeof EventSource === 'undefined') return;

    let source: EventSource;
    try {
      source = new EventSource(`${this.streamUrl}?clientId=${encodeURIComponent(this.clientId)}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.source = source;

    source.addEventListener('ready', () => {
      this.diagnostics.connected = true;
    });

    source.addEventListener('initiation', (event) => {
      try {
        const record = JSON.parse((event as MessageEvent).data) as InitiationRecord;
        void this.handleRecord(record);
      } catch (err: any) {
        this.diagnostics.lastError = err?.message || String(err);
      }
    });

    source.onerror = () => {
      this.diagnostics.connected = false;
      // EventSource retries on its own, but a closed stream needs a fresh one.
      try {
        source.close();
      } catch {
        // already closed
      }
      if (this.source === source) this.source = null;
      this.scheduleReconnect();
    };
  }

  /** Reconnect with bounded exponential backoff. */
  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.diagnostics.lastError = 'initiation stream could not be re-established';
      return;
    }
    const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts), 60_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
