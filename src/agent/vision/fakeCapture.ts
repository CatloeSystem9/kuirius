/**
 * Synthetic capture source for tests / CI (Phase 4).
 * Produces deterministic RGBA frames without any browser APIs, so the whole
 * vision pipeline (observer, signatures, local analysis, tools, core) is
 * testable under Node.
 */
import type { ActiveWindowInfo, CapturedFrame, CaptureSource } from './visionTypes';

export type FramePainter = (x: number, y: number, w: number, h: number) => [number, number, number];

export function makeFrame(width: number, height: number, painter: FramePainter, dataUrl?: string): CapturedFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = painter(x, y, width, height);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data, dataUrl, capturedAt: Date.now() };
}

/** Solid-color frame (no text-like regions). */
export function solidFrame(width = 192, height = 108, gray = 40, dataUrl?: string): CapturedFrame {
  return makeFrame(width, height, () => [gray, gray, gray], dataUrl);
}

/** Frame with high-variance horizontal bands on dark background — text-like for the local analyzer. */
export function stripedFrame(width = 192, height = 108, dataUrl?: string): CapturedFrame {
  return makeFrame(width, height, (x, y) => {
    const band = y % 12;
    if (band >= 3 && band <= 5) {
      // Alternating pixels mimic glyph strokes → high per-row variance.
      return x % 2 === 0 ? [235, 235, 235] : [30, 30, 40];
    }
    return [20, 20, 30];
  }, dataUrl);
}

/** Two-part frame (left/right halves) to exercise region clustering. */
export function splitFrame(width = 192, height = 108, leftGray = 30, rightGray = 200): CapturedFrame {
  return makeFrame(width, height, (x) => (x < width / 2 ? [leftGray, leftGray, leftGray] : [rightGray, rightGray, rightGray]));
}

export class FakeCaptureSource implements CaptureSource {
  frames: CapturedFrame[];
  private index = 0;
  private stopped = false;
  windowInfo: ActiveWindowInfo;
  captures = 0;

  constructor(frames: CapturedFrame[], windowInfo: ActiveWindowInfo = { available: true, title: 'Test Window — Editor', surface: 'window', source: 'display_media_track' }) {
    this.frames = frames;
    this.windowInfo = windowInfo;
  }

  async capture(): Promise<CapturedFrame> {
    if (this.stopped) throw new Error('Capture source already stopped');
    // Repeat the last frame once the sequence is exhausted (static screen).
    const frame = this.frames[Math.min(this.index, this.frames.length - 1)];
    this.index++;
    this.captures++;
    // Fresh copy with a new timestamp so every capture is a distinct observation.
    return { ...frame, data: new Uint8ClampedArray(frame.data), capturedAt: Date.now() };
  }

  getActiveWindowInfo(): ActiveWindowInfo {
    return this.windowInfo;
  }

  stop(): void {
    this.stopped = true;
  }
}

/** Capture source that never resolves — for timeout tests. */
export class HangingCaptureSource implements CaptureSource {
  async capture(): Promise<CapturedFrame> {
    return new Promise<CapturedFrame>(() => {});
  }
  getActiveWindowInfo(): ActiveWindowInfo {
    return { available: false, source: 'unavailable' };
  }
  stop(): void {}
}
