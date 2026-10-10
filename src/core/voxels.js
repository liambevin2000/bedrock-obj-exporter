'use strict';
// Voxel data for the 3D preview: collision shapes for walking, and Minecraft-style light levels
// (sky light and block light, flood-filled like the game does).
// Cell index is (z * sy + y) * sx + x so the arrays can be uploaded as 3D textures unchanged.

function voxelize(session, sel, opts = {}) {
  const mesher = session.mesher(sel, { fill: opts.fill, edits: opts.edits, only: opts.only });
  const b = mesher.b, list = session.models.list;
  const sx = b.x1 - b.x0 + 1, sy = b.y1 - b.y0 + 1, sz = b.z1 - b.z0 + 1, N = sx * sy * sz;
  const wantLight = opts.light !== false;
  const shape = new Uint8Array(N);
  // 0 clear, 1 opaque, 2 dims sky light a little (leaves), 3 dims it more (liquids)
  const kind = wantLight ? new Uint8Array(N) : null;
  const blk = wantLight ? new Uint8Array(N) : null;

  const shapes = [[]];              // id -> boxes
  const shapeIndex = new Map([['', 0]]);
  const shapeOf = [], kindOf = [];
  const info = (id) => {
    const m = list[id];
    let s = 0;
    if (m.boxes && m.boxes.length) {
      const key = m.boxes.map((x) => x.map((v) => Math.round(v * 1000) / 1000).join(',')).join(';');
      s = shapeIndex.get(key);
      if (s === undefined) {
        if (shapes.length < 255) { s = shapes.length; shapes.push(m.boxes); shapeIndex.set(key, s); }
        else s = shapeIndex.get('0,0,0,1,1,1') || 0;
      }
    }
    shapeOf[id] = s;
    kindOf[id] = m.opaque ? 1 : m.liquid ? 3 : (m.full ? 2 : 0);
  };

  const seeds = [];
  for (const [cx, cz] of mesher.chunkList()) {
    const c = mesher._decode(cx, cz);
    const x0 = Math.max(b.x0, cx * 16), x1 = Math.min(b.x1, cx * 16 + 15);
    const z0 = Math.max(b.z0, cz * 16), z1 = Math.min(b.z1, cz * 16 + 15);
    for (const [sub, data] of c.subs) {
      const y0 = Math.max(b.y0, sub * 16), y1 = Math.min(b.y1, sub * 16 + 15);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const base = ((x & 15) << 8) | ((z & 15) << 4);
          for (let y = y0; y <= y1; y++) {
            const id = data.ids[base | (y & 15)];
            if (id === 0) continue;
            if (shapeOf[id] === undefined) info(id);
            const i = ((z - b.z0) * sy + (y - b.y0)) * sx + (x - b.x0);
            shape[i] = shapeOf[id];
            if (wantLight) {
              kind[i] = kindOf[id];
              const e = list[id].emit;
              if (e > 0) { blk[i] = e; seeds.push(i); }
            }
          }
        }
      }
    }
  }

  const out = { dims: [sx, sy, sz], min: [b.x0, b.y0, b.z0], shape, shapes, light: null };
  if (!wantLight) return out;

  const SX = sx, SXY = sx * sy;
  const flood = (level, queue) => {
    // breadth-first spread, one level lost per block
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      const l = level[i] - 1;
      if (l <= 0) continue;
      const x = i % sx, y = ((i / sx) | 0) % sy, z = (i / SXY) | 0;
      if (x > 0) { const n = i - 1; if (kind[n] !== 1 && level[n] < l) { level[n] = l; queue.push(n); } }
      if (x < sx - 1) { const n = i + 1; if (kind[n] !== 1 && level[n] < l) { level[n] = l; queue.push(n); } }
      if (y > 0) { const n = i - SX; if (kind[n] !== 1 && level[n] < l) { level[n] = l; queue.push(n); } }
      if (y < sy - 1) { const n = i + SX; if (kind[n] !== 1 && level[n] < l) { level[n] = l; queue.push(n); } }
      if (z > 0) { const n = i - SXY; if (kind[n] !== 1 && level[n] < l) { level[n] = l; queue.push(n); } }
      if (z < sz - 1) { const n = i + SXY; if (kind[n] !== 1 && level[n] < l) { level[n] = l; queue.push(n); } }
    }
  };
  flood(blk, seeds);

  // Sky light: straight down from the top of the selection, then sideways into overhangs and caves.
  const sky = new Uint8Array(N);
  const q = [];
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      let l = 15;
      for (let y = sy - 1; y >= 0 && l > 0; y--) {
        const i = (z * sy + y) * sx + x;
        const k = kind[i];
        if (k === 1) break;
        if (k === 2) l -= 1; else if (k === 3) l -= 2;
        if (l <= 0) break;
        sky[i] = l;
      }
    }
  }
  for (let i = 0; i < N; i++) {
    const l = sky[i];
    if (l < 2) continue;
    const x = i % sx, y = ((i / sx) | 0) % sy, z = (i / SXY) | 0;
    // only cells with a darker open neighbour need to spread
    if ((x > 0 && kind[i - 1] !== 1 && sky[i - 1] < l - 1) || (x < sx - 1 && kind[i + 1] !== 1 && sky[i + 1] < l - 1) ||
        (z > 0 && kind[i - SXY] !== 1 && sky[i - SXY] < l - 1) || (z < sz - 1 && kind[i + SXY] !== 1 && sky[i + SXY] < l - 1) ||
        (y > 0 && kind[i - SX] !== 1 && sky[i - SX] < l - 1)) q.push(i);
  }
  flood(sky, q);

  const light = new Uint8Array(N * 2);
  for (let i = 0; i < N; i++) { light[i * 2] = sky[i] * 17; light[i * 2 + 1] = blk[i] * 17; }
  out.light = light;
  return out;
}

module.exports = { voxelize };
