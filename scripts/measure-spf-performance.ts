/**
 * SPF performance measurement (task §10).
 *
 * Usage: npx tsx scripts/measure-spf-performance.ts
 *
 * Measures local detection latency, redaction latency, memory usage and CPU
 * overhead over repeated inspections. Pure local work — no network.
 */
import { spfFirewall, ScreenPrivacyFirewall, SpfAuditLog } from '../src/agent/spf/index';

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function bench(label: string, iterations: number, run: () => void): { p50: number; p95: number; p99: number; mean: number } {
  // Warm-up (JIT + regex caches).
  for (let i = 0; i < Math.min(50, iterations); i++) run();
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    run();
    const end = process.hrtime.bigint();
    times.push(Number(end - start) / 1e6); // ms
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const result = { p50: percentile(times, 50), p95: percentile(times, 95), p99: percentile(times, 99), mean };
  console.log(
    `${label.padEnd(58)} n=${String(iterations).padEnd(6)} p50=${result.p50.toFixed(3)}ms  p95=${result.p95.toFixed(3)}ms  p99=${result.p99.toFixed(3)}ms  mean=${result.mean.toFixed(3)}ms`
  );
  return result;
}

const CTX = { destination: 'perf-test', payloadKind: 'text' as const, transport: 'prompt' as const };

// Payloads mirroring real traffic shapes.
const SHORT_BENIGN = 'The meeting is at 3pm in room 4021';
const SCREEN_SUMMARY = 'Visual Studio Code — 12 open editors, terminal shows npm run build, 3 errors in spf/firewall.ts. Buttons: Save, Run, Debug. Links: docs, settings.';
const OCR_1KB = Array.from({ length: 20 }, (_, i) => `Row ${i}: value ${Math.random().toString(36).slice(2, 40)} status ok confidence 0.92`).join('\n');
const OCR_10KB = Array.from({ length: 200 }, (_, i) => `Row ${i}: value ${Math.random().toString(36).slice(2, 40)} status ok confidence 0.92`).join('\n');
const SECRET_1KB = `password: FAKE-Perf-Secret-1 ${OCR_1KB}`;
const CHAT_BODY_MESSAGES = Array.from({ length: 16 }, (_, i) => ({ content: `${SCREEN_SUMMARY} (turn ${i})` }));

console.log('=== SPF performance (local detection / redaction / guard overhead) ===\n');

const memBefore = process.memoryUsage();
const cpuBefore = process.cpuUsage();

console.log('--- text detection latency ---');
bench('inspectText — short benign (32B)', 2000, () => spfFirewall.inspectText(SHORT_BENIGN, CTX));
bench('inspectText — screen summary (~200B)', 2000, () => spfFirewall.inspectText(SCREEN_SUMMARY, CTX));
bench('inspectText — OCR-ish 1KB clean', 1000, () => spfFirewall.inspectText(OCR_1KB, CTX));
bench('inspectText — OCR-ish 10KB clean', 200, () => spfFirewall.inspectText(OCR_10KB, CTX));
bench('inspectText — 1KB with secret (redact path)', 1000, () => spfFirewall.inspectText(SECRET_1KB, CTX));
bench('inspectImageTransfer — metadata gate', 2000, () =>
  spfFirewall.inspectImageTransfer({ question: 'Describe the screen', activeWindowTitle: 'Editor' }, { destination: 'perf', payloadKind: 'image', transport: 'prompt' })
);
bench('inspectTextFields — 16-message chat history', 500, () =>
  spfFirewall.inspectTextFields(
    Object.fromEntries(CHAT_BODY_MESSAGES.map((m, i) => [`msg_${i}`, m.content])),
    { destination: 'perf-chat', payloadKind: 'text', transport: 'chat-history' }
  )
);
bench('inspectJsonPayload — chat-shaped JSON', 500, () =>
  spfFirewall.inspectJsonPayload({ messages: CHAT_BODY_MESSAGES, memories: [SCREEN_SUMMARY] }, { destination: 'perf-json', payloadKind: 'json', transport: 'chat-history' })
);

console.log('\n--- redaction-only latency (pre-detected payload) ---');
const auditLog = new SpfAuditLog(500);
const fwAudit = new ScreenPrivacyFirewall({ audit: auditLog, deadlineMs: 200 });
bench('inspectText with audit recording (secret)', 1000, () => fwAudit.inspectText(`password: FAKE-x ${OCR_1KB}`, CTX));

console.log('\n--- repeated observations (task §10) ---');
bench('100 consecutive screen-summary inspections', 20, () => {
  for (let i = 0; i < 100; i++) spfFirewall.inspectText(SCREEN_SUMMARY, CTX);
});

const cpuAfter = process.cpuUsage(cpuBefore);
const memAfter = process.memoryUsage();

console.log('\n--- totals ---');
const stats = spfFirewall.stats();
console.log(`firewall counters: inspectCalls=${stats.inspectCalls} allow=${stats.allow} redact=${stats.redact} block=${stats.block} avgDetectMs=${stats.avgDetectMs.toFixed(3)}`);
console.log(`CPU during benchmark: user=${(cpuAfter.user / 1000).toFixed(1)}ms system=${(cpuAfter.system / 1000).toFixed(1)}ms`);
console.log(`heap: before=${(memBefore.heapUsed / 1024 / 1024).toFixed(1)}MB after=${(memAfter.heapUsed / 1024 / 1024).toFixed(1)}MB delta=${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(1)}MB`);
console.log(`audit ring entries: ${auditLog.stats().total}`);
