// Production startup measurement: spawn `node dist/server.cjs`, time until
// /api/health responds, then kill the child.
const { spawn } = require('child_process');
const http = require('http');

function probe() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:3000/api/health', { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

(async () => {
  const t0 = Date.now();
  const child = spawn(process.execPath, ['dist/server.cjs'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  let up = false;
  while (Date.now() - t0 < 30000) {
    if (await probe()) {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const elapsed = Date.now() - t0;
  child.kill('SIGKILL');
  console.log(up ? `PROD STARTUP OK: ${elapsed}ms` : 'PROD STARTUP FAILED after 30s');
  console.log('server output tail:', out.slice(-400).replace(/\n+/g, ' | '));
  process.exit(up ? 0 : 1);
})();
