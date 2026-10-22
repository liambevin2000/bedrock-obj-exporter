'use strict';
// Exports a 64 x 64 area around the player of each Java world given (or of every Java world found)
// and reports blocks that could not be drawn or use the missing-texture pattern.
//   node tools/java-world-check.js [world folder ...]
const os = require('os');
const path = require('path');
const { Session } = require('../src/core/exporter');
const { listJavaWorlds } = require('../src/core/java/install');

const dirs = process.argv.slice(2);
const worlds = dirs.length ? dirs.map((d) => ({ dir: d, name: path.basename(d) })) : listJavaWorlds();
for (const w of worlds) {
  const t0 = Date.now();
  let s;
  try {
    s = new Session({ worldDir: w.dir, extraPacks: [] });
    const scan = s.world.scan();
    const p = scan.player && scan.player.dim === 0 ? scan.player : null;
    const d = scan.dims[0];
    if (!d.count) { console.log(`${w.name}: no overworld chunks`); continue; }
    const cx = p ? Math.floor(p.x) : d.chunks[0] * 16 + 8, cz = p ? Math.floor(p.z) : d.chunks[1] * 16 + 8;
    const cy = p ? Math.floor(p.y) : 64;
    const sel = { dim: 0, x0: cx - 32, x1: cx + 31, z0: cz - 32, z1: cz + 31, y0: cy - 24, y1: cy + 24 };
    const r = s.exportObj(sel, path.join(os.tmpdir(), 'boe-java-check.obj'), { greedy: true });
    const missingTex = new Set();
    for (const m of s.models.list) if (m && m.quads && m.quads.some((q) => q.slot && q.slot.mat === s.res.missing)) missingTex.add(m.name);
    const info = s.packInfo();
    console.log(`${(w.instance || 'official') + ' / ' + w.name} (${s.world.version}, textures ${info.gameVersion}, ${info.mods} mods): ${scan.dims.map((x) => x.count).join('/')} chunks, ` +
      `${s.models.list.length - 1} block states, ${r.materials} materials, ${r.entities} entities, ${Date.now() - t0} ms`);
    const unknown = [...s.models.unknown.entries()];
    if (unknown.length) console.log('   not drawn:', unknown.slice(0, 12).map(([n, why]) => `${n} (${why})`).join('; '), unknown.length > 12 ? `... +${unknown.length - 12}` : '');
    if (missingTex.size) console.log('   missing textures:', [...missingTex].slice(0, 12).join(', '), missingTex.size > 12 ? `... +${missingTex.size - 12}` : '');
    const skipped = [...s.entities.skipped.entries()];
    if (skipped.length) console.log('   entities skipped:', skipped.map(([k, v]) => `${k} (${v})`).join('; '));
  } catch (e) {
    console.log(`${w.name}: ERROR ${e.stack}`);
  } finally { if (s) s.close(); }
}
