'use strict';
// Anvil region files (r.<x>.<z>.mca): 32 x 32 chunks, each a compressed NBT record.
// Header: 1024 big-endian location entries (3 bytes sector offset, 1 byte sector count), then
// 1024 timestamps. A record starts with its length (4 bytes) and compression type (1 byte):
// 1 gzip, 2 zlib, 3 none, 4 LZ4 (1.20.5+); +128 means the chunk lives in a separate c.<x>.<z>.mcc file.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readNbt } = require('./nbt');

// LZ4 block decompression (used inside Minecraft's LZ4 frames: "LZ4Block" header + blocks).
function lz4Block(src, out) {
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    src.copy(out, d, s, s + lit); s += lit; d += lit;
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
    len += 4;
    for (let i = 0; i < len; i++, d++) out[d] = out[d - off];
  }
  return d;
}

// Minecraft writes LZ4 with lz4-java's LZ4BlockOutputStream: blocks of "LZ4Block" + token + sizes.
function lz4Java(buf) {
  const parts = [];
  let p = 0;
  while (p + 21 <= buf.length && buf.toString('latin1', p, p + 8) === 'LZ4Block') {
    const token = buf[p + 8], method = token & 0xf0;
    const clen = buf.readInt32LE(p + 9), dlen = buf.readInt32LE(p + 13);
    p += 21;
    if (dlen === 0) break;
    const data = buf.subarray(p, p + clen); p += clen;
    if (method === 0x10) parts.push(Buffer.from(data)); // raw
    else { const out = Buffer.alloc(dlen); lz4Block(data, out); parts.push(out); }
  }
  return Buffer.concat(parts);
}

function decompress(type, data) {
  if (type === 1) return zlib.gunzipSync(data);
  if (type === 2) return zlib.inflateSync(data);
  if (type === 3) return data;
  if (type === 4) return lz4Java(data);
  throw new Error('unknown chunk compression ' + type);
}

class Region {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(this.fd).size;
    this.header = Buffer.alloc(8192);
    if (size >= 8192) fs.readSync(this.fd, this.header, 0, 8192, 0);
    this.size = size;
  }
  has(lx, lz) { const e = this.header.readUInt32BE(((lz & 31) * 32 + (lx & 31)) * 4); return e !== 0 && (e >>> 8) >= 2; }
  // Raw NBT root of a chunk (local coordinates 0..31), or null.
  read(lx, lz) {
    const e = this.header.readUInt32BE(((lz & 31) * 32 + (lx & 31)) * 4);
    if (!e) return null;
    const off = (e >>> 8) * 4096, count = (e & 0xff) * 4096;
    if (off < 8192 || off + 5 > this.size) return null;
    const head = Buffer.alloc(5);
    fs.readSync(this.fd, head, 0, 5, off);
    const len = head.readUInt32BE(0), type = head[4];
    if (len < 1 || len > Math.max(count, 1 << 24)) return null;
    let data;
    if (type & 128) {
      // oversized chunk stored next to the region file
      const m = /r\.(-?\d+)\.(-?\d+)\.mca$/.exec(this.file);
      if (!m) return null;
      const cx = Number(m[1]) * 32 + (lx & 31), cz = Number(m[2]) * 32 + (lz & 31);
      try { data = fs.readFileSync(path.join(path.dirname(this.file), `c.${cx}.${cz}.mcc`)); } catch (err) { return null; }
    } else {
      data = Buffer.alloc(len - 1);
      fs.readSync(this.fd, data, 0, len - 1, off + 5);
    }
    return readNbt(decompress(type & 127, data), { p: 0 });
  }
  // Which chunks exist: list of [lx, lz].
  chunks() {
    const out = [];
    for (let i = 0; i < 1024; i++) {
      const e = this.header.readUInt32BE(i * 4);
      if (e && (e >>> 8) >= 2) out.push([i & 31, i >> 5]);
    }
    return out;
  }
  close() { try { fs.closeSync(this.fd); } catch (e) { /* already closed */ } }
}

// Region files of one folder, opened on demand and kept open (bounded).
class RegionSet {
  constructor(dir, limit = 48) { this.dir = dir; this.open = new Map(); this.limit = limit; }
  region(rx, rz) {
    const key = rx + ',' + rz;
    let r = this.open.get(key);
    if (r !== undefined) { this.open.delete(key); this.open.set(key, r); return r; } // most recently used last
    const f = path.join(this.dir, `r.${rx}.${rz}.mca`);
    r = null;
    try { if (fs.statSync(f).size >= 8192) r = new Region(f); } catch (e) { r = null; }
    this.open.set(key, r);
    if (this.open.size > this.limit) {
      const [k, old] = this.open.entries().next().value;
      if (old) old.close();
      this.open.delete(k);
    }
    return r;
  }
  chunk(cx, cz) {
    const r = this.region(cx >> 5, cz >> 5);
    return r ? r.read(cx & 31, cz & 31) : null;
  }
  // Every region file in the folder: [rx, rz, file].
  files() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch (e) { return []; }
    const out = [];
    for (const n of names) { const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(n); if (m) out.push([Number(m[1]), Number(m[2]), path.join(this.dir, n)]); }
    return out;
  }
  close() { for (const r of this.open.values()) if (r) r.close(); this.open.clear(); }
}

module.exports = { Region, RegionSet, decompress };
