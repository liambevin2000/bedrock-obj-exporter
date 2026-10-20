'use strict';
// High-level session: one open world with its resources, shared by the map, the preview and the export.
const { World, DIM_MIN_Y, biomeAt } = require('./world');
const TILE = 8; // map tile size in chunks
const { Resources } = require('./resources');
const { Models } = require('./models');
const { Mesher } = require('./mesher');
const { ObjWriter } = require('./objwriter');

class Session {
  // opts: { worldDir, extraPacks }
  constructor(opts) {
    this.opts = opts;
    const gallery = String(opts.worldDir).startsWith('gallery:'); // built-in test scene of block shapes
    this.world = gallery ? new (require('./gallery').GalleryWorld)() : new World(opts.worldDir);
    this.res = new Resources({ worldDir: gallery ? null : opts.worldDir, extraPacks: opts.extraPacks, db: this.world.db });
    this.models = new Models(this.res);
    this.entities = new (require('./entities').Entities)(this.res, this.models);
  }

  // sel: { dim, x0, y0, z0, x1, y1, z1 } inclusive. Origin is the centre of the footprint at its lowest layer.
  mesher(sel, opts = {}) {
    const bounds = normalise(sel);
    const origin = opts.origin || [Math.floor((bounds.x0 + bounds.x1 + 1) / 2), bounds.y0, Math.floor((bounds.z0 + bounds.z1 + 1) / 2)];
    return new Mesher(this.world, this.models, { dim: sel.dim || 0, bounds, origin, greedy: opts.greedy, fill: opts.fill, edits: opts.edits, only: opts.only,
      entities: opts.noEntities ? null : this.entities });
  }

  // Writes an OBJ. onProgress(done, total) may return false to cancel.
  exportObj(sel, objPath, opts = {}, onProgress) {
    const mesher = this.mesher(sel, opts);
    const writer = new ObjWriter(objPath, { scale: opts.scale });
    const chunks = mesher.chunkList();
    try {
      for (let i = 0; i < chunks.length; i++) {
        const batch = mesher.meshChunk(chunks[i][0], chunks[i][1]);
        if (batch) writer.add(batch, this.res.materials);
        if (onProgress && onProgress(i + 1, chunks.length) === false) { writer.abort(); return { cancelled: true }; }
      }
    } catch (e) { writer.abort(); throw e; }
    const summary = writer.finish(this.res.materials, (m) => this.res.imageOf(m, opts.simplify));
    summary.unknown = [...this.models.unknown.entries(), ...this.entities.skipped.entries()];
    summary.entities = mesher.entityCount;
    return summary;
  }

  // Representative colour of a model seen from above.
  _mapColor(model, biome) {
    let cache = model.mapColors;
    if (!cache) cache = model.mapColors = new Map();
    let c = cache.get(biome);
    if (c) return c;
    let slot = null;
    if (model.liquid) slot = model.slots[1];
    else if (model.full) slot = model.faces[1].slot;
    else if (model.quads.length) {
      let best = -2;
      for (const q of model.quads) if (q.n[1] > best) { best = q.n[1]; slot = q.slot; }
    }
    c = slot ? this.res.materialColor(this.models.material(slot, biome)) : [0, 0, 0];
    cache.set(biome, c);
    return c;
  }

  // Top-down view of TILE x TILE chunks. ceiling: ignore blocks above this Y (null = none).
  // Returns { rgba: Uint8ClampedArray, heights: Int16Array (-32768 = nothing), empty }.
  mapTile(dim, tx, tz, ceiling) {
    const N = TILE * 16;
    const rgba = new Uint8ClampedArray(N * N * 4);
    const heights = new Int16Array(N * N).fill(-32768);
    const minY = DIM_MIN_Y[dim] || 0;
    const list = this.models.list;
    let any = false;
    for (let j = 0; j < TILE; j++) {
      for (let i = 0; i < TILE; i++) {
        const cx = tx * TILE + i, cz = tz * TILE + j;
        const col = this.world.getColumnData(cx, cz, dim);
        if (!col) continue;
        let maxH = -32768;
        for (let k = 0; k < 256; k++) if (col.heights[k] > maxH) maxH = col.heights[k];
        let top = maxH + minY + 16;
        if (ceiling !== null && ceiling !== undefined && ceiling < top) top = ceiling;
        let remaining = 256;
        const found = new Uint8Array(256);
        for (let sy = top >> 4; sy >= minY >> 4 && remaining > 0; sy--) {
          const sc = this.world.getSubChunk(cx, cz, dim, sy);
          if (!sc || !sc.layers.length) continue;
          const l0 = sc.layers[0];
          const ids = l0.palette.map((e) => this.models.idFor(e));
          if (ids.length === 1 && ids[0] === 0) continue;
          const yStart = Math.min(15, top - sy * 16);
          for (let x = 0; x < 16; x++) {
            for (let z = 0; z < 16; z++) {
              const k = z * 16 + x;
              if (found[k]) continue;
              const base = (x << 8) | (z << 4);
              for (let y = yStart; y >= 0; y--) {
                const id = ids[l0.indices[base | y]];
                if (id === 0 || list[id].invisible) continue;
                const wy = sy * 16 + y;
                const c = this._mapColor(list[id], biomeAt(col, x, wy, z, minY));
                const o = ((j * 16 + z) * N + i * 16 + x) * 4;
                rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
                heights[(j * 16 + z) * N + i * 16 + x] = wy;
                found[k] = 1; remaining--; any = true;
                break;
              }
            }
          }
        }
      }
    }
    if (any) { // relief shading from the height difference to the north-west
      for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
          const h = heights[z * N + x];
          if (h === -32768) continue;
          const hn = z > 0 ? heights[(z - 1) * N + x] : h, hw = x > 0 ? heights[z * N + x - 1] : h;
          let d = (hn === -32768 ? 0 : h - hn) + (hw === -32768 ? 0 : h - hw);
          d = d > 3 ? 3 : d < -3 ? -3 : d;
          const f = 1 + d * 0.07 + ((h & 1) ? 0.015 : 0);
          const o = (z * N + x) * 4;
          rgba[o] *= f; rgba[o + 1] *= f; rgba[o + 2] *= f;
        }
      }
    }
    return { rgba, heights, empty: !any };
  }

  packInfo() {
    const r = this.res;
    return {
      vanilla: r.hasVanilla, gameData: r.gameData,
      resourcePacks: r.worldResourcePacks.map((p) => ({ name: p.name, dir: p.dir })),
      behaviorPacks: r.worldBehaviorPacks.map((p) => ({ name: p.name, dir: p.dir })),
      extraPacks: r.extraPacks.map((p) => ({ name: p.name, dir: p.dir })),
      missing: r.missingPacks,
    };
  }

  close() { this.world.close(); this.res.close(); }
}

function normalise(s) {
  return {
    x0: Math.min(s.x0, s.x1), x1: Math.max(s.x0, s.x1),
    y0: Math.min(s.y0, s.y1), y1: Math.max(s.y0, s.y1),
    z0: Math.min(s.z0, s.z1), z1: Math.max(s.z0, s.z1),
  };
}

module.exports = { Session, normalise, DIM_MIN_Y, TILE };
