/**
 * SPF redaction — removes detected sensitive spans from text payloads and
 * redacts pixel regions on captured frames.
 *
 * Rules (task §4):
 *  - redaction replaces spans with bounded, category-labeled markers;
 *  - overlapping/adjacent matches are merged so a secret is fully removed;
 *  - the ORIGINAL payload is never a fallback: callers re-scan redacted text
 *    (verifyRedacted in decision.ts) and BLOCK when anything sensitive remains;
 *  - frame-region redaction is a pure RGBA operation (testable in Node) that
 *    fills regions so pixels cannot be reconstructed from the transmitted copy.
 */
import type { SpfFinding, SpfSeverity } from './spfTypes';

export interface RedactionMarkerStyle {
  /** Marker label style, e.g. `[REDACTED-SPF:otp]`. */
  format: (category: string) => string;
}

const DEFAULT_MARKER: RedactionMarkerStyle = {
  format: (category) => `[REDACTED-SPF:${category}]`,
};

interface Span {
  start: number;
  end: number;
  category: string;
}

function mergeSpans(spans: Span[], textLength: number): Span[] {
  const sorted = [...spans].filter((s) => s.start >= 0 && s.end > s.start && s.start < textLength)
    // start ascending, then LONGER span first — so a wider (more specific)
    // finding keeps its category as the marker label.
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      // Overlapping or touching — extend; severity keeps the first (sorted by
      // position), category of the wider span is preserved when it covers.
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** Fraction (0..1) of the original text removed by redaction. */
export function redactionCoverage(original: string, redacted: string): number {
  if (original.length === 0) return 0;
  const removed = original.length - redacted.length;
  // Markers add text back; compute honestly from removed raw characters,
  // bounded to 1.
  return Math.max(0, Math.min(1, removed / original.length));
}

/** Number of redaction markers present in a string (bounded sanity check). */
export function countRedactionMarkers(text: string): number {
  return (text.match(/\[REDACTED-SPF:[a-z_]+\]/g) || []).length;
}

/**
 * Replace redaction markers before a RESCAN with a token that BREAKS the
 * keyword:value adjacency (`login: [marker] password: [marker]` must not
 * re-detect as `login: password:`). A single backslash is excluded from
 * every detector value class ([^\s"'"\\]) and is not whitespace (so \\s*
 * bridges cannot jump over it) — no pattern can treat it as a secret value.
 * The transmitted text still contains the real markers; masking affects
 * only the re-scan view.
 */
export function maskRedactionMarkers(text: string): string {
  return text.replace(/\[REDACTED-SPF:[a-z_]+\]/g, '\\');
}

/**
 * Replace all sensitive spans with markers. Findings with sub-minimum
 * confidence must NOT be passed here (decision.ts filters first).
 */
export function applyRedactions(
  text: string,
  findings: SpfFinding[],
  style: RedactionMarkerStyle = DEFAULT_MARKER
): string {
  if (findings.length === 0 || text.length === 0) return text;
  const spans: Span[] = findings.map((f) => ({ start: f.start, end: f.end, category: f.category }));
  const merged = mergeSpans(spans, text.length);
  let out = '';
  let cursor = 0;
  for (const span of merged) {
    out += text.slice(cursor, span.start);
    out += style.format(span.category);
    cursor = Math.max(cursor, span.end);
  }
  out += text.slice(cursor);
  return out;
}

/** Severity-aware redaction: only findings at/above the threshold are removed. */
export function applyRedactionsAtLeast(
  text: string,
  findings: SpfFinding[],
  minSeverity: SpfSeverity,
  style: RedactionMarkerStyle = DEFAULT_MARKER
): string {
  const order: SpfSeverity[] = ['uncertain', 'sensitive', 'never_transmit'];
  const min = order.indexOf(minSeverity);
  return applyRedactions(
    text,
    findings.filter((f) => order.indexOf(f.severity) >= min),
    style
  );
}

// ------------------------------------------------------- frame regions (RGBA)

export interface NormalizedRegion {
  /** Normalized 0..1 coordinates relative to the full frame. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Redact rectangular regions of a captured frame's RGBA buffer.
 * Pure function: returns a new Uint8ClampedArray (the original is untouched),
 * filling each region with opaque black. Coordinates are clamped to bounds.
 * This is the "sensitive visual-region redaction" primitive used when prior
 * analysis identifies regions to remove before a transfer.
 */
export function redactFrameRegions(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  regions: NormalizedRegion[]
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba); // copy — original stays local
  for (const region of regions) {
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(region.x * width)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(region.y * height)));
    const x1 = Math.max(0, Math.min(width, Math.ceil((region.x + region.width) * width)));
    const y1 = Math.max(0, Math.min(height, Math.ceil((region.y + region.height) * height)));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * 4;
        out[idx] = 0;
        out[idx + 1] = 0;
        out[idx + 2] = 0;
        out[idx + 3] = 255;
      }
    }
  }
  return out;
}

/**
 * Browser-side helper: redact regions on a JPEG data URL through canvas.
 * Async and browser-only (createImageBitmap); returns null when unsupported
 * so callers fall back to BLOCK (never to the original payload).
 */
export async function redactDataUrlRegions(dataUrl: string, regions: NormalizedRegion[]): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(await (await fetch(`data:${dataUrl}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = '#000000';
    for (const region of regions) {
      ctx.fillRect(region.x * canvas.width, region.y * canvas.height, region.width * canvas.width, region.height * canvas.height);
    }
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch {
    return null;
  }
}
