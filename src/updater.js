'use strict';
// Keeps the app current the way Pose Studio does: the newest code lives in a public GitHub repo,
// and a release is just a push. On start the app reads release.json from the repo; if it names a
// newer version, the listed files are downloaded, checked against their SHA-256, and used from the
// next start on (boot.js picks them up). Libraries and Electron itself are not updated this way -
// release.json says which installer it needs, and an older install is told to get the new one.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// Reads a URL into a Buffer. https for the real thing; file: so the flow can be tested offline.
function fetchBuffer(url, redirects = 0) {
  if (url.startsWith('file:')) return fs.promises.readFile(new URL(url));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'bedrock-obj-exporter', 'Cache-Control': 'no-cache' }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) { res.resume(); resolve(fetchBuffer(new URL(res.headers.location, url).href, redirects + 1)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${res.statusCode} for ${url}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

// info: { baseUrl, userData, running (version in use), shell (installed version) }
// Returns { status: 'current' | 'ready' | 'needs-installer' | 'off' | 'error', version?, notes?, error? }.
async function checkForUpdate(info) {
  if (!info.baseUrl) return { status: 'off' };
  const base = info.baseUrl.endsWith('/') ? info.baseUrl : info.baseUrl + '/';
  let rel;
  try { rel = JSON.parse((await fetchBuffer(base + 'release.json?t=' + Date.now())).toString('utf8')); } catch (e) { return { status: 'error', error: e.message }; }
  if (!rel || !rel.version || !Array.isArray(rel.files)) return { status: 'error', error: 'release.json is not valid' };
  if (!newer(rel.version, info.running)) return { status: 'current', version: info.running };
  // an update that needs newer libraries than this install has cannot be applied in place
  if (rel.minShell && newer(rel.minShell, info.shell)) return { status: 'needs-installer', version: rel.version, notes: rel.notes, download: rel.download };

  const dir = path.join(info.userData, 'updates');
  const final = path.join(dir, rel.version), tmp = final + '.download';
  if (fs.existsSync(path.join(final, 'release.json'))) return { status: 'ready', version: rel.version, notes: rel.notes };
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of rel.files) {
      if (path.isAbsolute(f.path) || f.path.split(/[\\/]/).includes('..')) throw new Error('unsafe path in release.json: ' + f.path);
      const buf = await fetchBuffer(base + f.path.split('/').map(encodeURIComponent).join('/'));
      if (crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) throw new Error('checksum mismatch for ' + f.path);
      const dest = path.join(tmp, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    fs.writeFileSync(path.join(tmp, 'release.json'), JSON.stringify(rel));
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { status: 'error', error: e.message };
  }
  // older downloaded versions are no longer needed
  try { for (const n of fs.readdirSync(dir)) if (n !== rel.version && n !== path.basename(info.root || '')) fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch (e) { /* tidy-up only */ }
  return { status: 'ready', version: rel.version, notes: rel.notes };
}

module.exports = { checkForUpdate, newer };
