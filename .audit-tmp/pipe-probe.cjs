// Pipe probe: raw protocol with logging.
const net = require('net');
const op = process.argv[2] ?? 'status';
const code = process.argv[3] ?? '';
const msg = { op, code, nonce: 'nonce-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) };
const socket = net.connect('\\\\.\\pipe\\krisha-e5-recovery', () => {
  socket.write(JSON.stringify(msg) + '\n');
});
let buf = '';
socket.on('data', (c) => {
  buf += c.toString('utf8');
  console.log('RAW:', JSON.stringify(buf));
  socket.end();
});
socket.on('end', () => {
  console.log('ENDED. buf=', JSON.stringify(buf));
  process.exit(0);
});
socket.on('error', (e) => {
  console.log('ERR:', e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log('TIMEOUT. buf=', JSON.stringify(buf));
  process.exit(2);
}, 9000);
