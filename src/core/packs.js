'use strict';
// Resource / behavior pack discovery and layered file access.
const fs = require('fs');
const path = require('path');

// Bedrock JSON allows comments and trailing commas.
function parseJson(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return JSON.parse(text); } catch (e) { /* fall through to lenient parse */ }
  let out = '', i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2); i = i < 0 ? n : i + 2;
    } else { out += c; i++; }
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

function readJsonFile(file) {
  try { return parseJson(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// .brarchive: Mojang's flat archive used for the built-in packs.
// header: magic(8) count(u32) version(u32); entries: nameLen(u8) name(247) offset(u32) length(u32); then data.
class BrArchive {
  constructor(file) {
    this.file = file; this.entries = new Map();
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      const count = head.readUInt32LE(8);
      const table = Buffer.alloc(count * 256);
      fs.readSync(fd, table, 0, table.length, 16);
      const base = 16 + count * 256;
      for (let i = 0; i < count; i++) {
        const o = i * 256;
        const name = table.toString('utf8', o + 1, o + 1 + table[o]);
        this.entries.set(name.toLowerCase(), [base + table.readUInt32LE(o + 248), table.readUInt32LE(o + 252)]);
      }
    } finally { fs.closeSync(fd); }
  }
  read(name) {
    const e = this.entries.get(name.toLowerCase());
    if (!e) return null;
    const buf = Buffer.allocUnsafe(e[1]);
    // the archive stays open: indexing entities and models reads hundreds of entries in a row
    if (this.fd === undefined) this.fd = fs.openSync(this.file, 'r');
    fs.readSync(this.fd, buf, 0, e[1], e[0]);
    return buf;
  }
  close() { if (this.fd !== undefined) { try { fs.closeSync(this.fd); } catch (e) { /* already closed */ } this.fd = undefined; } }
}

// Running out of file handles is temporary: such a failure must not be remembered as "missing".
const outOfHandles = (e) => e && (e.code === 'EMFILE' || e.code === 'ENFILE');

// One pack on disk. Reads loose files first, then falls back to __brarchive bundles.
class Pack {
  constructor(dir, label) {
    this.dir = dir; this.label = label || path.basename(dir);
    this.archives = new Map();
    this.looseDirs = new Map();
    this.hasArchives = fs.existsSync(path.join(dir, '__brarchive'));
    this.manifest = readJsonFile(path.join(dir, 'manifest.json'));
    this.uuid = this.manifest && this.manifest.header && this.manifest.header.uuid;
    this.name = (this.manifest && this.manifest.header && this.manifest.header.name) || this.label;
  }
  _archive(relDir) {
    let a = this.archives.get(relDir);
    if (a === undefined) {
      const f = path.join(this.dir, '__brarchive', relDir + '.brarchive');
      try { a = fs.existsSync(f) ? new BrArchive(f) : null; } catch (e) { if (outOfHandles(e)) return null; a = null; }
      this.archives.set(relDir, a);
    }
    return a;
  }

  // Releases the archive files this pack holds open. Must be called when a world is closed:
  // every reload opens fresh packs, and leftover handles pile up until Windows refuses new ones.
  close() {
    for (const a of this.archives.values()) if (a) a.close();
    this.archives.clear();
  }
  read(rel) {
    const i = rel.lastIndexOf('/');
    // skip the attempt when the folder is not there at all (the built-in packs keep most things
    // only in archives, and thousands of failed opens add up)
    let loose = true;
    if (this.hasArchives && i > 0) {
      const dir = rel.slice(0, i);
      loose = this.looseDirs.get(dir);
      if (loose === undefined) { loose = fs.existsSync(path.join(this.dir, dir)); this.looseDirs.set(dir, loose); }
    }
    if (loose) { try { return fs.readFileSync(path.join(this.dir, rel)); } catch (e) { if (outOfHandles(e)) throw e; /* not loose */ } }
    if (this.hasArchives) {
      if (i > 0) {
        const a = this._archive(rel.slice(0, i));
        if (a) return a.read(rel.slice(i + 1));
      }
    }
    return null;
  }
  // Lists files under a folder (recursive) as pack-relative paths.
  list(relDir) {
    const out = [];
    const walk = (d, rel) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (e.isDirectory()) walk(path.join(d, e.name), rel + '/' + e.name);
        else out.push(rel + '/' + e.name);
      }
    };
    walk(path.join(this.dir, relDir), relDir);
    if (this.hasArchives) {
      const walkA = (d, rel) => {
        let ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
          if (e.isDirectory()) walkA(path.join(d, e.name), rel + '/' + e.name);
          else if (e.name.endsWith('.brarchive')) {
            const sub = rel + '/' + e.name.slice(0, -10);
            const a = this._archive(sub);
            if (a) for (const n of a.entries.keys()) out.push(sub + '/' + n);
          }
        }
      };
      const a = this._archive(relDir);
      if (a) for (const n of a.entries.keys()) out.push(relDir + '/' + n);
      walkA(path.join(this.dir, '__brarchive', relDir), relDir);
    }
    return out;
  }
}

// Packs ordered lowest priority first.
class PackStack {
  constructor(packs) { this.packs = packs; }
  read(rel) {
    for (let i = this.packs.length - 1; i >= 0; i--) {
      const b = this.packs[i].read(rel);
      if (b) return b;
    }
    return null;
  }
  // Every pack's copy of a JSON file, lowest priority first (for merging).
  readAllJson(rel) {
    const out = [];
    for (const p of this.packs) {
      const b = p.read(rel);
      if (!b) continue;
      try { out.push(parseJson(b.toString('utf8'))); } catch (e) { /* skip broken json */ }
    }
    return out;
  }
}

function versionOf(name) {
  const m = /_(\d+(?:\.\d+)*)$/.exec(name);
  return m ? m[1].split('.').map(Number) : [0];
}
function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function findGameData() {
  const cands = [];
  for (const drive of 'CDEFGH') {
    cands.push(`${drive}:\\XboxGames\\Minecraft for Windows\\Content\\data`);
  }
  try {
    const wa = 'C:\\Program Files\\WindowsApps';
    for (const d of fs.readdirSync(wa)) if (/^Microsoft\.MinecraftUWP_/.test(d)) cands.push(path.join(wa, d, 'data'));
  } catch (e) { /* WindowsApps is often unreadable */ }
  for (const drive of 'CDEFGH') cands.push(`${drive}:\\XboxGames\\Minecraft Preview for Windows\\Content\\data`);
  return cands.find((c) => fs.existsSync(path.join(c, 'resource_packs', 'vanilla'))) || null;
}

function vanillaPacks(gameData, kind) {
  if (!gameData) return [];
  const root = path.join(gameData, kind);
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return []; }
  names = names.filter((n) => n === 'vanilla' || /^vanilla_\d/.test(n))
    .sort((a, b) => (a === 'vanilla' ? -1 : b === 'vanilla' ? 1 : cmpVersion(versionOf(a), versionOf(b))));
  return names.map((n) => new Pack(path.join(root, n), n));
}

// Finds every pack folder (one manifest.json each) below a directory, up to two levels deep.
function scanPackDir(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const d = path.join(dir, e.name);
    if (fs.existsSync(path.join(d, 'manifest.json'))) out.push(d);
    else {
      try {
        for (const s of fs.readdirSync(d, { withFileTypes: true })) {
          if (s.isDirectory() && fs.existsSync(path.join(d, s.name, 'manifest.json'))) out.push(path.join(d, s.name));
        }
      } catch (e2) { /* ignore */ }
    }
  }
}

// Resolves the packs a world lists in world_<kind>.json to folders on disk.
// kind: 'resource_packs' | 'behavior_packs'. Returns { packs: [Pack...] lowest priority first, missing: [uuid...] }.
function worldPacks(worldDir, kind, comMojangRoots) {
  const listed = readJsonFile(path.join(worldDir, `world_${kind}.json`)) || [];
  const dirs = [];
  scanPackDir(path.join(worldDir, kind), dirs);
  for (const root of comMojangRoots) {
    scanPackDir(path.join(root, kind), dirs);
    scanPackDir(path.join(root, 'development_' + kind), dirs);
  }
  const byUuid = new Map();
  for (const d of dirs) {
    const m = readJsonFile(path.join(d, 'manifest.json'));
    const id = m && m.header && m.header.uuid;
    if (id && !byUuid.has(id.toLowerCase())) byUuid.set(id.toLowerCase(), d);
  }
  const packs = [], missing = [];
  // The file lists highest priority first.
  for (const entry of listed) {
    const id = entry && entry.pack_id && String(entry.pack_id).toLowerCase();
    if (!id) continue;
    const d = byUuid.get(id);
    if (d) packs.unshift(new Pack(d)); else missing.push(id);
  }
  return { packs, missing };
}

module.exports = { parseJson, readJsonFile, Pack, PackStack, BrArchive, findGameData, vanillaPacks, worldPacks, outOfHandles };
