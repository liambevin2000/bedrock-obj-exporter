'use strict';
// In-game helper that loads chunks the world never saved. It is a tiny behavior pack written into
// the world itself: when the world is opened in Minecraft its script walks through the missing
// chunks with ticking areas, touches a block in each so the game saves it, and reports progress on
// the action bar. The exporter removes the pack again once the chunks are in the save.
const fs = require('fs');
const path = require('path');
const { comMojangRoots } = require('./world');

const PACK_UUID = '6f1c3b2e-9a4d-4e8b-b1f2-5c7d0e3a9b41';
const MODULE_UUID = 'a2d84f0c-3e6b-4c1a-9f57-0b8e2d6c4a13';
const FOLDER = 'bedrock_exporter_chunk_loader';
const DIM_IDS = ['overworld', 'nether', 'the_end'];
const BATCH = 10; // ticking areas hold at most 100 chunks: batches are 10 x 10 chunk tiles

const packDir = (worldDir) => path.join(worldDir, 'behavior_packs', FOLDER);
const listFile = (worldDir) => path.join(worldDir, 'world_behavior_packs.json');

// The game only sees worlds in its own worlds folder, not imported copies.
function canInstall(worldDir) {
  if (!worldDir || String(worldDir).startsWith('gallery:')) return { ok: false, reason: 'This is the built-in test scene.' };
  const dir = path.resolve(worldDir).toLowerCase();
  const inGame = comMojangRoots().some((r) => dir.startsWith(path.resolve(r, 'minecraftWorlds').toLowerCase() + path.sep));
  if (!inGame) return { ok: false, reason: 'This is an imported copy of the world, so Minecraft cannot see it. Open the world from your Minecraft worlds list to use this.' };
  return { ok: true };
}

function batches(chunks) {
  const tiles = new Map();
  for (const [cx, cz] of chunks) {
    const k = Math.floor(cx / BATCH) + ',' + Math.floor(cz / BATCH);
    const t = tiles.get(k) || [cx, cz, cx, cz, []];
    t[0] = Math.min(t[0], cx); t[1] = Math.min(t[1], cz); t[2] = Math.max(t[2], cx); t[3] = Math.max(t[3], cz);
    t[4].push(cx, cz);
    tiles.set(k, t);
  }
  return [...tiles.values()];
}

function readList(worldDir) {
  try { const v = JSON.parse(fs.readFileSync(listFile(worldDir), 'utf8').replace(/^﻿/, '')); return Array.isArray(v) ? v : []; } catch (e) { return null; }
}
const isOurs = (e) => e && String(e.pack_id).toLowerCase() === PACK_UUID;

// chunks: [[cx, cz], ...] in dimension dim (0 overworld, 1 nether, 2 end).
function install(worldDir, dim, chunks) {
  const check = canInstall(worldDir);
  if (!check.ok) throw new Error(check.reason);
  if (!chunks.length) throw new Error('No missing chunks in the selection.');
  const dir = packDir(worldDir);
  const prev = status(worldDir);
  // a higher version every time, also after the helper was removed, so the game never runs a cached copy
  const build = Math.max(prev ? prev.build + 1 : 1, Math.floor(Date.now() / 1000) - 1735689600); // seconds since 2025
  const version = [1, 0, build];
  const job = { id: `${Date.now().toString(36)}-${build}`, dim: DIM_IDS[dim] || 'overworld', total: chunks.length, batches: batches(chunks) };

  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    format_version: 2,
    header: {
      name: 'Bedrock Exporter chunk loader',
      description: 'Loads the chunks this world never saved so the Bedrock OBJ Exporter can read them. The exporter removes it again afterwards.',
      uuid: PACK_UUID, version, min_engine_version: [1, 21, 90],
    },
    modules: [{ type: 'script', language: 'javascript', uuid: MODULE_UUID, version: [1, 0, 0], entry: 'scripts/main.js' }],
    dependencies: [{ module_name: '@minecraft/server', version: '2.0.0' }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'scripts', 'main.js'), script(job));
  const createdList = prev ? prev.createdList : !fs.existsSync(listFile(worldDir));
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ build, dim, chunks, createdList, installedAt: Date.now() }));

  let list = readList(worldDir);
  if (list === null) {
    if (fs.existsSync(listFile(worldDir))) fs.copyFileSync(listFile(worldDir), listFile(worldDir) + '.bak'); // unreadable: keep it
    list = [];
  }
  list = list.filter((e) => !isOurs(e));
  list.unshift({ pack_id: PACK_UUID, version });
  fs.writeFileSync(listFile(worldDir), JSON.stringify(list, null, 2));
  return { chunks: chunks.length, batches: job.batches.length };
}

// null when the helper is not in this world, else { dim, chunks, build, createdList }.
function status(worldDir) {
  if (!worldDir || String(worldDir).startsWith('gallery:')) return null;
  try { return JSON.parse(fs.readFileSync(path.join(packDir(worldDir), 'job.json'), 'utf8')); } catch (e) { return null; }
}

function remove(worldDir) {
  const st = status(worldDir);
  const list = readList(worldDir);
  if (list) {
    const rest = list.filter((e) => !isOurs(e));
    if (!rest.length && st && st.createdList) fs.rmSync(listFile(worldDir), { force: true });
    else if (rest.length !== list.length) fs.writeFileSync(listFile(worldDir), JSON.stringify(rest, null, 2));
  }
  fs.rmSync(packDir(worldDir), { recursive: true, force: true });
  try { fs.rmdirSync(path.join(worldDir, 'behavior_packs')); } catch (e) { /* not empty: other packs live there */ }
  return true;
}

// The script that runs inside Minecraft. Plain stable @minecraft/server 2.x API, no experiments.
function script(job) {
  return `// Written by the Bedrock OBJ Exporter. Loads the chunks this world never saved, then it can be removed.
import { world, system } from '@minecraft/server';

const JOB = ${JSON.stringify(job)};
const SLOTS = 4;          // ticking areas used at once (a world can hold 10)
const SETTLE = 20;        // ticks to keep a batch loaded after it is ready
const GIVE_UP = 1200;     // ticks to wait for a batch before moving on

const say = (msg) => world.sendMessage('§e[Exporter]§r ' + msg);
const run = (dim, cmd) => { try { return dim.runCommand(cmd).successCount > 0; } catch (e) { return false; } };

let started = false;
function begin() {
  if (started) return;
  started = true;
  system.runTimeout(start, 40);
}
world.afterEvents.playerSpawn.subscribe((ev) => { if (ev.initialSpawn) begin(); });
system.run(() => { if (world.getAllPlayers().length) begin(); }); // after /reload

function start() {
  const dim = world.getDimension(JOB.dim);
  const doneKey = 'boe:' + JOB.id;
  let flags = world.getDynamicProperty(doneKey);
  if (typeof flags !== 'string' || flags.length !== JOB.batches.length) flags = '0'.repeat(JOB.batches.length);
  const done = flags.split('');
  if (!done.includes('0')) { say('§aAll ' + JOB.total + ' chunks were already loaded.§r Save & Quit, then click Reload world in the exporter.'); return; }
  for (let s = 0; s < SLOTS; s++) run(dim, 'tickingarea remove boeload' + s); // left over from a session that was quit early

  const pending = [];
  done.forEach((d, i) => { if (d === '0') pending.push(i); });
  const active = []; // { slot, i, since, ready }
  const free = [];
  for (let s = SLOTS - 1; s >= 0; s--) free.push(s);
  let slots = SLOTS, failed = 0, tick = 0;
  const minY = dim.heightRange.min;
  say('Loading ' + JOB.total + ' missing chunks. You can stay where you are; progress shows above the hotbar.');

  const chunkIsLoaded = (cx, cz) => { try { return !!dim.getBlock({ x: cx * 16 + 8, y: minY, z: cz * 16 + 8 }); } catch (e) { return false; } };
  // The game only writes chunks that changed: swap one bottom block out and back in.
  const touch = (cx, cz) => {
    try {
      const b = dim.getBlock({ x: cx * 16, y: minY, z: cz * 16 });
      if (!b) return;
      const was = b.typeId;
      if (was !== 'minecraft:bedrock' && was !== 'minecraft:air') return;
      b.setType('minecraft:barrier');
      b.setType(was);
    } catch (e) { /* not essential: the chunk may be saved anyway */ }
  };
  const chunksDone = () => { let n = 0; done.forEach((d, i) => { if (d === '1') n += JOB.batches[i][4].length / 2; }); return n; };

  const timer = system.runInterval(() => {
    tick += 10;
    while (pending.length && active.length < slots) {
      const i = pending[0], b = JOB.batches[i], slot = free.pop();
      const ok = run(dim, 'tickingarea add ' + b[0] * 16 + ' 0 ' + b[1] * 16 + ' ' + (b[2] * 16 + 15) + ' 0 ' + (b[3] * 16 + 15) + ' boeload' + slot);
      if (!ok) {
        free.push(slot);
        if (!active.length) {
          say('§cCould not add a ticking area.§r The world probably already has 10. Run /tickingarea remove_all, then leave and reopen the world.');
          system.clearRun(timer);
          return;
        }
        slots = active.length; // other ticking areas are taking the rest
        break;
      }
      pending.shift();
      active.push({ slot, i, since: tick, ready: 0 });
    }
    for (let a = active.length - 1; a >= 0; a--) {
      const job = active[a], c = JOB.batches[job.i][4];
      if (!job.ready) {
        let all = true;
        for (let k = 0; k < c.length && all; k += 2) all = chunkIsLoaded(c[k], c[k + 1]);
        if (all) { for (let k = 0; k < c.length; k += 2) touch(c[k], c[k + 1]); job.ready = tick; }
        else if (tick - job.since > GIVE_UP) { failed += c.length / 2; job.ready = -1; }
      }
      if (job.ready === -1 || (job.ready && tick - job.ready >= SETTLE)) {
        run(dim, 'tickingarea remove boeload' + job.slot);
        free.push(job.slot);
        done[job.i] = job.ready === -1 ? '2' : '1';
        active.splice(a, 1);
        world.setDynamicProperty(doneKey, done.join(''));
      }
    }
    const n = chunksDone();
    for (const p of world.getAllPlayers()) { try { p.onScreenDisplay.setActionBar('Exporter: loading missing chunks ' + n + ' / ' + JOB.total); } catch (e) { /* ignore */ } }
    if (!pending.length && !active.length) {
      system.clearRun(timer);
      if (failed) say('§6Loaded ' + (JOB.total - failed) + ' of ' + JOB.total + ' chunks; ' + failed + ' did not load in time.§r Save & Quit, click Reload world in the exporter, and run it again for the rest.');
      else say('§aDone: all ' + JOB.total + ' chunks are loaded.§r Save & Quit, then click Reload world in the exporter.');
    }
  }, 10);
}
`;
}

// Minecraft only looks for new add-ons when it starts, so a game that was already running when the
// helper was added will never run it. Returns null (not running) or the start time in ms.
function minecraftStartedAt() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }
    const cmd = "$p = Get-Process -Name 'Minecraft.Windows*' -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if ($p) { [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() }";
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 8000 }, (err, out) => {
      const t = Number(String(out || '').trim());
      resolve(!err && t > 0 ? t : null);
    });
  });
}

module.exports = { canInstall, install, status, remove, batches, minecraftStartedAt, PACK_UUID };
