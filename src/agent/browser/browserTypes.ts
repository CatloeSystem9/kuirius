/**
 * Browser Agent types (Phase 8).
 *
 * A bounded, structured page-state model — no DOM mirrors, no page history
 * storage. Source of truth is the Krisha-controlled CDP browser via the local
 * server; when that is unavailable the agent falls back to the Phase 7
 * computer-use layer (screen vision + mouse/keyboard) for desktop-level
 * browser interaction.
 */

export interface PageLink {
  text: string;
  href: string;
}

export interface PageButton {
  text: string;
}

export interface PageField {
  tag: string;
  type: string;
  placeholder: string;
  name: string;
  id: string;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
}

export interface BrowserPageState {
  url: string;
  title: string;
  ready: 'complete' | 'loading' | 'interactive';
  links: PageLink[];
  buttons: PageButton[];
  fields: PageField[];
  headings: string[];
}

export interface BrowserState {
  available: boolean;
  error?: string;
  page: BrowserPageState | null;
  tabs: BrowserTab[];
  capturedAt: number;
}

export interface NavigateVerification {
  strategy: 'url' | 'title' | 'text' | 'self_reported';
  verified: boolean;
  note: string;
}

export interface NavigateOptions {
  expectTitle?: string;
  expectText?: string;
  expectUrlContains?: string;
  timeoutMs?: number;
}

export interface BrowserActionResult {
  action: string;
  summary: string;
  verified?: boolean;
  verificationNote?: string;
  url?: string;
  title?: string;
  matched?: string;
}

/** Injectable transport: HTTP to the local server (real) or a fake for tests. */
export interface BrowserBackend {
  getState(): Promise<{ success: boolean; state?: BrowserPageState; tabs?: BrowserTab[]; error?: string }>;
  navigate(url: string): Promise<{ success: boolean; url?: string; title?: string; error?: string }>;
  goBack(): Promise<{ success: boolean; url?: string; title?: string; error?: string }>;
  goForward(): Promise<{ success: boolean; url?: string; title?: string; error?: string }>;
  refresh(): Promise<{ success: boolean; url?: string; title?: string; error?: string }>;
  clickText(text: string, kind?: 'link' | 'button' | 'any'): Promise<{ success: boolean; clicked?: string; href?: string; url?: string; title?: string; error?: string; errorKind?: string }>;
  typeIntoField(match: string, text: string): Promise<{ success: boolean; field?: string; error?: string; errorKind?: string }>;
  scrollBy(deltaY: number): Promise<{ success: boolean; error?: string }>;
  listTabs(): Promise<{ success: boolean; tabs?: BrowserTab[]; error?: string }>;
}

export const BROWSER_ACTION_KINDS = [
  'navigate',
  'search_web',
  'find',
  'click',
  'type',
  'press_key',
  'scroll',
  'scroll_until',
  'wait',
  'verify',
  'back',
  'forward',
  'refresh',
] as const;

export type BrowserActionKind = (typeof BROWSER_ACTION_KINDS)[number];

export interface BrowserActionIntent {
  kind: BrowserActionKind;
  description: string;
  params: Record<string, unknown>;
}

export interface BrowserActionRecord {
  intent: BrowserActionIntent;
  status: 'completed' | 'failed' | 'skipped';
  verified?: boolean;
  verificationNote?: string;
  error?: string;
}

export interface BrowserUseResult {
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  goal: string;
  actions: BrowserActionRecord[];
  finalUrl?: string;
  finalTitle?: string;
  observations: number;
  summary: string;
}
