// Recursive grep: patterns file + list of roots (dirs or files).
const fs = require('fs');
const path = require('path');
const [patternFile, ...roots] = process.argv.slice(2);
const patterns = fs.readFileSync(patternFile, 'utf8').split('\n').filter(Boolean).map((s) => new RegExp(s));

function walk(p) {
  let st;
  try { st = fs.statSync(p); } catch { return; }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) {
      if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
      walk(path.join(p, e));
    }
  } else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|html|css)$/.test(p)) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
    text.split('\n').forEach((line, i) => {
      if (patterns.some((re) => re.test(line))) {
        console.log(path.relative(process.cwd(), p).replace(/\\/g, '/') + ':' + (i + 1) + ': ' + line.trim().slice(0, 160));
      }
    });
  }
}
for (const r of roots) walk(r);
