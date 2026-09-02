'use strict';
// One-off: reconcile TRANSPARENCY.md audit table against code extraction.
const fs = require('fs');
const code = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js')) {
      const s = fs.readFileSync(p, 'utf8');
      const re = /_audit\(\{\s*type:\s*'([a-z_]+)'/g;
      let m;
      while ((m = re.exec(s))) code.push(m[1]);
    }
  }
}
walk('src/gateway');
const doc = fs.readFileSync('docs/standards/TRANSPARENCY.md', 'utf8');
const listed = new Set();
let mm;
const reL = /^\| (\d+) \| `([a-z_]+)`/gm;
while ((mm = reL.exec(doc))) listed.add(mm[2]);
const uniq = [...new Set(code)].sort();
console.log('missing in doc:', uniq.filter((t) => !listed.has(t)).join(', ') || '(none)');
console.log('in doc not in code:', [...listed].filter((t) => !uniq.includes(t)).join(', ') || '(none)');
console.log('code total:', uniq.length);
// numbering check: find duplicate row numbers
const rows = [...doc.matchAll(/^\| (\d+) \|/gm)].map((r) => Number(r[1]));
const seen = new Map();
for (const n of rows) seen.set(n, (seen.get(n) || 0) + 1);
console.log('duplicate row numbers:', [...seen].filter(([, c]) => c > 1).map(([n]) => n).join(', ') || '(none)');
console.log('max row:', Math.max(...rows), 'row count:', rows.length);
