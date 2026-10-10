import * as THREE from 'three';

// First-person walk through the previewed selection using Minecraft's own movement numbers:
// 20 ticks a second, gravity 0.08, jump 0.42, 0.6 x 1.8 player, 0.6 step-up, eye height 1.62.
const TICK = 1000 / 20;
const HALF = 0.3, HEIGHT = 1.8, EYE = 1.62, STEP = 0.6;
const EPS = 1e-7;

export class Walker {
  constructor(preview) {
    this.p = preview;
    this.active = false; this.fly = false;
    this.pos = new THREE.Vector3(); this.prev = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.onGround = false;
    this.keys = new Set();
    this.acc = 0; this.last = 0;
    this.saved = null;

    const el = preview.renderer.domElement;
    document.addEventListener('pointerlockchange', () => {
      if (this.active && this.locked && document.pointerLockElement !== el) this.exit();
      this.locked = document.pointerLockElement === el;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.active || document.pointerLockElement !== el) return;
      this.yaw -= e.movementX * 0.0023;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * 0.0023));
    });
    el.addEventListener('click', () => { if (this.active && document.pointerLockElement !== el) el.requestPointerLock(); });
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.code === 'Escape') { this.exit(); return; }
      if (e.code === 'KeyF' && !e.repeat) { this.fly = !this.fly; this.vel.set(0, 0, 0); }
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ---- collision world ------------------------------------------------------------------------

  // Calls fn(x0,y0,z0,x1,y1,z1) for every solid box touching the given region (preview-local coords).
  _boxes(ax, ay, az, bx, by, bz, fn) {
    const v = this.p.voxels;
    if (!v) return;
    const [sx, sy, sz] = v.dims, o = this.p.origin;
    const gx = v.min[0] - o[0], gy = v.min[1] - o[1], gz = v.min[2] - o[2];
    const x0 = Math.max(0, Math.floor(ax - gx)), x1 = Math.min(sx - 1, Math.floor(bx - gx));
    const y0 = Math.max(0, Math.floor(ay - gy) - 1), y1 = Math.min(sy - 1, Math.floor(by - gy));
    const z0 = Math.max(0, Math.floor(az - gz)), z1 = Math.min(sz - 1, Math.floor(bz - gz));
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const s = v.shape[(z * sy + y) * sx + x];
      if (!s) continue;
      for (const b of v.shapes[s]) fn(x + gx + b[0], y + gy + b[1], z + gz + b[2], x + gx + b[3], y + gy + b[4], z + gz + b[5]);
    }
  }

  // Moves the player box by (dx,dy,dz), stopping at blocks. Returns what was actually moved.
  _sweep(pos, dx, dy, dz) {
    let x0 = pos.x - HALF, x1 = pos.x + HALF, y0 = pos.y, y1 = pos.y + HEIGHT, z0 = pos.z - HALF, z1 = pos.z + HALF;
    const list = [];
    this._boxes(Math.min(x0, x0 + dx) - 1, Math.min(y0, y0 + dy) - 1, Math.min(z0, z0 + dz) - 1, Math.max(x1, x1 + dx) + 1, Math.max(y1, y1 + dy) + 1, Math.max(z1, z1 + dz) + 1,
      (a, b, c, d, e, f) => list.push([a, b, c, d, e, f]));
    // Y first, then X, then Z - the order the game uses
    for (const b of list) {
      if (x1 <= b[0] + EPS || x0 >= b[3] - EPS || z1 <= b[2] + EPS || z0 >= b[5] - EPS) continue;
      if (dy > 0 && y1 <= b[1] + EPS) dy = Math.min(dy, b[1] - y1);
      else if (dy < 0 && y0 >= b[4] - EPS) dy = Math.max(dy, b[4] - y0);
    }
    y0 += dy; y1 += dy;
    for (const b of list) {
      if (y1 <= b[1] + EPS || y0 >= b[4] - EPS || z1 <= b[2] + EPS || z0 >= b[5] - EPS) continue;
      if (dx > 0 && x1 <= b[0] + EPS) dx = Math.min(dx, b[0] - x1);
      else if (dx < 0 && x0 >= b[3] - EPS) dx = Math.max(dx, b[3] - x0);
    }
    x0 += dx; x1 += dx;
    for (const b of list) {
      if (y1 <= b[1] + EPS || y0 >= b[4] - EPS || x1 <= b[0] + EPS || x0 >= b[3] - EPS) continue;
      if (dz > 0 && z1 <= b[2] + EPS) dz = Math.min(dz, b[2] - z1);
      else if (dz < 0 && z0 >= b[5] - EPS) dz = Math.max(dz, b[5] - z0);
    }
    return [dx, dy, dz];
  }

  _move(dx, dy, dz) {
    const pos = this.pos;
    let m = this._sweep(pos, dx, dy, dz);
    const blockedXZ = m[0] !== dx || m[2] !== dz;
    const landing = dy < 0 && m[1] !== dy;
    if (blockedXZ && (this.onGround || landing)) {
      // try the same move from a step higher, then settle back down
      const up = this._sweep(pos, 0, STEP, 0)[1];
      const p2 = pos.clone(); p2.y += up;
      const fwd = this._sweep(p2, dx, 0, dz);
      p2.x += fwd[0]; p2.z += fwd[2];
      const down = this._sweep(p2, 0, -up + (dy < 0 ? dy : 0), 0)[1];
      p2.y += down;
      if (fwd[0] * fwd[0] + fwd[2] * fwd[2] > m[0] * m[0] + m[2] * m[2] + 1e-9) {
        const hitX = fwd[0] !== dx, hitZ = fwd[2] !== dz;
        pos.copy(p2);
        if (hitX) this.vel.x = 0; if (hitZ) this.vel.z = 0;
        this.onGround = true; this.vel.y = 0;
        return;
      }
    }
    pos.x += m[0]; pos.y += m[1]; pos.z += m[2];
    if (m[0] !== dx) this.vel.x = 0;
    if (m[2] !== dz) this.vel.z = 0;
    this.onGround = dy < 0 && m[1] !== dy;
    if (m[1] !== dy) this.vel.y = 0;
  }

  // ---- simulation -----------------------------------------------------------------------------

  _tick() {
    const k = this.keys, v = this.vel;
    let f = 0, s = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) s -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) s += 1;
    const sprint = (k.has('ControlLeft') || k.has('ControlRight')) && f > 0;
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // forward is -Z at yaw 0, right is +X
    const wx = -sin * f + cos * s, wz = -cos * f - sin * s;
    this.prev.copy(this.pos);

    if (this.fly) {
      const speed = (sprint ? 1.09 : 0.545);   // blocks per tick: creative flight
      let up = 0;
      if (k.has('Space')) up += 1;
      if (k.has('ShiftLeft') || k.has('ShiftRight')) up -= 1;
      v.x = v.x * 0.6 + wx * speed * 0.4; v.z = v.z * 0.6 + wz * speed * 0.4; v.y = v.y * 0.6 + up * 0.375 * 0.4 * 2.5;
      this.pos.add(v);
      this.onGround = false;
      return;
    }

    const slip = this.onGround ? 0.6 * 0.91 : 0.91;
    const accel = this.onGround ? 0.1 * (sprint ? 1.3 : 1) * (0.16277136 / (slip * slip * slip)) : 0.02 * (sprint ? 1.3 : 1);
    v.x += wx * accel; v.z += wz * accel;
    if (this.onGround && k.has('Space')) {
      v.y = 0.42;
      if (sprint) { v.x += -sin * 0.2; v.z += -cos * 0.2; }
    }
    this._move(v.x, v.y, v.z);
    v.y = (v.y - 0.08) * 0.98;
    v.x *= slip; v.z *= slip;

    // fell out of the selection: put the player back where they started
    const box = this.p.localBox();
    if (this.pos.y < box.min.y - 24) { this.pos.copy(this.spawn); this.prev.copy(this.spawn); v.set(0, 0, 0); }
  }

  frame(t) {
    if (!this.last) this.last = t;
    this.acc = Math.min(250, this.acc + (t - this.last));
    this.last = t;
    while (this.acc >= TICK) { this._tick(); this.acc -= TICK; }
    const a = this.acc / TICK, cam = this.p.camera;
    cam.position.set(this.prev.x + (this.pos.x - this.prev.x) * a, this.prev.y + (this.pos.y - this.prev.y) * a + EYE, this.prev.z + (this.pos.z - this.prev.z) * a);
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (this.p.onPovInfo) {
      const o = this.p.origin;
      this.p.onPovInfo({ x: cam.position.x + o[0], y: cam.position.y + o[1], z: cam.position.z + o[2], yaw: this.yaw, pitch: this.pitch, fly: this.fly, onGround: this.onGround });
    }
  }

  // ---- enter / leave --------------------------------------------------------------------------

  enter(lock = true) {
    const p = this.p, cam = p.camera;
    if (this.active || !p.bounds) return;
    this.saved = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov, near: cam.near, target: p.controls.target.clone() };
    const box = p.localBox();
    // stand on the ground under whatever the orbit camera was looking at
    const x = Math.min(box.max.x - 0.5, Math.max(box.min.x + 0.5, Math.floor(p.controls.target.x) + 0.5));
    const z = Math.min(box.max.z - 0.5, Math.max(box.min.z + 0.5, Math.floor(p.controls.target.z) + 0.5));
    let y = null;
    for (let cy = box.max.y; cy >= box.min.y - 1 && y === null; cy -= 0.25) {
      let top = -Infinity;
      this._boxes(x - HALF, cy, z - HALF, x + HALF, cy + 0.25, z + HALF, (a, b, c, d, e, f) => {
        if (x + HALF > a && x - HALF < d && z + HALF > c && z - HALF < f && e > top) top = e;
      });
      if (top > -Infinity) y = top;
    }
    this.fly = y === null;
    this.pos.set(x, y === null ? box.max.y + 2 : y + 0.001, z);
    this.spawn = this.pos.clone();
    this.prev.copy(this.pos); this.vel.set(0, 0, 0); this.onGround = false;
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    this.yaw = Math.atan2(-dir.x, -dir.z); this.pitch = 0;
    cam.fov = 70; cam.near = 0.05; cam.updateProjectionMatrix();
    p.controls.enabled = false;
    this.acc = 0; this.last = 0; this.keys.clear();
    this.active = true; this.locked = false;
    if (lock) { try { const r = p.renderer.domElement.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* click to lock instead */ } }
  }

  exit() {
    if (!this.active) return;
    const p = this.p, cam = p.camera, s = this.saved;
    this.active = false;
    if (document.pointerLockElement === p.renderer.domElement) document.exitPointerLock();
    cam.fov = s.fov; cam.near = s.near; cam.position.copy(s.pos); cam.quaternion.copy(s.quat); cam.updateProjectionMatrix();
    p.controls.target.copy(s.target); p.controls.enabled = true; p.controls.update();
    p.dirty = true;
    if (p.onPovExit) p.onPovExit();
  }
}
