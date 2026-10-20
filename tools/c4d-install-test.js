'use strict';
// Checks where the Cinema 4D plugin gets installed, on throwaway preference folders.
// Usage: node tools/c4d-install-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installPlugin } = require('../src/core/c4dinstall');

const src = path.join(__dirname, '..', 'c4d-plugin', 'BedrockWorldImporter.pyp');
const plugin = fs.readFileSync(src);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boe-c4d-'));
const pl = (v) => path.join(root, `Maxon Cinema 4D ${v}_1ABCDC12`, 'plugins');
const put = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const files = (dir) => {
  const out = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/'); else out.push(rel + e.name); } };
  walk(dir, '');
  return out.sort().join(', ');
};
let failures = 0;
const check = (name, got, want) => { const ok = got === want; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got:  ${got}\n     want: ${want}`}`); if (!ok) failures++; };

try {
  // the coworker's set-up: plugins in folders, plus the loose copy older versions added
  put(path.join(pl('2026'), 'BedrockWorldImporter', 'BedrockWorldImporter.pyp'), 'old');
  put(path.join(pl('2026'), 'BedrockWorldImporter.pyp'), 'old');
  put(path.join(pl('2026'), 'EssentialCosmeticImporter', 'EssentialCosmeticImporter.pyp'), 'essential');
  // nothing installed yet
  fs.mkdirSync(pl('2025'), { recursive: true });
  // only the old loose copy
  put(path.join(pl('2024'), 'BedrockWorldImporter.pyp'), 'old');
  // kept in a folder of their own choosing
  put(path.join(pl('R26'), 'My Plugins', 'BedrockWorldImporter.pyp'), 'old');
  put(path.join(pl('R26'), 'My Plugins', 'other.pyp'), 'x');

  const r = installPlugin(root, src);
  check('coworker layout: loose copy gone, folder copy updated, Essential untouched', files(pl('2026')), 'BedrockWorldImporter/BedrockWorldImporter.pyp, EssentialCosmeticImporter/EssentialCosmeticImporter.pyp');
  check('fresh install goes into its own folder', files(pl('2025')), 'BedrockWorldImporter/BedrockWorldImporter.pyp');
  check('old loose copy moves into a folder', files(pl('2024')), 'BedrockWorldImporter/BedrockWorldImporter.pyp');
  check('a folder the user chose is kept', files(pl('R26')), 'My Plugins/BedrockWorldImporter.pyp, My Plugins/other.pyp');
  check('installed copies are the current plugin', [pl('2026') + '/BedrockWorldImporter', pl('2025') + '/BedrockWorldImporter', pl('2024') + '/BedrockWorldImporter', pl('R26') + '/My Plugins']
    .every((d) => fs.readFileSync(path.join(d, 'BedrockWorldImporter.pyp')).equals(plugin)) + '', 'true');
  check('Essential plugin content untouched', fs.readFileSync(path.join(pl('2026'), 'EssentialCosmeticImporter', 'EssentialCosmeticImporter.pyp'), 'utf8'), 'essential');
  check('reported', JSON.stringify(r), JSON.stringify({ installed: ['Cinema 4D 2025'], updated: ['Cinema 4D 2024', 'Cinema 4D 2026', 'Cinema 4D R26'] }));
  check('second run changes nothing', JSON.stringify(installPlugin(root, src)), JSON.stringify({ installed: [], updated: [] }));
  put(path.join(pl('2026'), 'BedrockWorldImporter.pyp'), plugin);
  installPlugin(root, src);
  check('an identical loose duplicate is still removed', files(pl('2026')), 'BedrockWorldImporter/BedrockWorldImporter.pyp, EssentialCosmeticImporter/EssentialCosmeticImporter.pyp');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
