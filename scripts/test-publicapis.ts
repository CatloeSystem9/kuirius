/**
 * Public-APIs catalog integration tests (Phase 20 capability layer).
 * Usage: npx tsx scripts/test-publicapis.ts
 * Deterministic: metadata-only checks over the supplied catalog — no network,
 * no credentials, no timers.
 */
import { AgentEventBus } from '../src/agent/events';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { PermissionManager } from '../src/agent/permissions';
import { CapabilityCatalog } from '../src/agent/capabilities/capabilityCatalog';
import { PublicApisCatalogSource, PUBLIC_APIS_SOURCE_ID } from '../src/agent/capabilities/publicApisSource';
import { SpecialistCatalogSource, SPECIALIST_SOURCE_ID } from '../src/agent/capabilities/specialistSource';
import { createCapabilityTools } from '../src/agent/capabilities/capabilityTools';
import { PUBLIC_APIS_CATALOG, CATEGORY_COUNT, TOTAL_ENTRY_COUNT } from '../src/agent/capabilities/publicapis/publicApisCatalog';
import type { CapabilityRecord } from '../src/agent/capabilities/capabilityTypes';

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
function assertEqual(actual: unknown, expected: unknown, label: string) {
  assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

console.log('Public-APIs catalog integration\n');

// =================================================================
// 1. Supplied files recognized — catalog data intact
// =================================================================
{
  console.log('1. Supplied catalog files recognized');
  assertEqual(CATEGORY_COUNT, 52, '52 categories from the supplied catalog');
  assertEqual(TOTAL_ENTRY_COUNT, 1841, '1,841 entries from the supplied catalog');
  assertEqual(PUBLIC_APIS_CATALOG.reduce((s, c) => s + c.entries.length, 0), TOTAL_ENTRY_COUNT, 'flatten(CATALOG) matches TOTAL_ENTRY_COUNT');
  const weather = PUBLIC_APIS_CATALOG.find((c) => c.category === 'Weather');
  assert(weather !== undefined && weather.entries.some((e) => e.name === 'WeatherAPI'), 'spot check: Weather category contains WeatherAPI');
}

// =================================================================
// 2. Lazy loading — nothing loads until first use, then exactly once
// =================================================================
{
  console.log('2. Lazy loading');
  const catalog = new CapabilityCatalog([new PublicApisCatalogSource()]);
  assertEqual(Object.keys(catalog.lazyLoadCounts()).length, 0, 'no source loaded at construction (startup stays free)');
  const t0 = Date.now();
  const records = await catalog.ensureLoaded();
  const loadMs = Date.now() - t0;
  assertEqual(records.length, 1841, 'all 1,841 entries loaded as capability records');
  assert(loadMs < 5_000, `one-time load ${loadMs}ms (metadata only)`);
  await catalog.ensureLoaded();
  assertEqual(catalog.lazyLoadCounts()[PUBLIC_APIS_SOURCE_ID], 1, 'source loaded exactly once (cached index)');
}

// =================================================================
// 3. Honest availability — metadata only, credentials marked, nothing executable
// =================================================================
{
  console.log('3. Honest availability + auth mapping');
  const catalog = new CapabilityCatalog([new PublicApisCatalogSource()]);
  const records = await catalog.ensureLoaded();

  // Expected availability split, derived independently from the raw catalog.
  const credAuth = new Set(['apiKey', 'OAuth', 'X-Mashape-Key']);
  let expectCred = 0;
  let expectFree = 0;
  for (const c of PUBLIC_APIS_CATALOG) for (const e of c.entries) (credAuth.has(e.auth) ? expectCred++ : expectFree++);
  const stats = await catalog.stats();
  assertEqual(stats.byAvailability.requires_credentials ?? 0, expectCred, `auth=key/OAuth/X-Mashape → requires_credentials (${expectCred})`);
  assertEqual(stats.byAvailability.discoverable ?? 0, expectFree, `no-secret auth → discoverable (${expectFree})`);
  assertEqual(stats.total, 1841, 'availability split sums to the full catalog');

  // Nothing is executable or advisory-faked: every record states the
  // no-adapter non-claim, and no record claims executable tool surface.
  assert(records.every((r: CapabilityRecord) => r.limitations.some((l) => l.includes('no adapter'))), 'every record states it has no adapter (never faked)');
  assert(records.every((r) => r.availability !== 'advisory'), 'public APIs are not mislabeled as advisory specialists');

  // Credentials are never invented/stored: credential records point at the user.
  const credRecords = records.filter((r) => r.availability === 'requires_credentials');
  assert(credRecords.every((r) => r.limitations.some((l) => l.includes('never invents'))), 'credential records direct the user to supply their own credentials');
  const openWeather = records.find((r) => r.name === 'WeatherAPI');
  assert(openWeather !== undefined && openWeather.availability === 'requires_credentials', 'spot check: WeatherAPI (apiKey) → requires_credentials');

  // No secret material anywhere in the metadata (paranoia check over the supplied data).
  const serialized = JSON.stringify(records).toLowerCase();
  assert(!/\b(sk-[a-z0-9]{8,}|bearer\s+[a-z0-9._-]{10,})/.test(serialized), 'no credential-shaped strings in catalog metadata');
}

// =================================================================
// 4. Record integrity — unique ids, valid structure, real tool families
// =================================================================
{
  console.log('4. Record integrity');
  const catalog = new CapabilityCatalog([new PublicApisCatalogSource()]);
  const records = await catalog.ensureLoaded();
  const ids = new Set(records.map((r) => r.id));
  assertEqual(ids.size, records.length, 'all record ids unique within the source (same-name entries disambiguated)');
  assert(records.every((r) => r.sourceId === PUBLIC_APIS_SOURCE_ID && r.family === 'public-api'), 'all records tagged with the public-apis source/family');
  assert(records.every((r) => r.category.length > 0 && r.description.length > 0), 'every record has category + description');
  assert(records.every((r) => r.tags.length >= 4), 'every record carries category/auth/https/cors tags');
  const knownFamilies = ['web.open_website', 'web.search_website', 'filesystem.read', 'filesystem.open_file'];
  assert(records.every((r) => r.preferredTools.every((t) => knownFamilies.includes(t))), 'preferredTools reference only real ToolRegistry tool names (advisory)');
  assert(records.every((r) => r.limitations.some((l) => l.startsWith('Docs: http'))), 'every record carries its documentation link');
}

// =================================================================
// 5. Discovery through the catalog — search, filters, bounded
// =================================================================
{
  console.log('5. Discovery');
  const catalog = new CapabilityCatalog([new PublicApisCatalogSource()]);
  const weatherHits = await catalog.search('weather');
  assert(weatherHits.length > 0 && weatherHits.every((h) => h.record.category === 'Weather'), 'weather query returns Weather-category APIs (deterministic rank)');

  const credOnly = await catalog.search('weather', { availability: 'requires_credentials' });
  assert(credOnly.length > 0 && credOnly.every((h) => h.record.availability === 'requires_credentials'), 'availability filter works (requires_credentials)');

  const capped = await catalog.search('weather', { maxResults: 3 });
  assert(capped.length <= 3, 'maxResults bounded');

  const byCat = await catalog.byCategory('Weather', 10);
  assert(byCat.length === 10, 'byCategory bounded listing works');
}

// =================================================================
// 6. Multi-source catalog — specialists + public-apis coexist
// =================================================================
{
  console.log('6. Multi-source catalog');
  const catalog = new CapabilityCatalog([new SpecialistCatalogSource(), new PublicApisCatalogSource()]);
  const stats = await catalog.stats();
  assertEqual(stats.total, 1941, '1,941 total records (100 specialists + 1,841 public APIs)');
  assertEqual(stats.sources.length, 2, 'two sources registered');
  const weatherHits = await catalog.search('current weather data');
  assert(weatherHits.length > 0, 'cross-source search works');
  assert(catalog.lazyLoadCounts()[SPECIALIST_SOURCE_ID] === 1 && catalog.lazyLoadCounts()[PUBLIC_APIS_SOURCE_ID] === 1, 'each source lazily loaded exactly once');

  // A broken public source would degrade honestly, never break the catalog.
  const broken = new CapabilityCatalog([
    new SpecialistCatalogSource(),
    { sourceId: 'public-apis', family: 'public-api', description: 'broken', load: () => Promise.reject(new Error('test failure')) },
  ]);
  const brokenStats = await broken.stats();
  assertEqual(brokenStats.total, 101, 'broken source degrades to one unavailable record — catalog still works');
}

// =================================================================
// 7. Through the existing gated capability tools — end to end
// =================================================================
{
  console.log('7. capability.search / capability.stats through the gated registry');
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const catalog = new CapabilityCatalog([new PublicApisCatalogSource()]);
  registry.registerAll(createCapabilityTools(catalog));
  const ctx = { taskId: 't-pubapi', stepId: 's', signal: new AbortController().signal, memory: {}, permissions };

  const search = await registry.execute('capability.search', { query: 'cryptocurrency exchange prices' }, ctx);
  assert(search.success, 'capability.search executes through the gated registry');
  const results = (search.output as { results: { name: string; availability: string; preferredTools: string[] }[] }).results;
  assert(results.length > 0 && results.some((r) => r.availability === 'requires_credentials'), 'crypto APIs discovered and honestly labeled requires_credentials');
  assert(results.every((r) => !('execute' in r) && !('endpoint' in r)), 'results carry no execution surface / no invented endpoints');

  const capabilityStats = await registry.execute('capability.stats', {}, ctx);
  assert(capabilityStats.success && (capabilityStats.output as { total: number }).total === 1841, 'capability.stats reports the public-apis catalog');
  assert((capabilityStats.output as { lazyLoadCounts: Record<string, number> }).lazyLoadCounts[PUBLIC_APIS_SOURCE_ID] === 1, 'lazy load count stays 1 through tool use');

  const bad = await registry.execute('capability.search', {}, ctx);
  assert(!bad.success && bad.errorKind === 'invalid_input', 'missing query → invalid_input (fail closed unchanged)');
}

console.log(`\n✓ Public-APIs integration: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
