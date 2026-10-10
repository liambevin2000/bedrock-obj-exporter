'use strict';
// Minimal zip extractor for .mcpack / .mcaddon / .mcworld / .zip (stored + deflate entries).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function extractZip(zipFile, destDir) {
  const fd = fs.openSync(zipFile, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('Not a zip archive');
    const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const root = path.resolve(destDir);
    let p = 0, files = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
      p += 46 + nameLen + extraLen + commentLen;
      const target = path.resolve(root, name);
      if (target !== root && !target.startsWith(root + path.sep)) continue; // never write outside the destination
      if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, local);
      const dataOff = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const raw = Buffer.alloc(csize);
      if (csize) fs.readSync(fd, raw, 0, csize, dataOff);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      files++;
    }
    return files;
  } finally { fs.closeSync(fd); }
}

// Finds pack folders (containing manifest.json) of a given module type under a directory.
function findPacks(dir, type) {
  const out = [];
  const walk = (d, depth) => {
    const mf = path.join(d, 'manifest.json');
    if (fs.existsSync(mf)) {
      try {
        const { parseJson } = require('./packs');
        const m = parseJson(fs.readFileSync(mf, 'utf8'));
        const types = (m.modules || []).map((x) => x.type);
        if (!type || types.includes(type) || !types.length) out.push(d);
      } catch (e) { out.push(d); }
      return;
    }
    if (depth >= 3) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
  };
  walk(dir, 0);
  return out;
}

module.exports = { extractZip, findPacks };
