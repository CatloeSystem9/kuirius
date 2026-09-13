/**
 * Browser capture source (Phase 4) — the real implementation.
 *
 * Uses the native Screen Capture API (getDisplayMedia) — the simplest reliable
 * capture path for this browser-based application, with zero new dependencies.
 * The stream is reused across observations so the user grants permission once
 * per session; stop() releases it.
 *
 * - analysis buffer: downscaled RGBA (canvas) for local analysis + signatures
 * - encoded frame: downscaled JPEG data URL (only sent anywhere on an explicit
 *   cloud-analysis request)
 *
 * This module touches DOM/browser APIs and is imported only by the bridge
 * (browser entry point), never by the pure core or Node tests.
 */
import type { ActiveWindowInfo, CapturedFrame, CaptureSource } from './visionTypes';
import { ObserverError } from './visionTypes';

const ANALYSIS_WIDTH = 240; // local analysis + signatures run at this scale
const ENCODE_MAX_WIDTH = 768; // JPEG sent to cloud analysis (only on explicit request)
const ENCODE_QUALITY = 0.6;

export class BrowserCaptureSource implements CaptureSource {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;

  private async ensureStream(): Promise<MediaStream> {
    if (this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live')) {
      return this.stream;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      throw new ObserverError('capture_unsupported', 'Screen capture is not supported in this environment');
    }

    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 } as MediaTrackConstraints,
        audio: false,
      });
    } catch (err: any) {
      const name = String(err?.name || '');
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new ObserverError('permission_denied', 'Screen capture permission was denied by the user or browser');
      }
      if (name === 'NotSupportedError' || name === 'TypeError') {
        throw new ObserverError('capture_unsupported', 'Screen capture is not supported in this environment');
      }
      throw new ObserverError('capture_failed', `Screen capture failed: ${String(err?.message || err)}`);
    }

    // End-of-share handling: drop the stream reference so the next capture re-prompts.
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.stream = null;
    });

    return this.stream;
  }

  private async ensureVideo(stream: MediaStream): Promise<HTMLVideoElement> {
    if (!this.video) {
      this.video = document.createElement('video');
      // Never appended to the document — fully offscreen.
      this.video.muted = true;
      this.video.playsInline = true;
    }
    this.video.srcObject = stream;
    if (this.video.readyState < 2) {
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new ObserverError('capture_failed', 'Video element failed to load the capture stream'));
        };
        const cleanup = () => {
          this.video?.removeEventListener('loadeddata', onReady);
          this.video?.removeEventListener('error', onError);
        };
        this.video?.addEventListener('loadeddata', onReady);
        this.video?.addEventListener('error', onError);
      });
    }
    try {
      await this.video.play();
    } catch {
      // Autoplay policies may reject play() — drawing still works once metadata is loaded.
    }
    return this.video;
  }

  async capture(): Promise<CapturedFrame> {
    const stream = await this.ensureStream();
    const video = await this.ensureVideo(stream);

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    const srcWidth = settings.width || video.videoWidth || ANALYSIS_WIDTH;
    const srcHeight = settings.height || video.videoHeight || ANALYSIS_WIDTH * 9 / 16;
    if (!srcWidth || !srcHeight) {
      throw new ObserverError('capture_failed', 'Capture stream reported no frame dimensions');
    }

    const analysisCanvas = document.createElement('canvas');
    analysisCanvas.width = ANALYSIS_WIDTH;
    analysisCanvas.height = Math.max(1, Math.round((srcHeight / srcWidth) * ANALYSIS_WIDTH));
    const actx = analysisCanvas.getContext('2d', { willReadFrequently: true });
    if (!actx) throw new ObserverError('capture_failed', 'Canvas 2D context unavailable');
    actx.drawImage(video, 0, 0, analysisCanvas.width, analysisCanvas.height);
    const imageData = actx.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);

    // Encoded JPEG for cloud analysis (downscaled, quality 0.6) — stays local
    // unless a task explicitly requests cloud analysis.
    const encodeScale = Math.min(1, ENCODE_MAX_WIDTH / srcWidth);
    const encodeCanvas = document.createElement('canvas');
    encodeCanvas.width = Math.max(1, Math.round(srcWidth * encodeScale));
    encodeCanvas.height = Math.max(1, Math.round(srcHeight * encodeScale));
    encodeCanvas.getContext('2d')?.drawImage(video, 0, 0, encodeCanvas.width, encodeCanvas.height);
    const dataUrl = encodeCanvas.toDataURL('image/jpeg', ENCODE_QUALITY);

    return {
      width: analysisCanvas.width,
      height: analysisCanvas.height,
      data: imageData.data,
      dataUrl,
      capturedAt: Date.now(),
    };
  }

  getActiveWindowInfo(): ActiveWindowInfo {
    // Browsers do not expose OS window enumeration. When the user shares a
    // specific window, the track label/settings carry the best available hint.
    const track = this.stream?.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') {
      return { available: false, source: 'unavailable' };
    }
    const settings = track.getSettings?.() ?? {};
    const surface = (settings as any).displaySurface as string | undefined;
    const label = track.label || '';
    return {
      available: true,
      title: label || undefined,
      surface: surface === 'monitor' || surface === 'window' || surface === 'browser' ? surface : 'unknown',
      source: 'display_media_track',
    };
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
  }
}
