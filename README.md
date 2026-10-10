# Bedrock OBJ Exporter

Pick an area of a Minecraft Bedrock world on a top-down map, check it in 3D, export it as OBJ + MTL + textures.

## Run

Double-click `Bedrock OBJ Exporter.bat` (or `npm start`). First run needs `npm install`.

## Use

1. Pick a world on the left (or drop a world folder / `.mcworld` on the window).
2. Drag on the map to select. Drag the edges to adjust; Shift snaps to chunks. Right-drag pans, scroll zooms.
3. Bottom/Top Y are filled from the surface inside the selection. `Full height` takes everything.
4. `Preview in 3D` shows exactly the geometry that will be written.
5. `Export OBJ…` writes `name.obj`, `name.mtl` and a `name_textures` folder.

In the 3D preview:

- Drag the green arrows on the box to grow or shrink the selection; the model updates as you drag.
- `Lighting`: Simple, Minecraft (sky and block light as in game), Sun with shadows, Sun with soft shadows.
  `Light sources glow` makes torches, lanterns, lava and add-on blocks with light emission light their surroundings.
  Lighting is a preview only; the OBJ carries no lights.
- `Go into POV`: walk the selection in first person with Minecraft movement (WASD, Space jump, Ctrl sprint,
  F toggles flying, Esc leaves). The readout shows the camera position and angle.

Picking things out of the scene (3D preview):

- `Pick object`, then click a building or a tree. A tree is its trunk plus the leaves nearest that trunk; a
  structure is everything connected that is not terrain. Shift-click adds, Ctrl-click takes away.
- When a click grabs too much: `Ground at Y` leaves out that height and everything below (towns on paving
  are detected and cut automatically; edit the number or clear it to change that), and `Trim` puts arrows on
  the pick's box — drag them in to cut parts off, out to let it grow.
- `Show and export only this`: the preview and both exports contain just that object, centred on itself.
- `Move it`: drag an orange arrow to slide the object; it is cut from where it was and pasted at the new place,
  and exports include the move. Several moves can be stacked; `Undo` drops them. The world save is never changed.

`node tools/pick-test.js "<world>" x0 y0 z0 x1 y1 z1` lists what the picker finds in an area.

`Locate` (top bar) lists the biomes and places found in the saved chunks: villages, trial chambers, ancient
cities, spawners, and placed things such as signs, beds, banners and chests. Pick one to highlight it on the
map and jump there; ◀ ▶ step through the places (structures nearest first, biome areas largest first).
Nothing is predicted from the seed, so unexplored parts of the world are not searched.
`node tools/locate-cli.js "<world>"` prints the same list.

`Simplify textures (flat colours)` in Options redraws every texture as a simpler version of itself
(`src/core/simplify.js`). It uses the merge rule from Essential Cosmetic Studio's promo textures (closest
colours merge first, redmean distance), but judged against each block texture's own contrast, so a texture
keeps three to six tones instead of collapsing to one: planks keep their boards, cobblestone its stones, ore
its flecks. Stray single pixels are smoothed away unless they contrast strongly. Large atlases (furniture)
use one gentler fixed distance. Animated textures share one set of tones across their frames.
`node tools/simplify-sheet.js out.png` writes a before/after sheet.

`Map top Y` hides everything above a height on the map (Nether roof, caves, interiors).

## Textures

The world's own resource packs are found automatically (world folder, then your global and development
pack folders), layered over vanilla textures read from the Minecraft install. `Add pack file…` /
`Add folder…` puts another pack (`.mcpack`, `.mcaddon`, `.zip` or folder) on top.

Biome tints (grass, leaves, water) are baked into the exported textures, including add-on biomes.

## What is exported

- Add-on blocks: geometry, material instances, permutations and transformations from the world's behavior pack.
- Vanilla: cubes, slabs, stairs (with inner and outer corners), fences, gates, walls, panes, doors, trapdoors,
  carpets, snow layers, torches, lanterns, ladders, vines, rails, crops, plants, liquids, waterlogging.
- Also built from boxes at their real proportions (`src/core/vanilla-extra.js`): signs, banners, heads, item
  frames, pots, redstone dust, levers, buttons, repeaters, portals, end rods, lightning rods, chains, bamboo,
  stonecutter, enchanting table, lectern, grindstone, anvil, hopper, cauldron, brewing stand, bell, shelves,
  conduit, dragon egg, campfires, candles, cake, sea pickles, turtle eggs, cocoa, dripstone, dripleaf,
  amethyst, petals and leaf litter.
- Hidden faces are removed. `Merge flat faces` joins same-texture faces into larger polygons (tiled UVs).

- Block entities are read too: sign text (in the game's font, front and back), banner colours and patterns,
  which head it is, bed colours, the plant in a flower pot, the item or block in an item frame.
- Scenery entities (`src/core/entities.js`): add-on furniture and vehicles (drawn the way the pack's client
  entity and render controllers say, including colour and model variants), paintings, armor stands, minecarts.
  Mobs (anything with AI), dropped items and boats are left out. `Include furniture and other entities` in
  Options turns this off.

Not carried over: armour and held items on armor stands, entity poses and animations, decorated pot sherds,
maps in frames, and block entities of objects you have moved. Marketplace packs are encrypted and cannot be
read. Anything skipped is listed after each preview/export.

The "gallery" is a built-in test scene with one of each of these shapes: `node tools/gallery-export.js out.obj`.

## Missing chunks

Chunks the game never saved show as gaps. When a selection contains some, a yellow box offers:

- `Fill gaps with an estimate (experimental)`: rebuilds each one from the saved chunks around it (blended
  ground height, the neighbours' ground layers, water level, and the same mix and density of grass, flowers
  and water plants). Trees and buildings are not invented.
- `Get them from the game…`: `/tickingarea` commands that make Minecraft generate and save the real chunks.
  Run them, Save & Quit, then `Reload world`.

`node tools/holes.js "<world>"` lists a world's gaps; `node tools/fill-stats.js "<world>" x0 y0 z0 x1 y1 z1`
compares plant density on saved and estimated chunks.

## Cinema 4D

`Export to Cinema 4D` writes the selection to `Documents/BedrockObjExporter/c4d-export` and installs
`c4d-plugin/BedrockWorldImporter.pyp` into every Cinema 4D preferences folder it finds (restart Cinema 4D
once after the first time). Then run **Extensions › Import Bedrock World** in Cinema 4D.

You get one Null named after the world with one polygon object per texture: real quads, UVs, unsmoothed
textures, alpha where the texture needs it, 1 block = 100 cm (the same scale as Essential Cosmetic Studio's
importer). Z is flipped for Cinema 4D's left-handed space so nothing is mirrored.

Animated textures (water, lava, fire, lanterns, sea lanterns, kelp, seagrass, magma...) are written as numbered
PNG sequences and set up as looping image sequences at the game's speed. OBJ export uses the first frame.

`python tools/c4d-plugin-check.py` checks the importer's logic against the latest export without Cinema 4D.

## Import notes

- 1 unit = 1 block (change with Scale). Y is up. The origin is the centre of the selection at its bottom.
- Set texture filtering to Closest/Nearest in your 3D app for the pixel look.

## Command line

```
node tools/export-cli.js "<world name or folder>" x0 y0 z0 x1 y1 z1 out.obj [--no-greedy] [--pack <dir>]
node tools/check-obj.js out.obj
```

## Sharing and updates

`npm run dist` builds `dist/Bedrock-OBJ-Exporter-Setup-<version>.exe` (about 80 MB, installs per user, no admin
rights). The installer is not code-signed, so Windows shows a SmartScreen prompt the first time
("More info" > "Run anyway").

Installed copies keep themselves current the way Pose Studio does. The app's own code (`src/`, `c4d-plugin/`)
is published in a public GitHub repo; on start the app reads `release.json` from it, downloads a newer
version if there is one (every file is checked against its SHA-256) and shows "Restart to update".
To release:

1. Add an entry at the top of `changelog.json` (1 to 3 short lines).
2. `npm run release` (sets the version, writes `CHANGELOG.md` and `release.json`).
3. Commit and push.

The repo address is `updates.url` in `package.json` (a raw.githubusercontent.com folder URL ending in `/main/`).
Updates cannot change libraries or Electron: if a change needs a new library, raise `minShell` in
`package.json` to that version, build a new installer and send it out; older installs are told to get it.
A downloaded update that fails to start is skipped and the installed version runs instead.

`tools/update-test.ps1` and `tools/packaged-test.ps1` check the update path without GitHub.

## Layout

- `src/core` — world reader (pure JS LevelDB), packs, textures, block models, mesher, OBJ writer. No Electron.
- `src/worker.js` — background threads for map tiles, preview and export.
- `src/main.js`, `src/ui` — the app.
