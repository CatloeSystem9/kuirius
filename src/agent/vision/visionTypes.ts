/**
 * Screen vision types (Phase 4).
 *
 * A ScreenState is a compact structured representation of one observation:
 * metadata + a lightweight block signature for change detection + a provider
 * analysis. Full-resolution image data is NEVER part of a ScreenState —
 * visual data lives only in the observer's bounded, in-memory snapshot cache.
 */

export interface Bounds {
  /** All values normalized 0..1 relative to the capture. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActiveWindowInfo {
  available: boolean;
  /** Best-effort window/screen title from the capture track metadata. */
  title?: string;
  surface?: 'monitor' | 'window' | 'browser' | 'unknown';
  source: 'display_media_track' | 'unavailable';
}

export type DetectedElementType =
  | 'button'
  | 'link'
  | 'checkbox'
  | 'dropdown'
  | 'text_field'
  | 'menu'
  | 'tab'
  | 'dialog'
  | 'icon'
  | 'list'
  | 'notification'
  | 'popup'
  | 'text_line'
  | 'unknown';

export interface DetectedText {
  text: string;
  kind?: 'heading' | 'label' | 'button_label' | 'error' | 'content' | 'unknown';
  bounds?: Bounds;
  confidence: number;
}

export interface DetectedUiElement {
  type: DetectedElementType;
  text?: string;
  bounds?: Bounds;
  confidence: number;
  actionable?: boolean;
}

export interface DialogInfo {
  kind: 'dialog' | 'popup' | 'notification' | 'confirmation';
  text?: string;
  bounds?: Bounds;
  confidence: number;
}

/**
 * Vision analysis result. Providers fill what they can honestly determine;
 * empty arrays mean "not determinable by this provider", never fabricated.
 */
export interface VisionAnalysis {
  provider: string;
  summary: string;
  application?: string;
  texts: DetectedText[];
  elements: DetectedUiElement[];
  dialogs: DialogInfo[];
  errors: string[];
  warnings: string[];
  loading?: boolean;
  confidence: number;
}

/** Lightweight block signature for cheap change detection. */
export interface ScreenSignature {
  gridW: number;
  gridH: number;
  blocks: number[];
}

export interface ScreenState {
  id: string;
  timestamp: number;
  activeWindow: ActiveWindowInfo;
  size: { width: number; height: number };
  signature: ScreenSignature;
  analysis: VisionAnalysis;
  /** Handle into the observer's bounded snapshot cache — never image data. */
  snapshotRef?: string;
}

export interface ScreenChangeResult {
  changed: boolean;
  changedFraction: number;
  changedBlocks: number;
  totalBlocks: number;
  regions: Bounds[];
  previousTimestamp?: number;
  currentTimestamp: number;
}

export interface ScreenStateDiff {
  activeWindowChanged: boolean;
  applicationChanged: boolean;
  textsAdded: string[];
  textsRemoved: string[];
  elementsAdded: DetectedUiElement[];
  elementsRemoved: DetectedUiElement[];
  errorAppeared: boolean;
  errorTexts: string[];
  dialogAppeared: boolean;
  loadingChanged: boolean | null;
  changedFraction: number;
  description: string;
}

/** A captured frame. `data` is analysis-resolution RGBA; `dataUrl` is optional (cloud providers). */
export interface CapturedFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  dataUrl?: string;
  capturedAt: number;
}

export interface VisionAnalysisContext {
  question?: string;
  activeWindow?: ActiveWindowInfo;
}

/** Swappable vision backend (spec §16). Providers report only what they truly detect. */
export interface VisionProvider {
  name: string;
  available(): boolean;
  analyze(frame: CapturedFrame, context: VisionAnalysisContext): Promise<VisionAnalysis>;
}

/** Capture abstraction: browser implementation vs. synthetic test source. */
export interface CaptureSource {
  capture(): Promise<CapturedFrame>;
  getActiveWindowInfo(): ActiveWindowInfo;
  stop(): void;
  /**
   * Optional cheap probe: analysis-resolution frame WITHOUT any encoding
   * (no JPEG, no dataUrl) — used by the live watcher for change detection.
   * Implementations SHOULD reuse internal buffers; the returned `data` view
   * is valid only until the next call. Falls back to capture() when absent.
   */
  captureAnalysis?(): Promise<CapturedFrame>;
}

/** Classified observer failures — mapped onto ToolResult error kinds by the tools. */
export type ObserverErrorKind =
  | 'permission_denied'
  | 'capture_unsupported'
  | 'capture_failed'
  | 'analysis_failed'
  | 'provider_unavailable'
  | 'timeout';

export class ObserverError extends Error {
  kind: ObserverErrorKind;
  constructor(kind: ObserverErrorKind, message: string) {
    super(message);
    this.name = 'ObserverError';
    this.kind = kind;
  }
}

/** Observation modes (spec §18). Adaptive scheduling refinement is Phase 13. */
export type ObservationMode = 'on_demand' | 'task_monitoring' | 'idle';

export const MODE_RECOMMENDED_MAX_AGE_MS: Record<ObservationMode, number> = {
  on_demand: 0, // always capture fresh on explicit request
  task_monitoring: 1500, // reuse a state up to 1.5s old inside a task
  idle: 60_000, // effectively no observation while idle
};
