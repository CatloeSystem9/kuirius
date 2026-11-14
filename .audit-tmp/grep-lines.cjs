// Audit helper: grep lines matching any of the given regexes in given files.
const fs = require('fs');
const [patternFile, ...files] = process.argv.slice(2);
const patterns = fs.readFileSync(patternFile, 'utf8').split('\n').filter(Boolean).map((s) => new RegExp(s));
for (const f of files) {
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (patterns.some((re) => re.test(line))) {
      console.log(f.replace(/\\/g, '/') + ':' + (i + 1) + ': ' + line.trim().slice(0, 160));
    }
  });
}
