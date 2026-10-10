'use strict';
// Shows how an entity is defined in a world's packs: node tools/entity-def.js "<world>" <identifier>
const { listWorlds } = require('../src/core/world');
const { Session } = require('../src/core/exporter');
const { parseJson } = require('../src/core/packs');

const [arg, id] = process.argv.slice(2);
const w = listWorlds().find((x) => x.dir === arg || x.name === arg || x.name.startsWith(arg)) || { dir: arg };
const s = new Session({ worldDir: w.dir });
const cut = (o, n) => JSON.stringify(o).slice(0, n);
const find = (packs, dir, test) => {
  for (const p of [...packs].reverse()) for (const f of p.list(dir)) {
    if (!f.endsWith('.json')) continue;
    const buf = p.read(f);
    if (!buf || !buf.includes(id)) continue;
    try { const j = parseJson(buf.toString('utf8')); const hit = test(j); if (hit) return { pack: p.name, file: f, json: hit }; } catch (e) { /* skip */ }
  }
  return null;
};
const rp = find(s.res.stack.packs, 'entity', (j) => (j['minecraft:client_entity'] && j['minecraft:client_entity'].description.identifier === id ? j['minecraft:client_entity'].description : null));
console.log('client entity:', rp ? rp.pack + ' / ' + rp.file : 'not found');
if (rp) console.log(cut(rp.json, 1500));
const bp = find(s.res.worldBehaviorPacks, 'entities', (j) => (j['minecraft:entity'] && j['minecraft:entity'].description.identifier === id ? j['minecraft:entity'] : null));
console.log('\nbehavior entity:', bp ? bp.pack + ' / ' + bp.file : 'not found');
if (bp) {
  const comps = Object.keys(bp.json.components || {});
  const groups = Object.values(bp.json.component_groups || {}).flatMap((g) => Object.keys(g));
  console.log('components:', comps.join(', '));
  console.log('in groups:', [...new Set(groups)].join(', '));
  console.log('properties:', cut(bp.json.description.properties || {}, 400));
}
if (rp && rp.json.render_controllers) {
  for (const rc of rp.json.render_controllers) {
    const name = typeof rc === 'string' ? rc : Object.keys(rc)[0];
    for (const p of [...s.res.stack.packs].reverse()) {
      let done = false;
      for (const f of p.list('render_controllers')) {
        const buf = p.read(f);
        if (!buf || !buf.includes(name)) continue;
        try { const j = parseJson(buf.toString('utf8')); const c = j.render_controllers && j.render_controllers[name]; if (c) { console.log('\nrender controller', name + ':', cut(c, 900)); done = true; break; } } catch (e) { /* skip */ }
      }
      if (done) break;
    }
  }
}
