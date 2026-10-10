'use strict';
// Streams quads into a Wavefront OBJ + MTL + textures folder.
const fs = require('fs');
const path = require('path');
const { encodePng } = require('./resources');

const AXIS_NORMALS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const fmt = (v) => { const s = (Math.round(v * 10000) / 10000).toString(); return s === '-0' ? '0' : s; };

class ObjWriter {
  // opts: { scale }
  constructor(objPath, opts = {}) {
    this.objPath = objPath;
    this.dir = path.dirname(objPath);
    this.base = path.basename(objPath, path.extname(objPath));
    this.scale = opts.scale || 1;
    fs.mkdirSync(this.dir, { recursive: true });
    this.fd = fs.openSync(objPath, 'w');
    this.chunks = []; this.pending = 0;
    this.nv = 0; this.nvt = 0; this.nvn = 6;
    this.normals = new Map();
    this.used = new Set();
    this.quads = 0;
    this.current = -1;
    this.materialNames = null;
    this._w(`# Exported by Bedrock OBJ Exporter\nmtllib ${this.base}.mtl\no ${this.base.replace(/\s+/g, '_')}\n`);
    for (const n of AXIS_NORMALS) this._w(`vn ${n[0]} ${n[1]} ${n[2]}\n`);
  }

  _w(s) {
    this.chunks.push(s); this.pending += s.length;
    if (this.pending > 1 << 20) this._flush();
  }
  _flush() {
    if (!this.chunks.length) return;
    fs.writeSync(this.fd, this.chunks.join(''));
    this.chunks = []; this.pending = 0;
  }

  // batch: Map(materialId -> QuadBuffer); materials: Resources.materials
  add(batch, materials) {
    const vmap = new Map(), tmap = new Map();
    const sc = this.scale;
    const lines = [];
    const faces = [];
    let refX = null, refZ = null;
    for (const [mat, qb] of batch) {
      this.used.add(mat);
      faces.push(`usemtl ${materials[mat].name}\n`);
      const pos = qb.pos, uv = qb.uv;
      for (let q = 0; q < qb.count; q++) {
        const o = q * 12, t = q * 8;
        // flat normal
        const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
        const bx = pos[o + 9] - pos[o], by = pos[o + 10] - pos[o + 1], bz = pos[o + 11] - pos[o + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        let ni;
        if (ny < -0.9999) ni = 1; else if (ny > 0.9999) ni = 2; else if (nz < -0.9999) ni = 3;
        else if (nz > 0.9999) ni = 4; else if (nx < -0.9999) ni = 5; else if (nx > 0.9999) ni = 6;
        else {
          const k = fmt(nx) + ' ' + fmt(ny) + ' ' + fmt(nz);
          ni = this.normals.get(k);
          if (!ni) { ni = ++this.nvn; this.normals.set(k, ni); lines.push(`vn ${k}\n`); }
        }
        let f = 'f';
        for (let c = 0; c < 4; c++) {
          const x = pos[o + c * 3], y = pos[o + c * 3 + 1], z = pos[o + c * 3 + 2];
          // batch-local key (a batch is one chunk column) so it fits in a double exactly
          if (refX === null) { refX = Math.floor(x) - 64; refZ = Math.floor(z) - 64; }
          const vk = (Math.round((x - refX) * 512) * 65536 + Math.round((z - refZ) * 512)) * 1048576 + Math.round((y + 1024) * 512);
          let vi = vmap.get(vk);
          if (!vi) { vi = ++this.nv; vmap.set(vk, vi); lines.push(`v ${fmt(x * sc)} ${fmt(y * sc)} ${fmt(z * sc)}\n`); }
          const u = uv[t + c * 2], v = 1 - uv[t + c * 2 + 1];
          const tk = (Math.round(u * 1024) + 16777216) * 33554432 + Math.round(v * 1024) + 16777216;
          let ti = tmap.get(tk);
          if (!ti) { ti = ++this.nvt; tmap.set(tk, ti); lines.push(`vt ${fmt(u)} ${fmt(v)}\n`); }
          f += ` ${vi}/${ti}/${ni}`;
        }
        faces.push(f + '\n');
        this.quads++;
      }
    }
    this._w(lines.join(''));
    this._w(faces.join(''));
  }

  // Writes the MTL and textures. Returns a summary.
  // imageOf(material) picks the picture to write (as authored, or simplified).
  finish(materials, imageOf) {
    this._flush();
    fs.closeSync(this.fd);
    const texDir = path.join(this.dir, this.base + '_textures');
    fs.mkdirSync(texDir, { recursive: true });
    let mtl = '# Exported by Bedrock OBJ Exporter\n';
    const ids = [...this.used].sort((a, b) => a - b);
    for (const id of ids) {
      const m = materials[id];
      const file = `${this.base}_textures/${m.name}.png`;
      fs.writeFileSync(path.join(this.dir, file), encodePng(imageOf ? imageOf(m) : m.image));
      mtl += `\nnewmtl ${m.name}\nKa 1 1 1\nKd 1 1 1\nKs 0 0 0\nNs 0\nillum 1\nmap_Kd ${file}\n`;
      if (m.mode !== 'opaque') mtl += `map_d ${file}\n`;
    }
    fs.writeFileSync(path.join(this.dir, this.base + '.mtl'), mtl);
    return { obj: this.objPath, quads: this.quads, vertices: this.nv, materials: ids.length, bytes: fs.statSync(this.objPath).size };
  }

  abort() { try { fs.closeSync(this.fd); } catch (e) { /* already closed */ } }
}

module.exports = { ObjWriter };
