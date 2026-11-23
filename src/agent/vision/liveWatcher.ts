/**
 * LiveScreenWatcher — lightweight continuous screen observation (browser).
 *
 * Samples the EXISTING getDisplayMedia stream through the capture source's
 * cheap `captureAnalysis()` probe (analysis-resolution RGBA, reused canvas,
 * NO JPEG encoding) and runs the existing block-signature change detector on
 * every probe. It is the sampling half of the Live Screen Perception system:
 * the watcher decides WHEN the screen changed; the understanding service
 * (screenUnderstanding.ts) decides WHEN that change is worth OCR.
 *
 * Resource design (8 GB RAM, 2-core i3 targets):
 *  - one pending probe at a time (no frame queues, no accumulation);
 *  - no retained pixel data (each probe's buffer is consumed immediately);
 *  - adaptive interval: idle 4 s → active 1.5 s → burst 800 ms, driven by
 *    quiet/change streaks and an external computer-use hint;
 *  - probing pauses while the tab is hidden (visibilitychange) and when the
 *    capture stream ends; timers are fully cleared by stop();
 *  - every capture failure backs off (never spins).
 *
 * Permission: requires 'screen.observation' (default-deny, same domain as
 * every other screen API) — the watcher NEVER bypasses the Screen Privacy
 * Firewall: probes produce signatures only, and no pixel data leaves this
 * module.
 */
import type { AgentEventBus } from '../events';
import type { PermissionManager } from '../permissions';
import { compareSignatures, computeBlockSignature } from './signatures';
import type { CaptureSource, ScreenChangeResult, ScreenSignature } from './visionTypes';
import { ObserverError } from './visionTypes';

export interface LiveIntervals {
  /** Unchanged screen (quiet streak ≥ 3). */
  idleMs: number;
  /** Normal watching cadence. */
  activeMs: number;
  /** Burst after meaningful changes or while computer-use is active. */
  burstMs: number;
}

export const DEFAULT_LIVE_INTERVALS: LiveIntervals = {
  idleMs: 4000,
  activeMs: 1500,
  burstMs: 800,
};

/** Change thresholds (fraction of signature blocks) — mirrors Phase 13 classes. */
const MINOR_CHANGE_FRACTION = 0.04;
const MAJOR_CHANGE_FRACTION = 0.15;

export interface LiveWatchStats {
  probes: number;
  unchanged: number;
  minor: number;
  major: number;
  failed: number;
  /** Last probe compute duration (draw + getImageData + signature), ms. */
  lastProbeMs: number | null;
  avgProbeMs: number | null;
  /** Time between the previous probe and the one that detected a change. */
  lastChangeDetectMs: number | null;
  currentIntervalMs: number | null;
  running: boolean;
  startedAt: number | null;
}

export interface LiveWatcherOptions {
  captureSource: CaptureSource;
  events?: AgentEventBus;
  permissions?: PermissionManager;
  /** Called for MINOR/MAJOR changes (never for unchanged probes). */
  onChange?: (result: ScreenChangeResult, fraction: number) => void;
  now?: () => number;
  intervals?: Partial<LiveIntervals>;
}

type LiveChangeClass = 'none' | 'minor' | 'major';

export class LiveScreenWatcher {
  private captureSource: CaptureSource;
  private events?: AgentEventBus;
  private permissions?: PermissionManager;
  private onChange?: (result: ScreenChangeResult, fraction: number) => void;
  private changeHooks: Array<(fraction: number, klass: LiveChangeClass) => void> = [];
  private nowFn: () => number;
  private intervals: LiveIntervals;

  private running = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private probing = false;
  private hidden = false;

  private lastSignature: ScreenSignature | null = null;
  private lastProbeAt = 0;
  private quietStreak = 0;
  private changeStreak = 0;
  private lastChangeAt = 0;
  private computerUseActive = false;

  private stats: LiveWatchStats = {
    probes: 0, unchanged: 0, minor: 0, major: 0, failed: 0,
    lastProbeMs: null, avgProbeMs: null, lastChangeDetectMs: null,
    currentIntervalMs: null, running: false, startedAt: null,
  };
  private probeMsSum = 0;

  constructor(options: LiveWatcherOptions) {
    this.captureSource = options.captureSource;
    this.events = options.events;
    this.permissions = options.permissions;
    this.onChange = options.onChange;
    this.nowFn = options.now ?? Date.now;
    this.intervals = { ...DEFAULT_LIVE_INTERVALS, ...(options.intervals ?? {}) };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      this.hidden = document.visibilityState === 'hidden';
    }
  }

  private onVisibility = (): void => {
    this.hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    // Resume the loop immediately when becoming visible again.
    if (this.running && !this.hidden && !this.timer && !this.probing) {
      this.schedule(0);
    }
  };

  /** Computer-use tasks temporarily keep the fast cadence. */
  setComputerUseActive(active: boolean): void {
    this.computerUseActive = active;
  }

  /**
   * Register a change consumer (e.g. the understanding service). Returns a
   * detach function. Hooks receive (fraction, class) for MINOR/MAJOR changes.
   */
  onChangeHook(fn: (fraction: number, klass: LiveChangeClass) => void): () => void {
    this.changeHooks.push(fn);
    return () => {
      this.changeHooks = this.changeHooks.filter((h) => h !== fn);
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Permission-gated start (idempotent). The capture stream is NOT started here — probes start it lazily. */
  start(): void {
    if (this.running) return;
    if (this.permissions && !this.permissions.isGranted('screen.observation')) {
      throw new ObserverError('permission_denied', 'Live screen watching requires the "screen.observation" permission');
    }
    this.running = true;
    this.stopped = false;
    this.quietStreak = 0;
    this.changeStreak = 0;
    this.stats = {
      probes: 0, unchanged: 0, minor: 0, major: 0, failed: 0,
      lastProbeMs: null, avgProbeMs: null, lastChangeDetectMs: null,
      currentIntervalMs: null, running: true, startedAt: this.nowFn(),
    };
    this.probeMsSum = 0;
    this.events?.emit({ name: 'SCREEN_LIVE_STARTED', payload: { intervals: this.intervals }, timestamp: Date.now() });
    this.schedule(this.hidden ? this.intervals.idleMs : 0);
  }

  /** Immediate stop: clears the timer, releases nothing else (capture stream is shared). */
  stop(): void {
    if (!this.running && !this.timer) {
      this.stopped = true;
      return;
    }
    this.running = false;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stats.currentIntervalMs = null;
    this.stats.running = false;
    this.events?.emit({ name: 'SCREEN_LIVE_STOPPED', payload: { stats: { ...this.stats } }, timestamp: Date.now() });
  }

  /** Called by the bridge on teardown — same as stop() but also drops listeners. */
  dispose(): void {
    this.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  getStats(): LiveWatchStats {
    return { ...this.stats };
  }

  // ------------------------------------------------------------------ loop

  private schedule(delayMs: number): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.probe();
    }, Math.max(0, delayMs));
    this.stats.currentIntervalMs = delayMs;
  }

  private currentInterval(): number {
    if (this.hidden) return this.intervals.idleMs;
    // Burst: computer-use active, repeated changes, or a recent meaningful
    // change (hold the fast cadence ~3 s so follow-up motion is caught).
    const recentChange = this.lastChangeAt > 0 && this.nowFn() - this.lastChangeAt < 3000;
    if (this.computerUseActive || this.changeStreak >= 2 || recentChange) return this.intervals.burstMs;
    if (this.quietStreak >= 3) return this.intervals.idleMs;
    return this.intervals.activeMs;
  }

  private classify(fraction: number): LiveChangeClass {
    if (fraction <= 0) return 'none';
    if (fraction >= MAJOR_CHANGE_FRACTION) return 'major';
    if (fraction >= MINOR_CHANGE_FRACTION) return 'minor';
    return 'none';
  }

  private async probe(): Promise<void> {
    if (!this.running || this.probing) return;
    this.probing = true;
    const startedAt = this.nowFn();
    try {
      // Cheap probe — analysis buffer only (captureAnalysis falls back to
      // capture() for sources that do not implement it, e.g. test fakes).
      const probe = this.captureSource.captureAnalysis
        ? await this.captureSource.captureAnalysis()
        : await this.captureSource.capture();
      const probeMs = this.nowFn() - startedAt;
      this.stats.probes += 1;
      this.stats.lastProbeMs = probeMs;
      this.probeMsSum += probeMs;
      this.stats.avgProbeMs = this.probeMsSum / this.stats.probes;

      const signature = computeBlockSignature(probe);
      const sinceLast = this.lastProbeAt > 0 ? startedAt - this.lastProbeAt : 0;
      this.lastProbeAt = startedAt;

      if (this.lastSignature) {
        const result = compareSignatures(this.lastSignature, signature);
        this.lastSignature = signature;
        const changeClass = this.classify(result.changedFraction);
        if (changeClass === 'none') {
          this.stats.unchanged += 1;
          this.quietStreak += 1;
          this.changeStreak = 0;
        } else {
          if (changeClass === 'major') this.stats.major += 1;
          else this.stats.minor += 1;
          this.changeStreak += 1;
          this.quietStreak = 0;
          this.lastChangeAt = startedAt;
          this.stats.lastChangeDetectMs = sinceLast;
          this.events?.emit({
            name: 'SCREEN_CHANGED',
            payload: { changedFraction: result.changedFraction, regions: result.regions.length, live: true, klass: changeClass },
            timestamp: Date.now(),
          });
          this.onChange?.(result, result.changedFraction);
          for (const hook of this.changeHooks) {
            try {
              hook(result.changedFraction, changeClass);
            } catch {
              // consumer errors never break the watch loop
            }
          }
        }
      } else {
        // First probe: baseline only (no change claim — nothing to compare).
        this.lastSignature = signature;
      }
    } catch {
      // Structured backoff: capture failures (permission revoked, stream ended,
      // transient errors) slow the loop down instead of spinning.
      this.stats.failed += 1;
      this.quietStreak += 2;
    } finally {
      this.probing = false;
      if (this.running) this.schedule(this.currentInterval());
    }
  }
}
