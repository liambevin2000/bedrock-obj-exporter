'use strict';
// Reopens a world many times in one process (as "Reload world" does in every worker) and reports,
// each round, how many open archive files are still held and how many textures failed to load.
//   node tools/reload-test.js "<world>" [rounds] [sessions per round]
// count every file the app opens and closes, to see what is left open across reloads
const fs = require('fs');
let opened = 0, closed = 0;
const open0 = fs.openSync, close0 = fs.closeSync;
fs.openSync = function (...a) { const fd = open0.apply(fs, a); opened++; return fd; };
fs.closeSync = function (...a) { closed++; return close0.apply(fs, a); };
const { listWorlds, scanChunks } = require('../src/core/world');
const { Session } = require('../src/core/exporter');

const [arg, roundsArg, perArg] = process.argv.slice(2);
const rounds = Number(roundsArg || 12), per = Number(perArg || 7); // the app runs 7 workers
const w = listWorlds().find((x) => x.dir === arg || x.name === arg || x.name.startsWith(arg)) || { dir: arg };

let live = [];
for (let r = 1; r <= rounds; r++) {
  // "reload": every worker closes its session and opens a new one
  for (const s of live) s.close();
  live = [];
  let missing = 0, materials = 0, archivesOpen = 0;
  for (let i = 0; i < per; i++) {
    const s = new Session({ worldDir: w.dir });
    live.push(s);
    const d = scanChunks(s.world.db)[0];
    const c = d.chunks;
    // draw a few map tiles, as the map workers do
    for (let k = 0; k < Math.min(6, d.count); k++) s.mapTile(0, c[k * 4] >> 3, c[k * 4 + 1] >> 3, null);
    // what a preview touches too: entity, model and render-controller lookups
    s.res.clientEntity('minecraft:armor_stand'); s.res.renderController('controller.render.armor_stand'); s.res.geometry('geometry.armor_stand');
    materials += s.res.materials.length;
    missing += s.models.list.filter((m) => m.quads && m.quads.some((q) => q.slot.mat === s.res.missing)).length;
  }
  for (const s of live) for (const p of s.res.stack.packs) for (const a of p.archives.values()) if (a && a.fd !== undefined) archivesOpen++;
  console.log(`round ${String(r).padStart(2)}: ${opened - closed} files open in total, ${archivesOpen} held by the current sessions, ${missing} block models with missing textures`);
}
for (const s of live) s.close();
