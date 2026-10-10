'use strict';
// Exercises object picking without the UI: drops a ray straight down every few blocks, reports what
// it finds, then checks that moving and isolating the largest structure and a tree meshes sensibly.
//   node tools/pick-test.js "<world>" x0 y0 z0 x1 y1 z1
const { listWorlds } = require('../src/core/world');
const { Session } = require('../src/core/exporter');
const O = require('../src/core/objects');

const [name, ...n] = process.argv.slice(2);
const [x0, y0, z0, x1, y1, z1] = n.map(Number);
const w = listWorlds().find((x) => x.dir === name || x.name === name || x.name.startsWith(name)) || { dir: name };
const s = new Session({ worldDir: w.dir });
const sel = { dim: 0, x0, y0, z0, x1, y1, z1 };

let t = Date.now();
const grid = O.buildGrid(s, sel, {});
console.log('grid', grid.dims.join('x'), 'in', Date.now() - t, 'ms');
const cls = O.classify(grid, s.models);
const names = ['air', 'terrain', 'wood', 'leaves', 'plant', 'built', 'attached'];
const byClass = {};
for (let id = 1; id < s.models.list.length; id++) (byClass[names[cls[id]]] = byClass[names[cls[id]]] || []).push(s.models.list[id].name.replace('minecraft:', ''));
for (const k of Object.keys(byClass)) console.log(' ', k + ':', [...new Set(byClass[k])].slice(0, 14).join(', '));

const found = new Map();
t = Date.now();
for (let x = x0 + 2; x <= x1; x += 4) for (let z = z0 + 2; z <= z1; z += 4) {
  const cell = O.castRay(grid, s.models, [x + 0.5, y1 + 5, z + 0.5], [0, -1, 0]);
  if (!cell) continue;
  const r = O.findObject(grid, s.models, cell);
  if (r.kind === 'terrain') continue;
  let sum = 0;
  for (let i = 0; i < r.x.length; i++) sum = (sum + r.x[i] * 31 + r.y[i] * 17 + r.z[i]) | 0;
  const key = r.kind + ':' + r.x.length + ':' + sum; // the same object is reached from many columns
  if (!found.has(key)) found.set(key, r);
}
console.log('picked', found.size, 'distinct objects in', Date.now() - t, 'ms');
const objs = [...found.values()].sort((a, b) => b.x.length - a.x.length);
for (const o of objs.slice(0, 8)) {
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < o.x.length; i++) { lo = [Math.min(lo[0], o.x[i]), Math.min(lo[1], o.y[i]), Math.min(lo[2], o.z[i])]; hi = [Math.max(hi[0], o.x[i]), Math.max(hi[1], o.y[i]), Math.max(hi[2], o.z[i])]; }
  console.log(' ', o.kind.padEnd(9), String(o.x.length).padStart(6), 'blocks  size', hi.map((v, i) => v - lo[i] + 1).join('x'), ' from', lo.join(','), ' mostly', o.main);
}

const quads = (opts, bounds) => {
  const m = s.mesher(bounds || sel, opts);
  let q = 0;
  for (const [cx, cz] of m.chunkList()) { const b = m.meshChunk(cx, cz); if (b) for (const qb of b.values()) q += qb.count; }
  return q;
};
const base = quads({});
for (const kind of ['structure', 'tree']) {
  const o = objs.find((x) => x.kind === kind);
  if (!o) continue;
  const edit = { x: o.x, y: o.y, z: o.z, ids: o.ids, offset: [0, 12, 0] };
  console.log(kind, '-> whole scene', base, 'faces | with it lifted 12 blocks', quads({ edits: [edit] }), '| it alone', quads({ only: Object.assign({}, edit, { offset: [0, 0, 0] }) }));
}
