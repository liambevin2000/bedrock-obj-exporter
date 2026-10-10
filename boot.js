'use strict';
// Entry point of the installed app. The app's own code (src/, c4d-plugin/) can be replaced by an
// update downloaded from GitHub (see src/updater.js); this file decides which copy to run:
// the newest downloaded one that is complete and newer than what shipped in the installer,
// otherwise the bundled one. It is the only part an update cannot change, so it stays tiny.
const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const bundled = __dirname;
const bundledVersion = require('./package.json').version;

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

function pickRoot() {
  // running from source: always the working copy, unless update testing is switched on
  if (!app.isPackaged && !process.env.BOE_UPDATES) return bundled;
  const dir = path.join(app.getPath('userData'), 'updates');
  let best = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      const root = path.join(dir, name);
      let rel;
      try { rel = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8')); } catch (e) { continue; }
      if (rel.version !== name || !newer(rel.version, bundledVersion) || fs.existsSync(path.join(root, '.bad'))) continue;
      // complete: every listed file is there
      if (!rel.files.every((f) => fs.existsSync(path.join(root, f.path)))) continue;
      if (!best || newer(rel.version, best.version)) best = { version: rel.version, root };
    }
  } catch (e) { /* no updates folder yet */ }
  if (!best) return bundled;
  // the update holds only our own code; libraries stay with the installed app
  const link = path.join(best.root, 'node_modules');
  try { if (!fs.existsSync(link)) fs.symlinkSync(path.join(bundled, 'node_modules'), link, 'junction'); } catch (e) { return bundled; }
  return best.root;
}

const root = pickRoot();
global.BOE = { bundled, bundledVersion, root, updated: root !== bundled };
try {
  require(path.join(root, 'src', 'main.js'));
} catch (e) {
  if (root === bundled) throw e;
  // a broken update must never stop the app from starting: mark it and use what was installed
  try { fs.writeFileSync(path.join(root, '.bad'), String(e && e.stack)); } catch (e2) { /* ignore */ }
  global.BOE = { bundled, bundledVersion, root: bundled, updated: false, failed: String(e && e.message) };
  require(path.join(bundled, 'src', 'main.js'));
  app.whenReady().then(() => dialog.showMessageBox({ type: 'warning', message: 'The last update could not be started, so the installed version is running instead.', detail: String(e && e.message) }));
}
