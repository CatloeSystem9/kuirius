/**
 * Real-browser verification (Phase 8) — harmless, non-intrusive.
 *
 * Uses the Krisha-controlled HEADLESS browser (own throwaway profile) so the
 * user's desktop, focus, and real browser profile are never touched:
 *   1. identify the controlled browser (CDP up)
 *   2. open https://example.com and verify by title
 *   3. observe the page (state model)
 *   4. find + click the visible "More information" link
 *   5. verify the navigation (URL now on iana.org)
 *   6. navigate back and verify the return
 */
import { BrowserAgent } from '../src/agent/browser/browserAgent';
import { HttpBrowserBackend, setBrowserBackendBaseUrl } from '../src/agent/browser/httpBrowser';
import { AgentEventBus } from '../src/agent/events';

const BASE = 'http://localhost:3000';
setBrowserBackendBaseUrl(BASE);

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become healthy');
}

async function main() {
  await waitForHealth();
  console.log('server healthy');

  const events = new AgentEventBus();
  events.on('BROWSER_NAVIGATED', () => console.log('  navigated'));
  events.on('BROWSER_ACTION_VERIFIED', (e) => console.log('  verified:', (e.payload as any)?.note));
  const agent = new BrowserAgent({ backend: new HttpBrowserBackend(), events, stateStaleMs: 0 });

  // 2. Open the harmless page and verify by title.
  const nav = await agent.navigate('https://example.com', { expectTitle: 'Example' });
  console.log('navigated:', nav.url, '—', nav.verificationNote);
  if (!nav.verified) throw new Error('example.com navigation not verified');

  // 3. Observe the page state.
  const state = await agent.getState(undefined, true);
  if (!state.available || !state.page) throw new Error('page state unavailable');
  console.log('observed:', state.page.url, '|', state.page.title, '|', state.page.links.length, 'link(s)');

  // 4-5. Find the outgoing link by its href, click it by its VISIBLE text
  //      (discovered from the observation — never hard-coded), verify.
  const outgoing = state.page.links.find((l) => l.href.includes('iana.org'));
  if (!outgoing) throw new Error('no outgoing link found on example.com');
  console.log('target link:', outgoing.text, '→', outgoing.href);
  const click = await agent.click(outgoing.text, { expectUrlContains: 'iana' });
  console.log('clicked:', click.matched, '→', click.url, '—', click.verificationNote);
  if (!click.verified) throw new Error('link click not verified');

  // 6. Navigate back and verify the return.
  const back = await agent.goBack();
  if (!String(back.url).includes('example.com')) throw new Error('back navigation did not return to example.com');
  console.log('back to:', back.url);

  console.log('REAL-BROWSER CHECK: PASS (CDP launch, navigate, observe, find, click, verify, back)');
}

main().catch((err) => {
  console.error('REAL-BROWSER CHECK: FAIL —', err.message);
  process.exit(1);
});
