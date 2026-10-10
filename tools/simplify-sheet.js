'use strict';
// Writes a before/after sheet of simplified block textures (each shown 8x, original above result)
// and prints how many tones each kept:  node tools/simplify-sheet.js out.png [terrain names...]
const fs = require('fs');
const { Resources, encodePng } = require('../src/core/resources');
const { simplifyImage } = require('../src/core/simplify');

const out = process.argv[2];
const names = process.argv.slice(3);
const list = names.length ? names : ['oak_planks', 'stone', 'cobblestone', 'dirt', 'grass_top', 'oak_log_side', 'oak_log_top', 'bricks', 'stonebrick',
  'sand', 'gravel', 'diamond_ore', 'iron_ore', 'oak_leaves', 'glass', 'bookshelf', 'crafting_table_side', 'furnace_front_off', 'tnt_side', 'pumpkin_face'];
const r = new Resources({});
const tones = (img) => { const s = new Set(); for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] > 10) s.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]); return s.size; };
const cells = [];
for (const n of list) {
  const t = r.terrainTexture(n);
  const img = t && r.image(t.path);
  if (!img || img.w !== 16 || img.h !== 16) { console.log(n.padEnd(22), 'skipped'); continue; }
  const simple = simplifyImage(img);
  console.log(n.padEnd(22), String(tones(img)).padStart(3), 'colours ->', tones(simple));
  cells.push([img, simple]);
}
const S = 8, P = 6, cw = 16 * S + P, W = cells.length * cw + P, H = 2 * (16 * S + P) + P;
const data = new Uint8Array(W * H * 4);
for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 40; data[i + 3] = 255; }
cells.forEach((pair, c) => pair.forEach((img, row) => {
  for (let y = 0; y < 16 * S; y++) for (let x = 0; x < 16 * S; x++) {
    const s = ((y / S | 0) * 16 + (x / S | 0)) * 4, d = ((P + row * (16 * S + P) + y) * W + P + c * cw + x) * 4;
    const a = img.data[s + 3] / 255;
    for (let k = 0; k < 3; k++) data[d + k] = Math.round(img.data[s + k] * a + 70 * (1 - a));
  }
}));
fs.writeFileSync(out, encodePng({ w: W, h: H, data }));
console.log('wrote', out);
