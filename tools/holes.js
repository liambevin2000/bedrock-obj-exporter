'use strict';
// Reports chunks that are missing from a world although their neighbours exist, and what (if
// anything) the database holds for them:  node tools/holes.js "<world name or folder>"
const { listWorlds, World } = require('../src/core/world');

const arg = process.argv[2];
const w = listWorlds().find((x) => x.dir === arg || x.name === arg || x.name.startsWith(arg)) || { dir: arg };
const world = new World(w.dir);
const have = new Set();
const tagsBy = new Map();
world.db.scanKeys((k) => {
  if (k.length < 9 || k.length > 14) return;
  let tagPos = 8;
  if (k.length >= 13) { if (k.readInt32LE(8) !== 0) return; tagPos = 12; }
  if (k.length !== tagPos + 1 && k.length !== tagPos + 2) return;
  const key = k.readInt32LE(0) + ',' + k.readInt32LE(4);
  let s = tagsBy.get(key);
  if (!s) tagsBy.set(key, s = new Set());
  s.add(k[tagPos]);
  if (k[tagPos] === 0x2f) have.add(key);
});
const N = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const holes = [], seen = new Set();
for (const key of have) {
  const [x, z] = key.split(',').map(Number);
  for (const [dx, dz] of N) {
    const hx = x + dx, hz = z + dz, hk = hx + ',' + hz;
    if (have.has(hk) || seen.has(hk)) continue;
    seen.add(hk);
    if (N.filter(([a, b]) => have.has((hx + a) + ',' + (hz + b))).length >= 3) holes.push(hk);
  }
}
const sig = (t) => (t ? [...t].sort((a, b) => a - b).map((v) => '0x' + v.toString(16)).join(' ') : '(no keys at all)');
const count = (list, f) => { const m = new Map(); for (const x of list) m.set(f(x), (m.get(f(x)) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
console.log('world:', w.dir);
console.log('chunks with blocks:', have.size, '| enclosed holes:', holes.length);
console.log('holes hold:', count(holes, (h) => sig(tagsBy.get(h))).slice(0, 8));
console.log('normal chunks hold:', count([...have], (h) => sig(tagsBy.get(h))).slice(0, 3));
console.log('sample holes:', holes.slice(0, 6).join('  '));
