'use strict';
// Checks the published update the way an installed copy would: reads release.json from the repo
// named in package.json, downloads every file into a throwaway folder and verifies its checksum.
//   node tools/update-live-check.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkForUpdate } = require('../src/updater');

const pkg = require('../package.json');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'boe-live-'));
checkForUpdate({ baseUrl: pkg.updates.url, userData, running: '0.0.1', shell: pkg.version }).then((r) => {
  console.log('from', pkg.updates.url);
  console.log(JSON.stringify(r));
  if (r.status === 'ready') {
    const dir = path.join(userData, 'updates', r.version);
    const rel = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8'));
    console.log(`downloaded and verified ${rel.files.length} files for version ${rel.version}; local release.json is ${pkg.version}`);
  }
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(r.status === 'ready' ? 0 : 1);
});
