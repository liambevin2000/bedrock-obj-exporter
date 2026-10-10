'use strict';
// Lists the biomes and recorded structures of a world: node tools/locate-cli.js "<world>" [dimension]
const { listWorlds, scanChunks } = require('../src/core/world');
const { Session } = require('../src/core/exporter');
const { locate } = require('../src/core/locate');

const arg = process.argv[2], dim = Number(process.argv[3] || 0);
const w = listWorlds().find((x) => x.dir === arg || x.name === arg || x.name.startsWith(arg)) || { dir: arg };
const s = new Session({ worldDir: w.dir });
let t = Date.now();
const d = scanChunks(s.world.db)[dim];
console.log(w.name || w.dir, '-', d.count, 'chunks, scan', Date.now() - t, 'ms');
t = Date.now();
locate(s, dim, d.chunks).then((r) => {
  console.log('located in', Date.now() - t, 'ms');
  console.log('biomes:', r.biomes.map((b) => `${b.name} (${b.chunks.length / 2})`).join(', '));
  for (const st of r.structures) console.log(' ', st.kind.padEnd(38), String(st.places.length).padStart(4), 'places, e.g.', st.places.slice(0, 3).map((p) => `${p.x},${p.y},${p.z}`).join('  '));
});
