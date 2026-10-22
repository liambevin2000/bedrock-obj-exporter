'use strict';
// Builds geometry for a region one chunk column at a time, so memory stays flat and results can stream.
const Q = require('./quads');
const { biomeAt, DIM_MIN_Y } = require('./world');

const W = 18; // 16 blocks plus a one block border for neighbour lookups

class QuadBuffer {
  constructor() { this.pos = new Float32Array(12 * 256); this.uv = new Float32Array(8 * 256); this.count = 0; }
  push(p, ox, oy, oz, uv) {
    const n = this.count;
    if ((n + 1) * 12 > this.pos.length) {
      const np = new Float32Array(this.pos.length * 2); np.set(this.pos); this.pos = np;
      const nu = new Float32Array(this.uv.length * 2); nu.set(this.uv); this.uv = nu;
    }
    const a = this.pos, o = n * 12;
    a[o] = p[0] + ox; a[o + 1] = p[1] + oy; a[o + 2] = p[2] + oz;
    a[o + 3] = p[3] + ox; a[o + 4] = p[4] + oy; a[o + 5] = p[5] + oz;
    a[o + 6] = p[6] + ox; a[o + 7] = p[7] + oy; a[o + 8] = p[8] + oz;
    a[o + 9] = p[9] + ox; a[o + 10] = p[10] + oy; a[o + 11] = p[11] + oz;
    this.uv.set(uv, n * 8);
    this.count = n + 1;
  }
}

function tileUV(d, x, y, z) {
  switch (d) {
    case 0: return [x, -z];
    case 1: return [x, z];
    case 2: return [-x, -y];
    case 3: return [x, -y];
    case 4: return [z, -y];
    default: return [-z, -y];
  }
}

class Mesher {
  // opts: { dim, bounds: {x0,y0,z0,x1,y1,z1} inclusive, origin: [x,y,z], greedy }
  constructor(world, models, opts) {
    this.world = world; this.models = models;
    this.dim = opts.dim || 0;
    this.b = opts.bounds; this.origin = opts.origin || [0, 0, 0];
    this.greedy = opts.greedy !== false;
    this.fill = !!opts.fill;            // estimate chunks the game never saved
    this.estimates = new Map(); this.edges = new Map(); this.decor = new Map();
    this.entities = opts.entities || null; this.entityCount = 0; // scenery entities (see entities.js)
    this.ops = null; this.only = !!opts.only; this.edited = new Map();
    if (opts.only || (opts.edits && opts.edits.length)) this._prepareEdits(opts.edits || [], opts.only); this.groundish = []; this.estimated = 0;
    this.minY = opts.minY !== undefined ? opts.minY : DIM_MIN_Y[this.dim] || 0;
    this.chunks = new Map(); // decoded chunk cache
    this.cacheLimit = 12;
    this.height = this.b.y1 - this.b.y0 + 1;
    this.H = this.height + 2;
    this.ids = new Uint16Array(W * W * this.H);
    this.wet = new Uint8Array(W * W * this.H);
    this.waterModel = null;
  }

  chunkList() {
    const out = [];
    for (let cz = this.b.z0 >> 4; cz <= this.b.z1 >> 4; cz++) for (let cx = this.b.x0 >> 4; cx <= this.b.x1 >> 4; cx++) out.push([cx, cz]);
    return out;
  }

  // ---- edits: moved and isolated objects ---------------------------------------------------------
  // edits: [{ x, y, z (world blocks), ids, offset: [dx,dy,dz] }] - each object is cut from where it
  // is and pasted at its offset, in order. only: one such object, shown alone with nothing else.
  _prepareEdits(edits, only) {
    this.ops = new Map(); // chunk key -> flat [kind, localX, worldY, localZ, id, ...]; kind 0 clear, 1 set
    const push = (kind, x, y, z, id) => {
      const key = (x >> 4) + ',' + (z >> 4);
      let a = this.ops.get(key);
      if (!a) this.ops.set(key, a = []);
      a.push(kind, x & 15, y, z & 15, id);
    };
    for (const e of only ? [only] : edits) {
      const o = e.offset || [0, 0, 0], n = e.x.length;
      if (!only) for (let i = 0; i < n; i++) push(0, e.x[i], e.y[i], e.z[i], 0);
      for (let i = 0; i < n; i++) push(1, e.x[i] + o[0], e.y[i] + o[1], e.z[i] + o[2], e.ids[i]);
    }
  }

  _decode(cx, cz) {
    if (!this.ops) return this._decodeBase(cx, cz);
    const key = cx + ',' + cz;
    let c = this.edited.get(key);
    if (c) return c;
    const base = this.only ? { subs: new Map(), col: this._decodeReal(cx, cz).col } : this._decodeBase(cx, cz);
    const ops = this.ops.get(key);
    if (!ops) c = base;
    else {
      const subs = new Map(base.subs), owned = new Set();
      const sub = (sy, create) => {
        let s = subs.get(sy);
        if (!s) { if (!create) return null; s = { ids: new Uint16Array(4096), wet: null }; subs.set(sy, s); owned.add(sy); }
        else if (!owned.has(sy)) { s = { ids: new Uint16Array(s.ids), wet: s.wet ? new Uint8Array(s.wet) : null }; subs.set(sy, s); owned.add(sy); }
        return s;
      };
      for (let i = 0; i < ops.length; i += 5) {
        const y = ops[i + 2], idx = (ops[i + 1] << 8) | (ops[i + 3] << 4) | (y & 15);
        const s = sub(y >> 4, ops[i] === 1);
        if (!s) continue;
        s.ids[idx] = ops[i + 4];
        if (s.wet) s.wet[idx] = 0;
      }
      c = { subs, col: base.col || this._decodeReal(cx, cz).col, estimated: base.estimated };
    }
    this.edited.set(key, c);
    if (this.edited.size > this.cacheLimit) this.edited.delete(this.edited.keys().next().value);
    return c;
  }

  _decodeBase(cx, cz) {
    const c = this._decodeReal(cx, cz);
    if (!this.fill || c.subs.size) return c;
    const key = cx + ',' + cz;
    let e = this.estimates.get(key);
    if (e === undefined) {
      e = this._estimate(cx, cz) || c;
      this.estimates.set(key, e);
      if (this.estimates.size > this.cacheLimit) this.estimates.delete(this.estimates.keys().next().value);
    }
    return e;
  }

  // ---- gap filling (experimental) ---------------------------------------------------------------
  // A chunk the game never saved is rebuilt from the nearest saved chunks around it: ground height
  // is blended between them and each column copies the ground layers of its nearest real column.
  // Trees, plants and buildings are not invented; water keeps its level.

  _isGround(id) {
    let g = this.groundish[id];
    if (g === undefined) {
      const m = this.models.list[id];
      g = this.groundish[id] = m.opaque && !/log|wood|leaves|stem|planks|mushroom_block|hyphae|bamboo/.test(m.name) ? 1 : 0;
    }
    return g === 1;
  }

  // The 16 columns along one side of a saved chunk. side: 0 west (x=0), 1 east (x=15), 2 north (z=0), 3 south (z=15)
  _edge(cx, cz, side) {
    const key = cx + ',' + cz + ',' + side;
    let e = this.edges.get(key);
    if (e !== undefined) return e;
    const c = this._decodeReal(cx, cz);
    e = null;
    if (c.subs.size) {
      const b = this.b, H = this.height, list = this.models.list;
      e = [];
      for (let i = 0; i < 16; i++) {
        const x = side === 0 ? 0 : side === 1 ? 15 : i, z = side === 2 ? 0 : side === 3 ? 15 : i;
        const col = new Uint16Array(H), wet = new Uint8Array(H);
        for (const [sy, sub] of c.subs) {
          const y0 = Math.max(b.y0, sy * 16), y1 = Math.min(b.y1, sy * 16 + 15), base = (x << 8) | (z << 4);
          for (let y = y0; y <= y1; y++) { col[y - b.y0] = sub.ids[base | (y & 15)]; if (sub.wet) wet[y - b.y0] = sub.wet[base | (y & 15)]; }
        }
        let ground = -1;
        for (let y = H - 1; y >= 0; y--) if (col[y] && this._isGround(col[y])) { ground = y; break; }
        // Water above the ground, including the water that waterlogged plants (seagrass, kelp) stand in.
        let liquidTop = -1, liquid = 0;
        if (ground >= 0) {
          let top = ground;
          while (top + 1 < H && ((col[top + 1] && list[col[top + 1]].liquid) || wet[top + 1])) {
            top++;
            if (!liquid && col[top] && list[col[top]].liquid) liquid = col[top];
          }
          if (top > ground) { liquidTop = top; if (!liquid) liquid = this._waterId(); }
        }
        e.push({ col, ground, liquid, liquidTop });
      }
    }
    this.edges.set(key, e);
    if (this.edges.size > 256) this.edges.delete(this.edges.keys().next().value);
    return e;
  }

  _waterId() {
    const id = this.models.idFor({ name: 'minecraft:water', states: { liquid_depth: 0 } });
    if (!this.waterModel) this.waterModel = this.models.list[id];
    return id;
  }

  // What grows on each kind of ground in a saved chunk, kept apart for dry land and under water:
  // (ground block * 2 + underwater) -> { bare, plants: [[id, upperId]] }.
  // Used to scatter the same grass and flowers, at the same density, over estimated chunks.
  _decor(cx, cz) {
    const key = cx + ',' + cz;
    let d = this.decor.get(key);
    if (d) return d;
    d = new Map();
    const c = this._decodeReal(cx, cz), b = this.b, list = this.models.list;
    const at = (base, wy) => { const s = c.subs.get(wy >> 4); return s ? s.ids[base | (wy & 15)] : 0; };
    const wetAt = (base, wy) => { const s = c.subs.get(wy >> 4); return s && s.wet ? s.wet[base | (wy & 15)] : 0; };
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        const base = (x << 8) | (z << 4);
        for (let wy = b.y1 - 1; wy >= b.y0; wy--) {
          const id = at(base, wy);
          if (!id || !this._isGround(id)) continue;
          const above = at(base, wy + 1);
          const liquidAbove = above && list[above].liquid;
          const k = id * 2 + (liquidAbove || wetAt(base, wy + 1) ? 1 : 0);
          let e = d.get(k);
          if (!e) d.set(k, e = { bare: 0, plants: [] });
          if (!above || liquidAbove) e.bare++;
          else if (list[above].sink) { const up = wy + 2 <= b.y1 ? at(base, wy + 2) : 0; e.plants.push([above, up && list[up].sink ? up : 0]); }
          break; // only the topmost ground block of the column counts
        }
      }
    }
    this.decor.set(key, d);
    if (this.decor.size > 64) this.decor.delete(this.decor.keys().next().value);
    return d;
  }

  _estimate(cx, cz) {
    const REACH = 6;
    // nearest saved chunk in each direction, and how many missing chunks lie in between
    const find = (dx, dz, side) => {
      for (let k = 1; k <= REACH; k++) { const e = this._edge(cx + dx * k, cz + dz * k, side); if (e) return { e, gap: (k - 1) * 16, chunk: [cx + dx * k, cz + dz * k] }; }
      return null;
    };
    const W = find(-1, 0, 1), E = find(1, 0, 0), N = find(0, -1, 3), S = find(0, 1, 2);
    if (!W && !E && !N && !S) return null;
    const b = this.b, H = this.height;
    // plants found on the surrounding saved chunks, pooled per ground block
    const flora = new Map();
    for (const n of [W, E, N, S]) {
      if (!n) continue;
      for (const [g, e] of this._decor(n.chunk[0], n.chunk[1])) {
        let f = flora.get(g);
        if (!f) flora.set(g, f = { bare: 0, plants: [] });
        f.bare += e.bare;
        for (const p of e.plants) f.plants.push(p);
      }
    }
    const subs = new Map();
    const sub = (sy) => { let s = subs.get(sy); if (!s) { s = { ids: new Uint16Array(4096), wet: null }; subs.set(sy, s); } return s; };
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        const cands = [];
        if (W && W.e[z].ground >= 0) cands.push([W.e[z], x + 1 + W.gap]);
        if (E && E.e[z].ground >= 0) cands.push([E.e[z], 16 - x + E.gap]);
        if (N && N.e[x].ground >= 0) cands.push([N.e[x], z + 1 + N.gap]);
        if (S && S.e[x].ground >= 0) cands.push([S.e[x], 16 - z + S.gap]);
        if (!cands.length) continue;
        let hs = 0, ws = 0, src = cands[0];
        for (const c of cands) { const wgt = 1 / (c[1] * c[1]); hs += c[0].ground * wgt; ws += wgt; if (c[1] < src[1]) src = c; }
        const h = Math.round(hs / ws), s = src[0], shift = h - s.ground;
        const base = (x << 8) | (z << 4);
        for (let y = 0; y < H; y++) {
          let id = 0;
          if (y <= h) id = s.col[Math.max(0, Math.min(s.ground, y - shift))];
          else if (s.liquid && y <= s.liquidTop) id = s.liquid;
          if (id) { const wy = y + b.y0; sub(wy >> 4).ids[base | (wy & 15)] = id; }
        }
        // Grass, flowers and other small plants: same mix and density as on the neighbours,
        // placed by a fixed hash of the position so every export agrees.
        // Land plants go on dry ground, water plants (seagrass, kelp) under water, standing in it.
        const under = !!s.liquid && h + 1 <= s.liquidTop;
        const f = flora.get(s.col[s.ground] * 2 + (under ? 1 : 0));
        if (f && f.plants.length && h + 1 < H) {
          let r = Math.imul(cx * 16 + x, 0x27d4eb2d) ^ Math.imul(cz * 16 + z, 0x165667b1);
          r = Math.imul(r ^ (r >>> 15), 0x2c1b3c6d); r = (r ^ (r >>> 13)) >>> 0;
          const pick = r % (f.bare + f.plants.length);
          if (pick < f.plants.length) {
            const p = f.plants[pick];
            const put = (y, id) => {
              const wy = y + b.y0, t = sub(wy >> 4);
              t.ids[base | (wy & 15)] = id;
              if (under && y <= s.liquidTop) { if (!t.wet) t.wet = new Uint8Array(4096); t.wet[base | (wy & 15)] = 1; }
            };
            put(h + 1, p[0]);
            if (p[1] && h + 2 < H) put(h + 2, p[1]);
          }
        }
      }
    }
    if (!subs.size) return null;
    const near = [W, E, N, S].filter(Boolean).sort((p, q) => p.gap - q.gap)[0];
    this.estimated++;
    return { subs, col: this._decodeReal(near.chunk[0], near.chunk[1]).col, estimated: true };
  }

  _decodeReal(cx, cz) {
    const key = cx + ',' + cz;
    let c = this.chunks.get(key);
    if (c) return c;
    const subs = new Map();
    const sy0 = this.b.y0 >> 4, sy1 = this.b.y1 >> 4;
    for (let sy = sy0; sy <= sy1; sy++) {
      const sc = this.world.getSubChunk(cx, cz, this.dim, sy);
      if (!sc || !sc.layers.length) continue;
      const l0 = sc.layers[0];
      const map = l0.palette.map((e) => this.models.idFor(e));
      if (map.length === 1 && map[0] === 0 && sc.layers.length === 1) continue;
      const ids = new Uint16Array(4096);
      const src = l0.indices;
      for (let i = 0; i < 4096; i++) ids[i] = map[src[i]];
      let wet = null;
      if (sc.layers.length > 1) {
        const l1 = sc.layers[1];
        const isWater = l1.palette.map((e) => e.name === 'minecraft:water' || e.name === 'minecraft:flowing_water');
        if (isWater.some(Boolean)) {
          wet = new Uint8Array(4096);
          for (let i = 0; i < 4096; i++) if (isWater[l1.indices[i]]) wet[i] = 1;
          if (!this.waterModel) this.waterModel = this.models.list[this.models.idFor({ name: 'minecraft:water', states: { liquid_depth: 0 } })];
        }
      }
      subs.set(sy, { ids, wet });
    }
    c = { subs, col: subs.size ? this.world.getColumnData(cx, cz, this.dim) : null };
    this.chunks.set(key, c);
    if (this.chunks.size > this.cacheLimit) this.chunks.delete(this.chunks.keys().next().value);
    return c;
  }

  // Copies the part of chunk (cx,cz) that falls inside the padded window of chunk (ccx,ccz).
  _fill(cx, cz, ccx, ccz) {
    const c = this._decode(cx, cz);
    if (!c.subs.size) return c;
    const b = this.b, H = this.H;
    const wx0 = Math.max(b.x0, cx * 16, ccx * 16 - 1), wx1 = Math.min(b.x1, cx * 16 + 15, ccx * 16 + 16);
    const wz0 = Math.max(b.z0, cz * 16, ccz * 16 - 1), wz1 = Math.min(b.z1, cz * 16 + 15, ccz * 16 + 16);
    if (wx0 > wx1 || wz0 > wz1) return c;
    for (const [sy, sub] of c.subs) {
      const y0 = Math.max(b.y0, sy * 16), y1 = Math.min(b.y1, sy * 16 + 15);
      for (let x = wx0; x <= wx1; x++) {
        const gx = x - ccx * 16 + 1, lx = (x & 15) << 8;
        for (let z = wz0; z <= wz1; z++) {
          const gz = z - ccz * 16 + 1, lxz = lx | ((z & 15) << 4);
          for (let y = y0; y <= y1; y++) {
            const gi = ((y - b.y0 + 1) * W + gz) * W + gx;
            this.ids[gi] = sub.ids[lxz | (y & 15)];
            if (sub.wet) this.wet[gi] = sub.wet[lxz | (y & 15)];
          }
        }
      }
    }
    void H;
    return c;
  }

  // Returns Map(materialId -> QuadBuffer) for one chunk column, or null if it is empty.
  meshChunk(cx, cz) {
    const b = this.b, ids = this.ids, wet = this.wet, list = this.models.list, H = this.H;
    ids.fill(0); wet.fill(0);
    const centre = this._fill(cx, cz, cx, cz);
    if (!centre.subs.size) return null;
    this._fill(cx - 1, cz, cx, cz); this._fill(cx + 1, cz, cx, cz);
    this._fill(cx, cz - 1, cx, cz); this._fill(cx, cz + 1, cx, cz);

    const out = new Map();
    const buf = (mat) => { let q = out.get(mat); if (!q) { q = new QuadBuffer(); out.set(mat, q); } return q; };
    const [ox, oy, oz] = this.origin;
    const baseX = cx * 16 - ox, baseY = b.y0 - oy, baseZ = cz * 16 - oz;
    const col = centre.col, minY = this.minY;
    const STEP = [-W * W, W * W, -W, W, -1, 1];
    const lx0 = Math.max(b.x0 - cx * 16, 0), lx1 = Math.min(b.x1 - cx * 16, 15);
    const lz0 = Math.max(b.z0 - cz * 16, 0), lz1 = Math.min(b.z1 - cz * 16, 15);
    const models = this.models;
    const matOf = (slot, x, y, z) => (slot.tintMethod ? models.material(slot, biomeAt(col, x, y + b.y0, z, minY)) : slot.mat);
    const hidden = (m, nb) => nb.opaque || (m.group !== 0 && nb.group === m.group);

    // Greedy masks: one per direction and layer, filled while walking the blocks.
    const greedy = this.greedy;
    const masks = greedy ? [new Map(), new Map(), new Map(), new Map(), new Map(), new Map()] : null;
    const maskDims = [[16, 16], [16, 16], [16, this.height], [16, this.height], [16, this.height], [16, this.height]];
    const maskSet = (d, layer, u, v, mat) => {
      let m = masks[d].get(layer);
      if (!m) { m = new Int32Array(maskDims[d][0] * maskDims[d][1]); masks[d].set(layer, m); }
      m[v * maskDims[d][0] + u] = mat + 1;
    };

    for (let y = 0; y < this.height; y++) {
      for (let z = lz0; z <= lz1; z++) {
        let gi = ((y + 1) * W + z + 1) * W + lx0 + 1;
        for (let x = lx0; x <= lx1; x++, gi++) {
          const id = ids[gi];
          const hasWater = wet[gi];
          if (id === 0 && !hasWater) continue;
          const m = list[id];
          if (m.full) {
            for (let d = 0; d < 6; d++) {
              if (hidden(m, list[ids[gi + STEP[d]]])) continue;
              const q = m.faces[d];
              const mat = matOf(q.slot, x, y, z);
              if (greedy && q.plain) {
                if (d < 2) maskSet(d, y, x, z, mat);
                else if (d < 4) maskSet(d, z, x, y, mat);
                else maskSet(d, x, z, y, mat);
              } else buf(mat).push(q.p, baseX + x, baseY + y, baseZ + z, q.uv);
            }
          } else if (m.liquid) {
            this._liquid(m, m.liquid, gi, x, y, z, baseX, baseY, baseZ, buf, matOf, STEP);
          } else if (id !== 0) {
            let quads = m.quads;
            if (m.entityOf) {
              // sign text, banner design, bed colour... live in the chunk's block entities
              const bes = centre.bes || (centre.bes = this.world.getBlockEntities(cx, cz, this.dim));
              const be = bes.get((cx * 16 + x) + ',' + (y + b.y0) + ',' + (cz * 16 + z));
              if (be) quads = models.withEntity(m, be).quads;
            }
            if (m.stair) {
              // Corner stairs: the same rule the game uses, from the stairs in front and behind.
              const s = m.stair, f = s.steps, left = (f + 1) & 3;
              const SIDE = [-W, -1, W, 1]; // north, west, south, east in the padded grid
              const at = (d) => { const n = list[ids[gi + SIDE[d]]]; return n.stair && n.stair.up === s.up ? n.stair : null; };
              const free = (d) => { const n = at(d); return !n || n.steps !== f; };
              let shape = 0;
              const front = at(f), back = at((f + 2) & 3);
              if (front && ((front.steps ^ f) & 1) && free((front.steps + 2) & 3)) shape = front.steps === left ? 1 : 2;
              else if (back && ((back.steps ^ f) & 1) && free(back.steps)) shape = back.steps === left ? 3 : 4;
              if (shape) quads = (s.shapes[shape] || (s.shapes[shape] = s.make(shape))).quads;
            }
            // Grass-like plants sink into the ground by 0 to 5 pixels, chosen per column from the
            // world position, so both halves of a tall plant move together and every export agrees.
            let dy = 0;
            if (m.sink) {
              let h = Math.imul(cx * 16 + x, 0x1f1f1f1f) ^ Math.imul(cz * 16 + z, 0x5f356495);
              h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h ^= h >>> 12;
              dy = -((h >>> 0) % 6) / 16;
            }
            for (let i = 0; i < quads.length; i++) {
              const q = quads[i];
              if (q.cull >= 0 && hidden(m, list[ids[gi + STEP[q.cull]]])) continue;
              buf(matOf(q.slot, x, y, z)).push(q.p, baseX + x, baseY + y + dy, baseZ + z, q.uv);
            }
          }
          if (hasWater && !m.liquid && this.waterModel) {
            this._liquid(this.waterModel, 1, gi, x, y, z, baseX, baseY, baseZ, buf, matOf, STEP);
          }
        }
      }
    }
    void H;

    // Scenery entities standing in this chunk: furniture, paintings, armor stands.
    if (this.entities && !this.only) {
      for (const e of this.world.getEntities(cx, cz, this.dim)) {
        const pos = e.Pos;
        if (!pos || pos[0] < b.x0 || pos[0] >= b.x1 + 1 || pos[1] < b.y0 || pos[1] >= b.y1 + 1 || pos[2] < b.z0 || pos[2] >= b.z1 + 1) continue;
        const em = this.entities.modelFor(e);
        if (!em) continue;
        // models face north; an entity with yaw 0 faces south, and yaw turns clockwise seen from above
        const turn = em.upright ? Q.rotation(1, 180 - ((e.Rotation && e.Rotation[0]) || 0)) : null;
        const px = pos[0] - ox, py = pos[1] - oy, pz = pos[2] - oz;
        for (const q of em.quads) {
          const p = new Array(12);
          for (let i = 0; i < 12; i += 3) {
            const x = q.p[i], y = q.p[i + 1], z = q.p[i + 2];
            if (turn) { p[i] = turn[0] * x + turn[2] * z; p[i + 1] = y; p[i + 2] = turn[8] * x + turn[10] * z; }
            else { p[i] = x; p[i + 1] = y; p[i + 2] = z; }
          }
          buf(q.slot.mat).push(p, px, py, pz, q.uv);
        }
        this.entityCount++;
      }
    }

    if (greedy) {
      for (let d = 0; d < 6; d++) {
        const [mw, mh] = maskDims[d];
        for (const [layer, mask] of masks[d]) {
          for (let v = 0; v < mh; v++) {
            for (let u = 0; u < mw;) {
              const mat = mask[v * mw + u];
              if (!mat) { u++; continue; }
              let w = 1;
              while (u + w < mw && mask[v * mw + u + w] === mat) w++;
              let h = 1;
              outer: for (; v + h < mh; h++) for (let k = 0; k < w; k++) if (mask[(v + h) * mw + u + k] !== mat) break outer;
              for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) mask[(v + j) * mw + u + k] = 0;
              let x0, y0, z0, x1, y1, z1;
              if (d < 2) { x0 = u; x1 = u + w; z0 = v; z1 = v + h; y0 = layer; y1 = layer + 1; }
              else if (d < 4) { x0 = u; x1 = u + w; y0 = v; y1 = v + h; z0 = layer; z1 = layer + 1; }
              else { z0 = u; z1 = u + w; y0 = v; y1 = v + h; x0 = layer; x1 = layer + 1; }
              const p = Q.faceCorners(d, x0, y0, z0, x1, y1, z1);
              const uv = new Array(8);
              let mu = Infinity, mv = Infinity;
              for (let i = 0; i < 4; i++) {
                const t = tileUV(d, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
                uv[i * 2] = t[0]; uv[i * 2 + 1] = t[1];
                if (t[0] < mu) mu = t[0]; if (t[1] < mv) mv = t[1];
              }
              for (let i = 0; i < 4; i++) { uv[i * 2] -= mu; uv[i * 2 + 1] -= mv; }
              buf(mat - 1).push(p, baseX, baseY, baseZ, uv);
              u += w;
            }
          }
        }
      }
    }
    return out.size ? out : null;
  }

  _liquid(m, kind, gi, x, y, z, baseX, baseY, baseZ, buf, matOf, STEP) {
    const ids = this.ids, wet = this.wet, list = this.models.list;
    const same = (i) => { const n = list[ids[i]]; return n.liquid === kind || (kind === 1 && wet[i] === 1); };
    const above = same(gi + STEP[1]);
    const depth = m.depth | 0;
    const top = above ? 1 : (depth === 0 || depth >= 8 ? 14 : Math.max(2, 14 - depth * 2)) / 16;
    for (let d = 0; d < 6; d++) {
      const ni = gi + STEP[d];
      if (d === 1 ? above : (same(ni) || list[ids[ni]].opaque)) continue;
      const p = Q.faceCorners(d, 0, 0, 0, 1, top, 1);
      const uv = new Array(8);
      for (let i = 0; i < 4; i++) { const t = Q.lockedUV(d, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); uv[i * 2] = t[0]; uv[i * 2 + 1] = t[1]; }
      buf(matOf(m.slots[d], x, y, z)).push(p, baseX + x, baseY + y, baseZ + z, uv);
    }
  }
}

module.exports = { Mesher, QuadBuffer };
