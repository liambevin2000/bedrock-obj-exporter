'use strict';
// Prints the blocks.json textures (and whether the files resolve) for block names: node tools/tex-of.js name...
const { Resources } = require('../src/core/resources');
const r = new Resources({});
for (const n of process.argv.slice(2)) {
  const e = r.blocksJson[n];
  if (!e) { console.log(n.padEnd(26), '(no blocks.json entry)', r.terrain[n] ? 'terrain: ' + JSON.stringify(r.terrain[n].textures).slice(0, 80) : ''); continue; }
  const t = typeof e.textures === 'string' ? { all: e.textures } : e.textures || {};
  console.log(n.padEnd(26), Object.entries(t).map(([k, v]) => { const tt = r.terrainTexture(v); const img = tt && r.image(tt.path); return `${k}=${v}${img ? `[${img.w}x${img.h}]` : '[MISSING]'}`; }).join(' '));
}
