'use strict';
// Prepares a release from changelog.json (newest entry first):
//  - sets the version in package.json
//  - writes CHANGELOG.md
//  - writes release.json: the version, its notes and every file of the app with its SHA-256
// Then commit and push; every installed copy downloads the update the next time it starts
// and offers "Restart to update".
// Usage: node release.js
//
// What an update can change: src/, c4d-plugin/ and changelog.json. Libraries (node_modules) and
// Electron itself come from the installer; if a change needs a new library, raise "minShell" in
// package.json to the new version and send out a new installer (npm run dist). Older installs
// are then told to get it instead of applying an update they cannot run.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const changelog = JSON.parse(fs.readFileSync(path.join(root, 'changelog.json'), 'utf8'));

// ---- check the changelog
if (!Array.isArray(changelog) || !changelog.length) throw new Error('changelog.json must be a non-empty array, newest first');
const semver = /^\d+\.\d+\.\d+$/;
changelog.forEach((e, i) => {
  if (!semver.test(e.version || '')) throw new Error(`changelog.json entry ${i}: version "${e.version}" should look like 1.2.3`);
  if (!Array.isArray(e.changes) || !e.changes.length) throw new Error(`changelog.json ${e.version}: add at least one line to "changes"`);
});
const newer = (a, b) => {
  const [pa, pb] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
};
for (let i = 1; i < changelog.length; i++) {
  if (!newer(changelog[i - 1].version, changelog[i].version)) throw new Error(`changelog.json: ${changelog[i - 1].version} should be newer than the entry below it (${changelog[i].version})`);
}
const version = changelog[0].version;

// ---- package.json: version
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.version = version;
if (!pkg.minShell) pkg.minShell = version;
if (newer(pkg.minShell, version)) throw new Error(`package.json minShell (${pkg.minShell}) is newer than the release (${version})`);
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

// ---- CHANGELOG.md
fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n' + changelog.map((e) => `## ${e.version}${e.date ? ' - ' + e.date : ''}\n\n${e.changes.map((c) => '- ' + c).join('\n')}\n`).join('\n'));

// ---- release.json: what an installed copy downloads
const files = [];
const walk = (rel) => {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel + '/' + ent.name;
    if (ent.isDirectory()) walk(p);
    else {
      const buf = fs.readFileSync(path.join(root, p));
      files.push({ path: p, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    }
  }
};
for (const dir of ['src', 'c4d-plugin']) walk(dir);
{
  const buf = fs.readFileSync(path.join(root, 'changelog.json'));
  files.push({ path: 'changelog.json', size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
}
const release = { version, minShell: pkg.minShell, date: changelog[0].date || null, notes: changelog[0].changes, download: (pkg.updates && pkg.updates.installer) || null, files };
fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(release, null, 2) + '\n');

console.log(`Release ${version}: ${files.length} files, ${(files.reduce((n, f) => n + f.size, 0) / 1024).toFixed(0)} KB. Needs installer ${pkg.minShell} or newer.`);
console.log('Now commit and push. Installed copies update the next time they start.');
