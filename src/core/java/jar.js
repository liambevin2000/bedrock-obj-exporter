'use strict';
// Java Edition resource packs: the game's client jar, mod jars, resource pack zips and folders.
// All are read in place: a zip is indexed once (central directory) and entries are read on demand.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class ZipArchive {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.entries = new Map(); // name -> [method, compressedSize, localHeaderOffset]
    const size = fs.fstatSync(this.fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(this.fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) { this.close(); throw new Error('Not a zip archive: ' + path.basename(file)); }
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    // zip64: the real values live in the zip64 end record
    if (cdOff === 0xffffffff || count === 0xffff) {
      const loc = e - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const recOff = Number(tail.readBigUInt64LE(loc + 8));
        const rec = Buffer.alloc(56);
        fs.readSync(this.fd, rec, 0, 56, recOff);
        count = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdOff = Number(rec.readBigUInt64LE(48));
      }
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(this.fd, cd, 0, cdSize, cdOff);
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
      if (csize === 0xffffffff || local === 0xffffffff) { // zip64 extra field
        let x = p + 46 + nameLen;
        const end = x + extraLen;
        while (x + 4 <= end) {
          const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
          if (id === 1) {
            let q = x + 4;
            if (cd.readUInt32LE(p + 24) === 0xffffffff) q += 8; // uncompressed size
            if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (local === 0xffffffff) local = Number(cd.readBigUInt64LE(q));
          }
          x += 4 + len;
        }
      }
      p += 46 + nameLen + extraLen + commentLen;
      if (!name.endsWith('/')) this.entries.set(name, [method, csize, local]);
    }
  }
  has(name) { return this.entries.has(name); }
  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const lh = Buffer.alloc(30);
    fs.readSync(this.fd, lh, 0, 30, e[2]);
    const dataOff = e[2] + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = Buffer.alloc(e[1]);
    if (e[1]) fs.readSync(this.fd, raw, 0, e[1], dataOff);
    if (e[0] === 0) return raw;
    if (e[0] === 8) return zlib.inflateRawSync(raw);
    return null;
  }
  close() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (err) { /* already closed */ } this.fd = null; } }
}

// One pack: a folder or a zip/jar. Paths are relative to the pack root ("assets/minecraft/...").
class JavaPack {
  constructor(src, opts = {}) {
    this.src = src;
    this.kind = opts.kind || 'pack'; // 'game' | 'mod' | 'world' | 'pack'
    this.isDir = fs.statSync(src).isDirectory();
    this.zip = this.isDir ? null : new ZipArchive(src);
    this.name = opts.name || path.basename(src).replace(/\.(zip|jar)$/i, '');
    this.namespaces = null;
    try {
      const meta = this.read('pack.mcmeta');
      const j = meta && JSON.parse(meta.toString('utf8').replace(/^﻿/, ''));
      const d = j && j.pack && j.pack.description;
      if (d && !opts.name && this.kind === 'pack') this.description = typeof d === 'string' ? d : (d.text || '');
    } catch (e) { /* no or broken pack.mcmeta */ }
  }
  read(rel) {
    if (this.zip) return this.zip.read(rel);
    try { return fs.readFileSync(path.join(this.src, rel)); } catch (e) { return null; }
  }
  has(rel) {
    if (this.zip) return this.zip.has(rel);
    return fs.existsSync(path.join(this.src, rel));
  }
  // Files under a folder (recursive), as pack-relative paths.
  list(relDir) {
    const prefix = relDir.endsWith('/') ? relDir : relDir + '/';
    if (this.zip) return [...this.zip.entries.keys()].filter((n) => n.startsWith(prefix));
    const out = [];
    const walk = (d, rel) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
        else out.push(rel + e.name);
      }
    };
    walk(path.join(this.src, relDir), prefix);
    return out;
  }
  close() { if (this.zip) this.zip.close(); }
}

// Packs ordered lowest priority first; later packs override earlier ones.
class JavaPackStack {
  constructor(packs) { this.packs = packs; }
  read(rel) {
    for (let i = this.packs.length - 1; i >= 0; i--) {
      const b = this.packs[i].read(rel);
      if (b) return b;
    }
    return null;
  }
  readJson(rel) {
    const b = this.read(rel);
    if (!b) return null;
    try { return JSON.parse(b.toString('utf8').replace(/^﻿/, '')); } catch (e) { return null; }
  }
  close() { for (const p of this.packs) p.close(); }
}

module.exports = { ZipArchive, JavaPack, JavaPackStack };
