'use strict';
// Background thread: owns one open world and answers map / preview / export requests.
const { parentPort } = require('worker_threads');
const { Session } = require('./core/exporter');
const { scanChunks, readLevelDat } = require('./core/world');

let session = null;
let pickGrid = null; // id grid of the selection being picked in, rebuilt when the selection or edits change
let lastScan = null; // chunk lists per dimension from the last scan
let jobToken = 0; // bumping this cancels the running preview/export

const tick = () => new Promise((r) => setImmediate(r));

const handlers = {
  open(a) {
    pickGrid = null; lastScan = null;
    if (session) { session.close(); session = null; }
    session = new Session({ worldDir: a.worldDir, extraPacks: a.extraPacks || [] });
    return { packs: session.packInfo() };
  },
  close() { jobToken++; if (session) { session.close(); session = null; } return true; },
  scan() {
    if (session.world.scan) { // Java worlds (and anything else that scans itself)
      const s = session.world.scan();
      lastScan = s.dims.map((d) => ({ chunks: new Int32Array(d.chunks) }));
      return { result: { dims: s.dims, player: s.player, spawn: s.spawn, edition: session.edition, minY: [0, 1, 2].map((d) => session.minY(d)) }, transfer: s.dims.map((d) => d.chunks.buffer) };
    }
    const dims = scanChunks(session.world.db);
    // kept for "locate" (the copy sent to the window is transferred away)
    lastScan = dims.map((d) => ({ chunks: new Int32Array(d.chunks) }));
    const ld = readLevelDat(session.world.dir) || {};
    const transfer = dims.map((d) => d.chunks.buffer);
    let player = null;
    try {
      const p = require('./core/nbt').readNbt(session.world.db.get(Buffer.from('~local_player')), { p: 0 });
      player = { x: p.Pos[0], y: p.Pos[1], z: p.Pos[2], dim: p.DimensionId | 0 };
    } catch (e) { /* no local player saved */ }
    return { result: { dims, player, spawn: [ld.SpawnX | 0, ld.SpawnY | 0, ld.SpawnZ | 0], edition: session.edition, minY: [0, 1, 2].map((d) => session.minY(d)) }, transfer };
  },
  tile(a) {
    const t = session.mapTile(a.dim, a.tx, a.tz, a.ceiling);
    if (t.empty) return { empty: true };
    return { result: { rgba: t.rgba, heights: t.heights }, transfer: [t.rgba.buffer, t.heights.buffer] };
  },
  cancel() { jobToken++; return true; },

  // Where biomes and recorded structures are, for the Locate panel.
  async locate(a, emit) {
    if (!lastScan) lastScan = session.world.scan ? session.world.scan().dims : scanChunks(session.world.db);
    const { locate } = require('./core/locate');
    const r = await locate(session, a.dim, lastScan[a.dim].chunks, async (done, total) => { emit({ type: 'progress', done, total }); await tick(); });
    return { result: r, transfer: r.biomes.map((b) => b.chunks.buffer) };
  },

  // Click-to-pick: finds the tree or structure under a ray through the previewed selection.
  pick(a) {
    const O = require('./core/objects');
    const key = a.gridKey;
    if (!pickGrid || pickGrid.key !== key) {
      const b = a.sel;
      if ((Math.abs(b.x1 - b.x0) + 1) * (Math.abs(b.y1 - b.y0) + 1) * (Math.abs(b.z1 - b.z0) + 1) > 250e6) throw new Error('The selection is too large to pick objects in. Shrink it first.');
      pickGrid = O.buildGrid(session, a.sel, { fill: a.fill, edits: a.edits });
      pickGrid.key = key;
    }
    const min = pickGrid.min, dims = pickGrid.dims;
    // a.cell re-picks from the block clicked before (when the ground level or trim box is adjusted)
    const cell = a.cell ? [a.cell[0] - min[0], a.cell[1] - min[1], a.cell[2] - min[2]] : O.castRay(pickGrid, session.models, a.origin, a.dir);
    if (!cell || cell.some((v, i) => v < 0 || v >= dims[i])) return { kind: 'none' };
    const opts = {};
    if (a.cut !== undefined && a.cut !== null) opts.minY = Math.max(0, a.cut - min[1] + 1); // ignore this world Y and below
    if (a.limit) {
      const l = a.limit;
      opts.limit = [l.x0 - min[0], l.y0 - min[1], l.z0 - min[2], l.x1 - min[0], l.y1 - min[1], l.z1 - min[2]];
    }
    const r = O.findObject(pickGrid, session.models, cell, opts);
    if (r.kind === 'terrain') return { kind: 'terrain' };
    r.seed = [cell[0] + min[0], cell[1] + min[1], cell[2] + min[2]];
    return { result: r, transfer: [r.x.buffer, r.y.buffer, r.z.buffer, r.ids.buffer] };
  },

  // Collision shapes and light levels for the previewed selection.
  voxels(a) {
    const { voxelize } = require('./core/voxels');
    const v = voxelize(session, a.sel, { light: a.light, fill: a.fill, edits: a.edits, only: a.only, noEntities: a.noEntities });
    const transfer = [v.shape.buffer];
    if (v.light) transfer.push(v.light.buffer);
    return { result: v, transfer };
  },

  // Streams the selection as geometry batches: { type:'batch', materials:[...new], groups:[{mat,pos,uv,count}] }
  async preview(a, emit) {
    const token = ++jobToken;
    const mesher = session.mesher(a.sel, { greedy: a.greedy, origin: a.origin, fill: a.fill, edits: a.edits, only: a.only, noEntities: a.noEntities });
    const chunks = mesher.chunkList();
    // nearest-to-centre first so the middle of the selection appears immediately
    const mx = (mesher.b.x0 + mesher.b.x1) / 32, mz = (mesher.b.z0 + mesher.b.z1) / 32;
    chunks.sort((p, q) => Math.hypot(p[0] - mx, p[1] - mz) - Math.hypot(q[0] - mx, q[1] - mz));
    const sent = new Set();
    let quads = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (token !== jobToken) return { cancelled: true };
      const batch = mesher.meshChunk(chunks[i][0], chunks[i][1]);
      if (batch) {
        const groups = [], materials = [], transfer = [];
        for (const [mat, qb] of batch) {
          if (!sent.has(mat)) {
            sent.add(mat);
            const m = session.res.materials[mat];
            const img = session.res.imageOf(m, a.simplify);
            materials.push({ id: mat, name: m.name, mode: m.mode, w: img.w, h: img.h, data: new Uint8Array(img.data) });
          }
          const pos = qb.pos.slice(0, qb.count * 12), uv = qb.uv.slice(0, qb.count * 8);
          groups.push({ mat, pos, uv, count: qb.count });
          transfer.push(pos.buffer, uv.buffer);
          quads += qb.count;
        }
        emit({ type: 'batch', materials, groups, done: i + 1, total: chunks.length }, transfer);
      } else if ((i & 15) === 0) emit({ type: 'progress', done: i + 1, total: chunks.length });
      await tick();
    }
    return { quads, chunks: chunks.length, size: [mesher.b.x1 - mesher.b.x0 + 1, mesher.height, mesher.b.z1 - mesher.b.z0 + 1], unknown: [...session.models.unknown.entries(), ...session.entities.skipped.entries()] };
  },

  // Same geometry as the OBJ export, written as the handoff the Cinema 4D plugin imports.
  async exportC4d(a, emit) {
    const token = ++jobToken;
    const { C4dWriter } = require('./core/c4dwriter');
    const mesher = session.mesher(a.sel, { greedy: a.greedy, fill: a.fill, edits: a.edits, only: a.only, noEntities: a.noEntities });
    const writer = new C4dWriter(a.dir, { name: a.name, scale: a.scale });
    const chunks = mesher.chunkList();
    for (let i = 0; i < chunks.length; i++) {
      if (token !== jobToken) return { cancelled: true };
      const batch = mesher.meshChunk(chunks[i][0], chunks[i][1]);
      if (batch) writer.add(batch);
      if ((i & 3) === 0) { emit({ type: 'progress', done: i + 1, total: chunks.length }); await tick(); }
    }
    const summary = writer.finish(session.res.materials, (m) => session.res.imageOf(m, a.simplify));
    summary.unknown = [...session.models.unknown.entries(), ...session.entities.skipped.entries()];
    return summary;
  },

  async export(a, emit) {
    const token = ++jobToken;
    const { ObjWriter } = require('./core/objwriter');
    const mesher = session.mesher(a.sel, { greedy: a.greedy, fill: a.fill, edits: a.edits, only: a.only, noEntities: a.noEntities });
    const writer = new ObjWriter(a.path, { scale: a.scale });
    const chunks = mesher.chunkList();
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (token !== jobToken) { writer.abort(); return { cancelled: true }; }
        const batch = mesher.meshChunk(chunks[i][0], chunks[i][1]);
        if (batch) writer.add(batch, session.res.materials);
        if ((i & 3) === 0) { emit({ type: 'progress', done: i + 1, total: chunks.length }); await tick(); }
      }
    } catch (e) { writer.abort(); throw e; }
    const summary = writer.finish(session.res.materials, (m) => session.res.imageOf(m, a.simplify));
    summary.unknown = [...session.models.unknown.entries(), ...session.entities.skipped.entries()];
    return summary;
  },
};

parentPort.on('message', async (msg) => {
  const { id, cmd, args } = msg;
  try {
    const emit = (data, transfer) => parentPort.postMessage({ id, event: data }, transfer || []);
    let r = await handlers[cmd](args || {}, emit);
    let transfer = [];
    if (r && r.transfer) { transfer = r.transfer; r = r.result; }
    parentPort.postMessage({ id, result: r }, transfer);
  } catch (e) {
    parentPort.postMessage({ id, error: (e && e.message) || String(e) });
  }
});
