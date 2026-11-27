/**
 * AmbientScreenGlance — restrained, local-first background awareness.
 *
 * This is intentionally not a continuous assistant vision loop.  It makes a
 * small signature-only probe at a low cadence, asks local OCR for context
 * only after a meaningful change, and offers help only for a sustained build
 * error pattern.  Pixels and OCR text stay in the existing short-lived,
 * in-memory vision services; this coordinator retains only timestamps and a
 * classification key.
 */
import type { ScreenObserver } from './screenObserver';
import type { ScreenUnderstandingService, ScreenUnderstandingSnapshot } from './screenUnderstanding';

export interface AmbientGlanceOffer {
  kind: 'build_errors';
  message: string;
  detectedAt: number;
}

export interface AmbientGlanceOptions {
  observer: Pick<ScreenObserver, 'detectChanges'>;
  understanding: Pick<ScreenUnderstandingService, 'requestRefresh'>;
  onOffer?: (offer: AmbientGlanceOffer) => void;
  /** A current chat/task must never be interrupted by an ambient offer. */
  mayOffer?: () => boolean;
  now?: () => number;
  schedule?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  intervalMs?: number;
  meaningfulChangeFraction?: number;
  persistenceMs?: number;
  offerCooldownMs?: number;
}

export interface AmbientGlanceDiagnostics {
  running: boolean;
  probes: number;
  meaningfulChanges: number;
  localRefreshes: number;
  offers: number;
  buildErrorSince: number | null;
  lastOfferAt: number | null;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MEANINGFUL_CHANGE = 0.08;
const DEFAULT_PERSISTENCE_MS = 2 * 60 * 60_000;
const DEFAULT_OFFER_COOLDOWN_MS = 6 * 60 * 60_000;

export class AmbientScreenGlance {
  private readonly observer: AmbientGlanceOptions['observer'];
  private readonly understanding: AmbientGlanceOptions['understanding'];
  private readonly onOffer?: AmbientGlanceOptions['onOffer'];
  private readonly mayOffer: () => boolean;
  private readonly now: () => number;
  private readonly schedule: NonNullable<AmbientGlanceOptions['schedule']>;
  private readonly cancel: NonNullable<AmbientGlanceOptions['cancel']>;
  private readonly intervalMs: number;
  private readonly meaningfulChangeFraction: number;
  private readonly persistenceMs: number;
  private readonly offerCooldownMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private buildErrorSince: number | null = null;
  private lastOfferAt: number | null = null;
  private stats: AmbientGlanceDiagnostics = {
    running: false, probes: 0, meaningfulChanges: 0, localRefreshes: 0,
    offers: 0, buildErrorSince: null, lastOfferAt: null,
  };

  constructor(options: AmbientGlanceOptions) {
    this.observer = options.observer;
    this.understanding = options.understanding;
    this.onOffer = options.onOffer;
    this.mayOffer = options.mayOffer ?? (() => true);
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((run, delay) => setTimeout(run, delay));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer));
    this.intervalMs = Math.max(15_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.meaningfulChangeFraction = Math.max(0.01, Math.min(1, options.meaningfulChangeFraction ?? DEFAULT_MEANINGFUL_CHANGE));
    this.persistenceMs = Math.max(60_000, options.persistenceMs ?? DEFAULT_PERSISTENCE_MS);
    this.offerCooldownMs = Math.max(this.persistenceMs, options.offerCooldownMs ?? DEFAULT_OFFER_COOLDOWN_MS);
  }

  /** Start one low-frequency loop. Capture permission remains with ScreenObserver. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stats.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    this.stats.running = false;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  diagnostics(): AmbientGlanceDiagnostics {
    return { ...this.stats, buildErrorSince: this.buildErrorSince, lastOfferAt: this.lastOfferAt };
  }

  private scheduleNext(delay: number): void {
    if (!this.running || this.timer) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.glance();
    }, delay);
  }

  private async glance(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      this.stats.probes += 1;
      const change = await this.observer.detectChanges();
      if (!change.changed || change.changedFraction < this.meaningfulChangeFraction) return;
      this.stats.meaningfulChanges += 1;
      // This route is local OCR and has its own cooldown, rate cap, and SPF
      // screening. A changed screen is the only justification we provide.
      const snapshot = await this.understanding.requestRefresh('change', change.changedFraction);
      if (snapshot) {
        this.stats.localRefreshes += 1;
        this.consider(snapshot);
      }
    } catch {
      // Do not turn a denied/ended share into repeated browser permission
      // prompts. The user can deliberately toggle awareness back on to share
      // a screen again.
      this.stop();
    } finally {
      this.inFlight = false;
      this.scheduleNext(this.intervalMs);
    }
  }

  private consider(snapshot: ScreenUnderstandingSnapshot): void {
    const now = this.now();
    if (!looksLikeBuildErrors(snapshot)) {
      this.buildErrorSince = null;
      return;
    }
    if (this.buildErrorSince === null) this.buildErrorSince = now;
    const persisted = now - this.buildErrorSince >= this.persistenceMs;
    const cooledDown = this.lastOfferAt === null || now - this.lastOfferAt >= this.offerCooldownMs;
    if (!persisted || !cooledDown || !this.mayOffer()) return;

    this.lastOfferAt = now;
    this.stats.offers += 1;
    this.onOffer?.({
      kind: 'build_errors',
      message: 'Build errors have been on screen for a while. Want a summary?',
      detectedAt: now,
    });
  }
}

/** Never retain or repeat OCR text in an ambient offer; classify it in place. */
function looksLikeBuildErrors(snapshot: ScreenUnderstandingSnapshot): boolean {
  const visible = snapshot.texts.map((line) => line.text).join('\n');
  return /\b(?:build\s+(?:failed|error)|compilation\s+(?:failed|error)|(?:typescript|ts)\s*(?:error|\d{4})|error\s+ts\d{4}|failed\s+to\s+compile)\b/i.test(visible);
}
