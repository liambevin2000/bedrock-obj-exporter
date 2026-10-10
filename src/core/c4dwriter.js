'use strict';
// Writes a selection in the form the Cinema 4D plugin (c4d-plugin/BedrockWorldImporter.pyp) reads:
// one binary mesh file, a folder of textures and a small handoff.json that points at them.
const fs = require('fs');
const path = require('path');
const { encodePng } = require('./resources');

class Grow {
  constructor(Type, n) { this.a = new Type(n); this.n = 0; }
  need(k) { if (this.n + k > this.a.length) { const b = new this.a.constructor(Math.max(this.a.length * 2, this.n + k)); b.set(this.a.subarray(0, this.n)); this.a = b; } }
  bytes() { return Buffer.from(this.a.buffer, this.a.byteOffset, this.n * this.a.BYTES_PER_ELEMENT); }
}

class C4dWriter {
  // dir: export folder. opts: { name, scale }
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.name = opts.name || 'Bedrock World';
    this.scale = opts.scale || 1;
    this.groups = new Map(); // material id -> { points, quads, uvs }
    this.quads = 0;
    fs.mkdirSync(dir, { recursive: true });
  }

  // batch: Map(materialId -> QuadBuffer). Points are welded within a batch (one chunk column).
  add(batch) {
    for (const [mat, qb] of batch) {
      let g = this.groups.get(mat);
      if (!g) { g = { points: new Grow(Float32Array, 4096), quads: new Grow(Uint32Array, 4096), uvs: new Grow(Float32Array, 8192) }; this.groups.set(mat, g); }
      const pos = qb.pos, n = qb.count;
      g.points.need(n * 12); g.quads.need(n * 4); g.uvs.need(n * 8);
      const seen = new Map();
      const refX = Math.floor(pos[0]) - 64, refZ = Math.floor(pos[2]) - 64;
      const P = g.points, Qd = g.quads;
      for (let q = 0; q < n; q++) {
        for (let c = 0; c < 4; c++) {
          const o = q * 12 + c * 3, x = pos[o], y = pos[o + 1], z = pos[o + 2];
          const key = (Math.round((x - refX) * 512) * 65536 + Math.round((z - refZ) * 512)) * 1048576 + Math.round((y + 1024) * 512);
          let i = seen.get(key);
          if (i === undefined) { i = P.n / 3; seen.set(key, i); P.a[P.n++] = x; P.a[P.n++] = y; P.a[P.n++] = z; }
          Qd.a[Qd.n++] = i;
        }
      }
      g.uvs.a.set(qb.uv.subarray(0, n * 8), g.uvs.n); g.uvs.n += n * 8;
      this.quads += n;
    }
  }

  // imageOf(material) picks the picture to write (as authored, or simplified).
  finish(materials, imageOf) {
    // Textures get a fresh folder per export and are never cleaned up: objects already imported
    // into a Cinema 4D scene keep pointing at the files they were built from.
    const stamp = Date.now();
    const texDir = path.join(this.dir, 'textures-' + stamp.toString(36));
    fs.mkdirSync(texDir, { recursive: true });
    const meshPath = path.join(this.dir, 'world.bin');
    const fd = fs.openSync(meshPath, 'w');
    const groups = [];
    let offset = 0;
    try {
      for (const id of [...this.groups.keys()].sort((a, b) => a - b)) {
        const g = this.groups.get(id), m = materials[id];
        let tex = path.join(texDir, m.name + '.png');
        const group = { name: m.name, mode: m.mode, texture: tex, points: g.points.n / 3, quads: g.quads.n / 4, offset };
        const image = imageOf ? imageOf(m) : m.image;
        const strip = image.strip;
        if (strip && strip.order.length > 1) {
          // Animated texture: one numbered PNG per frame in its own folder. Cinema 4D's bitmap
          // shader plays sibling files with a shared name and numbered suffix as a sequence.
          const dir = path.join(texDir, m.name + '-frames');
          fs.mkdirSync(dir, { recursive: true });
          const w = image.w, bytes = w * w * 4;
          strip.order.forEach((frame, i) => {
            const data = strip.data.subarray(frame * bytes, (frame + 1) * bytes);
            fs.writeFileSync(path.join(dir, `${m.name}_${String(i).padStart(4, '0')}.png`), encodePng({ w, h: w, data }));
          });
          tex = path.join(dir, `${m.name}_0000.png`);
          group.texture = tex; group.frames = strip.order.length; group.fps = strip.fps;
          this.animated = (this.animated || 0) + 1;
        } else fs.writeFileSync(tex, encodePng(image));
        const parts = [g.points.bytes(), g.quads.bytes(), g.uvs.bytes()];
        for (const p of parts) fs.writeSync(fd, p);
        groups.push(group);
        offset += parts[0].length + parts[1].length + parts[2].length;
      }
    } finally { fs.closeSync(fd); }
    const handoff = { app: 'BedrockObjExporter', version: 1, name: this.name, meshPath, unitCm: 100 * this.scale, groups, exportedAt: stamp };
    fs.writeFileSync(path.join(this.dir, 'handoff.json'), JSON.stringify(handoff, null, 2));
    return { dir: this.dir, quads: this.quads, materials: groups.length, animated: this.animated || 0, bytes: offset };
  }
}

module.exports = { C4dWriter };
