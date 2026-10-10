'use strict';
// Prints where the drawn (non-transparent) part sits inside terrain textures: node tools/tex-box.js name...
const { Resources } = require('../src/core/resources');
const r = new Resources({});
for (const n of process.argv.slice(2)) {
  const t = r.terrainTexture(n);
  const img = t && r.image(t.path);
  if (!img) { console.log(n.padEnd(20), 'no image'); continue; }
  let x0 = 99, y0 = 99, x1 = -1, y1 = -1, solid = 0;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (img.data[(y * img.w + x) * 4 + 3] <= 40) continue;
    solid++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  console.log(n.padEnd(20), `${img.w}x${img.h}`, img.alpha.padEnd(7), `drawn x ${x0}..${x1}  y ${y0}..${y1}`, `(${Math.round(100 * solid / (img.w * img.h))}% filled)`, t.path);
}
