/* One-shot diagnostic: who owns the global E5 recovery pipe?
 * Connects, sends a status op with a FRESH nonce (the replay protection
 * refuses reused nonces — observed live), prints the responder's identity
 * fields. Read-only. */
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const PIPE = '\\\\.\\pipe\\krisha-e5-recovery';
const socket = net.connect(PIPE);
let buffer = '';
const timer = setTimeout(() => {
  console.log('PROBE TIMEOUT (no responder accepted)');
  process.exit(0);
}, 4000);
socket.on('connect', () => {
  console.log('CONNECTED to', PIPE, '— a server owns this pipe');
  socket.write(JSON.stringify({ op: 'status', nonce: randomBytes(24).toString('hex') }) + '\n');
});
socket.on('data', (d: Buffer) => {
  buffer += String(d);
  if (!buffer.includes('\n')) return;
  clearTimeout(timer);
  try {
    const parsed = JSON.parse(buffer.split('\n')[0]);
    const snap = (parsed.result ?? {}) as Record<string, unknown>;
    console.log('RESPONDER: ok=' + parsed.ok
      + ' kind=' + snap.kind
      + ' generation=' + snap.generation
      + ' storageProtection=' + snap.storageProtection
      + ' auditDegraded=' + snap.auditDegraded);
  } catch (err) {
    console.log('UNPARSEABLE response:', buffer.slice(0, 200));
  }
  socket.end();
  setTimeout(() => process.exit(0), 200);
});
socket.on('error', (err) => {
  clearTimeout(timer);
  console.log('PIPE ERROR:', (err as Error).message);
  process.exit(0);
});
