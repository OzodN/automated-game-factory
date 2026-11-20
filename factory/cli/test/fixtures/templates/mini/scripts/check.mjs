// Fixture checks: "unit" fails when any source file contains the marker BUG.
import fs from 'node:fs';
import path from 'node:path';
const mode = process.argv[2];
function walk(d, out = []) { if (!fs.existsSync(d)) return out; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f, out) : out.push(f); } return out; }
if (mode === 'unit') {
  const bad = walk('src').filter((f) => fs.readFileSync(f, 'utf8').includes('BUG'));
  if (bad.length) { console.error('unit FAILED: defect marker in ' + bad.join(', ')); process.exit(1); }
}
if (mode === 'release' && !fs.existsSync('dist/index.html')) { console.error('no build'); process.exit(1); }
console.log(mode + ' ok');
