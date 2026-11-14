// T5b/T5c: server-side stop enforcement + recovery (operator pipe protocol).
const http = require('http');
const net = require('net');

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {});
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 15000 },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}
function pipeOp(msg) {
  return new Promise((resolve, reject) => {
    const socket = net.connect('\\\\.\\pipe\\krisha-e5-recovery', () => {
      socket.end(JSON.stringify(msg) + '\n');
    });
    let buf = '';
    socket.on('data', (c) => (buf += c));
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()));
      } catch (e) {
        reject(new Error('bad pipe response: ' + buf.slice(0, 200)));
      }
    });
    socket.on('error', reject);
    setTimeout(() => socket.destroy(new Error('pipe timeout')), 8000);
  });
}

(async () => {
  const target = 'C:/Users/Expert/AppData/Local/Temp/krisha-stop-test/deleteme.txt';
  // T5b: delete attempt while the stop is ACTIVE — the server must refuse.
  const whileStopped = await post(3000, '/api/fs/delete', { path: target });
  console.log('DELETE_WHILE_STOPPED:', whileStopped.status, whileStopped.body.slice(0, 200));

  // Operator recovery over the pipe: set credential, then recover.
  const setCred = await pipeOp({ op: 'set-credential', code: 'phase3-audit-credential-2026', nonce: 'nonce-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) });
  console.log('SET_CREDENTIAL:', JSON.stringify(setCred).slice(0, 220));
  const recover = await pipeOp({ op: 'recover', code: 'phase3-audit-credential-2026', nonce: 'nonce-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) });
  console.log('RECOVER:', JSON.stringify(recover).slice(0, 220));

  // T5c: the same delete after authorized recovery — now succeeds.
  const afterRecovery = await post(3000, '/api/fs/delete', { path: target });
  console.log('DELETE_AFTER_RECOVERY:', afterRecovery.status, afterRecovery.body.slice(0, 200));
  const stop = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:3000/api/safety/stop', (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  console.log('STOP_STATE:', stop);
  process.exit(0);
})().catch((e) => {
  console.error('T5 FAIL:', e.message);
  process.exit(1);
});
