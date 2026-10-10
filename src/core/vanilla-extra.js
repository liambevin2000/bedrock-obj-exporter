'use strict';
// Shapes for vanilla blocks that are neither a cube nor one of the common partial shapes in
// models.js: signs, banners, heads, frames, rods, chains, workstations, candles and the like.
// Bedrock ships no model files for these, so each is built from boxes at its real proportions.
// Things that live in block entities (sign text, banner patterns, which head, what is in a pot or
// frame) are not in the block data and are left out.
const Q = require('./quads');
const textart = require('./textart');

// One step = 90 degrees counter-clockwise seen from above (north -> west -> south -> east).
function rotBox(b, steps) {
  let [x0, y0, z0, x1, y1, z1] = b;
  for (let i = (steps & 3); i > 0; i--) [x0, z0, x1, z1] = [z0, 16 - x1, z1, 16 - x0];
  return [x0, y0, z0, x1, y1, z1];
}

// Steps that turn something built facing south to face the block's direction state.
function stepsOf(st) {
  if (st['minecraft:cardinal_direction'] !== undefined) return { south: 0, east: 1, north: 2, west: 3 }[st['minecraft:cardinal_direction']] | 0;
  if (st.facing_direction !== undefined) return { 3: 0, 5: 1, 2: 2, 4: 3 }[st.facing_direction] | 0;
  if (st.direction !== undefined) return [0, 3, 2, 1][st.direction & 3];
  return 0;
}

// Turns quads built standing on the floor (pointing up) to point along a block face.
const FACE_NAMES = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
function attach(quads, face) {
  const m = [Q.rotation(0, 180), null, Q.rotation(0, -90), Q.rotation(0, 90), Q.rotation(2, 90), Q.rotation(2, -90)][face];
  return m ? Q.transform(quads, Q.about(m, 0.5, 0.5, 0.5)) : quads;
}
const yaw = (quads, deg) => (deg ? Q.transform(quads, Q.about(Q.rotation(1, deg), 0.5, 0, 0.5)) : quads);

// Which head a block is, and the entity texture its 8x8x8 head sits at the top-left of.
const HEADS = {
  skeleton_skull: 'textures/entity/skeleton/skeleton', wither_skeleton_skull: 'textures/entity/skeleton/wither_skeleton',
  zombie_head: 'textures/entity/zombie/zombie', player_head: 'textures/entity/steve', creeper_head: 'textures/entity/creeper/creeper',
  piglin_head: 'textures/entity/piglin/piglin', dragon_head: 'textures/entity/skeleton/skeleton',
};
const HEAD_BY_TYPE = ['skeleton_skull', 'wither_skeleton_skull', 'zombie_head', 'player_head', 'creeper_head', 'dragon_head', 'piglin_head'];

// Blocks whose look depends on their block entity (see Models.withEntity).
const NEEDS_ENTITY = /(_sign|^standing_banner|^wall_banner|^skull|_skull|_head|^flower_pot|^frame|^glow_frame|^bed)$/;

// M: the Models instance, n: block name without namespace, st: states, S: six slots or null,
// be: the block's block entity (NBT) when it has one.
// Returns a model, null (draw nothing) or undefined (not one of ours).
function extraShape(M, n, st, S, be) {
  const res = M.res;
  // a slot for a picture made here rather than loaded from a pack
  const made = (key, name, image) => (image ? { mat: res.customMaterial(key, name, image), tintMethod: null } : null);
  // a flat picture on a sign-like board built facing south: x0..x1, y0..y1 in 1/16, at depth z
  const facePlane = (out, slot, x0, y0, x1, y1, z, back) => {
    const s = 1 / 16;
    if (back) Q.plane(out, [x1 * s, y1 * s, z * s, x1 * s, y0 * s, z * s, x0 * s, y0 * s, z * s, x0 * s, y1 * s, z * s], slot);
    else Q.plane(out, [x0 * s, y1 * s, z * s, x0 * s, y0 * s, z * s, x1 * s, y0 * s, z * s, x1 * s, y1 * s, z * s], slot);
  };
  // adds the sign's text (front and back) to a board spanning x0..x1, y0..y1, between z0 and z1
  const signText = (out, x0, y0, x1, y1, z0, z1, w, h) => {
    if (!be) return;
    const sides = [[be.FrontText || (be.Text !== undefined ? { Text: be.Text, SignTextColor: be.SignTextColor } : null), z1 + 0.05, false], [be.BackText, z0 - 0.05, true]];
    for (const [t, z, back] of sides) {
      if (!t || !t.Text) continue;
      const col = textart.argb(t.SignTextColor === undefined ? -16777216 : t.SignTextColor);
      const slot = made(`sign|${w}x${h}|${col}|${t.Text}`, 'sign_text', textart.textImage(res, t.Text, w, h, col, 4));
      if (slot) facePlane(out, slot, x0, y0, x1, y1, z, back);
    }
  };
  const slots = (name) => M.blockSlots('minecraft:' + name, st) || S;
  const all = S ? (d) => S[d] : null;
  const boxes = (list, tex, steps, opts) => {
    const out = [];
    for (const b of list) { const r = rotBox(b, steps || 0); Q.box(out, r[0], r[1], r[2], r[3], r[4], r[5], tex, opts); }
    return out;
  };
  const flat = (slot, y) => Q.plane([], [0, y, 0, 0, y, 1, 1, y, 1, 1, y, 0], slot);
  const done = (quads) => M.finish(quads);
  const sixteenth = (st.ground_sign_direction | 0) * -22.5; // 0 = south, then clockwise

  // ---- signs and banners ------------------------------------------------------------------------
  if (/hanging_sign$/.test(n)) {
    const q = boxes([[1, 0, 7, 15, 10, 9]], all);
    if (st.hanging) { for (const b of [[3, 10, 7.5, 4, 16, 8.5], [12, 10, 7.5, 13, 16, 8.5]]) Q.box(q, b[0], b[1], b[2], b[3], b[4], b[5], all); }
    else Q.box(q, 0, 14, 6, 16, 16, 10, all);
    signText(q, 1, 0, 15, 10, 7, 9, 84, 60);
    return done(st.attached_bit ? yaw(q, sixteenth) : yaw(q, stepsOf(st) * 90));
  }
  if (/standing_sign$/.test(n)) {
    const q = boxes([[7.33, 0, 7.33, 8.67, 9.33, 8.67], [0, 9.33, 7.33, 16, 17.33, 8.67]], all);
    signText(q, 0, 9.33, 16, 17.33, 7.33, 8.67, 96, 48);
    return done(yaw(q, sixteenth));
  }
  if (/wall_sign$/.test(n)) {
    const q = boxes([[0, 4.5, 0, 16, 12.5, 1.33]], all);
    signText(q, 0, 4.5, 16, 12.5, 0, 1.33, 96, 48);
    return done(yaw(q, stepsOf(st) * 90));
  }
  if (n === 'standing_banner' || n === 'wall_banner') {
    const pole = slots('oak_planks');
    // the cloth: base colour and patterns from the block entity (plain white when there is none)
    const img = textart.bannerImage(res, be);
    const cloth = made('banner|' + JSON.stringify([be && be.Base, ((be && be.Patterns) || []).map((p) => [p.Pattern, p.Color])]), 'banner', img) || slots('white_wool')[2];
    const k = img ? 16 / img.w : 0;
    // the cloth's front sits at 1,1 (20 x 40) of the banner texture; the back shows the same design
    const face = img ? [1 * k, 1 * k, 21 * k, 41 * k] : null;
    const uv = img ? { uv: { 0: face, 1: face, 2: face, 3: face, 4: [0, 1 * k, 1 * k, 41 * k], 5: [0, 1 * k, 1 * k, 41 * k] } } : undefined;
    if (n === 'wall_banner') {
      const q = boxes([[1.33, 14, 0, 14.67, 15.33, 1.33]], (d) => pole[d]);
      Q.box(q, 1.33, -12.67, 1.33, 14.67, 14, 2, cloth, uv);
      return done(yaw(q, stepsOf(st) * 90));
    }
    const q = boxes([[7.33, 0, 7.33, 8.67, 28, 8.67], [1.33, 28, 7.33, 14.67, 29.33, 8.67]], (d) => pole[d]);
    Q.box(q, 1.33, 1.33, 8.67, 14.67, 28, 9.33, cloth, uv);
    return done(yaw(q, sixteenth));
  }

  // ---- heads, frames, pots ----------------------------------------------------------------------
  if (n === 'skull' || /_skull$|_head$/.test(n)) {
    // older worlds store every head as "skull" and keep the kind in the block entity
    const kind = HEADS[n] ? n : HEAD_BY_TYPE[be && typeof be.SkullType === 'number' ? be.SkullType : 0] || 'skeleton_skull';
    const img = res.image(HEADS[kind]);
    let tex = all, uv;
    if (img) {
      const slot = M.slot(HEADS[kind]);
      const ku = 16 / img.w, kv = 16 / img.h, r = (u, v) => [u * ku, v * kv, (u + 8) * ku, (v + 8) * kv];
      tex = slot;
      uv = { uv: { 0: r(16, 0), 1: r(8, 0), 2: r(24, 8), 3: r(8, 8), 4: r(0, 8), 5: r(16, 8) } }; // face on the south side
    }
    if ((st.facing_direction | 0) >= 2) return done(yaw(Q.box([], 4, 4, 0, 12, 12, 8, tex, uv), stepsOf(st) * 90));
    return done(yaw(Q.box([], 4, 0, 4, 12, 8, 12, tex, uv), -((be && be.Rotation) || 0)));
  }
  if (n === 'frame' || n === 'glow_frame') {
    const wood = slots('birch_planks');
    const q = boxes([[3, 0, 3, 13, 0.5, 13]], all);
    for (const b of [[2, 0, 2, 14, 1, 3], [2, 0, 13, 14, 1, 14], [2, 0, 3, 3, 1, 13], [13, 0, 3, 14, 1, 13]]) Q.box(q, b[0], b[1], b[2], b[3], b[4], b[5], (d) => wood[d]);
    const item = be && be.Item;
    if (item && item.Name) {
      const turn = Q.about(Q.rotation(1, -45 * ((be.ItemRotation || 0) % 8)), 0.5, 0, 0.5);
      if (item.Block && item.Block.name) {
        // a block: a small copy of it lying in the frame
        const m = M.list[M.idFor(item.Block)];
        if (m && m.quads && m.quads.length) {
          const tr = Q.mul(turn, Q.mul(Q.translation(0.5, 1 / 16, 0.5), Q.mul(Q.scaling(0.4, 0.4, 0.4), Q.translation(-0.5, 0, -0.5))));
          for (const f of Q.transform(m.quads, tr)) q.push(f);
        }
      } else {
        // an item: its icon lying flat in the frame
        const path = res.itemTexture(item.Name);
        if (path && res.image(path)) {
          const a = 0.2, b = 0.8, y = 1.2 / 16;
          for (const f of Q.transform(Q.plane([], [a, y, a, a, y, b, b, y, b, b, y, a], M.slot(path)), turn)) q.push(f);
        }
      }
    }
    return done(attach(q, st.facing_direction === undefined ? 1 : st.facing_direction | 0));
  }
  if (n === 'decorated_pot') return done(boxes([[1, 0, 1, 15, 16, 15], [5, 16, 5, 11, 17, 11], [4, 17, 4, 12, 20, 12]], all));
  if (n === 'flower_pot') {
    const q = boxes([[5, 0, 5, 11, 6, 11]], all);
    const plant = be && be.PlantBlock;
    if (plant && plant.name) {
      // what grows in it: the plant's own model, shrunk and stood in the pot
      const m = M.list[M.idFor(plant)];
      if (m && m.quads && m.quads.length) {
        const tr = Q.mul(Q.translation(0.5, 4 / 16, 0.5), Q.mul(Q.scaling(0.6, 0.6, 0.6), Q.translation(-0.5, 0, -0.5)));
        for (const f of Q.transform(m.quads, tr)) q.push(f);
      }
    }
    return done(q);
  }
  if (n === 'bed') {
    // mattress in the bed's colour (from the block entity), pillow end on the head piece
    const colour = textart.DYE_NAMES[be && typeof be.color === 'number' ? be.color & 15 : 14];
    const path = 'textures/entity/bed/' + colour;
    const img = res.image(path), wood = slots('oak_planks');
    const q = [];
    if (img) {
      const k = 16 / img.w, r = (u, v, w, h) => [u * k, v * k, (u + w) * k, (v + h) * k];
      const head = !!st.head_piece_bit;
      const top = head ? r(6, 6, 16, 16) : r(6, 28, 16, 16), side = head ? r(6, 22, 16, 6) : r(6, 44, 16, 6);
      Q.box(q, 0, 3, 0, 16, 9, 16, M.slot(path), { uv: { 0: top, 1: top, 2: side, 3: side, 4: side, 5: side } });
    } else Q.box(q, 0, 3, 0, 16, 9, 16, all);
    for (const [x, z] of [[0, 0], [13, 0], [0, 13], [13, 13]]) Q.box(q, x, 0, z, x + 3, 3, z + 3, (d) => wood[d]);
    // built with the pillow towards north; direction says which way the head end points
    return done(yaw(q, [180, 90, 0, 270][st.direction & 3]));
  }

  // ---- redstone bits ----------------------------------------------------------------------------
  if (n === 'redstone_wire') {
    const dust = M.terrainSlot('redstone_dust_cross', 0, { fixedTint: [(st.redstone_signal | 0) ? 255 : 150, 20, 10], mode: 'alpha_test' });
    return done(flat(dust, 0.02));
  }
  if (n === 'lever') {
    const stone = slots('cobblestone'), wood = slots('oak_planks');
    const q = boxes([[5, 0, 4, 11, 3, 12]], (d) => stone[d]);
    Q.box(q, 7, 3, 7, 9, 11, 9, (d) => wood[d]);
    const dir = String(st.lever_direction || 'up_north_south');
    const face = /^up/.test(dir) ? 1 : /^down/.test(dir) ? 0 : FACE_NAMES[dir];
    return done(attach(q, face === undefined ? 1 : face));
  }
  if (/_button$/.test(n)) return done(attach(boxes([[5, 0, 6, 11, 2, 10]], all), st.facing_direction === undefined ? 1 : st.facing_direction | 0));
  if (/repeater$|comparator$/.test(n)) return done(boxes([[0, 0, 0, 16, 2, 16]], all));
  if (/^daylight_detector/.test(n)) return done(boxes([[0, 0, 0, 16, 6, 16]], all));

  // ---- portals ----------------------------------------------------------------------------------
  if (n === 'end_portal') return done(flat(S[1], 0.75));
  if (n === 'portal') return done(boxes([[0, 0, 6, 16, 16, 10]], all, st.portal_axis === 'z' ? 1 : 0));

  // ---- rods, chains, thin posts -----------------------------------------------------------------
  if (n === 'end_rod') {
    const q = [];
    Q.box(q, 7, 1, 7, 9, 16, 9, all, { uv: { 1: [2, 0, 4, 2], 2: [0, 0, 2, 15], 3: [0, 0, 2, 15], 4: [0, 0, 2, 15], 5: [0, 0, 2, 15] }, skip: [0] });
    Q.box(q, 6, 0, 6, 10, 1, 10, all, { uv: { 0: [2, 3, 6, 7], 1: [2, 3, 6, 7], 2: [2, 2, 6, 3], 3: [2, 2, 6, 3], 4: [2, 2, 6, 3], 5: [2, 2, 6, 3] } });
    return done(attach(q, st.facing_direction === undefined ? 1 : st.facing_direction | 0));
  }
  if (/lightning_rod$/.test(n)) {
    const q = [];
    Q.box(q, 7, 0, 7, 9, 12, 9, all, { uv: { 0: [0, 0, 2, 2], 2: [0, 4, 2, 16], 3: [0, 4, 2, 16], 4: [0, 4, 2, 16], 5: [0, 4, 2, 16] }, skip: [1] });
    Q.box(q, 6, 12, 6, 10, 16, 10, all, { uv: { 0: [0, 0, 4, 4], 1: [0, 0, 4, 4], 2: [0, 0, 4, 4], 3: [0, 0, 4, 4], 4: [0, 0, 4, 4], 5: [0, 0, 4, 4] } });
    return done(attach(q, st.facing_direction === undefined ? 1 : st.facing_direction | 0));
  }
  if (/chain$/.test(n)) {
    // two crossed strips, each showing its whole texture
    const q = [];
    Q.plane(q, [0.40625, 1, 0.5, 0.40625, 0, 0.5, 0.59375, 0, 0.5, 0.59375, 1, 0.5], S[2], [0, 0, 3, 16]);
    Q.plane(q, [0.5, 1, 0.59375, 0.5, 0, 0.59375, 0.5, 0, 0.40625, 0.5, 1, 0.40625], S[1], [0, 0, 3, 16]);
    const axis = st.pillar_axis;
    return done(axis === 'x' ? Q.transform(q, Q.about(Q.rotation(2, 90), 0.5, 0.5, 0.5)) : axis === 'z' ? Q.transform(q, Q.about(Q.rotation(0, 90), 0.5, 0.5, 0.5)) : q);
  }
  if (n === 'bamboo') { const t = st.bamboo_stalk_thickness === 'thick' ? 1.5 : 1; return done(boxes([[8 - t, 0, 8 - t, 8 + t, 16, 8 + t]], S[2], 0, { uv: { 2: [0, 0, 3, 16], 3: [0, 0, 3, 16], 4: [0, 0, 3, 16], 5: [0, 0, 3, 16], 0: [13, 4, 16, 7], 1: [13, 0, 16, 3] } })); }
  if (n === 'chorus_plant') return done(boxes([[4, 0, 4, 12, 16, 12]], all));

  // ---- workstations and containers --------------------------------------------------------------
  if (n === 'stonecutter_block' || n === 'stonecutter') {
    const q = boxes([[0, 0, 0, 16, 9, 16]], all);
    Q.plane(q, [1 / 16, 1, 0.5, 1 / 16, 9 / 16, 0.5, 15 / 16, 9 / 16, 0.5, 15 / 16, 1, 0.5], S[4], [1, 9, 15, 16]);
    return done(yaw(q, stepsOf(st) * 90));
  }
  if (n === 'enchanting_table') return done(boxes([[0, 0, 0, 16, 12, 16]], all));
  if (n === 'lectern') return done(boxes([[0, 0, 0, 16, 2, 16], [4, 2, 4, 12, 13, 12], [0, 13, 1, 16, 16, 15]], all, stepsOf(st)));
  if (n === 'grindstone') return done(boxes([[4, 4, 2, 12, 16, 14], [2, 0, 6, 4, 7, 10], [12, 0, 6, 14, 7, 10]], all, stepsOf(st)));
  if (/anvil$/.test(n)) return done(boxes([[2, 0, 2, 14, 4, 14], [4, 4, 3, 12, 5, 13], [6, 5, 4, 10, 10, 12], [3, 10, 0, 13, 16, 16]], all, stepsOf(st)));
  if (n === 'hopper') {
    const f = st.facing_direction | 0;
    const list = [[0, 10, 0, 16, 16, 16], [4, 4, 4, 12, 10, 12]];
    const q = boxes(list, all);
    const spout = f < 2 ? [6, 0, 6, 10, 4, 10] : rotBox([6, 4, 0, 10, 8, 4], { 2: 0, 4: 1, 3: 2, 5: 3 }[f] | 0);
    Q.box(q, spout[0], spout[1], spout[2], spout[3], spout[4], spout[5], all);
    return done(q);
  }
  if (n === 'cauldron') {
    const side = (d) => (d === 1 ? S[1] : d === 0 ? S[0] : S[2]);
    return done(boxes([[0, 3, 0, 16, 4, 16], [0, 4, 0, 2, 16, 16], [14, 4, 0, 16, 16, 16], [2, 4, 0, 14, 16, 2], [2, 4, 14, 14, 16, 16],
      [0, 0, 0, 4, 3, 4], [12, 0, 0, 16, 3, 4], [0, 0, 12, 4, 3, 16], [12, 0, 12, 16, 3, 16]], side));
  }
  if (n === 'brewing_stand') return done(boxes([[7, 0, 7, 9, 14, 9], [9, 0, 5, 15, 2, 11], [2, 0, 1, 8, 2, 7], [2, 0, 9, 8, 2, 15]], (d) => S[0]));
  if (n === 'bell') {
    // the bell's picture sits in the top-left corner of its texture
    const q = [];
    Q.box(q, 5, 6, 5, 11, 13, 11, (d) => S[2], { uv: { 0: [0, 0, 6, 6], 1: [0, 0, 6, 6], 2: [0, 0, 6, 7], 3: [0, 0, 6, 7], 4: [0, 0, 6, 7], 5: [0, 0, 6, 7] } });
    Q.box(q, 4, 4, 4, 12, 6, 12, (d) => S[2], { uv: { 0: [0, 0, 8, 8], 1: [0, 0, 8, 8], 2: [0, 7, 8, 9], 3: [0, 7, 8, 9], 4: [0, 7, 8, 9], 5: [0, 7, 8, 9] } });
    return done(q);
  }
  if (/_shelf$/.test(n)) return done(boxes([[0, 0, 0, 16, 16, 5], [0, 0, 5, 16, 1, 8], [0, 15, 5, 16, 16, 8]], all, stepsOf(st)));
  if (n === 'conduit') return done(boxes([[5, 5, 5, 11, 11, 11]], all));
  if (n === 'dragon_egg') return done(boxes([[5, 0, 5, 11, 1, 11], [2, 1, 2, 14, 8, 14], [3, 8, 3, 13, 11, 13], [5, 11, 5, 11, 14, 11], [6, 14, 6, 10, 16, 10]], all));
  if (n === 'heavy_core') return done(boxes([[4, 0, 4, 12, 8, 12]], all));
  if (n === 'dried_ghast') return done(boxes([[3, 0, 3, 13, 10, 13]], all, stepsOf(st)));
  if (n === 'sniffer_egg') return done(boxes([[1, 0, 2, 15, 16, 14]], all));

  // ---- campfires --------------------------------------------------------------------------------
  if (/campfire$/.test(n)) {
    const log = (d) => S[0], lit = (d) => (st.extinguished ? S[0] : S[2]);
    const q = boxes([[1, 0, 0, 5, 4, 16], [11, 0, 0, 15, 4, 16]], log, stepsOf(st));
    for (const b of [[0, 3, 1, 16, 7, 5], [0, 3, 11, 16, 7, 15]]) { const r = rotBox(b, stepsOf(st)); Q.box(q, r[0], r[1], r[2], r[3], r[4], r[5], lit); }
    if (!st.extinguished) for (const f of M.crossQuads(S[1])) q.push(f);
    return done(q);
  }

  // ---- candles, cake, small clusters ------------------------------------------------------------
  if (/candle_cake$/.test(n) || n === 'cake') {
    const cake = slots('cake');
    const q = boxes([[1 + (st.bite_counter | 0) * 2, 0, 1, 15, 8, 15]], (d) => cake[d]);
    if (n !== 'cake') { const c = slots(n.replace(/_cake$/, '')); Q.box(q, 7, 8, 7, 9, 14, 9, (d) => c[d], { uv: { 0: [0, 14, 2, 16], 1: [0, 6, 2, 8], 2: [0, 8, 2, 14], 3: [0, 8, 2, 14], 4: [0, 8, 2, 14], 5: [0, 8, 2, 14] } }); }
    return done(q);
  }
  if (/candle$/.test(n)) {
    const uv = { uv: { 0: [0, 14, 2, 16], 1: [0, 6, 2, 8], 2: [0, 8, 2, 14], 3: [0, 8, 2, 14], 4: [0, 8, 2, 14], 5: [0, 8, 2, 14] } };
    const spots = [[[7, 7, 6]], [[5, 7, 6], [9, 6, 5]], [[7, 5, 6], [5, 8, 5], [9, 8, 3]], [[5, 5, 6], [9, 5, 5], [5, 9, 5], [9, 9, 3]]][Math.min(3, st.candles | 0)];
    return done(boxes(spots.map(([x, z, h]) => [x, 0, z, x + 2, h, z + 2]), all, 0, uv));
  }
  if (n === 'sea_pickle') {
    const spots = [[[6, 6, 6]], [[3, 3, 6], [8, 8, 6]], [[6, 9, 6], [2, 2, 4], [8, 4, 6]], [[2, 2, 6], [9, 10, 6], [9, 2, 6], [2, 8, 7]]][Math.min(3, st.cluster_count | 0)];
    return done(boxes(spots.map(([x, z, h]) => [x, 0, z, x + 4, h, z + 4]), all, 0, { uv: { 0: [8, 1, 12, 5], 1: [4, 1, 8, 5], 2: [0, 5, 4, 11], 3: [4, 5, 8, 11], 4: [8, 5, 12, 11], 5: [12, 5, 16, 11] } }));
  }
  if (n === 'turtle_egg') {
    const count = { one_egg: 1, two_egg: 2, three_egg: 3, four_egg: 4 }[st.turtle_egg_count] || 1;
    const spots = [[5, 4, 7, 4], [1, 7, 5, 4], [11, 7, 4, 3], [6, 10, 3, 3]].slice(0, count);
    return done(boxes(spots.map(([x, z, h, w]) => [x, 0, z, x + w, h, z + w]), all));
  }
  if (n === 'cocoa') { const s = 4 + 2 * Math.min(2, st.age | 0); return done(boxes([[8 - s / 2, 12 - s - 1, 15 - s, 8 + s / 2, 12, 15]], all, [0, 3, 2, 1][st.direction & 3])); }

  // ---- plants with their own shape --------------------------------------------------------------
  if (n === 'pointed_dripstone') {
    const slot = { tip: S[2], frustum: S[0], middle: S[3], base: S[1], merge: S[4] }[st.dripstone_thickness] || S[2];
    const q = M.crossQuads(slot);
    if (!st.hanging) return done(q);
    for (const f of q) f.uv = [f.uv[2], f.uv[3], f.uv[0], f.uv[1], f.uv[6], f.uv[7], f.uv[4], f.uv[5]]; // upside down
    return done(q);
  }
  if (n === 'big_dripleaf') {
    const q = M.crossQuads(S[2]);
    if (st.big_dripleaf_head) for (const f of flat(S[3], 15 / 16)) q.push(f);
    return done(q);
  }
  if (n === 'small_dripleaf_block') return done(M.crossQuads(st.upper_block_bit ? S[1] : S[3]));
  if (n === 'spore_blossom') {
    const q = Q.plane([], [0, 0.99, 1, 0, 0.99, 0, 1, 0.99, 0, 1, 0.99, 1], S[1]);
    for (const f of M.crossQuads(S[0])) q.push(f);
    return done(q);
  }
  if (/amethyst_bud$|^amethyst_cluster$/.test(n)) {
    const face = FACE_NAMES[st['minecraft:block_face']];
    return done(attach(M.crossQuads(S[2]), face === undefined ? 1 : face));
  }
  if (n === 'pink_petals' || n === 'wildflowers' || n === 'leaf_litter' || n === 'frog_spawn') return done(flat(S[1], n === 'frog_spawn' ? 0.02 : 0.05));

  return undefined;
}

module.exports = { extraShape, NEEDS_ENTITY };
