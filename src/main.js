'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const { listWorlds, describeWorld } = require('./core/world');
const { extractZip, findPacks } = require('./core/zip');

let win = null;

// ---- worker pool ------------------------------------------------------------------------------

class Client {
  constructor() {
    this.worker = new Worker(path.join(__dirname, 'worker.js'));
    this.pending = new Map(); this.nextId = 1; this.load = 0;
    this.worker.on('message', (m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.event) { if (p.onEvent) p.onEvent(m.event); return; }
      this.pending.delete(m.id); this.load--;
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    });
    this.worker.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear(); this.load = 0;
    });
  }
  call(cmd, args, onEvent) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, onEvent });
      this.load++;
      this.worker.postMessage({ id, cmd, args });
    });
  }
}

let mapWorkers = [], jobWorker = null;
function ensureWorkers() {
  if (jobWorker) return;
  jobWorker = new Client();
  const n = Math.max(2, Math.min(6, os.cpus().length - 2));
  for (let i = 0; i < n; i++) mapWorkers.push(new Client());
}
const allWorkers = () => [jobWorker, ...mapWorkers];

// ---- imports ----------------------------------------------------------------------------------

function importArchive(file) {
  const st = fs.statSync(file);
  const dest = path.join(app.getPath('userData'), 'imported', `${path.basename(file).replace(/[^\w.-]/g, '_')}-${st.size}-${Math.floor(st.mtimeMs)}`);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
    try { extractZip(file, dest); } catch (e) { fs.rmSync(dest, { recursive: true, force: true }); throw e; }
  }
  return dest;
}

function resolvePackPaths(p) {
  const dir = fs.statSync(p).isDirectory() ? p : importArchive(p);
  const packs = findPacks(dir, 'resources');
  return packs.length ? packs : findPacks(dir, null);
}

// ---- ipc --------------------------------------------------------------------------------------

function setupIpc() {
  ipcMain.handle('worlds', () => listWorlds());

  ipcMain.handle('open', async (e, a) => {
    ensureWorkers();
    const results = await Promise.all(allWorkers().map((w) => w.call('open', a)));
    return results[0];
  });

  ipcMain.handle('scan', () => jobWorker.call('scan'));

  ipcMain.handle('tile', (e, a) => {
    let best = mapWorkers[0];
    for (const w of mapWorkers) if (w.load < best.load) best = w;
    return best.call('tile', a);
  });

  // The reply carries the number of events sent, so the window can wait for stragglers (see preload).
  ipcMain.handle('job', async (e, a) => {
    let events = 0;
    const result = await jobWorker.call(a.cmd, a.args, (ev) => {
      if (!e.sender.isDestroyed()) { events++; e.sender.send('job-event', a.jobId, ev); }
    });
    return { result, events };
  });
  ipcMain.handle('cancel', () => jobWorker.call('cancel'));

  ipcMain.handle('pickPack', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add a resource pack',
      properties: ['openFile'],
      filters: [{ name: 'Resource packs', extensions: ['mcpack', 'mcaddon', 'zip'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return [];
    return resolvePackPaths(r.filePaths[0]);
  });
  ipcMain.handle('pickPackFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add a resource pack folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return [];
    return resolvePackPaths(r.filePaths[0]);
  });
  ipcMain.handle('resolveDrop', (e, p) => {
    // A dropped path can be a world folder, a .mcworld, or a pack (folder or archive).
    const isDir = fs.statSync(p).isDirectory();
    if (isDir && fs.existsSync(path.join(p, 'level.dat'))) return { world: describeWorld(p) };
    if (!isDir && /\.mcworld$/i.test(p)) {
      const dir = importArchive(p);
      return { world: describeWorld(dir) };
    }
    return { packs: resolvePackPaths(p) };
  });
  ipcMain.handle('pickWorld', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open a world',
      properties: ['openFile'],
      filters: [{ name: 'Minecraft worlds', extensions: ['mcworld', 'zip', 'dat'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const f = r.filePaths[0];
    const dir = /level\.dat$/i.test(f) ? path.dirname(f) : importArchive(f);
    return describeWorld(dir);
  });
  ipcMain.handle('pickWorldFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open a world folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    return describeWorld(r.filePaths[0]);
  });

  ipcMain.handle('saveObj', async (e, name) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Export OBJ',
      defaultPath: path.join(app.getPath('documents'), 'Bedrock OBJ Exports', name, name + '.obj'),
      filters: [{ name: 'Wavefront OBJ', extensions: ['obj'] }],
    });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('reveal', (e, p) => shell.showItemInFolder(p));

  // Cinema 4D: where the handoff goes, and making sure the importer plugin is installed.
  ipcMain.handle('c4dPrepare', () => {
    const dir = path.join(app.getPath('documents'), 'BedrockObjExporter', 'c4d-export');
    const src = path.join(__dirname, '..', 'c4d-plugin', 'BedrockWorldImporter.pyp');
    let r = { installed: [], updated: [] };
    try { r = require('./core/c4dinstall').installPlugin(path.join(app.getPath('appData'), 'Maxon'), src); } catch (err) { /* the export still works, the plugin can be added by hand */ }
    return { dir, pluginSource: src, installed: r.installed, updated: r.updated };
  });

  // In-game helper that loads the chunks a world never saved (see core/chunkloader).
  const loader = require('./core/chunkloader');
  ipcMain.handle('loaderStatus', (e, worldDir) => ({ ...loader.canInstall(worldDir), installed: loader.status(worldDir) }));
  ipcMain.handle('loaderInstall', (e, a) => loader.install(a.worldDir, a.dim, a.chunks));
  ipcMain.handle('loaderRemove', (e, worldDir) => loader.remove(worldDir));
  ipcMain.handle('minecraftStartedAt', () => loader.minecraftStartedAt());

  // Development hooks used by the automated self-test.
  ipcMain.handle('auto', () => {
    const a = process.argv.find((x) => x.startsWith('--auto='));
    try { return a ? JSON.parse(fs.readFileSync(a.slice(7), 'utf8').replace(/^﻿/, '')) : null; } catch (err) { console.log('auto config error', err.message); return null; }
  });
  ipcMain.handle('shot', async (e, file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let i = 0; i < 5; i++) {
      const img = await win.webContents.capturePage();
      if (!img.isEmpty()) { fs.writeFileSync(file, img.toPNG()); return true; }
      win.show(); win.moveTop();
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  });
  ipcMain.handle('appInfo', () => ({ version: runningVersion, update: updateState }));
  ipcMain.handle('restartApp', () => { app.relaunch(); app.quit(); });
  ipcMain.handle('openExternal', (e, url) => { if (/^https:\/\//.test(String(url))) shell.openExternal(url); });
  ipcMain.handle('input', (e, ev) => { win.webContents.sendInputEvent(ev); return true; });
  ipcMain.handle('quit', () => app.quit());
}

// ---- version and updates ------------------------------------------------------------------------
// boot.js sets global.BOE when the app is started through it; running src/main.js directly
// (older shortcut, tests) behaves like a plain install with updates off.
const boot = global.BOE || { bundled: path.join(__dirname, '..'), root: path.join(__dirname, '..'), updated: false };
const shellPackage = (() => { try { return JSON.parse(fs.readFileSync(path.join(boot.bundled, 'package.json'), 'utf8')); } catch (e) { return {}; } })();
const runningVersion = (() => {
  if (boot.updated) { try { return JSON.parse(fs.readFileSync(path.join(boot.root, 'release.json'), 'utf8')).version; } catch (e) { /* fall through */ } }
  return shellPackage.version || '0.0.0';
})();
let updateState = { status: 'off' };

async function checkUpdates() {
  const baseUrl = process.env.BOE_UPDATE_URL || (shellPackage.updates && shellPackage.updates.url) || '';
  if (!baseUrl || (!app.isPackaged && !process.env.BOE_UPDATES)) return;
  const { checkForUpdate } = require('./updater');
  updateState = await checkForUpdate({ baseUrl, userData: app.getPath('userData'), running: runningVersion, shell: shellPackage.version || '0.0.0', root: boot.root });
  if (process.argv.includes('--log')) console.log('[update]', JSON.stringify(updateState));
  if (win && !win.isDestroyed()) win.webContents.send('update-state', updateState);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 620,
    backgroundColor: '#15171c',
    title: 'Bedrock OBJ Exporter',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
  win.webContents.once('did-finish-load', () => { checkUpdates().catch(() => {}); });
  win.webContents.on('console-message', (e, level, message) => { if (process.argv.includes('--log')) console.log('[ui]', message); });
}

app.whenReady().then(() => { setupIpc(); createWindow(); });
app.on('window-all-closed', () => app.quit());
