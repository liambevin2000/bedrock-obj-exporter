'use strict';
// Makes a simpler version of a texture: the same picture, drawn with a handful of flat tones.
// Built on the merge rule from Essential Cosmetic Studio's promo textures (closest colours are
// merged first, weighted by how many pixels each covers; "redmean" colour distance) - but where
// that tool stops at a fixed distance, which suits a cosmetic's separately coloured surfaces, a
// block texture is one surface whose whole range is often smaller than that distance, and would
// come out as a single flat colour. So each block texture is judged against its own contrast:
// merging stops when the closest remaining pair is a real step within THIS texture, and never
// before a few tones are left. Planks keep their boards and seams, stone its lighter and darker
// patches, ore its spots - just without the dithering and noise.

const ALPHA_THRESHOLD = 10;      // pixels this transparent are not part of the surface: left untouched
const RELATIVE_STEP = 0.24;      // block textures: stop merging at this share of the texture's own range
const MIN_TONES = 3, MAX_TONES = 6;
const ATLAS_DISTANCE = 48;       // large atlases (furniture, entities): one fixed, gentler distance
const ATLAS_SIZE = 64;           // anything bigger than this on a side is treated as an atlas
const MAX_START_COLOURS = 320;   // big pictures are pre-grouped so the merge stays fast

// "redmean" perceptual RGB distance, squared.
function distance(a, b) {
  const rmean = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db;
}

// Merges the closest pair again and again. stop(distanceSquared, clustersLeft) decides when.
function mergeColours(clusters, stop) {
  while (clusters.length > 1) {
    let bestI = -1, bestJ = -1, best = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const ci = clusters[i].color;
      for (let j = i + 1; j < clusters.length; j++) {
        const d = distance(ci, clusters[j].color);
        if (d < best) { best = d; bestI = i; bestJ = j; }
      }
    }
    if (stop(best, clusters.length)) break;
    const a = clusters[bestI], b = clusters[bestJ], total = a.count + b.count;
    const merged = { color: [0, 1, 2].map((k) => (a.color[k] * a.count + b.color[k] * b.count) / total), count: total };
    clusters.splice(bestJ, 1); clusters.splice(bestI, 1);
    clusters.push(merged);
  }
  return clusters.map((c) => c.color);
}

// Colours present in the visible pixels, grouped coarsely enough to stay under the limit.
function collect(datas) {
  for (let shift = 0; shift <= 4; shift++) {
    const map = new Map();
    for (const d of datas) {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] <= ALPHA_THRESHOLD) continue;
        const key = ((d[i] >> shift) << 16) | ((d[i + 1] >> shift) << 8) | (d[i + 2] >> shift);
        const e = map.get(key);
        if (e) { e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; e.count++; } else map.set(key, { r: d[i], g: d[i + 1], b: d[i + 2], count: 1 });
      }
    }
    if (map.size <= MAX_START_COLOURS || shift === 4) return [...map.values()].map((e) => ({ color: [e.r / e.count, e.g / e.count, e.b / e.count], count: e.count }));
  }
  return [];
}

// Replaces every visible pixel by its nearest tone. Returns the new pixels and, per pixel, which tone.
function repaint(data, tones) {
  const out = new Uint8Array(data), which = new Int16Array(data.length / 4).fill(-1);
  const cache = new Map();
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] <= ALPHA_THRESHOLD) continue;
    const key = (out[i] << 16) | (out[i + 1] << 8) | out[i + 2];
    let t = cache.get(key);
    if (t === undefined) {
      const p = [out[i], out[i + 1], out[i + 2]];
      let best = Infinity;
      for (let k = 0; k < tones.length; k++) { const d = distance(p, tones[k]); if (d < best) { best = d; t = k; } }
      cache.set(key, t);
    }
    which[i >> 2] = t;
  }
  return { out, which };
}

// Single stray pixels are noise, not design: give each one the tone most of its neighbours have.
// The picture wraps at its edges, as block textures tile.
// A lone pixel that contrasts strongly with what surrounds it is kept: that is an ore fleck, a
// rivet or an eye, not noise. `close` is the largest squared distance still counted as noise.
function despeckle(which, w, h, tones, close) {
  const res = new Int16Array(which);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = which[y * w + x];
    if (t < 0) continue;
    const n = [which[y * w + (x + 1) % w], which[y * w + (x + w - 1) % w], which[((y + 1) % h) * w + x], which[((y + h - 1) % h) * w + x]];
    if (n.includes(t)) continue; // it has a neighbour of its own tone: part of a shape
    const counts = new Map();
    for (const v of n) if (v >= 0) counts.set(v, (counts.get(v) || 0) + 1);
    let best = -1, bc = 1;
    for (const [v, c] of counts) if (c > bc) { best = v; bc = c; }
    // only when at least two neighbours agree, and the pixel is just a shade away from them
    if (best >= 0 && distance(tones[t], tones[best]) <= close) res[y * w + x] = best;
  }
  return res;
}

function paint(data, which, tones) {
  const out = new Uint8Array(data);
  for (let i = 0; i < which.length; i++) {
    const t = which[i];
    if (t < 0) continue;
    out[i * 4] = Math.round(tones[t][0]); out[i * 4 + 1] = Math.round(tones[t][1]); out[i * 4 + 2] = Math.round(tones[t][2]);
  }
  return out;
}

// image: { w, h, data, strip? }. Returns a new image of the same size. An animated texture's
// frames share one set of tones so it does not flicker.
function simplifyImage(image) {
  const sources = image.strip ? [image.strip.data] : [image.data];
  const start = collect(sources);
  if (!start.length) return image;
  const atlas = image.w > ATLAS_SIZE || image.h > ATLAS_SIZE;
  let tones, range = 0;
  if (atlas) {
    const limit = ATLAS_DISTANCE * ATLAS_DISTANCE;
    tones = mergeColours(start, (d) => d > limit);
  } else {
    // the texture's own range: the furthest two of its colours
    for (let i = 0; i < start.length; i++) for (let j = i + 1; j < start.length; j++) { const d = distance(start[i].color, start[j].color); if (d > range) range = d; }
    const step = range * RELATIVE_STEP * RELATIVE_STEP;
    const floor = Math.min(MIN_TONES, start.length);
    tones = mergeColours(start, (d, left) => left <= floor || (left <= MAX_TONES && d > step));
  }
  const apply = (data, w, h) => {
    const { which } = repaint(data, tones);
    return paint(data, atlas ? which : despeckle(which, w, h, tones, range * 0.2), tones);
  };
  const out = Object.assign({}, image, { data: apply(image.data, image.w, image.h) });
  if (image.strip) {
    // each frame is cleaned on its own (frames are stacked top to bottom)
    const s = image.strip, bytes = image.w * image.w * 4, data = new Uint8Array(s.data.length);
    for (let f = 0; f < s.count; f++) data.set(apply(s.data.subarray(f * bytes, (f + 1) * bytes), image.w, image.w), f * bytes);
    out.strip = Object.assign({}, s, { data });
  }
  return out;
}

module.exports = { simplifyImage };
