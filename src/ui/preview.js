import * as THREE from 'three';
// kept with the app's own code: installers leave out the library's "examples" folder it comes from
import { OrbitControls } from './vendor/OrbitControls.js';
import { Walker } from './pov.js';

const FLUSH_QUADS = 20000;
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
// handle index -> [axis, key in bounds, sign]
const HANDLES = [[0, 'x0', -1], [0, 'x1', 1], [1, 'y0', -1], [1, 'y1', 1], [2, 'z0', -1], [2, 'z1', 1]];

const LIGHT_GLSL = `
uniform highp sampler3D uLightTex;
uniform vec3 uGridMin; uniform vec3 uGridSize;
uniform float uHasGrid; uniform float uGlow; uniform int uMode;
varying vec3 vWPos; varying vec3 vWNormal;
`;
const LIGHT_FRAG = `
{
  vec3 wn = normalize(vWNormal);
  if (!gl_FrontFacing) wn = -wn;
  vec3 lp = (vWPos + wn * 0.5 - uGridMin) / uGridSize;
  float sky = 1.0; float blk = 0.0;
  if (uHasGrid > 0.5 && all(greaterThanEqual(lp, vec3(0.0))) && all(lessThanEqual(lp, vec3(1.0)))) {
    vec2 l = texture(uLightTex, lp).rg; sky = l.r; blk = l.g;
  }
  // Minecraft's brightness curve for a light level
  float sc = sky / (4.0 - 3.0 * sky);
  float bc = blk / (4.0 - 3.0 * blk);
  vec3 glow = uGlow * bc * vec3(1.0, 0.86, 0.66);
  if (uMode == 1) {
    float shade = wn.x * wn.x * 0.6 + wn.z * wn.z * 0.8 + wn.y * wn.y * (wn.y > 0.0 ? 1.0 : 0.5);
    outgoingLight = diffuseColor.rgb * shade * max(max(vec3(sc), glow), vec3(0.035));
  } else {
    outgoingLight += diffuseColor.rgb * glow * 1.25;
  }
}
`;

// Live 3D view of the geometry the exporter produces, with an editable selection box.
export class Preview {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.localClippingEnabled = true;
    container.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a2029);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 20000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.requestRender());
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    this.scene.add(this.sun, this.sun.target);
    this.sunDir = new THREE.Vector3(-0.62, 0.8, 0.28).normalize(); // from the side, so shadows fall across the view

    this.group = new THREE.Group();     // what is shown
    this.staging = null;                // geometry of a rebuild in progress
    this.scene.add(this.group);
    this.materials = new Map();
    this.pending = new Map();
    this.quads = 0;
    this.origin = null;                 // world position of local (0,0,0); fixed so the camera never jumps
    this.bounds = null;                 // world blocks, inclusive
    this.limits = { y0: -64, y1: 319 };
    this.clip = [0, 1, 2, 3, 4, 5].map(() => new THREE.Plane());
    this.uniforms = {
      uLightTex: { value: null }, uGridMin: { value: new THREE.Vector3() }, uGridSize: { value: new THREE.Vector3(1, 1, 1) },
      uHasGrid: { value: 0 }, uGlow: { value: 0 }, uMode: { value: 0 },
    };
    this.lighting = 'flat'; this.glow = false;
    this.voxels = null;
    this.onBoundsDrag = null; this.onBoundsCommit = null; this.onPovExit = null; this.onPovInfo = null;

    // selection box + drag handles
    this.boxLines = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x4cc38a, transparent: true, opacity: 0.7 }));
    this.scene.add(this.boxLines);
    this.handles = HANDLES.map((h, i) => {
      const m = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.2, 16), new THREE.MeshBasicMaterial({ color: 0x4cc38a, depthTest: false, transparent: true, opacity: 0.95 }));
      const dir = AXES[h[0]].clone().multiplyScalar(h[2]);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      m.renderOrder = 10; m.userData.index = i;
      this.scene.add(m);
      return m;
    });
    // picked object: highlight, its own box, and arrows for moving it
    this.obj = null;                    // { box: Box3 (local, before offset), offset: Vector3 }
    this.objGroup = new THREE.Group();
    this.scene.add(this.objGroup);
    this.objLines = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffb347 }));
    this.objLines.visible = false;
    this.scene.add(this.objLines);
    this.moveHandles = HANDLES.map((h, i) => {
      const m = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.2, 16), new THREE.MeshBasicMaterial({ color: 0xffb347, depthTest: false, transparent: true, opacity: 0.95 }));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), AXES[h[0]].clone().multiplyScalar(h[2]));
      m.renderOrder = 11; m.userData.index = i; m.visible = false;
      this.scene.add(m);
      return m;
    });
    this.pickMode = false; this.moveMode = false; this.boundsVisible = true;
    this.trimMode = false; this.trimBox = null; this.onTrimCommit = null;
    this.onPick = null; this.onObjectMove = null; this.onObjectMoveCommit = null;
    this.raycaster = new THREE.Raycaster();
    this.drag = null; this.hover = -1;
    this._bindPointer();

    this.walker = new Walker(this);
    this.active = false; this.dirty = true;
    this.resize();
    const loop = (t) => {
      requestAnimationFrame(loop);
      if (!this.active) return;
      if (this.walker.active) { this.walker.frame(t); this.dirty = true; }
      else if (this.controls.update()) this.dirty = true;
      if (this.dirty) { this.dirty = false; this._placeHandles(); this.renderer.render(this.scene, this.camera); }
    };
    requestAnimationFrame(loop);
  }

  requestRender() { this.dirty = true; }
  setActive(on) { this.active = on; if (on) { this.resize(); this.dirty = true; } else if (this.walker.active) this.walker.exit(); }

  resize() {
    const r = this.container.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.renderer.domElement.style.width = r.width + 'px';
    this.renderer.domElement.style.height = r.height + 'px';
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // Forget everything (new world or different packs).
  reset() {
    this._disposeGroup(this.group);
    if (this.staging) { this._disposeGroup(this.staging); this.staging = null; }
    for (const m of this.materials.values()) { m.map.dispose(); m.dispose(); }
    this.materials.clear(); this.pending.clear(); this.quads = 0;
    this.origin = null; this.bounds = null;
    this.setObject(null); this.moveMode = false; this.boundsVisible = true;
    this.setVoxels(null);
  }
  // Forgets the textures (they will be sent again), keeping the camera and selection.
  dropMaterials() {
    this._disposeGroup(this.group);
    if (this.staging) { this._disposeGroup(this.staging); this.scene.remove(this.staging); this.staging = null; }
    for (const m of this.materials.values()) { m.map.dispose(); m.dispose(); }
    this.materials.clear(); this.pending.clear();
    this.dirty = true;
  }
  _disposeGroup(g) { for (const m of [...g.children]) { m.geometry.dispose(); g.remove(m); } }

  // ---- selection box --------------------------------------------------------------------------

  localBox(b = this.bounds) {
    const o = this.origin;
    return new THREE.Box3(new THREE.Vector3(b.x0 - o[0], b.y0 - o[1], b.z0 - o[2]), new THREE.Vector3(b.x1 + 1 - o[0], b.y1 + 1 - o[1], b.z1 + 1 - o[2]));
  }

  // Sets the selection. The first call for a world also fixes the origin and frames the camera.
  setBounds(b, limits) {
    if (limits) this.limits = limits;
    this.bounds = { ...b };
    if (!this.origin) {
      this.origin = [Math.floor((b.x0 + b.x1 + 1) / 2), b.y0, Math.floor((b.z0 + b.z1 + 1) / 2)];
      this.frame();
    }
    this._updateBox();
  }

  frame() {
    const box = this.localBox(), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const d = Math.max(s.x, s.z, s.y * 1.2) * 1.15 + 8;
    this.controls.target.copy(c);
    this.camera.position.set(c.x + d * 0.62, c.y + d * 0.55, c.z + d * 0.62);
    this.camera.near = Math.max(0.1, d / 4000); this.camera.far = Math.max(4000, d * 30);
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  _updateBox() {
    const box = this.localBox(), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    this.boxLines.position.copy(c); this.boxLines.scale.copy(s);
    const e = 0.002; // keep faces lying exactly on the boundary
    this.clip[0].set(new THREE.Vector3(1, 0, 0), -box.min.x + e); this.clip[1].set(new THREE.Vector3(-1, 0, 0), box.max.x + e);
    this.clip[2].set(new THREE.Vector3(0, 1, 0), -box.min.y + e); this.clip[3].set(new THREE.Vector3(0, -1, 0), box.max.y + e);
    this.clip[4].set(new THREE.Vector3(0, 0, 1), -box.min.z + e); this.clip[5].set(new THREE.Vector3(0, 0, -1), box.max.z + e);
    this._fitShadow();
    this.dirty = true;
  }

  _handlePos(i, box = this.localBox()) {
    const c = box.getCenter(new THREE.Vector3()), h = HANDLES[i];
    c.setComponent(h[0], h[2] < 0 ? box.min.getComponent(h[0]) : box.max.getComponent(h[0]));
    return c;
  }

  _placeHandles() {
    const walking = this.walker.active;
    const show = !!this.bounds && !walking && this.boundsVisible;
    const moving = !!this.obj && (this.moveMode || this.trimMode) && !walking;
    this.boxLines.visible = show;
    const place = (list, box, visible, colour, active) => list.forEach((m, i) => {
      m.visible = visible;
      if (!visible) return;
      const p = this._handlePos(i, box);
      // constant size on screen
      const k = this.camera.position.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.035;
      m.scale.setScalar(k);
      m.position.copy(p).addScaledVector(AXES[HANDLES[i][0]], HANDLES[i][2] * k * 0.8);
      m.material.color.set(active && (i === this.hover || (this.drag && this.drag.index === i)) ? 0xffffff : colour);
    });
    // while an object is being moved, its arrows replace the selection's so the two cannot be confused
    place(this.handles, this.bounds ? this.localBox() : null, show && !moving, 0x4cc38a, !moving);
    const ob = this.obj ? this.objBox() : null;
    place(this.moveHandles, ob, moving, 0xffb347, moving);
    // shown alone, the object needs no tint or frame: you are looking at exactly what will export
    this.objGroup.visible = !!this.obj && !walking && this.boundsVisible;
    this.objLines.visible = !!this.obj && !walking && this.boundsVisible;
    if (ob) { this.objLines.position.copy(ob.getCenter(new THREE.Vector3())); this.objLines.scale.copy(ob.getSize(new THREE.Vector3())); }
  }

  // The orange box: the trim box while trimming, otherwise the object where it currently stands.
  objBox() { return this.trimMode && this.trimBox ? this.localBox(this.trimBox) : this.obj.box.clone().translate(this.obj.offset); }
  _activeHandles() { return this.obj && (this.moveMode || this.trimMode) ? this.moveHandles : (this.boundsVisible ? this.handles : []); }

  // Trim mode: the arrows resize a box the pick may not leave. b: world blocks, inclusive.
  setTrim(on, b) { this.trimMode = on; this.trimBox = on && b ? { ...b } : null; if (on) this.moveMode = false; this.dirty = true; }

  // o: { x, y, z: Int32Array of world blocks, offset: [dx,dy,dz] } or null. Highlights it.
  setObject(o) {
    for (const m of [...this.objGroup.children]) { m.geometry.dispose(); m.material.dispose(); this.objGroup.remove(m); }
    this.obj = null;
    if (o && o.x.length && this.origin) {
      const n = o.x.length, og = this.origin;
      const box = new THREE.Box3();
      for (let i = 0; i < n; i++) box.expandByPoint(new THREE.Vector3(o.x[i] - og[0], o.y[i] - og[1], o.z[i] - og[2]));
      box.max.addScalar(1);
      if (n <= 200000) {
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.04, 1.04, 1.04), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.2, depthWrite: false }), n);
        const mtx = new THREE.Matrix4();
        for (let i = 0; i < n; i++) { mtx.setPosition(o.x[i] - og[0] + 0.5, o.y[i] - og[1] + 0.5, o.z[i] - og[2] + 0.5); mesh.setMatrixAt(i, mtx); }
        mesh.frustumCulled = false; mesh.renderOrder = 2;
        this.objGroup.add(mesh);
      }
      this.obj = { box, offset: new THREE.Vector3(...(o.offset || [0, 0, 0])) };
      this.objGroup.position.copy(this.obj.offset);
    }
    this.dirty = true;
  }
  setObjectOffset(off) { if (this.obj) { this.obj.offset.set(...off); this.objGroup.position.copy(this.obj.offset); this.dirty = true; } }

  // Screen position of a handle (CSS pixels inside the container). Used by the self-test.
  handleScreen(i, move) {
    this._placeHandles();
    const p = (move ? this.moveHandles : this.handles)[i].position.clone().project(this.camera), r = this.container.getBoundingClientRect();
    return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
  }

  _ray(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    return this.raycaster.ray;
  }

  _bindPointer() {
    const el = this.renderer.domElement;
    // capture phase so a handle grab wins over orbiting
    let down = null; // where a plain click started, to tell a click from an orbit drag
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.bounds || this.walker.active) return;
      down = { x: e.clientX, y: e.clientY };
      this._ray(e);
      const hit = this.raycaster.intersectObjects(this._activeHandles(), false)[0];
      if (!hit) return;
      down = null;
      e.stopImmediatePropagation(); e.preventDefault();
      const index = hit.object.userData.index;
      if (this.obj && this.trimMode && this.trimBox) this.drag = { trim: true, index, start: this._handlePos(index, this.objBox()), base: { ...this.trimBox } };
      else if (this.obj && this.moveMode) this.drag = { move: true, index, start: this._handlePos(index, this.objBox()), base: this.obj.offset.clone() };
      else this.drag = { index, start: this._handlePos(index), base: { ...this.bounds } };
      this.controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      this.dirty = true;
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (this.walker.active || !this.bounds) return;
      const ray = this._ray(e);
      if (!this.drag) {
        const hit = this.raycaster.intersectObjects(this._activeHandles(), false)[0];
        const h = hit ? hit.object.userData.index : -1;
        if (h !== this.hover) { this.hover = h; el.style.cursor = h >= 0 ? 'grab' : (this.pickMode ? 'crosshair' : ''); this.dirty = true; }
        return;
      }
      // closest point on the handle's axis to the mouse ray
      const [axis, key] = HANDLES[this.drag.index];
      const d1 = AXES[axis], d2 = ray.direction, w = this.drag.start.clone().sub(ray.origin);
      const b = d1.dot(d2), d = d1.dot(w), e2 = d2.dot(w), den = 1 - b * b;
      if (Math.abs(den) < 1e-5) return;
      const t = (b * e2 - d) / den;
      if (this.drag.move) {
        // slide the picked object along this axis in whole blocks
        const off = this.drag.base.clone();
        off.setComponent(axis, off.getComponent(axis) + Math.round(t));
        if (off.equals(this.obj.offset)) return;
        this.setObjectOffset(off.toArray());
        if (this.onObjectMove) this.onObjectMove(off.toArray());
        return;
      }
      const o = this.origin[axis];
      const face = Math.round(this.drag.start.getComponent(axis) + t) + o; // world coordinate of the dragged face
      const nb = { ...this.drag.base };
      const lo = key[0] + '0', hi = key[0] + '1';
      if (key.endsWith('0')) nb[lo] = Math.min(face, nb[hi]); else nb[hi] = Math.max(face - 1, nb[lo]);
      if (this.drag.trim) { // resizing the box the pick is confined to
        if (nb[key] === this.trimBox[key]) return;
        this.trimBox = nb; this.dirty = true;
        return;
      }
      if (axis === 1) { nb.y0 = Math.max(this.limits.y0, nb.y0); nb.y1 = Math.min(this.limits.y1, nb.y1); }
      if (nb[key] === this.bounds[key]) return;
      this.bounds = nb;
      this._updateBox();
      if (this.onBoundsDrag) this.onBoundsDrag({ ...nb });
    });
    const end = (e) => {
      if (!this.drag) {
        // a click that did not turn into an orbit: pick what is under the cursor
        if (down && this.pickMode && e.type === 'pointerup' && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && this.onPick && this.origin) {
          const ray = this._ray(e), og = this.origin;
          this.onPick({ origin: [ray.origin.x + og[0], ray.origin.y + og[1], ray.origin.z + og[2]], dir: ray.direction.toArray() }, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
        }
        down = null;
        return;
      }
      const wasMove = this.drag.move, wasTrim = this.drag.trim;
      this.drag = null; this.controls.enabled = true;
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      this.dirty = true;
      if (wasTrim) { if (this.onTrimCommit) this.onTrimCommit({ ...this.trimBox }); }
      else if (wasMove) { if (this.onObjectMoveCommit) this.onObjectMoveCommit(this.obj.offset.toArray()); }
      else if (this.onBoundsCommit) this.onBoundsCommit({ ...this.bounds });
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  setCamera(c) {
    if (c.target) this.controls.target.set(...c.target);
    if (c.position) this.camera.position.set(...c.position);
    this.controls.update(); this.dirty = true;
  }

  // ---- lighting -------------------------------------------------------------------------------

  // mode: 'flat' | 'minecraft' | 'shadows' | 'soft'
  setLighting(mode, glow) {
    this.lighting = mode; this.glow = !!glow;
    const shadows = mode === 'shadows' || mode === 'soft';
    const type = mode === 'soft' ? THREE.VSMShadowMap : THREE.PCFShadowMap;
    const typeChanged = this.renderer.shadowMap.enabled !== shadows || this.renderer.shadowMap.type !== type;
    this.renderer.shadowMap.enabled = shadows;
    this.renderer.shadowMap.type = type;
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.radius = mode === 'soft' ? 5 : 1;
    this.sun.shadow.blurSamples = 16;
    this.sun.shadow.bias = mode === 'soft' ? -0.0002 : -0.0006;
    this.sun.shadow.normalBias = mode === 'soft' ? 0.02 : 0.04;
    this.hemi.intensity = shadows ? 1.25 : 2.1;
    this.sun.intensity = shadows ? 2.7 : 1.5;
    this.uniforms.uMode.value = mode === 'minecraft' ? 1 : 0;
    this.uniforms.uGlow.value = this.glow ? 1 : 0;
    this.scene.background.set(mode === 'minecraft' ? 0x7aa7ff : 0x1a2029);
    if (typeChanged) {
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      for (const m of this.materials.values()) m.needsUpdate = true;
    }
    for (const g of [this.group, this.staging]) if (g) for (const mesh of g.children) this._shadowFlags(mesh);
    this._fitShadow();
    this.dirty = true;
  }
  needsVoxels() { return this.lighting === 'minecraft' || this.glow; }

  _shadowFlags(mesh) {
    const on = this.renderer.shadowMap.enabled;
    mesh.castShadow = on && mesh.material.userData.mode !== 'blend';
    mesh.receiveShadow = on;
  }

  _fitShadow() {
    if (!this.bounds || !this.origin) return;
    const box = this.localBox(), c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2 + 2;
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(this.sunDir, r * 2);
    const cam = this.sun.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 0.5; cam.far = r * 4;
    cam.updateProjectionMatrix();
  }

  // v: result of the worker's voxel pass (or null).
  setVoxels(v) {
    this.voxels = v;
    const u = this.uniforms;
    if (u.uLightTex.value) { u.uLightTex.value.dispose(); u.uLightTex.value = null; }
    u.uHasGrid.value = 0;
    if (v && v.light && this.origin) {
      const [sx, sy, sz] = v.dims;
      const tex = new THREE.Data3DTexture(new Uint8Array(v.light.buffer, v.light.byteOffset, v.light.length), sx, sy, sz);
      tex.format = THREE.RGFormat; tex.type = THREE.UnsignedByteType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      u.uLightTex.value = tex;
      u.uGridMin.value.set(v.min[0] - this.origin[0], v.min[1] - this.origin[1], v.min[2] - this.origin[2]);
      u.uGridSize.value.set(sx, sy, sz);
      u.uHasGrid.value = 1;
    }
    this.dirty = true;
  }

  // ---- geometry -------------------------------------------------------------------------------

  _material(m) {
    if (this.materials.has(m.id)) return;
    const tex = new THREE.DataTexture(new Uint8Array(m.data.buffer, m.data.byteOffset, m.data.length), m.w, m.h, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    const mat = new THREE.MeshLambertMaterial({ map: tex, clippingPlanes: this.clip });
    if (m.mode === 'cutout') { mat.alphaTest = 0.5; mat.side = THREE.DoubleSide; }
    else if (m.mode === 'blend') { mat.transparent = true; mat.depthWrite = false; mat.side = THREE.DoubleSide; }
    mat.shadowSide = THREE.FrontSide;
    mat.userData.mode = m.mode;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNormal;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = transformed; vWNormal = normal;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + LIGHT_GLSL)
        .replace('#include <opaque_fragment>', LIGHT_FRAG + '\n#include <opaque_fragment>');
    };
    mat.customProgramCacheKey = () => 'boe-light';
    this.materials.set(m.id, mat);
  }

  // Starts receiving a (re)build. The current picture stays up until finish() swaps the new one in.
  begin() {
    if (this.staging) { this._disposeGroup(this.staging); this.scene.remove(this.staging); }
    this.pending.clear(); this.quads = 0;
    this.staging = new THREE.Group();
    // first build streams in visibly; rebuilds stay hidden so nothing overlaps
    this.staging.visible = this.group.children.length === 0;
    this.scene.add(this.staging);
  }

  addBatch(ev) {
    if (!this.staging) return;
    for (const m of ev.materials) this._material(m);
    for (const g of ev.groups) {
      let p = this.pending.get(g.mat);
      if (!p) { p = { parts: [], count: 0 }; this.pending.set(g.mat, p); }
      p.parts.push(g); p.count += g.count;
      this.quads += g.count;
      if (p.count >= FLUSH_QUADS) this._flush(g.mat);
    }
    if (this.staging.visible && (!this._lastFlush || performance.now() - this._lastFlush > 400)) { this._flushAll(); this._lastFlush = performance.now(); }
  }

  finish() {
    if (!this.staging) return;
    this._flushAll();
    this._disposeGroup(this.group); this.scene.remove(this.group);
    this.group = this.staging; this.group.visible = true; this.staging = null;
    this.dirty = true;
  }
  abort() { if (this.staging) { this._disposeGroup(this.staging); this.scene.remove(this.staging); this.staging = null; } }
  _flushAll() { for (const id of [...this.pending.keys()]) this._flush(id); }

  _flush(id) {
    const p = this.pending.get(id);
    if (!p || !p.count) return;
    this.pending.delete(id);
    const n = p.count;
    const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), nor = new Float32Array(n * 12);
    let o = 0;
    for (const g of p.parts) { pos.set(g.pos, o * 12); uv.set(g.uv, o * 8); o += g.count; }
    const index = new Uint32Array(n * 6);
    for (let q = 0; q < n; q++) {
      const v = q * 4, i = q * 6, a = q * 12;
      index[i] = v; index[i + 1] = v + 1; index[i + 2] = v + 2; index[i + 3] = v; index[i + 4] = v + 2; index[i + 5] = v + 3;
      const ax = pos[a + 3] - pos[a], ay = pos[a + 4] - pos[a + 1], az = pos[a + 5] - pos[a + 2];
      const bx = pos[a + 9] - pos[a], by = pos[a + 10] - pos[a + 1], bz = pos[a + 11] - pos[a + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (let c = 0; c < 4; c++) { nor[a + c * 3] = nx; nor[a + c * 3 + 1] = ny; nor[a + c * 3 + 2] = nz; }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mat = this.materials.get(id);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    if (mat.userData.mode === 'blend') mesh.renderOrder = 1;
    this._shadowFlags(mesh);
    this.staging.add(mesh);
    this.dirty = true;
  }
}
