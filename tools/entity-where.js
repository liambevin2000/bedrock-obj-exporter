'use strict';
// Lists where scenery entities and interesting block entities are, densest spots first:
//   node tools/entity-where.js "<world>"
const { listWorlds, scanChunks } = require('../src/core/world');
const { Session } = require('../src/core/exporter');

const arg = process.argv[2];
const w = listWorlds().find((x) => x.dir === arg || x.name === arg || x.name.startsWith(arg)) || { dir: arg };
const s = new Session({ worldDir: w.dir });
const d = scanChunks(s.world.db)[0];
const cells = new Map();
let drawn = 0, total = 0;
const kinds = new Map();
for (let i = 0; i < d.count; i++) {
  const cx = d.chunks[i * 4], cz = d.chunks[i * 4 + 1];
  for (const e of s.world.getEntities(cx, cz, 0)) {
    total++;
    const m = s.entities.modelFor(e);
    if (!m) continue;
    drawn++;
    kinds.set(e.identifier, (kinds.get(e.identifier) || 0) + 1);
    const k = (Math.floor(e.Pos[0] / 48)) + ',' + (Math.floor(e.Pos[2] / 48));
    const c = cells.get(k) || { n: 0, y: [] };
    c.n++; c.y.push(e.Pos[1]);
    cells.set(k, c);
  }
}
console.log(`entities: ${total} stored, ${drawn} drawable as scenery`);
console.log('kinds:', [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map((e) => e.join(' ')).join(', '));
console.log('left out:', [...s.entities.skipped.entries()].slice(0, 8).map((e) => e.join(': ')).join(' | ') || 'nothing');
for (const [k, c] of [...cells.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 4)) {
  const [x, z] = k.split(',').map(Number);
  console.log(`  ${c.n} entities in x ${x * 48}..${x * 48 + 47}, z ${z * 48}..${z * 48 + 47}, y ${Math.floor(Math.min(...c.y))}..${Math.ceil(Math.max(...c.y))}`);
}
