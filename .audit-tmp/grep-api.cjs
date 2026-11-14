// Audit helper: extract /api/... endpoint strings from source trees.
const fs = require('fs');
const path = require('path');

const roots = process.argv.slice(2);
const results = new Set();

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      walk(p);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      let text;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        const re = /['"`](\/api\/[A-Za-z0-9_\-/:.*]*)['"`]/g;
        let m;
        while ((m = re.exec(line)) !== null) {
          results.add(
            path.relative(process.cwd(), p).replace(/\\/g, '/') + ':' + (i + 1) + ' -> ' + m[1]
          );
        }
      });
    }
  }
}

for (const r of roots) walk(r);
for (const line of [...results].sort()) console.log(line);
