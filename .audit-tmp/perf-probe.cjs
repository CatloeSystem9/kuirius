// Phase 3 performance probe — request latency + server memory.
// Targets the LOCAL dev server only (127.0.0.1:3000).
const http = require('http');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {});
    const req = http.request(
      { host: '127.0.0.1', port: 3000, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 15000 },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, bytes: buf.length }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end(data);
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 3000, path, method: 'GET', timeout: 15000 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, bytes: buf.length }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}
const stats = [];
async function measure(label, fn, n) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const line = `${label}: n=${n} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${times[times.length - 1].toFixed(1)}ms`;
  stats.push(line);
  console.log(line);
}

(async () => {
  await get('/api/health');
  await measure('GET /api/health', () => get('/api/health'), 30);
  await measure('GET /api/safety/stop', () => get('/api/safety/stop'), 30);
  await measure('GET /api/integrity/status', () => get('/api/integrity/status'), 15);
  await measure('POST /api/fs/list (cwd)', () => post('/api/fs/list', { path: process.cwd() }), 20);
  await measure('POST /api/research/search (offline err)', () => post('/api/research/search', { query: 'krisha perf probe' }), 5);
  console.log('DONE');
  process.exit(0);
})().catch((e) => {
  console.error('PROBE FAIL:', e.message);
  process.exit(1);
});
