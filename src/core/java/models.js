'use strict';
// Java Edition block models: blockstates/<block>.json picks models (variants or multipart), models
// inherit from parents and are made of elements (boxes with per-face UVs, rotations and tints).
// The result is the same model object the Bedrock side builds, so the mesher treats both alike.
const Q = require('../quads');
const { Models } = require('../models');
const { special, extras, NEEDS_ENTITY_JAVA } = require('./special');

const DIRS = ['down', 'up', 'north', 'south', 'west', 'east'];
const INVISIBLE = /^(air|cave_air|void_air|barrier|structure_void|light|moving_piston|bubble_column|piston_head_placeholder)$/;
// Blocks you walk through (Java decides collision in code, not in the models).
const NO_COLLISION = /(torch|rail|redstone_wire|button|lever|sign|banner|vine|lichen|sapling|flower|tulip|^short_grass$|^grass$|tall_grass|fern$|bush$|^bush$|mushroom$|roots$|sprouts|petals|wildflowers|leaf_litter|cobweb|tripwire|kelp|seagrass|coral_fan|coral$|sugar_cane|^wheat$|carrots|potatoes|beetroots|nether_wart|sweet_berry|pressure_plate|fire$|portal$|^light$|dandelion|poppy|orchid|allium|bluet|daisy|cornflower|lily_of_the_valley|wither_rose|lilac|peony|rose_bush|torchflower|pitcher|spore_blossom|hanging_roots|cave_vines|weeping_vines|twisting_vines|glow_berries|frogspawn|dry_grass|firefly_bush|cactus_flower|^snow$|scaffolding|^water$|^lava$)/;
// Ground plants that sink a little into the ground by a varying amount (see Mesher).
const SINKS = /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|firefly_bush|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|torchflower|pitcher_plant|open_eyeblossom|closed_eyeblossom|.*_sapling|brown_mushroom|red_mushroom|crimson_roots|warped_roots|nether_sprouts|crimson_fungus|warped_fungus)$/;

// Light level (0-15) Java blocks give off.
function emission(n, st) {
  const lit = st.lit === 'true';
  if (n === 'light') return Number(st.level || 15) | 0;
  if (/candle_cake$/.test(n)) return lit ? 3 : 0;
  if (/candle$/.test(n)) return lit ? 3 * (Number(st.candles || 1) | 0) : 0;
  if (/copper_bulb$/.test(n)) return lit ? (/oxidized/.test(n) ? 4 : /weathered/.test(n) ? 8 : /exposed/.test(n) ? 12 : 15) : 0;
  if (n === 'respawn_anchor') return Math.max(0, (Number(st.charges || 0) | 0) * 4 - 1);
  if (n === 'sea_pickle') return st.waterlogged === 'true' ? 3 * ((Number(st.pickles || 1) | 0) + 1) : 0;
  if (/^(campfire)$/.test(n)) return lit ? 15 : 0;
  if (n === 'soul_campfire') return lit ? 10 : 0;
  if (/^(furnace|blast_furnace|smoker)$/.test(n)) return lit ? 13 : 0;
  if (/^(redstone_lamp)$/.test(n)) return lit ? 15 : 0;
  if (/redstone_ore$/.test(n)) return lit ? 9 : 0;
  if (/^redstone(_wall)?_torch$/.test(n)) return lit ? 7 : 0;
  if (/^cave_vines(_plant)?$/.test(n)) return st.berries === 'true' ? 14 : 0;
  if (n === 'trial_spawner') return 4;
  if (/^(glowstone|sea_lantern|jack_o_lantern|shroomlight|.*froglight|beacon|conduit|lava|end_portal|end_gateway|fire|lantern|.*copper_lantern)$/.test(n)) return 15;
  if (/^(torch|wall_torch|.*copper_torch|.*copper_wall_torch|end_rod)$/.test(n)) return 14;
  if (n === 'nether_portal') return 11;
  if (/^(soul_torch|soul_wall_torch|soul_lantern|soul_fire|crying_obsidian)$/.test(n)) return 10;
  if (/^(ender_chest|enchanting_table|glow_lichen)$/.test(n)) return 7;
  if (n === 'sculk_catalyst') return 6;
  if (n === 'amethyst_cluster') return 5;
  if (n === 'large_amethyst_bud') return 4;
  if (n === 'magma_block') return 3;
  if (n === 'medium_amethyst_bud') return 2;
  if (/^(small_amethyst_bud|brewing_stand|brown_mushroom|dragon_egg|end_portal_frame|sculk_sensor|calibrated_sculk_sensor)$/.test(n)) return 1;
  return 0;
}

// Fixed or biome tints for faces with a tintindex (Java registers these in code, not in models).
function tintOf(ns, n, st, index) {
  if (ns === 'minecraft') {
    if (/^(grass_block|short_grass|grass|tall_grass|fern|large_fern|potted_fern|sugar_cane|bush)$/.test(n)) return { tintMethod: 'grass' };
    if (/^(pink_petals|wildflowers)$/.test(n)) return index === 1 || index === 0 ? { tintMethod: 'grass' } : null;
    if (/^(oak_leaves|jungle_leaves|acacia_leaves|dark_oak_leaves|mangrove_leaves|vine)$/.test(n)) return { tintMethod: 'foliage' };
    if (n === 'birch_leaves') return { fixedTint: [128, 167, 85] };
    if (n === 'spruce_leaves') return { fixedTint: [97, 153, 97] };
    if (n === 'leaf_litter') return { tintMethod: 'dry_foliage' };
    if (/^(water|bubble_column|water_cauldron)$/.test(n)) return { tintMethod: 'water' };
    if (n === 'lily_pad') return { fixedTint: [32, 128, 48] };
    if (/^(melon_stem|pumpkin_stem)$/.test(n)) { const a = Number(st.age || 0) | 0; return { fixedTint: [a * 32, 255 - a * 8, a * 4] }; }
    if (/^attached_(melon|pumpkin)_stem$/.test(n)) return { fixedTint: [224, 199, 28] };
    if (n === 'redstone_wire') {
      const f = (Number(st.power || 0) | 0) / 15;
      const c = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
      return { fixedTint: [c(f * 0.6 + (f > 0 ? 0.4 : 0.3)), c(f * f * 0.7 - 0.5), c(f * f * 0.6 - 0.7)] };
    }
    return null;
  }
  // mods register their own colours in code; leaves and grass are the usual ones
  if (/leaves|leaf/.test(n)) return { tintMethod: 'foliage' };
  if (/grass|fern/.test(n)) return { tintMethod: 'grass' };
  return null;
}

// Default face UVs (1/16 units) from an element's position, as the game derives them.
function defaultUV(d, f, t) {
  switch (d) {
    case 0: return [f[0], 16 - t[2], t[0], 16 - f[2]];
    case 1: return [f[0], f[2], t[0], t[2]];
    case 2: return [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]];
    case 3: return [f[0], 16 - t[1], t[0], 16 - f[1]];
    case 4: return [f[2], 16 - t[1], t[2], 16 - f[1]];
    default: return [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]];
  }
}

// "facing=east,half=bottom" against states; "" and "normal" match everything.
function matchVariant(key, st) {
  if (key === '' || key === 'normal') return true;
  for (const kv of key.split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    if (String(st[kv.slice(0, i)]) !== kv.slice(i + 1)) return false;
  }
  return true;
}
function matchWhen(when, st) {
  if (Array.isArray(when.OR)) return when.OR.some((w) => matchWhen(w, st));
  if (Array.isArray(when.AND)) return when.AND.every((w) => matchWhen(w, st));
  for (const k of Object.keys(when)) {
    let want = String(when[k]), neg = false;
    if (want.startsWith('!')) { neg = true; want = want.slice(1); }
    const hit = want.split('|').includes(String(st[k]));
    if (hit === neg) return false;
  }
  return true;
}
const pick = (v) => (Array.isArray(v) ? v[0] : v);

class JavaModels extends Models {
  constructor(res) {
    super(res);
    this.resolved = new Map();
  }

  // ---- models -----------------------------------------------------------------------------------

  // Merged model: { textures, elements, chain: [ids] } following parents.
  resolve(id, depth = 0) {
    const key = String(id).includes(':') ? id : 'minecraft:' + id;
    if (this.resolved.has(key)) return this.resolved.get(key);
    let out = { textures: {}, elements: null, chain: [key] };
    if (depth < 16 && !/^(minecraft:)?builtin\//.test(key)) {
      const m = this.res.model(key);
      if (m) {
        const parent = m.parent ? this.resolve(m.parent, depth + 1) : null;
        out = {
          textures: Object.assign({}, parent ? parent.textures : {}, m.textures || {}),
          elements: m.elements || (parent ? parent.elements : null),
          chain: [key, ...(parent ? parent.chain : [])],
        };
      } else out.missing = true;
    }
    this.resolved.set(key, out);
    return out;
  }

  texture(ref, textures) {
    let t = ref, guard = 0;
    while (typeof t === 'string' && t.startsWith('#') && guard++ < 10) t = textures[t.slice(1)];
    if (t && typeof t === 'object') t = t.sprite || null; // newer format: { sprite, force_translucent }
    return typeof t === 'string' ? (t.includes(':') ? t : 'minecraft:' + t) : null;
  }

  // Quads of one model as placed by a blockstate entry { model, x, y, uvlock }.
  modelQuads(entry, name, states, allBoxes) {
    const m = this.resolve(entry.model);
    if (m.missing) { this.unknown.set(name, 'model not found: ' + entry.model); return null; }
    if (!m.elements) return [];
    const [ns, n] = name.split(':');
    const out = [];
    const boxes = allBoxes ? [] : null; // this entry's own, turned with it below
    for (const el of m.elements) {
      if (!el || !el.from || !el.to || !el.faces) continue;
      const f = el.from, t = el.to, s = 1 / 16;
      let quads = [];
      for (const dirName of DIRS) {
        const face = el.faces[dirName];
        if (!face) continue;
        const d = Q.DIR[dirName];
        // a face's texture is always a reference, with or without the leading #
        const ref = typeof face.texture === 'string' && !face.texture.startsWith('#') ? '#' + face.texture : face.texture;
        const tex = this.texture(ref, m.textures);
        const tint = face.tintindex !== undefined && face.tintindex >= 0 ? tintOf(ns, n, states, face.tintindex) : null;
        const slot = this.slot(tex, tint);
        const p = Q.faceCorners(d, f[0] * s, f[1] * s, f[2] * s, t[0] * s, t[1] * s, t[2] * s);
        const r = face.uv || defaultUV(d, f, t);
        const rot = ((face.rotation || 0) / 90) & 3;
        const uv = new Array(8);
        for (let i = 0; i < 4; i++) {
          const j = (i + rot) & 3;
          uv[i * 2] = (j < 2 ? r[0] : r[2]) * s;
          uv[i * 2 + 1] = (j === 0 || j === 3 ? r[1] : r[3]) * s;
        }
        quads.push({ p, uv, slot, cull: -1, layer: tint ? 1 : 0, explicitUV: !!face.uv });
      }
      // element rotation about its origin, optionally stretched back to full size
      const rt = el.rotation;
      if (rt && (rt.angle || rt.x || rt.y || rt.z)) {
        const o = (rt.origin || [8, 8, 8]).map((v) => v * s);
        let mtx;
        if (rt.axis) {
          const axis = { x: 0, y: 1, z: 2 }[rt.axis];
          mtx = Q.rotation(axis, rt.angle || 0);
          if (rt.rescale) {
            const k = 1 / Math.cos(Math.abs(rt.angle || 0) * Math.PI / 180);
            mtx = Q.mul(Q.scaling(axis === 0 ? 1 : k, axis === 1 ? 1 : k, axis === 2 ? 1 : k), mtx);
          }
        } else mtx = Q.mul(Q.rotation(2, rt.z || 0), Q.mul(Q.rotation(1, rt.y || 0), Q.rotation(0, rt.x || 0)));
        quads = this._transform(quads, Q.about(mtx, o[0], o[1], o[2]));
      } else if (boxes) boxes.push([f[0] * s, f[1] * s, f[2] * s, t[0] * s, t[1] * s, t[2] * s]);
      for (const q of quads) out.push(q);
    }
    // the blockstate's rotation (90 degree steps): x first, then y, both clockwise looking along the axis
    const rx = entry.x || 0, ry = entry.y || 0;
    let quads = out;
    if (rx || ry) {
      const R = Q.about(Q.mul(Q.rotation(1, -ry), Q.rotation(0, -rx)), 0.5, 0.5, 0.5);
      quads = this._transform(out, R);
      if (boxes) {
        for (let i = 0; i < boxes.length; i++) {
          const b = boxes[i], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
          for (let c = 0; c < 8; c++) {
            const x = b[c & 1 ? 3 : 0], y = b[c & 2 ? 4 : 1], z = b[c & 4 ? 5 : 2];
            for (let a = 0; a < 3; a++) { const v = R[a * 4] * x + R[a * 4 + 1] * y + R[a * 4 + 2] * z + R[a * 4 + 3]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
          }
          boxes[i] = [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]];
        }
      }
      // uvlock: textures stay aligned to the world instead of turning with the block
      if (entry.uvlock) {
        for (const q of quads) {
          const nrm = normal(q.p);
          const d = axisDir(nrm);
          if (d < 0) continue;
          for (let i = 0; i < 4; i++) { const tuv = Q.lockedUV(d, q.p[i * 3], q.p[i * 3 + 1], q.p[i * 3 + 2]); q.uv[i * 2] = tuv[0]; q.uv[i * 2 + 1] = tuv[1]; }
        }
      }
    }
    if (allBoxes) for (const b of boxes) allBoxes.push(b);
    return quads;
  }

  _transform(quads, m) {
    const t = Q.transform(quads, m);
    for (let i = 0; i < t.length; i++) { t[i].layer = quads[i].layer; t[i].explicitUV = quads[i].explicitUV; t[i].uv = t[i].uv.slice(); }
    return t;
  }

  // Grass block sides and similar: a tinted overlay drawn on top of the same face. Two faces in one
  // place fight in every 3D program, so they become one face with a texture composed of both.
  mergeOverlays(quads) {
    const at = new Map();
    const keyOf = (q) => { const k = []; for (let i = 0; i < 12; i += 3) k.push(Math.round(q.p[i] * 1024) + ',' + Math.round(q.p[i + 1] * 1024) + ',' + Math.round(q.p[i + 2] * 1024)); return k.sort().join(';'); };
    const out = [];
    for (const q of quads) {
      const k = keyOf(q);
      const prev = at.get(k);
      if (prev && prev.slot !== q.slot && prev.slot.path && q.slot.path && q.layer === 1 && prev.layer === 0) {
        prev.slot = this.slot(prev.slot.path + '+' + q.slot.path, Object.assign({ alphaMasked: true, mode: 'opaque' }, q.slot.tintMethod ? { tintMethod: q.slot.tintMethod } : { fixedTint: q.slot.fixedTint }));
        continue;
      }
      if (!prev) at.set(k, q);
      out.push(q);
    }
    return out;
  }

  // ---- blocks -----------------------------------------------------------------------------------

  // Blockstate entries that apply to these states.
  entries(name, states) {
    const bs = this.res.blockstate(name);
    if (!bs) return null;
    if (bs.variants) {
      for (const k of Object.keys(bs.variants)) if (matchVariant(k, states)) return [pick(bs.variants[k])];
      return [];
    }
    const out = [];
    for (const part of bs.multipart || []) if (!part.when || matchWhen(part.when, states)) out.push(pick(part.apply));
    return out;
  }

  build(name, states, be) {
    const [ns, n] = name.includes(':') ? name.split(':') : ['minecraft', name];
    if (ns === 'minecraft' && INVISIBLE.test(n)) {
      const emit = emission(n, states);
      return emit ? { quads: [], full: false, faces: null, opaque: false, liquid: 0, group: 0, empty: false, invisible: true, emit, boxes: [] } : null;
    }
    if (ns === 'minecraft' && (n === 'water' || n === 'lava')) {
      const water = n === 'water';
      const still = this.slot(water ? 'minecraft:block/water_still' : 'minecraft:block/lava_still', water ? { tintMethod: 'water', opacity: 0.65 } : null);
      const level = states.level !== undefined ? Number(states.level) | 0 : states.liquid_depth | 0;
      return { quads: [], full: false, faces: null, opaque: false, empty: false, group: 0, liquid: water ? 1 : 2, depth: level, slots: [still, still, still, still, still, still], emit: water ? 0 : 15, boxes: [] };
    }
    const list = this.entries(name, states);
    const boxes = [];
    let quads = [], cross = false;
    for (const e of list || []) {
      if (!e || !e.model) continue;
      const q = this.modelQuads(e, name, states, boxes);
      if (q) for (const x of q) quads.push(x);
      if (this.resolve(e.model).chain.some((c) => /block\/(tinted_)?cross(_emissive)?$|flower_pot_cross/.test(c))) cross = true;
    }
    // Blocks the game draws in code (chests, banners, heads, and beds and signs before 26.x): their
    // models have no geometry, so they are built here. The game's own model wins whenever it has some.
    if (!quads.length) {
      const sp = special(this, ns, n, states, be);
      if (sp !== undefined) {
        if (sp && !be && NEEDS_ENTITY_JAVA.test(n)) sp.entityOf = { name, states, variants: new Map() };
        if (sp) { sp.emit = emission(n, states); if (!sp.boxes) sp.boxes = NO_COLLISION.test(n) ? [] : [[0, 0, 0, 1, 1, 1]]; }
        return sp;
      }
      if (!list) {
        this.unknown.set(name, 'no block definition found' + (ns !== 'minecraft' ? ' (is the mod installed in this instance?)' : ''));
        return this.cube(() => this.slot(null));
      }
      return null;
    }
    // parts drawn in code on top of a block model: sign text, the bell itself
    const more = extras(this, ns, n, states, be);
    let needsEntity = false;
    if (more) { for (const x of more.quads) quads.push(x); needsEntity = more.needsEntity; }
    quads = this.mergeOverlays(quads);
    const m = this.finish(quads);
    if (!m) return null;
    if (needsEntity && !be) m.entityOf = { name, states, variants: new Map() };
    m.emit = emission(n, states);
    m.boxes = ns === 'minecraft' && NO_COLLISION.test(n) ? [] : (cross ? [] : boxes.filter((b) => b[3] - b[0] >= 0.1 && b[4] - b[1] > 0 && b[5] - b[2] >= 0.1));
    if (cross && (ns !== 'minecraft' || SINKS.test(n))) m.sink = true;
    // clear glass and ice hide the faces they share with the same block
    if (m.full && !m.opaque && /(^|_)glass$|^ice$|^slime_block$|^honey_block$/.test(n)) m.group = -1;
    return m;
  }

  // The model as its block entity makes it look (sign text, banner patterns, pot sherds).
  withEntity(m, be) {
    const e = m.entityOf;
    if (!e || !be) return m;
    let key;
    try { key = JSON.stringify(be, (k, v) => (k === 'x' || k === 'y' || k === 'z' ? undefined : typeof v === 'bigint' ? String(v) : v)); } catch (err) { return m; }
    let v = e.variants.get(key);
    if (v === undefined) {
      try { v = this.build(e.name, e.states, be) || m; } catch (err) { v = m; }
      e.variants.set(key, v);
    }
    return v;
  }
}

function normal(p) {
  const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2], bx = p[9] - p[0], by = p[10] - p[1], bz = p[11] - p[2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
function axisDir(n) {
  for (let d = 0; d < 6; d++) { const v = Q.DIR_VEC[d]; if (n[0] * v[0] + n[1] * v[1] + n[2] * v[2] > 0.999) return d; }
  return -1;
}

module.exports = { JavaModels, matchVariant, matchWhen, defaultUV, tintOf };
