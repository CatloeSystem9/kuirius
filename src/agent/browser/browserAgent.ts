/**
 * Browser Agent (Phase 8) — browser-specific observe → plan → act → verify
 * loop on top of the CDP-backed page-state model, with the Phase 7
 * Computer-Use Agent as the desktop fallback when the controlled browser is
 * unavailable. Runs inside the Agent Core via the `browser.use` tool.
 *
 * Lightweight by design: bounded state (25 links / 25 buttons / 25 fields),
 * one fresh state per action, adaptive bounded waits for navigation and
 * delayed elements, no polling loops, no page-history storage.
 */
import type {
  BrowserActionIntent,
  BrowserActionRecord,
  BrowserBackend,
  BrowserState,
  BrowserUseResult,
  NavigateOptions,
  NavigateVerification,
  BrowserActionResult,
} from './browserTypes';
import { maskSensitiveText } from '../computer/keyboardTypes';
import { ControlError } from '../computer/mouseTypes';
import type { AgentEventBus } from '../events';

const WAIT_INTERVALS_MS = [300, 600, 1000];
const DEFAULT_NAV_TIMEOUT_MS = 20_000;
const MAX_FIND_RESULTS = 8;

export interface BrowserAgentOptions {
  backend: BrowserBackend;
  events?: AgentEventBus;
  /** Optional Phase 7 fallback for desktop-level interaction. */
  computerUse?: { run(goal: string, signal?: AbortSignal): Promise<any> };
  /** Reuse window for state between steps (ms). */
  stateStaleMs?: number;
  /** Adaptive observation (Phase 13): request screen observation only when
   * browser-native state is insufficient or a visual check is warranted. */
  adaptiveObservation?: { observe(trigger: 'browser_navigation' | 'visual_fallback'): Promise<void> };
}

export class BrowserAgent {
  private backend: BrowserBackend;
  private events?: AgentEventBus;
  private computerUse?: BrowserAgentOptions['computerUse'];
  private stateStaleMs: number;
  private cachedState: BrowserState | null = null;
  private adaptiveObservation?: BrowserAgentOptions['adaptiveObservation'];

  constructor(options: BrowserAgentOptions) {
    this.backend = options.backend;
    this.events = options.events;
    this.computerUse = options.computerUse;
    this.stateStaleMs = options.stateStaleMs ?? 2000;
    this.adaptiveObservation = options.adaptiveObservation;
  }

  setAdaptiveObservation(hook: NonNullable<BrowserAgentOptions['adaptiveObservation']>): void {
    this.adaptiveObservation = hook;
  }

  /** Best-effort adaptive screen observation — never blocks the browser flow. */
  private requestObservation(trigger: 'browser_navigation' | 'visual_fallback'): void {
    this.adaptiveObservation?.observe(trigger).catch(() => {
      // Observation is advisory here; browser-native state remains authoritative.
    });
  }

  setComputerUse(cu: NonNullable<BrowserAgentOptions['computerUse']>): void {
    this.computerUse = cu;
  }

  // ------------------------------------------------------------------ state

  async getState(signal?: AbortSignal, force = false): Promise<BrowserState> {
    if (!force && this.cachedState && Date.now() - this.cachedState.capturedAt < this.stateStaleMs) {
      return this.cachedState;
    }
    if (signal?.aborted) throw new ControlError('cancelled', 'Browser action cancelled');
    const response = await this.backend.getState();
    if (!response.success || !response.state) {
      const state: BrowserState = {
        available: false,
        error: response.error ?? 'Browser state unavailable',
        page: null,
        tabs: [],
        capturedAt: Date.now(),
      };
      this.cachedState = state;
      this.events?.emit({ name: 'BROWSER_OBSERVED', payload: { available: false }, timestamp: Date.now() });
      // CDP state is insufficient — ask the adaptive layer for a screen look
      // (the visual fallback path). Advisory only.
      this.requestObservation('visual_fallback');
      return state;
    }
    // Defensive bounding — the server slices too, but never trust the wire.
    const raw = response.state;
    const state: BrowserState = {
      available: true,
      page: {
        url: raw.url,
        title: raw.title,
        ready: raw.ready,
        links: (raw.links ?? []).slice(0, 25),
        buttons: (raw.buttons ?? []).slice(0, 25),
        fields: (raw.fields ?? []).slice(0, 25),
        headings: (raw.headings ?? []).slice(0, 10),
      },
      tabs: (response.tabs ?? []).slice(0, 10),
      capturedAt: Date.now(),
    };
    this.cachedState = state;
    this.events?.emit({
      name: 'BROWSER_OBSERVED',
      payload: { url: state.page?.url, title: state.page?.title },
      timestamp: Date.now(),
    });
    return state;
  }

  invalidateState(): void {
    this.cachedState = null;
  }

  // -------------------------------------------------------------- navigation

  private validateUrl(raw: string): string {
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw new ControlError('invalid_coordinates', `"${raw.slice(0, 60)}" is not a valid URL`, false);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ControlError('invalid_coordinates', `Only http/https URLs are supported (got "${parsed.protocol}")`, false);
    }
    return parsed.toString();
  }

  /** Ensure a bare input like "example.com" becomes a navigable URL. */
  private coerceUrl(raw: string): string {
    const trimmed = raw.trim();
    // Explicit non-http(s) schemes are rejected — never navigated.
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) {
      throw new ControlError('invalid_coordinates', `Only http/https URLs are supported (got "${schemeMatch[1].toLowerCase()}")`, false);
    }
    if (/^https?:\/\//i.test(trimmed)) return this.validateUrl(trimmed);
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(trimmed)) return this.validateUrl(`https://${trimmed}`);
    // Search-style input: delegate to a search URL.
    return this.validateUrl(`https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`);
  }

  async navigate(url: string, options: NavigateOptions = {}, signal?: AbortSignal): Promise<BrowserActionResult> {
    const safeUrl = this.coerceUrl(url);
    if (signal?.aborted) throw new ControlError('cancelled', 'Browser action cancelled');
    this.events?.emit({ name: 'BROWSER_ACTION_STARTED', payload: { action: 'navigate', url: safeUrl }, timestamp: Date.now() });

    const response = await this.backend.navigate(safeUrl);
    if (!response.success) {
      this.events?.emit({ name: 'BROWSER_ACTION_FAILED', payload: { action: 'navigate', error: response.error }, timestamp: Date.now() });
      throw new ControlError('backend_failed', `Navigation to ${safeUrl} failed: ${response.error ?? 'unknown error'}`, true);
    }

    // Bounded wait for a complete, stable page.
    await this.waitForReady(options.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS, signal);
    const state = await this.getState(signal, true);
    const page = state.page;

    const verification = this.verifyNavigation(page, options, safeUrl);
    this.events?.emit({
      name: verification.verified ? 'BROWSER_ACTION_VERIFIED' : 'BROWSER_ACTION_FAILED',
      payload: { action: 'navigate', note: verification.note },
      timestamp: Date.now(),
    });

    // Phase 13: request adaptive screen observation after navigation (useful
    // for desktop-visible side effects); browser-native state stays primary.
    this.requestObservation('browser_navigation');

    return {
      action: 'navigate',
      url: page?.url,
      title: page?.title,
      verified: verification.verified,
      verificationNote: verification.note,
      summary: `Navigated to ${page?.url ?? safeUrl}${page?.title ? ` ("${page.title}")` : ''}. ${verification.note}`,
    };
  }

  private verifyNavigation(page: { url: string; title: string; headings: string[] } | null, options: NavigateOptions, requestedUrl: string): NavigateVerification {
    if (!page) {
      return { strategy: 'self_reported', verified: false, note: 'Page state could not be read after navigation' };
    }
    if (options.expectUrlContains && !page.url.toLowerCase().includes(options.expectUrlContains.toLowerCase())) {
      return { strategy: 'url', verified: false, note: `URL "${page.url}" does not contain "${options.expectUrlContains}"` };
    }
    if (options.expectTitle && !page.title.toLowerCase().includes(options.expectTitle.toLowerCase())) {
      return { strategy: 'title', verified: false, note: `Title "${page.title}" does not contain "${options.expectTitle}"` };
    }
    if (options.expectText) {
      const haystack = JSON.stringify(page.headings).toLowerCase();
      return {
        strategy: 'text',
        verified: haystack.includes(options.expectText.toLowerCase()),
        note: haystack.includes(options.expectText.toLowerCase())
          ? 'Expected text found in page headings'
          : `Expected text "${options.expectText}" not found in page headings`,
      };
    }
    // Default evidence: the loaded URL matches the request origin/path.
    const requested = new URL(requestedUrl);
    const loaded = new URL(page.url);
    const same = loaded.hostname === requested.hostname;
    return {
      strategy: 'url',
      verified: same,
      note: same
        ? `Loaded page on ${loaded.hostname} confirmed`
        : `Landed on ${loaded.hostname} instead of ${requested.hostname}`,
    };
  }

  /** Bounded adaptive wait for document readiness (no infinite polling). */
  private async waitForReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let intervalIndex = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ControlError('cancelled', 'Browser action cancelled');
      const response = await this.backend.getState();
      if (response.success && response.state?.ready === 'complete') return;
      const wait = WAIT_INTERVALS_MS[Math.min(intervalIndex, WAIT_INTERVALS_MS.length - 1)];
      intervalIndex++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }

  async goBack(signal?: AbortSignal): Promise<BrowserActionResult> {
    const response = await this.backend.goBack();
    if (!response.success) throw new ControlError('backend_failed', `Back navigation failed: ${response.error}`, true);
    await this.waitForReady(DEFAULT_NAV_TIMEOUT_MS, signal);
    this.invalidateState();
    const state = await this.getState(signal, true);
    return { action: 'back', url: state.page?.url, title: state.page?.title, summary: `Navigated back to ${state.page?.url ?? 'the previous page'}.` };
  }

  async goForward(signal?: AbortSignal): Promise<BrowserActionResult> {
    const response = await this.backend.goForward();
    if (!response.success) throw new ControlError('backend_failed', `Forward navigation failed: ${response.error}`, true);
    await this.waitForReady(DEFAULT_NAV_TIMEOUT_MS, signal);
    this.invalidateState();
    const state = await this.getState(signal, true);
    return { action: 'forward', url: state.page?.url, title: state.page?.title, summary: `Navigated forward to ${state.page?.url ?? 'the next page'}.` };
  }

  async refresh(signal?: AbortSignal): Promise<BrowserActionResult> {
    const response = await this.backend.refresh();
    if (!response.success) throw new ControlError('backend_failed', `Refresh failed: ${response.error}`, true);
    await this.waitForReady(DEFAULT_NAV_TIMEOUT_MS, signal);
    this.invalidateState();
    const state = await this.getState(signal, true);
    return { action: 'refresh', url: state.page?.url, title: state.page?.title, summary: `Reloaded ${state.page?.url ?? 'the page'}.` };
  }

  // ---------------------------------------------------------- find / interact

  /** Find links/buttons/fields/headings matching a text query. */
  async find(query: string, signal?: AbortSignal): Promise<{ matches: string[]; count: number }> {
    if (signal?.aborted) throw new ControlError('cancelled', 'Browser action cancelled');
    const state = await this.getState(signal);
    const page = state.page;
    if (!page) throw new ControlError('backend_failed', 'No browser page available to search', true);

    const q = query.trim().toLowerCase();
    const words = q.split(/\s+/).filter((w) => w.length > 1);
    const matchesText = (t: string): boolean => {
      const c = t.toLowerCase();
      return c.includes(q) || words.some((w) => c.includes(w));
    };

    const matches: string[] = [];
    for (const link of page.links) {
      if (matchesText(link.text)) matches.push(`link "${link.text.slice(0, 60)}" → ${link.href.slice(0, 80)}`);
    }
    for (const button of page.buttons) {
      if (matchesText(button.text)) matches.push(`button "${button.text.slice(0, 60)}"`);
    }
    for (const field of page.fields) {
      const label = field.placeholder || field.name || field.id || field.type;
      if (matchesText(label)) matches.push(`${field.tag} field "${label.slice(0, 60)}"`);
    }
    for (const heading of page.headings) {
      if (matchesText(heading)) matches.push(`heading "${heading.slice(0, 60)}"`);
    }
    return { matches: matches.slice(0, MAX_FIND_RESULTS), count: matches.length };
  }

  /** Scroll until a text query appears on the page (bounded). */
  async scrollUntil(query: string, options: { maxSteps?: number; timeoutMs?: number } = {}, signal?: AbortSignal): Promise<{ found: boolean; steps: number }> {
    const maxSteps = options.maxSteps ?? 10;
    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) throw new ControlError('cancelled', 'Browser action cancelled');
      const { count } = await this.find(query, signal);
      if (count > 0) return { found: true, steps: step };
      await this.backend.scrollBy(600);
      await new Promise((r) => setTimeout(r, WAIT_INTERVALS_MS[Math.min(step, WAIT_INTERVALS_MS.length - 1)]));
    }
    const { count } = await this.find(query, signal);
    return { found: count > 0, steps: maxSteps };
  }

  async click(targetText: string, options: { kind?: 'link' | 'button' | 'any'; expectUrlContains?: string; expectText?: string } = {}, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (signal?.aborted) throw new ControlError('cancelled', 'Browser action cancelled');
    this.events?.emit({ name: 'BROWSER_ACTION_STARTED', payload: { action: 'click', target: targetText }, timestamp: Date.now() });

    const before = await this.getState(signal);
    const response = await this.backend.clickText(targetText, options.kind ?? 'any');
    if (!response.success) {
      this.events?.emit({ name: 'BROWSER_ACTION_FAILED', payload: { action: 'click', error: response.error }, timestamp: Date.now() });
      throw new ControlError('target_not_found', response.error ?? 'Click failed', true);
    }
    this.invalidateState();
    await this.waitForReady(10_000, signal);
    const after = await this.getState(signal, true);

    const urlChanged = before.page?.url !== after.page?.url;
    let verified = false;
    let note = 'Page state after click is unchanged';
    if (options.expectUrlContains && after.page) {
      verified = after.page.url.toLowerCase().includes(options.expectUrlContains.toLowerCase());
      note = verified ? `URL now contains "${options.expectUrlContains}"` : `URL "${after.page.url}" does not contain "${options.expectUrlContains}"`;
    } else if (options.expectText && after.page) {
      verified = JSON.stringify(after.page.headings).toLowerCase().includes(options.expectText.toLowerCase());
      note = verified ? 'Expected text appeared' : 'Expected text did not appear';
    } else {
      verified = urlChanged || Boolean(response.href);
      note = urlChanged ? 'Page navigated as a result of the click' : verified ? 'Click dispatched on the matched element' : 'No page change after the click';
    }

    this.events?.emit({
      name: verified ? 'BROWSER_ACTION_VERIFIED' : 'BROWSER_ACTION_FAILED',
      payload: { action: 'click', note },
      timestamp: Date.now(),
    });

    return {
      action: 'click',
      matched: response.clicked,
      url: after.page?.url,
      title: after.page?.title,
      verified,
      verificationNote: note,
      summary: `Clicked "${response.clicked ?? targetText}". ${note}`,
    };
  }

  async type(text: string, fieldMatch: string, signal?: AbortSignal): Promise<BrowserActionResult> {
    if (signal?.aborted) throw new ControlError('cancelled', 'Browser action cancelled');
    const { masked, sensitive } = maskSensitiveText(text);
    this.events?.emit({ name: 'BROWSER_ACTION_STARTED', payload: { action: 'type', field: fieldMatch, sensitive }, timestamp: Date.now() });

    const response = await this.backend.typeIntoField(fieldMatch, text);
    if (!response.success) {
      this.events?.emit({ name: 'BROWSER_ACTION_FAILED', payload: { action: 'type', error: response.error }, timestamp: Date.now() });
      throw new ControlError('target_not_found', response.error ?? 'Typing failed', true);
    }
    const state = await this.getState(signal, true);
    return {
      action: 'type',
      matched: response.field,
      summary: `Typed ${sensitive ? '[sensitive input masked]' : `"${masked}"`} into the "${response.field ?? fieldMatch}" field.`,
      verified: true,
      verificationNote: 'Field value set and input/change events dispatched (confirmed by the browser).',
    };
  }

  async pressKey(_key: string, _signal?: AbortSignal): Promise<BrowserActionResult> {
    // Real key delivery goes through the Phase 6 keyboard layer on the focused
    // desktop window; synthetic keys inside the headless CDP browser are not
    // trusted, so this intentionally delegates rather than faking success.
    throw new ControlError('backend_failed', 'Use the keyboard control layer (computer.press_key) for key delivery, or run inside computer-use', false);
  }

  async scroll(direction: 'up' | 'down', amount = 3, signal?: AbortSignal): Promise<BrowserActionResult> {
    const deltaY = direction === 'up' ? -120 * amount : 120 * amount;
    const response = await this.backend.scrollBy(deltaY);
    if (!response.success) throw new ControlError('backend_failed', response.error ?? 'Scroll failed', true);
    return { action: 'scroll', summary: `Scrolled ${direction} by ${amount} notches in the browser page.`, verified: true, verificationNote: 'Scroll executed in the controlled browser.' };
  }

  /** Bounded adaptive wait for an expected page condition. */
  async waitFor(
    expected: { urlContains?: string; titleContains?: string; textContains?: string },
    options: { timeoutMs?: number } = {},
    signal?: AbortSignal
  ): Promise<{ satisfied: boolean; observations: number }> {
    const deadline = Date.now() + (options.timeoutMs ?? 8000);
    let observations = 0;
    let intervalIndex = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ControlError('cancelled', 'Browser action cancelled');
      observations++;
      const state = await this.getState(signal, true);
      const page = state.page;
      if (page) {
        if (expected.urlContains && !page.url.toLowerCase().includes(expected.urlContains.toLowerCase())) {
          // not satisfied
        } else if (expected.titleContains && !page.title.toLowerCase().includes(expected.titleContains.toLowerCase())) {
          // not satisfied
        } else if (expected.textContains && !JSON.stringify(page.headings).toLowerCase().includes(expected.textContains.toLowerCase())) {
          // not satisfied
        } else {
          return { satisfied: true, observations };
        }
      }
      const wait = WAIT_INTERVALS_MS[Math.min(intervalIndex, WAIT_INTERVALS_MS.length - 1)];
      intervalIndex++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    return { satisfied: false, observations };
  }

  // --------------------------------------------------------------- task loop

  /** Run a compound browser task (used by the `browser.use` tool). */
  async run(goal: string, intents: BrowserActionIntent[], signal?: AbortSignal): Promise<BrowserUseResult> {
    this.events?.emit({ name: 'BROWSER_TASK_STARTED', payload: { goal }, timestamp: Date.now() });
    const actions: BrowserActionRecord[] = [];
    let cancelled = false;

    for (const intent of intents) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      this.events?.emit({ name: 'BROWSER_ACTION_PLANNED', payload: { kind: intent.kind, description: intent.description }, timestamp: Date.now() });
      try {
        let record: BrowserActionRecord;
        switch (intent.kind) {
          case 'navigate': {
            const result = await this.navigate(String(intent.params.url ?? intent.params.query ?? ''), {
              expectText: intent.params.expectText as string | undefined,
            }, signal);
            record = { intent, status: 'completed', verified: result.verified, verificationNote: result.verificationNote };
            break;
          }
          case 'find': {
            const { matches, count } = await this.find(String(intent.params.query ?? ''), signal);
            record = {
              intent,
              status: 'completed',
              verified: count > 0,
              verificationNote: count > 0 ? `${count} match(es) found` : 'No matches on the current page',
              error: count === 0 ? 'No matches' : undefined,
            };
            void matches;
            break;
          }
          case 'click': {
            const result = await this.click(String(intent.params.target ?? ''), {
              kind: intent.params.kind as any,
              expectUrlContains: intent.params.expectUrlContains as string | undefined,
              expectText: intent.params.expectText as string | undefined,
            }, signal);
            record = { intent, status: 'completed', verified: result.verified, verificationNote: result.verificationNote };
            break;
          }
          case 'type': {
            const result = await this.type(String(intent.params.text ?? ''), String(intent.params.field ?? ''), signal);
            record = { intent, status: 'completed', verified: result.verified, verificationNote: result.verificationNote };
            break;
          }
          case 'scroll': {
            const result = await this.scroll((intent.params.direction as 'up' | 'down') ?? 'down', (intent.params.amount as number) ?? 3, signal);
            record = { intent, status: 'completed', verified: result.verified, verificationNote: result.verificationNote };
            break;
          }
          case 'scroll_until': {
            const found = await this.scrollUntil(String(intent.params.query ?? ''), {}, signal);
            record = { intent, status: found.found ? 'completed' : 'failed', verified: found.found, error: found.found ? undefined : `"${intent.params.query}" not found after scrolling` };
            break;
          }
          case 'wait': {
            const wait = await this.waitFor({
              urlContains: intent.params.urlContains as string | undefined,
              titleContains: intent.params.titleContains as string | undefined,
              textContains: intent.params.textContains as string | undefined,
            }, { timeoutMs: (intent.params.timeoutMs as number) ?? 8000 }, signal);
            record = { intent, status: wait.satisfied ? 'completed' : 'failed', verified: wait.satisfied, error: wait.satisfied ? undefined : 'Expected page state did not appear in time' };
            break;
          }
          case 'back': {
            const result = await this.goBack(signal);
            record = { intent, status: 'completed', verified: true, verificationNote: result.summary };
            break;
          }
          case 'forward': {
            const result = await this.goForward(signal);
            record = { intent, status: 'completed', verified: true, verificationNote: result.summary };
            break;
          }
          case 'refresh': {
            const result = await this.refresh(signal);
            record = { intent, status: 'completed', verified: true, verificationNote: result.summary };
            break;
          }
          default:
            record = { intent, status: 'failed', error: `Unsupported browser action "${intent.kind}"` };
        }
        actions.push(record);
        this.events?.emit({ name: 'BROWSER_ACTION_COMPLETED', payload: { kind: intent.kind, verified: record.verified }, timestamp: Date.now() });
        if (record.status === 'failed') {
          this.events?.emit({ name: 'BROWSER_ACTION_FAILED', payload: { kind: intent.kind, error: record.error }, timestamp: Date.now() });
          break; // safe stop — re-planning from the broken state is not heuristic
        }
      } catch (err: any) {
        if (err instanceof ControlError && err.kind === 'cancelled') {
          cancelled = true;
          break;
        }
        actions.push({ intent, status: 'failed', error: String(err?.message || err) });
        this.events?.emit({ name: 'BROWSER_ACTION_FAILED', payload: { kind: intent.kind, error: String(err?.message || err) }, timestamp: Date.now() });
        break;
      }
    }

    for (let i = actions.length; i < intents.length; i++) {
      actions.push({ intent: intents[i], status: 'skipped' });
    }

    const finalState = await this.getState(signal).catch(() => null);
    const status: BrowserUseResult['status'] = cancelled
      ? 'cancelled'
      : actions.some((a) => a.status === 'failed')
      ? 'failed'
      : actions.every((a) => a.status === 'completed')
      ? 'completed'
      : 'partial';

    const header =
      status === 'completed'
        ? `Browser task completed: all ${actions.length} action(s) executed.`
        : status === 'failed'
        ? `Browser task stopped after a failure.`
        : status === 'cancelled'
        ? 'Browser task was cancelled.'
        : `Browser task ended partially.`;
    const lines = actions.map((a, i) => `${i + 1}. ${a.intent.description} — ${a.status === 'completed' ? (a.verified ? 'Done (verified)' : 'Done (unverified)') : a.status === 'failed' ? `Failed — ${a.error ?? ''}` : 'Skipped'}`);
    const summary = [header, ...lines, finalState?.page ? `Final page: ${finalState.page.url}` : ''].join('\n').trim();

    this.events?.emit({ name: cancelled ? 'BROWSER_TASK_CANCELLED' : 'BROWSER_TASK_COMPLETED', payload: { status }, timestamp: Date.now() });
    return { status, goal, actions, finalUrl: finalState?.page?.url, finalTitle: finalState?.page?.title, observations: actions.length, summary };
  }
}
