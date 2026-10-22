'use strict';
// A made-up Java world showing every block the game jar defines (one state each), plus the blocks
// drawn in code with block entities (signs with text, banners with patterns, pots with sherds),
// paintings and item frames. Opened as "java-gallery:<version>" for testing the model system.
const { jarFor } = require('./install');

const SPACING = 2, ROW = 48, Y = 64;
const ZERO = new Uint16Array(4096);

class JavaGalleryWorld {
  constructor(version) {
    const jar = jarFor(version || null);
    this.version = jar ? jar.version : version;
    this.edition = 'java';
    this.biomeNames = ['minecraft:plains'];
    this.blocks = new Map();   // "x,y,z" -> { name, states }
    this.bes = new Map();      // "x,y,z" -> block entity
    this.entities = [];
    this.entries = [];         // [x, z, name] for the report
  }

  minY() { return -64; }
  biomeId() { return 0; }

  // Fills the scene once the resources are open (needs the jar's block list).
  setup(res) {
    const game = res.stack.packs.find((p) => p.kind === 'game');
    const names = game ? game.list('assets/minecraft/blockstates').map((f) => /blockstates\/(.+)\.json$/.exec(f)[1]).sort() : [];
    let i = 0;
    const place = (name, states, be) => {
      const x = (i % ROW) * SPACING, z = Math.floor(i / ROW) * SPACING;
      this.blocks.set(x + ',' + Y + ',' + z, { name, states });
      if (be) this.bes.set(x + ',' + Y + ',' + z, Object.assign({ x, y: Y, z }, be));
      this.entries.push([x, z, name]);
      i++;
      return [x, z];
    };
    for (const n of names) place('minecraft:' + n, defaultStates(res.blockstate('minecraft:' + n)));
    this.size = i;
    // block entities that change the look: in their own row at z = -6, the same place in every version
    let j = 0;
    const placeSpecial = (name, states, be) => {
      const x = j * SPACING, z = -6;
      this.blocks.set(x + ',' + Y + ',' + z, { name, states });
      if (be) this.bes.set(x + ',' + Y + ',' + z, Object.assign({ x, y: Y, z }, be));
      this.entries.push([x, z, name]);
      j++;
      return [x, z];
    };
    placeSpecial('minecraft:oak_sign', { rotation: '0' }, { id: 'minecraft:sign', front_text: { messages: ['"Bedrock"', '"OBJ"', '"Exporter"', '""'], color: 'black' } });
    placeSpecial('minecraft:spruce_wall_sign', { facing: 'south' }, { id: 'minecraft:sign', front_text: { messages: ['{"text":"Java"}', '{"text":"wall sign"}', '""', '""'], color: 'blue' } });
    placeSpecial('minecraft:cherry_hanging_sign', { rotation: '0', attached: 'false' }, { id: 'minecraft:hanging_sign', front_text: { messages: ['"Hanging"', '"sign"', '""', '""'], color: 'red' } });
    placeSpecial('minecraft:white_banner', { rotation: '0' }, { id: 'minecraft:banner', patterns: [{ pattern: 'minecraft:stripe_bottom', color: 'red' }, { pattern: 'minecraft:creeper', color: 'black' }] });
    placeSpecial('minecraft:blue_wall_banner', { facing: 'south' }, { id: 'minecraft:banner', Patterns: [{ Pattern: 'cr', Color: 4 }] });
    placeSpecial('minecraft:decorated_pot', { facing: 'south' }, { id: 'minecraft:decorated_pot', sherds: ['minecraft:angler_pottery_sherd', 'minecraft:archer_pottery_sherd', 'minecraft:brick', 'minecraft:heart_pottery_sherd'] });
    // double chest and a full bed
    const [cx, cz] = placeSpecial('minecraft:chest', { facing: 'south', type: 'left' });
    this.blocks.set((cx + 1) + ',' + Y + ',' + cz, { name: 'minecraft:chest', states: { facing: 'south', type: 'right' } });
    const [bx, bz] = placeSpecial('minecraft:red_bed', { facing: 'south', part: 'head' });
    this.blocks.set(bx + ',' + Y + ',' + (bz - 1), { name: 'minecraft:red_bed', states: { facing: 'south', part: 'foot' } });
    // a wall for a painting and an item frame
    const [wx, wz] = placeSpecial('minecraft:stone_bricks', {});
    for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy <= 1; dy++) this.blocks.set((wx + dx) + ',' + (Y + dy) + ',' + wz, { name: 'minecraft:stone_bricks', states: {} });
    this.entities.push({ id: 'minecraft:painting', Pos: [wx + 0.5, Y + 1, wz + 1 + 1 / 32], variant: 'minecraft:kebab', facing: 0 });
    this.entities.push({ id: 'minecraft:item_frame', Pos: [wx - 0.5, Y + 0.5, wz + 1 + 1 / 32], facing: 3, Item: { id: 'minecraft:diamond_sword', count: 1 } });
    this.entities.push({ id: 'minecraft:item_frame', Pos: [wx + 1.5, Y + 0.5, wz + 1 + 1 / 32], facing: 3, Item: { id: 'minecraft:stone', count: 1 } });
  }

  getSubChunk(cx, cz, dim, sy) {
    if (dim) return null;
    const palette = [{ name: 'minecraft:air', states: {} }], index = new Map([['minecraft:air|{}', 0]]);
    let indices = null;
    for (const [k, b] of this.blocks) {
      const [x, y, z] = k.split(',').map(Number);
      if (x >> 4 !== cx || z >> 4 !== cz || y >> 4 !== sy) continue;
      const key = b.name + '|' + JSON.stringify(b.states);
      let id = index.get(key);
      if (id === undefined) { id = palette.length; palette.push(b); index.set(key, id); }
      if (!indices) indices = new Uint16Array(4096);
      indices[((x & 15) << 8) | ((z & 15) << 4) | (y & 15)] = id;
    }
    return indices ? { layers: [{ palette, indices }] } : null;
  }

  getColumnData(cx, cz) {
    const heights = new Int16Array(256).fill(Y + 2 - this.minY());
    const secs = [];
    for (let i = 0; i < 24; i++) secs.push({ palette: [0], indices: ZERO });
    return { heights, biomeSections: secs, biomes2d: null };
  }

  getBlockEntities(cx, cz) {
    const out = new Map();
    for (const [k, be] of this.bes) if ((be.x >> 4) === cx && (be.z >> 4) === cz) out.set(k, be);
    return out;
  }
  getEntities(cx, cz) { return this.entities.filter((e) => (Math.floor(e.Pos[0]) >> 4) === cx && (Math.floor(e.Pos[2]) >> 4) === cz); }
  biomeIds() { return new Set([0]); }
  structureStarts() { return []; }

  scan() {
    const keys = new Set();
    for (const k of this.blocks.keys()) { const [x, , z] = k.split(',').map(Number); keys.add((x >> 4) + ',' + (z >> 4)); }
    const list = [...keys].map((k) => k.split(',').map(Number));
    const chunks = new Int32Array(list.length * 4);
    list.forEach(([x, z], i) => chunks.set([x, z, 4, 4], i * 4));
    const xs = list.map((c) => c[0]), zs = list.map((c) => c[1]);
    const bounds = list.length ? { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) } : null;
    return { dims: [{ count: list.length, chunks, bounds }, { count: 0, chunks: new Int32Array(0), bounds: null }, { count: 0, chunks: new Int32Array(0), bounds: null }], player: null, spawn: [0, Y, 0] };
  }
  close() {}
}

// A plausible state for a block: its first variant, or for multipart blocks the parts that apply
// without any connections.
function defaultStates(bs) {
  const st = {};
  if (!bs) return st;
  if (bs.variants) {
    const key = Object.keys(bs.variants)[0] || '';
    for (const kv of key.split(',')) { const i = kv.indexOf('='); if (i > 0) st[kv.slice(0, i)] = kv.slice(i + 1); }
    return st;
  }
  const props = new Map();
  const walk = (w) => {
    if (!w) return;
    if (w.OR) return w.OR.forEach(walk);
    if (w.AND) return w.AND.forEach(walk);
    for (const k of Object.keys(w)) { const vals = String(w[k]).replace(/^!/, '').split('|'); if (!props.has(k)) props.set(k, new Set()); for (const v of vals) props.get(k).add(v); }
  };
  for (const p of bs.multipart || []) walk(p.when);
  for (const [k, vals] of props) st[k] = vals.has('false') ? 'false' : vals.has('none') ? 'none' : [...vals][0];
  return st;
}

module.exports = { JavaGalleryWorld, defaultStates };
