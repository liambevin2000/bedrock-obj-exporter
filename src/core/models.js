'use strict';
// Turns a block (name + states) into a renderable model: a list of textured quads plus culling flags.
// Add-on blocks are read from the world's behavior pack (geometry, material instances, permutations).
// Vanilla blocks have no model files in Bedrock, so their shapes are built here.
const Q = require('./quads');
const molang = require('./molang');
const { geometryQuads } = require('./geometry');
const { extraShape, NEEDS_ENTITY } = require('./vanilla-extra');

const INVISIBLE = new Set(['air', 'cave_air', 'void_air', 'structure_void', 'structure_air', 'barrier', 'light_block',
  'moving_block', 'invisible_bedrock', 'bubble_column', 'tripwire', 'trip_wire', 'end_gateway', 'fire', 'soul_fire',
  'piston_arm_collision', 'sticky_piston_arm_collision', 'movingblock', 'camera', 'border_block', 'client_request_placeholder_block']);
// Block-entity driven visuals we do not rebuild (yet); they are reported to the user instead of drawn wrong.
const UNSUPPORTED = /^(tripwire_hook|item_frame)$/;

const ALIAS = { grass_block: 'grass', sea_lantern: 'seaLantern', iron_chain: 'chain' };
const GRASS_TINTED = new Set(['short_grass', 'tall_grass', 'fern', 'large_fern', 'reeds', 'sugar_cane', 'bush', 'tallgrass']);
const FOLIAGE_TINTED = new Set(['oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'vine', 'leaves', 'leaves2']);
const CROPS = new Set(['wheat', 'carrots', 'potatoes', 'beetroot', 'nether_wart', 'torchflower_crop', 'pitcher_crop']);
const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const LIQUIDS = { water: 1, flowing_water: 1, lava: 2, flowing_lava: 2 };

// Rotates a 1/16 box around the block centre: one step = 90 degrees counter-clockwise seen from above
// (north -> west -> south -> east).
function rotBox(b, steps) {
  let [x0, y0, z0, x1, y1, z1] = b;
  for (let i = (steps & 3); i > 0; i--) [x0, z0, x1, z1] = [z0, 16 - x1, z1, 16 - x0];
  return [x0, y0, z0, x1, y1, z1];
}
function rotSlots(s, steps) {
  let [d, u, n, so, w, e] = s;
  for (let i = (steps & 3); i > 0; i--) [n, w, so, e] = [e, n, w, so];
  return [d, u, n, so, w, e];
}
const centred = (m) => Q.about(m, 0.5, 0.5, 0.5);

// Light level (0-15) vanilla blocks give off.
const EMIT = [
  [/^(glowstone|sea_lantern|lit_pumpkin|lava|flowing_lava|shroomlight|.*froglight|beacon|conduit|lit_redstone_lamp|end_portal|end_gateway|fire|campfire|lantern|.*copper_lantern|respawn_anchor)$/, 15],
  [/^(torch|copper_torch|end_rod|cave_vines_body_with_berries|cave_vines_head_with_berries)$/, 14],
  [/^(lit_furnace|lit_blast_furnace|lit_smoker)$/, 13],
  [/^portal$/, 11],
  [/^(soul_torch|soul_lantern|soul_fire|soul_campfire|crying_obsidian)$/, 10],
  [/^(redstone_torch|ender_chest|enchanting_table|glow_lichen|lit_redstone_ore|lit_deepslate_redstone_ore)$/, 7],
  [/^(sea_pickle|sculk_catalyst|vault)$/, 6],
  [/^amethyst_cluster$/, 5], [/^large_amethyst_bud$/, 4], [/^(magma|trial_spawner)$/, 3], [/^medium_amethyst_bud$/, 2],
  [/^(small_amethyst_bud|brewing_stand|brown_mushroom|dragon_egg|end_portal_frame|sculk_sensor)$/, 1],
];
function vanillaEmission(n, st) {
  if ((/campfire$/.test(n) && st.extinguished) || (/candle/.test(n) && !st.lit)) return 0;
  if (/candle/.test(n)) return Math.min(15, 3 * ((st.candles | 0) + 1));
  if (/copper_bulb$/.test(n)) return st.lit ? (/^oxidized|waxed_oxidized/.test(n) ? 4 : /weathered/.test(n) ? 8 : /exposed/.test(n) ? 12 : 15) : 0;
  if (n === 'respawn_anchor') return Math.max(0, (st.respawn_anchor_charge | 0) * 4 - 1);
  for (const [re, v] of EMIT) if (re.test(n)) return v;
  return 0;
}

class Models {
  constructor(res) {
    this.res = res;
    this.list = [{ id: 0, name: 'minecraft:air', empty: true, quads: [], full: false, opaque: false, liquid: 0 }];
    this.index = new Map();
    this.slots = new Map();
    this.unknown = new Map();     // block name -> reason, for the export report
    this.groups = new Map();
  }

  // palette entry { name, states } -> model id
  idFor(entry) {
    const name = entry.name || 'minecraft:air';
    const states = entry.states || {};
    let sk = '';
    for (const k in states) sk += k + '=' + states[k] + ',';
    const key = name + '|' + sk;
    let id = this.index.get(key);
    if (id !== undefined) return id;
    let m;
    const boxes = [];
    Q.collectBoxes(boxes);
    try { m = this.build(name, states); } catch (e) { m = null; this.unknown.set(name, 'error: ' + e.message); }
    Q.collectBoxes(null);
    const emit = m && m.emit !== undefined ? m.emit : (name.startsWith('minecraft:') ? vanillaEmission(name.slice(10), states) : 0);
    // blocks we do not draw can still light their surroundings (fire, campfires, end rods...)
    if (!m && emit > 0) m = { quads: [], full: false, faces: null, opaque: false, liquid: 0, group: 0, empty: false, invisible: true };
    if (!m) id = 0;
    else {
      m.emit = emit;
      // collision: add-on blocks say so themselves; vanilla shapes collide with the boxes they are built from
      if (!m.boxes) m.boxes = m.liquid || m.invisible ? [] : boxes.filter((b) => b[3] - b[0] >= 0.2 || b[5] - b[2] >= 0.2);
      m.id = id = this.list.length; m.name = name;
      if (m.sink && /(^|:)(web|.*vines.*|hanging_roots|.*coral.*|spore_blossom)$/.test(name)) m.sink = false;
      if (m.group === -1) {
        if (!this.groups.has(name)) this.groups.set(name, this.groups.size + 1);
        m.group = this.groups.get(name);
      }
      this.list.push(m);
    }
    this.index.set(key, id);
    return id;
  }

  // ---- slots (texture + how to draw it) ---------------------------------------------------------

  slot(path, o) {
    o = o || {};
    const key = `${path}|${o.mode || ''}|${o.tintMethod || ''}|${o.alphaMasked ? 1 : 0}|${o.fixedTint ? o.fixedTint.join(',') : ''}|${o.opacity || ''}`;
    let s = this.slots.get(key);
    if (s) return s;
    s = { path, mode: o.mode || null, tintMethod: o.tintMethod || null, alphaMasked: !!o.alphaMasked, fixedTint: o.fixedTint || null, opacity: o.opacity || 0, byBiome: new Map() };
    s.mat = this.res.material(path, { mode: s.mode, tint: s.fixedTint || (s.tintMethod ? this.res.biomeTint(s.tintMethod, 1) : null), alphaMasked: s.alphaMasked, opacity: s.opacity });
    this.slots.set(key, s);
    return s;
  }

  // Final material id for a slot in a given biome.
  material(slot, biome) {
    if (!slot.tintMethod) return slot.mat;
    let m = slot.byBiome.get(biome);
    if (m === undefined) {
      m = this.res.material(slot.path, { mode: slot.mode, tint: this.res.biomeTint(slot.tintMethod, biome), alphaMasked: slot.alphaMasked, opacity: slot.opacity });
      slot.byBiome.set(biome, m);
    }
    return m;
  }

  terrainSlot(shortName, variant, o) {
    const t = shortName ? this.res.terrainTexture(shortName, variant) : null;
    if (!t) return this.slot(null);
    return this.slot(t.path, t.tint && !(o && o.tintMethod) ? Object.assign({ fixedTint: t.tint }, o) : o);
  }

  // ---- model assembly -------------------------------------------------------------------------

  finish(quads, extra) {
    if (!quads.length) return null;
    const f = Q.finalize(quads);
    const mode = (s) => this.res.materials[s.mat].mode;
    const m = Object.assign({ quads: f.quads, full: f.full, faces: f.faces, opaque: false, liquid: 0, group: 0, empty: false }, extra);
    if (f.full) {
      m.opaque = f.faces.every((q) => mode(q.slot) === 'opaque');
      // see-through cubes (glass, ice) hide the faces they share with the same block
      if (!m.opaque && f.faces.every((q) => mode(q.slot) === 'blend')) m.group = -1;
    }
    return m;
  }

  build(name, states) {
    const custom = this.res.customBlock(name);
    if (custom) return this.buildCustom(name, custom, states);
    if (name.startsWith('minecraft:')) return this.buildVanilla(name.slice(10), states);
    // Add-on block without a readable behavior pack: fall back to the resource pack's blocks.json.
    const slots = this.blockSlots(name, states);
    if (!slots) { this.unknown.set(name, 'no definition found (pack missing or encrypted)'); return this.cube(() => this.slot(null)); }
    return this.cube((d) => slots[d]);
  }

  cube(tex) { return this.finish(Q.box([], 0, 0, 0, 16, 16, 16, tex)); }

  // ---- add-on blocks --------------------------------------------------------------------------

  buildCustom(name, def, states) {
    const comps = Object.assign({}, def.components);
    for (const perm of def.permutations || []) {
      if (perm && perm.components && molang.test(perm.condition, states)) Object.assign(comps, perm.components);
    }
    const mi = comps['minecraft:material_instances'] || {};
    const instance = (n) => {
      let v = mi[n], guard = 0;
      while (typeof v === 'string' && guard++ < 8) v = mi[v];
      return v && typeof v === 'object' ? v : null;
    };
    const slotCache = new Map();
    const slotFor = (instName, faceName) => {
      const inst = instance(instName) || instance(faceName) || (faceName !== 'up' && faceName !== 'down' && instance('side')) || instance('*');
      if (!inst) return slotCache.get('?') || (slotCache.set('?', this.fallbackSlot(name, faceName)), slotCache.get('?'));
      let s = slotCache.get(inst);
      if (!s) {
        const tint = inst.tint_method && inst.tint_method !== 'none' ? inst.tint_method : null;
        s = this.terrainSlot(inst.texture, 0, { mode: inst.render_method || 'opaque', tintMethod: tint, alphaMasked: !!inst.alpha_masked_tint });
        slotCache.set(inst, s);
      }
      return s;
    };

    let geoRef = comps['minecraft:geometry'];
    let boneVis = null;
    if (geoRef && typeof geoRef === 'object') { boneVis = geoRef.bone_visibility || null; geoRef = geoRef.identifier; }
    let quads;
    if (!geoRef || geoRef === 'minecraft:geometry.full_block') {
      if (!geoRef && !Object.keys(mi).length) {
        const slots = this.blockSlots(name, states);
        quads = Q.box([], 0, 0, 0, 16, 16, 16, slots ? (d) => slots[d] : () => this.slot(null));
        if (!slots) this.unknown.set(name, 'no textures defined');
      } else quads = Q.box([], 0, 0, 0, 16, 16, 16, (d) => slotFor(Q.DIR_NAMES[d], Q.DIR_NAMES[d]));
    } else if (geoRef === 'minecraft:geometry.cross') {
      quads = this.crossQuads(slotFor('*', 'north'));
    } else {
      const geo = this.res.geometry(geoRef);
      if (!geo) {
        this.unknown.set(name, 'geometry not found: ' + geoRef);
        quads = Q.box([], 0, 0, 0, 16, 16, 16, (d) => slotFor(Q.DIR_NAMES[d], Q.DIR_NAMES[d]));
      } else quads = geometryQuads(geo, slotFor, boneVis, states);
    }

    // Bedrock semantics: no collision_box component (or true) means a full cube, false means none.
    const cb = comps['minecraft:collision_box'];
    let boxes = [[0, 0, 0, 1, 1, 1]];
    if (cb === false) boxes = [];
    else if (cb && typeof cb === 'object' && cb.origin && cb.size) {
      boxes = [[0.5 - (cb.origin[0] + cb.size[0]) / 16, cb.origin[1] / 16, 0.5 + cb.origin[2] / 16, 0.5 - cb.origin[0] / 16, (cb.origin[1] + cb.size[1]) / 16, 0.5 + (cb.origin[2] + cb.size[2]) / 16]];
    }
    const le = comps['minecraft:light_emission'];
    const emit = Math.max(0, Math.min(15, (typeof le === 'object' && le ? le.emission : le) | 0));

    const tr = comps['minecraft:transformation'];
    let trM = null;
    if (tr) {
      let m = Q.IDENTITY;
      const sc = tr.scale, r = tr.rotation, t = tr.translation;
      const piv = (p) => (p ? [0.5 - p[0] / 16, 0.5 + p[1] / 16, 0.5 + p[2] / 16] : [0.5, 0.5, 0.5]);
      if (sc) { const p = piv(tr.scale_pivot); m = Q.mul(Q.about(Q.scaling(sc[0], sc[1], sc[2]), p[0], p[1], p[2]), m); }
      if (r && (r[0] || r[1] || r[2])) {
        const p = piv(tr.rotation_pivot);
        const rm = Q.mul(Q.rotation(2, r[2] || 0), Q.mul(Q.rotation(1, r[1] || 0), Q.rotation(0, -(r[0] || 0))));
        m = Q.mul(Q.about(rm, p[0], p[1], p[2]), m);
      }
      if (t) m = Q.mul(Q.translation(-t[0] / 16, t[1] / 16, t[2] / 16), m);
      if (m !== Q.IDENTITY) { quads = Q.transform(quads, m); trM = m; }
    }
    if (trM) {
      boxes = boxes.map((b) => {
        const o = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let i = 0; i < 8; i++) {
          const x = b[i & 1 ? 3 : 0], y = b[i & 2 ? 4 : 1], z = b[i & 4 ? 5 : 2];
          for (let r = 0; r < 3; r++) {
            const v = trM[r * 4] * x + trM[r * 4 + 1] * y + trM[r * 4 + 2] * z + trM[r * 4 + 3];
            if (v < o[r]) o[r] = v; if (v > o[r + 3]) o[r + 3] = v;
          }
        }
        return o;
      });
    }
    const model = this.finish(quads);
    if (model) {
      model.boxes = boxes; model.emit = emit;
      // add-on grass, flowers and the like: walk-through blocks made only of upright planes
      model.sink = cb === false && !model.full && model.quads.every((q) => Math.abs(q.n[1]) < 0.01) &&
        !/vine|web|hanging|ladder|chain|rope|curtain|banner|branch|ivy/.test(name);
    }
    return model;
  }

  fallbackSlot(name, faceName) {
    const slots = this.blockSlots(name, {});
    return slots ? slots[Q.DIR[faceName] || 0] : this.slot(null);
  }

  // ---- blocks.json textures -------------------------------------------------------------------

  // Six slots (down, up, north, south, west, east) from blocks.json, or null.
  blockSlots(name, states, variant) {
    const bj = this.res.blocksJson;
    const short = name.startsWith('minecraft:') ? name.slice(10) : name;
    let e = bj[name] || bj[ALIAS[short] || short] || bj[short.replace(/_([a-z])/g, (m, c) => c.toUpperCase())];
    if (!e) {
      // Colour-flattened blocks that still share one legacy entry with a 16 colour texture list.
      const m = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(.+)$/.exec(short);
      if (m) {
        const base = { terracotta: 'stained_hardened_clay', concrete_powder: 'concretePowder' }[m[2]] || m[2];
        if (bj[base]) { e = bj[base]; variant = COLOURS.indexOf(m[1]); }
      }
    }
    // Some blocks have no blocks.json entry but a terrain texture of the same name.
    const t = e && e.textures ? e.textures : (this.res.terrain[short] ? short : null);
    if (!t) return null;
    const names = typeof t === 'string' ? [t, t, t, t, t, t]
      : [t.down || t.side, t.up || t.side, t.north || t.side, t.south || t.side, t.west || t.side, t.east || t.side];
    return names.map((n, d) => this.terrainSlot(n, variant || 0, this.vanillaTint(short, d)));
  }

  vanillaTint(n, d) {
    if (n === 'grass_block' || n === 'grass') return d === 1 ? { tintMethod: 'grass' } : d === 0 ? null : { tintMethod: 'grass', alphaMasked: true, mode: 'opaque' };
    if (GRASS_TINTED.has(n)) return { tintMethod: 'grass' };
    if (FOLIAGE_TINTED.has(n)) return { tintMethod: 'foliage' };
    if (n === 'birch_leaves') return { tintMethod: 'birch_foliage' };
    if (n === 'spruce_leaves') return { tintMethod: 'evergreen_foliage' };
    if (n === 'waterlily') return { fixedTint: [32, 128, 48] };
    if (n === 'water' || n === 'flowing_water') return { tintMethod: 'water', opacity: 0.65 };
    return null;
  }

  // ---- vanilla shapes -------------------------------------------------------------------------

  // A plant drawn as two crossed planes. Plants rooted in the ground sink by a varying amount
  // (see Mesher) so a field of grass is not one flat, level top edge.
  plant(slot) {
    const m = this.finish(this.crossQuads(slot));
    if (m) m.sink = true;
    return m;
  }

  crossQuads(slot) {
    const a = 0.18, b = 0.82, out = [];
    Q.plane(out, [a, 1, a, a, 0, a, b, 0, b, b, 1, b], slot);
    Q.plane(out, [a, 1, b, a, 0, b, b, 0, a, b, 1, a], slot);
    return out;
  }

  // The model of a block as its block entity makes it look: the sign with its text, the banner
  // with its colours. Falls back to the plain model. Results are shared between identical ones.
  withEntity(m, be) {
    const e = m.entityOf;
    if (!e || !be) return m;
    let key;
    try { key = JSON.stringify(be, (k, v) => (k === 'x' || k === 'y' || k === 'z' ? undefined : typeof v === 'bigint' ? String(v) : v)); } catch (err) { return m; }
    let v = e.variants.get(key);
    if (v === undefined) {
      try { v = this.buildVanilla(e.n, e.states, be) || m; } catch (err) { v = m; }
      e.variants.set(key, v);
    }
    return v;
  }

  buildVanilla(n, states, be) {
    if (INVISIBLE.has(n) || n.startsWith('light_block')) return null;
    if (LIQUIDS[n]) {
      const s = this.blockSlots(n === 'flowing_water' ? 'water' : n === 'flowing_lava' ? 'lava' : n, states);
      if (!s) return null;
      return { quads: [], full: false, faces: null, opaque: false, empty: false, group: 0, liquid: LIQUIDS[n], depth: states.liquid_depth | 0, slots: s };
    }
    let variant = 0;
    if (CROPS.has(n)) variant = states.growth | 0;
    const S = this.blockSlots(n, states, variant);
    if (S || /banner$|^lever$/.test(n)) {
      const special = extraShape(this, n, states, S, be);
      if (special !== undefined) {
        // remembered so the block can be rebuilt with its block entity (sign text, banner design...)
        if (special && !be && NEEDS_ENTITY.test(n)) special.entityOf = { n, states, variants: new Map() };
        return special;
      }
    }
    if (UNSUPPORTED.test(n)) { this.unknown.set('minecraft:' + n, 'shape not supported yet (skipped)'); return null; }
    if (!S) { this.unknown.set('minecraft:' + n, 'no texture entry in blocks.json'); return this.cube(() => this.slot(null)); }
    const all = (d) => S[d];
    const out = [];
    const st = states;
    const bit = (k) => !!st[k];

    if (/_slab\d*$/.test(n) && !/double/.test(n)) {
      const top = st['minecraft:vertical_half'] === 'top' || bit('top_slot_bit');
      return this.finish(Q.box(out, 0, top ? 8 : 0, 0, 16, top ? 16 : 8, 16, all));
    }
    if (/_stairs$/.test(n)) {
      // steps: which way the tall half faces (0 north, 1 west, 2 south, 3 east)
      const steps = [3, 1, 2, 0][st.weirdo_direction | 0];
      const up = bit('upside_down_bit');
      const flip = (b) => (up ? [b[0], 16 - b[4], b[2], b[3], 16 - b[1], b[5]] : b);
      // Built facing north. Corner pieces replace or add to the straight top half.
      const TOPS = [
        [[0, 8, 0, 16, 16, 8]],                              // straight
        [[0, 8, 0, 8, 16, 8]], [[8, 8, 0, 16, 16, 8]],       // outer corner: left, right
        [[0, 8, 0, 16, 16, 8], [0, 8, 8, 8, 16, 16]],        // inner corner: left
        [[0, 8, 0, 16, 16, 8], [8, 8, 8, 16, 16, 16]],       // inner corner: right
      ];
      const shape = (k) => {
        const quads = [];
        for (const b of [[0, 0, 0, 16, 8, 16], ...TOPS[k]]) { const r = flip(rotBox(b, steps)); Q.box(quads, r[0], r[1], r[2], r[3], r[4], r[5], all); }
        return this.finish(quads);
      };
      const m = shape(0);
      // the mesher picks the corner shape from the stairs around each block (see stairShape)
      m.stair = { steps, up, shapes: [m, null, null, null, null], make: shape };
      return m;
    }
    if (/_fence$/.test(n) || n === 'fence') {
      Q.box(out, 6, 0, 6, 10, 16, 10, all);
      const arms = [['north', 0], ['west', 1], ['south', 2], ['east', 3]];
      for (const [dir, steps] of arms) {
        if (!st['minecraft:connection_' + dir]) continue;
        for (const b of [[7, 12, 0, 9, 15, 6], [7, 6, 0, 9, 9, 6]]) { const r = rotBox(b, steps); Q.box(out, r[0], r[1], r[2], r[3], r[4], r[5], all); }
      }
      return this.finish(out);
    }
    if (/_fence_gate$/.test(n) || n === 'fence_gate') {
      const ns = st['minecraft:cardinal_direction'] ? /north|south/.test(st['minecraft:cardinal_direction']) : !((st.direction | 0) & 1);
      const steps = ns ? 1 : 0; // gate spans east-west when facing north/south
      const parts = [[7, 5, 0, 9, 16, 2], [7, 5, 14, 9, 16, 16]];
      if (!bit('open_bit')) parts.push([7, 6, 2, 9, 9, 14], [7, 12, 2, 9, 15, 14], [7, 9, 6, 9, 12, 10]);
      for (const b of parts) { const r = rotBox(b, steps); Q.box(out, r[0], r[1], r[2], r[3], r[4], r[5], all); }
      return this.finish(out);
    }
    if (/_wall$/.test(n)) {
      const conn = ['north', 'west', 'south', 'east'].map((d) => st['wall_connection_type_' + d] || 'none');
      const any = conn.some((c) => c !== 'none');
      if (bit('wall_post_bit') || !any) Q.box(out, 4, 0, 4, 12, 16, 12, all);
      conn.forEach((c, steps) => {
        if (c === 'none') return;
        const r = rotBox([5, 0, 0, 11, c === 'tall' ? 16 : 14, 8], steps);
        Q.box(out, r[0], r[1], r[2], r[3], r[4], r[5], all);
      });
      return this.finish(out);
    }
    if (/glass_pane$/.test(n) || /_bars$/.test(n)) {
      const face = S[2], edge = S[5];
      const conn = ['north', 'west', 'south', 'east'].map((d) => !!st['minecraft:connection_' + d]);
      if (!conn.some(Boolean)) Q.box(out, 7, 0, 7, 9, 16, 9, (d) => (d < 2 ? edge : face));
      conn.forEach((c, steps) => {
        if (!c) return;
        const r = rotBox([7, 0, 0, 9, 16, 8], steps);
        const broad = steps & 1 ? [2, 3] : [4, 5];
        Q.box(out, r[0], r[1], r[2], r[3], r[4], r[5], (d) => (broad.includes(d) ? face : edge));
      });
      return this.finish(out);
    }
    if (/_door$/.test(n)) {
      const dirs = { east: 0, south: 1, west: 2, north: 3 };
      const dir = st['minecraft:cardinal_direction'] !== undefined ? dirs[st['minecraft:cardinal_direction']] | 0 : st.direction | 0;
      const steps = [0, 3, 2, 1][dir & 3] + (bit('open_bit') ? 1 : 0);
      const r = rotBox([0, 0, 0, 3, 16, 16], steps);
      const slot = bit('upper_block_bit') ? S[2] : S[0];
      return this.finish(Q.box(out, r[0], r[1], r[2], r[3], r[4], r[5], slot));
    }
    if (/trapdoor$/.test(n)) {
      if (bit('open_bit')) { const r = rotBox([13, 0, 0, 16, 16, 16], [0, 2, 3, 1][st.direction & 3]); return this.finish(Q.box(out, r[0], r[1], r[2], r[3], r[4], r[5], all)); }
      const top = bit('upside_down_bit');
      return this.finish(Q.box(out, 0, top ? 13 : 0, 0, 16, top ? 16 : 3, 16, all));
    }
    if (/_carpet$/.test(n) || n === 'carpet') return this.finish(Q.box(out, 0, 0, 0, 16, 1, 16, all));
    if (n === 'snow_layer') { const h = Math.min(16, ((st.height | 0) + 1) * 2); return this.finish(Q.box(out, 0, 0, 0, 16, h, 16, all)); }
    if (n === 'farmland' || n === 'grass_path' || n === 'dirt_path') return this.finish(Q.box(out, 0, 0, 0, 16, 15, 16, all));
    if (/_pressure_plate$/.test(n)) return this.finish(Q.box(out, 1, 0, 1, 15, 1, 15, all));
    if (n === 'cactus') {
      Q.box(out, 0, 0, 0, 16, 16, 16, all, { skip: [2, 3, 4, 5] });
      Q.box(out, 1, 0, 1, 15, 16, 15, all, { skip: [0, 1], uv: { 2: [0, 0, 16, 16], 3: [0, 0, 16, 16], 4: [0, 0, 16, 16], 5: [0, 0, 16, 16] } });
      return this.finish(out);
    }
    if (/chest$/.test(n)) {
      const steps = { south: 0, east: 1, north: 2, west: 3 }[st['minecraft:cardinal_direction']] | 0;
      const R = rotSlots(S, steps);
      return this.finish(Q.box(out, 1, 0, 1, 15, 14, 15, (d) => R[d]));
    }
    if (n === 'bed') return this.finish(Q.box(out, 0, 0, 0, 16, 9, 16, all));
    if (/torch$/.test(n)) {
      const uv = { 0: [7, 14, 9, 16], 1: [7, 6, 9, 8], 2: [7, 6, 9, 16], 3: [7, 6, 9, 16], 4: [7, 6, 9, 16], 5: [7, 6, 9, 16] };
      let quads = Q.box([], 7, 0, 7, 9, 10, 9, all, { uv });
      // attached to the block on that side: base sits near the wall, top leans into the room
      const wall = { west: [2, -22.5, -0.3125, 0], east: [2, 22.5, 0.3125, 0], north: [0, 22.5, 0, -0.3125], south: [0, -22.5, 0, 0.3125] }[st.torch_facing_direction];
      if (wall) quads = Q.transform(quads, Q.mul(Q.translation(wall[2], 0.1875, wall[3]), Q.about(Q.rotation(wall[0], wall[1]), 0.5, 0, 0.5)));
      return this.finish(quads);
    }
    if (/lantern$/.test(n)) {
      const y = bit('hanging') ? 1 : 0;
      Q.box(out, 5, y, 5, 11, y + 7, 11, all, { uv: { 0: [0, 9, 6, 15], 1: [0, 9, 6, 15], 2: [0, 2, 6, 9], 3: [0, 2, 6, 9], 4: [0, 2, 6, 9], 5: [0, 2, 6, 9] } });
      Q.box(out, 6, y + 7, 6, 10, y + 9, 10, all, { skip: [0], uv: { 1: [1, 10, 5, 14], 2: [1, 0, 5, 2], 3: [1, 0, 5, 2], 4: [1, 0, 5, 2], 5: [1, 0, 5, 2] } });
      return this.finish(out);
    }
    if (n === 'ladder') {
      const d = st.facing_direction | 0, e = 1 / 16;
      const planes = { 2: [1, 1, 1 - e, 1, 0, 1 - e, 0, 0, 1 - e, 0, 1, 1 - e], 3: [0, 1, e, 0, 0, e, 1, 0, e, 1, 1, e], 4: [1 - e, 1, 0, 1 - e, 0, 0, 1 - e, 0, 1, 1 - e, 1, 1], 5: [e, 1, 1, e, 0, 1, e, 0, 0, e, 1, 0] };
      return this.finish(Q.plane(out, planes[d] || planes[2], S[2]));
    }
    if (n === 'vine' || n === 'glow_lichen' || n === 'sculk_vein' || n === 'resin_clump') {
      const e = 0.05;
      const bits = n === 'vine' ? st.vine_direction_bits | 0 : st.multi_face_direction_bits | 0;
      const sides = n === 'vine' ? { south: 1, west: 2, north: 4, east: 8 } : { down: 1, up: 2, south: 4, west: 8, north: 16, east: 32 };
      const pl = {
        south: [1, 1, 1 - e, 1, 0, 1 - e, 0, 0, 1 - e, 0, 1, 1 - e], north: [0, 1, e, 0, 0, e, 1, 0, e, 1, 1, e],
        east: [1 - e, 1, 0, 1 - e, 0, 0, 1 - e, 0, 1, 1 - e, 1, 1], west: [e, 1, 1, e, 0, 1, e, 0, 0, e, 1, 0],
        down: [0, e, 0, 0, e, 1, 1, e, 1, 1, e, 0], up: [0, 1 - e, 1, 0, 1 - e, 0, 1, 1 - e, 0, 1, 1 - e, 1],
      };
      for (const k in sides) if (bits & sides[k]) Q.plane(out, pl[k], S[2]);
      if (!out.length) Q.plane(out, n === 'vine' ? pl.up : pl.down, S[2]);
      return this.finish(out);
    }
    if (/rail$/.test(n)) {
      const d = st.rail_direction | 0, e = 1 / 16;
      const c = [0, e, 0, 0, e, 1, 1, e, 1, 1, e, 0];
      const turn = { 1: 1, 6: 0, 7: 1, 8: 2, 9: 3 }[d] || 0;
      const q = Q.plane([], c, d >= 6 ? S[1] : S[0])[0];
      for (let i = 0; i < turn; i++) q.uv = [q.uv[2], q.uv[3], q.uv[4], q.uv[5], q.uv[6], q.uv[7], q.uv[0], q.uv[1]];
      return this.finish([q]);
    }
    if (n === 'waterlily') return this.finish(Q.plane(out, [0, 0.02, 0, 0, 0.02, 1, 1, 0.02, 1, 1, 0.02, 0], S[1]));
    if (CROPS.has(n)) {
      const y0 = -1 / 16, y1 = 15 / 16;
      for (const a of [0.25, 0.75]) {
        Q.plane(out, [a, y1, 0, a, y0, 0, a, y0, 1, a, y1, 1], S[2]);
        Q.plane(out, [0, y1, a, 0, y0, a, 1, y0, a, 1, y1, a], S[2]);
      }
      return this.finish(out);
    }
    if (st.upper_block_bit !== undefined && S[0] !== S[1]) return this.plant(bit('upper_block_bit') ? S[1] : S[0]);
    if (n === 'seagrass') return this.plant(st.sea_grass_type === 'double_top' ? S[2] : st.sea_grass_type === 'double_bot' ? S[0] : S[1]);
    if (n === 'kelp') return this.plant(S[2]);
    if (n === 'web' || /sapling$|_roots$|_fungus$|mushroom$|^deadbush$|^reeds$|sprouts$|_bush$|_tulip$|_orchid$|^cave_vines|vines$|coral$|coral_fan$|^short_|^tall_|flower$|blossom$|propagule$/.test(n)) {
      if (!/mangrove_roots|muddy_mangrove_roots/.test(n)) return this.plant(S[2]);
    }
    // Anything else whose texture is mostly empty is a plant drawn as two crossed planes.
    if (S.every((s) => s === S[0]) && !/glass|leaves|ice|spawner|roots|slime|honey|grate|scaffold/.test(n)) {
      const mat = this.res.materials[S[0].mat];
      if (mat.mode === 'cutout') { this.res.materialColor(mat.id); if (mat.coverage < 0.6) return this.plant(S[0]); }
    }

    // Full cubes, possibly oriented.
    let slots = S;
    const sidesDiffer = !(S[2] === S[3] && S[3] === S[4] && S[4] === S[5]);
    if (sidesDiffer) {
      let steps = 0;
      if (st['minecraft:cardinal_direction'] !== undefined) steps = { south: 0, east: 1, north: 2, west: 3 }[st['minecraft:cardinal_direction']] | 0;
      else if (st.facing_direction !== undefined) steps = { 3: 0, 5: 1, 2: 2, 4: 3 }[st.facing_direction] | 0;
      else if (st.direction !== undefined) steps = [0, 3, 2, 1][st.direction & 3];
      slots = rotSlots(S, steps);
    }
    let quads = Q.box([], 0, 0, 0, 16, 16, 16, (d) => slots[d]);
    if (st.pillar_axis === 'x') quads = Q.transform(quads, centred(Q.rotation(2, 90)));
    else if (st.pillar_axis === 'z') quads = Q.transform(quads, centred(Q.rotation(0, 90)));
    return this.finish(quads);
  }
}

module.exports = { Models };
