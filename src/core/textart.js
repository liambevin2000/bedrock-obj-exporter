'use strict';
// Pictures made from block-entity data: sign text in the game's own font, and banners composed
// from their base colour and pattern layers.

// The 16 dye colours, in the order blocks use (0 white ... 15 black).
const DYES = [[249, 255, 254], [249, 128, 29], [199, 78, 189], [58, 179, 218], [254, 216, 61], [128, 199, 31], [243, 139, 170], [71, 79, 82],
  [157, 157, 151], [22, 156, 156], [137, 50, 184], [60, 68, 170], [131, 84, 50], [94, 124, 22], [176, 46, 38], [29, 29, 33]];
const DYE_NAMES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'silver', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

// ---- font ---------------------------------------------------------------------------------------

function loadFont(res) {
  if (res._font !== undefined) return res._font;
  const img = res.image('font/default8');
  if (!img) return (res._font = null);
  const cell = img.w / 16;
  const widths = new Uint8Array(256);
  for (let c = 0; c < 256; c++) {
    const cx = (c % 16) * cell, cy = Math.floor(c / 16) * cell;
    let last = -1;
    for (let x = 0; x < cell; x++) for (let y = 0; y < cell; y++) if (img.data[((cy + y) * img.w + cx + x) * 4 + 3] > 40) last = x;
    widths[c] = last < 0 ? 0 : last + 1;
  }
  widths[32] = Math.round(cell * 3 / 8); // space
  return (res._font = { img, cell, widths });
}

const lineWidth = (font, s) => { let w = 0; for (const ch of s) { const c = ch.charCodeAt(0); w += (c < 256 ? font.widths[c] : font.widths[63]) + 1; } return Math.max(0, w - 1); };

// Draws up to `maxLines` centred lines into a transparent w x h picture. colour: [r,g,b].
function textImage(res, text, w, h, colour, maxLines) {
  const font = loadFont(res);
  if (!font) return null;
  const lines = String(text || '').replace(/§./g, '').split('\n').slice(0, maxLines || 4);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.some((l) => l.trim())) return null;
  const data = new Uint8Array(w * h * 4);
  const cell = font.cell, step = cell + 2;
  // the game lays four lines out from the top of the board
  const top = Math.round((h - (maxLines || 4) * step) / 2) + 1;
  lines.forEach((line, row) => {
    let x = Math.round((w - lineWidth(font, line)) / 2);
    const y0 = top + row * step;
    for (const ch of line) {
      let c = ch.charCodeAt(0);
      if (c >= 256) c = 63;
      const gx = (c % 16) * cell, gy = Math.floor(c / 16) * cell;
      for (let py = 0; py < cell; py++) for (let px = 0; px < font.widths[c]; px++) {
        if (font.img.data[((gy + py) * font.img.w + gx + px) * 4 + 3] <= 40) continue;
        const dx = x + px, dy = y0 + py;
        if (dx < 0 || dx >= w || dy < 0 || dy >= h) continue;
        const o = (dy * w + dx) * 4;
        data[o] = colour[0]; data[o + 1] = colour[1]; data[o + 2] = colour[2]; data[o + 3] = 255;
      }
      x += font.widths[c] + 1;
    }
  });
  return { w, h, data };
}

// Sign text colour is stored as a signed ARGB int.
function argb(n) { const v = (n | 0) >>> 0; return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }

// ---- banners ------------------------------------------------------------------------------------

const PATTERNS = {
  bs: 'stripe_bottom', ts: 'stripe_top', ls: 'stripe_left', rs: 'stripe_right', cs: 'stripe_center', ms: 'stripe_middle',
  drs: 'stripe_downright', dls: 'stripe_downleft', ss: 'small_stripes', cr: 'cross', sc: 'straight_cross',
  ld: 'diagonal_left', rud: 'diagonal_up_right', lud: 'diagonal_up_left', rd: 'diagonal_right',
  vh: 'half_vertical', vhr: 'half_vertical_right', hh: 'half_horizontal', hhb: 'half_horizontal_bottom',
  bl: 'square_bottom_left', br: 'square_bottom_right', tl: 'square_top_left', tr: 'square_top_right',
  bt: 'triangle_bottom', tt: 'triangle_top', bts: 'triangles_bottom', tts: 'triangles_top',
  mc: 'circle', mr: 'rhombus', bo: 'border', cbo: 'curly_border', bri: 'bricks', gra: 'gradient', gru: 'gradient_up',
  cre: 'creeper', sku: 'skull', flo: 'flower', moj: 'mojang', glb: 'globe', pig: 'piglin', flw: 'flow', gus: 'guster',
};

// Banner colours are stored in the opposite order to blocks (0 black ... 15 white).
const bannerDye = (n) => DYES[15 - (n & 15)];

// Composes the banner's cloth: base colour, then each pattern layer through its mask.
// Returns a picture in the banner texture layout (the cloth front is at 1,1 size 20x40 of 64x64).
function bannerImage(res, be) {
  const base = res.image('textures/entity/banner/banner_base') || res.image('textures/entity/banner/banner');
  if (!base) return null;
  const w = base.w, h = base.h, data = new Uint8Array(base.data);
  const tint = (c) => { for (let i = 0; i < data.length; i += 4) { data[i] = data[i] * c[0] / 255; data[i + 1] = data[i + 1] * c[1] / 255; data[i + 2] = data[i + 2] * c[2] / 255; data[i + 3] = 255; } };
  tint(bannerDye(be && typeof be.Base === 'number' ? be.Base : 15));
  for (const p of (be && be.Patterns) || []) {
    const name = PATTERNS[p.Pattern];
    const mask = name && res.image('textures/entity/banner/banner_' + name);
    if (!mask || mask.w !== w || mask.h !== h) continue;
    const c = bannerDye(p.Color | 0);
    // masks are either white-on-transparent or white-on-black
    const useAlpha = mask.alpha !== 'opaque';
    for (let i = 0; i < data.length; i += 4) {
      const a = (useAlpha ? mask.data[i + 3] : mask.data[i]) / 255;
      if (a <= 0) continue;
      const shade = (base.data[i] + base.data[i + 1] + base.data[i + 2]) / 765; // keep the cloth's weave
      data[i] = data[i] * (1 - a) + c[0] * shade * a;
      data[i + 1] = data[i + 1] * (1 - a) + c[1] * shade * a;
      data[i + 2] = data[i + 2] * (1 - a) + c[2] * shade * a;
    }
  }
  return { w, h, data };
}

module.exports = { textImage, bannerImage, argb, DYES, DYE_NAMES };
