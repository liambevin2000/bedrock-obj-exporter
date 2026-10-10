'use strict';
// Counts block entities and entities stored in a world: node tools/entities-probe.js "<world>"
const { listWorlds, World } = require('../src/core/world');
const { readNbt } = require('../src/core/nbt');

const arg = process.argv[2];
const w = listWorlds().find((x) => x.dir === arg || x.name === arg || x.name.startsWith(arg)) || { dir: arg };
const world = new World(w.dir);
const be = new Map(), ents = new Map(), samples = new Map();
let digp = 0, legacy = 0;
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const keys = [];
world.db.scanKeys((k) => {
  const s = k.toString('latin1');
  if (s.startsWith('actorprefix')) keys.push(Buffer.from(k));
  else if (s.startsWith('digp')) digp++;
  else if ((k.length === 9 || k.length === 13) && (k[k.length - 1] === 0x31 || k[k.length - 1] === 0x32)) keys.push(Buffer.from(k));
});
const seen = new Set();
for (const k of keys) {
  const id = k.toString('hex');
  if (seen.has(id)) continue;
  seen.add(id);
  const v = world.db.get(k);
  if (!v) continue;
  const isActor = k.toString('latin1').startsWith('actorprefix');
  const tag = k[k.length - 1];
  const pos = { p: 0 };
  try {
    while (pos.p < v.length) {
      const n = readNbt(v, pos);
      if (!n) break;
      if (isActor || tag === 0x32) {
        if (!isActor) legacy++;
        bump(ents, n.identifier || n.id);
        if (!samples.has(n.identifier)) samples.set(n.identifier, n);
      } else { bump(be, n.id); if (!samples.has('be:' + n.id)) samples.set('be:' + n.id, n); }
    }
  } catch (e) { /* truncated record */ }
}
const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map((e) => e.join(' ')).join(', ');
console.log('world:', w.name || w.dir);
console.log('block entities:', top(be) || 'none');
console.log('entities (digp chunks ' + digp + ', legacy ' + legacy + '):', top(ents) || 'none');
const show = process.argv.slice(3);
const json = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : ArrayBuffer.isView(v) ? `[${v.length} bytes]` : v));
for (const s of show) if (samples.has(s)) console.log('\n' + s + ':', json(samples.get(s)).slice(0, 1500));
