'use strict';
// Read-only LevelDB reader for Minecraft Bedrock worlds (Mojang's fork: zlib-compressed blocks).
// Pure JS so it runs anywhere Node does, with no native build step. Never writes to the world.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    b = buf[pos.p++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return result;
}

function snappyDecompress(src) {
  const pos = { p: 0 };
  const len = readVarint(src, pos);
  const out = Buffer.allocUnsafe(len);
  let p = pos.p, o = 0;
  while (p < src.length) {
    const tag = src[p++];
    const type = tag & 3;
    if (type === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let i = 0; i < bytes; i++) n |= src[p++] << (8 * i);
        n >>>= 0;
      }
      n += 1;
      src.copy(out, o, p, p + n);
      p += n; o += n;
    } else {
      let n, off;
      if (type === 1) {
        n = ((tag >> 2) & 7) + 4;
        off = ((tag >> 5) << 8) | src[p++];
      } else if (type === 2) {
        n = (tag >> 2) + 1;
        off = src[p] | (src[p + 1] << 8); p += 2;
      } else {
        n = (tag >> 2) + 1;
        off = src.readUInt32LE(p); p += 4;
      }
      for (let i = 0; i < n; i++, o++) out[o] = out[o - off];
    }
  }
  return out;
}

// Log-format reader shared by MANIFEST and .log files.
function* logRecords(buf) {
  const BLOCK = 32768;
  let p = 0, parts = null;
  while (p + 7 <= buf.length) {
    const left = BLOCK - (p % BLOCK);
    if (left < 7) { p += left; continue; }
    const len = buf.readUInt16LE(p + 4);
    const type = buf[p + 6];
    if (type === 0 && len === 0) { p += left; continue; } // preallocated/zeroed tail
    const data = buf.subarray(p + 7, p + 7 + len);
    p += 7 + len;
    if (data.length < len) break; // torn write at the tail
    if (type === 1) { parts = null; yield data; }
    else if (type === 2) parts = [data];
    else if (type === 3) { if (parts) parts.push(data); }
    else if (type === 4) { if (parts) { parts.push(data); yield Buffer.concat(parts); parts = null; } }
    else break;
  }
}

function compareBytes(a, aStart, aEnd, b, bStart, bEnd) {
  const n = Math.min(aEnd - aStart, bEnd - bStart);
  for (let i = 0; i < n; i++) {
    const d = a[aStart + i] - b[bStart + i];
    if (d) return d;
  }
  return (aEnd - aStart) - (bEnd - bStart);
}

class Table {
  constructor(file, number, level, smallest, largest) {
    this.file = file; this.number = number; this.level = level;
    this.smallest = smallest; this.largest = largest; // user keys (may be null when discovered without a manifest)
    this.fd = null; this.index = null;
  }
  open() {
    if (this.index !== null) return;
    // A table that is still being written (world open in the game) or damaged has no valid footer.
    // Skip it instead of failing the whole world.
    this.index = { keys: [], offs: [], sizes: [] };
    try { this._open(); } catch (e) {
      this.index = { keys: [], offs: [], sizes: [] };
      try { this._salvage(); } catch (e2) { /* keep whatever was recovered */ }
      this.broken = this.index.offs.length === 0;
      this.salvaged = !this.broken;
    }
  }
  // The game was closed while writing this table: the index at the end is missing, but the data
  // blocks before it are intact. Walk them one by one and rebuild the index.
  _salvage() {
    if (this.fd === null) this.fd = fs.openSync(this.file, 'r');
    const size = fs.fstatSync(this.fd).size;
    const buf = Buffer.allocUnsafe(size);
    fs.readSync(this.fd, buf, 0, size, 0);
    const { keys, offs, sizes } = this.index;
    let p = 0;
    while (p < size - 5) {
      let r;
      try { r = zlib.inflateRawSync(buf.subarray(p), { info: true }); } catch (e) { break; }
      const used = r.engine.bytesWritten;
      if (!used || buf[p + used] !== 4 || r.buffer.length < 8) break;
      let last = null;
      try { forEachEntry(r.buffer, (k) => { last = k; }); } catch (e) { break; }
      if (!last || last.length < 8) break;
      keys.push(Buffer.from(last.subarray(0, last.length - 8))); offs.push(p); sizes.push(used);
      p += used + 5;
    }
  }
  _open() {
    this.fd = fs.openSync(this.file, 'r');
    const size = fs.fstatSync(this.fd).size;
    if (size < 48) throw new Error('Table too small');
    const footer = Buffer.allocUnsafe(48);
    fs.readSync(this.fd, footer, 0, 48, size - 48);
    if (footer.readUInt32LE(40) !== 0x8b80fb57 || footer.readUInt32LE(44) !== 0xdb477524) throw new Error('Bad table footer');
    const pos = { p: 0 };
    readVarint(footer, pos); readVarint(footer, pos); // metaindex handle
    const indexOff = readVarint(footer, pos), indexSize = readVarint(footer, pos);
    const block = this.readBlock(indexOff, indexSize);
    // Index entries: separator key -> data block handle.
    const keys = [], offs = [], sizes = [];
    forEachEntry(block, (key, vStart, vEnd) => {
      keys.push(Buffer.from(key.subarray(0, key.length - 8)));
      const vp = { p: vStart };
      offs.push(readVarint(block, vp)); sizes.push(readVarint(block, vp));
    });
    this.index = { keys, offs, sizes };
  }
  readBlock(offset, size) {
    const raw = Buffer.allocUnsafe(size + 1);
    fs.readSync(this.fd, raw, 0, size + 1, offset);
    const type = raw[size];
    const body = raw.subarray(0, size);
    switch (type) {
      case 0: return body;
      case 1: return snappyDecompress(body);
      case 2: return zlib.inflateSync(body);
      case 4: return zlib.inflateRawSync(body);
      default: throw new Error(`Unknown LevelDB block compression ${type} in ${path.basename(this.file)}`);
    }
  }
  close() { if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; } }
}

// Calls fn(keyBuffer, valueStart, valueEnd) for each entry. keyBuffer is reused between calls.
function forEachEntry(block, fn) {
  const numRestarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - numRestarts * 4;
  let key = Buffer.allocUnsafe(256), keyLen = 0;
  const pos = { p: 0 };
  while (pos.p < end) {
    const shared = readVarint(block, pos), nonShared = readVarint(block, pos), vLen = readVarint(block, pos);
    const need = shared + nonShared;
    if (need > key.length) { const nk = Buffer.allocUnsafe(need * 2); key.copy(nk, 0, 0, shared); key = nk; }
    block.copy(key, shared, pos.p, pos.p + nonShared);
    keyLen = need;
    const vStart = pos.p + nonShared;
    pos.p = vStart + vLen;
    if (fn(key.subarray(0, keyLen), vStart, vStart + vLen) === false) return;
  }
}

class LevelDB {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.cacheLimit = opts.cacheBlocks || 256;
    this.cache = new Map(); // "fileNo:offset" -> decompressed block (LRU by insertion order)
    this.mem = new Map();   // latin1 user key -> Buffer | null (deleted), from the write-ahead log
    this.level0 = []; this.levels = [];
    this._load();
  }

  _load() {
    const files = fs.readdirSync(this.dir);
    try {
      const head = fs.readFileSync(path.join(this.dir, 'CURRENT')).subarray(0, 8);
      if (head.length === 8 && head.readUInt32LE(0) === 0 && head.readUInt32LE(4) === 0x9bcfb9fc) {
        throw Object.assign(new Error('This world is encrypted (Marketplace content), so its blocks cannot be read.'), { encrypted: true });
      }
    } catch (e) { if (e.encrypted) throw e; }
    let live = null, logNumber = 0;
    try {
      const current = fs.readFileSync(path.join(this.dir, 'CURRENT'), 'utf8').trim();
      const manifest = fs.readFileSync(path.join(this.dir, current));
      live = new Map();
      for (const rec of logRecords(manifest)) {
        const pos = { p: 0 };
        while (pos.p < rec.length) {
          const tag = readVarint(rec, pos);
          if (tag === 1) { pos.p += readVarint(rec, pos); }
          else if (tag === 2) logNumber = readVarint(rec, pos);
          else if (tag === 3 || tag === 4 || tag === 9) readVarint(rec, pos);
          else if (tag === 5) { readVarint(rec, pos); pos.p += readVarint(rec, pos); }
          else if (tag === 6) { readVarint(rec, pos); live.delete(readVarint(rec, pos)); }
          else if (tag === 7) {
            const level = readVarint(rec, pos), number = readVarint(rec, pos);
            readVarint(rec, pos);
            const sl = readVarint(rec, pos); const smallest = Buffer.from(rec.subarray(pos.p, pos.p + sl - 8)); pos.p += sl;
            const ll = readVarint(rec, pos); const largest = Buffer.from(rec.subarray(pos.p, pos.p + ll - 8)); pos.p += ll;
            live.set(number, { level, smallest, largest });
          } else throw new Error('Unknown manifest tag ' + tag);
        }
      }
    } catch (e) {
      live = null; // fall back to treating every table as an overlapping level-0 file
    }

    const tables = [];
    for (const f of files) {
      const m = /^(\d+)\.(ldb|sst)$/.exec(f);
      if (!m) continue;
      const number = parseInt(m[1], 10);
      if (live) {
        const info = live.get(number);
        if (!info) continue;
        tables.push(new Table(path.join(this.dir, f), number, info.level, info.smallest, info.largest));
      } else {
        tables.push(new Table(path.join(this.dir, f), number, 0, null, null));
      }
    }
    this.tables = tables;
    this.level0 = tables.filter(t => t.level === 0).sort((a, b) => b.number - a.number);
    const maxLevel = tables.reduce((m, t) => Math.max(m, t.level), 0);
    for (let l = 1; l <= maxLevel; l++) {
      this.levels.push(tables.filter(t => t.level === l)
        .sort((a, b) => compareBytes(a.smallest, 0, a.smallest.length, b.smallest, 0, b.smallest.length)));
    }

    // Replay write-ahead logs: recent writes the game has not flushed into a table yet.
    const logs = files.map(f => /^(\d+)\.log$/.exec(f)).filter(Boolean)
      .map(m => parseInt(m[1], 10)).filter(n => n >= logNumber).sort((a, b) => a - b);
    for (const n of logs) {
      let buf;
      try { buf = fs.readFileSync(path.join(this.dir, String(n).padStart(6, '0') + '.log')); } catch (e) { continue; }
      for (const rec of logRecords(buf)) {
        if (rec.length < 12) continue;
        const count = rec.readUInt32LE(8);
        const pos = { p: 12 };
        for (let i = 0; i < count && pos.p < rec.length; i++) {
          const type = rec[pos.p++];
          const kl = readVarint(rec, pos); const key = rec.toString('latin1', pos.p, pos.p + kl); pos.p += kl;
          if (type === 1) {
            const vl = readVarint(rec, pos);
            this.mem.set(key, Buffer.from(rec.subarray(pos.p, pos.p + vl))); pos.p += vl;
          } else this.mem.set(key, null);
        }
      }
    }
  }

  _block(table, i) {
    const id = table.number + ':' + table.index.offs[i];
    let b = this.cache.get(id);
    if (b) { this.cache.delete(id); this.cache.set(id, b); return b; }
    b = table.readBlock(table.index.offs[i], table.index.sizes[i]);
    this.cache.set(id, b);
    if (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
    return b;
  }

  // Returns Buffer, null (deleted) or undefined (not in this table).
  _tableGet(table, key) {
    if (table.smallest && (compareBytes(key, 0, key.length, table.smallest, 0, table.smallest.length) < 0 ||
        compareBytes(key, 0, key.length, table.largest, 0, table.largest.length) > 0)) return undefined;
    table.open();
    const keys = table.index.keys;
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareBytes(keys[mid], 0, keys[mid].length, key, 0, key.length) < 0) lo = mid + 1; else hi = mid;
    }
    if (lo >= keys.length) return undefined;
    const block = this._block(table, lo);
    let result;
    forEachEntry(block, (k, vStart, vEnd) => {
      const c = compareBytes(k, 0, k.length - 8, key, 0, key.length);
      if (c < 0) return true;
      if (c === 0) result = k[k.length - 8] === 0 ? null : block.subarray(vStart, vEnd);
      return false;
    });
    return result;
  }

  get(key) {
    const m = this.mem.get(key.toString('latin1'));
    if (m !== undefined) return m;
    for (const t of this.level0) {
      const v = this._tableGet(t, key);
      if (v !== undefined) return v;
    }
    for (const level of this.levels) {
      let lo = 0, hi = level.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const lg = level[mid].largest;
        if (compareBytes(lg, 0, lg.length, key, 0, key.length) < 0) lo = mid + 1; else hi = mid;
      }
      if (lo < level.length) {
        const v = this._tableGet(level[lo], key);
        if (v !== undefined) return v;
      }
    }
    return null;
  }

  // Visits every user key (including stale versions). fn(keyBuffer) - buffer is reused.
  scanKeys(fn) {
    for (const k of this.mem.keys()) fn(Buffer.from(k, 'latin1'));
    for (const t of this.tables) {
      t.open();
      for (let i = 0; i < t.index.offs.length; i++) {
        const block = t.readBlock(t.index.offs[i], t.index.sizes[i]);
        forEachEntry(block, (k) => { fn(k.subarray(0, k.length - 8)); });
      }
    }
  }

  // Number of tables that could not be read (after they have been touched).
  brokenTables() { for (const t of this.tables) t.open(); return this.tables.filter((t) => t.broken).length; }

  close() { for (const t of this.tables) t.close(); this.cache.clear(); }
}

module.exports = { LevelDB };
