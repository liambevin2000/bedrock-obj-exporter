'use strict';
// Exports the Java test scene (every block of a game version) and reports blocks that could not be
// drawn or use the missing-texture pattern.  node tools/java-gallery-export.js <out.obj> [version]
const { Session } = require('../src/core/exporter');

const out = process.argv[2];
const version = process.argv[3] || '';
const t0 = Date.now();
const s = new Session({ worldDir: 'java-gallery:' + version, extraPacks: [] });
const w = s.world;
const sel = { dim: 0, x0: -1, x1: 48 * 2 + 1, y0: 62, y1: 68, z0: -8, z1: Math.ceil(w.size / 48) * 2 + 1 };
const r = s.exportObj(sel, out, { greedy: true });
console.log(`Minecraft ${w.version}: ${w.size} blocks -> ${r.faces} faces, ${r.materials} materials in ${Date.now() - t0} ms`);
const missing = [];
const empty = [];
for (const [x, z, name] of w.entries) {
  const b = w.blocks.get(x + ',64,' + z);
  if (!b) continue;
  const id = s.models.idFor(b);
  const m = s.models.list[id];
  if (!id) { empty.push(name.replace('minecraft:', '')); continue; }
  const quads = m.liquid ? [] : m.quads;
  if (quads.some((q) => q.slot && q.slot.mat === s.res.missing)) missing.push(name.replace('minecraft:', ''));
}
const unknown = [...s.models.unknown.entries()];
console.log('not drawn / problems:', unknown.length ? unknown.map(([n, why]) => `${n}: ${why}`).join('; ') : 'none');
console.log(`models using the missing-texture placeholder (${missing.length}):`, missing.join(', ') || 'none');
console.log(`drawn as nothing (${empty.length}):`, empty.join(', ') || 'none');
console.log('entities skipped:', [...s.entities.skipped.entries()].map(([k, v]) => k + ': ' + v).join('; ') || 'none', '| drawn:', r.entities);
s.close();
