/**
 * Camera Vision (Step 6) — controlled visual-perception service.
 *
 * Explicitly user-controlled camera access with a bounded capture → validate →
 * downscale → analyze pipeline. Design guarantees:
 *   - The camera NEVER activates on its own: start() is called only from the
 *     explicit user control.
 *   - Immediate stop: every track ends, the preview element detaches, and no
 *     further frame acquisition is possible.
 *   - NO raw-frame retention: exactly one working frame exists transiently in
 *     a canvas during capture/analysis and is released immediately after;
 *     nothing is written to storage, memory history, or disk.
 *   - Bounded processing: frames are downscaled to ≤ CAMERA_MAX_SIDE px and
 *     JPEG-compressed before any transmission; analysis happens ONLY for a
 *     user-authorized question (no continuous upload); duplicate frames
 *     (content-hash match) reuse the last perception instead of a new model
 *     call.
 *   - Honesty: perception results distinguish observed (objects) from
 *     interpreted (activities) from undeterminable (uncertainties); the
 *     service NEVER performs facial recognition or sensitive-trait inference
 *     (the server prompt forbids it and the client marks presence-only).
 *   - SPF/E5 untouched: transmission rides /api/vision/camera-analyze, which
 *     runs the same SPF gates as screen vision and is E5 stop-blocked.
 */
import type { ConversationTurnManager } from './conversationTurnManager';

export const CAMERA_MAX_SIDE = 640;
export const CAMERA_JPEG_QUALITY = 0.7;
/** Sampling floor for video-conversation mode (ms between analyzed frames). */
export const CAMERA_MIN_SAMPLE_INTERVAL_MS = 4000;

export type CameraStatus =
  | 'inactive'
  | 'starting'
  | 'active'
  | 'permission_denied'
  | 'camera_unavailable'
  | 'camera_disconnected'
  | 'failed';

export interface CameraPerceptionObject {
  label: string;
  confidence: number;
}
export interface CameraPerception {
  scene: string;
  objects: CameraPerceptionObject[];
  activities: CameraPerceptionObject[];
  setting: string;
  uncertainties: string[];
  personPresent: boolean | null;
  confidence: number;
  /** True when this perception was reused for an identical frame (no new model call). */
  fromCache?: boolean;
}

export interface CameraVisionDiagnostics {
  status: CameraStatus;
  /** Epoch ms the camera was last started (0 = never). */
  startedAt: number;
  /** Frames acquired since start (count only — no content). */
  framesAcquired: number;
  /** Model analyses performed since start (count only). */
  analysesPerformed: number;
  /** Duplicate-frame reuses since start (count only). */
  duplicateReuses: number;
  /** Whether a video element is attached for preview. */
  previewAttached: boolean;
}

export interface CameraVisionOptions {
  /** Injectable getUserMedia (tests). */
  getUserMediaImpl?: typeof navigator.mediaDevices.getUserMedia;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable canvas factory (tests) — returns a 2D-context holder. */
  createCanvas?: (width: number, height: number) => { canvas: unknown; ctx: CameraCanvasContext };
  now?: () => number;
  /** Analysis endpoint (default /api/vision/camera-analyze). */
  endpoint?: string;
}

/** Minimal 2D-context contract used by the pipeline (test-friendly). */
export interface CameraCanvasContext {
  drawImage(source: unknown, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray | number[] };
  canvas: { toDataURL(type: string, quality?: number): string; width: number; height: number };
}

export class CameraVisionService {
  private status: CameraStatus = 'inactive';
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private trackEndedHandler: (() => void) | null = null;
  private lastPerception: CameraPerception | null = null;
  private lastFrameHash = '';
  private lastAnalyzedAt = 0;
  private startedAt = 0;
  private framesAcquired = 0;
  private analysesPerformed = 0;
  private duplicateReuses = 0;
  private analyzing = false;
  private opts: Required<Pick<CameraVisionOptions, 'endpoint' | 'now'>> & CameraVisionOptions;
  private getUserMediaImpl: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null;
  private fetchImpl: typeof fetch;
  private createCanvas: (width: number, height: number) => { canvas: unknown; ctx: CameraCanvasContext };
  private listeners = new Set<(status: CameraStatus) => void>();

  constructor(options: CameraVisionOptions = {}) {
    this.opts = { endpoint: '/api/vision/camera-analyze', now: () => Date.now(), ...options };
    // The real navigator path is resolved at call time (browsers only);
    // tests inject their own implementation.
    this.getUserMediaImpl = options.getUserMediaImpl ?? null;
    this.fetchImpl = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (() => { throw new Error('no fetch'); }));
    this.createCanvas =
      options.createCanvas ??
      ((width, height) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d') as unknown as CameraCanvasContext;
        return { canvas, ctx: { ...ctx, canvas } };
      });
  }

  subscribe(listener: (status: CameraStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): CameraStatus {
    return this.status;
  }

  getDiagnostics(): CameraVisionDiagnostics {
    return {
      status: this.status,
      startedAt: this.startedAt,
      framesAcquired: this.framesAcquired,
      analysesPerformed: this.analysesPerformed,
      duplicateReuses: this.duplicateReuses,
      previewAttached: this.videoEl !== null,
    };
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Start the camera. ONLY called from the explicit user control. Maps
   * permission/device failures to honest states and never retries silently.
   */
  async start(): Promise<{ ok: boolean; status: CameraStatus; error?: string }> {
    if (this.status === 'active' || this.status === 'starting') {
      return { ok: true, status: this.status };
    }
    this.setStatus('starting');
    // Resolve the capture implementation: injected (tests) or the browser's
    // getUserMedia. An environment without camera support is honest failure.
    const impl =
      this.getUserMediaImpl ??
      (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        : null);
    if (!impl) {
      this.setStatus('camera_unavailable');
      return { ok: false, status: this.status, error: 'Camera access is not supported in this browser.' };
    }
    let stream: MediaStream;
    try {
      stream = await impl({
        video: { facingMode: 'user', width: { ideal: CAMERA_MAX_SIDE }, height: { ideal: CAMERA_MAX_SIDE } },
        audio: false, // camera vision never captures audio
      });
    } catch (err: unknown) {
      const name = String((err as { name?: string })?.name || '');
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        this.setStatus('permission_denied');
        return { ok: false, status: this.status, error: 'Camera permission denied.' };
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError' || name === 'DevicesNotFoundError') {
        this.setStatus('camera_unavailable');
        return { ok: false, status: this.status, error: 'No camera is available.' };
      }
      this.setStatus('failed');
      return { ok: false, status: this.status, error: 'Failed to start the camera.' };
    }

    this.stream = stream;
    this.startedAt = this.opts.now();
    // Track disconnection/revocation → immediate honest shutdown.
    const track = stream.getVideoTracks()[0];
    if (track) {
      this.trackEndedHandler = () => {
        // The OS/browser revoked or disconnected the camera: stop everything.
        this.stop('camera_disconnected');
      };
      track.addEventListener('ended', this.trackEndedHandler);
    }
    this.setStatus('active');
    return { ok: true, status: this.status };
  }

  /** Attach the preview element (visible camera-active UI owns this). */
  attachPreview(video: HTMLVideoElement | null): void {
    this.videoEl = video;
    if (video && this.stream) {
      video.srcObject = this.stream;
      try {
        void video.play();
      } catch {}
    }
  }

  /**
   * Immediate stop: ends every track, detaches the preview, clears the
   * working frame slot. After this call no acquisition or analysis is
   * possible until an explicit new start().
   */
  stop(reason: CameraStatus = 'inactive'): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        if (this.trackEndedHandler) track.removeEventListener('ended', this.trackEndedHandler);
        try {
          track.stop();
        } catch {}
      }
    }
    this.stream = null;
    if (this.videoEl) {
      try {
        this.videoEl.pause();
      } catch {}
      this.videoEl.srcObject = null;
    }
    // Detach the preview element: after stop, the service holds no camera
    // surface at all (the visible panel re-binds on an explicit new start).
    this.videoEl = null;
    this.lastPerception = null;
    this.lastFrameHash = '';
    this.trackEndedHandler = null;
    this.setStatus(reason === 'camera_disconnected' ? 'camera_disconnected' : 'inactive');
  }

  // ------------------------------------------------------------ frame pipeline

  /**
   * Acquire + validate + downscale one frame. Returns the bounded JPEG data
   * URL and its content hash, or a rejection reason. The frame exists only
   * inside the transient canvas — nothing is retained.
   */
  captureFrame(): { ok: boolean; reason?: string; dataUrl?: string; hash?: string; width?: number; height?: number } {
    if (this.status !== 'active' || !this.stream) {
      return { ok: false, reason: 'camera_not_active' };
    }
    if (!this.videoEl || this.videoEl.readyState < 2) {
      return { ok: false, reason: 'frame_not_ready' };
    }
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (!vw || !vh) {
      return { ok: false, reason: 'invalid_frame' };
    }
    // Downscale to the bounded long side (i3-friendly: one small canvas draw).
    const scale = Math.min(1, CAMERA_MAX_SIDE / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const { ctx } = this.createCanvas(w, h);
    try {
      ctx.drawImage(this.videoEl, 0, 0, w, h);
    } catch {
      return { ok: false, reason: 'capture_failed' };
    }
    // Quality validation: reject uniform/blank frames (all-same luminance).
    const sample = ctx.getImageData(0, 0, Math.min(w, 64), Math.min(h, 64));
    let minL = 255;
    let maxL = 0;
    const data = sample.data;
    for (let i = 0; i < data.length; i += 4) {
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
    if (maxL - minL < 4) {
      return { ok: false, reason: 'blank_frame' };
    }
    let dataUrl: string;
    try {
      dataUrl = ctx.canvas.toDataURL('image/jpeg', CAMERA_JPEG_QUALITY);
    } catch {
      return { ok: false, reason: 'encode_failed' };
    }
    if (!dataUrl || dataUrl.length < 100) {
      return { ok: false, reason: 'encode_failed' };
    }
    this.framesAcquired += 1;
    const hash = frameContentHash(dataUrl);
    return { ok: true, dataUrl, hash, width: w, height: h };
  }

  /**
   * One user-authorized analysis: capture → duplicate check → transmit (SPF
   * runs server-side) → structured perception. The frame is released
   * immediately after the call — nothing is retained.
   */
  async analyzeFrame(question?: string): Promise<{ ok: boolean; reason?: string; perception?: CameraPerception }> {
    if (this.analyzing) {
      return { ok: false, reason: 'analysis_in_progress' };
    }
    if (this.status !== 'active') {
      return { ok: false, reason: 'camera_not_active' };
    }
    this.analyzing = true;
    try {
      const frame = this.captureFrame();
      if (!frame.ok || !frame.dataUrl || !frame.hash) {
        return { ok: false, reason: frame.reason ?? 'capture_failed' };
      }
      // Duplicate-frame prevention: identical consecutive frames reuse the
      // cached perception — no repeated model call for a still scene.
      if (frame.hash === this.lastFrameHash && this.lastPerception) {
        this.duplicateReuses += 1;
        return { ok: true, perception: { ...this.lastPerception, fromCache: true } };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let res: Response;
      try {
        res = await this.fetchImpl(this.opts.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ image: frame.dataUrl, question: question?.slice(0, 300) }),
        });
      } catch {
        return { ok: false, reason: 'network_unavailable' };
      } finally {
        clearTimeout(timer);
      }
      // Frame released: the dataUrl is not stored anywhere after this call.
      if (!res.ok) {
        return { ok: false, reason: 'analysis_failed' };
      }
      const body = await res.json();
      if (body?.fallback) {
        return { ok: false, reason: String(body.reason || 'analysis_failed') };
      }
      const perception = this.normalizePerception(body?.analysis);
      if (!perception) {
        return { ok: false, reason: 'malformed_analysis' };
      }
      this.lastFrameHash = frame.hash;
      this.lastPerception = perception;
      this.lastAnalyzedAt = this.opts.now();
      this.analysesPerformed += 1;
      return { ok: true, perception };
    } finally {
      this.analyzing = false;
    }
  }

  /** Recent perception for the SAME camera session (content-safe reuse). */
  getLastPerception(): CameraPerception | null {
    return this.lastPerception;
  }

  // ------------------------------------------------------------------ internals

  /** Normalize + bound the model's JSON into the honest perception shape. */
  private normalizePerception(raw: unknown): CameraPerception | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const clamp01 = (v: unknown): number => {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
    };
    const boundList = (v: unknown, max: number): CameraPerceptionObject[] =>
      Array.isArray(v)
        ? v
            .filter((o) => o && typeof (o as { label?: unknown }).label === 'string')
            .slice(0, max)
            .map((o) => ({ label: String((o as { label: unknown }).label).slice(0, 120), confidence: clamp01((o as { confidence?: unknown }).confidence) }))
        : [];
    const personRaw = r.personPresent;
    return {
      scene: typeof r.scene === 'string' ? r.scene.slice(0, 600) : '',
      objects: boundList(r.objects, 12),
      activities: boundList(r.activities, 8),
      setting: typeof r.setting === 'string' ? r.setting.slice(0, 120) : 'unknown',
      uncertainties: Array.isArray(r.uncertainties)
        ? r.uncertainties.filter((u) => typeof u === 'string').slice(0, 8).map((u) => String(u).slice(0, 200))
        : [],
      personPresent: typeof personRaw === 'boolean' ? personRaw : null,
      confidence: clamp01(r.confidence),
    };
  }

  private setStatus(next: CameraStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {}
    }
  }
}

/** Deterministic FNV-1a content hash for duplicate-frame prevention. */
export function frameContentHash(dataUrl: string): string {
  let hash = 0x811c9dc5;
  // Sample the string — full hashing a large data URL is wasteful.
  const step = Math.max(1, Math.floor(dataUrl.length / 4096));
  for (let i = 0; i < dataUrl.length; i += step) {
    hash ^= dataUrl.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ('0000000' + (hash >>> 0).toString(16)).slice(-8);
}

// ------------------------------------------------------------------ singleton

let singleton: CameraVisionService | null = null;

export function getCameraVisionService(options?: CameraVisionOptions): CameraVisionService {
  if (!singleton) {
    singleton = new CameraVisionService(options);
  }
  return singleton;
}

export function resetCameraVisionForTests(): void {
  singleton?.stop();
  singleton = null;
}

/** Convenience: defer delivery until the turn manager leaves 'speaking'. */
export function deliverWhenNotSpeaking(
  turnManager: ConversationTurnManager,
  deliver: () => void,
  unsubscribeBag: Array<() => void>
): void {
  if (turnManager.getPhase() !== 'speaking') {
    deliver();
    return;
  }
  const unsub = turnManager.subscribe((phase) => {
    if (phase !== 'speaking') {
      unsub();
      deliver();
    }
  });
  unsubscribeBag.push(unsub);
}
