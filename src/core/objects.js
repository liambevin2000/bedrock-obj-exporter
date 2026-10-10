'use strict';
// Picking "things" out of a selection: click a block, get the whole tree or structure it belongs to.
// Works on a plain grid of model ids for the selection (index = (z * sy + y) * sx + x).

const TREE = /(log|wood|leaves|leaf|stem|hyphae|branch|roots|wart_block|shroomlight|canopy|bark|trunk|mushroom_block|bamboo|cactus|chorus|azalea)/;
const LEAF = /(leaves|leaf|wart_block|canopy|azalea|mushroom_block)/;
const MANMADE = /(plank|brick|stairs|slab|wall|fence|door|glass|pane|tile|pillar|polished|chiseled|cut_|carved|smooth_|lamp|lantern|torch|wool|carpet|concrete|bookshelf|chest|barrel|furnace|table|bed|banner|sign|bars|ladder|rail|scaffold|beam|roof|window|chair|shelf|candle|anvil|cauldron|hopper|campfire|copper|quartz|purpur|prismarine_brick|hay)/;
const NATURAL = /^minecraft:(dirt|coarse_dirt|dirt_with_roots|grass_block|grass|podzol|mycelium|stone|granite|diorite|andesite|deepslate|tuff|calcite|dripstone_block|sand|red_sand|gravel|suspicious_\w+|clay|mud|sandstone|red_sandstone|hardened_clay|terracotta|(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_terracotta|snow|snow_layer|powder_snow|ice|packed_ice|blue_ice|frosted_ice|water|flowing_water|lava|flowing_lava|bedrock|netherrack|soul_sand|soul_soil|basalt|blackstone|end_stone|obsidian|crying_obsidian|magma|moss_block|pale_moss_block|sculk|\w*nylium|\w+_ore|amethyst_block|budding_amethyst|glowstone|pointed_dripstone|infested_\w+|smooth_basalt|raw_\w+_block|kelp|seagrass|bubble_column)$/;

// Copies the selection (with gap filling and edits applied) into one id grid.
function buildGrid(session, sel, opts = {}) {
  const mesher = session.mesher(sel, { fill: opts.fill, edits: opts.edits });
  const b = mesher.b;
  const sx = b.x1 - b.x0 + 1, sy = b.y1 - b.y0 + 1, sz = b.z1 - b.z0 + 1;
  const ids = new Uint16Array(sx * sy * sz);
  for (const [cx, cz] of mesher.chunkList()) {
    const c = mesher._decode(cx, cz);
    const x0 = Math.max(b.x0, cx * 16), x1 = Math.min(b.x1, cx * 16 + 15);
    const z0 = Math.max(b.z0, cz * 16), z1 = Math.min(b.z1, cz * 16 + 15);
    for (const [sub, data] of c.subs) {
      const y0 = Math.max(b.y0, sub * 16), y1 = Math.min(b.y1, sub * 16 + 15);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const base = ((x & 15) << 8) | ((z & 15) << 4);
        for (let y = y0; y <= y1; y++) ids[((z - b.z0) * sy + (y - b.y0)) * sx + (x - b.x0)] = data.ids[base | (y & 15)];
      }
    }
  }
  return { ids, dims: [sx, sy, sz], min: [b.x0, b.y0, b.z0], classes: null };
}

// Per model id: 0 air, 1 terrain, 2 tree wood, 3 leaves, 4 ground plant, 5 built / other, 6 attached decoration.
function classify(grid, models) {
  if (grid.classes) return grid.classes;
  const list = models.list, ids = grid.ids;
  const counts = new Uint32Array(list.length);
  let solid = 0;
  for (let i = 0; i < ids.length; i++) if (ids[i]) { counts[ids[i]]++; solid++; }
  // the same block in different states (rotations, growth) counts as one kind
  const byName = new Map();
  for (let id = 1; id < list.length; id++) if (counts[id]) byName.set(list[id].name, (byName.get(list[id].name) || 0) + counts[id]);
  const cls = new Uint8Array(list.length);
  for (let id = 1; id < list.length; id++) {
    const m = list[id], n = m.name, short = n.slice(n.indexOf(':') + 1);
    if (m.liquid || m.invisible) cls[id] = 1;
    else if (m.sink) cls[id] = 4;
    // walk-through decorations (torches, ladders, branches, potted plants, add-on foliage) belong
    // to whatever they are attached to rather than linking separate things together
    else if (!m.full && (!m.boxes || !m.boxes.length)) cls[id] = 6;
    else if (LEAF.test(short) && !MANMADE.test(short)) cls[id] = 3;
    else if (TREE.test(short) && !MANMADE.test(short)) cls[id] = 2;
    else if (NATURAL.test(n)) cls[id] = 1;
    // add-on terrain has no known names: a block that makes up a good share of everything solid,
    // and does not look built, is ground
    else if (!n.startsWith('minecraft:') && !MANMADE.test(short) && (byName.get(n) || 0) >= solid * 0.015) cls[id] = 1;
    else cls[id] = 5;
  }
  grid.classes = cls;
  return cls;
}

// First visible block along a ray (world coordinates). Small plants are looked through.
function castRay(grid, models, origin, dir) {
  const [sx, sy, sz] = grid.dims, min = grid.min, list = models.list;
  const size = [sx, sy, sz];
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = origin[a] - min[a], d = dir[a];
    if (Math.abs(d) < 1e-9) { if (o < 0 || o > size[a]) return null; continue; }
    let ta = -o / d, tb = (size[a] - o) / d;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  const p = [0, 1, 2].map((a) => origin[a] - min[a] + dir[a] * (t0 + 1e-4));
  const cell = p.map((v, a) => Math.min(size[a] - 1, Math.max(0, Math.floor(v))));
  const step = dir.map((d) => (d > 0 ? 1 : -1));
  const tMax = [0, 1, 2].map((a) => (Math.abs(dir[a]) < 1e-9 ? Infinity : ((dir[a] > 0 ? cell[a] + 1 - p[a] : p[a] - cell[a]) / Math.abs(dir[a]))));
  const tDelta = dir.map((d) => (Math.abs(d) < 1e-9 ? Infinity : 1 / Math.abs(d)));
  for (let guard = 0; guard < sx + sy + sz + 4; guard++) {
    const id = grid.ids[(cell[2] * sy + cell[1]) * sx + cell[0]];
    if (id) { const m = list[id]; if (!m.liquid && !m.invisible && !m.sink) return cell; }
    const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
    cell[a] += step[a]; tMax[a] += tDelta[a];
    if (cell[a] < 0 || cell[a] >= size[a]) return null;
  }
  return null;
}

const LIMIT = 3000000;

// The object the given cell belongs to. Returns the block list (see finish) or { kind: 'terrain' }.
// opts (all in grid cells): minY - ignore everything below this layer (undefined = work it out);
// limit - [x0,y0,z0,x1,y1,z1] box the object may not leave.
function findObject(grid, models, cell, opts = {}) {
  const [sx, sy, sz] = grid.dims, ids = grid.ids, N = ids.length, SXY = sx * sy;
  const cls = classify(grid, models);
  const at = (x, y, z) => (z * sy + y) * sx + x;
  const start = at(cell[0], cell[1], cell[2]);
  const startClass = cls[ids[start]];
  if (startClass <= 1) return { kind: 'terrain' };

  const L = opts.limit || [0, 0, 0, sx - 1, sy - 1, sz - 1];
  let minY = opts.minY === undefined || opts.minY === null ? 0 : opts.minY;
  // cells outside the allowed region are simply never entered
  const blocked = new Uint8Array(N);
  const applyRegion = () => {
    blocked.fill(0);
    const y0 = Math.max(minY, L[1]);
    if (L[0] <= 0 && L[2] <= 0 && L[3] >= sx - 1 && L[5] >= sz - 1 && y0 <= 0 && L[4] >= sy - 1) return;
    for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) {
      const rowOut = z < L[2] || z > L[5] || y < y0 || y > L[4];
      const base = (z * sy + y) * sx;
      if (rowOut) blocked.fill(1, base, base + sx);
      else { if (L[0] > 0) blocked.fill(1, base, base + L[0]); if (L[3] < sx - 1) blocked.fill(1, base + L[3] + 1, base + sx); }
    }
  };
  applyRegion();
  let cut = null; // grid layer of the ground that was cut away, if any

  let seen = new Uint8Array(N);
  // Flood fill over the 26 neighbours of each cell, through cells whose class passes `ok`.
  const flood = (seeds, ok, maxSteps) => {
    const out = [];
    let frontier = seeds.slice();
    for (const s of seeds) { seen[s] = 1; out.push(s); }
    for (let depth = 0; frontier.length && depth < (maxSteps || Infinity); depth++) {
      const next = [];
      for (const i of frontier) {
        const x = i % sx, y = ((i / sx) | 0) % sy, z = (i / SXY) | 0;
        for (let dz = -1; dz <= 1; dz++) { const nz = z + dz; if (nz < 0 || nz >= sz) continue;
          for (let dy = -1; dy <= 1; dy++) { const ny = y + dy; if (ny < 0 || ny >= sy) continue;
            for (let dx = -1; dx <= 1; dx++) { const nx = x + dx; if (nx < 0 || nx >= sx) continue;
              const n = (nz * sy + ny) * sx + nx;
              if (seen[n] || blocked[n] || !ok(cls[ids[n]])) continue;
              seen[n] = 1; out.push(n); next.push(n);
              if (out.length > LIMIT) return out;
            } } }
      }
      frontier = next;
    }
    return out;
  };

  let kind, cells;
  let treeStart = startClass === 3;
  let wood = null;
  if (startClass === 2) {
    // a log is a tree if its connected wood touches leaves; otherwise it is a beam in a building
    wood = flood([start], (c) => c === 2);
    const touchesLeaves = wood.some((i) => {
      const x = i % sx, y = ((i / sx) | 0) % sy, z = (i / SXY) | 0;
      for (let d = 0; d < 6; d++) {
        const nx = x + [1, -1, 0, 0, 0, 0][d], ny = y + [0, 0, 1, -1, 0, 0][d], nz = z + [0, 0, 0, 0, 1, -1][d];
        if (nx >= 0 && nx < sx && ny >= 0 && ny < sy && nz >= 0 && nz < sz && cls[ids[at(nx, ny, nz)]] === 3) return true;
      }
      return false;
    });
    if (touchesLeaves) treeStart = true;
    else { for (const i of wood) seen[i] = 0; wood = null; }
  }

  if (treeStart) {
    kind = 'tree';
    if (!wood) {
      // clicked the canopy: walk through leaves to the nearest wood
      const leaves = flood([start], (c) => c === 3, 12);
      let found = -1;
      for (const i of leaves) {
        const x = i % sx, y = ((i / sx) | 0) % sy, z = (i / SXY) | 0;
        for (let dz = -1; dz <= 1 && found < 0; dz++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dx = -1; dx <= 1 && found < 0; dx++) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx < 0 || nx >= sx || ny < 0 || ny >= sy || nz < 0 || nz >= sz) continue;
          if (cls[ids[at(nx, ny, nz)]] === 2) found = at(nx, ny, nz);
        }
        if (found >= 0) break;
      }
      for (const i of leaves) seen[i] = 0;
      wood = found >= 0 ? flood([found], (c) => c === 2) : [];
      if (!wood.length) { cells = flood([start], (c) => c === 3, 6); return finish(grid, models, 'tree', cells); }
    }
    // Leaves go to whichever trunk is nearest, so touching canopies split between their trees.
    const owner = new Int8Array(N); // 1 ours, 2 another tree
    let frontier = [];
    for (const i of wood) { owner[i] = 1; frontier.push(i); }
    const b = bounds(wood, sx, sy), M = 10;
    for (let z = Math.max(0, b[2] - M); z <= Math.min(sz - 1, b[5] + M); z++) for (let y = Math.max(0, b[1] - M); y <= Math.min(sy - 1, b[4] + M); y++) for (let x = Math.max(0, b[0] - M); x <= Math.min(sx - 1, b[3] + M); x++) {
      const i = at(x, y, z);
      if (!owner[i] && cls[ids[i]] === 2) { owner[i] = 2; frontier.push(i); }
    }
    cells = wood.slice();
    for (let depth = 0; depth < 8 && frontier.length; depth++) {
      const next = [];
      for (const i of frontier) {
        const x = i % sx, y = ((i / sx) | 0) % sy, z = (i / SXY) | 0, o = owner[i];
        for (let d = 0; d < 6; d++) {
          const nx = x + [1, -1, 0, 0, 0, 0][d], ny = y + [0, 0, 1, -1, 0, 0][d], nz = z + [0, 0, 0, 0, 1, -1][d];
          if (nx < 0 || nx >= sx || ny < 0 || ny >= sy || nz < 0 || nz >= sz) continue;
          const n = at(nx, ny, nz);
          if (owner[n] || blocked[n] || cls[ids[n]] !== 3) continue;
          owner[n] = o; next.push(n);
          if (o === 1) cells.push(n);
        }
      }
      frontier = next;
    }
  } else if (startClass === 4 || startClass === 6) {
    kind = 'plant';
    cells = [start];
    if (cell[1] + 1 < sy && cls[ids[start + sx]] === startClass) cells.push(start + sx);
    if (cell[1] > 0 && cls[ids[start - sx]] === startClass) cells.push(start - sx);
    return finish(grid, models, kind, cells);
  } else {
    // a structure: everything connected that is neither ground, leaves nor loose plants
    kind = 'structure';
    const built = (c) => c === 5 || c === 2;
    cells = flood([start], built);
    // Towns sit on paving that is "built" too, which joins every building into one. If one layer of
    // the result is a sheet covering a good part of the whole selection, that is the ground: cut
    // just above it and pick again, so only what stands on it at this spot remains.
    if (opts.minY === undefined || opts.minY === null) {
      const area = new Uint32Array(sy);
      for (const i of cells) area[((i / sx) | 0) % sy]++;
      let aMax = 0;
      for (let y = 0; y < sy; y++) if (area[y] > aMax) aMax = area[y];
      if (aMax >= 0.2 * sx * sz) {
        let top = 0;
        for (let y = 0; y < sy; y++) if (area[y] >= 0.4 * aMax) top = y;
        if (cell[1] > top) {
          cut = top; minY = top + 1;
          applyRegion();
          seen = new Uint8Array(N);
          cells = flood([start], built);
        }
      }
    } else if (minY > 0) cut = minY - 1;
  }
  // small plants and decorations standing on the object come with it
  const inSet = new Uint8Array(N);
  for (const i of cells) inSet[i] = 1;
  const extra = [];
  for (const i of cells) {
    let up = i + sx;
    for (let k = 0; k < 2; k++, up += sx) {
      if ((((up / sx) | 0) % sy) === 0 || up >= N || inSet[up] || cls[ids[up]] !== 4) break;
      inSet[up] = 1; extra.push(up);
    }
    // things fixed to its sides, top or underside: torches, ladders, branches, hanging plants
    const x = i % sx, y = ((i / sx) | 0) % sy, z = (i / SXY) | 0;
    for (let d = 0; d < 6; d++) {
      const nx = x + [1, -1, 0, 0, 0, 0][d], ny = y + [0, 0, 1, -1, 0, 0][d], nz = z + [0, 0, 0, 0, 1, -1][d];
      if (nx < 0 || nx >= sx || ny < 0 || ny >= sy || nz < 0 || nz >= sz) continue;
      const n = at(nx, ny, nz);
      if (inSet[n] || blocked[n] || cls[ids[n]] !== 6) continue;
      inSet[n] = 1; extra.push(n);
      // and the rest of a two-block-tall decoration
      for (const m of [n + sx, n - sx]) if (m >= 0 && m < N && !inSet[m] && cls[ids[m]] === 6 && ids[m] !== 0 && Math.abs((((m / sx) | 0) % sy) - ny) === 1) { inSet[m] = 1; extra.push(m); }
    }
  }
  for (const i of extra) cells.push(i);
  const r = finish(grid, models, kind, cells);
  r.cut = cut === null ? null : cut + grid.min[1]; // world Y of the ground layer left behind
  return r;
}

function bounds(cells, sx, sy) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], SXY = sx * sy;
  for (const i of cells) {
    const x = i % sx, y = ((i / sx) | 0) % sy, z = (i / SXY) | 0;
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z;
    if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
  }
  return b;
}

// World-coordinate block list for a set of grid cells.
function finish(grid, models, kind, cells) {
  const [sx, sy] = grid.dims, SXY = sx * sy, min = grid.min, n = cells.length;
  const x = new Int32Array(n), y = new Int32Array(n), z = new Int32Array(n), ids = new Uint16Array(n);
  const names = new Map();
  for (let k = 0; k < n; k++) {
    const i = cells[k];
    x[k] = min[0] + i % sx; y[k] = min[1] + ((i / sx) | 0) % sy; z[k] = min[2] + ((i / SXY) | 0);
    ids[k] = grid.ids[i];
    const nm = models.list[ids[k]].name;
    names.set(nm, (names.get(nm) || 0) + 1);
  }
  const main = [...names.entries()].sort((a, b) => b[1] - a[1])[0];
  return { kind, x, y, z, ids, main: main ? main[0] : '', truncated: n > LIMIT };
}

module.exports = { buildGrid, castRay, findObject, classify };
