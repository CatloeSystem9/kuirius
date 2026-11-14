// READ-ONLY git history scan: reflog + loose-object tree search for the
// malformed root files. No writes, no git commands.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GIT = '.git';
const suspects = ["console.log('", 'rb.executeRollback({', 's.taskId', 'sys.fsCreate(path.join(fsRoots', '({', "s.toolName+'"];

function readObject(hash) {
  const loose = path.join(GIT, 'objects', hash.slice(0, 2), hash.slice(2));
  if (fs.existsSync(loose)) {
    return { type: 'loose', data: zlib.inflateSync(fs.readFileSync(loose)) };
  }
  return { type: 'packed', data: null };
}

// 1. Full reflog
const reflog = fs.readFileSync(path.join(GIT, 'logs', 'HEAD'), 'utf8').trim().split('\n');
console.log('reflog entries:', reflog.length);
const commits = [];
for (const line of reflog) {
  const m = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.*?) (\d+) ([+-]\d{4})\t(.*)$/);
  if (m) commits.push({ old: m[1], hash: m[2], who: m[3], time: new Date(Number(m[4]) * 1000).toISOString(), msg: m[6] });
}
// print last 12
for (const c of commits.slice(-12)) console.log(c.time, c.hash.slice(0, 8), '|', c.msg.slice(0, 70));

// 2. For recent commits, find tree and scan for suspect names
console.log('\n-- suspect-name presence per commit (recent first, loose objects only) --');
for (const c of commits.slice().reverse().slice(-14)) {
  const obj = readObject(c.hash);
  if (obj.type === 'packed' || !obj.data) {
    console.log(c.hash.slice(0, 8), c.msg.slice(0, 40), '=> [packed object, skipped]');
    continue;
  }
  const text = obj.data.toString('binary');
  const treeMatch = text.match(/^tree ([0-9a-f]{40})/m);
  if (!treeMatch) { console.log(c.hash.slice(0, 8), 'no tree'); continue; }
  const t = readObject(treeMatch[1]);
  if (t.type === 'packed' || !t.data) { console.log(c.hash.slice(0, 8), c.msg.slice(0, 40), '=> tree packed'); continue; }
  // parse tree entries: mode<space>name\0 20-byte sha
  const names = [];
  let i = 0;
  const td = t.data;
  while (i < td.length) {
    const sp = td.indexOf(0x20, i);
    const nul = td.indexOf(0x00, sp);
    if (sp < 0 || nul < 0) break;
    const name = td.slice(sp + 1, nul).toString('utf8');
    names.push(name);
    i = nul + 1 + 20;
  }
  const found = suspects.filter((s) => names.includes(s));
  console.log(c.hash.slice(0, 8), new Date(Number(c.msg ? c.time : 0)).toISOString().slice(0, 10), '|', c.msg.slice(0, 42).padEnd(42), '| suspects:', found.length ? found.join('; ') : 'none');
}

// 3. Check loose availability + pack files
const packDir = path.join(GIT, 'objects', 'pack');
if (fs.existsSync(packDir)) {
  console.log('\npack files:', fs.readdirSync(packDir).filter((f) => f.endsWith('.pack')).join(', ') || 'none');
}
