// READ-ONLY .git/index scan: list tracked paths matching the malformed-root-file
// signatures, and dump a summary of tracked root-level entries.
const fs = require('fs');

const buf = fs.readFileSync('.git/index');
if (buf.slice(0, 4).toString() !== 'DIRC') {
  console.log('not a git index');
  process.exit(1);
}
const version = buf.readUInt32BE(4);
const count = buf.readUInt32BE(8);
console.log('index version', version, 'entries', count);

let off = 12;
const entries = [];
for (let i = 0; i < count; i++) {
  const flags = buf.readUInt16BE(off + 60);
  const nameLen = flags & 0xfff;
  const nameStart = off + 62;
  const name = buf.slice(nameStart, nameStart + nameLen).toString('utf8');
  entries.push(name);
  const entryLen = Math.ceil((62 + nameLen + 1) / 8) * 8; // padded to 8, NUL-terminated
  off += entryLen;
  if (off >= buf.length) break;
}
const suspects = ['({', "console.log('", 'rb.executeRollback({', 's.taskId', 'sys.fsCreate(path.join(fsRoots'];
console.log('\n-- malformed files tracked? --');
for (const s of suspects) {
  console.log(JSON.stringify(s), entries.includes(s) ? 'TRACKED' : 'not tracked');
}
console.log('\n-- root-level tracked entries (first 40) --');
console.log(entries.filter((e) => !e.includes('/')).slice(0, 40).join('\n'));
console.log('\ntotal tracked:', entries.length);
