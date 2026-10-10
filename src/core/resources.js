'use strict';
// Everything a world needs to look right: its pack stack, textures, materials, biome colours,
// custom block definitions and custom geometry.
const path = require('path');
const { PNG } = require('pngjs');
const { PackStack, Pack, parseJson, findGameData, vanillaPacks, worldPacks } = require('./packs');
const { comMojangRoots } = require('./world');
const { readNbt } = require('./nbt');
const { VANILLA_BIOMES } = require('./biomes');
const { simplifyImage } = require('./simplify');

function decodeTga(buf) {
  const idLen = buf[0], type = buf[2], w = buf.readUInt16LE(12), h = buf.readUInt16LE(14), bpp = buf[16], desc = buf[17];
  if (buf[1] !== 0 || (type !== 2 && type !== 10 && type !== 3 && type !== 11)) throw new Error('Unsupported TGA');
  const bytes = bpp >> 3;
  const data = new Uint8Array(w * h * 4);
  let p = 18 + idLen;
  const n = w * h;
  const put = (i, o) => {
    const d = i * 4;
    if (bytes === 1) { data[d] = data[d + 1] = data[d + 2] = buf[o]; data[d + 3] = 255; }
    else { data[d] = buf[o + 2]; data[d + 1] = buf[o + 1]; data[d + 2] = buf[o]; data[d + 3] = bytes === 4 ? buf[o + 3] : 255; }
  };
  if (type === 2 || type === 3) {
    for (let i = 0; i < n; i++, p += bytes) put(i, p);
  } else {
    let i = 0;
    while (i < n) {
      const c = buf[p++], count = (c & 0x7f) + 1;
      if (c & 0x80) { for (let k = 0; k < count && i < n; k++, i++) put(i, p); p += bytes; }
      else for (let k = 0; k < count && i < n; k++, i++, p += bytes) put(i, p);
    }
  }
  if (!(desc & 0x20)) { // bottom-left origin: flip rows
    const row = w * 4, tmp = new Uint8Array(row);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row, b = (h - 1 - y) * row;
      tmp.set(data.subarray(a, a + row)); data.copyWithin(a, b, b + row); data.set(tmp, b);
    }
  }
  return { w, h, data };
}

function decodeImage(buf, ext) {
  if (ext === '.tga') return decodeTga(buf);
  const png = PNG.sync.read(buf);
  return { w: png.width, h: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// RGBA PNG with exactly one IDAT chunk. Cinema 4D's bitmap loader refuses PNGs whose image data
// is split over several IDAT chunks (valid PNG, but it reports "Couldn't open file").
function encodePng(img) {
  const { w, h } = img, row = w * 4;
  const raw = Buffer.alloc((row + 1) * h);
  const src = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  for (let y = 0; y < h; y++) src.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row); // filter byte 0 = none
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', require('zlib').deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function hexToRgb(hex) {
  if (Array.isArray(hex)) return hex.length >= 3 ? [hex[0] * 255, hex[1] * 255, hex[2] * 255].map(Math.round) : null;
  if (typeof hex !== 'string') return null;
  let s = hex.replace(/^#/, '');
  if (s.length === 8) s = s.slice(2); // AARRGGBB
  if (s.length !== 6) return null;
  const v = parseInt(s, 16);
  return isNaN(v) ? null : [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const DEFAULT_TINT = { grass: [145, 189, 89], foliage: [119, 171, 47], water: [63, 118, 228] };
const FIXED_TINT = { birch_foliage: [128, 167, 85], evergreen_foliage: [97, 153, 97], dry_foliage: [161, 132, 85] };

class Resources {
  // opts: { worldDir, extraPacks: [dir...], gameData, db (LevelDB, optional, for custom biome ids) }
  constructor(opts) {
    this.gameData = opts.gameData || findGameData();
    const roots = comMojangRoots();
    const vanilla = vanillaPacks(this.gameData, 'resource_packs');
    const wr = opts.worldDir ? worldPacks(opts.worldDir, 'resource_packs', roots) : { packs: [], missing: [] };
    const wb = opts.worldDir ? worldPacks(opts.worldDir, 'behavior_packs', roots) : { packs: [], missing: [] };
    const extra = (opts.extraPacks || []).map((d) => new Pack(d));
    this.worldResourcePacks = wr.packs; this.worldBehaviorPacks = wb.packs;
    this.missingPacks = wr.missing;
    this.extraPacks = extra;
    this.addonPacks = [...wr.packs, ...extra];
    this.stack = new PackStack([...vanilla, ...wr.packs, ...extra]);
    this.hasVanilla = vanilla.length > 0;

    this.blocksJson = {};
    for (const j of this.stack.readAllJson('blocks.json')) Object.assign(this.blocksJson, j);
    this.terrain = {};
    for (const j of this.stack.readAllJson('textures/terrain_texture.json')) Object.assign(this.terrain, j.texture_data || {});
    // animated textures: path -> { ticks per frame, explicit frame order or null }
    this.flipbooks = new Map();
    for (const j of this.stack.readAllJson('textures/flipbook_textures.json')) {
      if (!Array.isArray(j)) continue;
      for (const f of j) {
        if (!f || !f.flipbook_texture) continue;
        this.flipbooks.set(String(f.flipbook_texture).toLowerCase(), { ticks: Math.max(1, f.ticks_per_frame | 0 || 1), order: Array.isArray(f.frames) ? f.frames : null });
      }
    }

    this.images = new Map();     // texture path -> image | null
    this.materials = [];         // { id, name, image, mode: 'opaque'|'cutout'|'blend', color }
    this.materialIndex = new Map();
    this.tintCache = new Map();
    this._customBlocks = null; this._geoIndex = null; this._geoCache = new Map();
    this._biomeNames = new Map(VANILLA_BIOMES);
    this._biomeColors = new Map();
    this._clientBiomes = null;
    if (opts.db) this._loadBiomeIds(opts.db);
    this.missing = this._makeMissing();
  }

  _loadBiomeIds(db) {
    try {
      const v = db.get(Buffer.from('BiomeIdsTable'));
      const t = v && readNbt(v, { p: 0 });
      for (const e of (t && t.list) || []) this._biomeNames.set(e.id, String(e.name));
    } catch (e) { /* older worlds have no table */ }
  }

  _makeMissing() {
    const data = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const on = ((x >> 3) ^ (y >> 3)) & 1, o = (y * 16 + x) * 4;
      data[o] = on ? 248 : 0; data[o + 1] = 0; data[o + 2] = on ? 248 : 0; data[o + 3] = 255;
    }
    const image = { w: 16, h: 16, data, key: '<missing>', alpha: 'opaque' };
    return this._addMaterial('missing_texture', image, 'opaque', '<missing>');
  }

  // ---- textures -------------------------------------------------------------------------------

  // Loads a texture by pack path without extension (e.g. textures/blocks/stone).
  image(texPath) {
    const key = String(texPath).replace(/\\/g, '/').replace(/\.(png|tga|jpg|jpeg)$/i, '');
    if (this.images.has(key)) return this.images.get(key);
    let img = null;
    try {
      let file = key, buf = null, ext = null;
      const set = this.stack.read(key + '.texture_set.json');
      if (set) {
        const j = parseJson(set.toString('utf8'));
        const c = j && j['minecraft:texture_set'] && j['minecraft:texture_set'].color;
        if (typeof c === 'string' && !c.startsWith('#')) file = key.slice(0, key.lastIndexOf('/') + 1) + c;
      }
      for (const e of ['.png', '.tga']) { buf = this.stack.read(file + e); if (buf) { ext = e; break; } }
      if (buf) {
        img = decodeImage(buf, ext);
        const flip = this.flipbooks.get(key.toLowerCase());
        if (flip && img.h > img.w && img.h % img.w === 0) {
          // Animated: frames are stacked top to bottom. Everything still shows the first frame;
          // the whole strip is kept so exporters that can play it get every frame.
          const count = img.h / img.w;
          const order = (flip.order || Array.from({ length: count }, (v, i) => i)).filter((i) => i >= 0 && i < count);
          const strip = { data: img.data, count, order, fps: 20 / flip.ticks };
          const first = (order[0] || 0) * img.w * img.w * 4;
          img = { w: img.w, h: img.w, data: img.data.slice(first, first + img.w * img.w * 4), strip };
        }
        img.key = key;
        img.alpha = classifyAlpha(img);
      }
    } catch (e) { img = null; }
    this.images.set(key, img);
    return img;
  }

  // Resolves a terrain_texture short name to { path, tint } (variant = index for legacy texture arrays).
  terrainTexture(name, variant) {
    const e = this.terrain[name];
    if (!e) return null;
    let t = e.textures;
    if (Array.isArray(t)) t = t[Math.min(variant || 0, t.length - 1)];
    if (t && Array.isArray(t.variations)) t = t.variations[0]; // weighted random variants: use the main one
    if (!t) return null;
    if (typeof t === 'string') return { path: t, tint: null };
    return { path: t.path, tint: hexToRgb(t.tint_color) };
  }

  _addMaterial(name, image, mode, key) {
    let n = name.replace(/[^A-Za-z0-9_.-]/g, '_'), i = 1;
    const used = this._usedNames || (this._usedNames = new Set());
    while (used.has(n.toLowerCase())) n = name.replace(/[^A-Za-z0-9_.-]/g, '_') + '_' + (++i);
    used.add(n.toLowerCase());
    const m = { id: this.materials.length, name: n, image, mode, color: null };
    this.materials.push(m);
    this.materialIndex.set(key, m.id);
    return m.id;
  }

  // Material for a texture path. opts: { tint: [r,g,b]|null, mode: render method or null (auto), alphaMasked }
  material(texPath, opts = {}) {
    const tint = opts.tint || null;
    const key = `${texPath}|${tint ? tint.join(',') : ''}|${opts.mode || ''}|${opts.alphaMasked ? 1 : 0}|${opts.opacity || ''}`;
    const hit = this.materialIndex.get(key);
    if (hit !== undefined) return hit;
    const src = texPath ? this.image(texPath) : null;
    if (!src) { this.materialIndex.set(key, this.missing); return this.missing; }
    let mode = opts.mode;
    if (mode === 'alpha_test' || mode === 'alpha_test_single_sided' || mode === 'alpha_test_to_opaque' || mode === 'alpha_test_single_sided_to_opaque') mode = src.alpha === 'opaque' ? 'opaque' : 'cutout';
    else if (mode === 'blend' || mode === 'blend_to_opaque') mode = src.alpha === 'opaque' ? 'opaque' : 'blend';
    else if (mode === 'opaque' || mode === 'double_sided') mode = 'opaque';
    else mode = src.alpha;
    if (opts.opacity) mode = 'blend';
    let image = src;
    if (tint || opts.opacity || (mode === 'opaque' && src.alpha !== 'opaque')) {
      // the same tint / opacity treatment for the still image and, if animated, every frame
      const treat = (source) => {
        const d = new Uint8Array(source);
        for (let i = 0; i < d.length; i += 4) {
          if (opts.opacity) d[i + 3] = Math.round(d[i + 3] * opts.opacity);
          if (tint) {
            // Alpha-masked tint (grass block sides): alpha marks how much of the tint applies.
            const k = opts.alphaMasked ? d[i + 3] / 255 : 1;
            d[i] = Math.round(d[i] * (1 - k + k * tint[0] / 255));
            d[i + 1] = Math.round(d[i + 1] * (1 - k + k * tint[1] / 255));
            d[i + 2] = Math.round(d[i + 2] * (1 - k + k * tint[2] / 255));
          }
          if (mode === 'opaque') d[i + 3] = 255;
        }
        return d;
      };
      image = { w: src.w, h: src.h, data: treat(src.data), key: src.key, alpha: mode };
      if (src.strip) image.strip = Object.assign({}, src.strip, { data: treat(src.strip.data) });
    }
    const base = path.posix.basename(src.key);
    const name = tint ? `${base}_${tint.map((c) => c.toString(16).padStart(2, '0')).join('')}` : base;
    return this._addMaterial(name, image, mode, key);
  }

  // The picture to use for a material: as authored, or flattened to a few solid colours.
  imageOf(m, simplify) {
    if (!simplify) return m.image;
    if (!m.simple) { try { m.simple = simplifyImage(m.image); } catch (e) { m.simple = m.image; } }
    return m.simple;
  }

  // A material from a picture made here (sign text, a composed banner). key makes it reusable.
  customMaterial(key, name, image) {
    const k = 'custom|' + key;
    const hit = this.materialIndex.get(k);
    if (hit !== undefined) return hit;
    image.alpha = classifyAlpha(image);
    image.key = k;
    return this._addMaterial(name, image, image.alpha, k);
  }

  // ---- entities -------------------------------------------------------------------------------

  // Finds "<kind>" definitions by identifier across packs without parsing every file up front.
  _defIndex(cacheName, packs, dir, pattern) {
    if (this[cacheName]) return this[cacheName];
    const index = new Map();
    for (const p of packs) {
      let files;
      try { files = p.list(dir); } catch (e) { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const buf = p.read(f);
        if (!buf) continue;
        const text = buf.toString('utf8');
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text))) index.set(m[1], { pack: p, file: f }); // later packs override
      }
    }
    this[cacheName] = index;
    return index;
  }

  _def(cacheName, packs, dir, pattern, id, pick) {
    const cache = this[cacheName + 'Parsed'] || (this[cacheName + 'Parsed'] = new Map());
    if (cache.has(id)) return cache.get(id);
    let out = null;
    const ref = this._defIndex(cacheName, packs, dir, pattern).get(id);
    if (ref) { try { out = pick(parseJson(ref.pack.read(ref.file).toString('utf8'))) || null; } catch (e) { out = null; } }
    cache.set(id, out);
    return out;
  }

  // Client entity description (geometry, textures, render controllers) or null.
  clientEntity(id) {
    return this._def('_clientEntities', this.stack.packs, 'entity', /"identifier"\s*:\s*"([^"]+)"/g, id,
      (j) => { const d = j['minecraft:client_entity'] && j['minecraft:client_entity'].description; return d && d.identifier === id ? d : null; });
  }

  // Behavior definition of an add-on entity (to tell furniture from mobs) or null.
  behaviorEntity(id) {
    return this._def('_behaviorEntities', this.worldBehaviorPacks, 'entities', /"identifier"\s*:\s*"([^"]+)"/g, id,
      (j) => { const e = j['minecraft:entity']; return e && e.description && e.description.identifier === id ? e : null; });
  }

  renderController(name) {
    return this._def('_renderControllers', this.stack.packs, 'render_controllers', /"(controller\.render\.[^"]+)"\s*:/g, name,
      (j) => (j.render_controllers && j.render_controllers[name]) || null);
  }

  // Texture path of an item's icon, or null.
  itemTexture(name) {
    if (!this._itemTextures) {
      this._itemTextures = {};
      for (const j of this.stack.readAllJson('textures/item_texture.json')) Object.assign(this._itemTextures, j.texture_data || {});
    }
    const short = String(name).replace(/^minecraft:/, '');
    const e = this._itemTextures[short] || this._itemTextures[name];
    // many items share a legacy entry (all swords under "sword"); their picture is still named after them
    if (!e) return this.image('textures/items/' + short) ? 'textures/items/' + short : null;
    let t = e.textures;
    if (Array.isArray(t)) t = t[0];
    return typeof t === 'string' ? t : (t && t.path) || null;
  }

  // Average visible colour of a material (for the map).
  materialColor(id) {
    const m = this.materials[id];
    if (m.color) return m.color;
    const d = m.image.data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a < 32) continue;
      r += d[i] * a; g += d[i + 1] * a; b += d[i + 2] * a; n += a;
    }
    m.color = n ? [r / n, g / n, b / n] : [0, 0, 0];
    m.coverage = n / (d.length / 4 * 255);
    return m.color;
  }

  // ---- biomes ---------------------------------------------------------------------------------

  _loadClientBiomes() {
    const out = new Map();
    // Legacy table first, per-biome client files override it.
    for (const j of this.stack.readAllJson('biomes_client.json')) {
      for (const [name, b] of Object.entries((j && j.biomes) || {})) {
        const c = hexToRgb(b.water_surface_color);
        if (c) out.set('minecraft:' + name, { water: c });
      }
    }
    for (const p of this.stack.packs) {
      let files;
      try { files = p.list('biomes'); } catch (e) { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const j = parseJson(p.read(f).toString('utf8'));
          const cb = j['minecraft:client_biome'];
          if (!cb) continue;
          const id = cb.description.identifier, c = cb.components || {};
          const e = Object.assign({}, out.get(id) || out.get('minecraft:' + id));
          const col = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? hexToRgb(x.color) : hexToRgb(x));
          const g = col(c['minecraft:grass_appearance']), fo = col(c['minecraft:foliage_appearance']);
          const wa = c['minecraft:water_appearance'] && hexToRgb(c['minecraft:water_appearance'].surface_color);
          const dry = col(c['minecraft:dry_foliage_color']);
          if (g) e.grass = g; if (fo) e.foliage = fo; if (wa) e.water = wa; if (dry) e.dry_foliage = dry;
          out.set(id.includes(':') ? id : 'minecraft:' + id, e);
        } catch (e) { /* skip unreadable biome */ }
      }
    }
    return out;
  }

  // tintMethod: grass | default_foliage | birch_foliage | evergreen_foliage | dry_foliage | water
  biomeTint(tintMethod, biomeId) {
    if (!tintMethod || tintMethod === 'none') return null;
    if (tintMethod === 'default_foliage') tintMethod = 'foliage';
    const key = tintMethod + ':' + biomeId;
    let c = this._biomeColors.get(key);
    if (c !== undefined) return c;
    if (!this._clientBiomes) this._clientBiomes = this._loadClientBiomes();
    const name = this._biomeNames.get(biomeId);
    const cb = name && (this._clientBiomes.get(name) || this._clientBiomes.get('minecraft:' + name));
    c = (cb && cb[tintMethod]) || null;
    if (!c && (tintMethod === 'grass' || tintMethod === 'foliage')) c = this._colormap(tintMethod, name);
    if (!c) c = FIXED_TINT[tintMethod] || DEFAULT_TINT[tintMethod] || DEFAULT_TINT.grass;
    this._biomeColors.set(key, c);
    return c;
  }

  _colormap(kind, biomeName) {
    const { BIOME_CLIMATE } = require('./biomes');
    const short = biomeName ? biomeName.replace(/^minecraft:/, '') : 'plains';
    const fixed = { swampland: [106, 112, 57], swampland_mutated: [106, 112, 57], mangrove_swamp: [141, 177, 39] };
    if (fixed[short] && kind === 'grass') return fixed[short];
    if (/^mesa/.test(short)) return kind === 'grass' ? [144, 129, 77] : [158, 129, 77];
    const cl = BIOME_CLIMATE[short];
    if (!cl) return null;
    const img = this.image(`textures/colormap/${kind}`);
    if (!img) return null;
    const t = Math.min(1, Math.max(0, cl[0])), r = Math.min(1, Math.max(0, cl[1])) * t;
    const x = Math.min(img.w - 1, Math.floor((1 - t) * (img.w - 1))), y = Math.min(img.h - 1, Math.floor((1 - r) * (img.h - 1)));
    const o = (y * img.w + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2]];
  }

  // ---- add-on blocks and geometry ---------------------------------------------------------------

  customBlock(name) {
    if (!this._customBlocks) {
      this._customBlocks = new Map();
      for (const p of this.worldBehaviorPacks) {
        for (const f of p.list('blocks')) {
          if (!f.endsWith('.json')) continue;
          try {
            const j = parseJson(p.read(f).toString('utf8'));
            const b = j['minecraft:block'];
            if (b && b.description && b.description.identifier) this._customBlocks.set(b.description.identifier, b);
          } catch (e) { /* skip broken block file */ }
        }
      }
    }
    return this._customBlocks.get(name) || null;
  }

  // Returns the geometry description object for an identifier, or null.
  geometry(id) {
    if (this._geoCache.has(id)) return this._geoCache.get(id);
    if (!this._geoIndex) {
      this._geoIndex = new Map();
      for (const p of this.stack.packs) { // vanilla too: armor stands, minecarts and the like
        for (const f of p.list('models')) {
          if (!f.endsWith('.json')) continue;
          const buf = p.read(f);
          if (!buf) continue;
          const text = buf.toString('utf8');
          const re = /"(geometry\.[^"]+)"/g;
          let m;
          while ((m = re.exec(text))) this._geoIndex.set(m[1].split(':')[0], { pack: p, file: f });
        }
      }
    }
    let geo = null;
    const ref = this._geoIndex.get(id);
    if (ref) {
      try {
        const j = parseJson(ref.pack.read(ref.file).toString('utf8'));
        if (Array.isArray(j['minecraft:geometry'])) {
          geo = j['minecraft:geometry'].find((g) => g.description && g.description.identifier === id) || null;
        } else if (j[id] || Object.keys(j).find((k) => k.split(':')[0] === id)) {
          // legacy 1.8 format: { "geometry.name": { texturewidth, bones } }
          const k = j[id] ? id : Object.keys(j).find((x) => x.split(':')[0] === id);
          geo = { description: { identifier: id, texture_width: j[k].texturewidth || 64, texture_height: j[k].textureheight || 64 }, bones: j[k].bones || [] };
        }
      } catch (e) { geo = null; }
    }
    this._geoCache.set(id, geo);
    return geo;
  }
}

function classifyAlpha(img) {
  const d = img.data;
  let clear = 0, partial = 0;
  const n = d.length / 4;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    if (a < 16) clear++; else if (a < 240) partial++;
  }
  if (partial > n * 0.02) return 'blend';
  if (clear > 0 || partial > 0) return 'cutout';
  return 'opaque';
}

module.exports = { Resources, encodePng, hexToRgb };
