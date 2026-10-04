/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — source inspection.
 *
 * Turns a fetched page into a bounded SourceRecord with deterministic quality
 * signals (domain tier + content signals), and provides the sentence
 * segmentation used by evidence extraction. Pure functions — no I/O.
 */
import type { SearchHit, SourceRecord, SourceTier } from './researchTypes';
import { clampText } from './researchTypes';

function asUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    // Bare hostnames ("wikipedia.org") are not valid URLs — normalize them.
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim())) {
      try {
        return new URL(`https://${value.trim()}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function domainOfUrl(url: string): string {
  const parsed = asUrl(url);
  return parsed ? parsed.hostname.replace(/^www\./, '').toLowerCase() : '';
}

/** Registrable domain (last two labels) — used for source independence. */
export function registrableDomain(url: string): string {
  const host = domainOfUrl(url);
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return host;
  const twoLevelTlds = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'co.in', 'co.jp', 'com.br']);
  const last2 = parts.slice(-2).join('.');
  if (twoLevelTlds.has(last2) && parts.length >= 3) return parts.slice(-3).join('.');
  return last2;
}

const REFERENCE_DOMAINS = new Set([
  'wikipedia.org', 'britannica.com', 'encyclopedia.com', 'stanford-encyclopedia.com', 'plato.stanford.edu',
]);
const DOC_DOMAIN_RE = /^(?:docs?|developer|learn|api|guide|wiki)\./;
const NEWS_DOMAINS = new Set([
  'reuters.com', 'apnews.com', 'bbc.com', 'theguardian.com', 'nytimes.com', 'washingtonpost.com',
  'economist.com', 'nature.com', 'science.org', 'scientificamerican.com', 'npr.org', 'aljazeera.com',
]);
const SOCIAL_DOMAINS = new Set([
  'reddit.com', 'quora.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'tiktok.com',
  'medium.com', 'youtube.com', 'stackoverflow.com', 'pinterest.com',
]);

export function tierForDomain(domain: string): SourceTier {
  if (!domain) return 'unknown';
  // Quality signals fold subdomains into their registrable domain
  // (en.wikipedia.org counts as wikipedia.org) but keep host-based doc hints.
  // Bare domains ("wikipedia.org") are not valid URLs — fall back to self.
  const registrable = registrableDomain(domain) || domain;
  if (REFERENCE_DOMAINS.has(registrable)) return 'reference';
  if (/\.(?:edu|gov|ac\.uk|gov\.uk)$/i.test(domain)) return 'educational';
  if (SOCIAL_DOMAINS.has(registrable)) return 'social';
  if (NEWS_DOMAINS.has(registrable)) return 'news';
  if (DOC_DOMAIN_RE.test(domain) || DOC_DOMAIN_RE.test(registrable)) return 'docs';
  if (/\.(?:org)$/i.test(domain)) return 'docs';
  if (/\.(?:com|net|io|ai|dev|co)$/i.test(domain)) return 'general';
  return 'unknown';
}

const TIER_BASE_QUALITY: Record<SourceTier, number> = {
  reference: 0.9,
  educational: 0.85,
  docs: 0.85,
  news: 0.7,
  general: 0.5,
  social: 0.3,
  unknown: 0.4,
};

/** Deterministic quality estimate: tier baseline + small content signals. */
export function qualityScore(tier: SourceTier, textLength: number): number {
  let score = TIER_BASE_QUALITY[tier];
  if (textLength >= 2_000) score += 0.05;
  if (textLength > 0 && textLength < 400) score -= 0.1;
  return Math.max(0.1, Math.min(0.95, Math.round(score * 100) / 100));
}

let srcCounter = 0;
export function resetSourceIds(): void {
  srcCounter = 0;
}

/** Build the bounded SourceRecord for an inspected hit+page. */
export function makeSourceRecord(
  hit: SearchHit,
  page: { url: string; title: string; text: string },
  excerptMaxChars: number,
  now: number
): SourceRecord {
  srcCounter += 1;
  const domain = domainOfUrl(page.url) || domainOfUrl(hit.url);
  const tier = tierForDomain(domain);
  const text = page.text ?? '';
  return {
    id: `src_${srcCounter}`,
    url: page.url,
    domain,
    title: clampText(page.title || hit.title, 160),
    tier,
    quality: qualityScore(tier, text.length),
    fetchedAt: now,
    textExcerpt: clampText(text, excerptMaxChars),
    textLength: text.length,
  };
}

/** Sentence segmentation over the bounded excerpt. */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\s+/g, ' ').trim();
  const rough = normalized.split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/g);
  const sentences: string[] = [];
  for (const s of rough) {
    const clean = s.trim();
    if (clean.length >= 25 && clean.length <= 400 && /[a-z]/.test(clean)) {
      sentences.push(clean);
    }
  }
  return sentences;
}

/** Year tokens in text (freshness / temporal claims). */
export function extractYears(text: string): number[] {
  const years: number[] = [];
  for (const m of text.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)) {
    years.push(parseInt(m[1], 10));
  }
  return years;
}
