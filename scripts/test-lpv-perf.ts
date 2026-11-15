/**
 * LPV performance measurement suite — prints concrete timings as evidence
 * and asserts loose sanity bounds (no tight perf gates).
 *
 * Run: npx tsx scripts/test-lpv-perf.ts
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

const now = (): number => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, sub-ms resolution

// Environment BEFORE module import.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krisha-lpv-perf-'));
const fsRoots = path.join(tmp, 'fsroots');
const storeDir = path.join(tmp, 'e5store');
fs.mkdirSync(fsRoots, { recursive: true });
process.env.KRISHA_FS_ROOTS = fsRoots;
process.env.KRISHA_SANDBOX_DIR = storeDir;

const lpv = await import('../lpvCore');

const SYN_USER = 'perf-user@example.test';
const SYN_PASS = 'P3rf-Synth!Pass-42';

const timings: Record<string, number> = {};

// ===========================================================================
section('Vault initialization (DPAPI key generation + wrap + persist)');
// ===========================================================================
{
  const t0 = now();
  await lpv.initializeVault();
  timings.init = now() - t0;
  console.log(`  init: ${timings.init.toFixed(1)} ms`);
  assert(timings.init < 15_000, `init completes (${timings.init.toFixed(0)} ms < 15 s bound)`);
}

// ===========================================================================
section('Unlock — cold (PowerShell worker spawn + DPAPI unwrap) vs warm');
// ===========================================================================
{
  const t0 = now();
  await lpv.unlockVault();
  timings.unlockCold = now() - t0;
  console.log(`  unlock (cold): ${timings.unlockCold.toFixed(1)} ms`);
  assert(timings.unlockCold < 20_000, `cold unlock within bound (${timings.unlockCold.toFixed(0)} ms < 20 s)`);

  lpv.lockVault('perf');
  const t1 = now();
  await lpv.unlockVault();
  timings.unlockWarm = now() - t1;
  console.log(`  unlock (warm): ${timings.unlockWarm.toFixed(1)} ms`);
  assert(timings.unlockWarm < 2_500, `warm unlock within bound (${timings.unlockWarm.toFixed(0)} ms < 2.5 s)`);

  // Perf runs use policy-auto saves — enable Category B for roblox.
  lpv.setPolicy({ autoSaveEnabled: true, autoSaveCategories: { roblox: true } }, 'perf');

  // Three more warm cycles for a stable average.
  const cycles: number[] = [];
  for (let i = 0; i < 3; i++) {
    lpv.lockVault('perf');
    const t = now();
    await lpv.unlockVault();
    cycles.push(now() - t);
  }
  const avg = cycles.reduce((a, b) => a + b, 0) / cycles.length;
  console.log(`  unlock (warm avg of 3): ${avg.toFixed(1)} ms`);
  assert(avg < 2_500, `warm unlock average within bound (${avg.toFixed(0)} ms)`);
}

// ===========================================================================
section('Save / update / list latency (encrypt + HMAC + durable persist)');
// ===========================================================================
{
  const saveTimes: number[] = [];
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    const t = now();
    const e = lpv.addEntry(
      { categoryKey: 'roblox', title: `Perf Entry ${i}`, username: SYN_USER, password: SYN_PASS, url: i % 5 === 0 ? 'https://perf.example.test/x' : undefined },
      { kind: 'policy-auto' },
      'perf'
    );
    saveTimes.push(now() - t);
    ids.push(e.entry.id);
  }
  const saveAvg = saveTimes.reduce((a, b) => a + b, 0) / saveTimes.length;
  const saveP95 = saveTimes.slice().sort((a, b) => a - b)[Math.floor(saveTimes.length * 0.95)];
  console.log(`  save: avg ${saveAvg.toFixed(2)} ms · p95 ${saveP95.toFixed(2)} ms (n=25, incl. AES-GCM + HMAC + fsync persist)`);
  assert(saveAvg < 100, `save avg within bound (${saveAvg.toFixed(1)} ms < 100 ms)`);

  const updateTimes: number[] = [];
  for (const id of ids) {
    const t = now();
    lpv.updateEntry(id, { title: `Perf Entry (updated)` }, { kind: 'user-direct' }, 'perf');
    updateTimes.push(now() - t);
  }
  const updAvg = updateTimes.reduce((a, b) => a + b, 0) / updateTimes.length;
  console.log(`  update (decrypt + re-encrypt + persist): avg ${updAvg.toFixed(2)} ms`);
  assert(updAvg < 150, `update avg within bound (${updAvg.toFixed(1)} ms < 150 ms)`);

  const t1 = now();
  lpv.listEntries();
  const listMs = now() - t1;
  console.log(`  listEntries (metadata): ${listMs.toFixed(2)} ms`);
  assert(listMs < 50, `list within bound (${listMs.toFixed(1)} ms < 50 ms)`);
}

// ===========================================================================
section('Memory footprint (entries + crypto overhead)');
// ===========================================================================
{
  global.gc?.();
  const before = process.memoryUsage();
  for (let i = 0; i < 25; i++) {
    lpv.addEntry({ categoryKey: 'roblox', title: `Perf Mem ${i}`, username: SYN_USER, password: SYN_PASS }, { kind: 'policy-auto' }, 'perf');
  }
  const after = process.memoryUsage();
  const heapDeltaKb = (after.heapUsed - before.heapUsed) / 1024;
  console.log(`  heap growth for 25 entries: ${heapDeltaKb.toFixed(1)} KB`);
  console.log(`  total entries: ${lpv.getVaultStatus().entryCount}`);
  assert(lpv.getVaultStatus().entryCount === 50, 'vault holds all 50 entries');
  assert(heapDeltaKb < 4096, `heap growth bounded (${heapDeltaKb.toFixed(0)} KB < 4 MB)`);
}

// ===========================================================================
section('Auto-lock evaluation overhead (deterministic, injectable clock)');
// ===========================================================================
{
  const t0 = now();
  for (let i = 0; i < 1000; i++) lpv._lpvTestHooks.evaluateAutoLock();
  const per = (now() - t0) / 1000;
  console.log(`  evaluateAutoLock: ${per.toFixed(4)} ms per evaluation (1000 runs)`);
  assert(per < 1, `auto-lock evaluation negligible (${per.toFixed(3)} ms < 1 ms)`);
}

// ===========================================================================
section('Lock hygiene (zeroing cost)');
// ===========================================================================
{
  const t0 = now();
  lpv.lockVault('perf-end');
  timings.lock = now() - t0;
  console.log(`  lock (zero keys + persist state): ${timings.lock.toFixed(2)} ms`);
  assert(lpv._lpvTestHooks.noKeyMaterialResident(), 'no key material resident after lock');
}

console.log(`\n-- measured summary --`);
for (const [k, v] of Object.entries(timings)) console.log(`  ${k}: ${v.toFixed(1)} ms`);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
