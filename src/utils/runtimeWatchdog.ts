/**
 * Runtime Watchdog (Step 1 — Background Runtime / Lid-Closed Operation).
 *
 * Keeps Krix's runtime state observable while the window is hidden or the
 * laptop lid is closed (Windows power action: "Do nothing"):
 *
 *  - HEARTBEAT: bounded, visibility-aware probes to the server health
 *    endpoint. 60 s when the tab is visible, 240 s when hidden (hidden tabs
 *    clamp timers to ≥1/min anyway — the slower cadence is deliberate
 *    battery/CPU thrift on low-resource hardware). One setTimeout chain,
 *    never a polling loop, no work between beats.
 *  - SLEEP/WAKE: the laptop suspending (lid-close Modern Standby, explicit
 *    sleep, idle sleep timeout) freezes ALL timers. Two detection signals,
 *    both passive: (a) the Page Lifecycle 'resume' event where the browser
 *    supports it, and (b) timer drift — a heartbeat that fires far later
 *    than scheduled means the process was suspended in between. Detection
 *    NEVER wakes the machine: it only notices that Windows resumed it.
 *  - SERVER LOSS/RESTORE: failed heartbeats mark the server unavailable and
 *    back off (30 s → 600 s bounded). The next successful probe reports
 *    restore — including after the server process itself was restarted.
 *
 * Recovery actions are delegated to subscribers (App.tsx). The watchdog
 * itself performs no state mutation, restarts no services, and holds no
 * privileged handles. CPU cost: one fetch per beat; RAM: a few numbers.
 */

export type RuntimeWatchdogEvent =
  | { kind: 'server_ok'; uptimeMs?: number; startedAt?: number; serverTime?: number }
  | { kind: 'server_lost'; consecutiveFailures: number }
  | { kind: 'server_restored'; downtimeMs?: number }
  | { kind: 'system_resumed'; detection: 'lifecycle_resume' | 'timer_drift'; suspendedForMs?: number }
  | { kind: 'network_offline' }
  | { kind: 'network_online' };

export interface RuntimeWatchdogStatus {
  /** Last known server reachability. */
  serverAvailable: boolean;
  /** True while the tab is hidden. */
  hidden: boolean;
  /** ms of observed server downtime (0 when none known). */
  downtimeMs: number;
  /** Consecutive failed heartbeats. */
  consecutiveFailures: number;
  /** Last successful heartbeat timestamp (0 = never). */
  lastOkAt: number;
  started: boolean;
}

const VISIBLE_BEAT_MS = 60_000;
const HIDDEN_BEAT_MS = 240_000;
/** Backoff schedule for failed probes (bounded). */
const FAILURE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
/**
 * Timer-drift wake threshold: a heartbeat that fires this much later than
 * scheduled implies suspension. Deliberately conservative — ordinary hidden-
 * tab throttling adds at most ~60 s; real sleep adds minutes or hours.
 */
const DRIFT_WAKE_THRESHOLD_MS = 120_000;

export interface RuntimeWatchdogOptions {
  /** Health endpoint URL (default /api/health). */
  healthUrl?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable scheduler (tests) — defaults to window.setTimeout. */
  scheduleFn?: (fn: () => void, delayMs: number) => () => void;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Diagnostic logging (default: console.debug per successful beat). */
  log?: (msg: string) => void;
}

type Unsubscribe = () => void;

export class RuntimeWatchdog {
  private opts: Required<Pick<RuntimeWatchdogOptions, 'healthUrl' | 'now'>> & RuntimeWatchdogOptions;
  private fetchImpl: typeof fetch;
  private scheduleFn: (fn: () => void, delayMs: number) => () => void;
  private cancelNext: (() => void) | null = null;
  private listeners = new Set<(e: RuntimeWatchdogEvent) => void>();
  private nextBeatAt = 0;
  private running = false;
  private offline = false;
  private inFlight = false;
  private detachLifecycle: Unsubscribe | null = null;
  private detachNetwork: Unsubscribe | null = null;

  private serverAvailable = true;
  private consecutiveFailures = 0;
  private downtimeStart = 0;
  private downtimeMs = 0;
  private lastOkAt = 0;

  constructor(options: RuntimeWatchdogOptions = {}) {
    this.opts = { healthUrl: '/api/health', now: () => Date.now(), ...options };
    this.fetchImpl = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (() => { throw new Error('no fetch'); }));
    this.scheduleFn = options.scheduleFn ?? ((fn, delayMs) => {
      const id = setTimeout(fn, delayMs);
      return () => clearTimeout(id);
    });
  }

  // ------------------------------------------------------------- lifecycle

  /** Start the heartbeat + passive listeners (DOM listeners attach only where the DOM exists). Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.detachLifecycle = this.attachLifecycleSignals();
    this.detachNetwork = this.attachNetworkSignals();
    this.scheduleNextBeat(VISIBLE_BEAT_MS);
  }

  /** Stop everything (React unmount). Idempotent. */
  stop(): void {
    this.running = false;
    this.cancelNext?.();
    this.cancelNext = null;
    this.detachLifecycle?.();
    this.detachLifecycle = null;
    this.detachNetwork?.();
    this.detachNetwork = null;
    this.listeners.clear();
  }

  subscribe(listener: (e: RuntimeWatchdogEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): RuntimeWatchdogStatus {
    return {
      serverAvailable: this.serverAvailable,
      hidden: typeof document !== 'undefined' ? document.hidden : false,
      downtimeMs: this.downtimeMs,
      consecutiveFailures: this.consecutiveFailures,
      lastOkAt: this.lastOkAt,
      started: this.running,
    };
  }

  // ---------------------------------------------------------------- events

  private emit(e: RuntimeWatchdogEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(e);
      } catch {
        // a broken subscriber never breaks the watchdog
      }
    }
  }

  // ------------------------------------------------------- passive signals

  /** Page Lifecycle resume (Chrome): the precise suspend/resume signal. */
  private attachLifecycleSignals(): Unsubscribe {
    if (typeof document === 'undefined') return () => undefined;
    const onResume = () => this.handleSystemResumed('lifecycle_resume');
    document.addEventListener('resume', onResume);
    return () => document.removeEventListener('resume', onResume);
  }

  private attachNetworkSignals(): Unsubscribe {
    if (typeof window === 'undefined') return () => undefined;
    const onOffline = () => {
      this.offline = true;
      this.emit({ kind: 'network_offline' });
    };
    const onOnline = () => {
      this.offline = false;
      this.emit({ kind: 'network_online' });
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }

  // -------------------------------------------------------------- schedule

  private currentBeatMs(): number {
    // document.hidden is the lid/window proxy: a hidden tab (or a closed lid
    // with the browser still running) gets the slower, battery-friendly beat.
    const hidden = typeof document !== 'undefined' && (document as { hidden?: boolean }).hidden === true;
    return hidden ? HIDDEN_BEAT_MS : VISIBLE_BEAT_MS;
  }

  private scheduleNextBeat(delayMs?: number): void {
    if (!this.running) return;
    const beat = delayMs ?? this.currentBeatMs();
    this.nextBeatAt = this.opts.now() + beat;
    this.cancelNext?.();
    this.cancelNext = this.scheduleFn(() => {
      this.cancelNext = null;
      void this.heartbeat();
    }, beat);
  }

  // -------------------------------------------------------------- heartbeat

  private async heartbeat(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;

    const startedAt = this.opts.now();
    const expectedAt = this.nextBeatAt;
    try {
      const result = await this.probeHealth();
      const now = this.opts.now();

      // Wake detection (fallback signal): the beat fired far later than it
      // was scheduled ⇒ the whole process was suspended in between.
      const lateBy = startedAt - expectedAt;
      if (this.lastOkAt > 0 && lateBy > DRIFT_WAKE_THRESHOLD_MS) {
        this.emit({ kind: 'system_resumed', detection: 'timer_drift', suspendedForMs: lateBy });
      }

      this.lastOkAt = now;
      const wasDown = !this.serverAvailable;
      this.serverAvailable = true;
      this.consecutiveFailures = 0;
      if (wasDown) {
        this.downtimeMs = this.downtimeStart > 0 ? now - this.downtimeStart : 0;
        this.emit({ kind: 'server_restored', downtimeMs: this.downtimeMs });
        this.downtimeStart = 0;
      }
      this.emit({ kind: 'server_ok', uptimeMs: result.uptimeMs, startedAt: result.startedAt, serverTime: result.serverTime });
      (this.opts.log ?? ((msg) => console.debug(msg)))(`[runtime] heartbeat ok (${Math.round((result.uptimeMs ?? 0) / 1000)}s server uptime)`);
    } catch {
      const now = this.opts.now();
      this.consecutiveFailures += 1;
      if (this.serverAvailable) {
        this.serverAvailable = false;
        this.downtimeStart = now;
        this.emit({ kind: 'server_lost', consecutiveFailures: this.consecutiveFailures });
      }
    } finally {
      this.inFlight = false;
      if (this.running) {
        const backoff =
          this.serverAvailable
            ? undefined
            : FAILURE_BACKOFF_MS[Math.min(this.consecutiveFailures - 1, FAILURE_BACKOFF_MS.length - 1)];
        this.scheduleNextBeat(backoff);
      }
    }
  }

  /** One bounded health probe. Resolves with runtime info or throws. */
  private async probeHealth(): Promise<{ uptimeMs?: number; startedAt?: number; serverTime?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await this.fetchImpl(this.opts.healthUrl, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`health probe status ${res.status}`);
      const body = (await res.json()) as { runtime?: { uptimeMs?: number; startedAt?: number; serverTime?: number } };
      return body?.runtime ?? {};
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------ wake signal

  /** Page Lifecycle 'resume' — the authoritative suspend-return signal. */
  private handleSystemResumed(detection: 'lifecycle_resume'): void {
    const suspendedForMs = this.lastOkAt > 0 ? Math.max(0, this.opts.now() - this.lastOkAt) : undefined;
    this.emit({ kind: 'system_resumed', detection, suspendedForMs });
  }
}

// ------------------------------------------------------------------ singleton

let singleton: RuntimeWatchdog | null = null;

/** Browser singleton (lazy). Tests construct their own instances. */
export function getRuntimeWatchdog(options: RuntimeWatchdogOptions = {}): RuntimeWatchdog {
  if (!singleton) {
    singleton = new RuntimeWatchdog(options);
  }
  return singleton;
}

/** Test hook: reset the singleton. */
export function resetRuntimeWatchdogForTests(): void {
  singleton?.stop();
  singleton = null;
}
