/**
 * Phase 8 verification suite — Browser Agent under Node with a fake CDP backend.
 * Usage: npx tsx scripts/test-browser-phase8.ts
 */
import { BrowserAgent } from '../src/agent/browser/browserAgent';
import { createBrowserTools } from '../src/agent/browser/browserTools';
import { buildBrowserIntents, isBrowserUseRequest, isBrowserActionClause } from '../src/agent/browser/browserDecider';
import { classifyStep, isBrowserUseRequest as plannerIsBrowserUseRequest, HeuristicPlanner, extractGoal } from '../src/agent/planner';
import type { BrowserBackend, BrowserPageState } from '../src/agent/browser/browserTypes';
import { PermissionManager } from '../src/agent/permissions';
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { AgentCore } from '../src/agent/agentCore';
import { TaskStore, MemoryStorage } from '../src/agent/taskState';
import { maskSensitiveText } from '../src/agent/computer/keyboardTypes';
import { ok } from '../src/agent/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/** Deterministic fake CDP backend with a mutable page + history. */
class FakeBrowserBackend implements BrowserBackend {
  page: BrowserPageState = {
    url: 'https://example.com/',
    title: 'Example Domain',
    ready: 'complete',
    links: [{ text: 'More information', href: 'https://www.iana.org/domains/example' }],
    buttons: [{ text: 'Accept' }],
    fields: [{ tag: 'input', type: 'text', placeholder: 'Search the site', name: 'q', id: 'search' }],
    headings: ['Example Domain'],
  };
  history: string[] = ['https://example.com/'];
  historyIndex = 0;
  getStateCalls = 0;
  failClickNext = false;
  clickCount = 0;
  navigationLatencyMs = 0;

  async getState() {
    this.getStateCalls++;
    return { success: true, state: { ...this.page, links: [...this.page.links], buttons: [...this.page.buttons], fields: [...this.page.fields], headings: [...this.page.headings] }, tabs: [{ id: 't1', title: this.page.title, url: this.page.url }] };
  }

  async navigate(url: string) {
    if (this.navigationLatencyMs) await new Promise((r) => setTimeout(r, this.navigationLatencyMs));
    if (url.startsWith('https://fail.')) return { success: false, error: 'name resolution failed' };
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(url);
    this.historyIndex++;
    const host = new URL(url).hostname;
    this.page = {
      ...this.page,
      url,
      title: host === 'www.iana.org' ? 'IANA-managed Reserved Domains' : `Page at ${host}`,
      headings: [host === 'www.iana.org' ? 'IANA Managed Domains' : `Content of ${host}`],
      links: host === 'www.iana.org' ? [{ text: 'Back to example', href: 'https://example.com/' }] : this.page.links,
    };
    return { success: true, url, title: this.page.title };
  }

  private jump(delta: number) {
    const next = this.historyIndex + delta;
    if (next < 0 || next >= this.history.length) return { success: false, error: 'no history entry' };
    this.historyIndex = next;
    const url = this.history[this.historyIndex];
    this.page = { ...this.page, url, title: url.includes('iana') ? 'IANA-managed Reserved Domains' : 'Example Domain' };
    return { success: true, url };
  }

  async goBack() {
    return this.jump(-1);
  }
  async goForward() {
    return this.jump(1);
  }
  async refresh() {
    return { success: true, url: this.page.url };
  }

  async clickText(text: string) {
    if (this.failClickNext) {
      this.failClickNext = false;
      return { success: false, errorKind: 'not_found', error: 'No visible link/button matching the query' };
    }
    const link = this.page.links.find((l) => l.text.toLowerCase().includes(text.toLowerCase()));
    if (!link) return { success: false, errorKind: 'not_found', error: 'No match' };
    this.clickCount++;
    await this.navigate(link.href);
    return { success: true, clicked: link.text, href: link.href, url: this.page.url, title: this.page.title };
  }

  async typeIntoField(match: string, text: string) {
    const field = this.page.fields.find((f) => `${f.placeholder} ${f.name} ${f.id}`.toLowerCase().includes(match.toLowerCase()));
    if (!field) return { success: false, errorKind: 'not_found', error: 'No field match' };
    return { success: true, field: field.name || field.placeholder };
  }

  async scrollBy() {
    return { success: true };
  }
  async listTabs() {
    return { success: true, tabs: [{ id: 't1', title: this.page.title, url: this.page.url }] };
  }
}

function makeHarness() {
  const backend = new FakeBrowserBackend();
  const events = new AgentEventBus();
  const permissions = new PermissionManager();
  permissions.grant('browser.interaction');
  const agent = new BrowserAgent({ backend, events, stateStaleMs: 0 });
  const registry = new ToolRegistry();
  registry.registerAll(createBrowserTools(agent));
  return { backend, events, permissions, agent, registry };
}

// ---------------------------------------------------------------- architecture
{
  console.log('Architecture: registration, contract, permissions');
  const { registry, permissions, backend } = makeHarness();

  const use = registry.describe('browser.use')!;
  assertEqual(use.permissions, ['browser.interaction'], 'browser.use permission declared');
  assertEqual(use.retryPolicy?.maxAttempts, 1, 'browser.use runs once per step');
  assertEqual(use.verification?.strategy, 'state_check', 'page-state verification strategy');
  assertEqual(registry.findByCategory('web').length >= 11, true, 'browser tools registered under web category');
  assertEqual(registry.findByCapability('browser.find').length, 1, 'find capability discoverable');
  assert(backend.getStateCalls === 0, 'no state reads at registration');

  // Permission denial through the registry (browser.interaction is default-granted → revoke).
  const h2 = makeHarness();
  const pm = new PermissionManager();
  pm.revoke('browser.interaction');
  const denied = await h2.registry.execute('browser.navigate', { url: 'https://example.com' }, {
    taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {}, permissions: pm,
  });
  assertEqual(denied.errorKind, 'permission_denied' as const, 'permission_denied classification');
  assertEqual(denied.retryable, false, 'permission failures not retryable');
  void permissions;
}

// ---------------------------------------------------------------- planning
{
  console.log('Planning: browser intent classification and routing');
  assertEqual(classifyStep('find the docs link on this page')?.toolName, 'browser.find', 'find-on-page intent');
  assertEqual(classifyStep('click the More information link on this page')?.toolName, 'browser.click', 'click-on-page intent');
  assertEqual(classifyStep('scroll until the pricing table is visible')?.toolName, 'browser.scroll_until', 'scroll-until intent');
  assertEqual(classifyStep('type "hello" into the search box on this page')?.toolName, 'browser.type', 'type-into-field-on-page intent');
  assertEqual(classifyStep('wait until the page shows Dashboard')?.toolName, 'browser.wait', 'wait intent');
  assertEqual(classifyStep('click the save button')?.toolName, 'computer.click', 'plain click NOT hijacked by browser layer');
  assert(isBrowserActionClause('find the docs link on this page'), 'browser clause recognized');
  assertEqual(isBrowserUseRequest('open https://example.com then find the More information link on this page then click the More information link on this page'), true, 'compound browser task detected');
  assertEqual(plannerIsBrowserUseRequest('open youtube then search lofi'), false, 'pure open/search stays on static web tools');

  const planner = new HeuristicPlanner();
  const plan = planner.makePlan(extractGoal('open https://example.com then find the More information link on this page then click the More information link on this page then tell me the result'));
  assertEqual(plan.steps.map((s) => s.toolName), ['browser.use', 'chat.report'], 'compound browser task routed to browser.use');
}

// ---------------------------------------------------------------- navigation
{
  console.log('Navigation: validation, verification, history');
  const { agent, backend } = makeHarness();

  // URL validation.
  let err: any;
  try { await agent.navigate('javascript:alert(1)'); } catch (e) { err = e; }
  assertEqual(err?.kind, 'invalid_coordinates', 'javascript: scheme rejected');
  try { await agent.navigate('file:///C:/Windows'); } catch (e) { err = e; }
  assertEqual(err?.kind, 'invalid_coordinates', 'file: scheme rejected');
  // Search-style input is coerced to a search URL, not rejected.
  const search = await agent.navigate('not a url at all');
  assert(String(search.url).includes('duckduckgo.com'), 'search-style input coerced to a search URL');

  const nav = await agent.navigate('https://example.com', {}, undefined);
  assertEqual(nav.verified, true, 'navigation verified by hostname evidence');
  assert(backend.getStateCalls >= 2, 'post-navigation state read');

  const failed = await agent.navigate('https://fail.example.com').catch((e) => e);
  assertEqual(failed.kind, 'backend_failed', 'navigation failure classified honestly');

  const withTitle = await agent.navigate('https://www.iana.org/domains/example', { expectTitle: 'IANA' });
  assertEqual(withTitle.verified, true, 'expected-title verification passes');

  // Expectation mismatch: page loaded fine, but verification honestly fails.
  const wrongTitle = await agent.navigate('https://www.iana.org/domains/example', { expectTitle: 'Nonexistent' });
  assertEqual(wrongTitle.verified, false, 'expected-title mismatch reports unverified');
  assert(wrongTitle.verificationNote.includes('does not contain'), 'mismatch note explains the evidence');

  // History flows on a dedicated harness (no search-coercion noise).
  const h2 = makeHarness();
  await h2.agent.navigate('https://www.iana.org/domains/example');
  const back = await h2.agent.goBack();
  assert(String(back.url).includes('example.com'), 'back navigation works');
  const forward = await h2.agent.goForward();
  assert(String(forward.url).includes('iana'), 'forward navigation works');
  const refresh = await h2.agent.refresh();
  assert(String(refresh.url).includes('iana'), 'refresh keeps the page');
}

// ---------------------------------------------------------------- page state + find
{
  console.log('Page state + find');
  const { agent, backend } = makeHarness();
  const state = await agent.getState(undefined, true);
  assertEqual(state.available, true, 'state available from backend');
  assertEqual(state.page?.title, 'Example Domain', 'title tracked');
  assertEqual(state.page?.ready, 'complete' as const, 'loading state tracked');
  assertEqual(state.tabs.length, 1, 'tabs tracked');

  const before = backend.getStateCalls;
  await agent.getState(); // within stale window (0ms → always fresh actually)
  void before;

  const { matches, count } = await agent.find('more information');
  assert(count >= 1, 'find locates the link');
  assert(matches.some((m) => m.startsWith('link')), 'match describes the link type');
  const none = await agent.find('zzz-nonexistent');
  assertEqual(none.count, 0, 'no false matches');
}

// ---------------------------------------------------------------- interaction
{
  console.log('Interaction: click with verification, type with masking, scroll');
  const { agent, backend } = makeHarness();

  const click = await agent.click('More information', { expectUrlContains: 'iana' });
  assertEqual(click.verified, true, 'click verified via expected URL');
  assert(String(click.url).includes('iana'), 'page actually navigated');
  assertEqual(backend.clickCount, 1, 'click dispatched once');

  const type = await agent.type('test query', 'search');
  assertEqual(type.verified, true, 'type confirmed by the browser');
  assert(type.summary.includes('test query'), 'non-sensitive text visible in summary');

  const sensitive = await agent.type('my password is hunter2secret', 'search');
  assert(!sensitive.summary.includes('hunter2secret'), 'sensitive text masked');
  assert(sensitive.summary.includes('[sensitive input masked]'), 'masking marker present');
  assertEqual(maskSensitiveText('token abc123def456ghi789').sensitive, true, 'token pattern detected');

  const scroll = await agent.scroll('down', 3);
  assertEqual(scroll.verified, true, 'scroll executed in controlled browser');

  const scrolled = await agent.scrollUntil('IANA', { maxSteps: 3 });
  assertEqual(scrolled.found, true, 'scroll-until finds the heading');
}

// ---------------------------------------------------------------- dynamic pages
{
  console.log('Dynamic pages: delayed target, disappearance, wait');
  const { agent, backend } = makeHarness();

  // Delayed target: page gains a heading after the first state read.
  let reads = 0;
  const origGetState = backend.getState.bind(backend);
  backend.getState = async () => {
    const r = await origGetState();
    reads++;
    if (reads >= 2) backend.page = { ...backend.page, headings: ['Example Domain', 'Dashboard Loaded'] };
    return r;
  };
  const wait = await agent.waitFor({ textContains: 'Dashboard' }, { timeoutMs: 5000 });
  assertEqual(wait.satisfied, true, 'delayed content detected by bounded wait');
  assert(wait.observations >= 2, `wait polled adaptively (${wait.observations} reads)`);

  // Wait timeout: expectation never appears.
  const never = await agent.waitFor({ textContains: 'Never Appears' }, { timeoutMs: 900 });
  assertEqual(never.satisfied, false, 'wait times out honestly');

  // Target disappearance: click fails not_found → run stops safely.
  const h2 = makeHarness();
  h2.backend.failClickNext = true;
  const result = await h2.agent.run('goal', buildBrowserIntents('open https://example.com then click the Missing link on this page'));
  assertEqual(result.status, 'failed' as const, 'missing target fails the run honestly');
  assertEqual(result.actions[1].status, 'failed' as const, 'click action failed');
  assertEqual(result.actions.length, 2, 'no extra actions beyond the two intents');
}

// ---------------------------------------------------------------- browser.use loop
{
  console.log('browser.use orchestrator loop');
  const { agent, events } = makeHarness();
  const names: string[] = [];
  for (const n of ['BROWSER_ACTION_PLANNED', 'BROWSER_ACTION_COMPLETED', 'BROWSER_TASK_COMPLETED', 'BROWSER_NAVIGATED'] as const) {
    events.on(n, () => names.push(n));
  }
  const result = await agent.run(
    'goal',
    buildBrowserIntents('open https://example.com then click the More information link on this page then go back on this page'),
    undefined
  );
  assertEqual(result.status, 'completed' as const, 'multi-action browser task completed');
  assertEqual(result.actions.map((a) => a.intent.kind), ['navigate', 'click', 'back'], 'ordered browser actions');
  assert(result.summary.includes('Browser task completed'), 'honest completion header');
  for (const expected of ['BROWSER_ACTION_PLANNED', 'BROWSER_ACTION_COMPLETED', 'BROWSER_TASK_COMPLETED']) {
    assert(names.includes(expected), `event emitted: ${expected}`);
  }
}

// ---------------------------------------------------------------- agent core integration
{
  console.log('Agent Core integration');
  const { registry, permissions, backend } = makeHarness();
  registry.register({ name: 'chat.report', description: '', category: 'communication', riskLevel: 'low' as const, execute: async () => ok() });
  const core = new AgentCore({ registry, events: new AgentEventBus(), store: new TaskStore(new MemoryStorage()), permissions });
  const task = await core.submit('open https://example.com then click the More information link on this page then tell me the result');
  assertEqual(task.status, 'completed' as const, 'browser task completes through the Agent Core');
  assertEqual(task.plan!.steps[0].result!.toolId, 'browser.use', 'routed via browser.use capability');
  assert(task.summary!.includes('Browser task completed'), 'core report carries the browser summary');
  const cuOutput = task.plan!.steps[0].result!.output as any;
  assert(String(cuOutput.finalUrl).includes('iana'), 'final URL evidence recorded');
  void backend;
}

// ---------------------------------------------------------------- cancellation
{
  console.log('Cancellation');
  const { agent } = makeHarness();
  const controller = new AbortController();
  controller.abort();
  let err: any;
  try {
    await agent.getState(controller.signal, true);
  } catch (e) {
    err = e;
  }
  assertEqual(err?.kind, 'cancelled', 'pre-aborted state read cancelled');

  const controller2 = new AbortController();
  controller2.abort();
  const result = await agent.run('goal', buildBrowserIntents('open https://example.com then click the More information link on this page'), controller2.signal);
  assertEqual(result.status, 'cancelled' as const, 'cancelled browser run');
  assert(result.actions.every((a) => a.status === 'skipped'), 'all actions skipped');
}

// ---------------------------------------------------------------- performance
{
  console.log('Performance: bounded observation');
  const { agent, backend } = makeHarness();
  backend.page = { ...backend.page, links: Array.from({ length: 100 }, (_, i) => ({ text: `link ${i}`, href: `https://example.com/${i}` })) };
  const state = await agent.getState(undefined, true);
  assert(state.page!.links.length <= 25, `links bounded in state (${state.page!.links.length})`);
  const before = backend.getStateCalls;
  await agent.find('link 1');
  assert(backend.getStateCalls - before <= 2, `find reads state once (${backend.getStateCalls - before})`);
}

// ---------------------------------------------------------------- summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('PHASE 8 TESTS: ALL GREEN');
