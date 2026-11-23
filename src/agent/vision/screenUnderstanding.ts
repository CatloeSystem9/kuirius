/**
 * ScreenUnderstandingService — the local "what is on the screen right now"
 * layer for the Live Screen Perception system (browser side).
 *
 * The LiveScreenWatcher answers "did the screen change?"; THIS service
 * answers "what is on it". It runs the local Windows OCR (via the server's
 * SPF-screened /api/screen/understand route — the SAME WinRT worker the
 * Screen Privacy Firewall uses, single-flight by construction) ONLY when a
 * trigger justifies it, and keeps a bounded, SPF-screened snapshot:
 *
 *   { activeWindow, application, texts[], elements[], at, source }
 *
 * Privacy: every line is screened by the Screen Privacy Firewall ONCE MORE
 * on this side before entering the cache (per-item strip — sensitive lines
 * become placeholders), matching the tool-output policy. Nothing is ever
 * persisted; the cache holds the last few snapshots only and dies with the
 * page. Cloud analysis (Gemini) is NEVER triggered by this service — the
 * existing explicit request path remains the only cloud route.
 *
 * Resource design: single-flight refresh (one OCR request at a time), a
 * cooldown between refreshes, a per-minute cap, signature dedupe (unchanged
 * screen → no OCR), and a bounded history (last 3 snapshots).
 */
import type { AgentEventBus } from '../events';
import type { PermissionManager } from '../permissions';
import type { DetectedText, ScreenState } from './visionTypes';
import { spfScreenItem } from '../spf/index';

export interface UnderstoodText extends DetectedText {
  /** Normalized 0..1 bounds relative to the captured frame. */
}

export interface ScreenUnderstandingSnapshot {
  id: string;
  at: number;
  capturedAt: number;
  activeWindow: { available: boolean; title?: string; surface?: string };
  /** Best-effort application name inferred from the window title. */
  application?: string;
  /** SPF-screened visible text lines (top by reading order), ≤ 40. */
  texts: UnderstoodText[];
  /** Total OCR lines before the cap (context for honesty). */
  totalLines: number;
  /** SPF-screened line count in this snapshot. */
  redactedLines: number;
  categories?: string[];
  source: 'ocr';
  /** ms from request start to understood result (server-measured OCR + transport). */
  ocrMs?: number;
}

export interface ScreenUnderstandingOptions {
  watcher: import('./liveWatcher').LiveScreenWatcher;
  observer: {
    getActiveWindow(): { available: boolean; title?: string; surface?: string };
    getCurrentState(options?: { maxAgeMs?: number }): Promise<ScreenState>;
    getSnapshot(ref: string): string | undefined;
  };
  events?: AgentEventBus;
  permissions?: PermissionManager;
  /** Injectable transport for tests. Default: POST /api/screen/understand. */
  fetchFn?: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
  /** Minimum ms between OCR refreshes (cooldown). */
  minIntervalMs?: number;
  /** Max OCR refreshes per rolling minute (bounded server load). */
  maxPerMinute?: number;
  /** Fraction threshold that justifies an OCR refresh (watcher minor/major map here). */
  refreshFraction?: number;
  now?: () => number;
}

export const DEFAULT_UNDERSTANDING_LIMITS = {
  minIntervalMs: 2500,
  maxPerMinute: 18,
  refreshFraction: 0.03,
  maxSnapshots: 3,
  maxTexts: 40,
};

interface ServerUnderstandResponse {
  success: boolean;
  result?: {
    status: string;
    message?: string;
    width?: number;
    height?: number;
    ocrMs?: number;
    totalLines?: number;
    lines?: Array<{ t: string; x: number; y: number; w: number; h: number; spf?: string }>;
    redactedLines?: number;
    categories?: string[];
  };
  fallback?: boolean;
  reason?: string;
}

/** Best-effort application name from a window title (deterministic, local). */
export function inferApplication(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  // "Document - App" / "Document — App" — the trailing segment is usually the app.
  const split = t.split(/\s+[–—-]\s+/);
  const tail = split.length > 1 ? split[split.length - 1].trim() : t;
  const m = tail.match(/([A-Za-z0-9#.]+(?:\.[A-Za-z0-9]+)*\.exe)$/i);
  if (m) return m[1];
  return tail.slice(0, 48);
}

export class ScreenUnderstandingService {
  private watcher: ScreenUnderstandingOptions['watcher'];
  private observer: ScreenUnderstandingOptions['observer'];
  private events?: AgentEventBus;
  private permissions?: PermissionManager;
  private fetchFn: NonNullable<ScreenUnderstandingOptions['fetchFn']>;
  private limits: typeof DEFAULT_UNDERSTANDING_LIMITS;
  private nowFn: () => number;

  private detachWatcher: (() => void) | null = null;
  private snapshots: ScreenUnderstandingSnapshot[] = [];
  private inflight: Promise<ScreenUnderstandingSnapshot | null> | null = null;
  private lastRefreshAt = 0;
  private refreshTimestamps: number[] = [];
  private lastOcrSignatureKey: string | null = null;
  private pendingFraction: number | null = null;
  private pendingReason: 'change' | 'window' | 'explicit' | 'computer_use' | null = null;

  constructor(options: ScreenUnderstandingOptions) {
    this.watcher = options.watcher;
    this.observer = options.observer;
    this.events = options.events;
    this.permissions = options.permissions;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init as never) as unknown as Promise<{ ok: boolean; json(): Promise<unknown> }>);
    this.limits = { ...DEFAULT_UNDERSTANDING_LIMITS, ...(options.minIntervalMs !== undefined || options.maxPerMinute !== undefined || options.refreshFraction !== undefined ? {
      minIntervalMs: options.minIntervalMs ?? DEFAULT_UNDERSTANDING_LIMITS.minIntervalMs,
      maxPerMinute: options.maxPerMinute ?? DEFAULT_UNDERSTANDING_LIMITS.maxPerMinute,
      refreshFraction: options.refreshFraction ?? DEFAULT_UNDERSTANDING_LIMITS.refreshFraction,
      maxSnapshots: DEFAULT_UNDERSTANDING_LIMITS.maxSnapshots,
      maxTexts: DEFAULT_UNDERSTANDING_LIMITS.maxTexts,
    } : {}) };
    this.nowFn = options.now ?? Date.now;
  }

  // ------------------------------------------------------------- lifecycle

  /** Start following the watcher (live watching itself is started separately). */
  attach(): () => void {
    if (this.detachWatcher) return this.detachWatcher;
    const onChange = (fraction: number, klass: string) => {
      if (klass !== 'none' && fraction >= this.limits.refreshFraction) {
        this.requestRefresh('change', fraction);
      }
    };
    const detach = this.watcher.onChangeHook(onChange);
    this.detachWatcher = detach;
    return detach;
  }

  detach(): void {
    this.detachWatcher?.();
    this.detachWatcher = null;
  }

  // ------------------------------------------------------------ triggering

  /**
   * Request a refresh through the trigger policy. Cheap: coalesces requests,
   * enforces the cooldown + per-minute cap + signature dedupe, single-flight.
   * Returns the (possibly cached) newest snapshot, or null when skipped.
   */
  async requestRefresh(reason: 'change' | 'window' | 'explicit' | 'computer_use', changedFraction?: number): Promise<ScreenUnderstandingSnapshot | null> {
    const now = this.nowFn();
    if (this.permissions && !this.permissions.isGranted('screen.observation')) return null;

    if (this.inflight) {
      // Coalesce — one OCR at a time; remember that more changed meanwhile.
      this.pendingFraction = Math.max(this.pendingFraction ?? 0, changedFraction ?? 0);
      if (!this.pendingReason) this.pendingReason = reason;
      return this.inflight;
    }

    const sinceLast = now - this.lastRefreshAt;
    const perMinute = this.refreshTimestamps.filter((t) => now - t < 60_000).length;
    const significant = reason !== 'change' || (changedFraction ?? 0) >= this.limits.refreshFraction;
    const windowChanged = this.detectWindowChange();
    const justified =
      reason !== 'change' ||
      significant ||
      windowChanged;
    if (!justified) return this.snapshots[0] ?? null;
    if (sinceLast < this.limits.minIntervalMs) {
      this.pendingFraction = Math.max(this.pendingFraction ?? 0, changedFraction ?? 0);
      if (!this.pendingReason) this.pendingReason = reason;
      return this.snapshots[0] ?? null;
    }
    if (perMinute >= this.limits.maxPerMinute) return this.snapshots[0] ?? null;

    this.lastRefreshAt = now;
    this.refreshTimestamps.push(now);
    this.refreshTimestamps = this.refreshTimestamps.filter((t) => now - t < 60_000);

    this.inflight = this.refreshInternal(reason).finally(() => {
      this.inflight = null;
      // A coalesced change arrived while refreshing: honor it immediately
      // (still bounded by the cooldown via lastRefreshAt).
      if (this.pendingReason) {
        const pendingReason = this.pendingReason;
        const pendingFraction = this.pendingFraction ?? undefined;
        this.pendingReason = null;
        this.pendingFraction = null;
        void this.requestRefresh(pendingReason, pendingFraction);
      }
    });
    return this.inflight;
  }

  private windowAtAttach: string | undefined = undefined;
  private detectWindowChange(): boolean {
    const info = this.observer.getActiveWindow();
    const key = info.available ? `${info.title ?? ''}|${info.surface ?? ''}` : 'unavailable';
    if (this.windowAtAttach === undefined) {
      this.windowAtAttach = key;
      return true; // first understanding always justified
    }
    if (key !== this.windowAtAttach) {
      this.windowAtAttach = key;
      return true;
    }
    return false;
  }

  /** Signature key for dedupe: unchanged screen since the last OCR → skip. */
  setLastKnownSignatureKey(key: string | null): void {
    this.lastOcrSignatureKey = key;
  }
  shouldSkipForSignature(key: string | null): boolean {
    return key !== null && key === this.lastOcrSignatureKey;
  }

  // --------------------------------------------------------------- refresh

  private async refreshInternal(reason: 'change' | 'window' | 'explicit' | 'computer_use'): Promise<ScreenUnderstandingSnapshot | null> {
    const startedAt = this.nowFn();
    try {
      // Full capture WITH the encoded JPEG — only here (trigger-gated).
      const state = await this.observer.getCurrentState({ maxAgeMs: 0 });
      if (!state.snapshotRef) {
        return this.snapshots[0] ?? null; // no encoded frame available — keep cached understanding
      }
      const dataUrl = this.observer.getSnapshot(state.snapshotRef);
      if (!dataUrl) return this.snapshots[0] ?? null;

      const windowInfo = state.activeWindow;
      const res = await this.fetchFn('/api/screen/understand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: dataUrl,
          activeWindowTitle: windowInfo.available ? windowInfo.title : undefined,
        }),
      });
      if (!res.ok) return this.snapshots[0] ?? null;
      const body = (await res.json()) as ServerUnderstandResponse;
      if (!body.success || body.result?.status !== 'ok' || !Array.isArray(body.result.lines)) {
        return this.snapshots[0] ?? null;
      }

      // SPF screening AGAIN on this side (per-item strip) — the cache must
      // never hold raw sensitive screen text even if a future server change
      // altered its policy.
      const texts: UnderstoodText[] = [];
      for (const line of body.result.lines.slice(0, this.limits.maxTexts)) {
        const item = spfScreenItem(line.t, 'perception:understanding-cache', state.id, 'digest');
        if (!item.text) continue;
        texts.push({
          text: item.text,
          kind: 'content',
          bounds: {
            x: line.x / (body.result.width || 1),
            y: line.y / (body.result.height || 1),
            width: line.w / (body.result.width || 1),
            height: line.h / (body.result.height || 1),
          },
          confidence: 0.8,
        });
      }

      const snapshot: ScreenUnderstandingSnapshot = {
        id: `under_${state.id}`,
        at: this.nowFn(),
        capturedAt: state.timestamp,
        activeWindow: {
          available: windowInfo.available,
          title: windowInfo.available ? windowInfo.title : undefined,
          surface: windowInfo.available ? windowInfo.surface : undefined,
        },
        application: inferApplication(windowInfo.available ? windowInfo.title : undefined),
        texts,
        totalLines: body.result.totalLines ?? texts.length,
        redactedLines: body.result.redactedLines ?? 0,
        categories: body.result.categories,
        source: 'ocr',
        ocrMs: body.result.ocrMs,
      };

      this.snapshots.unshift(snapshot);
      if (this.snapshots.length > this.limits.maxSnapshots) this.snapshots.pop();
      this.lastOcrSignatureKey = state.signature ? `${state.signature.blocks.slice(0, 24).join(',')}` : null;
      this.events?.emit({
        name: 'SCREEN_UNDERSTANDING_UPDATED',
        payload: {
          id: snapshot.id,
          application: snapshot.application,
          lineCount: texts.length,
          redactedLines: snapshot.redactedLines,
          reason,
          totalMs: this.nowFn() - startedAt,
        },
        timestamp: Date.now(),
      });
      return snapshot;
    } catch {
      // Structured failure: keep the previous understanding, report nothing fabricated.
      return this.snapshots[0] ?? null;
    }
  }

  // ------------------------------------------------------------- queries

  getLatest(): ScreenUnderstandingSnapshot | null {
    return this.snapshots[0] ?? null;
  }

  list(): ScreenUnderstandingSnapshot[] {
    return [...this.snapshots];
  }

  /** Compact summary for the agent: active app + key visible text. */
  describe(): string {
    const s = this.snapshots[0];
    if (!s) return 'No recent screen understanding. Run screen.observe or enable live watching first.';
    const app = s.application || s.activeWindow.title || 'unknown application';
    const ageS = Math.round((this.nowFn() - s.at) / 1000);
    const top = s.texts.slice(0, 6).map((t) => t.text).join(' | ');
    return `Active app: ${app}. Understood ${s.texts.length}/${s.totalLines} text line(s) ${ageS}s ago${top ? `: ${top}` : ''}.`;
  }

  /** Has anything been understood since (freshness gate for verification). */
  fresherThan(ms: number): boolean {
    const s = this.snapshots[0];
    return !!s && this.nowFn() - s.at < ms;
  }

  /** Test hook: replace limits. */
  setLimitsForTests(partial: Partial<typeof DEFAULT_UNDERSTANDING_LIMITS>): void {
    this.limits = { ...this.limits, ...partial };
  }
}
