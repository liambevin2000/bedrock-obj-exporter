'use strict';
// Checks the in-game chunk loader helper on a throwaway world: install, reinstall, remove, and that
// the generated script parses. Usage: node tools/loader-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boe-loader-'));
const worldDir = path.join(root, 'minecraftWorlds', 'test world');
fs.mkdirSync(worldDir, { recursive: true });
fs.writeFileSync(path.join(worldDir, 'level.dat'), '');
const world = require('../src/core/world');
world.comMojangRoots = () => [root]; // before chunkloader takes its copy
const loader = require('../src/core/chunkloader');

let failures = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); if (!ok) failures++; };
const list = () => (fs.existsSync(path.join(worldDir, 'world_behavior_packs.json')) ? JSON.parse(fs.readFileSync(path.join(worldDir, 'world_behavior_packs.json'), 'utf8')) : null);

try {
  check('imported copies are refused', !loader.canInstall(path.join(root, 'elsewhere')).ok);
  check('worlds in the game folder are accepted', loader.canInstall(worldDir).ok);

  const chunks = [];
  for (let x = -3; x < 22; x++) for (let z = 5; z < 9; z++) chunks.push([x, z]);
  const r = loader.install(worldDir, 0, chunks);
  check('install', r.chunks === chunks.length, `${r.chunks} chunks in ${r.batches} batches`);
  check('every batch fits one ticking area', loader.batches(chunks).every((b) => (b[2] - b[0] + 1) * (b[3] - b[1] + 1) <= 100));
  check('batches cover every chunk once', loader.batches(chunks).reduce((n, b) => n + b[4].length / 2, 0) === chunks.length);
  let l = list();
  check('listed in world_behavior_packs.json', l && l.length === 1 && l[0].pack_id === loader.PACK_UUID);
  const firstBuild = l[0].version[2];
  check('records when it was added', Math.abs(loader.status(worldDir).installedAt - Date.now()) < 5000);

  const pack = path.join(worldDir, 'behavior_packs', 'bedrock_exporter_chunk_loader');
  const mjs = path.join(root, 'main.mjs');
  fs.copyFileSync(path.join(pack, 'scripts', 'main.js'), mjs);
  let parsed = true;
  try { execFileSync(process.execPath, ['--check', mjs], { stdio: 'pipe' }); } catch (e) { parsed = false; console.log(String(e.stderr)); }
  check('generated script parses', parsed);

  // another pack the user had, then a reinstall: theirs is kept, ours moves to a new version
  fs.writeFileSync(path.join(worldDir, 'world_behavior_packs.json'), JSON.stringify([...list(), { pack_id: 'user-pack', version: [1, 0, 0] }]));
  loader.install(worldDir, 1, chunks.slice(0, 5));
  l = list();
  const manifest = JSON.parse(fs.readFileSync(path.join(pack, 'manifest.json'), 'utf8'));
  check('reinstall bumps the version', manifest.header.version[2] === firstBuild + 1 && l[0].version[2] === firstBuild + 1);
  check('reinstall keeps other packs', l.length === 2 && l[1].pack_id === 'user-pack');
  check('status reports the new job', loader.status(worldDir).dim === 1 && loader.status(worldDir).chunks.length === 5);

  loader.remove(worldDir);
  l = list();
  check('remove leaves the user\'s packs', l && l.length === 1 && l[0].pack_id === 'user-pack');
  check('remove deletes the pack folder', !fs.existsSync(pack));
  check('status is empty afterwards', loader.status(worldDir) === null);

  // a world with no pack list before: removing leaves no trace (and a later re-add gets a higher version)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100);
  fs.rmSync(path.join(worldDir, 'world_behavior_packs.json'));
  loader.install(worldDir, 0, chunks);
  check('adding it again after removal still raises the version', list()[0].version[2] > firstBuild + 1);
  loader.remove(worldDir);
  check('no leftovers in a world that had no packs', !fs.existsSync(path.join(worldDir, 'world_behavior_packs.json')) && !fs.existsSync(path.join(worldDir, 'behavior_packs')));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
