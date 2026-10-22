'use strict';
// Java blocks the game draws in code instead of from block models: chests, beds, signs, banners,
// heads, shulker boxes, decorated pots, conduits and bell bodies. Built from boxes with the entity
// textures' box layout. What lives in the block entity (sign text, banner patterns, pot sherds) is
// drawn when the block entity is known.
const Q = require('../quads');
const textart = require('../textart');

const DYE = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const NEEDS_ENTITY_JAVA = /(_sign|_banner|^decorated_pot)$/;
// Degrees to turn something built facing north so it faces a direction.
const YAW = { north: 0, east: -90, south: 180, west: 90 };
const turn = (quads, deg) => (deg ? Q.transform(quads, Q.about(Q.rotation(1, deg), 0.5, 0.5, 0.5)) : quads);
// Built pointing up -> pointing along a face (shulker boxes).
function pointTo(quads, facing) {
  const m = { down: Q.rotation(0, 180), north: Q.rotation(0, -90), south: Q.rotation(0, 90), west: Q.rotation(2, 90), east: Q.rotation(2, -90) }[facing];
  return m ? Q.transform(quads, Q.about(m, 0.5, 0.5, 0.5)) : quads;
}

// A box built facing north whose faces use the standard entity box layout of a tw x th texture:
// a w x h x d box at (u, v) has its top and bottom in the first d rows and the four sides below.
// g: [x0, y0, z0, x1, y1, z1] in 1/16 block (the box drawn can be scaled relative to w, h, d).
function cuboid(out, slot, tw, th, g, u, v, w, h, d, opts = {}) {
  const s = 1 / 16;
  const R = (u0, v0, u1, v1) => [u0 / tw, v0 / th, u1 / tw, v1 / th];
  const sideV0 = v + d + (opts.cropTop || 0), sideV1 = v + d + h - (opts.cropBottom || 0);
  const rects = {
    2: R(u + d, sideV0, u + d + w, sideV1),
    3: R(u + 2 * d + w, sideV0, u + 2 * d + 2 * w, sideV1),
    5: R(u, sideV0, u + d, sideV1),
    4: R(u + d + w, sideV0, u + 2 * d + w, sideV1),
    1: R(u + d, v, u + d + w, v + d),
    0: R(u + d + w, v, u + d + 2 * w, v + d),
  };
  for (let dIdx = 0; dIdx < 6; dIdx++) {
    if (opts.skip && opts.skip.includes(dIdx)) continue;
    const p = Q.faceCorners(dIdx, g[0] * s, g[1] * s, g[2] * s, g[3] * s, g[4] * s, g[5] * s);
    const [u0, v0, u1, v1] = rects[dIdx];
    // sides: picture upright as seen from outside; top and bottom: the edge next to the front (north)
    // side sits against the front picture, as on the unfolded box
    const uv = dIdx >= 2 ? [u0, v0, u0, v1, u1, v1, u1, v0] : [u1, v1, u1, v0, u0, v0, u0, v1];
    out.push({ p, uv, slot, cull: -1 });
  }
  return out;
}

// Plain text of a text component in any of its saved forms (JSON string, string, compound, list).
function plain(c, depth = 0) {
  if (c === null || c === undefined || depth > 8) return '';
  if (typeof c === 'string') {
    const t = c.trim();
    if ((t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) && t.length > 1) { try { return plain(JSON.parse(t), depth + 1); } catch (e) { return c; } }
    return c;
  }
  if (Array.isArray(c)) return c.map((x) => plain(x, depth + 1)).join('');
  if (typeof c === 'object') {
    let s = typeof c.text === 'string' ? c.text : typeof c[''] === 'string' ? c[''] : c.translate ? (c.fallback || '') : '';
    if (c.extra) s += plain(c.extra, depth + 1);
    return s;
  }
  return String(c);
}

function dyeRgb(name) {
  const i = DYE.indexOf(String(name || 'black').replace(/^minecraft:/, ''));
  if (i === 15 || i < 0) return [0, 0, 0];
  return textart.DYES[i];
}

// Front and back text of a sign block entity: [{ text, colour }, { text, colour }].
function signTexts(be) {
  if (!be) return [null, null];
  const side = (t) => {
    if (!t) return null;
    const lines = (t.messages || []).map((m) => plain(m)).slice(0, 4);
    return lines.some((l) => l.trim()) ? { text: lines.join('\n'), colour: dyeRgb(t.color) } : null;
  };
  if (be.front_text || be.back_text) return [side(be.front_text), side(be.back_text)];
  // before 1.20: Text1..Text4 and Color
  const lines = [be.Text1, be.Text2, be.Text3, be.Text4].map((m) => plain(m));
  return [lines.some((l) => l.trim()) ? { text: lines.join('\n'), colour: dyeRgb(be.Color) } : null, null];
}

const WOODS = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak|[a-z_]+?)_(wall_)?(hanging_)?sign$/;

// M: the JavaModels, ns/n: namespace and block name, st: states, be: block entity or undefined.
// Returns a model, null (nothing drawn) or undefined (not one of these).
function special(M, ns, n, st, be) {
  if (ns !== 'minecraft') return undefined;
  const res = M.res;
  const tex = (id) => { const img = res.image(id); return img ? { slot: M.slot(id), w: img.w, h: img.h } : null; };
  // a slot for a picture made here (sign text, a composed banner) rather than loaded from a pack
  const made = (key, name, image) => (image ? { mat: res.customMaterial(key, name, image), tintMethod: null } : null);
  const done = (q) => M.finish(q);
  const facing = st.facing || 'north';

  // ---- chests -------------------------------------------------------------------------------------
  const chest = /^(waxed_)?((exposed|weathered|oxidized)_)?(copper_chest)$|^(chest|trapped_chest|ender_chest)$/.exec(n);
  if (chest) {
    const base = chest[5] === 'trapped_chest' ? 'trapped' : chest[5] === 'ender_chest' ? 'ender' : chest[4] ? 'copper' + (chest[3] ? '_' + chest[3] : '') : 'normal';
    const type = st.type === 'left' || st.type === 'right' ? st.type : 'single';
    const t = tex('minecraft:entity/chest/' + base + (type === 'single' ? '' : '_' + type)) || tex('minecraft:entity/chest/' + base);
    if (!t) return null;
    const q = [];
    if (type === 'single') {
      cuboid(q, t.slot, t.w, t.h, [1, 0, 1, 15, 10, 15], 0, 19, 14, 10, 14);
      cuboid(q, t.slot, t.w, t.h, [1, 9, 1, 15, 14, 15], 0, 0, 14, 5, 14);
      cuboid(q, t.slot, t.w, t.h, [7, 7, 0, 9, 11, 1], 0, 0, 2, 4, 1);
    } else {
      // halves of a double chest, built facing north: "left" reaches to its west edge
      const x0 = type === 'left' ? 0 : 1, x1 = type === 'left' ? 15 : 16;
      cuboid(q, t.slot, t.w, t.h, [x0, 0, 1, x1, 10, 15], 0, 19, 15, 10, 14);
      cuboid(q, t.slot, t.w, t.h, [x0, 9, 1, x1, 14, 15], 0, 0, 15, 5, 14);
      const k = type === 'left' ? 0 : 15;
      cuboid(q, t.slot, t.w, t.h, [k, 7, 0, k + 1, 11, 1], 0, 0, 1, 4, 1);
    }
    return done(turn(q, YAW[facing]));
  }

  // ---- beds ---------------------------------------------------------------------------------------
  // (26.x draws beds from block models; this is for older versions)
  const bed = /^([a-z_]+)_bed$/.exec(n);
  if (bed && DYE.includes(bed[1])) {
    const t = tex('minecraft:entity/bed/' + bed[1]);
    if (!t) return null;
    const head = st.part === 'head';
    // Each half is a 16 x 16 x 6 box in the texture (head at 0,0, foot at 0,22), lying flat: its
    // front is the mattress top, its 6-pixel strips are the long sides and the ends.
    const V = head ? 0 : 22, k = 1 / t.w, s16 = 1 / 16;
    const q = [];
    const quad = (d, uv) => q.push({ p: Q.faceCorners(d, 0, 3 * s16, 0, 1, 9 * s16, 1), uv: uv.map((x) => x * k), slot: t.slot, cull: -1 });
    // top: the pillow end (north) at the top of the picture
    quad(1, [6, V + 6, 6, V + 22, 22, V + 22, 22, V + 6]);
    quad(0, [44, V + 6, 44, V + 22, 28, V + 22, 28, V + 6]);
    // long sides: 6 wide, 16 tall in the picture, turned to lie along the bed
    quad(4, [6, V + 6, 0, V + 6, 0, V + 22, 6, V + 22]);
    quad(5, [22, V + 22, 28, V + 22, 28, V + 6, 22, V + 6]);
    // the end of this half (head end north, foot end south)
    if (head) quad(2, [22, 6, 22, 0, 6, 0, 6, 6]);
    else quad(3, [22, V + 6, 22, V, 38, V, 38, V + 6]);
    // two legs at the outer end of each half
    const legs = head ? [[0, 0], [13, 0]] : [[0, 13], [13, 13]];
    for (const [x, z] of legs) cuboid(q, t.slot, t.w, t.h, [x, 0, z, x + 3, 3, z + 3], 50, head ? 0 : 6, 3, 3, 3);
    // built with the pillow end to the north; facing is the way the head points
    return done(turn(q, YAW[facing]));
  }

  // ---- signs --------------------------------------------------------------------------------------
  // (26.x draws signs from block models; this is for older versions, built facing south like those)
  const sign = WOODS.exec(n);
  if (sign) {
    const wood = sign[1], wall = !!sign[2], hanging = !!sign[3];
    const t = tex(hanging ? 'minecraft:entity/signs/hanging/' + wood : 'minecraft:entity/signs/' + wood);
    if (!t) return null;
    const board = [];
    if (hanging) {
      cuboid(board, t.slot, t.w, t.h, [1, 0, 7, 15, 10, 9], 0, 12, 14, 10, 2);
      if (wall) cuboid(board, t.slot, t.w, t.h, [0, 14, 6, 16, 16, 10], 0, 0, 16, 2, 4);
      for (const x of [2, 13]) cuboid(board, t.slot, t.w, t.h, [x, 10, 7.5, x + 1, 14, 8.5], 0, 6, 1, 4, 1);
    } else if (wall) {
      cuboid(board, t.slot, t.w, t.h, [0, 4.33, 14.33, 16, 12.33, 15.67], 0, 0, 24, 12, 2);
    } else {
      cuboid(board, t.slot, t.w, t.h, [0, 9.33, 7.33, 16, 17.33, 8.67], 0, 0, 24, 12, 2);
      cuboid(board, t.slot, t.w, t.h, [7.33, 0, 7.33, 8.67, 9.33, 8.67], 0, 14, 2, 14, 2);
    }
    // the boxes face north as laid out; turn them to face south, then place like the game's models
    const q = turn(board, 180);
    for (const x of signTextQuads(M, n, st, be, true)) q.push(x);
    return done(turn(q, signYaw(n, st)));
  }

  // ---- banners ------------------------------------------------------------------------------------
  const banner = /^([a-z_]+?)_(wall_)?banner$/.exec(n);
  if (banner && DYE.includes(banner[1])) {
    const base = tex('minecraft:entity/banner/banner_base') || tex('minecraft:entity/banner_base');
    if (!base) return null;
    const img = bannerImage(res, banner[1], be);
    const cloth = img ? made('jbanner|' + banner[1] + '|' + JSON.stringify(patternsOf(be)), 'banner', img) : base.slot;
    const q = [];
    const W = base.w, H = base.h;
    const wall = !!banner[2];
    if (wall) {
      cuboid(q, base.slot, W, H, [1.33, 14, 14, 14.67, 15.33, 16], 0, 42, 20, 2, 2);
      cuboid(q, cloth, W, H, [1.33, -12.67, 13.33, 14.67, 14, 14], 0, 0, 20, 40, 1);
    } else {
      cuboid(q, base.slot, W, H, [7.33, 0, 7.33, 8.67, 28, 8.67], 44, 0, 2, 42, 2);
      cuboid(q, base.slot, W, H, [1.33, 28, 7.33, 14.67, 29.33, 8.67], 0, 42, 20, 2, 2);
      cuboid(q, cloth, W, H, [1.33, 1.33, 6.67, 14.67, 28, 7.33], 0, 0, 20, 40, 1);
    }
    return done(turn(q, wall ? YAW[facing] : 180 - 22.5 * (Number(st.rotation || 0) | 0)));
  }

  // ---- heads --------------------------------------------------------------------------------------
  const head = /^(skeleton|wither_skeleton|zombie|player|creeper|piglin|dragon)_(wall_)?(skull|head)$/.exec(n);
  if (head) {
    const kind = head[1], wall = !!head[2];
    const path = { skeleton: 'skeleton/skeleton', wither_skeleton: 'skeleton/wither_skeleton', zombie: 'zombie/zombie', player: 'player/wide/steve', creeper: 'creeper/creeper', piglin: 'piglin/piglin', dragon: 'enderdragon/dragon' }[kind];
    const t = tex('minecraft:entity/' + path) || (kind === 'player' ? tex('minecraft:entity/steve') : null);
    if (!t) return null;
    const q = [];
    if (kind === 'dragon') {
      cuboid(q, t.slot, t.w, t.h, wall ? [2, 2, 4, 14, 14, 16] : [2, 0, 2, 14, 12, 14], 112, 30, 16, 16, 16);
      cuboid(q, t.slot, t.w, t.h, wall ? [3.5, 4, -2, 12.5, 7.75, 4] : [3.5, 2, -4, 12.5, 5.75, 2], 176, 44, 12, 5, 16);
    } else if (kind === 'piglin') {
      cuboid(q, t.slot, t.w, t.h, wall ? [3, 4, 8, 13, 12, 16] : [3, 0, 4, 13, 8, 12], 0, 0, 10, 8, 8);
    } else {
      cuboid(q, t.slot, t.w, t.h, wall ? [4, 4, 8, 12, 12, 16] : [4, 0, 4, 12, 8, 12], 0, 0, 8, 8, 8);
    }
    return done(turn(q, wall ? YAW[facing] : 180 - 22.5 * (Number(st.rotation || 0) | 0)));
  }

  // ---- shulker boxes ------------------------------------------------------------------------------
  const shulker = /^(?:([a-z_]+)_)?shulker_box$/.exec(n);
  if (shulker && (!shulker[1] || DYE.includes(shulker[1]))) {
    const t = tex('minecraft:entity/shulker/shulker' + (shulker[1] ? '_' + shulker[1] : '')) || tex('minecraft:entity/shulker/shulker');
    if (!t) return null;
    const q = [];
    cuboid(q, t.slot, t.w, t.h, [0, 4, 0, 16, 16, 16], 0, 0, 16, 12, 16);
    cuboid(q, t.slot, t.w, t.h, [0, 0, 0, 16, 4, 16], 0, 28, 16, 8, 16, { cropTop: 4, skip: [1] });
    return done(pointTo(q, st.facing || 'up'));
  }

  // ---- decorated pots -----------------------------------------------------------------------------
  if (n === 'decorated_pot') {
    const baseT = tex('minecraft:entity/decorated_pot/decorated_pot_base');
    if (!baseT) return null;
    const sherds = sherdsOf(be);
    const side = (i) => {
      const item = sherds[i];
      const pat = item && /([a-z_]+)_pottery_sherd$/.exec(item);
      return (pat && tex('minecraft:entity/decorated_pot/' + pat[1] + '_pottery_pattern')) || tex('minecraft:entity/decorated_pot/decorated_pot_side') || baseT;
    };
    const q = [];
    // sides in the order the game stores them: back, left, right, front (built facing north)
    const faces = [[3, side(0)], [5, side(1)], [4, side(2)], [2, side(3)]];
    for (const [d, t] of faces) {
      const p = Q.faceCorners(d, 1 / 16, 0, 1 / 16, 15 / 16, 1, 15 / 16);
      q.push({ p, uv: Q.rectUV(1 / 16, 0, 15 / 16, 1), slot: t.slot, cull: -1 });
    }
    const k = (v) => v / baseT.w;
    for (const d of [0, 1]) q.push({ p: Q.faceCorners(d, 1 / 16, 0, 1 / 16, 15 / 16, 1, 15 / 16), uv: Q.rectUV(k(14), k(13), k(28), k(27)), slot: baseT.slot, cull: -1 });
    cuboid(q, baseT.slot, baseT.w, baseT.h, [4, 17, 4, 12, 20, 12], 0, 0, 8, 3, 8);
    cuboid(q, baseT.slot, baseT.w, baseT.h, [5, 16, 5, 11, 17, 11], 0, 5, 6, 1, 6, { skip: [1] });
    return done(turn(q, YAW[facing]));
  }

  if (/copper_golem_statue$/.test(n)) { M.unknown.set('minecraft:' + n, 'drawn by the game in code; not supported yet'); return null; }

  // ---- conduit and bell ---------------------------------------------------------------------------
  if (n === 'conduit') {
    const t = tex('minecraft:entity/conduit/base');
    if (!t) return null;
    return done(cuboid([], t.slot, t.w, t.h, [5, 5, 5, 11, 11, 11], 0, 0, 6, 6, 6));
  }
  if (n === 'bell') {
    // the frame comes from the block model; the bell itself is drawn in code
    const t = tex('minecraft:entity/bell/bell_body');
    const frame = M.entries('minecraft:bell', st) || [];
    const q = [];
    for (const e of frame) { const fq = M.modelQuads(e, 'minecraft:bell', st, null); if (fq) for (const x of fq) q.push(x); }
    if (t) {
      const body = [];
      cuboid(body, t.slot, t.w, t.h, [5, 6, 5, 11, 13, 11], 0, 0, 6, 7, 6);
      cuboid(body, t.slot, t.w, t.h, [4, 4, 4, 12, 6, 12], 0, 13, 8, 2, 8);
      for (const x of turn(body, YAW[facing])) q.push(x);
    }
    return q.length ? done(q) : null;
  }

  return undefined;
}

// ---- banner pictures ----------------------------------------------------------------------------

const CODES = { bs: 'stripe_bottom', ts: 'stripe_top', ls: 'stripe_left', rs: 'stripe_right', cs: 'stripe_center', ms: 'stripe_middle',
  drs: 'stripe_downright', dls: 'stripe_downleft', ss: 'small_stripes', cr: 'cross', sc: 'straight_cross', ld: 'diagonal_left',
  rud: 'diagonal_up_right', lud: 'diagonal_up_left', rd: 'diagonal_right', vh: 'half_vertical', vhr: 'half_vertical_right',
  hh: 'half_horizontal', hhb: 'half_horizontal_bottom', bl: 'square_bottom_left', br: 'square_bottom_right', tl: 'square_top_left',
  tr: 'square_top_right', bt: 'triangle_bottom', tt: 'triangle_top', bts: 'triangles_bottom', tts: 'triangles_top', mc: 'circle',
  mr: 'rhombus', bo: 'border', cbo: 'curly_border', bri: 'bricks', gra: 'gradient', gru: 'gradient_up', cre: 'creeper',
  sku: 'skull', flo: 'flower', moj: 'mojang', glb: 'globe', pig: 'piglin', flw: 'flow', gus: 'guster' };

// [[patternName, dyeName], ...] from either block entity format.
function patternsOf(be) {
  if (!be) return [];
  const list = be.patterns || be.Patterns || (be.components && be.components['minecraft:banner_patterns']) || [];
  const out = [];
  for (const p of list) {
    let pat = p.pattern !== undefined ? p.pattern : p.Pattern;
    if (pat && typeof pat === 'object') pat = pat.asset_id || '';
    pat = String(pat || '').replace(/^minecraft:/, '');
    if (CODES[pat]) pat = CODES[pat];
    let col = p.color !== undefined ? p.color : p.Color;
    if (typeof col === 'number') col = DYE[col & 15];
    if (pat) out.push([pat, String(col || 'white').replace(/^minecraft:/, '')]);
  }
  return out;
}

function bannerImage(res, baseColour, be) {
  const base = res.image('minecraft:entity/banner/banner_base') || res.image('minecraft:entity/banner_base');
  if (!base) return null;
  const w = base.w, h = base.h, data = new Uint8Array(base.data);
  const c0 = textart.DYES[DYE.indexOf(baseColour)] || textart.DYES[0];
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i] * c0[0] / 255; data[i + 1] = data[i + 1] * c0[1] / 255; data[i + 2] = data[i + 2] * c0[2] / 255; }
  for (const [pat, col] of patternsOf(be)) {
    const mask = res.image('minecraft:entity/banner/' + pat);
    if (!mask || mask.w !== w || mask.h !== h) continue;
    const c = textart.DYES[DYE.indexOf(col)] || textart.DYES[0];
    for (let i = 0; i < data.length; i += 4) {
      const a = mask.data[i + 3] / 255 * (mask.data[i] / 255);
      if (a <= 0) continue;
      const shade = (base.data[i] + base.data[i + 1] + base.data[i + 2]) / 765; // keep the cloth's weave
      data[i] = data[i] * (1 - a) + c[0] * shade * a;
      data[i + 1] = data[i + 1] * (1 - a) + c[1] * shade * a;
      data[i + 2] = data[i + 2] * (1 - a) + c[2] * shade * a;
    }
  }
  return { w, h, data };
}

// The four sherd items of a decorated pot: [back, left, right, front].
function sherdsOf(be) {
  const s = be && (be.sherds || (be.components && be.components['minecraft:pot_decorations']));
  if (!s) return [null, null, null, null];
  if (Array.isArray(s)) return [0, 1, 2, 3].map((i) => (s[i] ? String(s[i].id || s[i]) : null));
  return ['back', 'left', 'right', 'front'].map((k) => (s[k] ? String(s[k].id || s[k]) : null));
}

// ---- sign text and other parts drawn on top of block models ------------------------------------

const YAW_S = { south: 0, east: 90, north: 180, west: -90 }; // degrees from facing south
const signKind = (n) => (/wall_hanging_sign$/.test(n) ? 'wall_hanging' : /hanging_sign$/.test(n) ? 'hanging' : /wall_sign$/.test(n) ? 'wall' : 'standing');
function signYaw(n, st) {
  const k = signKind(n);
  return k === 'wall' || k === 'wall_hanging' ? YAW_S[st.facing || 'south'] || 0 : -22.5 * (Number(st.rotation || 0) | 0);
}

// The text planes of a sign, built facing south (front on the +z side) like the game's sign models.
// Turned into place unless raw is set (the caller turns the whole sign).
function signTextQuads(M, n, st, be, raw) {
  const q = [];
  const [front, back] = signTexts(be);
  if (!front && !back) return q;
  const res = M.res, s = 1 / 16;
  const k = signKind(n);
  // board area [x0, y0, x1, y1], front and back depth, picture size
  const b = k === 'standing' ? [0, 9.33, 16, 17.33, 8.72, 7.28, 96, 48] : k === 'wall' ? [0, 4.33, 16, 12.33, 1.72, null, 96, 48] : [1, 0, 15, 10, 9.05, 6.95, 84, 60];
  const add = (side, z, backSide) => {
    if (!side || z === null) return;
    const img = textart.textImage(res, side.text, b[6], b[7], side.colour, 4);
    if (!img) return;
    const slot = { mat: res.customMaterial(`jsign|${b[6]}x${b[7]}|${side.colour}|${side.text}`, 'sign_text', img), tintMethod: null };
    const [x0, y0, x1, y1] = b;
    if (!backSide) Q.plane(q, [x0 * s, y1 * s, z * s, x0 * s, y0 * s, z * s, x1 * s, y0 * s, z * s, x1 * s, y1 * s, z * s], slot);
    else Q.plane(q, [x1 * s, y1 * s, z * s, x1 * s, y0 * s, z * s, x0 * s, y0 * s, z * s, x0 * s, y1 * s, z * s], slot);
  };
  add(front, b[4], false);
  add(back, b[5], true);
  return raw ? q : turn(q, signYaw(n, st));
}

// Parts the game draws in code on top of a block model. Returns { quads, needsEntity } or null.
function extras(M, ns, n, st, be) {
  if (ns !== 'minecraft') return null;
  if (/_sign$/.test(n)) return { quads: signTextQuads(M, n, st, be, false), needsEntity: true };
  if (n === 'bell') {
    const img = M.res.image('minecraft:entity/bell/bell_body');
    if (!img) return null;
    const slot = M.slot('minecraft:entity/bell/bell_body'), body = [];
    cuboid(body, slot, img.w, img.h, [5, 6, 5, 11, 13, 11], 0, 0, 6, 7, 6);
    cuboid(body, slot, img.w, img.h, [4, 4, 4, 12, 6, 12], 0, 13, 8, 2, 8);
    return { quads: turn(body, YAW[st.facing || 'north']), needsEntity: false };
  }
  return null;
}

module.exports = { special, extras, NEEDS_ENTITY_JAVA, cuboid, plain };
