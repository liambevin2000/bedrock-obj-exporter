'use strict';
const fs = require('fs');
const path = require('path');
const { LevelDB } = require('./leveldb');
const { readNbt } = require('./nbt');

const DIM_MIN_Y = [-64, 0, 0];
const TAG_DATA3D = 0x2b, TAG_DATA2D = 0x2d, TAG_SUBCHUNK = 0x2f, TAG_BLOCK_ENTITY = 0x31, TAG_ENTITY = 0x32, TAG_SPAWN_AREAS = 0x39;

function chunkKey(cx, cz, dim, tag, sub) {
  const len = 8 + (dim ? 4 : 0) + 1 + (sub === undefined ? 0 : 1);
  const b = Buffer.allocUnsafe(len);
  b.writeInt32LE(cx, 0); b.writeInt32LE(cz, 4);
  let p = 8;
  if (dim) { b.writeInt32LE(dim, 8); p = 12; }
  b[p++] = tag;
  if (sub !== undefined) b.writeInt8(sub, p);
  return b;
}

// Decodes one paletted storage. Returns { indices: Uint16Array(4096), palette: [...] }.
// Index order is (x << 8) | (z << 4) | y.
function readStorage(buf, pos, readEntry) {
  const header = buf[pos.p++];
  const bits = header >> 1;
  const indices = new Uint16Array(4096);
  if (bits === 0) {
    return { indices, palette: [readEntry(buf, pos)] };
  }
  const perWord = Math.floor(32 / bits);
  const words = Math.ceil(4096 / perWord);
  const mask = (1 << bits) - 1;
  let i = 0;
  for (let w = 0; w < words; w++) {
    let word = buf.readUInt32LE(pos.p + w * 4);
    for (let j = 0; j < perWord && i < 4096; j++, i++) {
      indices[i] = word & mask;
      word >>>= bits;
    }
  }
  pos.p += words * 4;
  const count = buf.readInt32LE(pos.p); pos.p += 4;
  const palette = new Array(count);
  for (let k = 0; k < count; k++) palette[k] = readEntry(buf, pos);
  return { indices, palette };
}

const readBlockEntry = (buf, pos) => readNbt(buf, pos);
const readIntEntry = (buf, pos) => { const v = buf.readInt32LE(pos.p); pos.p += 4; return v; };

// Returns { layers: [{indices, palette}] } or null for formats we cannot read.
function parseSubChunk(buf) {
  const version = buf[0];
  const pos = { p: 1 };
  let layers = 1;
  if (version === 8 || version === 9) {
    layers = buf[pos.p++];
    if (version === 9) pos.p++; // y index, already known from the key
  } else if (version !== 1) {
    return null; // pre-1.2.13 numeric-id chunks
  }
  const out = [];
  for (let l = 0; l < layers && pos.p < buf.length; l++) out.push(readStorage(buf, pos, readBlockEntry));
  return { layers: out };
}

class World {
  constructor(dir) {
    this.dir = dir;
    this.db = new LevelDB(path.join(dir, 'db'));
  }

  getSubChunk(cx, cz, dim, sy) {
    const v = this.db.get(chunkKey(cx, cz, dim, TAG_SUBCHUNK, sy));
    if (!v || v.length < 3) return null;
    try { return parseSubChunk(v); } catch (e) { return null; }
  }

  // Heightmap (256 x int16, index z*16+x, relative to the dimension floor) plus a biome lookup.
  getColumnData(cx, cz, dim) {
    let v = this.db.get(chunkKey(cx, cz, dim, TAG_DATA3D));
    if (v && v.length >= 512) {
      const heights = new Int16Array(256);
      for (let i = 0; i < 256; i++) heights[i] = v.readInt16LE(i * 2);
      const sections = [];
      const pos = { p: 512 };
      try {
        while (pos.p < v.length) {
          if (v[pos.p] === 0xff) { pos.p++; sections.push(sections[sections.length - 1] || null); continue; }
          sections.push(readStorage(v, pos, readIntEntry));
        }
      } catch (e) { /* truncated biome data: keep what we have */ }
      return { heights, biomeSections: sections, biomes2d: null };
    }
    v = this.db.get(chunkKey(cx, cz, dim, TAG_DATA2D));
    if (v && v.length >= 768) {
      const heights = new Int16Array(256);
      for (let i = 0; i < 256; i++) heights[i] = v.readInt16LE(i * 2);
      return { heights, biomeSections: null, biomes2d: v.subarray(512, 768) };
    }
    return null;
  }

  // Which biomes occur anywhere in a chunk (ids), without unpacking the per-block data.
  biomeIds(cx, cz, dim) {
    const out = new Set();
    let v = this.db.get(chunkKey(cx, cz, dim, TAG_DATA3D));
    if (v && v.length > 512) {
      let p = 512;
      try {
        while (p < v.length) {
          const header = v[p++];
          if (header === 0xff) continue; // same as the section below
          const bits = header >> 1;
          if (bits === 0) { out.add(v.readInt32LE(p)); p += 4; continue; }
          p += Math.ceil(4096 / Math.floor(32 / bits)) * 4;
          const n = v.readInt32LE(p); p += 4;
          for (let i = 0; i < n; i++, p += 4) out.add(v.readInt32LE(p));
        }
      } catch (e) { /* truncated: keep what was read */ }
      return out;
    }
    v = this.db.get(chunkKey(cx, cz, dim, TAG_DATA2D));
    if (v && v.length >= 768) for (let i = 512; i < 768; i++) out.add(v[i]);
    return out;
  }

  // Structure areas the game records for mob spawning: [{ type, x0, y0, z0, x1, y1, z1 }].
  // type: 1 nether fortress, 2 swamp hut, 3 ocean monument, 5 pillager outpost.
  hardcodedSpawners(cx, cz, dim) {
    const v = this.db.get(chunkKey(cx, cz, dim, TAG_SPAWN_AREAS));
    const out = [];
    if (!v || v.length < 4) return out;
    const n = v.readInt32LE(0);
    for (let i = 0, p = 4; i < n && p + 25 <= v.length; i++, p += 25) {
      out.push({ x0: v.readInt32LE(p), y0: v.readInt32LE(p + 4), z0: v.readInt32LE(p + 8), x1: v.readInt32LE(p + 12), y1: v.readInt32LE(p + 16), z1: v.readInt32LE(p + 20), type: v[p + 24] });
    }
    return out;
  }

  // Block entities of a chunk (sign text, banner colours, what is in a pot...): Map "x,y,z" -> NBT.
  getBlockEntities(cx, cz, dim) {
    const out = new Map();
    const v = this.db.get(chunkKey(cx, cz, dim, TAG_BLOCK_ENTITY));
    if (!v) return out;
    const pos = { p: 0 };
    try {
      while (pos.p < v.length) {
        const n = readNbt(v, pos);
        if (!n) break;
        if (typeof n.x === 'number') out.set(n.x + ',' + n.y + ',' + n.z, n);
      }
    } catch (e) { /* truncated record: keep what was read */ }
    return out;
  }

  // Entities stored for a chunk, as NBT. New worlds keep a list of actor ids per chunk ("digp") and
  // each actor under its own key; older ones keep them inside the chunk record.
  getEntities(cx, cz, dim) {
    const out = [];
    const readAll = (v) => {
      const pos = { p: 0 };
      try { while (pos.p < v.length) { const n = readNbt(v, pos); if (!n) break; out.push(n); } } catch (e) { /* truncated */ }
    };
    const ck = chunkKey(cx, cz, dim, 0).subarray(0, dim ? 12 : 8);
    const ids = this.db.get(Buffer.concat([Buffer.from('digp'), ck]));
    if (ids) {
      for (let i = 0; i + 8 <= ids.length; i += 8) {
        const v = this.db.get(Buffer.concat([Buffer.from('actorprefix'), ids.subarray(i, i + 8)]));
        if (v) readAll(v);
      }
    }
    const legacy = this.db.get(chunkKey(cx, cz, dim, TAG_ENTITY));
    if (legacy) readAll(legacy);
    return out;
  }

  close() { this.db.close(); }
}

function biomeAt(col, x, y, z, minY) {
  if (!col) return 1;
  if (col.biomes2d) return col.biomes2d[z * 16 + x];
  const s = col.biomeSections;
  if (!s || !s.length) return 1;
  let i = (y - minY) >> 4;
  if (i < 0) i = 0; if (i >= s.length) i = s.length - 1;
  const sec = s[i];
  if (!sec) return 1;
  return sec.palette[sec.indices[(x << 8) | (z << 4) | (y & 15)]];
}

// Scans every key once to find which chunks exist. Returns per-dimension chunk lists and bounds.
function scanChunks(db) {
  const dims = [new Map(), new Map(), new Map()];
  const villages = new Set(); // keys of village records, for "locate"
  db.scanKeys((k) => {
    let dim = 0, tagPos;
    if (k.length === 10) tagPos = 8;
    else if (k.length === 14) { dim = k.readInt32LE(8); tagPos = 12; }
    else {
      if (k.length > 20 && k[0] === 0x56 && k.toString('latin1', 0, 8) === 'VILLAGE_' && k.toString('latin1', k.length - 5) === '_INFO') villages.add(k.toString('latin1'));
      return;
    }
    if (k[tagPos] !== TAG_SUBCHUNK || dim < 0 || dim > 2) return;
    const cx = k.readInt32LE(0), cz = k.readInt32LE(4);
    if (cx < -1875000 || cx > 1875000 || cz < -1875000 || cz > 1875000) return;
    const sy = k.readInt8(tagPos + 1);
    const key = cx + ',' + cz;
    const e = dims[dim].get(key);
    if (!e) dims[dim].set(key, [cx, cz, sy, sy]);
    else { if (sy < e[2]) e[2] = sy; if (sy > e[3]) e[3] = sy; }
  });
  db.villageKeys = [...villages];
  return dims.map((m) => {
    const n = m.size;
    const chunks = new Int32Array(n * 4);
    let i = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const e of m.values()) {
      chunks.set(e, i); i += 4;
      if (e[0] < minX) minX = e[0]; if (e[0] > maxX) maxX = e[0];
      if (e[1] < minZ) minZ = e[1]; if (e[1] > maxZ) maxZ = e[1];
    }
    return { count: n, chunks, bounds: n ? { minX, maxX, minZ, maxZ } : null };
  });
}

function readLevelDat(dir) {
  try {
    const buf = fs.readFileSync(path.join(dir, 'level.dat'));
    return readNbt(buf, { p: 8 });
  } catch (e) { return null; }
}

function comMojangRoots() {
  const roots = [];
  const appdata = process.env.APPDATA, local = process.env.LOCALAPPDATA;
  if (appdata) {
    const users = path.join(appdata, 'Minecraft Bedrock', 'Users');
    try { for (const u of fs.readdirSync(users)) roots.push(path.join(users, u, 'games', 'com.mojang')); } catch (e) {}
    const usersP = path.join(appdata, 'Minecraft Bedrock Preview', 'Users');
    try { for (const u of fs.readdirSync(usersP)) roots.push(path.join(usersP, u, 'games', 'com.mojang')); } catch (e) {}
  }
  if (local) {
    for (const pkg of ['Microsoft.MinecraftUWP_8wekyb3d8bbwe', 'Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe']) {
      roots.push(path.join(local, 'Packages', pkg, 'LocalState', 'games', 'com.mojang'));
    }
  }
  return roots.filter((r) => fs.existsSync(r));
}

function describeWorld(dir) {
  if (!fs.existsSync(path.join(dir, 'db')) && !fs.existsSync(path.join(dir, 'level.dat'))) return null;
  let name = path.basename(dir);
  try { name = fs.readFileSync(path.join(dir, 'levelname.txt'), 'utf8').split(/\r?\n/)[0].trim() || name; } catch (e) {}
  let modified = 0, size = 0;
  try { modified = fs.statSync(path.join(dir, 'level.dat')).mtimeMs; } catch (e) {}
  try { for (const f of fs.readdirSync(path.join(dir, 'db'))) size += fs.statSync(path.join(dir, 'db', f)).size; } catch (e) {}
  const icon = path.join(dir, 'world_icon.jpeg');
  return { dir, name, modified, size, icon: fs.existsSync(icon) ? icon : null };
}

function listWorlds() {
  const out = [];
  for (const root of comMojangRoots()) {
    const wdir = path.join(root, 'minecraftWorlds');
    let entries = [];
    try { entries = fs.readdirSync(wdir); } catch (e) { continue; }
    for (const e of entries) {
      const w = describeWorld(path.join(wdir, e));
      if (w && w.size > 0) out.push(w);
    }
  }
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

module.exports = { World, scanChunks, readLevelDat, listWorlds, describeWorld, comMojangRoots, biomeAt, DIM_MIN_Y };
