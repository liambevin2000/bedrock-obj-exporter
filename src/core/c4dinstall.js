'use strict';
// Installs the Cinema 4D importer plugin into every Cinema 4D preferences folder.
// The plugin lives in its own folder (plugins/BedrockWorldImporter/), the way Cinema 4D plugins are
// usually kept. A copy that is already in some folder is updated where it is, and every other copy
// is deleted: Cinema 4D loading the same plugin twice breaks other plugins (for example the Essential
// Cosmetic importer disappears). Earlier versions of the exporter left a loose copy in plugins/.
const fs = require('fs');
const path = require('path');

const NAME = 'BedrockWorldImporter';
const FILE = NAME + '.pyp';

// Every copy of the plugin in a plugins folder: loose, or up to two folders deep.
function findCopies(pluginsDir) {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.isFile() && e.name.toLowerCase() === FILE.toLowerCase()) out.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < 2) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(pluginsDir, 0);
  return out;
}

// Returns 'installed', 'updated', 'tidied' (only duplicates removed) or null (already right).
function installInto(pluginsDir, plugin) {
  const copies = findCopies(pluginsDir);
  const foldered = copies.filter((f) => path.dirname(f) !== pluginsDir);
  const target = foldered.find((f) => path.basename(path.dirname(f)) === NAME) || foldered[0] || path.join(pluginsDir, NAME, FILE);
  let result = null;
  let current = null;
  try { current = fs.readFileSync(target); } catch (e) { /* not there yet */ }
  if (!current || !current.equals(plugin)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, plugin);
    result = current || copies.length ? 'updated' : 'installed';
  }
  for (const f of copies) {
    if (f === target) continue;
    fs.rmSync(f, { force: true });
    const dir = path.dirname(f);
    if (dir !== pluginsDir) { try { fs.rmdirSync(dir); } catch (e) { /* other files in it */ } }
    result = result || 'tidied';
  }
  return result;
}

// maxonDir: %APPDATA%\Maxon. Returns { installed: [...versions], updated: [...versions] }.
function installPlugin(maxonDir, pluginFile) {
  const plugin = fs.readFileSync(pluginFile);
  const installed = [], updated = [];
  let dirs = [];
  try { dirs = fs.readdirSync(maxonDir); } catch (e) { return { installed, updated }; } // no Cinema 4D preferences
  for (const d of dirs) {
    if (!/^Maxon Cinema 4D /.test(d)) continue;
    const r = installInto(path.join(maxonDir, d, 'plugins'), plugin);
    const label = d.replace(/^Maxon /, '').replace(/_[0-9A-F]{8}(_\w)?$/, '');
    if (r === 'installed') installed.push(label);
    else if (r) updated.push(label);
  }
  return { installed, updated };
}

module.exports = { installPlugin, installInto, findCopies };
