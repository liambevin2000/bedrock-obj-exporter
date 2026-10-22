'use strict';
// Java Edition world: region files decoded into the same shapes the Bedrock reader produces, so the
// mesher, map, picking and exports work unchanged:
//   getSubChunk -> { layers: [{ palette: [{ name, states }], indices: Uint16Array(4096) }, water layer?] }
//   getColumnData -> { heights, biomeSections }   (indices in Bedrock order: (x << 8) | (z << 4) | y)
// Supports the 1.18+ chunk format and the 1.13-1.17 one ("Level" compound). Older (numeric id) worlds are refused.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { RegionSet } = require('./region');
const { readNbt, readNbtFile } = require('./nbt');
const { regionDirs, levelInfo } = require('./install');
const { LEGACY_BIOMES } = require('./legacy');

const DIM_KEYS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];
// Blocks that always stand in water even without a waterlogged state.
const ALWAYS_WET = new Set(['minecraft:seagrass', 'minecraft:tall_seagrass', 'minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:bubble_column']);
const WATER_LAYER = [{ name: 'minecraft:air', states: {} }, { name: 'minecraft:water', states: { level: '0' } }];
const ZERO = new Uint16Array(4096);

// Unpacks a long array of fixed-width values. spanning: values may cross long boundaries (before 1.16).
function unpack(longs, bits, count, spanning) {
  const out = new Uint16Array(count);
  if (!longs || !bits) return out;
  const mask = (1n << BigInt(bits)) - 1n;
  if (spanning) {
    for (let i = 0; i < count; i++) {
      const bit = i * bits, w = bit >> 6, off = bit & 63;
      let v = BigInt.asUintN(64, longs[w]) >> BigInt(off);
      if (off + bits > 64 && w + 1 < longs.length) v |= BigInt.asUintN(64, longs[w + 1]) << BigInt(64 - off);
      out[i] = Number(v & mask);
    }
    return out;
  }
  const per = Math.floor(64 / bits);
  // work on 32-bit halves: much faster than BigInt per value
  const m = (1 << bits) - 1;
  for (let w = 0, i = 0; w < longs.length && i < count; w++) {
    const l = longs[w];
    let lo = Number(BigInt.asUintN(32, l)), hi = Number(BigInt.asUintN(32, l >> 32n));
    for (let j = 0; j < per && i < count; j++, i++) {
      const s = j * bits;
      let v;
      if (s + bits <= 32) v = (lo >>> s) & m;
      else if (s >= 32) v = (hi >>> (s - 32)) & m;
      else v = ((lo >>> s) | (hi << (32 - s))) & m;
      out[i] = v;
    }
  }
  return out;
}

const bitsFor = (n, min) => Math.max(min, Math.ceil(Math.log2(Math.max(n, 1))));

// Palette entry in any spelling: "minecraft:stone", {"": "minecraft:stone"} (26.x mixed lists),
// {id, properties} (26.x) or {Name, Properties}.
function normEntry(e) {
  if (typeof e === 'string') return { name: e, states: {} };
  if (!e) return { name: 'minecraft:air', states: {} };
  if (typeof e[''] === 'string') return { name: e[''], states: {} };
  const states = {}, props = e.Properties || e.properties;
  if (props) for (const k in props) states[k] = String(props[k]);
  return { name: e.Name || e.id || e.name || 'minecraft:air', states };
}
const normName = (e) => (typeof e === 'string' ? e : e && typeof e[''] === 'string' ? e[''] : (e && (e.Name || e.id || e.name)) || 'minecraft:plains');

class JavaWorld {
  constructor(dir) {
    this.dir = dir;
    this.edition = 'java';
    const info = levelInfo(dir);
    if (!info.data) throw new Error('level.dat could not be read');
    this.level = info.data; this.version = info.version; this.dataVersion = info.dataVersion;
    if (this.dataVersion && this.dataVersion < 1444) throw new Error(`This world was last saved in Minecraft ${info.version || 'before 1.13'}. Open it in 1.13 or newer once, then try again.`);
    this.name = info.name;
    const dirs = regionDirs(dir);
    this.regions = dirs.map((d) => new RegionSet(path.join(d, 'region')));
    this.entityRegions = dirs.map((d) => new RegionSet(path.join(d, 'entities'), 16));
    // 1.18 raised the overworld floor to -64; nether and end stay at 0
    this._minY = [this.dataVersion >= 2825 ? -64 : 0, 0, 0];
    this.biomeNames = ['minecraft:plains'];  // id -> name, shared with the resources for tinting
    this._biomeIds = new Map([['minecraft:plains', 0]]);
    this.cache = new Map();
    this.cacheLimit = 96;
  }

  minY(dim) { return this._minY[dim] || 0; }
  biomeId(name) {
    let id = this._biomeIds.get(name);
    if (id === undefined) { id = this.biomeNames.length; this.biomeNames.push(name); this._biomeIds.set(name, id); }
    return id;
  }

  // ---- chunk decoding ---------------------------------------------------------------------------

  _chunk(cx, cz, dim) {
    const key = dim + ':' + cx + ',' + cz;
    let c = this.cache.get(key);
    if (c !== undefined) return c;
    c = null;
    try {
      const rs = this.regions[dim];
      const nbt = rs && rs.chunk(cx, cz);
      if (nbt) c = this._decode(nbt, dim);
    } catch (e) { c = null; }
    this.cache.set(key, c);
    if (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
    return c;
  }

  _decode(root, dim) {
    const old = root.Level && !root.sections; // 1.13 - 1.17
    const lv = old ? root.Level : root;
    const status = String(lv.Status || '');
    // the game only shows fully generated chunks; the rest are terrain in progress
    if (status && !/(^|:)full$/.test(status) && status !== 'postprocessed' && status !== 'fullchunk') return null;
    const dv = root.DataVersion | 0;
    const spanning = dv && dv < 2529; // before 20w17a values could cross long boundaries
    const sectionsIn = old ? lv.Sections : lv.sections;
    const subs = new Map();
    let minSy = Infinity, maxSy = -Infinity;
    const biomeSecs = new Map();
    for (const s of sectionsIn || []) {
      const sy = s.Y | 0;
      let palette, data;
      if (old) { palette = s.Palette; data = s.BlockStates; } else if (s.block_states) { palette = s.block_states.palette; data = s.block_states.data; }
      if (palette && palette.length) {
        const pal = palette.map(normEntry);
        if (!(pal.length === 1 && /(^|:)(air|cave_air|void_air)$/.test(pal[0].name))) {
          const raw = pal.length > 1 ? unpack(data, bitsFor(pal.length, 4), 4096, spanning) : ZERO;
          // Java order (y << 8) | (z << 4) | x -> Bedrock order (x << 8) | (z << 4) | y
          const indices = new Uint16Array(4096);
          if (raw !== ZERO) for (let i = 0; i < 4096; i++) indices[((i & 15) << 8) | (i & 0xf0) | (i >> 8)] = raw[i];
          let wet = null;
          const wetPal = pal.map((e) => e.states.waterlogged === 'true' || ALWAYS_WET.has(e.name));
          if (wetPal.some(Boolean)) {
            wet = new Uint16Array(4096);
            for (let i = 0; i < 4096; i++) if (wetPal[indices[i]]) wet[i] = 1;
          }
          subs.set(sy, { palette: pal, indices, wet });
          if (sy < minSy) minSy = sy; if (sy > maxSy) maxSy = sy;
        }
      }
      if (!old && s.biomes && s.biomes.palette) {
        const bp = s.biomes.palette.map((b) => this.biomeId(normName(b)));
        biomeSecs.set(sy, { palette: bp, raw: bp.length > 1 ? unpack(s.biomes.data, bitsFor(bp.length, 1), 64, false) : null });
      }
    }
    // pre-1.18: biomes for the whole column (1024 = 4x4x64 cells from 1.15, 256 = per column before)
    let oldBiomes = null;
    if (old && lv.Biomes && lv.Biomes.length) oldBiomes = lv.Biomes;
    const bes = new Map();
    for (const be of (old ? lv.TileEntities : lv.block_entities) || []) {
      if (be && typeof be.x === 'number') bes.set(be.x + ',' + be.y + ',' + be.z, be);
    }
    return { subs, minSy, maxSy, biomeSecs, oldBiomes, heightmaps: lv.Heightmaps || null, spanning, bes, starts: lv.structures || lv.Structures || null, dim };
  }

  getSubChunk(cx, cz, dim, sy) {
    const c = this._chunk(cx, cz, dim);
    const s = c && c.subs.get(sy);
    if (!s) return null;
    const layers = [{ palette: s.palette, indices: s.indices }];
    if (s.wet) layers.push({ palette: WATER_LAYER, indices: s.wet });
    return { layers };
  }

  getColumnData(cx, cz, dim) {
    const c = this._chunk(cx, cz, dim);
    if (!c) return null;
    if (c.col) return c.col;
    const minY = this.minY(dim);
    const heights = new Int16Array(256);
    const hm = c.heightmaps && (c.heightmaps.WORLD_SURFACE || c.heightmaps.MOTION_BLOCKING);
    if (hm && hm.length) {
      // 9 bits for vanilla heights; worlds with taller custom dimensions use more
      let bits = (hm.length * 64) / 256;
      if (!c.spanning) for (let b = 9; b <= 16; b++) if (Math.ceil(256 / Math.floor(64 / b)) === hm.length) { bits = b; break; }
      const v = unpack(hm, bits, 256, c.spanning);
      for (let i = 0; i < 256; i++) heights[i] = v[i]; // blocks above the floor, index z * 16 + x
    } else heights.fill(c.maxSy === -Infinity ? 0 : (c.maxSy + 1) * 16 - minY);
    // biomes in the Bedrock layout: one section per 16 blocks from the dimension floor
    const secs = [];
    const top = Math.max(c.maxSy, minY / 16 + 15);
    for (let sy = minY >> 4; sy <= top; sy++) {
      const b = c.biomeSecs.get(sy);
      if (!b && !c.oldBiomes) { secs.push(secs[secs.length - 1] || null); continue; }
      const indices = new Uint16Array(4096);
      let palette;
      if (b) {
        palette = b.palette;
        if (b.raw) for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) indices[(x << 8) | (z << 4) | y] = b.raw[((y >> 2) << 4) | ((z >> 2) << 2) | (x >> 2)];
      } else {
        const ob = c.oldBiomes, ids = new Map(), pal = [];
        const idOf = (n) => { let i = ids.get(n); if (i === undefined) { i = pal.length; pal.push(this.biomeId(LEGACY_BIOMES[n] || 'minecraft:plains')); ids.set(n, i); } return i; };
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) {
          const n = ob.length >= 1024 ? ob[Math.min(63, ((sy * 16 + y) - minY) >> 2) * 16 + (z >> 2) * 4 + (x >> 2)] : ob[z * 16 + x];
          indices[(x << 8) | (z << 4) | y] = idOf(n);
        }
        palette = pal;
      }
      secs.push({ palette, indices });
    }
    c.col = { heights, biomeSections: secs, biomes2d: null };
    return c.col;
  }

  // Which biomes occur in a chunk (ids).
  biomeIds(cx, cz, dim) {
    const c = this._chunk(cx, cz, dim);
    const out = new Set();
    if (!c) return out;
    for (const b of c.biomeSecs.values()) for (const id of b.palette) out.add(id);
    if (c.oldBiomes) for (const n of new Set(c.oldBiomes)) out.add(this.biomeId(LEGACY_BIOMES[n] || 'minecraft:plains'));
    return out;
  }

  getBlockEntities(cx, cz, dim) {
    const c = this._chunk(cx, cz, dim);
    return c ? c.bes : new Map();
  }

  // Structures that start in this chunk, with their bounding box centre: [{ kind, x, y, z }].
  structureStarts(cx, cz, dim) {
    const c = this._chunk(cx, cz, dim);
    const starts = c && c.starts && (c.starts.starts || c.starts.Starts);
    const out = [];
    if (!starts) return out;
    for (const [name, s] of Object.entries(starts)) {
      if (!s || s.id === 'INVALID' || s.id === 'minecraft:invalid') continue;
      let bb = s.BB;
      if (!bb && Array.isArray(s.Children) && s.Children.length) {
        bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (const ch of s.Children) {
          const b = ch.BB; if (!b) continue;
          for (let i = 0; i < 3; i++) { bb[i] = Math.min(bb[i], b[i]); bb[i + 3] = Math.max(bb[i + 3], b[i + 3]); }
        }
      }
      const kind = String(s.id || name);
      if (bb && bb[0] !== Infinity) out.push({ kind, x: (bb[0] + bb[3]) >> 1, y: (bb[1] + bb[4]) >> 1, z: (bb[2] + bb[5]) >> 1 });
      else out.push({ kind, x: cx * 16 + 8, y: 64, z: cz * 16 + 8 });
    }
    return out;
  }

  // Entities of a chunk (1.17+ keep them in entities/ region files, older worlds in the chunk).
  getEntities(cx, cz, dim) {
    const ers = this.entityRegions[dim];
    let list = [];
    try {
      const e = ers && ers.chunk(cx, cz);
      if (e && Array.isArray(e.Entities)) list = e.Entities;
      else {
        const rs = this.regions[dim];
        const raw = rs && rs.chunk(cx, cz);
        if (raw && raw.Level && Array.isArray(raw.Level.Entities)) list = raw.Level.Entities;
      }
    } catch (err) { list = []; }
    return list.filter((e) => e && Array.isArray(e.Pos));
  }

  // ---- scanning ---------------------------------------------------------------------------------

  // Which chunks exist and are fully generated. Reads only the start of each chunk record: the
  // status comes first in the saved data, so a few hundred bytes are enough.
  scan() {
    const dims = this.regions.map((rs, dim) => {
      const list = [];
      const minSy = this.minY(dim) >> 4, maxSy = minSy + (dim === 0 ? (this._minY[0] < 0 ? 23 : 15) : dim === 1 ? 7 : 15);
      for (const [rx, rz] of rs.files()) {
        const r = rs.region(rx, rz);
        if (!r) continue;
        const head = Buffer.alloc(1024);
        for (const [lx, lz] of r.chunks()) {
          const e = r.header.readUInt32BE((lz * 32 + lx) * 4);
          const off = (e >>> 8) * 4096;
          const n = fs.readSync(r.fd, head, 0, 1024, off);
          if (n < 6) continue;
          const type = head[4] & 127;
          // the status as saved, from the decompressed bytes (null when not in them)
          const statusIn = (txt) => {
            const i = txt.indexOf('Status');
            if (i < 0 || i + 8 > txt.length) return null;
            const len = txt.readUInt16BE(i + 6);
            return txt.toString('utf8', i + 8, i + 8 + len);
          };
          const isFull = (st) => /(^|:)full$/.test(st) || st === 'postprocessed' || st === 'fullchunk';
          let full = true;
          try {
            let st = null;
            if (type === 2) st = statusIn(zlib.inflateSync(head.subarray(5, n), { finishFlush: zlib.constants.Z_SYNC_FLUSH }));
            else if (type === 1) st = statusIn(zlib.gunzipSync(head.subarray(5, n), { finishFlush: zlib.constants.Z_SYNC_FLUSH }));
            else if (type === 3) st = statusIn(head.subarray(5, n));
            if (st === null && (type === 1 || type === 2 || type === 3)) {
              // some mods save the status last: decompress the whole record and look for it there
              const len = head.readUInt32BE(0);
              if (len > 1 && len < 1 << 24 && !(head[4] & 128)) {
                const buf = Buffer.alloc(len - 1);
                fs.readSync(r.fd, buf, 0, len - 1, off + 5);
                st = statusIn(type === 2 ? zlib.inflateSync(buf) : type === 1 ? zlib.gunzipSync(buf) : buf);
              }
            }
            full = st === null ? this._chunk(rx * 32 + lx, rz * 32 + lz, dim) !== null : isFull(st);
          } catch (err) { full = this._chunk(rx * 32 + lx, rz * 32 + lz, dim) !== null; }
          if (full) list.push(rx * 32 + lx, rz * 32 + lz, minSy, maxSy);
        }
      }
      const count = list.length / 4;
      const chunks = new Int32Array(list.length);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < list.length; i += 4) {
        chunks[i] = list[i]; chunks[i + 1] = list[i + 1]; chunks[i + 2] = list[i + 2]; chunks[i + 3] = list[i + 3];
        if (list[i] < minX) minX = list[i]; if (list[i] > maxX) maxX = list[i];
        if (list[i + 1] < minZ) minZ = list[i + 1]; if (list[i + 1] > maxZ) maxZ = list[i + 1];
      }
      return { count, chunks, bounds: count ? { minX, maxX, minZ, maxZ } : null };
    });
    return { dims, player: this.player(), spawn: this.spawn() };
  }

  // The singleplayer player's position: in level.dat (older) or players/data/<uuid>.dat (26.x).
  player() {
    const fromNbt = (p) => {
      if (!p || !Array.isArray(p.Pos)) return null;
      const d = p.Dimension !== undefined ? p.Dimension : p.dimension;
      const dim = typeof d === 'number' ? (d === -1 ? 1 : d === 1 ? 2 : 0) : Math.max(0, DIM_KEYS.indexOf(String(d || 'minecraft:overworld')));
      return { x: p.Pos[0], y: p.Pos[1], z: p.Pos[2], dim };
    };
    let p = fromNbt(this.level.Player);
    if (p) return p;
    const uuid = this.level.singleplayer_uuid;
    const cands = [];
    for (const sub of [path.join('players', 'data'), 'players', 'playerdata']) {
      try { for (const f of fs.readdirSync(path.join(this.dir, sub))) if (f.endsWith('.dat')) cands.push(path.join(this.dir, sub, f)); } catch (e) { /* none */ }
    }
    cands.sort((a, b) => { try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch (e) { return 0; } });
    for (const f of cands) { try { p = fromNbt(readNbtFile(f)); if (p) return p; } catch (e) { /* unreadable */ } }
    void uuid;
    return null;
  }

  spawn() {
    const l = this.level;
    if (l.spawn && l.spawn.pos) { const s = l.spawn.pos; return [s[0] | 0, s[1] | 0, s[2] | 0]; }
    return [l.SpawnX | 0, l.SpawnY | 0, l.SpawnZ | 0];
  }

  close() {
    for (const r of this.regions) r.close();
    for (const r of this.entityRegions) r.close();
    this.cache.clear();
  }
}

module.exports = { JavaWorld, unpack, normEntry };
void readNbt;
