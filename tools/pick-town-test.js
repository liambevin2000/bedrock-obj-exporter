'use strict';
// Checks the picker on a made-up town: two buildings standing on one sheet of built paving.
// A click on one building must return that building only, and the ground level and trim box
// must reshape the pick.   node tools/pick-town-test.js
const O = require('../src/core/objects');

const sx = 40, sy = 16, sz = 30;
const ids = new Uint16Array(sx * sy * sz);
const at = (x, y, z) => (z * sy + y) * sx + x;
const PAVING = 1, WALL = 2;
for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) { ids[at(x, 0, z)] = PAVING; ids[at(x, 1, z)] = PAVING; }
const building = (x0, x1, z0, z1, h) => { for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = 2; y < 2 + h; y++) ids[at(x, y, z)] = WALL; };
building(4, 12, 5, 14, 8);    // A: 9 x 10 x 8 = 720
building(22, 33, 8, 20, 10);  // B: 12 x 13 x 10 = 1560
const solid = (name) => ({ name, full: true, opaque: true, boxes: [[0, 0, 0, 1, 1, 1]] });
const models = { list: [{ name: 'minecraft:air', empty: true }, solid('minecraft:gray_concrete'), solid('minecraft:smooth_quartz')] };
const grid = { ids, dims: [sx, sy, sz], min: [100, 60, 200], classes: null };

let failed = 0;
const check = (label, got, want) => { const ok = got === want; if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + label + ': ' + got + (ok ? '' : ' (expected ' + want + ')')); };

const cell = O.castRay(grid, models, [100 + 8.5, 100, 200 + 9.5], [0, -1, 0]);
check('ray lands on roof of A at layer', cell && cell[1], 9);
const a = O.findObject(grid, models, cell);
check('auto pick of A, blocks', a.x.length, 720);
check('auto pick reports ground at world Y', a.cut, 61);

const everything = O.findObject(grid, models, cell, { minY: 0 });
check('ground cut removed -> everything connected', everything.x.length, 720 + 1560 + sx * sz * 2);

const raised = O.findObject(grid, models, cell, { minY: 5 });
check('ground raised to layer 4 -> upper part of A only', raised.x.length, 9 * 10 * 5);

// the app keeps the ground level found by the first pick when the trim box changes
const trimmed = O.findObject(grid, models, cell, { minY: 2, limit: [4, 0, 5, 8, sy - 1, 14] });
check('trim box over half of A, ground kept', trimmed.x.length, 5 * 10 * 8);

const street = O.findObject(grid, models, [0, 1, 0]);
check('clicking the paving itself picks the connected sheet and all on it', street.x.length, 720 + 1560 + sx * sz * 2);

process.exit(failed ? 1 : 0);
