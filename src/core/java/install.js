'use strict';
// Where Java Edition keeps things on this PC: worlds of the official launcher and of the common
// third-party launchers (Prism, Modrinth, CurseForge), each instance's mods, and the game jars the
// textures and block models come from.
const fs = require('fs');
const path = require('path');
const { readNbtFile } = require('./nbt');

const appdata = () => process.env.APPDATA || '';
const home = () => process.env.USERPROFILE || process.env.HOME || '';

// Game folders that hold a "saves" folder: { dir, label, mods (folder or null) }.
function gameDirs() {
  const out = [];
  const add = (dir, label) => { if (fs.existsSync(path.join(dir, 'saves'))) out.push({ dir, label, mods: fs.existsSync(path.join(dir, 'mods')) ? path.join(dir, 'mods') : null }); };
  add(path.join(appdata(), '.minecraft'), null);
  const each = (root, fn) => { let ents = []; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; } for (const e of ents) if (e.isDirectory()) fn(path.join(root, e.name), e.name); };
  each(path.join(appdata(), 'PrismLauncher', 'instances'), (d, n) => { add(path.join(d, 'minecraft'), 'Prism: ' + n); add(path.join(d, '.minecraft'), 'Prism: ' + n); });
  each(path.join(appdata(), 'MultiMC', 'instances'), (d, n) => { add(path.join(d, 'minecraft'), 'MultiMC: ' + n); add(path.join(d, '.minecraft'), 'MultiMC: ' + n); });
  each(path.join(appdata(), 'ModrinthApp', 'profiles'), (d, n) => add(d, 'Modrinth: ' + n));
  each(path.join(appdata(), 'com.modrinth.theseus', 'profiles'), (d, n) => add(d, 'Modrinth: ' + n));
  each(path.join(home(), 'curseforge', 'minecraft', 'Instances'), (d, n) => add(d, 'CurseForge: ' + n));
  each(path.join(appdata(), '.tlauncher', 'legacy', 'Minecraft', 'game'), () => {});
  return out;
}

function isJavaWorld(dir) {
  return fs.existsSync(path.join(dir, 'level.dat')) && !fs.existsSync(path.join(dir, 'db'));
}

// Region folders of a world, by dimension: 0 overworld, 1 nether, 2 end.
// 26.x keeps every dimension under dimensions/<namespace>/<name>/; older worlds use region, DIM-1, DIM1.
function regionDirs(dir) {
  const pick = (...c) => c.find((d) => fs.existsSync(d)) || c[0];
  const dims = path.join(dir, 'dimensions', 'minecraft');
  return [
    pick(path.join(dims, 'overworld'), dir),
    pick(path.join(dims, 'the_nether'), path.join(dir, 'DIM-1')),
    pick(path.join(dims, 'the_end'), path.join(dir, 'DIM1')),
  ];
}

function levelInfo(dir) {
  try {
    const root = readNbtFile(path.join(dir, 'level.dat'));
    const d = root.Data || root;
    const v = d.Version || {};
    return { name: d.LevelName ? String(d.LevelName) : null, version: v.Name ? String(v.Name) : null, dataVersion: d.DataVersion | 0, data: d };
  } catch (e) { return { name: null, version: null, dataVersion: 0, data: null }; }
}

function describeJavaWorld(dir, game) {
  if (!isJavaWorld(dir)) return null;
  const info = levelInfo(dir);
  let modified = 0, size = 0;
  try { modified = fs.statSync(path.join(dir, 'level.dat')).mtimeMs; } catch (e) { /* ignore */ }
  for (const d of regionDirs(dir)) {
    try { for (const f of fs.readdirSync(path.join(d, 'region'))) size += fs.statSync(path.join(d, 'region', f)).size; } catch (e) { /* no such dimension yet */ }
  }
  const icon = path.join(dir, 'icon.png');
  return {
    dir, edition: 'java', name: info.name || path.basename(dir), modified, size,
    icon: fs.existsSync(icon) ? icon : null, version: info.version, dataVersion: info.dataVersion,
    instance: game ? game.label : null, mods: game ? game.mods : null,
  };
}

function listJavaWorlds() {
  const out = [];
  for (const g of gameDirs()) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(g.dir, 'saves'), { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const w = describeJavaWorld(path.join(g.dir, 'saves', e.name), g);
      if (w && w.size > 0) out.push(w);
    }
  }
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

// The instance a world folder belongs to (for its mods), when it sits in <game>/saves/<world>.
function gameOf(worldDir) {
  const saves = path.dirname(path.resolve(worldDir));
  if (path.basename(saves).toLowerCase() !== 'saves') return null;
  const dir = path.dirname(saves);
  const known = gameDirs().find((g) => path.resolve(g.dir).toLowerCase() === dir.toLowerCase());
  return known || { dir, label: null, mods: fs.existsSync(path.join(dir, 'mods')) ? path.join(dir, 'mods') : null };
}

// ---- game jars --------------------------------------------------------------------------------

// Every client jar found: [{ version, file }].
function gameJars() {
  const out = [];
  const seen = new Set();
  const add = (version, file) => { if (!seen.has(version) && fs.existsSync(file)) { seen.add(version); out.push({ version, file }); } };
  const versionsIn = (root) => { try { for (const v of fs.readdirSync(root)) add(v, path.join(root, v, v + '.jar')); } catch (e) { /* none */ } };
  versionsIn(path.join(appdata(), '.minecraft', 'versions'));
  versionsIn(path.join(appdata(), 'ModrinthApp', 'meta', 'versions'));
  versionsIn(path.join(appdata(), 'com.modrinth.theseus', 'meta', 'versions'));
  versionsIn(path.join(home(), 'curseforge', 'minecraft', 'Install', 'versions'));
  for (const root of [path.join(appdata(), 'PrismLauncher', 'libraries', 'com', 'mojang', 'minecraft'), path.join(appdata(), 'MultiMC', 'libraries', 'com', 'mojang', 'minecraft')]) {
    try { for (const v of fs.readdirSync(root)) add(v, path.join(root, v, `minecraft-${v}-client.jar`)); } catch (e) { /* none */ }
  }
  // loader versions ("fabric-loader-0.16-1.21.1", "1.21.1-0.16.10") are not vanilla jars
  return out.filter((j) => /^(\d+\.\d+(\.\d+)?)([-_ ](pre|rc|snapshot)[-_ ]?\d+)?$|^\d\dw\d\d[a-z]$/i.test(j.version) && fs.statSync(j.file).size > 1e6);
}

// Sort key: releases and their pre-releases in order; weekly snapshots ("25w46a") by date.
function versionKey(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-_ ](pre|rc|snapshot)[-_ ]?(\d+))?$/i.exec(v);
  if (m) {
    const major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3] || 0);
    const stage = !m[4] ? 3 : { snapshot: 0, pre: 1, rc: 2 }[m[4].toLowerCase()];
    // 1.x versions come before 26.x (the year-numbered scheme started in 2026)
    const base = major === 1 ? 2000 + minor * 10 + patch / 100 : major * 100 + minor + patch / 100;
    return base * 1000 + stage * 100 + Number(m[5] || 0) / 10;
  }
  const s = /^(\d\d)w(\d\d)([a-z])$/i.exec(v);
  if (s) { // 25w46a: between the 1.21 releases of that year
    const y = Number(s[1]), w = Number(s[2]);
    return (y < 26 ? 2000 + 210 + (y - 25) * 10 + w / 6 : y * 100 + w / 13) * 1000 + 50;
  }
  return 0;
}

// The jar for a world's version: that exact version, else the closest newer one, else the newest.
function jarFor(version) {
  const jars = gameJars();
  if (!jars.length) return null;
  const exact = jars.find((j) => j.version === version);
  if (exact) return exact;
  const want = versionKey(version || '');
  const sorted = jars.slice().sort((a, b) => versionKey(a.version) - versionKey(b.version));
  return sorted.find((j) => versionKey(j.version) >= want) || sorted[sorted.length - 1];
}

module.exports = { listJavaWorlds, describeJavaWorld, isJavaWorld, regionDirs, levelInfo, gameOf, gameJars, jarFor, versionKey };
