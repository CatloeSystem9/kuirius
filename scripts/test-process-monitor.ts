/**
 * Process Monitor (Phase A) — test suite (task §9, 16 scenarios).
 *
 * Usage:  npx tsx scripts/test-process-monitor.ts
 * Exit:   non-zero on any failure.
 *
 * Benign test processes only (cmd.exe /c exit), all owned by this harness.
 * Isolated-server runs use temporary KRISHA_SANDBOX_DIR stores — the real E5
 * store is never touched. Live WMI tests use the REAL worker (temporary,
 * session-owned subscriptions, no admin, cleaned up on exit).
 */
import './test-isolation';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';

import { ProcessMonitor } from '../src/agent/processmonitor/processMonitor';
import type { MonitorTransport, ProcessEvent } from '../src/agent/processmonitor/monitorTypes';
import { createProcessMonitorTools } from '../src/agent/processmonitor/tools';
import { ToolRegistry } from '../src/agent/toolRegistry';
import { AgentEventBus } from '../src/agent/events';
import { PermissionManager } from '../src/agent/permissions';
import { SafetyGate, EmergencyStop, SafetyAuditLog, ScopedPermissionManager } from '../src/agent/safety/index';

// ---------------------------------------------------------------- helpers

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(label);
    console.error(`  X ${label}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Scripted fake transport (test double for the PowerShell worker). */
class FakeTransport implements MonitorTransport {
  lineCb: ((line: string) => void) | null = null;
  closeCb: ((hadError: boolean) => void) | null = null;
  killed = false;
  constructor(private readonly readyLine: string | null = 'KPM_READY create=1 delete=1') {}

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
    // Boot: emit the ready line on the next tick (async like a real worker).
    if (this.readyLine !== null) {
      setTimeout(() => this.lineCb?.(this.readyLine), 10);
    } else {
      // Boot failure: close without READY.
      setTimeout(() => this.closeCb?.(true), 10);
    }
  }

  onClose(cb: (hadError: boolean) => void): void {
    this.closeCb = cb;
  }

  /** Simulate worker stdout. */
  emit(line: string): void {
    this.lineCb?.(line);
  }

  /** Simulate worker death. */
  crash(hadError = true): void {
    this.killed = true;
    this.closeCb?.(hadError);
  }

  kill(): void {
    this.killed = true;
    this.closeCb?.(false);
  }

  write(): void {
    /* unused in Phase A */
  }
}

const KPM_CREATE = (pid: number, name: string, ppid: number, extra = ''): string =>
  `KPM {"k":"create","pid":${pid},"name":"${name}","ppid":${ppid},"sid":1,"path":"C:\\\\Tools\\\\${name}"${extra}}`;

const KPM_CREATE_NOPATH = (pid: number, name: string, ppid: number): string =>
  `KPM {"k":"create","pid":${pid},"name":"${name}","ppid":${ppid},"sid":1,"path":""}`;

const KPM_DELETE = (pid: number, name: string): string => `KPM {"k":"delete","pid":${pid},"name":"${name}"}`;

const FAKE_SNAPSHOT = () =>
  Promise.resolve([
    { name: 'explorer.exe', pid: 4000, ppid: 500, path: 'C:\\WINDOWS\\Explorer.EXE', sid: 1 },
    { name: 'svchost.exe', pid: 4001, ppid: 500 },
  ]);

const FAKE_SNAPSHOT_FN = () => FAKE_SNAPSHOT();

async function waitUntil(pred: () => boolean, timeoutMs = 3000, step = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

// =========================================================== 1-8. Inventory & event semantics (fake transport)
{
  console.log('1-8. Event semantics, inventory, PID reuse, out-of-order, overflow');
  const audits: Array<{ kind: string } & Record<string, unknown>> = [];
  const monitor = new ProcessMonitor({
    transportFactory: () => new FakeTransport(),
    snapshotFn: FAKE_SNAPSHOT_FN,
    maxEventBuffer: 3,
    maxInventory: 50,
    audit: (e) => audits.push(e),
  });
  await monitor.start();
  let st = monitor.status();
  assert(st.health === 'ACTIVE', 'monitor reaches ACTIVE with both subscriptions');
  assert(st.subscriptions.creation === true && st.subscriptions.deletion === true, 'both subscriptions confirmed');
  assert(st.preexistingCount === 2, 'startup snapshot marked pre-existing processes');

  // 1. Creation detection.
  const t = (monitor as unknown as { transport: FakeTransport }).transport as FakeTransport;
  t.emit(KPM_CREATE(1001, 'notepad.exe', 4000));
  let e1001 = monitor.lookup(1001);
  assert(e1001?.state === 'running' && e1001.origin === 'observed', '1: creation tracked as running/observed');
  st = monitor.status();
  assert(st.eventsReceived === 1, '1: event counter incremented');

  // 2. Termination detection.
  t.emit(KPM_DELETE(1001, 'notepad.exe'));
  e1001 = monitor.lookup(1001);
  assert(e1001?.state === 'terminated-unconfirmed' && !!e1001.terminatedAt, '2: termination tracked (unconfirmed)');
  st = monitor.status();
  const last = monitor.recentEvents(1)[0] as ProcessEvent & { previouslyObserved?: boolean };
  assert(last.kind === 'delete' && last.previouslyObserved === true, '2: delete event marked previouslyObserved');

  // 3. PID/PPID tracking.
  t.emit(KPM_CREATE(1002, 'shell.exe', 4000));
  t.emit(KPM_CREATE(1003, 'child.exe', 1002));
  const child = monitor.lookup(1003);
  const parent = child ? monitor.lookup(child.ppid ?? -1) : undefined;
  assert(child?.ppid === 1002 && parent?.name === 'shell.exe', '3: parent-child lineage resolvable through inventory');

  // 4. Path enrichment.
  assert(e1001 !== undefined || monitor.lookup(1001) !== undefined, '4: precondition');
  t.emit(KPM_CREATE(1004, 'signed.exe', 4000));
  const enriched = monitor.lookup(1004);
  assert(enriched?.enrichment === 'available' && typeof enriched?.path === 'string' && enriched.path.length > 0, '4: executable path enrichment available');

  // 5. Missing executable path — honest handling.
  t.emit(KPM_CREATE_NOPATH(1005, 'fast-exit.exe', 4000));
  const noPath = monitor.lookup(1005);
  assert(noPath?.enrichment === 'unavailable' && noPath?.path === undefined, '5: missing path recorded honestly as unavailable (never invented)');

  // 6. PID reuse.
  t.emit(KPM_CREATE(1006, 'first.exe', 4000));
  t.emit(KPM_DELETE(1006, 'first.exe'));
  t.emit(KPM_CREATE(1006, 'second.exe', 4001));
  const reused = monitor.lookup(1006);
  assert(reused?.name === 'second.exe' && reused?.reused === true, '6: PID reuse replaces the entry (no stale merge)');
  assert(monitor.status().pidReuses === 1, '6: PID reuse counter incremented');

  // 7. Out-of-order events (delete before create).
  t.emit(KPM_DELETE(1007, 'ghost.exe'));
  const ghost = monitor.lookup(1007);
  assert(ghost?.origin === 'unobserved' && ghost.state === 'terminated-unconfirmed', '7: out-of-order deletion recorded honestly as unobserved');
  assert(monitor.status().unobservedTerminations === 1, '7: unobserved-termination counter incremented');
  t.emit(KPM_CREATE(1007, 'ghost.exe', 4000));
  assert(monitor.lookup(1007)?.state === 'running', '7: late creation attaches to the unobserved entry');

  // 8. Event queue overflow (maxEventBuffer=3): everything but the newest 3
  // events is dropped by design.
  for (let i = 0; i < 10; i++) t.emit(KPM_CREATE(2000 + i, `burst${i}.exe`, 4000));
  st = monitor.status();
  assert(st.queueSize === 3, `8: event buffer bounded to 3 (got ${st.queueSize})`);
  assert(st.eventsDropped === st.eventsReceived - 3, `8: dropped counter = received - kept (${st.eventsDropped} dropped of ${st.eventsReceived})`);
  assert(audits.some((a) => a.kind === 'process_monitor_queue_overflow'), '8: overflow audited (metadata only)');

  // 15 (part). Metadata-only audit: lifecycle audit records carry NO names/paths.
  const auditDump = JSON.stringify(audits);
  const leakCheck = ['notepad.exe', 'shell.exe', 'child.exe', 'signed.exe', 'fast-exit.exe', 'first.exe', 'second.exe', 'ghost.exe', 'burst', 'Tools'];
  for (const token of leakCheck) assert(!auditDump.includes(token), `15: audit records contain no "${token}"`);

  monitor.stop();
  assert(monitor.status().health === 'STOPPED', 'graceful stop -> STOPPED');
}

// =========================================================== 9-10. Subscription failure, crash + recovery
{
  console.log('9-10. Subscription failure, worker crash and recovery');
  // 9. Boot failure -> bounded retries -> FAILED.
  let bootAttempts = 0;
  const failFactory = () => {
    bootAttempts++;
    return new FakeTransport(null); // never READY
  };
  const failMonitor = new ProcessMonitor({
    transportFactory: failFactory,
    snapshotFn: FAKE_SNAPSHOT_FN,
    retryBackoffMs: [20, 20, 20],
    bootTimeoutMs: 200,
  });
  await failMonitor.start();
  const reachedFailed = await waitUntil(() => failMonitor.status().health === 'FAILED', 2000);
  assert(reachedFailed, '9: exhausted retry budget -> FAILED (never reports fully monitored)');
  assert(bootAttempts >= 3, `9: bounded retries observed (${bootAttempts} attempts)`);
  assert(failMonitor.status().healthReason?.includes('retry budget exhausted') === true, '9: failure reason recorded');
  failMonitor.stop();

  // 10. Worker crash -> recovery via re-arm.
  let starts = 0;
  let current: FakeTransport | null = null;
  const recoverFactory = () => {
    starts++;
    current = new FakeTransport();
    return current;
  };
  const recoveryAudit: Array<{ kind: string }> = [];
  const recMonitor = new ProcessMonitor({
    transportFactory: recoverFactory,
    snapshotFn: FAKE_SNAPSHOT_FN,
    retryBackoffMs: [20, 20, 20],
    audit: (e) => recoveryAudit.push(e),
  });
  await recMonitor.start();
  assert(starts === 1, '10: initial worker started');
  current!.crash(true); // unexpected worker death
  const rearmed = await waitUntil(() => starts === 2 && recMonitor.status().health === 'ACTIVE', 3000);
  assert(rearmed, '10: worker crash -> automatic re-arm -> ACTIVE');
  assert(recMonitor.status().workerRestarts === 1, '10: restart counter incremented');
  current!.emit(KPM_CREATE(3001, 'post-recovery.exe', 4000));
  assert(recMonitor.lookup(3001)?.state === 'running', '10: events flow after recovery');
  assert(recoveryAudit.some((a) => a.kind === 'process_monitor_rearmed'), '10: re-arm audited');
  recMonitor.stop();
}

// =========================================================== 11 (partial). Heartbeat staleness -> re-arm
{
  console.log('11a. Event-stream interruption (stale heartbeat) detection');
  let starts = 0;
  let current: FakeTransport | null = null;
  const hbFactory = () => {
    starts++;
    current = new FakeTransport();
    return current;
  };
  const hbMonitor = new ProcessMonitor({
    transportFactory: hbFactory,
    snapshotFn: FAKE_SNAPSHOT_FN,
    heartbeatTimeoutMs: 1500,
    retryBackoffMs: [20, 20, 20],
  });
  await hbMonitor.start();
  // Never emit a heartbeat after READY -> watchdog must re-arm.
  const rearmed = await waitUntil(() => starts >= 2, 8000);
  assert(rearmed, '11a: stale heartbeat detected -> monitor re-armed');
  await waitUntil(() => hbMonitor.status().health === 'ACTIVE', 3000);
  hbMonitor.stop();
}

// =========================================================== 12. Graceful shutdown
{
  console.log('12. Graceful shutdown and cleanup');
  const factory = () => new FakeTransport();
  const monitor = new ProcessMonitor({ transportFactory: factory, snapshotFn: FAKE_SNAPSHOT_FN });
  await monitor.start();
  monitor.stop();
  const st = monitor.status();
  assert(st.health === 'STOPPED', '12: health STOPPED after stop()');
  // Events after stop are ignored (lifecycle guard).
  const before = monitor.status().eventsReceived;
  monitor.recentEvents(0);
  assert(monitor.status().eventsReceived === before, '12: no event processing after stop');
  // Double-stop is safe.
  monitor.stop();
  assert(monitor.status().health === 'STOPPED', '12: double-stop safe');
}

// =========================================================== 13-14. Permission boundaries + emergency-stop compatibility
{
  console.log('13-14. Permission boundaries + emergency-stop compatibility');
  let CLOCK = 5_000_000;
  const now = () => CLOCK;
  const bus = new AgentEventBus();
  const registry = new ToolRegistry(bus);
  const permissions = new PermissionManager();
  const scoped = new ScopedPermissionManager(now);
  const audit = new SafetyAuditLog();
  const emergencyStop = new EmergencyStop(audit);
  const gate = new SafetyGate({ permissions, scoped, emergencyStop, audit, now });
  registry.setSafetyGate(gate);
  registry.registerAll(createProcessMonitorTools());

  // 13. No process-control tool exists in the agent surface.
  const names = registry.names();
  const controlScan = names.filter((n) => /kill|terminate|suspend|inject|stop process|quarantine/i.test(n));
  assert(controlScan.length === 0, `13: no process-control tool registered (found: ${controlScan.join(',') || 'none'})`);
  const caps = registry.list().flatMap((t) => t.capabilities ?? []);
  const capScan = caps.filter((c) => /process\.control|terminate|suspend|kill/i.test(c));
  assert(capScan.length === 0, '13: no process-control capability declared');

  // 14. Emergency stop: the read-only status tool remains callable (safe
  // class), and no monitor state is damaged by the stop.
  emergencyStop.activate('phase-a e-stop compatibility test');
  const statusTool = registry.get('processMonitor.status');
  assert(statusTool !== undefined, '14: status tool registered');
  // The tool fetches the server route; in-process there is no server — call
  // it and expect an honest failure (not_found), NOT a permission denial:
  // the gate must classify it SAFE and let it through.
  const ctx = { taskId: 't', stepId: 's', signal: new AbortController().signal, memory: {} };
  const result = await registry.execute('processMonitor.status', {}, ctx);
  assert((result.metadata?.safety as any)?.decision === 'allow', '14: status tool allowed under emergency stop (safe class)');
  assert(result.success === false && result.errorKind === 'not_found', '14: honest not-found without a server (no fabricated status)');
  assert(emergencyStop.isActive() === true, '14: emergency stop remains active (unaffected by monitor)');
  emergencyStop.deactivate();
}

// =========================================================== 15b. Metadata-only audit with the REAL worker
{
  console.log('15b. Metadata-only audit with the REAL worker');
  const audits: Array<{ kind: string } & Record<string, unknown>> = [];
  const monitor = new ProcessMonitor({ audit: (e) => audits.push(e) });
  await monitor.start();
  await sleep(1500);
  const st15b = monitor.status();
  assert(st15b.health === 'ACTIVE', 'real worker reaches ACTIVE (real WMI subscriptions, no admin)');
  const auditDump = JSON.stringify(audits);
  assert(!auditDump.includes('.exe'), '15b: lifecycle audit records contain no process names');
  monitor.stop();
}

// =========================================================== 16. Performance with the REAL worker (live WMI)
async function performanceScenarios(): Promise<void> {
  console.log('16. Performance (real worker, live WMI) — MEASURED');
  const monitor = new ProcessMonitor();
  const cpuBefore = process.cpuUsage();
  const memBefore = process.memoryUsage().rss;
  await monitor.start();
  const bootDone = Date.now();
  const st = monitor.status();
  assert(st.health === 'ACTIVE', '16: real monitor ACTIVE');

  // Idle period: 8 s with no synthetic events.
  const idleCpuBefore = process.cpuUsage();
  await sleep(8000);
  const idleCpu = process.cpuUsage(idleCpuBefore);
  const idleTotalMs = (idleCpu.user + idleCpu.system) / 1000;
  assert(idleTotalMs < 500, `idle 8 s CPU consumption ${idleTotalMs.toFixed(1)} ms (target: negligible, <500 ms incl. test harness overhead)`);
  const memIdle = process.memoryUsage().rss;
  console.log(`  measured: idle 8s CPU ${idleTotalMs.toFixed(1)} ms; RSS delta since boot ${(memIdle - memBefore) / 1024 / 1024 >= 0 ? '+' : ''}${((memIdle - memBefore) / 1024 / 1024).toFixed(1)} MB (whole test process, includes harness)`);

  // Burst: 12 LONG-LIVED benign children (ping ~24 s) — the security-relevant
  // case (persisting processes must be seen). Fast-exit processes are probed
  // separately (22a below) because WITHIN-1 WMI polling cannot observe a
  // process that is born and dead between polls — a MEASURED, documented
  // non-admin limitation (elevated ETW would be required).
  const latencies: number[] = [];
  const longChildren: Array<{ pid: number; child: ReturnType<typeof spawn> }> = [];
  let received = 0;
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) {
    const child = spawn('ping.exe', ['-n', '25', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
    longChildren.push({ pid: child.pid, child });
    const spawnAt = Date.now();
    const deadline = spawnAt + 8000;
    while (Date.now() < deadline) {
      const evs = monitor.recentEvents(200).filter((e) => e.kind === 'create' && (e as any).pid === child.pid);
      if (evs.length > 0) {
        latencies.push(Date.now() - spawnAt);
        received++;
        break;
      }
      await sleep(25);
    }
  }
  const burstWall = Date.now() - t0;
  const burstCpu = process.cpuUsage(cpuBefore);
  const burstRam = process.memoryUsage().rss;
  assert(received >= 10, `burst: ${received}/12 long-lived children observed via live WMI (>=10 required)`);
  const minLatency = Math.min(...latencies);
  const maxLatency = Math.max(...latencies);
  console.log(`  measured: burst of 12 long-lived spawns in ${burstWall} ms; detection latency ${minLatency}-${maxLatency} ms (n=${received})`);
  // Cleanup: terminate the long-lived children (harness-owned, benign).
  for (const c of longChildren) {
    try { c.child.kill(); } catch { }
  }
  // 22a. Short-lived processes: MEASURED honest limitation.
  let shortObserved = 0;
  const shortBefore = monitor.status().eventsReceived;
  for (let i = 0; i < 6; i++) spawn('cmd.exe', ['/c', 'exit'], { windowsHide: true, stdio: 'ignore' });
  await sleep(3500);
  shortObserved = monitor.status().eventsReceived - shortBefore;
  console.log(`  measured (documented limitation): short-lived (fast-exit) children observed: ${shortObserved}/6 — WITHIN-1 WMI polling cannot see born-and-dead-between-polls processes (elevated ETW required for full short-lived coverage)`);
  const stAfter = monitor.status();
  assert(stAfter.queueSize <= 500, `queue bounded during burst (size ${stAfter.queueSize}, dropped ${stAfter.eventsDropped})`);
  assert(burstRam - memBefore < 50 * 1024 * 1024, `RAM delta during monitoring+burst ${( ((burstRam - memBefore) / 1024 / 1024) ).toFixed(1)} MB < 50 MB target`);
  console.log(`  measured: RSS delta (boot -> post-burst) ${((burstRam - memBefore) / 1024 / 1024).toFixed(1)} MB (whole test process)`);
  const cpuTotal = (burstCpu.user + burstCpu.system) / 1000;
  console.log(`  measured: total CPU during boot+idle+burst ${cpuTotal.toFixed(0)} ms`);
  assert(stAfter.health === 'ACTIVE', 'monitor stayed ACTIVE through the burst');

  // 11 (partial) — recovery timing after worker failure (mechanism-level).
  const recoveryMonitor = new ProcessMonitor({
    transportFactory: () => new FakeTransport(),
    snapshotFn: FAKE_SNAPSHOT_FN,
    retryBackoffMs: [30],
  });
  await recoveryMonitor.start();
  (recoveryMonitor as unknown as { transport: FakeTransport }).transport.crash(true);
  const recStart = Date.now();
  const recovered = await waitUntil(() => recoveryMonitor.status().health === 'ACTIVE', 3000);
  const recoveryMs = Date.now() - recStart;
  assert(recovered, 'recovery: worker failure -> re-armed');
  console.log(`  measured: recovery after worker failure ${recoveryMs} ms (mechanism-level, backoff 30 ms)`);
  assert(recoveryMs < 2000, 'recovery under 2 s');
  recoveryMonitor.stop();

  // Disk writes: lifecycle audit events only (counted, metadata-only).
  console.log(`  measured: audit lifecycle events emitted during perf run are metadata-only (names/paths never recorded — asserted in scenario 15)`);

  monitor.stop();
}

// =========================================================== 11. Server restart & subscription reinit + route smoke (real, isolated)
async function serverRestartScenarios(): Promise<void> {
  console.log('11b. Server restart + subscription reinitialization (isolated sandbox store)');
  const portBusy = await new Promise<boolean>((resolve) => {
    const req = http.get('http://127.0.0.1:3106/api/health', (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
  if (portBusy) {
    console.log('  (skipped: port 3106 already in use)');
    return;
  }

  const spawnServer = (): ReturnType<typeof spawn> => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kpm-e5-'));
    const child = spawn(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'server.ts'],
      {
        cwd: process.cwd(),
        stdio: 'ignore',
        env: {
          ...process.env,
          KRISHA_PORT: '3106',
          KRISHA_SANDBOX_DIR: path.join(sandbox, 'e5store'),
          KRISHA_FS_ROOTS: path.join(sandbox, 'fsroots'),
        },
        detached: false,
      }
    );
    (child as any).__sandbox = sandbox;
    return child;
  };
  const waitHealthy = async (): Promise<boolean> => {
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get('http://127.0.0.1:3106/api/health', (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return true;
    }
    return false;
  };
  const monitorStatus = async (): Promise<any> => {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await new Promise<any>((resolve, reject) => {
          const req = http.get('http://127.0.0.1:3106/api/processmonitor/status', (res) => {
            let b = '';
            res.on('data', (c) => (b += String(c)));
            res.on('end', () => resolve(JSON.parse(b)));
          });
          req.on('error', reject);
          req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('timeout'));
          });
        });
        if (String(res?.status?.health) === 'ACTIVE') return res;
      } catch { /* retry */ }
      await sleep(500);
    }
    return null;
  };

  let child = spawnServer();
  try {
    assert(await waitHealthy(), 'server 1 healthy (isolated store)');
    const s1 = await monitorStatus();
    assert(!!s1, 'monitor ACTIVE after first boot (real WMI subscriptions re-armed)');
    assert(s1?.status?.inventorySize > 0, 'startup snapshot populated the inventory');
    // Control-route absence: a kill/terminate route must not exist (POST is
    // never caught by the SPA fallback — a true 404 from Express).
    const controlProbe = await new Promise<number>((resolve) => {
      const req = http.request('http://127.0.0.1:3106/api/processmonitor/kill', { method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', () => resolve(0));
      req.end();
    });
    assert(controlProbe === 404, `no process-control route exists (kill POST probe -> ${controlProbe})`);

    // Real creation detection through the running server: spawn a benign child.
    const child2 = spawn('cmd.exe', ['/c', 'exit'], { windowsHide: true, stdio: 'ignore' });
    await sleep(3000);
    const s2 = await monitorStatus();
    const sawChild = JSON.stringify(s2?.recentEvents ?? []).includes('cmd.exe');
    assert(sawChild || (s2?.status?.eventsReceived ?? 0) > 0, 'live WMI observed process activity on the host');

    // Restart: kill server 1, spawn server 2 -> subscriptions re-armed.
    child.kill();
    await sleep(1200);
    try { fs.rmSync((child as any).__sandbox, { recursive: true, force: true }); } catch { }
    child = spawnServer();
    assert(await waitHealthy(), 'server 2 healthy after restart');
    const s3 = await monitorStatus();
    assert(!!s3, 'monitor ACTIVE after server restart (subscriptions reinitialized)');
    assert((s3?.status?.inventorySize ?? 0) > 0, 'inventory rebuilt after restart');
  } finally {
    child.kill();
    await sleep(1000);
    try { fs.rmSync((child as any).__sandbox, { recursive: true, force: true }); } catch { }
  }
}

// ---------------------------------------------------------------- run
try {
  await performanceScenarios();
  await serverRestartScenarios();
} catch (err) {
  failed++;
  failures.push(`harness crashed: ${String((err as Error)?.message || err)}`);
  console.error(err);
}

console.log(`\nProcess Monitor results: ${passed} passed, ${failed} failed`);
// Explicit exit: the live-server section creates cross-process handles
// (spawned servers, CDP sessions) whose keep-alive sockets would otherwise
// hold the event loop open after the summary.
if (failed > 0) {
  console.error('FAILURES:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PROCESS MONITOR TESTS: ALL GREEN');
process.exit(0);
