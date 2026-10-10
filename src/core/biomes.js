'use strict';
// Vanilla biome numeric ids (stable across versions) and the climate used for grass/foliage colour maps.
// Add-on biomes come from the world's BiomeIdsTable and their client_biome files instead.

const NAMES = {
  0: 'ocean', 1: 'plains', 2: 'desert', 3: 'extreme_hills', 4: 'forest', 5: 'taiga', 6: 'swampland', 7: 'river',
  8: 'hell', 9: 'the_end', 10: 'legacy_frozen_ocean', 11: 'frozen_river', 12: 'ice_plains', 13: 'ice_mountains',
  14: 'mushroom_island', 15: 'mushroom_island_shore', 16: 'beach', 17: 'desert_hills', 18: 'forest_hills',
  19: 'taiga_hills', 20: 'extreme_hills_edge', 21: 'jungle', 22: 'jungle_hills', 23: 'jungle_edge',
  24: 'deep_ocean', 25: 'stone_beach', 26: 'cold_beach', 27: 'birch_forest', 28: 'birch_forest_hills',
  29: 'roofed_forest', 30: 'cold_taiga', 31: 'cold_taiga_hills', 32: 'mega_taiga', 33: 'mega_taiga_hills',
  34: 'extreme_hills_plus_trees', 35: 'savanna', 36: 'savanna_plateau', 37: 'mesa', 38: 'mesa_plateau_stone',
  39: 'mesa_plateau', 40: 'warm_ocean', 41: 'deep_warm_ocean', 42: 'lukewarm_ocean', 43: 'deep_lukewarm_ocean',
  44: 'cold_ocean', 45: 'deep_cold_ocean', 46: 'frozen_ocean', 47: 'deep_frozen_ocean', 48: 'bamboo_jungle',
  49: 'bamboo_jungle_hills', 129: 'sunflower_plains', 130: 'desert_mutated', 131: 'extreme_hills_mutated',
  132: 'flower_forest', 133: 'taiga_mutated', 134: 'swampland_mutated', 140: 'ice_plains_spikes',
  149: 'jungle_mutated', 151: 'jungle_edge_mutated', 155: 'birch_forest_mutated', 156: 'birch_forest_hills_mutated',
  157: 'roofed_forest_mutated', 158: 'cold_taiga_mutated', 160: 'redwood_taiga_mutated',
  161: 'redwood_taiga_hills_mutated', 162: 'extreme_hills_plus_trees_mutated', 163: 'savanna_mutated',
  164: 'savanna_plateau_mutated', 165: 'mesa_bryce', 166: 'mesa_plateau_stone_mutated', 167: 'mesa_plateau_mutated',
  178: 'soulsand_valley', 179: 'crimson_forest', 180: 'warped_forest', 181: 'basalt_deltas', 182: 'jagged_peaks',
  183: 'frozen_peaks', 184: 'snowy_slopes', 185: 'grove', 186: 'meadow', 187: 'lush_caves', 188: 'dripstone_caves',
  189: 'stony_peaks', 190: 'deep_dark', 191: 'mangrove_swamp', 192: 'cherry_grove', 193: 'pale_garden',
};

// [temperature, downfall]
const BIOME_CLIMATE = {
  plains: [0.8, 0.4], sunflower_plains: [0.8, 0.4], desert: [2, 0], desert_hills: [2, 0], desert_mutated: [2, 0],
  extreme_hills: [0.2, 0.3], extreme_hills_edge: [0.2, 0.3], extreme_hills_plus_trees: [0.2, 0.3],
  extreme_hills_mutated: [0.2, 0.3], extreme_hills_plus_trees_mutated: [0.2, 0.3],
  forest: [0.7, 0.8], forest_hills: [0.7, 0.8], flower_forest: [0.7, 0.8], taiga: [0.25, 0.8], taiga_hills: [0.25, 0.8],
  taiga_mutated: [0.25, 0.8], river: [0.5, 0.5], ocean: [0.5, 0.5], deep_ocean: [0.5, 0.5], warm_ocean: [0.5, 0.5],
  lukewarm_ocean: [0.5, 0.5], deep_lukewarm_ocean: [0.5, 0.5], cold_ocean: [0.5, 0.5], deep_cold_ocean: [0.5, 0.5],
  frozen_ocean: [0, 0.5], deep_frozen_ocean: [0, 0.5], legacy_frozen_ocean: [0, 0.5], frozen_river: [0, 0.5],
  ice_plains: [0, 0.5], ice_mountains: [0, 0.5], ice_plains_spikes: [0, 0.5], mushroom_island: [0.9, 1],
  mushroom_island_shore: [0.9, 1], beach: [0.8, 0.4], stone_beach: [0.2, 0.3], cold_beach: [0.05, 0.3],
  jungle: [0.95, 0.9], jungle_hills: [0.95, 0.9], jungle_edge: [0.95, 0.8], jungle_mutated: [0.95, 0.9],
  jungle_edge_mutated: [0.95, 0.8], bamboo_jungle: [0.95, 0.9], bamboo_jungle_hills: [0.95, 0.9],
  birch_forest: [0.6, 0.6], birch_forest_hills: [0.6, 0.6], birch_forest_mutated: [0.7, 0.8],
  birch_forest_hills_mutated: [0.7, 0.8], roofed_forest: [0.7, 0.8], roofed_forest_mutated: [0.7, 0.8],
  cold_taiga: [-0.5, 0.4], cold_taiga_hills: [-0.5, 0.4], cold_taiga_mutated: [-0.5, 0.4], mega_taiga: [0.3, 0.8],
  mega_taiga_hills: [0.3, 0.8], redwood_taiga_mutated: [0.25, 0.8], redwood_taiga_hills_mutated: [0.3, 0.8],
  savanna: [1.2, 0], savanna_plateau: [1, 0], savanna_mutated: [1.1, 0], savanna_plateau_mutated: [1, 0],
  jagged_peaks: [-0.7, 0.9], frozen_peaks: [-0.7, 0.9], snowy_slopes: [-0.3, 0.9], grove: [-0.2, 0.8],
  meadow: [0.3, 0.8], lush_caves: [0.9, 0], dripstone_caves: [0.2, 0], stony_peaks: [1, 0.3], deep_dark: [0.8, 0.4],
  cherry_grove: [0.3, 0.8], pale_garden: [0.7, 0.8], hell: [2, 0], the_end: [0.5, 0.5],
};

const VANILLA_BIOMES = Object.entries(NAMES).map(([id, n]) => [Number(id), 'minecraft:' + n]);

module.exports = { VANILLA_BIOMES, BIOME_CLIMATE };
