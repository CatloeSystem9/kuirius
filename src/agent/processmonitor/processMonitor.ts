/**
 * Process Monitor (Phase A) — event-driven host process visibility.
 *
 * MECHANISM (all facilities MEASURED during the Phase 1 audit): a persistent
 * PowerShell worker registers TEMPORARY, session-owned WMI event
 * subscriptions for process creation and deletion
 * (`__InstanceCreationEvent` / `__InstanceDeletionEvent WITHIN 1 WHERE
 * TargetInstance ISA 'Win32_Process'`) and streams each event to the Node
 * parent as one JSON line. No admin, no permanent WMI consumers, no
 * persistent system-wide subscriptions — the subscriptions live inside the
 * worker process and vanish when it exits. The worker self-exits when its
 * parent dies (parent-PID probe each idle cycle) and Node explicitly kills
 * it on shutdown, so no orphaned monitor survives.
 *
 * HEALTH MODEL: STARTING → ACTIVE (both subscriptions confirmed) →
 * DEGRADED (one subscription failed, or heartbeat stale → re-arming) →
 * FAILED (retry budget exhausted) / STOPPED (intentional). Never reports
 * "fully monitored" unless both streams are confirmed live.
 *
 * INVENTORY: bounded Map keyed by PID with termination tracking, PID-reuse
 * handling, out-of-order (delete-before-create) handling, startup snapshot
 * for pre-existing processes, and oldest-eviction. Honest enrichment:
 * a missing ExecutablePath is recorded as 'unavailable', never invented.
 *
 * AUDIT: lifecycle/health events flow to the E5 chain through an injected
 * callback (metadata only — kinds and counts, NEVER process names or paths;
 * individual process events live only in the bounded in-memory ring).
 *
 * BOUNDARIES: visibility only — this module performs NO process control
 * (no terminate/suspend/inject) and exposes no control surface to agents.
 *
 * NODE-ONLY: imports node:child_process — import only from the server
 * entrypoint and tests.
 */
import { spawn } from 'node:child_process';

import type {
  InventoryEntry,
  MonitorHealth,
  MonitorStatus,
  MonitorTransport,
  ProcessEvent,
} from './monitorTypes';

// ----------------------------------------------------------- PS worker script

const KPM_HEARTBEAT_SECONDS = 15;

/**
 * The worker registers both subscriptions, reports which succeeded, then
 * loops: wait for an event (or heartbeat timeout), emit one JSON line per
 * event, and probe parent liveness so it can never orphan itself.
 * ASCII-only source: PowerShell 5.1 reads BOM-less scripts as ANSI.
 */
export const KPM_WORKER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$parentPid = PPID_PLACEHOLDER
$createOk = $false
$deleteOk = $false
try {
  Register-CimIndicationEvent -Query "SELECT * FROM __InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'" -SourceIdentifier 'KPMCreate' | Out-Null
  $createOk = $true
} catch { }
try {
  Register-CimIndicationEvent -Query "SELECT * FROM __InstanceDeletionEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'" -SourceIdentifier 'KPMDelete' | Out-Null
  $deleteOk = $true
} catch { }
Write-Output ("KPM_READY create=" + [int]$createOk + " delete=" + [int]$deleteOk)
[Console]::Out.Flush()
while ($true) {
  $e = Wait-Event -Timeout ${KPM_HEARTBEAT_SECONDS}
  if ($null -eq $e) {
    $parent = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
    if ($null -eq $parent) { break }
    Write-Output 'KPM_HEARTBEAT'
    [Console]::Out.Flush()
    continue
  }
  $src = $e.SourceIdentifier
  $ti = $e.SourceEventArgs.NewEvent.TargetInstance
  if ($src -eq 'KPMCreate') {
    $o = @{ k = 'create'; name = [string]$ti.Name; pid = [int]$ti.ProcessId; ppid = [int]$ti.ParentProcessId; sid = [int]$ti.SessionId; path = [string]$ti.ExecutablePath }
    Write-Output ('KPM ' + ($o | ConvertTo-Json -Compress -Depth 3))
  } elseif ($src -eq 'KPMDelete') {
    $o = @{ k = 'delete'; name = [string]$ti.Name; pid = [int]$ti.ProcessId }
    Write-Output ('KPM ' + ($o | ConvertTo-Json -Compress -Depth 3))
  }
  try { Remove-Event -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue } catch { }
  [Console]::Out.Flush()
}
Write-Output 'KPM_EXIT'
`;

// ------------------------------------------------------------ monitor config

export interface ProcessMonitorOptions {
  /** Injected transport factory (tests). Default: real PowerShell transport. */
  transportFactory?: () => MonitorTransport;
  /** Injected snapshot function for the startup/pre-reconcile Win32 query. */
  snapshotFn?: () => Promise<Array<{ name: string; pid: number; ppid: number; path?: string; sid?: number }>>;
  maxInventory?: number;
  maxEventBuffer?: number;
  /** Worker boot timeout (READY expected within this budget). */
  bootTimeoutMs?: number;
  /** Heartbeat staleness threshold (worker emits every 15 s when idle). */
  heartbeatTimeoutMs?: number;
  /** Re-arm retry delays after worker failure (consecutive). */
  retryBackoffMs?: number[];
  /** Audit sink for lifecycle events (metadata only). */
  audit?: (event: { kind: string; [key: string]: unknown }) => void;
}

export interface MonitorAuditMeta {
  [key: string]: unknown;
}

const DEFAULT_MAX_INVENTORY = 2000;
const DEFAULT_MAX_EVENT_BUFFER = 500;
const DEFAULT_BOOT_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 50_000; // > 3 idle cycles (15 s each)
const DEFAULT_RETRY_BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000];
const MAX_LINE_LENGTH = 4_096;
const MAX_LINES_PER_CHUNK = 64;

interface PendingDelete {
  pid: number;
  name?: string;
  at: number;
}

// -------------------------------------------------------------- transport

class PowerShellTransport implements MonitorTransport {
  private proc: ReturnType<typeof spawn> | null = null;
  private lineCb: ((line: string) => void) | null = null;
  private closeCb: ((hadError: boolean) => void) | null = null;
  private buffer = '';
  private closedByUs = false;

  constructor(script: string, parentPid: number) {
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout!.on('data', (d: Buffer) => {
      this.buffer += String(d);
      let idx: number;
      let lines = 0;
      while ((idx = this.buffer.indexOf('\n')) >= 0 && lines < MAX_LINES_PER_CHUNK) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        lines++;
        if (line.length > 0 && line.length <= MAX_LINE_LENGTH && this.lineCb) this.lineCb(line);
      }
    });
    this.proc.stderr!.on('data', () => {
      /* stderr noise ignored */
    });
    this.proc.on('close', (code) => {
      const hadError = code !== 0 && !this.closedByUs;
      const cb = this.closeCb;
      this.proc = null;
      if (cb) cb(hadError);
    });
    // NOTE: stdin must stay OPEN — ending it makes the -Command - host hit
    // EOF and exit immediately after the bootstrap, before any event can be
    // observed. The worker lives until killed or until its parent-liveness
    // probe fires.
    this.proc.stdin!.write(script + '\n');
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  onClose(cb: (hadError: boolean) => void): void {
    this.closeCb = cb;
  }

  write(data: string): void {
    try {
      this.proc?.stdin?.write(data);
    } catch {
      /* transport is closing */
    }
  }

  kill(): void {
    this.closedByUs = true;
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

// ------------------------------------------------------------- the monitor

export class ProcessMonitor {
  private options: Required<Pick<ProcessMonitorOptions, 'maxInventory' | 'maxEventBuffer' | 'bootTimeoutMs' | 'heartbeatTimeoutMs' | 'retryBackoffMs'>> & ProcessMonitorOptions;
  private transport: MonitorTransport | null = null;
  private health: MonitorHealth = 'STOPPED';
  private healthReason: string | undefined;
  private startedAt: number | undefined;
  private subscriptions = { creation: false, deletion: false };
  private inventory = new Map<number, InventoryEntry>();
  private eventBuffer: ProcessEvent[] = [];
  private pendingDeletes = new Map<number, PendingDelete>();
  private eventsReceived = 0;
  private eventsDropped = 0;
  private preexistingCount = 0;
  private unobservedTerminations = 0;
  private pidReuses = 0;
  private workerRestarts = 0;
  private lastEventAt: number | undefined;
  private lastHeartbeatAt: number | undefined;
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private intentionalStop = false;
  private lifecycle = 0; // generation — events from an older transport are ignored
  private auditLogCount = 0;

  constructor(options: ProcessMonitorOptions = {}) {
    this.options = {
      maxInventory: options.maxInventory ?? DEFAULT_MAX_INVENTORY,
      maxEventBuffer: options.maxEventBuffer ?? DEFAULT_MAX_EVENT_BUFFER,
      bootTimeoutMs: options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      retryBackoffMs: options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF,
      transportFactory: options.transportFactory,
      snapshotFn: options.snapshotFn,
      audit: options.audit,
    };
  }

  // ---------------------------------------------------------------- audit

  private emitAudit(kind: string, meta: MonitorAuditMeta = {}): void {
    this.auditLogCount++;
    try {
      this.options.audit?.({ kind, ...meta });
    } catch {
      /* audit must never break monitoring */
    }
  }

  // ---------------------------------------------------------------- health

  private setHealth(health: MonitorHealth, reason?: string): void {
    if (this.health !== health || reason !== this.healthReason) {
      this.health = health;
      this.healthReason = reason;
      if (health === 'DEGRADED' || health === 'FAILED') {
        this.emitAudit(`process_monitor_${health.toLowerCase()}`, { reason: reason ?? '' });
      }
    }
  }

  status(): MonitorStatus {
    return {
      health: this.health,
      healthReason: this.healthReason,
      startedAt: this.startedAt,
      subscriptions: { ...this.subscriptions },
      workerRestarts: this.workerRestarts,
      eventsReceived: this.eventsReceived,
      eventsDropped: this.eventsDropped,
      queueSize: this.eventBuffer.length,
      inventorySize: this.inventory.size,
      preexistingCount: this.preexistingCount,
      unobservedTerminations: this.unobservedTerminations,
      pidReuses: this.pidReuses,
      lastEventAt: this.lastEventAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
    };
  }

  /** Recent events (bounded copy, oldest first) — visibility surface. */
  recentEvents(count = 50): ProcessEvent[] {
    return this.eventBuffer.slice(-Math.min(count, this.options.maxEventBuffer));
  }

  /** Bounded inventory view (optionally filtered to running). */
  inventoryView(filter?: { runningOnly?: boolean; limit?: number }): InventoryEntry[] {
    let entries = Array.from(this.inventory.values());
    if (filter?.runningOnly) entries = entries.filter((e) => e.state === 'running');
    entries.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    const limit = Math.min(filter?.limit ?? 500, this.options.maxInventory);
    return entries.slice(0, limit);
  }

  /** Lookup one pid's entry (for lineage questions). */
  lookup(pid: number): InventoryEntry | undefined {
    return this.inventory.get(pid);
  }

  // ---------------------------------------------------------------- start

  async start(): Promise<MonitorHealth> {
    if (this.health === 'ACTIVE' || this.health === 'STARTING') return this.health;
    this.intentionalStop = false;
    this.consecutiveFailures = 0;
    this.health = 'STARTING';
    this.startedAt = Date.now();
    await this.arm(true);
    return this.health;
  }

  /** Clean shutdown: kill worker, clear timers, mark STOPPED. */
  stop(): void {
    this.intentionalStop = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.transport?.kill();
    this.transport = null;
    this.health = 'STOPPED';
    this.healthReason = undefined;
    this.emitAudit('process_monitor_stopped', {});
  }

  // ------------------------------------------------------------ arming

  private async arm(initial: boolean): Promise<void> {
    this.lifecycle += 1;
    const myLifecycle = this.lifecycle;
    this.setHealth(initial ? 'STARTING' : 'DEGRADED', initial ? undefined : 're-arming worker');
    const factory = this.options.transportFactory ?? this.defaultTransportFactory();
    let transport: MonitorTransport | null = null;

    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.options.bootTimeoutMs);
      let booted = false;
      transport = factory();
      transport.onLine((line) => {
        if (!booted) {
          if (line.startsWith('KPM_READY')) {
            booted = true;
            clearTimeout(timer);
            // Subscription confirmation: create=1 delete=1
            const createOk = line.includes('create=1');
            const deleteOk = line.includes('delete=1');
            this.subscriptions = { creation: createOk, deletion: deleteOk };
            resolve(createOk || deleteOk);
          }
          return;
        }
        this.handleLine(line, myLifecycle);
      });
      transport.onClose(() => {
        if (booted) {
          this.handleWorkerExit(myLifecycle);
        } else {
          clearTimeout(timer);
          resolve(false);
        }
      });
    });

    if (!(await ready) || this.intentionalStop) {
      transport?.kill();
      if (this.intentionalStop) return;
      this.scheduleRearm('worker boot failed');
      return;
    }

    this.transport = transport!;
    this.consecutiveFailures = 0;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.watchdogTick(), Math.min(20_000, this.options.heartbeatTimeoutMs));
    this.watchdog.unref?.();

    // Startup snapshot: mark pre-existing processes (bounded by inventory cap).
    try {
      const snapshotFn = this.options.snapshotFn ?? this.defaultSnapshotFn();
      const snapshot = await snapshotFn();
      if (this.lifecycle === myLifecycle && this.transport === transport) {
        let added = 0;
        const now = Date.now();
        for (const p of snapshot) {
          if (this.inventory.has(p.pid) || added >= this.options.maxInventory) continue;
          this.inventory.set(p.pid, {
            pid: p.pid,
            name: p.name,
            path: p.path,
            ppid: p.ppid,
            sessionId: p.sid,
            origin: 'startup',
            state: 'running',
            firstSeenAt: now,
            enrichment: p.path ? 'available' : 'unavailable',
          });
          added++;
        }
        this.preexistingCount = added;
      }
    } catch {
      /* snapshot failure degrades completeness, not the monitor — honest */
    }

    this.setHealth(this.subscriptions.creation && this.subscriptions.deletion ? 'ACTIVE' : 'DEGRADED', this.subscriptions.creation && this.subscriptions.deletion ? undefined : 'partial subscriptions');
    if (!initial) this.emitAudit('process_monitor_rearmed', { restarts: this.workerRestarts });
    else this.emitAudit('process_monitor_started', { subscriptions: this.subscriptions });
  }

  private scheduleRearm(reason: string): void {
    if (this.intentionalStop) return;
    const attempt = this.consecutiveFailures;
    if (attempt >= this.options.retryBackoffMs.length) {
      this.setHealth('FAILED', `${reason}; retry budget exhausted (${attempt} attempts)`);
      return;
    }
    this.consecutiveFailures += 1;
    this.setHealth('DEGRADED', `${reason}; re-arming (attempt ${this.consecutiveFailures})`);
    this.workerRestarts += 1;
    const delay = this.options.retryBackoffMs[Math.min(attempt, this.options.retryBackoffMs.length - 1)];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.intentionalStop) void this.arm(false);
    }, delay);
    this.retryTimer.unref?.();
  }

  private handleWorkerExit(myLifecycle: number): void {
    if (this.lifecycle !== myLifecycle || this.intentionalStop) return;
    this.subscriptions = { creation: false, deletion: false };
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.scheduleRearm('worker exited unexpectedly');
  }

  private watchdogTick(): void {
    if (this.health === 'ACTIVE') {
      const stale = this.lastHeartbeatAt === undefined || Date.now() - this.lastHeartbeatAt > this.options.heartbeatTimeoutMs;
      if (stale) {
        // Telemetry interrupted: re-arm.
        this.transport?.kill();
        this.scheduleRearm('heartbeat stale');
      }
    }
  }

  private defaultTransportFactory(): () => MonitorTransport {
    return () => new PowerShellTransport(KPM_WORKER_SCRIPT.replace('PPID_PLACEHOLDER', String(process.pid)), process.pid);
  }

  private defaultSnapshotFn(): () => Promise<Array<{ name: string; pid: number; ppid: number; path?: string; sid?: number }>> {
    return async () => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process | Select-Object -First 2000 Name,ProcessId,ParentProcessId,SessionId,ExecutablePath | ConvertTo-Json -Compress -Depth 2",
        ],
        { timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
      );
      const parsed = JSON.parse(stdout) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((p): p is { Name: string; ProcessId: number; ParentProcessId: number; SessionId?: number; ExecutablePath?: string } => !!p && typeof p === 'object' && Number.isFinite((p as any).ProcessId))
        .map((p) => ({ name: p.Name, pid: p.ProcessId, ppid: p.ParentProcessId, path: p.ExecutablePath || undefined, sid: p.SessionId }));
    };
  }

  // ------------------------------------------------------------- events

  private handleLine(line: string, myLifecycle: number): void {
    if (this.lifecycle !== myLifecycle) return;
    if (line === 'KPM_HEARTBEAT') {
      this.lastHeartbeatAt = Date.now();
      if (this.health === 'DEGRADED' && this.healthReason?.includes('re-arming')) return;
      return;
    }
    if (!line.startsWith('KPM ')) return;
    let parsed: any;
    try {
      parsed = JSON.parse(line.slice(4));
    } catch {
      return; // malformed line — never invent an event
    }
    if (parsed?.k === 'create') this.handleCreate(parsed);
    else if (parsed?.k === 'delete') this.handleDelete(parsed);
  }

  private pushEvent(event: ProcessEvent): void {
    this.eventsReceived += 1;
    this.lastEventAt = event.at;
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.options.maxEventBuffer) {
      this.eventBuffer.shift();
      this.eventsDropped += 1;
      if (this.eventsDropped % 50 === 1) this.emitAudit('process_monitor_queue_overflow', { dropped: this.eventsDropped });
    }
    // Phase B: detection engine subscribers (in-process; bounded fan-out).
    for (const cb of this.eventListeners) {
      try {
        cb(event);
      } catch {
        /* a subscriber must never break the monitor */
      }
    }
  }

  private eventListeners = new Set<(event: ProcessEvent) => void>();

  /**
   * Subscribe to live process events (Phase B detection engine consumes
   * Phase A telemetry through this internal interface — no second monitor
   * is created). Returns an unsubscribe function. A failing subscriber is
   * isolated and never breaks the monitor.
   */
  onEvent(cb: (event: ProcessEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  private handleCreate(parsed: any): void {
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return;
    const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
    const path = typeof parsed.path === 'string' && parsed.path.length > 0 ? parsed.path : undefined;
    const ppid = Number.isInteger(parsed.ppid) ? Number(parsed.ppid) : undefined;
    const sid = Number.isInteger(parsed.sid) ? Number(parsed.sid) : undefined;
    const at = Date.now();

    const existing = this.inventory.get(pid);
    const reused = !!existing && (existing.name !== name || (path !== undefined && existing.path !== undefined && existing.path !== path));
    if (reused) this.pidReuses += 1;

    const entry: InventoryEntry = {
      pid,
      name,
      path,
      ppid,
      sessionId: sid,
      origin: 'observed',
      state: 'running',
      firstSeenAt: at,
      enrichment: path ? 'available' : 'unavailable',
      reused: reused || undefined,
    };
    this.inventory.set(pid, entry);
    const pending = this.pendingDeletes.get(pid);
    if (pending) this.pendingDeletes.delete(pid);

    this.pushEvent({ kind: 'create', pid, name, ppid, sessionId: sid, path, at, source: 'wmi-worker', enriched: !!path });
    this.evictIfNeeded();
  }

  private handleDelete(parsed: any): void {
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return;
    const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined;
    const at = Date.now();
    const existing = this.inventory.get(pid);
    if (existing) {
      existing.state = 'terminated-unconfirmed';
      existing.terminatedAt = at;
      if (!existing.name && name) existing.name = name;
    } else {
      // Delete-before-create (out of order) or a process that died inside the
      // first poll window: record honestly as unobserved, never invented.
      this.unobservedTerminations += 1;
      this.pendingDeletes.set(pid, { pid, name, at });
      if (this.pendingDeletes.size > 200) {
        const oldest = this.pendingDeletes.keys().next().value;
        if (oldest !== undefined) this.pendingDeletes.delete(oldest);
      }
      if (!existing && !this.inventory.has(pid)) {
        this.inventory.set(pid, {
          pid,
          name,
          origin: 'unobserved',
          state: 'terminated-unconfirmed',
          firstSeenAt: at,
          terminatedAt: at,
          enrichment: 'unavailable',
        });
      }
    }
    this.pushEvent({ kind: 'delete', pid, name, at, source: 'wmi-worker', previouslyObserved: !!existing });
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.inventory.size > this.options.maxInventory) {
      // Evict oldest terminated-unconfirmed first; then oldest entry.
      let victim: number | undefined;
      let oldestTerminated: number | undefined;
      let oldestAny: number | undefined;
      for (const [pid, e] of this.inventory) {
        if (e.state === 'terminated-unconfirmed' && (oldestTerminated === undefined || e.firstSeenAt < (this.inventory.get(oldestTerminated)?.firstSeenAt ?? Infinity))) oldestTerminated = pid;
        if (oldestAny === undefined || e.firstSeenAt < (this.inventory.get(oldestAny)?.firstSeenAt ?? Infinity)) oldestAny = pid;
      }
      victim = oldestTerminated ?? oldestAny;
      if (victim === undefined) break;
      this.inventory.delete(victim);
    }
  }

  /** On-demand bounded reconciliation against a live snapshot (drift correction). */
  async reconcile(): Promise<{ corrected: number; snapshotSize: number } | null> {
    if (this.health !== 'ACTIVE') return null;
    try {
      const snapshotFn = this.options.snapshotFn ?? this.defaultSnapshotFn();
      const snapshot = await snapshotFn();
      const live = new Set(snapshot.map((p) => p.pid));
      let corrected = 0;
      const now = Date.now();
      for (const [pid, e] of this.inventory) {
        if (e.origin === 'observed' && e.state === 'running' && !live.has(pid)) {
          e.state = 'terminated-unconfirmed';
          e.terminatedAt = now;
          corrected++;
        }
      }
      let added = 0;
      for (const p of snapshot) {
        if (!this.inventory.has(p.pid) && this.inventory.size < this.options.maxInventory) {
          this.inventory.set(p.pid, {
            pid: p.pid,
            name: p.name,
            path: p.path,
            ppid: p.ppid,
            sessionId: p.sid,
            origin: 'startup',
            state: 'running',
            firstSeenAt: now,
            enrichment: p.path ? 'available' : 'unavailable',
          });
          added++;
          corrected++;
        }
      }
      this.emitAudit('process_monitor_reconciled', { corrected, snapshotSize: snapshot.length });
      return { corrected: corrected - added, snapshotSize: snapshot.length };
    } catch {
      return null;
    }
  }

  /** Test/ops hook: audit events emitted so far (count). */
  get auditEventCount(): number {
    return this.auditLogCount;
  }
}
