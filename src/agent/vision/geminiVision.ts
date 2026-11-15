/**
 * Gemini cloud-vision provider (Phase 4).
 *
 * Opt-in only: invoked when a task explicitly requests deep analysis
 * (`analyze: 'cloud'`), never automatically. Sends a downscaled JPEG to the
 * project's own server endpoint (/api/vision/analyze) which routes through
 * the existing Gemini model waterfall with server-side rate limiting.
 * Failures are reported honestly as provider_unavailable / analysis_failed.
 *
 * SPF enforcement (EP-10): every transfer passes the Screen Privacy Firewall
 * BEFORE leaving the tab (blocked requests never hit the network) and the
 * returned analysis (a derived screen representation) is screened again on
 * receipt. The server independently re-runs the same gate — this client gate
 * is defense in depth and gives honest local UX.
 */
import type { CapturedFrame, VisionAnalysis, VisionAnalysisContext, VisionProvider } from './visionTypes';
import { ObserverError } from './visionTypes';
import { spfFirewall, spfScreenItem } from '../spf/index';

const MAX_IMAGE_WIDTH = 768;

function stripDataUrlPrefix(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',');
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

/** SPF-screen one returned analysis string (redact or strip the item). */
function spfClean(value: string): string {
  return spfScreenItem(value, 'gemini:vision-analyze:client-receive', undefined, 'prompt').text;
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

    // SPF EP-10a — pre-send gate. Any sensitive signal in the transfer
    // context blocks the upload BEFORE any bytes leave the tab.
    const question = context.question ?? 'Describe what is currently visible on this screen.';
    const imageVerdict = spfFirewall.inspectImageTransfer(
      { question, activeWindowTitle: context.activeWindow?.title },
      { destination: 'gemini:vision-analyze', payloadKind: 'image', transport: 'prompt' }
    );
    if (imageVerdict.decision === 'block') {
      throw new ObserverError(
        'provider_unavailable',
        `Screen Privacy Firewall blocked cloud analysis: ${imageVerdict.reason}`
      );
    }

    const baseUrl = typeof window !== 'undefined' ? '' : (process.env.VISION_BASE_URL || 'http://localhost:3000');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/vision/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: stripDataUrlPrefix(frame.dataUrl),
          question: imageVerdict.decision === 'redact' && imageVerdict.redactedText ? imageVerdict.redactedText : question,
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

    if (data?.spfBlocked) {
      throw new ObserverError('provider_unavailable', `Screen Privacy Firewall blocked cloud analysis: ${String(data.reason ?? 'policy')}`);
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
    // SPF EP-10b — post-receive screening of the OCR-derived texts: secrets
    // transcribed by the model are redacted/stripped before they enter any
    // downstream representation (ScreenState, tool outputs, summaries).
    const clean = (v: unknown): string => (typeof v === 'string' ? spfClean(v) : '');
    return {
      provider: this.name,
      summary: typeof a.summary === 'string' ? clean(a.summary) : 'Cloud vision returned no summary.',
      application: typeof a.application === 'string' ? clean(a.application) : undefined,
      texts: asArray<any>(a.texts).map((t) => (t && typeof t === 'object' ? { ...t, text: clean(t.text) } : t)),
      elements: asArray<any>(a.elements).map((e) => (e && typeof e === 'object' && typeof e.text === 'string' ? { ...e, text: clean(e.text) } : e)),
      dialogs: asArray<any>(a.dialogs).map((d) => (d && typeof d === 'object' && typeof d.text === 'string' ? { ...d, text: clean(d.text) } : d)),
      errors: asArray(a.errors).filter((e: unknown): e is string => typeof e === 'string').map(clean),
      warnings: asArray(a.warnings).filter((e: unknown): e is string => typeof e === 'string').map(clean),
      loading: typeof a.loading === 'boolean' ? a.loading : undefined,
      confidence: typeof a.confidence === 'number' ? Math.max(0, Math.min(1, a.confidence)) : 0.6,
    };
  }
}
