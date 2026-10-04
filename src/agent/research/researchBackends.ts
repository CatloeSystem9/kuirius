/**
 * Deep Research Intelligence (additional capability — outside the numbered
 * roadmap) — network backends.
 *
 * The ONLY place research touches the network, behind the ResearchWebBackend
 * interface so tests inject fakes and no real HTTP happens under test.
 *
 * The real backend calls the local server's /api/research/* endpoints
 * (same-origin pattern used by every other agent subsystem — PowerShell
 * backends, filesystem backends, CDP browser backend): server-side fetch
 * avoids browser CORS limits, keeps parsing off the client, and adds no
 * dependency. Injectable base URL so Node-based verification can target the
 * server directly (browser default is same-origin).
 */
import type { ResearchWebBackend, SearchHit } from './researchTypes';

const REQUEST_TIMEOUT_MS = 30_000;

let BASE_URL = '';

export function setResearchBackendBaseUrl(url: string): void {
  BASE_URL = url.replace(/\/$/, '');
}

type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const defaultFetch: FetchFn = (url, init) =>
  fetch(url, init as never) as unknown as Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function post(
  action: 'search' | 'fetch',
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
  fetchFn: FetchFn
): Promise<Record<string, any>> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${BASE_URL}/api/research/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return { success: false, error: `Research backend returned HTTP ${res.status}` };
    return (await res.json()) as Record<string, any>;
  } catch (err: any) {
    if (controller.signal.aborted) return { success: false, error: 'Research backend request timed out or was cancelled' };
    return { success: false, error: `Research backend unreachable: ${String(err?.message || err)}` };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Real backend over the local server endpoints. */
export class HttpResearchBackend implements ResearchWebBackend {
  private fetchFn: FetchFn;

  constructor(fetchFn?: FetchFn) {
    this.fetchFn = fetchFn ?? defaultFetch;
  }

  async search(query: string, signal?: AbortSignal): Promise<{ hits: SearchHit[]; error?: string }> {
    const r = await post('search', { query }, signal, this.fetchFn);
    if (!r.success) return { hits: [], error: r.error ?? 'Search failed' };
    const hits = Array.isArray(r.results) ? (r.results as SearchHit[]) : [];
    return { hits };
  }

  async fetchPage(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string; error?: string }> {
    const r = await post('fetch', { url }, signal, this.fetchFn);
    if (!r.success) return { url, title: '', text: '', error: r.error ?? 'Fetch failed' };
    return { url: String(r.url ?? url), title: String(r.title ?? ''), text: String(r.text ?? '') };
  }
}

// ---------------------------------------------------------------- test fakes

/** Scripted backend for deterministic tests: queries → hits, urls → pages. */
export class FakeResearchBackend implements ResearchWebBackend {
  searchResults = new Map<string, { hits: SearchHit[]; error?: string }>();
  pages = new Map<string, { title: string; text: string }>();
  /** Fallback for unscripted queries (loop tests) — empty means "no results". */
  defaultSearch: SearchHit[] = [];
  searchCalls = 0;
  fetchCalls = 0;
  /** When set, the next N searches fail regardless of the query. */
  failNextSearches = 0;
  /** When set, URLs containing these substrings fail to fetch. */
  failFetchContaining: string[] = [];

  constructor(
    private delayMs = 0,
    private clock: (ms: number) => Promise<void> = () => Promise.resolve()
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<{ hits: SearchHit[]; error?: string }> {
    this.searchCalls++;
    if (signal?.aborted) return { hits: [], error: 'cancelled' };
    if (this.delayMs > 0) await this.clock(this.delayMs);
    if (this.failNextSearches > 0) {
      this.failNextSearches--;
      return { hits: [], error: 'search unavailable' };
    }
    const direct = this.searchResults.get(query);
    if (direct) return direct;
    if (this.searchResults.size > 0 && this.defaultSearch.length === 0) {
      return { hits: [], error: `no results scripted for "${query}"` };
    }
    return { hits: this.defaultSearch };
  }

  async fetchPage(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string; error?: string }> {
    this.fetchCalls++;
    if (signal?.aborted) return { url, title: '', text: '', error: 'cancelled' };
    if (this.delayMs > 0) await this.clock(this.delayMs);
    if (this.failFetchContaining.some((frag) => url.includes(frag))) {
      return { url, title: '', text: '', error: 'fetch failed' };
    }
    const page = this.pages.get(url);
    if (!page) return { url, title: '', text: '', error: `no page scripted for ${url}` };
    return { url, ...page };
  }
}
