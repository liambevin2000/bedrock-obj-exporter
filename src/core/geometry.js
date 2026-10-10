'use strict';
// Converts add-on block geometry (geo.json) into quads in block space.
const Q = require('./quads');
const molang = require('./molang');

const FACE_ORDER = ['down', 'up', 'north', 'south', 'west', 'east'];

// Bedrock model space mirrors X relative to the world, and rotations are stored with X and Y negated.
function pivotRotation(pivot, rot) {
  if (!rot || (!rot[0] && !rot[1] && !rot[2])) return null;
  const px = -(pivot ? pivot[0] : 0) / 16 + 0.5, py = (pivot ? pivot[1] : 0) / 16, pz = (pivot ? pivot[2] : 0) / 16 + 0.5;
  const m = Q.mul(Q.rotation(2, rot[2] || 0), Q.mul(Q.rotation(1, -(rot[1] || 0)), Q.rotation(0, -(rot[0] || 0))));
  return Q.about(m, px, py, pz);
}

// uv rect [u, v, w, h] in texels -> corner uvs (TL, BL, BR, TR), normalised.
function cornersFromRect(r, tw, th, flipU, flipV, rot) {
  let u0 = r[0], v0 = r[1], u1 = r[0] + r[2], v1 = r[1] + r[3];
  if (flipU) { const t = u0; u0 = u1; u1 = t; }
  if (flipV) { const t = v0; v0 = v1; v1 = t; }
  let uv = [u0 / tw, v0 / th, u0 / tw, v1 / th, u1 / tw, v1 / th, u1 / tw, v0 / th];
  for (let k = ((rot || 0) / 90) & 3; k > 0; k--) uv = [uv[2], uv[3], uv[4], uv[5], uv[6], uv[7], uv[0], uv[1]];
  return uv;
}

// geo: geometry description; slotFor(instanceName, faceName) -> slot; states for bone_visibility.
function geometryQuads(geo, slotFor, boneVisibility, states) {
  const desc = geo.description || {};
  const tw = desc.texture_width || 16, th = desc.texture_height || 16;
  const bones = geo.bones || [];
  const byName = new Map(bones.map((b) => [b.name, b]));
  const matrices = new Map();
  const boneMatrix = (b, depth) => {
    if (matrices.has(b.name)) return matrices.get(b.name);
    let m = pivotRotation(b.pivot, b.rotation) || Q.IDENTITY;
    const parent = b.parent && byName.get(b.parent);
    if (parent && depth < 32) m = Q.mul(boneMatrix(parent, depth + 1), m);
    matrices.set(b.name, m);
    return m;
  };
  const visible = (b, depth) => {
    if (boneVisibility && Object.prototype.hasOwnProperty.call(boneVisibility, b.name)) {
      if (!molang.test(boneVisibility[b.name], states)) return false;
    }
    const parent = b.parent && byName.get(b.parent);
    return parent && depth < 32 ? visible(parent, depth + 1) : true;
  };

  const out = [];
  for (const b of bones) {
    if (!b.cubes || !b.cubes.length || !visible(b, 0)) continue;
    const bm = boneMatrix(b, 0);
    for (const c of b.cubes) {
      const o = c.origin || [0, 0, 0], s = c.size || [0, 0, 0], inf = c.inflate || 0;
      const x0 = (-(o[0] + s[0]) - inf) / 16 + 0.5, x1 = (-o[0] + inf) / 16 + 0.5;
      const y0 = (o[1] - inf) / 16, y1 = (o[1] + s[1] + inf) / 16;
      const z0 = (o[2] - inf) / 16 + 0.5, z1 = (o[2] + s[2] + inf) / 16 + 0.5;
      const quads = [];
      const boxUv = Array.isArray(c.uv);
      for (let d = 0; d < 6; d++) {
        const name = FACE_ORDER[d];
        let uv, inst = name;
        if (boxUv) {
          const u = c.uv[0], v = c.uv[1], w = Math.floor(s[0]), h = Math.floor(s[1]), dp = Math.floor(s[2]);
          let r, fu = !!c.mirror, fv = false;
          if (name === 'east') r = [u, v + dp, dp, h];
          else if (name === 'north') r = [u + dp, v + dp, w, h];
          else if (name === 'west') r = [u + dp + w, v + dp, dp, h];
          else if (name === 'south') r = [u + dp + w + dp, v + dp, w, h];
          else if (name === 'up') { r = [u + dp, v, w, dp]; fu = !fu; fv = true; }
          else { r = [u + dp + w, v, w, dp]; fu = !fu; }
          if (r[2] === 0 || r[3] === 0) continue;
          uv = cornersFromRect(r, tw, th, fu, fv, 0);
        } else {
          const f = c.uv && c.uv[name];
          if (!f || !f.uv) continue;
          const size = f.uv_size || [0, 0];
          const flip = name === 'up' || name === 'down';
          uv = cornersFromRect([f.uv[0], f.uv[1], size[0], size[1]], tw, th, flip, flip, f.uv_rotation);
          if (f.material_instance) inst = f.material_instance;
        }
        const slot = slotFor(inst, name);
        if (!slot) continue;
        quads.push({ p: Q.faceCorners(d, x0, y0, z0, x1, y1, z1), uv, slot, cull: -1 });
      }
      const cm = pivotRotation(c.pivot, c.rotation);
      const m = cm ? Q.mul(bm, cm) : bm;
      for (const q of (m === Q.IDENTITY ? quads : Q.transform(quads, m))) out.push(q);
    }
  }
  return out;
}

module.exports = { geometryQuads };
