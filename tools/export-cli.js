'use strict';
// Headless export: node tools/export-cli.js "<world name or dir>" x0 y0 z0 x1 y1 z1 out.obj [--no-greedy] [--pack dir]
const path = require('path');
const { listWorlds } = require('../src/core/world');
const { Session } = require('../src/core/exporter');

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] === '--pack'));
const packIdx = args.indexOf('--pack');
if (pos.length < 8) { console.error('usage: export-cli <world> x0 y0 z0 x1 y1 z1 out.obj [--no-greedy] [--pack dir]'); process.exit(1); }
const w = listWorlds().find((x) => x.dir === pos[0] || x.name === pos[0]) || { dir: pos[0] };
const [x0, y0, z0, x1, y1, z1] = pos.slice(1, 7).map(Number);
let t = Date.now();
const s = new Session({ worldDir: w.dir, extraPacks: packIdx >= 0 ? [args[packIdx + 1]] : [] });
console.log('opened in', Date.now() - t, 'ms', JSON.stringify(s.packInfo().resourcePacks.map((p) => p.name)));
t = Date.now();
const r = s.exportObj({ dim: 0, x0, y0, z0, x1, y1, z1 }, path.resolve(pos[7]), { greedy: !flags.includes('--no-greedy') });
console.log('exported in', Date.now() - t, 'ms');
console.log(JSON.stringify(Object.assign({}, r, { unknown: r.unknown.length })));
for (const [n, why] of r.unknown.slice(0, 40)) console.log('  !', n, '-', why);
