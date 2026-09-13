/**
 * Screen Observation Service (Phase 4, spec §2).
 *
 * capture → analyze → understand → represent screen state → detect changes →
 * provide context. Independent from the UI; permission-gated through the
 * Phase 3 PermissionManager ('screen.observation', default-deny).
 *
 * Resource discipline (spec §19):
 *  - capture reuse via maxAgeMs (no duplicate captures inside a task step)
 *  - analysis runs on a downscaled RGBA buffer, never the full frame
 *  - cloud analysis is strictly opt-in per call
 *  - no polling loops; modes only influence reuse windows (adaptive scheduling is Phase 13)
 *
 * Privacy (spec §20–21): image data never persists — a bounded in-memory
 * snapshot cache (max 3 entries, 60s TTL) holds data URLs only long enough
 * for follow-up questions, and purgeSnapshots()/stop() clear everything.
 */
import type {
  ActiveWindowInfo,
  CapturedFrame,
  CaptureSource,
  ObservationMode,
  ScreenChangeResult,
  ScreenState,
  ScreenStateDiff,
  VisionAnalysisContext,
  VisionProvider,
} from './visionTypes';
import { MODE_RECOMMENDED_MAX_AGE_MS, ObserverError } from './visionTypes';
import { AgentEventBus } from '../events';
import { PermissionManager } from '../permissions';
import { computeBlockSignature, compareSignatures } from './signatures';
import { LocalPixelVisionProvider } from './localPixelVision';
import { GeminiVisionProvider } from './geminiVision';

const SNAPSHOT_CACHE_LIMIT = 3;
const SNAPSHOT_TTL_MS = 60_000;
const CAPTURE_TIMEOUT_MS = 8000;
const STATE_HISTORY_LIMIT = 8;

interface SnapshotEntry {
  dataUrl?: string;
  addedAt: number;
}

export interface ScreenObserverOptions {
  captureSource: CaptureSource;
  events?: AgentEventBus;
  permissions?: PermissionManager;
  providers?: VisionProvider[];
  /** Capture timeout override (tests use small values). */
  captureTimeoutMs?: number;
}

export class ScreenObserver {
  private captureSource: CaptureSource;
  private events: AgentEventBus | null;
  private permissions: PermissionManager | null;
  private providers: { local: VisionProvider; cloud: VisionProvider };
  private captureTimeoutMs: number;
  private lastState: ScreenState | null = null;
  private stateHistory: ScreenState[] = [];
  private lastActiveWindow: ActiveWindowInfo | null = null;
  private lastChangeResult: ScreenChangeResult | null = null;
  private snapshots = new Map<string, SnapshotEntry>();
  private mode: ObservationMode = 'on_demand';
  private stateCounter = 0;

  constructor(options: ScreenObserverOptions) {
    this.captureSource = options.captureSource;
    this.events = options.events ?? null;
    this.permissions = options.permissions ?? null;
    this.captureTimeoutMs = options.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS;
    this.providers = {
      local: options.providers?.[0] ?? new LocalPixelVisionProvider(),
      cloud: options.providers?.[1] ?? new GeminiVisionProvider(),
    };
  }

  // ------------------------------------------------------------------ modes

  setMode(mode: ObservationMode): void {
    this.mode = mode;
  }

  getMode(): ObservationMode {
    return this.mode;
  }

  /** Scheduling hint for later phases — no timers are run in Phase 4. */
  getRecommendedReuseWindow(): number {
    return MODE_RECOMMENDED_MAX_AGE_MS[this.mode];
  }

  // ------------------------------------------------------------- permission

  private ensureAllowed(): void {
    if (this.permissions && !this.permissions.isGranted('screen.observation')) {
      throw new ObserverError('permission_denied', 'Screen observation is disabled: the "screen.observation" permission is not granted');
    }
  }

  // ---------------------------------------------------------------- capture

  private async captureFrame(): Promise<CapturedFrame> {
    this.ensureAllowed();
    this.events?.emit({ name: 'SCREEN_OBSERVATION_STARTED', timestamp: Date.now() });
    try {
      return await withTimeout(this.captureSource.capture(), this.captureTimeoutMs, 'timeout');
    } catch (err) {
      if (err instanceof ObserverError) throw err;
      const message = String((err as any)?.message || err);
      if (/not supported|unsupported|notallowed|permission/i.test(message)) {
        throw new ObserverError('permission_denied', `Screen capture rejected or unsupported: ${message}`);
      }
      throw new ObserverError('capture_failed', `Screen capture failed: ${message}`);
    }
  }

  // ----------------------------------------------------------------- states

  /** Current structured screen state (capture + analyze), with reuse window. */
  async getCurrentState(options: { analyze?: 'auto' | 'cloud'; question?: string; maxAgeMs?: number } = {}): Promise<ScreenState> {
    const maxAge = options.maxAgeMs ?? this.getRecommendedReuseWindow();
    if (this.lastState && maxAge > 0 && Date.now() - this.lastState.timestamp < maxAge) {
      return this.lastState; // unchanged-screen optimization: skip recapture entirely
    }

    const frame = await this.captureFrame();

    const provider = options.analyze === 'cloud' ? this.providers.cloud : this.providers.local;
    if (!provider.available()) {
      throw new ObserverError('provider_unavailable', `Vision provider "${provider.name}" is unavailable`);
    }

    const activeWindow = this.captureSource.getActiveWindowInfo();
    let analysis;
    try {
      analysis = await provider.analyze(frame, { question: options.question, activeWindow });
      this.events?.emit({ name: 'SCREEN_ANALYSIS_COMPLETED', payload: { provider: analysis.provider, confidence: analysis.confidence }, timestamp: Date.now() });
    } catch (err) {
      const kind = err instanceof ObserverError ? err.kind : 'analysis_failed';
      const message = err instanceof ObserverError ? err.message : String((err as any)?.message || err);
      this.events?.emit({ name: 'SCREEN_ANALYSIS_FAILED', payload: { error: message, kind }, timestamp: Date.now() });
      throw new ObserverError(kind === 'provider_unavailable' ? 'provider_unavailable' : 'analysis_failed', message);
    }

    const state: ScreenState = {
      id: `screen_${Date.now()}_${++this.stateCounter}`,
      timestamp: frame.capturedAt,
      activeWindow,
      size: { width: frame.width, height: frame.height },
      signature: computeBlockSignature(frame),
      analysis,
      snapshotRef: frame.dataUrl ? this.storeSnapshot(frame.dataUrl) : undefined,
    };

    // Active-window change detection (metadata only, no extra capture).
    if (
      this.lastActiveWindow &&
      (this.lastActiveWindow.title !== activeWindow.title || this.lastActiveWindow.surface !== activeWindow.surface)
    ) {
      this.events?.emit({ name: 'ACTIVE_WINDOW_CHANGED', payload: { from: this.lastActiveWindow, to: activeWindow }, timestamp: Date.now() });
    }
    this.lastActiveWindow = activeWindow;

    this.lastState = state;
    this.pushHistory(state);
    this.events?.emit({ name: 'SCREEN_OBSERVED', payload: { stateId: state.id, provider: analysis.provider }, timestamp: Date.now() });
    return state;
  }

  /** Bounded in-memory history of recent states (no image data) for comparisons. */
  listStates(): ScreenState[] {
    return [...this.stateHistory];
  }

  private pushHistory(state: ScreenState): void {
    this.stateHistory.push(state);
    if (this.stateHistory.length > STATE_HISTORY_LIMIT) this.stateHistory.shift();
  }

  /** Latest state if one exists (no capture). */
  peekCurrentState(): ScreenState | null {
    return this.lastState;
  }

  // ------------------------------------------------------- change detection

  /** Cheap capture + signature comparison; no vision analysis runs here. */
  async detectChanges(): Promise<ScreenChangeResult> {
    const frame = await this.captureFrame();
    const signature = computeBlockSignature(frame);

    if (!this.lastState) {
      const result: ScreenChangeResult = {
        changed: false,
        changedFraction: 0,
        changedBlocks: 0,
        totalBlocks: signature.blocks.length,
        regions: [],
        currentTimestamp: Date.now(),
      };
      this.lastState = {
        id: `screen_${Date.now()}_${++this.stateCounter}`,
        timestamp: frame.capturedAt,
        activeWindow: this.captureSource.getActiveWindowInfo(),
        size: { width: frame.width, height: frame.height },
        signature,
        analysis: {
          provider: 'signature_only',
          summary: 'Baseline signature captured (no analysis performed).',
          texts: [],
          elements: [],
          dialogs: [],
          errors: [],
          warnings: [],
          confidence: 0.2,
        },
      };
      this.pushHistory(this.lastState);
      return result;
    }

    const result = compareSignatures(this.lastState.signature, signature);
    result.previousTimestamp = this.lastState.timestamp;
    this.lastChangeResult = result;
    if (result.changed) {
      this.events?.emit({
        name: 'SCREEN_CHANGED',
        payload: { changedFraction: result.changedFraction, regions: result.regions.length },
        timestamp: Date.now(),
      });
    }
    // Update the baseline signature without replacing the last analysis.
    this.lastState = {
      ...this.lastState,
      id: `screen_${Date.now()}_${++this.stateCounter}`,
      timestamp: frame.capturedAt,
      signature,
    };
    this.pushHistory(this.lastState);
    return result;
  }

  peekLastChange(): ScreenChangeResult | null {
    return this.lastChangeResult;
  }

  // ------------------------------------------------------------- comparison

  compareStates(previous: ScreenState, current: ScreenState): ScreenStateDiff {
    const signatureDiff = compareSignatures(previous.signature, current.signature);

    const prevTexts = new Set(previous.analysis.texts.map((t) => t.text.toLowerCase()));
    const currTexts = current.analysis.texts.map((t) => t.text);
    const textsAdded = currTexts.filter((t) => !prevTexts.has(t.toLowerCase()));
    const currTextSet = new Set(current.analysis.texts.map((t) => t.text.toLowerCase()));
    const textsRemoved = previous.analysis.texts.map((t) => t.text).filter((t) => !currTextSet.has(t.toLowerCase()));

    const prevElementKeys = new Set(previous.analysis.elements.map(elementKey));
    const elementsAdded = current.analysis.elements.filter((e) => !prevElementKeys.has(elementKey(e)));
    const currElementKeys = new Set(current.analysis.elements.map(elementKey));
    const elementsRemoved = previous.analysis.elements.filter((e) => !currElementKeys.has(elementKey(e)));

    const errorTexts = current.analysis.errors;
    const errorAppeared = errorTexts.length > previous.analysis.errors.length;
    const dialogAppeared = current.analysis.dialogs.length > previous.analysis.dialogs.length;
    const activeWindowChanged =
      previous.activeWindow.title !== current.activeWindow.title ||
      previous.activeWindow.surface !== current.activeWindow.surface;
    const applicationChanged = Boolean(previous.analysis.application) && previous.analysis.application !== current.analysis.application;
    const loadingChanged =
      previous.analysis.loading === undefined && current.analysis.loading === undefined
        ? null
        : previous.analysis.loading !== current.analysis.loading;

    const parts: string[] = [];
    if (!signatureDiff.changed && !activeWindowChanged) {
      parts.push('No meaningful change detected between the two observations.');
    } else {
      if (activeWindowChanged) {
        parts.push(
          `The visible window changed${previous.activeWindow.title ? ` from "${previous.activeWindow.title}"` : ''}${current.activeWindow.title ? ` to "${current.activeWindow.title}"` : ''}.`
        );
      }
      if (applicationChanged) parts.push(`The application changed from ${previous.analysis.application} to ${current.analysis.application}.`);
      if (dialogAppeared) parts.push('A new dialog or popup appeared.');
      if (errorAppeared) parts.push(`An error appeared: ${errorTexts.slice(0, 3).join('; ')}.`);
      if (textsAdded.length > 0) parts.push(`New text: ${textsAdded.slice(0, 5).map((t) => `"${truncate(t, 60)}"`).join(', ')}.`);
      if (textsRemoved.length > 0) parts.push(`${textsRemoved.length} text item(s) disappeared.`);
      if (elementsAdded.length > 0) parts.push(`${elementsAdded.length} new element(s) appeared.`);
      if (loadingChanged !== null) parts.push(loadingChanged ? 'Loading started or is in progress.' : 'Loading finished.');
      parts.push(`Roughly ${Math.round(signatureDiff.changedFraction * 100)}% of the screen changed.`);
    }

    return {
      activeWindowChanged,
      applicationChanged,
      textsAdded,
      textsRemoved,
      elementsAdded,
      elementsRemoved,
      errorAppeared,
      errorTexts,
      dialogAppeared,
      loadingChanged,
      changedFraction: signatureDiff.changedFraction,
      description: parts.join(' '),
    };
  }

  // ---------------------------------------------------------- active window

  getActiveWindow(): ActiveWindowInfo {
    return this.captureSource.getActiveWindowInfo();
  }

  // ------------------------------------------------------- snapshot cache

  private storeSnapshot(dataUrl: string): string {
    const ref = `snapshot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.snapshots.set(ref, { dataUrl, addedAt: Date.now() });
    this.evictSnapshots();
    return ref;
  }

  private evictSnapshots(): void {
    const now = Date.now();
    for (const [ref, entry] of this.snapshots) {
      if (now - entry.addedAt > SNAPSHOT_TTL_MS) this.snapshots.delete(ref);
    }
    while (this.snapshots.size > SNAPSHOT_CACHE_LIMIT) {
      const oldest = Array.from(this.snapshots.entries()).sort((a, b) => a[1].addedAt - b[1].addedAt)[0];
      if (!oldest) break;
      this.snapshots.delete(oldest[0]);
    }
  }

  /** Retrieve a cached snapshot (for follow-up cloud questions); may be expired. */
  getSnapshot(ref: string): string | undefined {
    const entry = this.snapshots.get(ref);
    if (!entry) return undefined;
    if (Date.now() - entry.addedAt > SNAPSHOT_TTL_MS) {
      this.snapshots.delete(ref);
      return undefined;
    }
    return entry.dataUrl;
  }

  snapshotCount(): number {
    this.evictSnapshots();
    return this.snapshots.size;
  }

  /** Clear all temporary visual data immediately. */
  purgeSnapshots(): void {
    this.snapshots.clear();
  }

  /** Release the capture stream and all temporary data. */
  stop(): void {
    this.purgeSnapshots();
    this.captureSource.stop();
  }
}

function elementKey(e: { type: string; text?: string; bounds?: { x: number; y: number } }): string {
  return `${e.type}|${e.text ?? ''}|${e.bounds ? `${e.bounds.x.toFixed(2)},${e.bounds.y.toFixed(2)}` : ''}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function withTimeout<T>(promise: Promise<T>, ms: number, kind: 'timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ObserverError(kind, `Capture timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
