import { Preview } from './preview.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const TILE = 128; // blocks per map tile (8 chunks)
const DIM_RANGE = [[-64, 319], [0, 127], [0, 255]];
// Build height per dimension of the open world (Java worlds from before 1.18 start at 0).
const dimRange = (d) => (state.dimRange || DIM_RANGE)[d];
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* no storage */ } } };

const state = {
  worlds: [], javaWorlds: null, edition: store.get('edition') === 'java' ? 'java' : 'bedrock', dimRange: null,
  world: null, dim: 0, ceiling: null,
  view: { x: 0, z: 0, scale: 2 },       // world coords at canvas centre, pixels per block
  sel: null,                             // { x0, z0, x1, z1, y0, y1 } inclusive blocks
  index: null,                           // per-dimension chunk index from the scan
  tiles: new Map(), inflight: 0, epoch: 0,
  extraPacks: [], packs: null,
  busy: false, mode: 'map', previewKey: null,
  edits: [], obj: null, isolate: false, editVersion: 0,
};

const canvas = $('map');
const ctx = canvas.getContext('2d');
let preview = null;

// ---- worlds -----------------------------------------------------------------------------------

function fmtSize(b) { return b > 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : (b / (1 << 20)).toFixed(b < 10 << 20 ? 1 : 0) + ' MB'; }
function fmtDate(ms) { return ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
function fileUrl(p) { return 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/%3A/g, ':'); }

const worldList = () => (state.edition === 'java' ? state.javaWorlds || [] : state.worlds);

function renderWorlds() {
  const q = $('worldSearch').value.trim().toLowerCase();
  const list = $('worldList');
  list.textContent = '';
  for (const w of worldList()) {
    if (q && !(w.name + ' ' + (w.instance || '')).toLowerCase().includes(q)) continue;
    const el = document.createElement('div');
    el.className = 'world' + (state.world && state.world.dir === w.dir ? ' on' : '');
    const icon = w.icon ? Object.assign(document.createElement('img'), { src: fileUrl(w.icon), loading: 'lazy' }) : Object.assign(document.createElement('div'), { className: 'noicon' });
    const text = document.createElement('div');
    text.innerHTML = '<div class="name"></div><div class="meta"></div>';
    text.children[0].textContent = w.name;
    text.children[1].textContent = `${fmtDate(w.modified)} · ${fmtSize(w.size)}` + (w.version ? ` · ${w.version}` : '');
    if (w.edition === 'java') {
      // many Java worlds are called "New World": say which launcher instance each comes from
      const sub = document.createElement('div');
      sub.className = 'meta sub';
      sub.textContent = w.instance || 'Minecraft Launcher';
      sub.title = w.dir;
      text.append(sub);
    }
    el.append(icon, text);
    el.onclick = () => openWorld(w);
    list.append(el);
  }
  if (!list.children.length) {
    const msg = state.edition === 'java'
      ? (state.javaWorlds ? 'No Java worlds found. Use Open folder… to pick a world folder.' : 'Looking for Java worlds…')
      : 'No worlds found.';
    list.innerHTML = `<div class="muted" style="padding:12px">${msg}</div>`;
  }
}

// Bedrock or Java: which worlds the list shows. Java worlds are looked up the first time.
async function setEdition(e) {
  state.edition = e === 'java' ? 'java' : 'bedrock';
  store.set('edition', state.edition);
  for (const b of $('editionSeg').children) b.classList.toggle('on', b.dataset.edition === state.edition);
  $('openWorldFile').hidden = state.edition === 'java';
  renderWorlds();
  if (state.edition === 'java' && !state.javaWorlds) {
    try { state.javaWorlds = await api.invoke('javaWorlds'); } catch (err) { state.javaWorlds = []; }
    renderWorlds();
  }
}
for (const b of $('editionSeg').children) b.onclick = () => setEdition(b.dataset.edition);

function setBusy(text) {
  state.busy = !!text;
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
  updateButtons();
}

async function openWorld(w, keepView) {
  if (state.busy) return;
  const edition = w.edition === 'java' || String(w.dir).startsWith('java-gallery:') ? 'java' : 'bedrock';
  const list = edition === 'java' ? (state.javaWorlds || (state.javaWorlds = [])) : state.worlds;
  if (!list.find((x) => x.dir === w.dir)) list.unshift(w);
  if (edition !== state.edition) setEdition(edition); // e.g. a Java world folder dropped while Bedrock is listed
  if (!keepView) { state.extraPacks = state.world && state.world.dir === w.dir ? state.extraPacks : []; }
  state.world = w; state.index = null; state.previewKey = null; state.voxelKey = null; state.reframe = true;
  previewSeq++;
  if (preview) preview.reset();
  clearEdits(); // picked blocks refer to this session's block table
  state.locateData = {}; state.loc = null; $('locateBar').hidden = true; $('locatePanel').hidden = true;
  resetTiles();
  if (!keepView) { state.sel = null; syncSelInputs(); }
  $('empty').hidden = true;
  $('worldTitle').textContent = w.name;
  renderWorlds();
  setBusy('Opening world…');
  setStatus('');
  try {
    const info = await api.invoke('open', { worldDir: w.dir, extraPacks: state.extraPacks });
    state.packs = info.packs;
    renderPacks();
    setBusy('Indexing chunks…');
    const scan = await api.invoke('scan');
    state.player = scan.player;
    state.openEdition = scan.edition || 'bedrock';
    // build height of each dimension: Bedrock's nether is 128 high, Java's 256; old Java worlds start at 0
    state.dimRange = state.openEdition === 'java'
      ? (scan.minY || [-64, 0, 0]).map((y, d) => [y, d === 0 && y < 0 ? 319 : 255])
      : DIM_RANGE;
    state.index = scan.dims.map((d) => {
      const tiles = new Set();
      let minSy = 127, maxSy = -128;
      for (let i = 0; i < d.chunks.length; i += 4) {
        tiles.add((d.chunks[i] >> 3) + ',' + (d.chunks[i + 1] >> 3));
        if (d.chunks[i + 2] < minSy) minSy = d.chunks[i + 2];
        if (d.chunks[i + 3] > maxSy) maxSy = d.chunks[i + 3];
      }
      const chunkSet = new Set();
      for (let i = 0; i < d.chunks.length; i += 4) chunkSet.add(d.chunks[i] + ',' + d.chunks[i + 1]);
      return { count: d.count, bounds: d.bounds, tiles, chunkSet, minY: minSy * 16, maxY: maxSy * 16 + 15, chunks: d.chunks };
    });
    if (!keepView) {
      if (!state.index[state.dim].count) setDim(state.index.findIndex((d) => d.count) >= 0 ? state.index.findIndex((d) => d.count) : 0, true);
      fitView();
    }
  } catch (e) {
    setStatus(`<span class="err">Could not open this world: ${escapeHtml(e.message)}</span>`);
  }
  setBusy(null);
  setMode('map');
  draw();
  refreshLoader().catch(() => { $('loaderInfo').hidden = true; });
}

// Worlds are often several far-apart islands of chunks. Frame the one the player is in,
// or the densest one, rather than the empty middle of everything.
function mainCluster(idx) {
  const c = idx.chunks, R = 48;
  let sx, sz;
  const p = state.player;
  if (p && p.dim === state.dim && idx.tiles.has((Math.floor(p.x / 16) >> 3) + ',' + (Math.floor(p.z / 16) >> 3))) { sx = Math.floor(p.x / 16); sz = Math.floor(p.z / 16); }
  else {
    const cells = new Map();
    for (let i = 0; i < c.length; i += 4) { const k = (c[i] >> 5) + ',' + (c[i + 1] >> 5); cells.set(k, (cells.get(k) || 0) + 1); }
    let best = null, bestN = -1;
    for (const [k, n] of cells) {
      const [x, z] = k.split(',').map(Number);
      let sum = n;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx || dz) sum += cells.get((x + dx) + ',' + (z + dz)) || 0;
      if (sum > bestN) { bestN = sum; best = [x, z]; }
    }
    sx = best[0] * 32 + 16; sz = best[1] * 32 + 16;
  }
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < c.length; i += 4) {
    if (Math.abs(c[i] - sx) > R || Math.abs(c[i + 1] - sz) > R) continue;
    if (c[i] < b.minX) b.minX = c[i]; if (c[i] > b.maxX) b.maxX = c[i];
    if (c[i + 1] < b.minZ) b.minZ = c[i + 1]; if (c[i + 1] > b.maxZ) b.maxZ = c[i + 1];
  }
  return b.minX === Infinity ? idx.bounds : b;
}

function fitView() {
  const idx = state.index && state.index[state.dim];
  if (!idx || !idx.bounds) { state.view = { x: 0, z: 0, scale: 2 }; return; }
  const all = idx.bounds;
  const b = (all.maxX - all.minX > 96 || all.maxZ - all.minZ > 96) ? mainCluster(idx) : all;
  const w = (b.maxX - b.minX + 1) * 16, h = (b.maxZ - b.minZ + 1) * 16;
  const r = canvas.getBoundingClientRect();
  state.view.x = (b.minX * 16 + (b.maxX + 1) * 16) / 2;
  state.view.z = (b.minZ * 16 + (b.maxZ + 1) * 16) / 2;
  state.view.scale = Math.max(0.125, Math.min(4, Math.min(r.width / w, r.height / h) * 0.9));
}

// ---- packs ------------------------------------------------------------------------------------

function renderPacks() {
  const el = $('packs');
  el.textContent = '';
  el.classList.remove('muted');
  const p = state.packs;
  if (!p) { el.textContent = 'Open a world to see its packs.'; el.classList.add('muted'); return; }
  const add = (tag, name, cls, onRemove, title) => {
    const d = document.createElement('div');
    d.className = 'pack' + (cls ? ' ' + cls : '');
    d.title = title || '';
    d.innerHTML = '<span class="tag"></span><span class="pname"></span>';
    d.children[0].textContent = tag; d.children[1].textContent = name;
    if (onRemove) { const b = document.createElement('button'); b.textContent = '✕'; b.title = 'Remove'; b.onclick = onRemove; d.append(b); }
    el.append(d);
  };
  // highest priority first, like the in-game list
  [...p.extraPacks].reverse().forEach((x) => add('added', x.name, '', () => { state.extraPacks = state.extraPacks.filter((d) => d !== x.dir); reopen(); }, x.dir));
  [...p.resourcePacks].reverse().forEach((x) => add('world', x.name, '', null, x.dir));
  if (p.edition === 'java') {
    if (p.mods) add('mods', `${p.mods} mod${p.mods === 1 ? '' : 's'} from this world's instance`, '', null, 'Blocks, textures and biome colours from the mods in the instance this world belongs to');
    if (p.vanilla) {
      const note = p.worldVersion && p.gameVersion !== p.worldVersion ? ` (world is ${p.worldVersion})` : '';
      add('base', `Minecraft ${p.gameVersion}${note}`, '', null, p.gameData);
    } else add('missing', 'Minecraft Java not found — play the world once with the official launcher, or add a resource pack', 'warn');
    return;
  }
  for (const id of p.missing) add('missing', id, 'warn', null, 'This pack is listed by the world but was not found on this PC (Marketplace packs are encrypted). Add it manually if you have the files.');
  if (p.vanilla) add('base', 'Vanilla (from your Minecraft install)', '', null, p.gameData);
  else add('missing', 'Vanilla textures not found — install Minecraft or add a vanilla pack', 'warn');
}

async function addPacks(dirs) {
  if (!dirs || !dirs.length) return;
  for (const d of dirs) if (!state.extraPacks.includes(d)) state.extraPacks.push(d);
  if (state.world) await reopen();
}
async function reopen() { if (state.world) await openWorld(state.world, true); }

// ---- map tiles --------------------------------------------------------------------------------

function resetTiles() {
  for (const t of state.tiles.values()) if (t && t.bitmap) t.bitmap.close();
  state.tiles.clear(); state.epoch++;
}
const tileKey = (tx, tz) => tx + ',' + tz;

function pumpTiles(wanted) {
  const max = 10;
  while (state.inflight < max && wanted.length) {
    const [tx, tz] = wanted.shift();
    const key = tileKey(tx, tz);
    if (state.tiles.has(key)) continue;
    state.tiles.set(key, { loading: true });
    state.inflight++;
    const epoch = state.epoch;
    api.invoke('tile', { dim: state.dim, tx, tz, ceiling: state.ceiling }).then(async (t) => {
      state.inflight--;
      if (epoch !== state.epoch) { draw(); return; }
      if (!t || t.empty) state.tiles.set(key, { empty: true });
      else {
        const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(t.rgba.buffer, t.rgba.byteOffset, t.rgba.length), TILE, TILE));
        if (epoch !== state.epoch) { bitmap.close(); return; }
        state.tiles.set(key, { bitmap, heights: t.heights });
      }
      draw();
    }).catch(() => { state.inflight--; if (epoch === state.epoch) state.tiles.set(key, { empty: true }); });
  }
}

// ---- drawing ----------------------------------------------------------------------------------

let drawQueued = false;
function draw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(drawNow); } }

function resize() {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
const toScreen = (x, z) => [(x - state.view.x) * state.view.scale + canvas.clientWidth / 2, (z - state.view.z) * state.view.scale + canvas.clientHeight / 2];
const toWorld = (sx, sy) => [(sx - canvas.clientWidth / 2) / state.view.scale + state.view.x, (sy - canvas.clientHeight / 2) / state.view.scale + state.view.z];

function drawNow() {
  drawQueued = false;
  if (state.mode !== 'map') return;
  resize();
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight, s = state.view.scale;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d0f12';
  ctx.fillRect(0, 0, W, H);
  const idx = state.index && state.index[state.dim];
  if (!idx) return;

  const [wx0, wz0] = toWorld(0, 0), [wx1, wz1] = toWorld(W, H);
  const tx0 = Math.floor(wx0 / TILE), tx1 = Math.floor(wx1 / TILE), tz0 = Math.floor(wz0 / TILE), tz1 = Math.floor(wz1 / TILE);
  ctx.imageSmoothingEnabled = s < 1;
  ctx.imageSmoothingQuality = 'high';
  const wanted = [];
  // zoomed far out: show where chunks exist without loading every tile
  const overview = s < 0.1;
  const ctxTile = Math.floor(state.view.x / TILE), cztTile = Math.floor(state.view.z / TILE);
  for (let tz = tz0; tz <= tz1; tz++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = tileKey(tx, tz);
      if (!idx.tiles.has(key)) continue;
      const t = state.tiles.get(key);
      const [sx, sy] = toScreen(tx * TILE, tz * TILE);
      const size = TILE * s;
      if (t && t.bitmap && size >= 3) ctx.drawImage(t.bitmap, Math.round(sx), Math.round(sy), Math.ceil(size), Math.ceil(size));
      else if (overview) { if (!t || !t.empty) { ctx.fillStyle = '#4b6a57'; ctx.fillRect(sx - (3 - Math.min(3, size)) / 2, sy - (3 - Math.min(3, size)) / 2, Math.max(3, size), Math.max(3, size)); } }
      else if (!t) { wanted.push([tx, tz]); ctx.fillStyle = '#14171c'; ctx.fillRect(sx, sy, size, size); }
      else if (t.loading) { ctx.fillStyle = '#14171c'; ctx.fillRect(sx, sy, size, size); }
    }
  }
  const p = state.player;
  if (p && p.dim === state.dim) {
    const [px, pz] = toScreen(p.x, p.z);
    ctx.beginPath(); ctx.arc(px, pz, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#15171c'; ctx.stroke();
  }
  wanted.sort((a, b) => Math.hypot(a[0] - ctxTile, a[1] - cztTile) - Math.hypot(b[0] - ctxTile, b[1] - cztTile));
  pumpTiles(wanted);

  // chunk grid when zoomed in
  if (s >= 6) {
    ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = Math.floor(wx0 / 16) * 16; x <= wx1; x += 16) { const [sx] = toScreen(x, 0); ctx.moveTo(Math.round(sx) + .5, 0); ctx.lineTo(Math.round(sx) + .5, H); }
    for (let z = Math.floor(wz0 / 16) * 16; z <= wz1; z += 16) { const [, sy] = toScreen(0, z); ctx.moveTo(0, Math.round(sy) + .5); ctx.lineTo(W, Math.round(sy) + .5); }
    ctx.stroke();
  }

  drawLocation(W, H);

  const sel = dragSel || state.sel;
  if (sel) {
    const [ax, az] = toScreen(Math.min(sel.x0, sel.x1), Math.min(sel.z0, sel.z1));
    const [bx, bz] = toScreen(Math.max(sel.x0, sel.x1) + 1, Math.max(sel.z0, sel.z1) + 1);
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(0, 0, W, az); ctx.fillRect(0, bz, W, H - bz); ctx.fillRect(0, az, ax, bz - az); ctx.fillRect(bx, az, W - bx, bz - az);
    ctx.strokeStyle = '#4cc38a'; ctx.lineWidth = 2;
    ctx.strokeRect(ax, az, bx - ax, bz - az);
    ctx.fillStyle = '#4cc38a';
    for (const [hx, hz] of [[ax, az], [bx, az], [ax, bz], [bx, bz]]) ctx.fillRect(hx - 4, hz - 4, 8, 8);
    const label = `${Math.abs(sel.x1 - sel.x0) + 1} × ${Math.abs(sel.z1 - sel.z0) + 1}`;
    ctx.font = '600 12px "Segoe UI", sans-serif';
    const tw = ctx.measureText(label).width + 12;
    const ly = az > 26 ? az - 24 : az + 6;
    ctx.fillStyle = '#4cc38a'; ctx.fillRect(ax, ly, tw, 20);
    ctx.fillStyle = '#06241a'; ctx.fillText(label, ax + 6, ly + 14);
  }
}

// ---- map interaction --------------------------------------------------------------------------

let dragSel = null, drag = null, spaceDown = false;
const EDGE = 7;

function hitSel(sx, sy) {
  const sel = state.sel;
  if (!sel) return null;
  const [ax, az] = toScreen(sel.x0, sel.z0), [bx, bz] = toScreen(sel.x1 + 1, sel.z1 + 1);
  if (sx < ax - EDGE || sx > bx + EDGE || sy < az - EDGE || sy > bz + EDGE) return null;
  const l = Math.abs(sx - ax) <= EDGE, r = Math.abs(sx - bx) <= EDGE, t = Math.abs(sy - az) <= EDGE, b = Math.abs(sy - bz) <= EDGE;
  if (!l && !r && !t && !b) return null;
  return { l, r, t, b };
}
function cursorFor(h) {
  if (!h) return 'crosshair';
  if ((h.l && h.t) || (h.r && h.b)) return 'nwse-resize';
  if ((h.r && h.t) || (h.l && h.b)) return 'nesw-resize';
  return h.l || h.r ? 'ew-resize' : 'ns-resize';
}
const snap = (v, e) => (e.shiftKey ? Math.round(v / 16) * 16 : Math.floor(v));

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (!state.index) return;
  canvas.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (e.button !== 0 || spaceDown) { drag = { type: 'pan', sx, sy, vx: state.view.x, vz: state.view.z }; canvas.style.cursor = 'grabbing'; return; }
  const h = hitSel(sx, sy);
  if (h) { drag = { type: 'resize', h, base: { ...state.sel } }; dragSel = { ...state.sel }; return; }
  const [wx, wz] = toWorld(sx, sy);
  drag = { type: 'select', ax: snap(wx, e), az: snap(wz, e), moved: false, sx, sy };
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  const [wx, wz] = toWorld(sx, sy);
  updateCoords(wx, wz);
  if (!drag) { canvas.style.cursor = spaceDown ? 'grab' : cursorFor(hitSel(sx, sy)); return; }
  if (drag.type === 'pan') {
    state.view.x = drag.vx - (sx - drag.sx) / state.view.scale;
    state.view.z = drag.vz - (sy - drag.sy) / state.view.scale;
  } else if (drag.type === 'select') {
    if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 4) return;
    drag.moved = true;
    const bx = snap(wx, e), bz = snap(wz, e);
    dragSel = { x0: Math.min(drag.ax, bx), x1: Math.max(drag.ax, bx) - (e.shiftKey && bx !== drag.ax ? 1 : 0), z0: Math.min(drag.az, bz), z1: Math.max(drag.az, bz) - (e.shiftKey && bz !== drag.az ? 1 : 0) };
  } else if (drag.type === 'resize') {
    const s = { ...drag.base }, h = drag.h, bx = snap(wx, e), bz = snap(wz, e);
    if (h.l) s.x0 = Math.min(bx, s.x1); if (h.r) s.x1 = Math.max(bx - (e.shiftKey ? 1 : 0), s.x0);
    if (h.t) s.z0 = Math.min(bz, s.z1); if (h.b) s.z1 = Math.max(bz - (e.shiftKey ? 1 : 0), s.z0);
    dragSel = s;
  }
  draw();
});
canvas.addEventListener('pointerup', () => {
  if (drag && dragSel) {
    const keepY = drag.type === 'resize' && state.sel;
    setSelection({ ...dragSel, y0: keepY ? state.sel.y0 : undefined, y1: keepY ? state.sel.y1 : undefined });
  }
  drag = null; dragSel = null; canvas.style.cursor = 'crosshair';
  draw();
});
canvas.addEventListener('pointerleave', () => { $('coords').textContent = ''; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!state.index) return;
  const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  const [wx, wz] = toWorld(sx, sy);
  const ns = Math.max(0.01, Math.min(24, state.view.scale * Math.pow(1.0015, -e.deltaY)));
  state.view.scale = ns;
  state.view.x = wx - (sx - canvas.clientWidth / 2) / ns;
  state.view.z = wz - (sy - canvas.clientHeight / 2) / ns;
  draw();
}, { passive: false });
window.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target.tagName !== 'INPUT') { spaceDown = true; e.preventDefault(); } });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
window.addEventListener('resize', () => { draw(); if (preview) preview.resize(); });

function heightAt(x, z) {
  const t = state.tiles.get(tileKey(Math.floor(x / TILE), Math.floor(z / TILE)));
  if (!t || !t.heights) return null;
  const h = t.heights[(((z % TILE) + TILE) % TILE) * TILE + (((x % TILE) + TILE) % TILE)];
  return h === -32768 ? null : h;
}
function updateCoords(wx, wz) {
  const x = Math.floor(wx), z = Math.floor(wz), h = heightAt(x, z);
  $('coords').textContent = `X ${x}   Z ${z}` + (h === null ? '' : `   Y ${h}`);
}

// ---- selection --------------------------------------------------------------------------------

function surfaceRange(sel) {
  let lo = Infinity, hi = -Infinity;
  // sample at most ~40k columns so huge selections stay instant
  const step = Math.max(1, Math.floor(Math.sqrt(((sel.x1 - sel.x0 + 1) * (sel.z1 - sel.z0 + 1)) / 40000)));
  for (let z = sel.z0; z <= sel.z1; z += step) for (let x = sel.x0; x <= sel.x1; x += step) {
    const h = heightAt(x, z);
    if (h === null) continue;
    if (h < lo) lo = h; if (h > hi) hi = h;
  }
  return hi === -Infinity ? null : [lo, hi];
}

function setSelection(sel) {
  const s = { x0: Math.min(sel.x0, sel.x1), x1: Math.max(sel.x0, sel.x1), z0: Math.min(sel.z0, sel.z1), z1: Math.max(sel.z0, sel.z1), y0: sel.y0, y1: sel.y1 };
  if (s.y0 === undefined || s.y1 === undefined || Number.isNaN(s.y0) || Number.isNaN(s.y1)) {
    const r = surfaceRange(s), dr = dimRange(state.dim);
    if (r) { s.y0 = Math.max(dr[0], r[0] - 4); s.y1 = Math.min(dr[1], r[1]); }
    else { s.y0 = dr[0]; s.y1 = dr[1]; }
    if (state.ceiling !== null) s.y1 = Math.min(s.y1, state.ceiling);
  }
  if (s.y0 > s.y1) [s.y0, s.y1] = [s.y1, s.y0];
  state.sel = s;
  syncSelInputs();
  // edited while looking at the 3D view: update it in place; picked on the map: frame it afresh
  if (state.mode === 'preview') buildPreview(); else state.reframe = true;
  draw();
}

// ---- locate: biomes and structures ------------------------------------------------------------
// state.locateData[dim] is the world's list (loaded once per dimension); state.loc is what is
// currently highlighted: { name, kind: 'biome' | 'structure', areas: [...], index, chunkSet? }.

async function loadLocate() {
  state.locateData = state.locateData || {};
  if (state.locateData[state.dim]) return state.locateData[state.dim];
  $('locateList').innerHTML = '<div class="muted" style="padding:8px">Searching the world…</div>';
  const dim = state.dim, world = state.world;
  const r = await api.job('locate', { dim }, (ev) => { $('locateList').innerHTML = `<div class="muted" style="padding:8px">Searching the world… ${Math.round(100 * ev.done / ev.total)}%</div>`; });
  if (state.world !== world) return null;
  state.locateData[dim] = r;
  return r;
}

function renderLocate() {
  const data = state.locateData && state.locateData[state.dim];
  const list = $('locateList');
  if (!data) return;
  const q = $('locateSearch').value.trim().toLowerCase();
  list.textContent = '';
  const section = (titleText, items, label, count, pick) => {
    const shown = items.filter((it) => !q || label(it).toLowerCase().includes(q));
    if (!shown.length) return;
    const h = document.createElement('h4'); h.textContent = titleText; list.append(h);
    for (const it of shown) {
      const row = document.createElement('div');
      row.className = 'loc' + (state.loc && state.loc.name === label(it) ? ' on' : '');
      row.innerHTML = '<span></span><span></span>';
      row.children[0].textContent = label(it); row.children[1].textContent = count(it);
      row.onclick = () => pick(it);
      list.append(row);
    }
  };
  section('Structures and places', data.structures, (s) => s.kind, (s) => `${s.places.length}`, (s) => showLocation({
    name: s.kind, kind: 'structure', areas: s.places.map((p) => ({ x: p.x, z: p.z, y: p.y, count: p.count })),
  }));
  section('Biomes', data.biomes, (b) => b.name, (b) => `${(b.chunks.length / 2).toLocaleString()} chunks`, (b) => showLocation(biomeLocation(b)));
  if (!list.children.length) list.innerHTML = '<div class="muted" style="padding:8px">Nothing matches.</div>';
}

// Groups a biome's chunks into connected areas.
function biomeLocation(b) {
  const set = new Set();
  for (let i = 0; i < b.chunks.length; i += 2) set.add(b.chunks[i] + ',' + b.chunks[i + 1]);
  const seen = new Set(), areas = [];
  for (let i = 0; i < b.chunks.length; i += 2) {
    const start = b.chunks[i] + ',' + b.chunks[i + 1];
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [[b.chunks[i], b.chunks[i + 1]]];
    const a = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, count: 0 };
    while (stack.length) {
      const [cx, cz] = stack.pop();
      a.count++;
      if (cx < a.x0) a.x0 = cx; if (cx > a.x1) a.x1 = cx; if (cz < a.z0) a.z0 = cz; if (cz > a.z1) a.z1 = cz;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = (cx + dx) + ',' + (cz + dz);
        if (set.has(k) && !seen.has(k)) { seen.add(k); stack.push([cx + dx, cz + dz]); }
      }
    }
    areas.push({ x: (a.x0 + a.x1 + 1) * 8, z: (a.z0 + a.z1 + 1) * 8, w: (a.x1 - a.x0 + 1) * 16, h: (a.z1 - a.z0 + 1) * 16, count: a.count });
  }
  return { name: b.name, kind: 'biome', areas, chunks: b.chunks };
}

function showLocation(loc) {
  // structures: nearest to where you are looking first, so "Next" walks outwards.
  // biomes: biggest area first - a biome is often dozens of stray chunks around one real region.
  const vx = state.view.x, vz = state.view.z;
  if (loc.kind === 'biome') loc.areas.sort((p, q) => q.count - p.count);
  else loc.areas.sort((p, q) => Math.hypot(p.x - vx, p.z - vz) - Math.hypot(q.x - vx, q.z - vz));
  loc.index = 0;
  state.loc = loc;
  $('locatePanel').hidden = true;
  setMode('map');
  goToLocation(0);
}

function goToLocation(step) {
  const loc = state.loc;
  if (!loc || !loc.areas.length) return;
  loc.index = (loc.index + step + loc.areas.length) % loc.areas.length;
  const a = loc.areas[loc.index];
  state.view.x = a.x; state.view.z = a.z;
  const r = canvas.getBoundingClientRect();
  state.view.scale = loc.kind === 'biome' ? Math.max(0.5, Math.min(6, Math.min(r.width / (a.w + 64), r.height / (a.h + 64)))) : 5;
  $('locateBar').hidden = false;
  const what = loc.kind === 'biome' ? `${a.count.toLocaleString()} chunks` : `X ${a.x}  Y ${a.y}  Z ${a.z}`;
  $('locateInfo').textContent = `${loc.name} · ${loc.index + 1} of ${loc.areas.length} · ${what}`;
  draw();
}

function clearLocation() { state.loc = null; $('locateBar').hidden = true; draw(); }

function drawLocation(W, H) {
  const loc = state.loc;
  if (!loc) return;
  const s = state.view.scale;
  if (loc.kind === 'biome') {
    ctx.fillStyle = 'rgba(255, 179, 71, .30)';
    const size = 16 * s, c = loc.chunks;
    for (let i = 0; i < c.length; i += 2) {
      const [sx, sy] = toScreen(c[i] * 16, c[i + 1] * 16);
      if (sx > W || sy > H || sx + size < 0 || sy + size < 0) continue;
      ctx.fillRect(sx, sy, size + 0.5, size + 0.5);
    }
  }
  loc.areas.forEach((a, i) => {
    const [sx, sy] = toScreen(a.x, a.z);
    if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) return;
    const current = i === loc.index;
    if (loc.kind === 'biome' && !current) return;
    ctx.beginPath(); ctx.arc(sx, sy, current ? 7 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = current ? '#ffb347' : 'rgba(255, 179, 71, .8)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#15171c'; ctx.stroke();
  });
}

$('locateBtn').onclick = async () => {
  if (!state.world || !state.index) return;
  const panel = $('locatePanel');
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  $('locateSearch').focus();
  try { await loadLocate(); renderLocate(); } catch (e) { $('locateList').innerHTML = `<div class="muted" style="padding:8px">${escapeHtml(e.message)}</div>`; }
};
$('locateSearch').oninput = renderLocate;
$('locateNext').onclick = () => goToLocation(1);
$('locatePrev').onclick = () => goToLocation(-1);
$('locateClear').onclick = clearLocation;
document.addEventListener('pointerdown', (e) => { if (!$('locateWrap').contains(e.target)) $('locatePanel').hidden = true; });

// ---- chunks the game never saved --------------------------------------------------------------

function missingChunks(s = state.sel) {
  const idx = state.index && state.index[state.dim];
  if (!s || !idx || !idx.chunkSet) return { missing: [], total: 0 };
  const missing = [];
  let total = 0;
  for (let cz = s.z0 >> 4; cz <= s.z1 >> 4; cz++) for (let cx = s.x0 >> 4; cx <= s.x1 >> 4; cx++) { total++; if (!idx.chunkSet.has(cx + ',' + cz)) missing.push([cx, cz]); }
  return { missing, total };
}

function updateGaps() {
  const { missing, total } = missingChunks();
  $('gaps').hidden = missing.length === 0;
  if (missing.length) $('gapsText').textContent = `${missing.length} of ${total} chunks in this selection were never saved by the game, so they are empty.`;
}

// Ticking areas make the game generate and keep chunks loaded; each may cover at most 100 chunks
// and a world can hold 10 of them.
function tickingCommands() {
  const { missing } = missingChunks();
  const tiles = new Map();
  for (const [cx, cz] of missing) {
    const k = Math.floor(cx / 10) + ',' + Math.floor(cz / 10);
    const t = tiles.get(k) || { x0: cx, x1: cx, z0: cz, z1: cz };
    t.x0 = Math.min(t.x0, cx); t.x1 = Math.max(t.x1, cx); t.z0 = Math.min(t.z0, cz); t.z1 = Math.max(t.z1, cz);
    tiles.set(k, t);
  }
  const all = [...tiles.values()];
  if (state.openEdition === 'java') {
    // Java: force-loaded chunks are generated and saved; there is no limit on how many
    const add = all.map((t) => `/forceload add ${t.x0 * 16} ${t.z0 * 16} ${t.x1 * 16 + 15} ${t.z1 * 16 + 15}`);
    return { add, remove: ['/forceload remove all'], left: 0 };
  }
  const areas = all.slice(0, 10);
  const add = areas.map((t, i) => `/tickingarea add ${t.x0 * 16} 0 ${t.z0 * 16} ${t.x1 * 16 + 15} 0 ${t.z1 * 16 + 15} boefill${i + 1}`);
  const remove = areas.map((t, i) => `/tickingarea remove boefill${i + 1}`);
  return { add, remove, left: all.length - areas.length };
}

async function showGapDialog() {
  const c = tickingCommands();
  $('cmds').value = c.add.join('\n') + '\n\n' + c.remove.join('\n');
  $('cmdsNote').textContent = c.left > 0
    ? `A world can hold 10 ticking areas, so this covers part of the selection. Reload afterwards and open this again for the remaining ${c.left} area${c.left > 1 ? 's' : ''}.`
    : 'If a command says the limit is reached, remove old ticking areas first with /tickingarea remove_all.';
  $('modal').dataset.add = c.add.join('\n');

  // the one-click helper (Bedrock only: it is a Bedrock script add-on)
  const java = state.openEdition === 'java';
  $('loaderAdd').hidden = java;
  if (java) {
    $('autoNote').classList.remove('err');
    $('autoNote').textContent = 'For Java worlds, load them with the commands below (they need cheats on).';
    $('autoSteps').hidden = true;
    $('manual').open = true;
    $('modal').hidden = false;
    return;
  }
  const { missing } = missingChunks();
  const st = await api.invoke('loaderStatus', state.world.dir);
  const tiles = new Set(missing.map(([cx, cz]) => Math.floor(cx / 10) + ',' + Math.floor(cz / 10))).size;
  const secs = Math.ceil(tiles / 4) * 4 + 5;
  const note = $('autoNote');
  note.classList.toggle('err', !st.ok);
  $('autoSteps').hidden = true;
  $('loaderAdd').disabled = !st.ok;
  $('loaderAdd').textContent = st.installed ? 'Update the helper with this selection' : 'Add the helper to this world';
  note.textContent = st.ok
    ? `${missing.length} chunk${missing.length === 1 ? '' : 's'}, usually done in ${secs < 60 ? 'under a minute' : `about ${Math.ceil(secs / 60)} minutes`}. Like any add-on it turns off achievements for this world. The exporter takes it out again once the chunks are in.`
    : st.reason;
  $('manual').open = !st.ok;
  $('modal').hidden = false;
}
$('gapsGame').onclick = showGapDialog;
$('loaderAdd').onclick = async () => {
  const { missing } = missingChunks();
  try {
    const r = await api.invoke('loaderInstall', { worldDir: state.world.dir, dim: state.dim, chunks: missing });
    $('autoNote').classList.remove('err');
    $('autoNote').textContent = `Added. It will load ${r.chunks} chunk${r.chunks === 1 ? '' : 's'} next time this world opens in Minecraft:`;
    $('autoSteps').hidden = false;
    $('loaderAdd').disabled = true;
    refreshLoader();
  } catch (e) {
    $('autoNote').classList.add('err');
    $('autoNote').textContent = 'Could not add the helper: ' + e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
};

// Shows how far the helper has got, and takes it out of the world once every chunk is in.
async function refreshLoader() {
  const box = $('loaderInfo');
  const st = state.world && state.index ? await api.invoke('loaderStatus', state.world.dir) : null;
  const job = state.loaderJob = st && st.installed;
  if (!job) { box.hidden = true; return; }
  watchGame();
  const idx = state.index[job.dim];
  const got = idx ? job.chunks.filter(([cx, cz]) => idx.chunkSet.has(cx + ',' + cz)).length : 0;
  if (got === job.chunks.length) {
    await api.invoke('loaderRemove', state.world.dir);
    box.hidden = true;
    setStatus(`<span class="ok">All ${got} chunks came through from the game. The helper has been taken out of the world again.</span>`);
    return;
  }
  const dimName = ['Overworld', 'Nether', 'End'][job.dim];
  $('loaderText').textContent = got
    ? `The chunk helper is in this world: ${got} of ${job.chunks.length} chunks are in so far${job.dim !== state.dim ? ` (${dimName})` : ''}. Finish in Minecraft, Save & Quit, then reload.`
    : `The chunk helper is in this world, waiting for ${job.chunks.length} chunks${job.dim !== state.dim ? ` in the ${dimName}` : ''}. Restart Minecraft if it is running, open the world, wait for "Done", Save & Quit, then reload.`;
  box.hidden = false;
}
// Minecraft only looks for new add-ons when it starts, so a game that was already running when the
// helper was added never runs it. Watch for that while the helper is waiting.
let gameTimer = null;
async function checkGame() {
  const job = state.loaderJob;
  const waiting = job && job.installedAt && (!$('loaderInfo').hidden || (!$('modal').hidden && !$('autoSteps').hidden));
  let text = '', good = false;
  if (!waiting) { clearInterval(gameTimer); gameTimer = null; }
  else {
    const started = await api.invoke('minecraftStartedAt');
    if (started && started < job.installedAt) text = 'Minecraft is still running from before the helper was added, so it will not see it. Close Minecraft completely and start it again.';
    else if (started) { text = 'Minecraft was started after the helper was added: open the world and it begins by itself.'; good = true; }
  }
  for (const id of ['mcWarn', 'loaderWarn']) { const el = $(id); el.textContent = text; el.classList.toggle('good', good); el.hidden = !text; }
}
function watchGame() { checkGame(); if (!gameTimer) gameTimer = setInterval(checkGame, 4000); }
$('loaderReload').onclick = () => reopen();
$('loaderRemove').onclick = async () => { await api.invoke('loaderRemove', state.world.dir); refreshLoader(); };
$('modalClose').onclick = () => { $('modal').hidden = true; };
$('copyCmds').onclick = async () => {
  const text = $('modal').dataset.add;
  try { await navigator.clipboard.writeText(text); } catch (e) { $('cmds').select(); document.execCommand('copy'); }
  $('copyCmds').textContent = 'Copied';
  setTimeout(() => { $('copyCmds').textContent = 'Copy add commands'; }, 1500);
};
const reloadWorld = () => { $('modal').hidden = true; reopen(); };
$('reload').onclick = reloadWorld;
$('modalReload').onclick = reloadWorld;
$('fill').onchange = () => { if (state.mode === 'preview') buildPreview(); };

function syncSelInputs() {
  updateGaps();
  const s = state.sel;
  for (const k of ['x0', 'x1', 'z0', 'z1', 'y0', 'y1']) $(k).value = s ? s[k] : '';
  if (!s) $('selInfo').textContent = 'Nothing selected — drag on the map';
  else {
    const w = s.x1 - s.x0 + 1, l = s.z1 - s.z0 + 1, h = s.y1 - s.y0 + 1;
    $('selInfo').textContent = `${w} × ${h} × ${l} blocks · ${(w * l * h).toLocaleString()} total`;
  }
  updateButtons();
}

for (const k of ['x0', 'x1', 'z0', 'z1', 'y0', 'y1']) {
  $(k).addEventListener('change', () => {
    const v = {};
    for (const j of ['x0', 'x1', 'z0', 'z1', 'y0', 'y1']) v[j] = parseInt($(j).value, 10);
    if (['x0', 'x1', 'z0', 'z1'].some((j) => Number.isNaN(v[j]))) return;
    setSelection(v);
  });
}
$('fitSurface').onclick = () => { if (state.sel) setSelection({ ...state.sel, y0: undefined, y1: undefined }); };
$('fitAll').onclick = () => {
  if (!state.sel || !state.index) return;
  const idx = state.index[state.dim];
  setSelection({ ...state.sel, y0: idx.count ? idx.minY : dimRange(state.dim)[0], y1: idx.count ? idx.maxY : dimRange(state.dim)[1] });
};

// ---- top bar ----------------------------------------------------------------------------------

function setDim(d, silent) {
  state.dim = d;
  for (const b of $('dimSeg').children) b.classList.toggle('on', Number(b.dataset.dim) === d);
  resetTiles(); state.sel = null; syncSelInputs();
  state.previewKey = null; state.voxelKey = null; state.reframe = true; previewSeq++;
  if (preview) preview.reset();
  clearEdits();
  state.loc = null; $('locateBar').hidden = true; $('locatePanel').hidden = true;
  if (!silent) { fitView(); setMode('map'); draw(); }
}
for (const b of $('dimSeg').children) b.onclick = () => setDim(Number(b.dataset.dim));
$('ceiling').addEventListener('change', () => {
  const v = parseInt($('ceiling').value, 10);
  state.ceiling = Number.isNaN(v) ? null : v;
  resetTiles(); draw();
});
for (const b of $('viewSeg').children) b.onclick = () => { if (b.dataset.view === 'preview') startPreview(); else setMode('map'); };

function setMode(mode) {
  state.mode = mode;
  for (const b of $('viewSeg').children) b.classList.toggle('on', b.dataset.view === mode);
  canvas.hidden = mode !== 'map';
  $('preview').hidden = mode !== 'preview';
  setHint();
  $('previewStats').hidden = mode !== 'preview';
  $('previewTools').hidden = mode !== 'preview';
  $('povHud').hidden = true;
  if (mode !== 'preview') $('coords').textContent = '';
  if (preview) preview.setActive(mode === 'preview');
  draw();
}

function setHint() {
  $('hint').textContent = state.mode === 'map'
    ? 'Drag to select an area · Right-drag or Space-drag to pan · Scroll to zoom · Shift snaps to chunks'
    : (preview && preview.pickMode
      ? 'Click a building or tree to pick it · Shift-click adds · Ctrl-click removes · Drag to orbit'
      : 'Drag to orbit · Right-drag to pan · Scroll to zoom · Drag the green arrows to resize the selection');
}

function updateButtons() {
  const ok = !!(state.world && state.sel && state.index && !state.busy);
  $('previewBtn').disabled = !ok || jobRunning === 'export';
  $('exportBtn').disabled = !ok || jobRunning === 'export';
  $('c4dBtn').disabled = !ok || jobRunning === 'export';
}

// ---- jobs: preview and export -----------------------------------------------------------------

let jobRunning = null;
function setStatus(html) { $('status').innerHTML = html; }
function setProgress(done, total) {
  $('progress').hidden = total === undefined;
  if (total) $('progressBar').style.width = Math.round((done / total) * 100) + '%';
}
function escapeHtml(s) { return String(s).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const selArgs = () => ({ dim: state.dim, ...state.sel });
const jobKey = () => JSON.stringify([state.world.dir, state.extraPacks, selArgs(), $('greedy').checked, $('fill').checked, state.editVersion, state.isolate, $('ents').checked, $('simplify').checked]);

// ---- picked objects: isolate, move ------------------------------------------------------------
// state.obj is the object picked in 3D ({ x, y, z, ids, kind, main, offset }); state.edits are moves
// already applied. Jobs get the selection, the moves, and (when isolated) the one object to show.

const objEdit = (o = state.obj) => ({ x: o.x, y: o.y, z: o.z, ids: o.ids, offset: o.offset });
const moved = (o = state.obj) => !!o && (o.offset[0] !== 0 || o.offset[1] !== 0 || o.offset[2] !== 0);
const jobEdits = () => (state.obj && !state.isolate && moved() ? [...state.edits, objEdit()] : state.edits);

function objBounds(o = state.obj) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < o.x.length; i++) {
    if (o.x[i] < x0) x0 = o.x[i]; if (o.x[i] > x1) x1 = o.x[i];
    if (o.y[i] < y0) y0 = o.y[i]; if (o.y[i] > y1) y1 = o.y[i];
    if (o.z[i] < z0) z0 = o.z[i]; if (o.z[i] > z1) z1 = o.z[i];
  }
  const [dx, dy, dz] = o.offset;
  return { x0: x0 + dx, x1: x1 + dx, y0: y0 + dy, y1: y1 + dy, z0: z0 + dz, z1: z1 + dz };
}

function jobScope() {
  const simplify = $('simplify').checked;
  if (state.isolate && state.obj) return { sel: { dim: state.dim, ...objBounds() }, edits: [], only: objEdit(), simplify };
  return { sel: selArgs(), edits: jobEdits(), noEntities: !$('ents').checked, simplify };
}

function describeObj(o) {
  const what = { tree: 'Tree', structure: 'Structure', plant: 'Plant' }[o.kind] || 'Object';
  const b = objBounds({ ...o, offset: [0, 0, 0] });
  return `${what} · ${o.x.length.toLocaleString()} blocks · ${b.x1 - b.x0 + 1} × ${b.y1 - b.y0 + 1} × ${b.z1 - b.z0 + 1} · mostly ${o.main.slice(o.main.indexOf(':') + 1).replace(/_/g, ' ')}`;
}

function updateObjPanel() {
  const o = state.obj;
  $('objPanel').hidden = !o && !state.edits.length;
  $('objBody').hidden = !o;
  if (o) {
    $('objInfo').textContent = describeObj(o) + (o.truncated ? ' (very large: only part of it was picked)' : '');
    const [dx, dy, dz] = o.offset;
    const part = (v, pos, neg) => (v ? `${Math.abs(v)} ${v > 0 ? pos : neg}` : null);
    const parts = [part(dx, 'east', 'west'), part(dy, 'up', 'down'), part(dz, 'south', 'north')].filter(Boolean);
    const trimming = !!(preview && preview.trimMode);
    $('moveInfo').textContent = parts.length ? 'Moved ' + parts.join(', ')
      : trimming ? 'Drag the orange arrows: inwards cuts parts off, outwards lets the pick grow.'
        : (preview && preview.moveMode ? 'Drag an orange arrow to move it.' : '');
    $('isolate').checked = state.isolate;
    $('moveBtn').classList.toggle('on', !!(preview && preview.moveMode));
    $('moveBtn').disabled = state.isolate;
    // the pick can be reshaped until it has been moved or shown alone
    const fixed = moved() || state.isolate || !o.seed;
    $('trimBtn').classList.toggle('on', trimming);
    $('trimBtn').disabled = fixed; $('cutY').disabled = fixed; $('cutAuto').disabled = fixed;
    if (document.activeElement !== $('cutY')) $('cutY').value = o.cut === null || o.cut === undefined ? '' : o.cut;
  }
  const n = state.edits.length + (moved() && !state.isolate ? 1 : 0);
  $('resetMoves').hidden = n === 0;
  $('resetMoves').textContent = `Undo ${n === 1 ? 'the move' : `all ${n} moves`}`;
}

// A finished move becomes part of the scene; the object is no longer the active one.
function releaseObj() {
  if (state.obj && moved() && !state.isolate) state.edits.push(objEdit());
  state.obj = null;
  if (state.isolate) { state.isolate = false; state.editVersion++; }
  if (preview) { preview.setObject(null); preview.setTrim(false); preview.moveMode = false; preview.boundsVisible = true; }
  updateObjPanel();
}

function clearEdits() {
  state.edits = []; state.obj = null; state.isolate = false; state.editVersion = (state.editVersion || 0) + 1;
  if (preview) { preview.setObject(null); preview.setTrim(false); preview.moveMode = false; preview.boundsVisible = true; }
  updateObjPanel();
}

const pickArgs = () => ({ sel: selArgs(), fill: $('fill').checked, edits: jobEdits(),
  gridKey: JSON.stringify([state.world.dir, selArgs(), $('fill').checked, state.editVersion, state.edits.length]) });

// Picks again from the block clicked last time, with a different ground level or trim box.
// change: { cutSet: undefined (work it out) | 'none' | world Y } and/or { limit: box | undefined }
async function repick(change) {
  const o = state.obj;
  if (!o || !o.seed || moved() || state.isolate) return;
  const next = { cutSet: o.cutSet, limit: o.limit, ...change };
  // If the block clicked originally is now cut away (trimmed off, or below the ground level), start
  // from the nearest block of the current pick that is still allowed.
  let seed = o.seed;
  const l = next.limit, floor = typeof next.cutSet === 'number' ? next.cutSet : -Infinity;
  const allowed = (x, y, z) => y > floor && (!l || (x >= l.x0 && x <= l.x1 && y >= l.y0 && y <= l.y1 && z >= l.z0 && z <= l.z1));
  if (!allowed(seed[0], seed[1], seed[2])) {
    // restart from one of the blocks the object is mainly made of, not a vine or torch hanging on it
    const counts = new Map();
    for (let i = 0; i < o.ids.length; i++) counts.set(o.ids[i], (counts.get(o.ids[i]) || 0) + 1);
    const common = o.ids.length * 0.02;
    let best = Infinity, found = null;
    for (let i = 0; i < o.x.length; i++) {
      if (counts.get(o.ids[i]) < common || !allowed(o.x[i], o.y[i], o.z[i])) continue;
      const d = (o.x[i] - seed[0]) ** 2 + (o.y[i] - seed[1]) ** 2 + (o.z[i] - seed[2]) ** 2;
      if (d < best) { best = d; found = [o.x[i], o.y[i], o.z[i]]; }
    }
    if (!found) { setStatus('<span class="warn">Nothing of the pick is left inside that. Drag the arrows back out or change the ground level.</span>'); updateObjPanel(); return; }
    seed = found;
  }
  let r;
  try {
    r = await api.job('pick', { ...pickArgs(), cell: seed, limit: next.limit,
      cut: next.cutSet === undefined ? undefined : next.cutSet === 'none' ? -1000000 : next.cutSet });
  } catch (e) { setStatus(`<span class="err">${escapeHtml(e.message)}</span>`); return; }
  if (state.obj !== o) return; // something else was picked meanwhile
  if (r.kind === 'none' || r.kind === 'terrain') { setStatus('<span class="warn">With that setting the block you clicked is no longer part of anything. Try another value.</span>'); updateObjPanel(); return; }
  // a ground level the tool worked out is kept for later adjustments (the trim box must not change it)
  state.obj = { ...r, offset: [0, 0, 0], cutSet: next.cutSet === undefined && r.cut !== null && r.cut !== undefined ? r.cut : next.cutSet, limit: next.limit };
  preview.setObject(state.obj);
  updateObjPanel();
  setStatus(`Picked: ${escapeHtml(describeObj(state.obj))}.`);
}

function setTrimMode(on) {
  const o = state.obj;
  if (!o || moved() || state.isolate) return;
  preview.setTrim(on, o.limit || objBounds());
  updateObjPanel();
}

async function onPick(ray, mods) {
  if (!state.sel || jobRunning === 'export' || state.isolate) return;
  const extend = (mods.shift || mods.ctrl) && state.obj && !moved();
  if (!extend) releaseObj();
  let r;
  try {
    r = await api.job('pick', { ...pickArgs(), origin: ray.origin, dir: ray.dir });
  } catch (e) { setStatus(`<span class="err">${escapeHtml(e.message)}</span>`); return; }
  if (r.kind === 'none') { setStatus('Nothing there. Click a building or a tree.'); return; }
  if (r.kind === 'terrain') { setStatus('That is terrain. Click a building or a tree — Shift-click adds to the pick, Ctrl-click takes away.'); return; }
  if (extend) {
    // merge or subtract by block position
    const key = (x, y, z) => x + ',' + y + ',' + z;
    const o = state.obj, hit = new Set();
    for (let i = 0; i < r.x.length; i++) hit.add(key(r.x[i], r.y[i], r.z[i]));
    const X = [], Y = [], Z = [], I = [];
    for (let i = 0; i < o.x.length; i++) {
      const k = key(o.x[i], o.y[i], o.z[i]);
      if (mods.ctrl && hit.has(k)) continue;
      hit.delete(k);
      X.push(o.x[i]); Y.push(o.y[i]); Z.push(o.z[i]); I.push(o.ids[i]);
    }
    if (!mods.ctrl) for (let i = 0; i < r.x.length; i++) if (hit.has(key(r.x[i], r.y[i], r.z[i]))) { X.push(r.x[i]); Y.push(r.y[i]); Z.push(r.z[i]); I.push(r.ids[i]); }
    if (!X.length) { releaseObj(); setStatus('Pick cleared.'); return; }
    // a hand-built pick has no single starting block any more, so it cannot be re-guessed
    state.obj = { ...o, x: Int32Array.from(X), y: Int32Array.from(Y), z: Int32Array.from(Z), ids: Uint16Array.from(I), kind: o.kind === r.kind ? o.kind : 'object', seed: null };
    preview.setTrim(false);
  } else state.obj = { ...r, offset: [0, 0, 0], cutSet: r.cut !== null && r.cut !== undefined ? r.cut : undefined };
  preview.setObject(state.obj);
  updateObjPanel();
  setStatus(`Picked: ${escapeHtml(describeObj(state.obj))}.`);
}

function setPickMode(on) {
  if (!preview) return;
  preview.pickMode = on;
  $('pickBtn').classList.toggle('on', on);
  preview.renderer.domElement.style.cursor = on ? 'crosshair' : '';
  setHint();
}

function setIsolate(on) {
  if (!state.obj) return;
  state.isolate = on; state.editVersion++;
  preview.setTrim(false);
  preview.moveMode = false; preview.boundsVisible = !on;
  updateObjPanel();
  buildPreview();
}

function setMoveMode(on) {
  if (!state.obj || state.isolate) return;
  if (on) preview.setTrim(false);
  preview.moveMode = on; preview.dirty = true;
  updateObjPanel();
}

function unknownHtml(unknown) {
  if (!unknown || !unknown.length) return '';
  return `<details><summary>${unknown.length} block type${unknown.length > 1 ? 's' : ''} need attention</summary><ul>${unknown.map(([n, why]) => `<li>${escapeHtml(n)} — ${escapeHtml(why)}</li>`).join('')}</ul></details>`;
}

const LIGHT_LIMIT = 60e6, WALK_LIMIT = 200e6; // blocks
const volume = (s) => (s.x1 - s.x0 + 1) * (s.z1 - s.z0 + 1) * (s.y1 - s.y0 + 1);
let previewSeq = 0, rebuildTimer = null;
const rebuildTimer_active = () => state.sel && preview && state.previewKey !== jobKey();

function initPreview() {
  preview = new Preview($('preview'));
  // dragging a face of the box in 3D edits the selection live
  preview.onBoundsDrag = (b) => {
    state.sel = { ...state.sel, ...b };
    syncSelInputs();
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => buildPreview(), 140);
  };
  preview.onBoundsCommit = () => { clearTimeout(rebuildTimer); buildPreview(); };
  preview.onPovExit = () => { $('povHud').hidden = true; $('previewTools').hidden = false; setHint(); };
  preview.onPick = onPick;
  // dragging an orange arrow slides the picked object; the scene follows as you drag
  preview.onObjectMove = (off) => {
    state.obj.offset = off; state.editVersion++;
    updateObjPanel();
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => buildPreview(), 140);
  };
  preview.onObjectMoveCommit = () => { clearTimeout(rebuildTimer); buildPreview(); };
  preview.onTrimCommit = (box) => repick({ limit: box });
  preview.onPovInfo = (i) => {
    const deg = (r) => Math.round(r * 180 / Math.PI);
    $('povInfo').textContent = `X ${i.x.toFixed(1)}  Y ${i.y.toFixed(1)}  Z ${i.z.toFixed(1)}   ·   yaw ${((-deg(i.yaw) % 360) + 360) % 360}°  pitch ${deg(i.pitch)}°   ·   ${i.fly ? 'flying' : 'walking'}`;
  };
  applyLighting();
}

function startPreview() {
  if (!state.sel || !state.world || state.busy) { if (state.previewKey) setMode('preview'); return; }
  if (!preview) initPreview();
  setMode('preview');
  buildPreview();
}

// Builds (or rebuilds) the 3D view for the current selection. Safe to call repeatedly: a newer call
// cancels the one in flight, and the old picture stays visible until the new one is complete.
async function buildPreview() {
  if (!preview || !state.sel || !state.world || state.busy) return;
  if (jobRunning === 'export') { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(buildPreview, 400); return; }
  const key = jobKey();
  if (key === state.previewKey) return;
  const seq = ++previewSeq;
  if (jobRunning) await api.invoke('cancel');
  if (seq !== previewSeq) return;
  if (state.reframe) { preview.origin = null; preview.setVoxels(null); state.voxelKey = null; state.reframe = false; }
  const reframed = !preview.origin;
  preview.setBounds(state.sel, { y0: dimRange(state.dim)[0], y1: dimRange(state.dim)[1] });
  if (reframed && state.obj) preview.setObject(state.obj); // the highlight is positioned relative to the origin
  state.previewKey = key;
  jobRunning = 'preview'; updateButtons();
  preview.begin();
  setStatus(volume(state.sel) > 60e6 ? '<span class="warn">Large selection — the preview may take a while.</span>' : 'Building preview…');
  setProgress(0, 1);
  const t0 = performance.now();
  try {
    const r = await api.job('preview', { ...jobScope(),greedy: $('greedy').checked, fill: $('fill').checked, origin: preview.origin }, (ev) => {
      if (seq !== previewSeq) return;
      if (ev.type === 'batch') preview.addBatch(ev);
      setProgress(ev.done, ev.total);
    });
    if (seq !== previewSeq) return;
    if (r.cancelled) { state.previewKey = null; preview.abort(); return; }
    state.lastBuild = { sent: r.quads, shown: preview.quads }; // these must match: every face sent is on screen
    preview.finish();
    $('previewStats').textContent = `${r.quads.toLocaleString()} faces · ${preview.materials.size} materials · ${r.size.join(' × ')} blocks`;
    setStatus(`Preview ready in ${((performance.now() - t0) / 1000).toFixed(1)} s. This is exactly what will be exported.` + unknownHtml(r.unknown));
    if (preview.needsVoxels() || preview.walker.active) await loadVoxels(seq);
  } catch (e) {
    if (seq === previewSeq) { state.previewKey = null; preview.abort(); setStatus(`<span class="err">Preview failed: ${escapeHtml(e.message)}</span>`); }
  } finally {
    if (seq === previewSeq && jobRunning === 'preview') { jobRunning = null; setProgress(); updateButtons(); }
  }
}

// Collision shapes and light levels for the selection now on screen.
async function loadVoxels(seq = previewSeq) {
  const vol = volume(state.sel);
  if (vol > WALK_LIMIT) { setStatus('<span class="warn">This selection is too large for walking and in-game lighting. Shrink it a little.</span>'); return false; }
  const light = preview.needsVoxels() && vol <= LIGHT_LIMIT;
  if (preview.needsVoxels() && !light) setStatus('<span class="warn">Selection too large for light simulation — showing it unlit. Shrink it to see Minecraft lighting.</span>');
  const key = jobKey() + '|' + light;
  if (state.voxelKey === key) return true;
  const v = await api.job('voxels', { ...jobScope(),light, fill: $('fill').checked });
  if (seq !== previewSeq) return false;
  preview.setVoxels(v);
  state.voxelKey = key;
  return true;
}

function applyLighting() {
  if (!preview) return;
  preview.setLighting($('lighting').value, $('glow').checked);
  if (preview.needsVoxels() && state.previewKey && !jobRunning) loadVoxels().catch((e) => setStatus(`<span class="err">${escapeHtml(e.message)}</span>`));
}

async function enterPov(lock = true) {
  if (!preview || !state.previewKey || jobRunning) return;
  try { if (!(await loadVoxels())) return; } catch (e) { setStatus(`<span class="err">${escapeHtml(e.message)}</span>`); return; }
  $('povHud').hidden = false; $('previewTools').hidden = true;
  $('hint').textContent = 'WASD move · Space jump · Ctrl sprint · F fly (Space up, Shift down) · Esc leave';
  preview.walker.enter(lock);
}

async function startExport(forcedPath) {
  if (!state.sel || !state.world) return;
  const s = state.sel;
  const name = `${state.world.name.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'world'}_${state.isolate && state.obj ? state.obj.kind + '_' : ''}${s.x0}_${s.z0}`;
  const path = forcedPath || await api.invoke('saveObj', name);
  if (!path) return;
  if (jobRunning) await api.invoke('cancel');
  jobRunning = 'export'; updateButtons();
  setStatus('Exporting…'); setProgress(0, 1);
  const t0 = performance.now();
  try {
    const r = await api.job('export', { ...jobScope(),greedy: $('greedy').checked, fill: $('fill').checked, scale: parseFloat($('scale').value) || 1, path }, (ev) => setProgress(ev.done, ev.total));
    if (r.cancelled) { setStatus('Export cancelled.'); return; }
    setStatus(`Exported ${r.quads.toLocaleString()} faces and ${r.materials} textures in ${((performance.now() - t0) / 1000).toFixed(1)} s (${fmtSize(r.bytes)}). <a id="reveal">Show in folder</a>` + unknownHtml(r.unknown));
    $('reveal').onclick = () => api.invoke('reveal', r.obj);
    return r;
  } catch (e) {
    setStatus(`<span class="err">Export failed: ${escapeHtml(e.message)}</span>`);
  } finally { jobRunning = null; setProgress(); updateButtons(); }
}

async function startC4dExport() {
  if (!state.sel || !state.world) return;
  if (jobRunning) await api.invoke('cancel');
  jobRunning = 'export'; updateButtons();
  setStatus('Sending to Cinema 4D…'); setProgress(0, 1);
  const t0 = performance.now();
  try {
    const prep = await api.invoke('c4dPrepare');
    const s = state.sel;
    const r = await api.job('exportC4d', { ...jobScope(),greedy: $('greedy').checked, fill: $('fill').checked, scale: parseFloat($('scale').value) || 1, dir: prep.dir, name: state.isolate && state.obj ? `${state.world.name} ${state.obj.kind} ${objBounds().x0},${objBounds().z0}` : `${state.world.name} ${s.x0},${s.z0}` }, (ev) => setProgress(ev.done, ev.total));
    if (r.cancelled) { setStatus('Export cancelled.'); return; }
    const fresh = [...prep.installed, ...prep.updated];
    const plugin = fresh.length
      ? `<br><span class="warn">The importer plugin was ${prep.installed.length ? 'installed' : 'updated'} for ${escapeHtml(fresh.join(', '))} — restart Cinema 4D once so it loads.</span>`
      : '';
    setStatus(`Sent ${r.quads.toLocaleString()} faces and ${r.materials} textures${r.animated ? ` (${r.animated} animated)` : ''} in ${((performance.now() - t0) / 1000).toFixed(1)} s.<br>In Cinema 4D run <b>Extensions › Import Bedrock World</b>. <a id="reveal">Show files</a>` + plugin + unknownHtml(r.unknown));
    $('reveal').onclick = () => api.invoke('reveal', r.dir + '\\handoff.json');
    return r;
  } catch (e) {
    setStatus(`<span class="err">Cinema 4D export failed: ${escapeHtml(e.message)}</span>`);
  } finally { jobRunning = null; setProgress(); updateButtons(); }
}

$('c4dBtn').onclick = () => startC4dExport();
$('previewBtn').onclick = startPreview;
$('pickBtn').onclick = () => setPickMode(!preview.pickMode);
$('isolate').onchange = () => setIsolate($('isolate').checked);
$('moveBtn').onclick = () => setMoveMode(!preview.moveMode);
$('trimBtn').onclick = () => setTrimMode(!preview.trimMode);
$('cutY').onchange = () => { const v = parseInt($('cutY').value, 10); repick({ cutSet: Number.isNaN(v) ? 'none' : v }); };
$('cutAuto').onclick = () => repick({ cutSet: undefined });
$('objClear').onclick = () => { const was = state.isolate; releaseObj(); if (was) buildPreview(); };
$('resetMoves').onclick = () => { clearEdits(); buildPreview(); };
$('lighting').onchange = applyLighting;
$('glow').onchange = applyLighting;
$('povBtn').onclick = () => enterPov();
$('greedy').onchange = () => { if (state.mode === 'preview') buildPreview(); };
$('ents').onchange = () => { if (state.mode === 'preview') buildPreview(); };
// textures are cached by the 3D view, so they have to be sent again in their other form
$('simplify').onchange = () => { if (preview) preview.dropMaterials(); if (state.mode === 'preview') buildPreview(); };
$('exportBtn').onclick = () => startExport();
$('addPack').onclick = async () => addPacks(await api.invoke('pickPack', { edition: state.openEdition }));
$('addPackFolder').onclick = async () => addPacks(await api.invoke('pickPackFolder', { edition: state.openEdition }));
$('openWorldFile').onclick = async () => { const w = await api.invoke('pickWorld'); if (w) openWorld(w); };
$('openWorldFolder').onclick = async () => { const w = await api.invoke('pickWorldFolder'); if (w) openWorld(w); else if (w === null) return; };
$('worldSearch').oninput = renderWorlds;

// ---- drag and drop ----------------------------------------------------------------------------

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dropping'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping');
  for (const f of e.dataTransfer.files) {
    try {
      const r = await api.invoke('resolveDrop', { path: api.pathForFile(f), edition: state.world ? state.openEdition : state.edition });
      if (r.world) await openWorld(r.world);
      else if (r.packs && r.packs.length) await addPacks(r.packs);
      else setStatus('<span class="warn">That does not look like a world or a resource pack.</span>');
    } catch (err) { setStatus(`<span class="err">${escapeHtml(err.message)}</span>`); }
  }
});

// ---- start ------------------------------------------------------------------------------------

async function waitForTiles() {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (state.inflight === 0 && ![...state.tiles.values()].some((t) => t.loading)) { await new Promise((r) => setTimeout(r, 150)); if (state.inflight === 0) return; }
  }
}

async function runAuto(a) {
  if (a.update) { // report what the updater did, then leave
    await new Promise((r) => setTimeout(r, a.update));
    const info = await api.invoke('appInfo');
    console.log('auto: update', JSON.stringify({ running: info.version, status: info.update.status, offered: info.update.version, error: info.update.error, bar: $('updateBar').hidden ? null : $('updateBar').textContent }));
    return api.invoke('quit');
  }
  if (a.edition) await setEdition(a.edition);
  const w = String(a.world).startsWith('gallery:') ? { dir: 'gallery:', name: 'Shape gallery', size: 1, modified: 0, icon: null }
    : String(a.world).startsWith('java-gallery:') ? { dir: a.world, name: 'Java block gallery', size: 1, modified: 0, icon: null, edition: 'java' }
    : [...state.worlds, ...(state.javaWorlds || [])].find((x) => x.name === a.world || x.dir === a.world);
  if (!w) { console.log('auto: world not found'); return api.invoke('quit'); }
  await openWorld(w);
  if (a.view) Object.assign(state.view, a.view);
  if (a.ceiling !== undefined) { state.ceiling = a.ceiling; resetTiles(); }
  draw(); await waitForTiles();
  if (a.sel) { setSelection(a.sel); if (a.fitSel) { state.view.x = (a.sel.x0 + a.sel.x1) / 2; state.view.z = (a.sel.z0 + a.sel.z1) / 2; } draw(); await waitForTiles(); }
  await new Promise((r) => setTimeout(r, 300));
  for (const want of a.locate || []) { // highlight a biome or structure by name and photograph the map
    const data = await loadLocate();
    const st = data.structures.find((s) => s.kind === want.name), bi = data.biomes.find((b) => b.name === want.name);
    console.log('auto: locate lists', data.structures.length, 'kinds of place and', data.biomes.length, 'biomes');
    if (st) showLocation({ name: st.kind, kind: 'structure', areas: st.places.map((p) => ({ x: p.x, z: p.z, y: p.y, count: p.count })) });
    else if (bi) showLocation(biomeLocation(bi));
    if (want.next) goToLocation(want.next);
    await waitForTiles();
    console.log('auto: located', $('locateInfo').textContent);
    if (want.panel) { $('locatePanel').hidden = false; renderLocate(); await new Promise((r) => setTimeout(r, 200)); }
    await api.invoke('shot', want.file);
    $('locatePanel').hidden = true;
  }
  if (a.locate) clearLocation();
  if (a.gapDialog) { // photograph the "get them from the game" dialog for the current selection
    await showGapDialog();
    await new Promise((r) => setTimeout(r, 200));
    console.log('auto: gap dialog', $('autoNote').textContent);
    await api.invoke('shot', a.gapDialog);
    $('modal').hidden = true;
  }
  if (a.mouse) {
    // real input events through the window: scroll to zoom, then drag a selection
    const r = canvas.getBoundingClientRect(), cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const before = state.view.scale;
    await api.invoke('input', { type: 'mouseMove', x: cx, y: cy });
    await api.invoke('input', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 240 });
    await wait(200);
    await api.invoke('input', { type: 'mouseDown', x: cx - 80, y: cy - 60, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) await api.invoke('input', { type: 'mouseMove', x: cx - 80 + i * 20, y: cy - 60 + i * 15, button: 'left' });
    await api.invoke('input', { type: 'mouseUp', x: cx + 80, y: cy + 60, button: 'left', clickCount: 1 });
    await wait(300);
    console.log('auto: mouse', JSON.stringify({ zoomed: state.view.scale > before, scaleBefore: before, scaleAfter: state.view.scale, sel: state.sel }));
    await waitForTiles();
  }
  if (a.shotMap) await api.invoke('shot', a.shotMap);
  if (a.shotPreview || a.shots) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const idle = async () => { for (let i = 0; i < 300; i++) { await wait(100); if (!jobRunning && !rebuildTimer_active()) { await wait(200); if (!jobRunning) return; } } };
    startPreview();
    await idle();
    for (const s of a.shots || [{ file: a.shotPreview }]) {
      if (s.fill !== undefined) { $('fill').checked = s.fill; buildPreview(); await wait(300); await idle(); console.log('auto: gaps', $('gapsText').textContent, '|', JSON.stringify(tickingCommands()), '|', $('previewStats').textContent); }
      if (s.pickAt) { // pick whatever is under a point, straight down
        await onPick({ origin: [s.pickAt[0] + 0.5, 400, s.pickAt[1] + 0.5], dir: [0, -1, 0] }, { shift: !!s.shift, ctrl: !!s.ctrl });
        console.log('auto: pick', $('objInfo').textContent || $('status').textContent);
      }
      if (s.pickClick) { // a real mouse click in pick mode, on a given world point
        setPickMode(true);
        const og = preview.origin, v = { x: s.pickClick[0] - og[0], y: s.pickClick[1] - og[1], z: s.pickClick[2] - og[2] };
        const p = preview.camera.position.clone().set(v.x, v.y, v.z).project(preview.camera), r = $('preview').getBoundingClientRect();
        const cx = Math.round(r.left + (p.x + 1) / 2 * r.width), cy = Math.round(r.top + (1 - p.y) / 2 * r.height);
        await api.invoke('input', { type: 'mouseMove', x: cx, y: cy });
        await api.invoke('input', { type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
        await api.invoke('input', { type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
        await wait(900);
        console.log('auto: click-pick', $('objInfo').textContent || $('status').textContent);
        setPickMode(false);
      }
      if (s.move) { // drag one of the object's arrows with the mouse
        setMoveMode(true); await wait(200);
        const [hx, hy] = preview.handleScreen(s.move[0], true).map(Math.round);
        await api.invoke('input', { type: 'mouseMove', x: hx, y: hy });
        await api.invoke('input', { type: 'mouseDown', x: hx, y: hy, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 10; i++) { await api.invoke('input', { type: 'mouseMove', x: hx + s.move[1] * i / 10, y: hy + s.move[2] * i / 10, button: 'left' }); await wait(30); }
        await api.invoke('input', { type: 'mouseUp', x: hx + s.move[1], y: hy + s.move[2], button: 'left', clickCount: 1 });
        await wait(300); await idle();
        console.log('auto: move', $('moveInfo').textContent, '|', $('previewStats').textContent);
      }
      if (s.simplify !== undefined) { $('simplify').checked = s.simplify; $('simplify').onchange(); await wait(300); await idle(); await wait(400); console.log('auto: simplify', s.simplify, '|', $('status').textContent.slice(0, 60)); }
      if (s.stress) { // toggle "show only this" repeatedly and count builds where faces went missing
        let lost = 0, worst = 1;
        for (let i = 0; i < s.stress; i++) {
          setIsolate(i % 2 === 0); await wait(60); await idle();
          const b = state.lastBuild;
          if (b.shown !== b.sent) { lost++; worst = Math.min(worst, b.shown / b.sent); }
        }
        setIsolate(false); await idle();
        console.log('auto: stress', JSON.stringify({ builds: s.stress, incomplete: lost, worstShare: +worst.toFixed(2) }));
      }
      if (s.cut !== undefined) { $('cutY').value = s.cut === null ? '' : s.cut; await $('cutY').onchange(); await wait(500); console.log('auto: ground', s.cut, '->', $('objInfo').textContent); }
      if (s.trim) { // pull one side of the trim box in with the mouse
        setTrimMode(true); await wait(200);
        const [hx, hy] = preview.handleScreen(s.trim[0], true).map(Math.round);
        await api.invoke('input', { type: 'mouseMove', x: hx, y: hy });
        await api.invoke('input', { type: 'mouseDown', x: hx, y: hy, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 10; i++) { await api.invoke('input', { type: 'mouseMove', x: hx + s.trim[1] * i / 10, y: hy + s.trim[2] * i / 10, button: 'left' }); await wait(30); }
        await api.invoke('input', { type: 'mouseUp', x: hx + s.trim[1], y: hy + s.trim[2], button: 'left', clickCount: 1 });
        await wait(700);
        console.log('auto: trim ->', $('objInfo').textContent, '| box', JSON.stringify(state.obj && state.obj.limit));
      }
      if (s.isolate !== undefined) { $('isolate').checked = s.isolate; setIsolate(s.isolate); await wait(300); await idle(); console.log('auto: isolate', s.isolate, '|', $('previewStats').textContent); }
      if (s.release) { $('objClear').click(); await wait(300); await idle(); console.log('auto: released, moves kept:', state.edits.length, '|', $('previewStats').textContent); }
      if (s.lighting) { $('lighting').value = s.lighting; $('glow').checked = !!s.glow; applyLighting(); await wait(300); await idle(); await wait(900); }
      if (s.camera) preview.setCamera(s.camera);
      if (s.dragHandle !== undefined) {
        // grab a box handle with real mouse events and pull it
        const [hx, hy] = preview.handleScreen(s.dragHandle).map(Math.round);
        const before = { ...state.sel };
        await api.invoke('input', { type: 'mouseMove', x: hx, y: hy });
        await api.invoke('input', { type: 'mouseDown', x: hx, y: hy, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 10; i++) { await api.invoke('input', { type: 'mouseMove', x: hx + s.dragBy[0] * i / 10, y: hy + s.dragBy[1] * i / 10, button: 'left' }); await wait(30); }
        await api.invoke('input', { type: 'mouseUp', x: hx + s.dragBy[0], y: hy + s.dragBy[1], button: 'left', clickCount: 1 });
        await wait(300); await idle();
        console.log('auto: drag', JSON.stringify({ before, after: state.sel, stats: $('previewStats').textContent }));
      }
      if (s.pov) {
        await enterPov(false);
        const w = preview.walker, log = [];
        const snap = (label) => log.push(`${label}: y=${w.pos.y.toFixed(2)} ground=${w.onGround} moved=${Math.hypot(w.pos.x - w.spawn.x, w.pos.z - w.spawn.z).toFixed(2)}`);
        if (s.pov.yaw !== undefined) w.yaw = s.pov.yaw;
        await wait(900); snap('landed');
        w.keys.add('KeyW'); await wait(s.pov.walk || 1500); snap('walked');
        w.keys.add('Space'); await wait(250); snap('jumping'); w.keys.delete('Space');
        await wait(900); w.keys.delete('KeyW'); await wait(400); snap('end');
        if (s.pov.pitch !== undefined) w.pitch = s.pov.pitch;
        console.log('auto: pov', log.join(' | '), '|', $('povInfo').textContent);
        await wait(300);
      }
      await wait(500);
      if (s.debug) {
        const p = preview, sh = p.sun.shadow;
        console.log('auto: dbg', JSON.stringify({ enabled: p.renderer.shadowMap.enabled, type: p.renderer.shadowMap.type, cast: p.sun.castShadow, map: !!sh.map, mapSize: sh.map && [sh.map.width, sh.map.height],
          casters: p.group.children.filter((m) => m.castShadow).length, receivers: p.group.children.filter((m) => m.receiveShadow).length, meshes: p.group.children.length,
          sunPos: p.sun.position.toArray().map(Math.round), target: p.sun.target.position.toArray().map(Math.round), cam: [sh.camera.left, sh.camera.right, sh.camera.near, sh.camera.far].map(Math.round),
          programs: p.renderer.info.programs.length, calls: p.renderer.info.render.calls }));
      }
      if (s.file) await api.invoke('shot', s.file);
      if (s.pov) { preview.walker.exit(); await wait(200); }
    }
  }
  if (a.c4d) { const r = await startC4dExport(); console.log('auto: c4d', JSON.stringify(r && { quads: r.quads, materials: r.materials, dir: r.dir })); }
  if (a.exportPath) { const r = await startExport(a.exportPath); console.log('auto: export', JSON.stringify(r && { quads: r.quads, materials: r.materials })); }
  console.log('auto: status', $('status').textContent.slice(0, 600));
  if (!a.stay) api.invoke('quit');
}

// ---- version and updates ----------------------------------------------------------------------

function showUpdate(u) {
  const bar = $('updateBar');
  if (!u || (u.status !== 'ready' && u.status !== 'needs-installer')) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.textContent = '';
  const head = document.createElement('div');
  head.textContent = u.status === 'ready' ? `Version ${u.version} is ready.` : `Version ${u.version} needs a new installer.`;
  bar.append(head);
  if (Array.isArray(u.notes) && u.notes.length) {
    const ul = document.createElement('ul');
    for (const n of u.notes.slice(0, 4)) { const li = document.createElement('li'); li.textContent = n; ul.append(li); }
    bar.append(ul);
  }
  const btn = document.createElement('button');
  btn.className = 'small';
  if (u.status === 'ready') { btn.textContent = 'Restart to update'; btn.onclick = () => api.invoke('restartApp'); }
  else { btn.textContent = 'Get the installer'; btn.onclick = () => api.invoke('openExternal', u.download); btn.hidden = !u.download; }
  bar.append(btn);
}

(async function init() {
  api.onUpdateState(showUpdate);
  api.invoke('appInfo').then((info) => { $('versionLine').textContent = 'Version ' + info.version; showUpdate(info.update); });
  setMode('map');
  syncSelInputs();
  state.worlds = await api.invoke('worlds');
  await setEdition(state.edition);
  const auto = await api.invoke('auto');
  if (auto) runAuto(auto).catch((e) => { console.log('auto: error', e.message, e.stack); api.invoke('quit'); });
})();
