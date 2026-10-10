'use strict';
// Quad primitives shared by vanilla shapes and add-on geometry.
// Block space is 0..1 per axis: +x east, +y up, +z south. Directions: 0 down, 1 up, 2 north, 3 south, 4 west, 5 east.
// A quad is { p: [12], uv: [8], slot, cull } with corners ordered top-left, bottom-left, bottom-right,
// top-right as seen from outside (counter-clockwise). uv is in image space (v grows downward), 0..1.

const DIR = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
const DIR_NAMES = ['down', 'up', 'north', 'south', 'west', 'east'];
const DIR_VEC = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const OPPOSITE = [1, 0, 3, 2, 5, 4];

// Corners of one face of an axis-aligned box.
function faceCorners(d, x0, y0, z0, x1, y1, z1) {
  switch (d) {
    case 0: return [x0, y0, z1, x0, y0, z0, x1, y0, z0, x1, y0, z1];
    case 1: return [x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0];
    case 2: return [x1, y1, z0, x1, y0, z0, x0, y0, z0, x0, y1, z0];
    case 3: return [x0, y1, z1, x0, y0, z1, x1, y0, z1, x1, y1, z1];
    case 4: return [x0, y1, z0, x0, y0, z0, x0, y0, z1, x0, y1, z1];
    default: return [x1, y1, z1, x1, y0, z1, x1, y0, z0, x1, y1, z0];
  }
}

// Position-locked texture coordinates, the way vanilla maps textures onto partial blocks.
function lockedUV(d, x, y, z) {
  switch (d) {
    case 0: return [x, 1 - z];
    case 1: return [x, z];
    case 2: return [1 - x, 1 - y];
    case 3: return [x, 1 - y];
    case 4: return [z, 1 - y];
    default: return [1 - z, 1 - y];
  }
}

function rectUV(u0, v0, u1, v1) { return [u0, v0, u0, v1, u1, v1, u1, v0]; }

// Box in 1/16 units. tex: slot | (dir) => slot | null. opts.uv: { [dir]: [u0,v0,u1,v1] in 1/16 } overrides.
// While a model is being built, the solid boxes it is made of are recorded here (for walking collision).
let collector = null;
function collectBoxes(arr) { collector = arr; }

function box(out, x0, y0, z0, x1, y1, z1, tex, opts) {
  const s = 1 / 16;
  if (collector) collector.push([Math.min(x0, x1) * s, Math.min(y0, y1) * s, Math.min(z0, z1) * s, Math.max(x0, x1) * s, Math.max(y0, y1) * s, Math.max(z0, z1) * s]);
  const a = [x0 * s, y0 * s, z0 * s, x1 * s, y1 * s, z1 * s];
  for (let d = 0; d < 6; d++) {
    if (opts && opts.skip && opts.skip.includes(d)) continue;
    const slot = typeof tex === 'function' ? tex(d) : tex;
    if (!slot) continue;
    const p = faceCorners(d, a[0], a[1], a[2], a[3], a[4], a[5]);
    let uv;
    const o = opts && opts.uv && opts.uv[d];
    if (o) uv = rectUV(o[0] * s, o[1] * s, o[2] * s, o[3] * s);
    else {
      uv = [];
      for (let i = 0; i < 4; i++) { const t = lockedUV(d, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); uv.push(t[0], t[1]); }
    }
    out.push({ p, uv, slot, cull: -1 });
  }
  return out;
}

// A flat quad with explicit corners (TL, BL, BR, TR) showing the whole texture or a 1/16 rect.
function plane(out, corners, slot, rect) {
  const r = rect || [0, 0, 16, 16];
  out.push({ p: corners.slice(), uv: rectUV(r[0] / 16, r[1] / 16, r[2] / 16, r[3] / 16), slot, cull: -1 });
  return out;
}

// ---- 3x4 matrices (row-major, [r00 r01 r02 tx, r10 ...]) ----------------------------------------

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
function mul(a, b) {
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
    }
  }
  return o;
}
function translation(x, y, z) { return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]; }
function scaling(x, y, z) { return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0]; }
function snap(v) { const r = Math.round(v); return Math.abs(v - r) < 1e-9 ? r : v; }
// Right-handed rotation about an axis (0 x, 1 y, 2 z), degrees.
function rotation(axis, deg) {
  const t = deg * Math.PI / 180, c = snap(Math.cos(t)), s = snap(Math.sin(t));
  if (axis === 0) return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
  if (axis === 1) return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}
function about(m, px, py, pz) { return mul(translation(px, py, pz), mul(m, translation(-px, -py, -pz))); }

function transform(quads, m) {
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  return quads.map((q) => {
    const p = new Array(12);
    for (let i = 0; i < 12; i += 3) {
      const x = q.p[i], y = q.p[i + 1], z = q.p[i + 2];
      p[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
      p[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      p[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
    }
    let uv = q.uv;
    if (det < 0) { // mirrored: restore counter-clockwise winding
      const pr = [p[9], p[10], p[11], p[6], p[7], p[8], p[3], p[4], p[5], p[0], p[1], p[2]];
      uv = [uv[6], uv[7], uv[4], uv[5], uv[2], uv[3], uv[0], uv[1]];
      return { p: pr, uv, slot: q.slot, cull: -1 };
    }
    return { p, uv, slot: q.slot, cull: -1 };
  });
}

function normalOf(p) {
  const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
  const bx = p[9] - p[0], by = p[10] - p[1], bz = p[11] - p[2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  if (nx === 0 && ny === 0 && nz === 0) { // degenerate first corner: use the opposite one
    const cx = p[6] - p[3], cy = p[7] - p[4], cz = p[8] - p[5];
    nx = ay * cz - az * cy; ny = az * cx - ax * cz; nz = ax * cy - ay * cx;
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

const EPS = 1e-4;
const FULL_UV = [0, 0, 0, 1, 1, 1, 1, 0];

// Tags each quad with its normal, the block face it lies on (cull) and whether it covers that whole
// face with the standard texture orientation (plain). Returns model flags.
function finalize(quads) {
  const faces = [null, null, null, null, null, null];
  for (const q of quads) {
    for (let i = 0; i < 12; i++) { const r = Math.round(q.p[i] * 4096) / 4096; if (Math.abs(q.p[i] - r) < 1e-6) q.p[i] = r; }
    const n = q.n = normalOf(q.p);
    q.cull = -1; q.fullFace = false; q.plain = false;
    for (let d = 0; d < 6; d++) {
      const v = DIR_VEC[d];
      if (n[0] * v[0] + n[1] * v[1] + n[2] * v[2] < 0.999) continue;
      const axis = d < 2 ? 1 : d < 4 ? 2 : 0, want = d & 1 ? 1 : 0;
      let on = true;
      for (let i = 0; i < 4; i++) if (Math.abs(q.p[i * 3 + axis] - want) > EPS) on = false;
      if (!on) break;
      q.cull = d;
      const ref = faceCorners(d, 0, 0, 0, 1, 1, 1);
      let covered = 0, plain = true;
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          if (Math.abs(q.p[i * 3] - ref[j * 3]) < EPS && Math.abs(q.p[i * 3 + 1] - ref[j * 3 + 1]) < EPS && Math.abs(q.p[i * 3 + 2] - ref[j * 3 + 2]) < EPS) {
            covered++;
            if (Math.abs(q.uv[i * 2] - FULL_UV[j * 2]) > EPS || Math.abs(q.uv[i * 2 + 1] - FULL_UV[j * 2 + 1]) > EPS) plain = false;
            break;
          }
        }
      }
      if (covered === 4) { q.fullFace = true; q.plain = plain; if (!faces[d]) faces[d] = q; }
      break;
    }
  }
  // "Double sided" models carry a second, inward-facing copy of each face. Two coincident faces
  // z-fight in every DCC tool, so keep one per location (the outward one when it sits on the block edge).
  const seen = new Map();
  for (const q of quads) {
    const pts = [];
    for (let i = 0; i < 12; i += 3) pts.push(Math.round(q.p[i] * 1024) + ',' + Math.round(q.p[i + 1] * 1024) + ',' + Math.round(q.p[i + 2] * 1024));
    const key = pts.sort().join(';');
    const prev = seen.get(key);
    if (!prev || (prev.cull < 0 && q.cull >= 0)) seen.set(key, q);
  }
  if (seen.size !== quads.length) quads = quads.filter((q) => seen.get([0, 3, 6, 9].map((i) => Math.round(q.p[i] * 1024) + ',' + Math.round(q.p[i + 1] * 1024) + ',' + Math.round(q.p[i + 2] * 1024)).sort().join(';')) === q);
  const full = quads.length === 6 && faces.every(Boolean);
  return { quads, full, faces: full ? faces : null };
}

module.exports = {
  DIR, DIR_NAMES, DIR_VEC, OPPOSITE, faceCorners, lockedUV, rectUV, box, plane, collectBoxes,
  IDENTITY, mul, translation, scaling, rotation, about, transform, finalize,
};
