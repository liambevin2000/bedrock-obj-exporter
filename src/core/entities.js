'use strict';
// Entities that are part of the scenery rather than alive: add-on furniture, paintings, armor
// stands, boats, minecarts. Mobs, dropped items and other moving things are left out.
// An entity is drawn the way its resource pack says: client entity -> render controllers ->
// geometry + texture, with the usual variant / skin queries answered from the saved entity.
const Q = require('./quads');
const molang = require('./molang');
const { geometryQuads } = require('./geometry');

// (boats have no model file in the game's packs, so they cannot be drawn)
const VANILLA_STATIC = new Set(['armor_stand', 'minecart', 'chest_minecart', 'hopper_minecart', 'tnt_minecart', 'command_block_minecart', 'ender_crystal']);

// Paintings on the classic atlas (textures/painting/kz): name -> [x, y, width, height] in blocks of 16 px.
const KZ = {
  Kebab: [0, 0, 1, 1], Aztec: [1, 0, 1, 1], Alban: [2, 0, 1, 1], Aztec2: [3, 0, 1, 1], Bomb: [4, 0, 1, 1], Plant: [5, 0, 1, 1], Wasteland: [6, 0, 1, 1],
  Pool: [0, 2, 2, 1], Courbet: [2, 2, 2, 1], Sea: [4, 2, 2, 1], Sunset: [6, 2, 2, 1], Creebet: [8, 2, 2, 1],
  Wanderer: [0, 4, 1, 2], Graham: [1, 4, 1, 2],
  Match: [0, 8, 2, 2], Bust: [2, 8, 2, 2], Stage: [4, 8, 2, 2], Void: [6, 8, 2, 2], SkullAndRoses: [8, 8, 2, 2], Wither: [10, 8, 2, 2],
  Earth: [0, 10, 2, 2], Wind: [2, 10, 2, 2], Water: [4, 10, 2, 2], Fire: [6, 10, 2, 2],
  Fighters: [0, 6, 4, 2],
  Pointer: [0, 12, 4, 4], Pigscene: [4, 12, 4, 4], BurningSkull: [8, 12, 4, 4],
  Skeleton: [12, 4, 4, 3], DonkeyKong: [12, 7, 4, 3],
};

const glob = (pattern, name) => new RegExp('^' + String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(name);

class Entities {
  constructor(res, models) {
    this.res = res; this.models = models;
    this.cache = new Map();
    this.kinds = new Map(); // identifier -> 'static' | 'skip'
    this.skipped = new Map(); // identifier -> why, for the report
  }

  // Is this entity scenery? Vanilla: a fixed list. Add-on: anything without AI or movement.
  _kind(id) {
    let k = this.kinds.get(id);
    if (k) return k;
    k = 'skip';
    if (id === 'minecraft:painting') k = 'painting';
    else if (id.startsWith('minecraft:')) k = VANILLA_STATIC.has(id.slice(10)) ? 'static' : 'skip';
    else if (this.res.clientEntity(id)) {
      const def = this.res.behaviorEntity(id);
      const keys = def ? [...Object.keys(def.components || {}), ...Object.values(def.component_groups || {}).flatMap((g) => Object.keys(g || {}))] : [];
      // AI goals or pathfinding make it a mob; vehicles (cars, carts) only have movement and stay in
      const alive = keys.some((c) => /^minecraft:(behavior\.|navigation\.)/.test(c));
      k = alive ? 'skip' : 'static';
      if (alive) this.skipped.set(id, 'a mob (it has AI), left out');
    }
    this.kinds.set(id, k);
    return k;
  }

  // Returns { quads, upright } for a saved entity, or null. Quads are relative to the entity's
  // position, facing north; upright ones are turned by the entity's yaw when placed.
  modelFor(nbt) {
    const id = nbt.identifier;
    if (!id) return null;
    const kind = this._kind(id);
    if (kind === 'skip') return null;
    if (kind === 'painting') return this._painting(nbt);
    const q = {
      variant: nbt.Variant | 0, mark_variant: nbt.MarkVariant | 0, skin_id: nbt.SkinID | 0, is_baby: nbt.IsBaby ? 1 : 0,
      is_sheared: nbt.Sheared ? 1 : 0, is_chested: nbt.Chested ? 1 : 0, is_saddled: nbt.Saddled ? 1 : 0, is_tamed: nbt.IsTamed ? 1 : 0,
      is_sitting: nbt.Sitting ? 1 : 0, is_angry: nbt.IsAngry ? 1 : 0, is_stunned: nbt.IsStunned ? 1 : 0, is_powered: 0, is_in_ui: 0,
    };
    const key = id + '|' + Object.values(q).join(',');
    let m = this.cache.get(key);
    if (m !== undefined) return m;
    try { m = this._build(id, q); } catch (e) { m = null; this.skipped.set(id, 'could not be built: ' + e.message); }
    this.cache.set(key, m);
    return m;
  }

  _build(id, q) {
    const def = this.res.clientEntity(id);
    if (!def) { this.skipped.set(id, 'no resource pack definition found'); return null; }
    const states = { __q: q };
    const lower = (o) => { const out = {}; for (const k of Object.keys(o || {})) out[k.toLowerCase()] = o[k]; return out; };
    const geos = lower(def.geometry), texs = lower(def.textures);
    const quads = [];
    const controllers = (def.render_controllers || []).length ? def.render_controllers : [null];
    for (const entry of controllers) {
      let name = entry, cond = null;
      if (entry && typeof entry === 'object') { name = Object.keys(entry)[0]; cond = entry[name]; }
      if (cond !== null && !molang.test(cond, states)) continue;
      const rc = name ? this.res.renderController(name) : null;
      const arrays = Object.assign({}, ...Object.values((rc && rc.arrays) || {}).map(lower));
      // "Geometry.x" / "Texture.x" name an entry of the client entity; "Array.x[expr]" picks from a list
      const resolve = (ref, table, depth) => {
        if (typeof ref !== 'string' || depth > 4) return null;
        const r = ref.trim();
        const arr = /^(array\.[\w.]+)\s*\[(.*)\]$/i.exec(r);
        if (arr) {
          const list = arrays[arr[1].toLowerCase()];
          if (!list || !list.length) return null;
          const i = Math.floor(Number(molang.compile(arr[2])(states)) || 0);
          return resolve(list[((i % list.length) + list.length) % list.length], table, depth + 1);
        }
        const m = /^(geometry|texture)\.(.+)$/i.exec(r);
        return m ? table[m[2].toLowerCase()] || null : null;
      };
      const geoId = rc ? resolve(rc.geometry, geos, 0) : geos.default || Object.values(geos)[0];
      const texPath = rc ? resolve((rc.textures || [])[0], texs, 0) : texs.default || Object.values(texs)[0];
      const geo = geoId && this.res.geometry(geoId);
      if (!geo || !texPath || !this.res.image(texPath)) continue;
      const slot = this.models.slot(texPath);
      // part_visibility: [{ "bone or pattern*": expression }], later entries win
      let visible = null;
      if (rc && Array.isArray(rc.part_visibility)) {
        visible = {};
        for (const bone of geo.bones || []) {
          for (const rule of rc.part_visibility) for (const pat of Object.keys(rule)) if (glob(pat, bone.name)) visible[bone.name] = rule[pat];
        }
      }
      for (const f of geometryQuads(geo, () => slot, visible, states)) quads.push(f);
    }
    if (!quads.length) { this.skipped.set(id, 'no geometry or texture resolved'); return null; }
    // geometry comes out in block space, centred on (0.5, 0, 0.5): move it onto the entity's own origin
    return { quads: Q.transform(quads, Q.translation(-0.5, 0, -0.5)), upright: true };
  }

  _painting(nbt) {
    const motif = String(nbt.Motif || nbt.Motive || 'Kebab');
    const key = 'painting|' + motif + '|' + (nbt.Direction | 0);
    let m = this.cache.get(key);
    if (m !== undefined) return m;
    m = null;
    let slot = null, rect = null, w = 1, h = 1;
    if (KZ[motif]) {
      const img = this.res.image('textures/painting/kz');
      if (img) {
        const [x, y, bw, bh] = KZ[motif], k = 16 / (img.w / 16); // atlas is 16 blocks wide
        slot = this.models.slot('textures/painting/kz'); w = bw; h = bh;
        rect = [x * k, y * k, (x + bw) * k, (y + bh) * k];
      }
    } else {
      // newer paintings each have their own picture, named in snake_case
      const path = 'textures/painting/' + motif.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      const img = this.res.image(path);
      if (img) { slot = this.models.slot(path); w = Math.max(1, Math.round(img.w / 16)); h = Math.max(1, Math.round(img.h / 16)); rect = [0, 0, 16, 16]; }
    }
    if (slot) {
      const back = (this.models.blockSlots('minecraft:oak_planks', {}) || [])[2] || slot;
      // built facing south, centred on the entity's position, one pixel thick
      const quads = Q.box([], -w * 8, -h * 8, -0.5, w * 8, h * 8, 0.5, (d) => (d === 3 ? slot : back), { uv: { 3: rect } });
      const turn = [0, -90, 180, 90][(nbt.Direction | 0) & 3]; // 0 south, 1 west, 2 north, 3 east
      m = { quads: turn ? Q.transform(quads, Q.rotation(1, turn)) : quads, upright: false };
    } else this.skipped.set('minecraft:painting', 'picture not found: ' + motif);
    this.cache.set(key, m);
    return m;
  }
}

module.exports = { Entities };
