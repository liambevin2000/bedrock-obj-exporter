'use strict';
// Sanity-checks an exported OBJ: node tools/check-obj.js path/to/file.obj
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split('\n');
let v = 0, vt = 0, vn = 0, f = 0, bad = 0;
const used = new Set();
for (const l of lines) {
  if (l.startsWith('v ')) v++;
  else if (l.startsWith('vt ')) vt++;
  else if (l.startsWith('vn ')) vn++;
  else if (l.startsWith('usemtl ')) used.add(l.slice(7).trim());
  else if (l.startsWith('f ')) {
    f++;
    for (const c of l.slice(2).trim().split(' ')) {
      const [a, b, n] = c.split('/').map(Number);
      if (!(a >= 1 && a <= v && b >= 1 && b <= vt && n >= 1 && n <= vn)) bad++;
    }
  }
}
const mtl = fs.readFileSync(file.replace(/\.obj$/i, '.mtl'), 'utf8');
const defined = new Set([...mtl.matchAll(/newmtl (.+)/g)].map((m) => m[1].trim()));
const missingTextures = [...mtl.matchAll(/map_Kd (.+)/g)].filter((m) => !fs.existsSync(path.join(path.dirname(file), m[1].trim()))).length;
const result = { vertices: v, uvs: vt, normals: vn, faces: f, badIndices: bad, materials: used.size, undefinedMaterials: [...used].filter((m) => !defined.has(m)).length, missingTextures };
console.log(JSON.stringify(result));
process.exit(bad || result.undefinedMaterials || missingTextures ? 1 : 0);
