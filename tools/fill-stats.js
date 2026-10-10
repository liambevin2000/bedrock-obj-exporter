'use strict';
// Compares plant density on saved chunks with the estimated ones in a selection:
//   node tools/fill-stats.js "<world>" x0 y0 z0 x1 y1 z1
const { listWorlds } = require('../src/core/world');
const { Session } = require('../src/core/exporter');

const [name, ...n] = process.argv.slice(2);
const [x0, y0, z0, x1, y1, z1] = n.map(Number);
const w = listWorlds().find((x) => x.dir === name || x.name === name || x.name.startsWith(name)) || { dir: name };
const s = new Session({ worldDir: w.dir });
const m = s.mesher({ dim: 0, x0, y0, z0, x1, y1, z1 }, { fill: true });
const list = s.models.list;
const tally = { saved: { columns: 0, plants: 0, kinds: new Map() }, estimated: { columns: 0, plants: 0, kinds: new Map() } };
for (const [cx, cz] of m.chunkList()) {
  const c = m._decode(cx, cz);
  if (!c.subs.size) continue;
  const t = c.estimated ? tally.estimated : tally.saved;
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    const base = (x << 8) | (z << 4);
    t.columns++;
    for (let wy = m.b.y1; wy >= m.b.y0; wy--) {
      const sub = c.subs.get(wy >> 4);
      const id = sub ? sub.ids[base | (wy & 15)] : 0;
      if (!id) continue;
      if (list[id].sink) { t.plants++; const k = list[id].name.replace(/^minecraft:/, ''); t.kinds.set(k, (t.kinds.get(k) || 0) + 1); }
      if (m._isGround(id)) break;
    }
  }
}
for (const k of ['saved', 'estimated']) {
  const t = tally[k];
  console.log(`${k}: ${t.columns} columns, ${t.plants} plant blocks (${(100 * t.plants / Math.max(1, t.columns)).toFixed(1)} per 100 columns)`);
  console.log('  ' + [...t.kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e.join(' ')).join(', '));
}
