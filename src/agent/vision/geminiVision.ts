/**
 * Gemini cloud-vision provider (Phase 4).
 *
 * Opt-in only: invoked when a task explicitly requests deep analysis
 * (`analyze: 'cloud'`), never automatically. Sends a downscaled JPEG to the
 * project's own server endpoint (/api/vision/analyze) which routes through
 * the existing Gemini model waterfall with server-side rate limiting.
 * Failures are reported honestly as provider_unavailable / analysis_failed.
 */
import type { CapturedFrame, VisionAnalysis, VisionAnalysisContext, VisionProvider } from './visionTypes';
import { ObserverError } from './visionTypes';

const MAX_IMAGE_WIDTH = 768;

function stripDataUrlPrefix(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',');
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

export class GeminiVisionProvider implements VisionProvider {
  name = 'gemini_cloud_vision';

  available(): boolean {
    // The server decides availability; the client can always attempt once.
    // Rate limiting and key presence are enforced server-side.
    return true;
  }

  async analyze(frame: CapturedFrame, context: VisionAnalysisContext): Promise<VisionAnalysis> {
    if (!frame.dataUrl) {
      throw new ObserverError('provider_unavailable', 'Cloud vision requires an encoded frame, which this capture did not provide');
    }

    const baseUrl = typeof window !== 'undefined' ? '' : (process.env.VISION_BASE_URL || 'http://localhost:3000');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/vision/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: stripDataUrlPrefix(frame.dataUrl),
          question: context.question ?? 'Describe what is currently visible on this screen.',
          activeWindowTitle: context.activeWindow?.title,
        }),
      });
    } catch (err: any) {
      throw new ObserverError('provider_unavailable', `Vision endpoint unreachable: ${String(err?.message || err)}`);
    }

    if (!response.ok) {
      throw new ObserverError('analysis_failed', `Vision endpoint returned HTTP ${response.status}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new ObserverError('analysis_failed', 'Vision endpoint returned malformed JSON');
    }

    if (data?.fallback) {
      throw new ObserverError('provider_unavailable', `Cloud vision unavailable: ${data.reason ?? 'unknown reason'}`);
    }

    const a = data?.analysis;
    if (!a || typeof a !== 'object') {
      throw new ObserverError('analysis_failed', 'Vision endpoint returned no analysis object');
    }

    // Validate/normalize the model output — never trust it blindly.
    const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    return {
      provider: this.name,
      summary: typeof a.summary === 'string' ? a.summary : 'Cloud vision returned no summary.',
      application: typeof a.application === 'string' ? a.application : undefined,
      texts: asArray(a.texts),
      elements: asArray(a.elements),
      dialogs: asArray(a.dialogs),
      errors: asArray(a.errors).filter((e: unknown): e is string => typeof e === 'string'),
      warnings: asArray(a.warnings).filter((e: unknown): e is string => typeof e === 'string'),
      loading: typeof a.loading === 'boolean' ? a.loading : undefined,
      confidence: typeof a.confidence === 'number' ? Math.max(0, Math.min(1, a.confidence)) : 0.6,
    };
  }
}
