/**
 * Region-aware capture support (Phase 13, spec §6) — lightweight cropping.
 *
 * A requested observation region crops the captured frame BEFORE provider
 * analysis (cheaper inference) while all detected bounds are translated
 * back into full-screen normalized coordinates so downstream targeting
 * (vision-guided mouse/keyboard actions) stays correct. Change signatures
 * are always computed on the FULL frame — never the crop — so change
 * detection stays consistent across regions.
 */
import type { Bounds, CapturedFrame, VisionAnalysis } from './visionTypes';

/** Heuristic region presets (fractions of the full screen). */
export type RegionPresetName =
  | 'active_application'
  | 'browser_content'
  | 'dialog_area'
  | 'target_control'
  | 'verification_region';

export const REGION_PRESETS: Record<RegionPresetName, Bounds> = {
  active_application: { x: 0, y: 0, width: 1, height: 0.92 },
  browser_content: { x: 0, y: 0.1, width: 1, height: 0.86 },
  dialog_area: { x: 0.15, y: 0.15, width: 0.7, height: 0.7 },
  target_control: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  verification_region: { x: 0, y: 0, width: 1, height: 1 },
};

/** Resolve a region preset to bounds; null means full screen. */
export function resolveRegionBounds(region: string | undefined): Bounds | null {
  if (!region || region === 'full_screen') return null;
  return (REGION_PRESETS as Record<string, Bounds | undefined>)[region] ?? null;
}

/** Crop a captured frame to normalized bounds (identity for full-screen). */
export function cropFrame(frame: CapturedFrame, bounds: Bounds): CapturedFrame {
  const x0 = Math.max(0, Math.floor(bounds.x * frame.width));
  const y0 = Math.max(0, Math.floor(bounds.y * frame.height));
  const w = Math.min(frame.width - x0, Math.ceil(bounds.width * frame.width));
  const h = Math.min(frame.height - y0, Math.ceil(bounds.height * frame.height));
  if (w <= 0 || h <= 0 || (x0 === 0 && y0 === 0 && w === frame.width && h === frame.height)) {
    return frame;
  }

  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y0 + row) * frame.width + x0) * 4;
    data.set(frame.data.subarray(srcStart, srcStart + w * 4), row * w * 4);
  }
  return {
    width: w,
    height: h,
    data,
    // No dataUrl: cropped frames are analysis-only (no second full image copy).
    capturedAt: frame.capturedAt,
  };
}

/** Translate region-relative analysis bounds back to full-screen coordinates. */
export function translateAnalysis(analysis: VisionAnalysis, bounds: Bounds): VisionAnalysis {
  const map = (b?: Bounds): Bounds | undefined =>
    b
      ? {
          x: bounds.x + b.x * bounds.width,
          y: bounds.y + b.y * bounds.height,
          width: b.width * bounds.width,
          height: b.height * bounds.height,
        }
      : undefined;

  return {
    ...analysis,
    texts: analysis.texts.map((t) => ({ ...t, bounds: map(t.bounds) })),
    elements: analysis.elements.map((e) => ({ ...e, bounds: map(e.bounds) })),
    dialogs: analysis.dialogs.map((d) => ({ ...d, bounds: map(d.bounds) })),
  };
}
