'use strict';
// Java Edition textures, block definitions and biome colours, read from the game jar, the world's
// mods, its resources.zip / datapacks and any packs added by hand (later ones win).
const fs = require('fs');
const path = require('path');
const { TextureLibrary, decodeImage, classifyAlpha } = require('../resources');
const { JavaPack, JavaPackStack } = require('./jar');
const { jarFor, gameOf } = require('./install');

// "minecraft:block/stone" / "block/stone" -> ["minecraft", "block/stone"]
function splitId(id) {
  const s = String(id);
  const i = s.indexOf(':');
  return i < 0 ? ['minecraft', s] : [s.slice(0, i), s.slice(i + 1)];
}

const hexOrInt = (v) => {
  if (typeof v === 'number') return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v)) { const n = parseInt(v.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  return null;
};

class JavaResources extends TextureLibrary {
  // opts: { worldDir, version, extraPacks: [path...], biomeNames: [] (shared with the world) }
  constructor(opts) {
    super();
    this.edition = 'java';
    const jar = jarFor(opts.version);
    this.gameJar = jar;
    this.hasVanilla = !!jar;
    this.gameData = jar ? jar.file : null;
    const packs = [];
    if (jar) { try { packs.push(new JavaPack(jar.file, { kind: 'game', name: 'Minecraft ' + jar.version })); } catch (e) { this.hasVanilla = false; } }
    // mods of the instance the world belongs to: their blocks, textures and biomes
    this.modPacks = [];
    const game = opts.worldDir ? gameOf(opts.worldDir) : null;
    if (game && game.mods) {
      let files = [];
      try { files = fs.readdirSync(game.mods).filter((f) => /\.jar$/i.test(f)); } catch (e) { files = []; }
      for (const f of files) {
        try {
          const p = new JavaPack(path.join(game.mods, f), { kind: 'mod' });
          if (p.zip && ![...p.zip.entries.keys()].some((n) => n.startsWith('assets/') || n.startsWith('data/'))) { p.close(); continue; }
          this.modPacks.push(p);
        } catch (e) { /* not a readable jar */ }
      }
      packs.push(...this.modPacks);
    }
    // the world's own resource pack and data packs
    this.worldResourcePacks = [];
    const wr = opts.worldDir && path.join(opts.worldDir, 'resources.zip');
    if (wr && fs.existsSync(wr)) { try { const p = new JavaPack(wr, { kind: 'world', name: 'World resource pack' }); packs.push(p); this.worldResourcePacks.push(p); } catch (e) { /* broken zip */ } }
    this.dataPacks = [];
    if (opts.worldDir) {
      let ents = [];
      try { ents = fs.readdirSync(path.join(opts.worldDir, 'datapacks')); } catch (e) { ents = []; }
      for (const n of ents) {
        try { const p = new JavaPack(path.join(opts.worldDir, 'datapacks', n), { kind: 'datapack' }); this.dataPacks.push(p); packs.push(p); } catch (e) { /* not a pack */ }
      }
    }
    this.extraPacks = [];
    for (const d of opts.extraPacks || []) {
      try { const p = new JavaPack(d, { kind: 'pack' }); packs.push(p); this.extraPacks.push(p); } catch (e) { /* unreadable */ }
    }
    this.stack = new JavaPackStack(packs);
    this.worldBehaviorPacks = [];
    this.missingPacks = [];
    this.biomeNames = opts.biomeNames || ['minecraft:plains'];
    this._biomes = new Map();
    this._biomeColors = new Map();
    this._json = new Map();
  }

  // ---- files ------------------------------------------------------------------------------------

  json(rel) {
    if (this._json.has(rel)) return this._json.get(rel);
    const j = this.stack.readJson(rel);
    this._json.set(rel, j);
    return j;
  }
  blockstate(name) { const [ns, p] = splitId(name); return this.json(`assets/${ns}/blockstates/${p}.json`); }
  model(id) { const [ns, p] = splitId(id); return this.json(`assets/${ns}/models/${p}.json`); }

  // Texture by id ("minecraft:block/stone"). Bedrock-style paths used by shared helpers are mapped.
  // "a+b" is texture a with overlay b on top; the overlay's coverage is kept in the alpha channel so
  // a tint can be applied to the overlay part only (grass block sides).
  image(id) {
    const key = String(id);
    if (this.images.has(key)) return this.images.get(key);
    let img = null;
    if (key.includes('+')) {
      const [a, b] = key.split('+');
      const base = this.image(a), over = this.image(b);
      if (base && over && base.w === over.w && base.h === over.h) {
        const d = new Uint8Array(base.data.length);
        for (let i = 0; i < d.length; i += 4) {
          const k = over.data[i + 3] / 255;
          for (let c = 0; c < 3; c++) d[i + c] = Math.round(base.data[i + c] * (1 - k) + over.data[i + c] * k);
          d[i + 3] = over.data[i + 3];
        }
        img = { w: base.w, h: base.h, data: d, key: base.key + '_overlay', alpha: 'cutout' };
      } else img = base;
      this.images.set(key, img);
      return img;
    }
    try {
      let ns, p;
      if (key === 'font/default8') { ns = 'minecraft'; p = 'font/ascii'; } else [ns, p] = splitId(key);
      const file = `assets/${ns}/textures/${p}`;
      const buf = this.stack.read(file + '.png');
      if (buf) {
        img = decodeImage(buf, '.png');
        // animated: frames stacked top to bottom, described by the .mcmeta next to it
        let meta = null;
        try { const m = this.stack.read(file + '.png.mcmeta'); meta = m && JSON.parse(m.toString('utf8').replace(/^﻿/, '')); } catch (e) { meta = null; }
        const anim = meta && meta.animation;
        if (anim) {
          const fw = anim.width || Math.min(img.w, img.h), fh = anim.height || fw;
          if (fw === img.w && img.h > fh && img.h % fh === 0) {
            const count = img.h / fh;
            const frames = Array.isArray(anim.frames) ? anim.frames.map((f) => (typeof f === 'number' ? f : f.index)).filter((i) => i >= 0 && i < count) : Array.from({ length: count }, (v, i) => i);
            const strip = { data: img.data, count, order: frames, fps: 20 / Math.max(1, anim.frametime || 1) };
            const first = (frames[0] || 0) * fw * fh * 4;
            img = { w: fw, h: fh, data: img.data.slice(first, first + fw * fh * 4), strip };
          } else if (img.h > img.w && img.h % img.w === 0) {
            img = { w: img.w, h: img.w, data: img.data.slice(0, img.w * img.w * 4) };
          }
        }
        img.key = key.replace(/^minecraft:/, '');
        img.alpha = classifyAlpha(img);
      }
    } catch (e) { img = null; }
    this.images.set(key, img);
    return img;
  }

  close() { this.stack.close(); }

  // ---- biomes ------------------------------------------------------------------------------------

  biomeName(id) { return this.biomeNames[id] || null; }

  _biome(name) {
    let b = this._biomes.get(name);
    if (b !== undefined) return b;
    const [ns, p] = splitId(name);
    const j = this.json(`data/${ns}/worldgen/biome/${p}.json`);
    b = null;
    if (j) {
      const e = j.effects || {};
      b = {
        temperature: typeof j.temperature === 'number' ? j.temperature : 0.8,
        downfall: typeof j.downfall === 'number' ? j.downfall : 0.4,
        grass: hexOrInt(e.grass_color), foliage: hexOrInt(e.foliage_color), dry: hexOrInt(e.dry_foliage_color),
        water: hexOrInt(e.water_color), modifier: e.grass_color_modifier || null,
      };
    }
    this._biomes.set(name, b);
    return b;
  }

  _colormap(kind, b) {
    const img = this.image('minecraft:colormap/' + kind);
    const t = Math.min(1, Math.max(0, b ? b.temperature : 0.8)), d = Math.min(1, Math.max(0, b ? b.downfall : 0.4)) * t;
    if (!img) return kind === 'grass' ? [145, 189, 89] : [119, 171, 47];
    const x = Math.min(img.w - 1, Math.floor((1 - t) * 255 * img.w / 256)), y = Math.min(img.h - 1, Math.floor((1 - d) * 255 * img.h / 256));
    const o = (y * img.w + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
  }

  // tintMethod: grass | foliage | dry_foliage | water, or a fixed colour handled by the models.
  biomeTint(tintMethod, biomeId) {
    if (!tintMethod || tintMethod === 'none') return null;
    const key = tintMethod + ':' + biomeId;
    let c = this._biomeColors.get(key);
    if (c !== undefined) return c;
    const name = this.biomeNames[biomeId] || 'minecraft:plains';
    const b = this._biome(name);
    if (tintMethod === 'water') c = (b && b.water) || [63, 118, 228];
    else if (tintMethod === 'foliage') c = (b && b.foliage) || this._colormap('foliage', b);
    else if (tintMethod === 'dry_foliage') c = (b && b.dry) || this._colormap('dry_foliage', b) || [161, 132, 85];
    else {
      c = (b && b.grass) || this._colormap('grass', b);
      if (b && b.modifier === 'swamp') c = [106, 112, 57];
      else if (b && b.modifier === 'dark_forest') c = [((c[0] & 0xfe) + 0x28) >> 1, ((c[1] & 0xfe) + 0x34) >> 1, ((c[2] & 0xfe) + 0x0a) >> 1];
    }
    this._biomeColors.set(key, c);
    return c;
  }
}

module.exports = { JavaResources, splitId };
