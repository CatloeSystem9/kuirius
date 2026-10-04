import fs from 'fs';
const path = 'scripts/test-longrun-phase19.ts';
let text = fs.readFileSync(path, 'utf8');
// Repair ALL remaining broken arrow labels: a single-quote that used to be a
// mojibake arrow inside a label string. Pattern: word + quote + space + word,
// inside a single-quoted literal. Replace with " -> ".
text = text.replace(/([a-z0-9)]) ' (?=[a-z])/gi, '$1 -> ');
fs.writeFileSync(path, text, 'utf8');
console.log('repaired');
