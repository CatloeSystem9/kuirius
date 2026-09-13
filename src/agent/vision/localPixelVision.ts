/**
 * Local pixel-heuristic vision provider (Phase 4).
 *
 * Zero dependencies, runs entirely on the analysis-resolution RGBA buffer.
 * It detects text-like horizontal bands and basic luminance statistics —
 * useful for change reasoning and as the always-available fallback. It can
 * NOT read text: it reports empty texts/errors rather than inventing content.
 * Escalation to a stronger provider is explicit (spec §17).
 */
import type { CapturedFrame, VisionAnalysis, VisionAnalysisContext, VisionProvider, DetectedUiElement } from './visionTypes';

const ANALYSIS_TARGET_BANDS = 8;

export class LocalPixelVisionProvider implements VisionProvider {
  name = 'local_pixel_heuristics';

  available(): boolean {
    return true;
  }

  async analyze(frame: CapturedFrame, context: VisionAnalysisContext): Promise<VisionAnalysis> {
    const { width, height, data } = frame;

    // Row luminance mean/variance for text-band detection.
    const rowMean = new Array<number>(height).fill(0);
    const rowVar = new Array<number>(height).fill(0);
    for (let y = 0; y < height; y++) {
      let sum = 0;
      let sumSq = 0;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += lum;
        sumSq += lum * lum;
      }
      const mean = sum / width;
      rowMean[y] = mean;
      rowVar[y] = sumSq / width - mean * mean;
    }

    // Contrast between adjacent rows (text creates alternating bright/dark rows).
    const rowContrast = new Array<number>(height).fill(0);
    for (let y = 1; y < height; y++) {
      rowContrast[y] = Math.abs(rowMean[y] - rowMean[y - 1]);
    }
    const meanContrast = rowContrast.slice(1).reduce((a, b) => a + b, 0) / (height - 1);

    // A row is "text-like" when it has high intra-row variance or strong
    // contrast with its neighbor. Merge consecutive rows into bands.
    const isTexty = (y: number) => rowVar[y] > 220 || rowContrast[y] > meanContrast * 2.2;
    const elements: DetectedUiElement[] = [];
    let y = 0;
    while (y < height && elements.length < ANALYSIS_TARGET_BANDS) {
      if (isTexty(y)) {
        const start = y;
        while (y < height && (isTexty(y) || (y + 1 < height && isTexty(y + 1)))) y++;
        const rows = y - start;
        if (rows >= 2) {
          elements.push({
            type: 'text_line',
            bounds: { x: 0.02, y: start / height, width: 0.96, height: rows / height },
            confidence: 0.45,
            actionable: false,
          });
        }
      } else {
        y++;
      }
    }

    const avgBrightness = rowMean.reduce((a, b) => a + b, 0) / height;

    const windowNote = context.activeWindow?.available
      ? ` Active window: ${context.activeWindow.title || context.activeWindow.surface || 'unknown'}.`
      : ' Active window information is not available in this environment.';

    const summary =
      `Local pixel analysis: ${elements.length} text-like region(s) detected, ` +
      `average brightness ${Math.round(avgBrightness)}/255, ` +
      `resolution ${width}x${height} (analysis scale).` +
      windowNote +
      ' Text content requires a vision provider with OCR.';

    return {
      provider: this.name,
      summary,
      texts: [], // local heuristics cannot OCR — honestly empty
      elements,
      dialogs: [],
      errors: [],
      warnings: [],
      loading: undefined,
      confidence: 0.35,
    };
  }
}
