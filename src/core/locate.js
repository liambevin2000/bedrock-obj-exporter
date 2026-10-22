'use strict';
// "Locate" for saved worlds: which biomes are where, and the structures the save itself records.
// Only chunks the game has saved can be searched - nothing is predicted from the seed.
const { readNbt } = require('./nbt');

const SPAWN_AREA = { 1: 'Nether fortress', 2: 'Swamp hut', 3: 'Ocean monument', 5: 'Pillager outpost' };

// Java block entity ids for the same kinds of place.
const JAVA_POINTS = {
  'minecraft:mob_spawner': 'MobSpawner', 'minecraft:trial_spawner': 'TrialSpawner', 'minecraft:vault': 'Vault',
  'minecraft:sculk_shrieker': 'SculkShrieker', 'minecraft:end_portal': 'EndPortal', 'minecraft:end_gateway': 'EndGateway',
  'minecraft:beacon': 'Beacon', 'minecraft:conduit': 'Conduit', 'minecraft:brushable_block': 'BrushableBlock', 'minecraft:bell': 'Bell',
  'minecraft:jukebox': 'Jukebox', 'minecraft:command_block': 'CommandBlock', 'minecraft:structure_block': 'StructureBlock',
  'minecraft:chest': 'Chest', 'minecraft:trapped_chest': 'Chest', 'minecraft:barrel': 'Barrel', 'minecraft:sign': 'Sign',
  'minecraft:hanging_sign': 'HangingSign', 'minecraft:banner': 'Banner', 'minecraft:bed': 'Bed', 'minecraft:decorated_pot': 'DecoratedPot',
  'minecraft:skull': 'Skull',
};
// Java structure ids -> names people use.
const javaStructure = (id) => {
  const s = String(id).replace(/^minecraft:/, '');
  const names = { village_plains: 'Village (plains)', village_desert: 'Village (desert)', village_savanna: 'Village (savanna)', village_snowy: 'Village (snowy)',
    village_taiga: 'Village (taiga)', mansion: 'Woodland mansion', monument: 'Ocean monument', fortress: 'Nether fortress', bastion_remnant: 'Bastion remnant',
    stronghold: 'Stronghold', mineshaft: 'Mineshaft', mineshaft_mesa: 'Mineshaft (badlands)', desert_pyramid: 'Desert pyramid', jungle_pyramid: 'Jungle temple',
    swamp_hut: 'Swamp hut', igloo: 'Igloo', pillager_outpost: 'Pillager outpost', ancient_city: 'Ancient city', trial_chambers: 'Trial chambers',
    trail_ruins: 'Trail ruins', end_city: 'End city', buried_treasure: 'Buried treasure', ruined_portal: 'Ruined portal', shipwreck: 'Shipwreck',
    shipwreck_beached: 'Shipwreck (beached)', ocean_ruin_cold: 'Ocean ruin (cold)', ocean_ruin_warm: 'Ocean ruin (warm)', nether_fossil: 'Nether fossil' };
  return names[s] || (/^ruined_portal/.test(s) ? 'Ruined portal' : title(s));
};

// Block entities that mark a place worth finding. Each becomes a list of areas.
const POINTS = {
  MobSpawner: 'Monster spawner', TrialSpawner: 'Trial chamber (trial spawner)', Vault: 'Trial chamber (vault)',
  SculkShrieker: 'Ancient city (sculk shrieker)', EndPortal: 'End portal', EndGateway: 'End gateway', Beacon: 'Beacon',
  Conduit: 'Conduit', BrushableBlock: 'Archaeology site (suspicious blocks)', Bell: 'Bell', Lodestone: 'Lodestone',
  Jukebox: 'Jukebox', CommandBlock: 'Command block', StructureBlock: 'Structure block', Chest: 'Chest', Barrel: 'Barrel',
  Sign: 'Sign', HangingSign: 'Hanging sign', Banner: 'Banner', Bed: 'Bed', DecoratedPot: 'Decorated pot', Skull: 'Head',
};

const title = (s) => s.replace(/^minecraft:/, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

// chunks: Int32Array of [cx, cz, minSy, maxSy] per chunk (from scanChunks). step(done, total) may
// be awaited to keep the thread responsive. Returns { biomes, structures }.
async function locate(session, dim, chunks, step) {
  const world = session.world, res = session.res;
  const n = chunks.length / 4;
  const biomes = new Map();   // id -> [cx, cz, cx, cz, ...]
  const points = new Map();   // label -> [x, y, z, ...]
  const structures = [];      // { kind, x, y, z, box }
  const add = (label, x, y, z) => { let a = points.get(label); if (!a) points.set(label, a = []); a.push(x, y, z); };

  for (let i = 0; i < n; i++) {
    const cx = chunks[i * 4], cz = chunks[i * 4 + 1];
    for (const id of world.biomeIds(cx, cz, dim)) { let a = biomes.get(id); if (!a) biomes.set(id, a = []); a.push(cx, cz); }
    if (world.hardcodedSpawners) {
      for (const s of world.hardcodedSpawners(cx, cz, dim)) {
        const kind = SPAWN_AREA[s.type];
        if (kind) structures.push({ kind, x: (s.x0 + s.x1) >> 1, y: (s.y0 + s.y1) >> 1, z: (s.z0 + s.z1) >> 1 });
      }
    }
    if (world.structureStarts) for (const s of world.structureStarts(cx, cz, dim)) structures.push({ kind: javaStructure(s.kind), x: s.x, y: s.y, z: s.z });
    for (const be of world.getBlockEntities(cx, cz, dim).values()) {
      const label = POINTS[be.id] || POINTS[JAVA_POINTS[be.id]];
      if (label) add(label, be.x, be.y, be.z);
    }
    if (step && (i & 1023) === 1023) await step(i + 1, n);
  }

  // villages keep their own records
  const dimName = ['Overworld', 'Nether', 'TheEnd'][dim];
  for (const key of (world.db && world.db.villageKeys) || []) {
    const named = /^VILLAGE_(Overworld|Nether|TheEnd)_/.exec(key);
    if (named ? named[1] !== dimName : dim !== 0) continue;
    try {
      const v = world.db.get(Buffer.from(key, 'latin1'));
      const t = v && readNbt(v, { p: 0 });
      if (t && typeof t.X0 === 'number') structures.push({ kind: 'Village', x: (t.X0 + t.X1) >> 1, y: (t.Y0 + t.Y1) >> 1, z: (t.Z0 + t.Z1) >> 1 });
    } catch (e) { /* unreadable village record */ }
  }

  // The same structure is recorded once per chunk it touches: merge records that are close together.
  const merged = new Map();
  const mergeInto = (kind, x, y, z, cell) => {
    const k = kind + '|' + Math.floor(x / cell) + ',' + Math.floor(z / cell);
    const m = merged.get(k);
    if (m) { m.sx += x; m.sy += y; m.sz += z; m.count++; } else merged.set(k, { kind, sx: x, sy: y, sz: z, count: 1 });
  };
  for (const s of structures) mergeInto(s.kind, s.x, s.y, s.z, 96);
  for (const [label, a] of points) for (let i = 0; i < a.length; i += 3) mergeInto(label, a[i], a[i + 1], a[i + 2], 48);
  const byKind = new Map();
  for (const m of merged.values()) {
    let list = byKind.get(m.kind);
    if (!list) byKind.set(m.kind, list = []);
    list.push({ x: Math.round(m.sx / m.count), y: Math.round(m.sy / m.count), z: Math.round(m.sz / m.count), count: m.count });
  }

  return {
    biomes: [...biomes.entries()].map(([id, a]) => ({ id, name: title(res.biomeName(id) || 'biome ' + id), chunks: Int32Array.from(a) }))
      .sort((p, q) => q.chunks.length - p.chunks.length),
    structures: [...byKind.entries()].map(([kind, places]) => ({ kind, places })).sort((p, q) => p.kind.localeCompare(q.kind)),
  };
}

module.exports = { locate };
