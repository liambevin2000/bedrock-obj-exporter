'use strict';
// A made-up world used for checking block shapes: one of each listed block on a stone floor, three
// blocks apart. Open it by using "gallery:" as the world folder (the self-test does this).
// It implements just the parts of World that the map, mesher and picker call.

const B = (name, states) => ({ name: 'minecraft:' + name, states: states || {} });

// [label row] entries are laid out left to right, a new row every COLS entries.
const ENTRIES = [
  B('standing_sign', { ground_sign_direction: 0 }), B('spruce_standing_sign', { ground_sign_direction: 3 }), B('wall_sign', { facing_direction: 3 }),
  B('oak_hanging_sign', { hanging: 1, attached_bit: 0, facing_direction: 3 }), B('standing_banner', { ground_sign_direction: 2 }), B('wall_banner', { facing_direction: 3 }),
  B('skull', { facing_direction: 1 }), B('skull', { facing_direction: 3 }), B('frame', { facing_direction: 1 }), B('glow_frame', { facing_direction: 3 }),
  B('decorated_pot'), B('flower_pot'),

  B('redstone_wire', { redstone_signal: 15 }), B('lever', { lever_direction: 'up_north_south' }), B('lever', { lever_direction: 'south' }), B('stone_button', { facing_direction: 1 }),
  B('wooden_button', { facing_direction: 3 }), B('unpowered_repeater', { direction: 0 }), B('powered_comparator', { direction: 0 }), B('daylight_detector'),
  B('end_portal'), B('portal', { portal_axis: 'x' }), B('end_rod', { facing_direction: 1 }), B('end_rod', { facing_direction: 5 }),

  B('lightning_rod', { facing_direction: 1 }), B('chain', { pillar_axis: 'y' }), B('chain', { pillar_axis: 'x' }), B('bamboo', { bamboo_stalk_thickness: 'thick' }),
  B('chorus_plant'), B('chorus_flower'), B('stonecutter_block', { 'minecraft:cardinal_direction': 'south' }), B('enchanting_table'),
  B('lectern', { 'minecraft:cardinal_direction': 'south' }), B('grindstone', { direction: 0 }), B('anvil', { 'minecraft:cardinal_direction': 'south' }), B('hopper', { facing_direction: 0 }),

  B('hopper', { facing_direction: 5 }), B('cauldron', { fill_level: 0 }), B('brewing_stand'), B('bell', { direction: 0 }),
  B('oak_shelf', { 'minecraft:cardinal_direction': 'south' }), B('conduit'), B('dragon_egg'), B('heavy_core'),
  B('dried_ghast', { 'minecraft:cardinal_direction': 'south' }), B('sniffer_egg'), B('campfire', { extinguished: 0 }), B('soul_campfire', { extinguished: 1 }),

  B('candle', { candles: 0, lit: 1 }), B('white_candle', { candles: 3, lit: 0 }), B('candle_cake', { lit: 1 }), B('cake', { bite_counter: 2 }),
  B('sea_pickle', { cluster_count: 3 }), B('turtle_egg', { turtle_egg_count: 'three_egg' }), B('cocoa', { age: 2, direction: 0 }), B('pointed_dripstone', { dripstone_thickness: 'tip', hanging: 0 }),
  B('pointed_dripstone', { dripstone_thickness: 'base', hanging: 1 }), B('big_dripleaf', { big_dripleaf_head: 1 }), B('small_dripleaf_block', { upper_block_bit: 1 }), B('spore_blossom'),

  B('amethyst_cluster', { 'minecraft:block_face': 'up' }), B('small_amethyst_bud', { 'minecraft:block_face': 'south' }), B('pink_petals'), B('wildflowers'),
  B('leaf_litter'), B('frog_spawn'), B('scaffolding'), B('trial_spawner'),
  B('vault'), B('creaking_heart'), B('resin_clump', { multi_face_direction_bits: 1 }), B('lantern', { hanging: 0 }),

  // the same blocks again, this time with block entities (see BLOCK_ENTITIES): text, colours, contents
  B('standing_sign', { ground_sign_direction: 0 }), B('wall_sign', { facing_direction: 3 }), B('oak_hanging_sign', { hanging: 1, attached_bit: 0, facing_direction: 3 }), B('standing_banner', { ground_sign_direction: 0 }),
  B('standing_banner', { ground_sign_direction: 0 }), B('wall_banner', { facing_direction: 3 }), B('skull', { facing_direction: 1 }), B('skull', { facing_direction: 1 }),
  B('skull', { facing_direction: 3 }), B('flower_pot'), B('frame', { facing_direction: 1 }), B('frame', { facing_direction: 3 }),

  B('bed', { direction: 0, head_piece_bit: 1 }), B('bed', { direction: 3, head_piece_bit: 0 }), B('creeper_head', { facing_direction: 1 }), B('piglin_head', { facing_direction: 1 }),
  B('zombie_head', { facing_direction: 1 }), B('cauldron', { fill_level: 6, cauldron_liquid: 'water' }), B('smooth_stone'), B('smooth_stone'),
  B('smooth_stone'), B('smooth_stone'), B('smooth_stone'), B('smooth_stone'),

  // shapes that already existed, kept here as a regression check
  B('oak_stairs', { weirdo_direction: 0 }), B('stone_slab', { 'minecraft:vertical_half': 'top' }), B('oak_fence', { 'minecraft:connection_east': 1 }), B('cobblestone_wall', { wall_post_bit: 1 }),
  B('glass_pane', { 'minecraft:connection_north': 1, 'minecraft:connection_south': 1 }), B('wooden_door', { direction: 0 }), B('trapdoor', { direction: 0 }), B('torch', { torch_facing_direction: 'top' }),
  B('ladder', { facing_direction: 3 }), B('chest', { 'minecraft:cardinal_direction': 'south' }), B('bed', { direction: 0 }), B('cactus'),
];

const COLS = 12, GAP = 3;

// Block entities for the "with block entities" rows, in order (they start on the seventh row).
const BE_ROW = 6;
const BLOCK_ENTITIES = [
  { id: 'Sign', FrontText: { Text: 'Bedrock OBJ\nExporter\nsign text\n<line four>', SignTextColor: -16777216 }, BackText: { Text: 'back side', SignTextColor: -65536 } },
  { id: 'Sign', FrontText: { Text: '\nWall sign\n', SignTextColor: -1 } },
  { id: 'HangingSign', FrontText: { Text: 'Shop\nopen', SignTextColor: -16777216 } },
  { id: 'Banner', Base: 1, Patterns: [{ Pattern: 'bo', Color: 15 }, { Pattern: 'cre', Color: 0 }] },
  { id: 'Banner', Base: 4, Patterns: [{ Pattern: 'gra', Color: 12 }, { Pattern: 'mc', Color: 11 }, { Pattern: 'bts', Color: 15 }] },
  { id: 'Banner', Base: 10, Patterns: [{ Pattern: 'cs', Color: 15 }, { Pattern: 'ms', Color: 15 }] },
  { id: 'Skull', SkullType: 3, Rotation: 0 }, { id: 'Skull', SkullType: 1, Rotation: 45 }, { id: 'Skull', SkullType: 2, Rotation: 0 },
  { id: 'FlowerPot', PlantBlock: { name: 'minecraft:poppy', states: {} } },
  { id: 'ItemFrame', Item: { Name: 'minecraft:diamond_sword', Count: 1 }, ItemRotation: 1 },
  { id: 'ItemFrame', Item: { Name: 'minecraft:diamond_block', Count: 1, Block: { name: 'minecraft:diamond_block', states: {} } }, ItemRotation: 0 },
  { id: 'Bed', color: 11 }, { id: 'Bed', color: 1 },
];

// Scenery entities, placed along the far edge (positions are filled in by the world).
const ENTITIES = [
  { identifier: 'minecraft:painting', Motif: 'Wither', Direction: 0, size: [2, 2] },
  { identifier: 'minecraft:painting', Motif: 'Fighters', Direction: 0, size: [4, 2] },
  { identifier: 'minecraft:painting', Motif: 'Backyard', Direction: 0, size: [3, 4] },
  { identifier: 'minecraft:armor_stand', Rotation: [0, 0] },
  { identifier: 'minecraft:armor_stand', Rotation: [90, 0] },
  { identifier: 'minecraft:minecart', Rotation: [0, 0] },
  { identifier: 'minecraft:boat', Rotation: [0, 0], Variant: 0 },
  { identifier: 'minecraft:zombie', Rotation: [0, 0] }, // a mob: must not be drawn
];

// Extra arrangement: a ring of stairs so every corner shape (inner and outer) appears.
// weirdo_direction: 0 east, 1 west, 2 south, 3 north (the side the tall half is on).
function stairRing(cells, ox, oz) {
  const put = (x, z, dir) => cells.set(`${ox + x},1,${oz + z}`, B('stone_brick_stairs', { weirdo_direction: dir, upside_down_bit: 0 }));
  // outer ring 4x4: tall halves facing inwards make a raised rim with four inner corners
  for (let i = 0; i < 4; i++) { put(i, 0, 2); put(i, 3, 3); }
  for (let i = 1; i < 3; i++) { put(0, i, 0); put(3, i, 1); }
  // a plus-shaped roof piece: tall halves facing outwards make four outer corners
  put(7, 1, 3); put(8, 1, 3); put(7, 2, 2); put(8, 2, 2);
  put(6, 1, 1); put(6, 2, 1); put(9, 1, 0); put(9, 2, 0);
}

class GalleryWorld {
  constructor() {
    this.dir = 'gallery:';
    this.cells = new Map(); // "x,y,z" -> palette entry
    this.bes = new Map();   // "x,y,z" -> block entity
    this.entities = [];
    const rows = Math.ceil(ENTRIES.length / COLS);
    this.size = [COLS * GAP + 2, rows * GAP + 2 + 8];
    for (let x = 0; x < this.size[0]; x++) for (let z = 0; z < this.size[1]; z++) this.cells.set(`${x},0,${z}`, B('smooth_stone'));
    ENTRIES.forEach((e, i) => {
      const x = 2 + (i % COLS) * GAP, z = 2 + Math.floor(i / COLS) * GAP;
      // things that hang or sit on a wall get the block they attach to
      const hangs = (e.states.hanging && !/lantern/.test(e.name)) || e.name === 'minecraft:spore_blossom';
      const y = hangs ? 2 : 1;
      this.cells.set(`${x},${y},${z}`, e);
      if (hangs) this.cells.set(`${x},3,${z}`, B('smooth_stone'));
      const be = BLOCK_ENTITIES[i - BE_ROW * COLS];
      if (be) this.bes.set(`${x},${y},${z}`, Object.assign({ x, y, z }, be));
    });
    // a wall along the north edge for paintings, and the other entities standing in front of it
    let ex = 3;
    for (const e of ENTITIES) {
      const painting = e.identifier === 'minecraft:painting';
      const w = painting ? e.size[0] : 1;
      const pos = painting ? [ex + w / 2, 1 + e.size[1] / 2 + 0.5, 0 + 1 + 1 / 32] : [ex + 0.5, 1, 1.5];
      if (painting) for (let x = ex; x < ex + w; x++) for (let y = 1; y <= e.size[1] + 1; y++) this.cells.set(`${x},${y},0`, B('smooth_stone'));
      this.entities.push(Object.assign({}, e, { Pos: pos }));
      ex += w + 2;
    }
    stairRing(this.cells, 2, rows * GAP + 3);
    const self = this;
    this.db = {
      tables: [],
      get() { return null; },
      scanKeys(fn) {
        for (let cx = 0; cx <= (self.size[0] - 1) >> 4; cx++) for (let cz = 0; cz <= (self.size[1] - 1) >> 4; cz++) {
          const k = Buffer.alloc(10); k.writeInt32LE(cx, 0); k.writeInt32LE(cz, 4); k[8] = 0x2f; k.writeInt8(0, 9);
          fn(k);
        }
      },
      close() {},
    };
  }

  getSubChunk(cx, cz, dim, sy) {
    if (dim !== 0 || sy !== 0 || cx < 0 || cz < 0) return null;
    const indices = new Uint16Array(4096), palette = [{ name: 'minecraft:air', states: {} }], index = new Map();
    let any = false;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) {
      const e = this.cells.get(`${cx * 16 + x},${y},${cz * 16 + z}`);
      if (!e) continue;
      let p = index.get(e);
      if (p === undefined) { p = palette.length; palette.push(e); index.set(e, p); }
      indices[(x << 8) | (z << 4) | y] = p;
      any = true;
    }
    return any ? { layers: [{ indices, palette }] } : null;
  }

  getColumnData(cx, cz, dim) {
    if (dim !== 0 || cx < 0 || cz < 0 || cx > (this.size[0] - 1) >> 4 || cz > (this.size[1] - 1) >> 4) return null;
    return { heights: new Int16Array(256).fill(4), biomeSections: null, biomes2d: new Uint8Array(256).fill(1) };
  }

  getBlockEntities(cx, cz) {
    const out = new Map();
    for (const [k, v] of this.bes) if ((v.x >> 4) === cx && (v.z >> 4) === cz) out.set(k, v);
    return out;
  }

  getEntities(cx, cz) { return this.entities.filter((e) => (Math.floor(e.Pos[0]) >> 4) === cx && (Math.floor(e.Pos[2]) >> 4) === cz); }

  close() {}
}

module.exports = { GalleryWorld, ENTRIES };
