'use strict';
// Java entities that are scenery: paintings and item frames (with what they hold).
// Mobs, dropped items and vehicles are left out, as on the Bedrock side.
const Q = require('../quads');

const FACE_YAW = { 2: 0, 3: 180, 4: 90, 5: -90 }; // 3D direction ids -> degrees from north

class JavaEntities {
  constructor(res, models) {
    this.res = res; this.models = models;
    this.cache = new Map();
    this.skipped = new Map();
  }

  // { quads, upright } relative to the entity's position, or null.
  modelFor(nbt) {
    const id = String(nbt.id || '');
    if (id === 'minecraft:painting' || id === 'Painting') return this._painting(nbt);
    if (id === 'minecraft:item_frame' || id === 'minecraft:glow_item_frame' || id === 'ItemFrame') return this._frame(nbt, id === 'minecraft:glow_item_frame');
    if (id === 'minecraft:armor_stand') this.skipped.set(id, 'armor stands are not drawn for Java worlds yet');
    return null;
  }

  _painting(nbt) {
    let variant = nbt.variant !== undefined ? nbt.variant : nbt.Motive !== undefined ? nbt.Motive : nbt.Motif;
    if (variant && typeof variant === 'object') variant = variant.asset_id || variant.id || '';
    variant = String(variant || 'minecraft:kebab').toLowerCase();
    if (!variant.includes(':')) variant = 'minecraft:' + variant.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    const facing = (nbt.facing !== undefined ? nbt.facing : nbt.Facing) | 0; // 0 south, 1 west, 2 north, 3 east
    const key = 'painting|' + variant + '|' + facing;
    if (this.cache.has(key)) return this.cache.get(key);
    const [ns, name] = variant.split(':');
    const def = this.res.json(`data/${ns}/painting_variant/${name}.json`);
    const asset = def && def.asset_id ? String(def.asset_id) : variant;
    const [ans, apath] = asset.includes(':') ? asset.split(':') : ['minecraft', asset];
    const texId = `${ans}:painting/${apath}`;
    const img = this.res.image(texId);
    let m = null;
    if (img) {
      const w = def && def.width ? def.width : Math.max(1, Math.round(img.w / 16)), h = def && def.height ? def.height : Math.max(1, Math.round(img.h / 16));
      const slot = this.models.slot(texId);
      const back = this.res.image('minecraft:painting/back') ? this.models.slot('minecraft:painting/back') : slot;
      // built facing south, centred on the entity's position, one pixel thick
      const quads = Q.box([], -w * 8, -h * 8, -0.5, w * 8, h * 8, 0.5, (d) => (d === 3 ? slot : back), { uv: { 3: [0, 0, 16, 16] } });
      const turn = [0, -90, 180, 90][facing & 3];
      m = { quads: turn ? Q.transform(quads, Q.rotation(1, turn)) : quads, upright: false };
    } else this.skipped.set('minecraft:painting', 'picture not found: ' + variant);
    this.cache.set(key, m);
    return m;
  }

  _frame(nbt, glow) {
    const facing = (nbt.facing !== undefined ? nbt.facing : nbt.Facing) | 0; // 0 down, 1 up, 2 north, 3 south, 4 west, 5 east
    const item = nbt.Item && nbt.Item.id ? String(nbt.Item.id) : null;
    const rot = (nbt.ItemRotation | 0) & 7;
    const invisible = !!nbt.Invisible;
    const key = ['frame', glow, facing, item, rot, invisible].join('|');
    if (this.cache.has(key)) return this.cache.get(key);
    const M = this.models;
    let quads = [];
    // the frame model faces north with its back against z = 16
    if (!invisible) {
      const q = M.modelQuads({ model: glow ? 'minecraft:block/glow_item_frame' : 'minecraft:block/item_frame' }, 'minecraft:item_frame', {}, null);
      if (q) quads = q.map((x) => ({ p: x.p, uv: x.uv, slot: x.slot, cull: -1 }));
    }
    if (item) {
      const [ns, name] = item.includes(':') ? item.split(':') : ['minecraft', item];
      const icon = `${ns}:item/${name}`;
      const turn = Q.about(Q.rotation(2, 45 * rot), 0.5, 0.5, 0);
      if (this.res.image(icon)) {
        const a = 0.25, b = 0.75, z = 14.9 / 16;
        for (const f of Q.transform(Q.plane([], [b, b, z, b, a, z, a, a, z, a, b, z], M.slot(icon)), turn)) quads.push(f);
      } else {
        // a block: a small copy of its model standing in the frame
        const bm = M.list[M.idFor({ name: item, states: {} })];
        if (bm && bm.quads && bm.quads.length) {
          const tr = Q.mul(turn, Q.mul(Q.translation(0.5, 0.5, 14.5 / 16), Q.mul(Q.scaling(0.4, 0.4, 0.4), Q.translation(-0.5, -0.5, -0.5))));
          for (const f of Q.transform(bm.quads, tr)) quads.push(f);
        }
      }
    }
    let m = null;
    if (quads.length) {
      // centre on the entity: the frame is half a pixel deep at the back of the block
      quads = Q.transform(quads, Q.translation(-0.5, -0.5, -15.5 / 16));
      let r = null;
      if (facing === 0) r = Q.rotation(0, -90); else if (facing === 1) r = Q.rotation(0, 90);
      else if (FACE_YAW[facing]) r = Q.rotation(1, FACE_YAW[facing]);
      m = { quads: r ? Q.transform(quads, r) : quads, upright: false };
    }
    this.cache.set(key, m);
    return m;
  }
}

module.exports = { JavaEntities };
