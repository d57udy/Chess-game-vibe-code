// Pooled billboard particles (one instanced draw call per blend mode) and a magic projectile helper.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { highlightTexture, decalTexture } from './scene-textures.js';

const MAX_PARTICLES = 200;

const FIELDS = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'a0', 'r', 'g', 'b', 'drag', 'grav', 'spin', 'spinV'];

// Per-kind recipes. Speeds are horizontal (radial) and vertical ranges in units/s.
const RECIPES = {
  dust: { sys: 'soft', count: 18, color: '#9c8668', life: [0.7, 1.2], speed: [0.5, 1.4], up: [0.15, 0.6], spread: 0.25, grav: -0.5, drag: 2.4, size: [0.25, 0.75], alpha: 0.8, lift: 0.06, whiten: 0.1 },
  spark: { sys: 'glow', count: 22, color: '#ffc861', life: [0.22, 0.5], speed: [1.6, 4.0], up: [0.4, 2.6], spread: 0.05, grav: -7, drag: 1.4, size: [0.1, 0.02], alpha: 1, lift: 0, whiten: 0.5, flash: 3 },
  magic: { sys: 'glow', count: 30, color: '#8fd8ff', life: [0.55, 1.0], speed: [0.5, 1.8], up: [-0.3, 1.4], spread: 0.12, grav: 1.2, drag: 2.6, size: [0.22, 0.0], alpha: 0.9, lift: 0, whiten: 0.25, flash: 4 },
  poof: { sys: 'soft', count: 24, color: '#ece6f2', life: [0.55, 0.95], speed: [1.0, 2.2], up: [-0.5, 1.2], spread: 0.2, grav: 0.6, drag: 3.6, size: [0.4, 1.0], alpha: 0.9, lift: 0, whiten: 0.15 },
};

const VERT = /* glsl */ `
  attribute vec3 iOffset;
  attribute vec4 iColor;
  attribute vec2 iSize;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vUv = uv;
    vColor = iColor;
    vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
    float c = cos(iSize.y), s = sin(iSize.y);
    mv.xy += vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iSize.x;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  uniform float uPower;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = pow(clamp(1.0 - d, 0.0, 1.0), uPower);
    gl_FragColor = vec4(vColor.rgb, vColor.a * a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function createParticleSystem(parent, { additive, power }) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  const aOffset = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const aColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 2), 2).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iOffset', aOffset);
  geo.setAttribute('iColor', aColor);
  geo.setAttribute('iSize', aSize);
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPower: { value: power } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    toneMapped: !additive,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = false;
  parent.add(mesh);

  const P = {};
  for (const f of FIELDS) P[f] = new Float32Array(MAX_PARTICLES);
  let count = 0;

  function spawn(p) {
    if (count >= MAX_PARTICLES) return false;
    const i = count++;
    for (const f of FIELDS) P[f][i] = p[f] ?? 0;
    return true;
  }

  function update(dt) {
    let i = 0;
    while (i < count) {
      P.age[i] += dt;
      if (P.age[i] >= P.life[i]) {
        // swap-remove with the last live particle
        const last = --count;
        for (const f of FIELDS) P[f][i] = P[f][last];
        continue;
      }
      const damp = Math.exp(-P.drag[i] * dt);
      P.vx[i] *= damp;
      P.vz[i] *= damp;
      P.vy[i] = P.vy[i] * damp + P.grav[i] * dt;
      P.px[i] += P.vx[i] * dt;
      P.py[i] += P.vy[i] * dt;
      P.pz[i] += P.vz[i] * dt;
      P.spin[i] += P.spinV[i] * dt;
      const k = P.age[i] / P.life[i];
      const alpha = P.a0[i] * Math.min(1, k / 0.12) * Math.pow(1 - k, 1.3);
      aOffset.array[i * 3] = P.px[i];
      aOffset.array[i * 3 + 1] = P.py[i];
      aOffset.array[i * 3 + 2] = P.pz[i];
      aColor.array[i * 4] = P.r[i];
      aColor.array[i * 4 + 1] = P.g[i];
      aColor.array[i * 4 + 2] = P.b[i];
      aColor.array[i * 4 + 3] = alpha;
      aSize.array[i * 2] = P.s0[i] + (P.s1[i] - P.s0[i]) * k;
      aSize.array[i * 2 + 1] = P.spin[i];
      i++;
    }
    geo.instanceCount = count;
    mesh.visible = count > 0;
    if (count > 0) {
      aOffset.needsUpdate = true;
      aColor.needsUpdate = true;
      aSize.needsUpdate = true;
    }
  }

  return { spawn, update, clear: () => { count = 0; geo.instanceCount = 0; mesh.visible = false; }, count: () => count };
}

export function createFx(scene, { emberPoints = [], camera } = {}) {
  const root = new THREE.Group();
  root.name = 'fx';
  scene.add(root);
  const systems = {
    soft: createParticleSystem(root, { additive: false, power: 1.4 }),
    glow: createParticleSystem(root, { additive: true, power: 2.0 }),
    ambient: createParticleSystem(root, { additive: true, power: 2.0 }), // torch embers, never counted as busy
  };

  // One shared point light for flashes and projectiles; it always exists so the light count never
  // changes (adding/removing lights at runtime would recompile every material).
  const fxLight = new THREE.PointLight('#8fd8ff', 0, 6, 1.6);
  root.add(fxLight);
  let flash = 0;

  const tmpColor = new THREE.Color();
  const white = new THREE.Color('#ffffff');
  const rand = (a, b) => a + Math.random() * (b - a);

  function burst(position, kind = 'dust', { color, count, scale = 1 } = {}) {
    const rc = RECIPES[kind] || RECIPES.dust;
    const sys = systems[rc.sys];
    const baseColor = new THREE.Color(color ?? rc.color);
    const n = count ?? rc.count;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * rc.spread * scale;
      const hs = rand(rc.speed[0], rc.speed[1]) * scale;
      tmpColor.copy(baseColor).lerp(white, Math.random() * rc.whiten);
      sys.spawn({
        px: position.x + Math.cos(a) * r,
        py: position.y + rc.lift + Math.random() * rc.spread * 0.5,
        pz: position.z + Math.sin(a) * r,
        vx: Math.cos(a) * hs,
        vy: rand(rc.up[0], rc.up[1]) * scale,
        vz: Math.sin(a) * hs,
        life: rand(rc.life[0], rc.life[1]),
        s0: rc.size[0] * scale * rand(0.75, 1.25),
        s1: rc.size[1] * scale * rand(0.75, 1.25),
        a0: rc.alpha,
        r: tmpColor.r,
        g: tmpColor.g,
        b: tmpColor.b,
        drag: rc.drag,
        grav: rc.grav,
        spin: Math.random() * 6.28,
        spinV: rand(-2, 2),
      });
    }
    if (rc.flash) {
      fxLight.color.copy(baseColor);
      fxLight.position.set(position.x, position.y + 0.5, position.z);
      flash = Math.max(flash, rc.flash * scale);
    }
  }

  // ---- projectile ----
  const glowTex = highlightTexture('glow');
  const coreGeo = new THREE.IcosahedronGeometry(0.065, 2); // ~0.13 diameter at size 1
  const orbPool = [];
  const active = new Set();

  function acquireOrb(color, size) {
    let orb = orbPool.pop();
    if (!orb) {
      const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ toneMapped: false }));
      const glowMat = () => new THREE.SpriteMaterial({
        map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      });
      const halo = new THREE.Sprite(glowMat()); // wide colored glow
      const hot = new THREE.Sprite(glowMat()); // small white-hot center
      halo.renderOrder = hot.renderOrder = 11;
      orb = new THREE.Group();
      orb.add(core, halo, hot);
      orb.userData = { core, halo, hot };
    }
    const c = new THREE.Color(color);
    orb.userData.core.material.color.copy(c).lerp(white, 0.75);
    orb.userData.halo.material.color.copy(c);
    orb.userData.hot.material.color.copy(c).lerp(white, 0.5);
    orb.userData.halo.scale.setScalar(0.9 * size);
    orb.userData.hot.scale.setScalar(0.3 * size);
    orb.userData.core.scale.setScalar(size);
    root.add(orb);
    return orb;
  }

  // projectile(from, to, { duration, color, arc, size, burst }) -> Promise resolved on arrival.
  function projectile(from, to, { duration = 0.45, color = '#8fd8ff', arc = 0.3, size = 1, burst: burstKind = null } = {}) {
    return new Promise((resolve) => {
      const p0 = from.clone();
      const p1 = to.clone();
      const orb = acquireOrb(color, size);
      const c = new THREE.Color(color);
      const job = { t: 0, trail: 0 };
      job.step = (dt) => {
        job.t += dt;
        const k = Math.min(1, job.t / Math.max(duration, 1e-4));
        orb.position.lerpVectors(p0, p1, k);
        orb.position.y += arc * 4 * k * (1 - k);
        orb.userData.halo.material.rotation += dt * 4;
        orb.userData.halo.scale.setScalar((0.9 + 0.15 * Math.sin(job.t * 40)) * size);
        fxLight.color.copy(c);
        fxLight.position.copy(orb.position);
        flash = Math.max(flash, 3);
        job.trail += dt;
        while (job.trail > 1 / 120) {
          job.trail -= 1 / 120;
          tmpColor.copy(c).lerp(white, Math.random() * 0.4);
          systems.glow.spawn({
            px: orb.position.x + rand(-0.03, 0.03),
            py: orb.position.y + rand(-0.03, 0.03),
            pz: orb.position.z + rand(-0.03, 0.03),
            vx: rand(-0.3, 0.3), vy: rand(-0.1, 0.4), vz: rand(-0.3, 0.3),
            life: rand(0.2, 0.35), s0: 0.24 * size, s1: 0, a0: 0.9,
            r: tmpColor.r, g: tmpColor.g, b: tmpColor.b, drag: 2, grav: 0, spin: 0, spinV: 0,
          });
        }
        if (k >= 1) job.finish();
      };
      job.finish = () => {
        if (!active.has(job)) return;
        active.delete(job);
        root.remove(orb);
        orbPool.push(orb);
        impactFlash(p1, c, size);
        if (burstKind) burst(p1, burstKind, { color });
        resolve();
      };
      active.add(job);
    });
  }

  // Impact flash: an expanding additive glow sprite plus a light pulse (pooled).
  const flashes = [];
  const flashPool = [];
  function impactFlash(pos, color, size = 1) {
    const s = flashPool.pop() || new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    s.material.color.copy(color).lerp(white, 0.3);
    s.position.copy(pos);
    s.renderOrder = 11;
    root.add(s);
    flashes.push({ s, t: 0, size });
    fxLight.color.copy(color);
    fxLight.position.copy(pos);
    flash = Math.max(flash, 8);
  }
  function updateFlashes(dt) {
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.t += dt;
      const k = f.t / 0.28;
      if (k >= 1) {
        root.remove(f.s);
        flashPool.push(f.s);
        flashes.splice(i, 1);
        continue;
      }
      f.s.scale.setScalar((0.4 + 1.6 * Math.sqrt(k)) * f.size);
      f.s.material.opacity = 1 - k;
    }
  }

  // ---- impacts: directional sparks + flash + expanding ground ring ----
  const IMPACTS = {
    slash: { sys: 'glow', count: 26, color: '#fff0b0', speed: [2.5, 5], cone: 0.6, size: 0.09, life: [0.2, 0.45], grav: -6, flash: '#fff3c4', ring: '#ffffff', ringSize: 0.9, ringAdd: true },
    blunt: { sys: 'glow', count: 12, color: '#ffb050', speed: [1.5, 3], cone: 1.0, size: 0.1, life: [0.25, 0.5], grav: -7, flash: '#ffd29a', ring: '#b98a5a', ringSize: 1.5, ringAdd: false, dust: 14 },
    pierce: { sys: 'glow', count: 18, color: '#ffe2a0', speed: [3, 6], cone: 0.25, size: 0.08, life: [0.18, 0.35], grav: -5, flash: '#ffffff', ring: '#ffffff', ringSize: 0.6, ringAdd: true },
    magic: { sys: 'glow', count: 24, color: '#8fd8ff', speed: [1.5, 3.5], cone: 1.2, size: 0.16, life: [0.4, 0.8], grav: 0.5, flash: '#9fe0ff', ring: '#7fd0ff', ringSize: 1.3, ringAdd: true, burst: 'magic' },
    bone: { sys: 'soft', count: 16, color: '#e8e0c8', speed: [1.5, 3], cone: 0.9, size: 0.07, life: [0.4, 0.8], grav: -8, flash: '#f5efdc', ring: '#e8e0c8', ringSize: 0.9, ringAdd: false, dust: 8 },
  };
  const ringTex = highlightTexture('ring');
  const ringGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const rings = [];
  const ringPool = [];
  const MAX_RINGS = 10;
  const dirTmp = new THREE.Vector3();
  const rndTmp = new THREE.Vector3();

  function groundRing(pos, color, size, additive) {
    if (rings.length >= MAX_RINGS) return;
    const m = ringPool.pop() || new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      map: ringTex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    m.material.color.set(color);
    m.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.material.needsUpdate = true;
    m.position.set(pos.x, groundY(pos.x, pos.z) + 0.015, pos.z);
    m.renderOrder = 7;
    root.add(m);
    rings.push({ m, t: 0, size });
  }
  function updateRings(dt) {
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.t += dt;
      const k = r.t / 0.4;
      if (k >= 1) {
        root.remove(r.m);
        ringPool.push(r.m);
        rings.splice(i, 1);
        continue;
      }
      r.m.scale.setScalar(0.25 + r.size * (1 - Math.pow(1 - k, 2)));
      r.m.material.opacity = 0.9 * (1 - k);
    }
  }

  function impact(position, direction, kind = 'slash') {
    const rc = IMPACTS[kind] || IMPACTS.slash;
    dirTmp.copy(direction && direction.lengthSq() > 1e-6 ? direction : new THREE.Vector3(0, 1, 0)).normalize();
    const base = new THREE.Color(rc.color);
    for (let i = 0; i < rc.count; i++) {
      rndTmp.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(rc.cone).add(dirTmp).normalize();
      const sp = rand(rc.speed[0], rc.speed[1]);
      tmpColor.copy(base).lerp(white, Math.random() * 0.4);
      systems[rc.sys].spawn({
        px: position.x, py: position.y, pz: position.z,
        vx: rndTmp.x * sp, vy: rndTmp.y * sp + 0.6, vz: rndTmp.z * sp,
        life: rand(rc.life[0], rc.life[1]), s0: rc.size * rand(0.7, 1.3), s1: rc.size * 0.2, a0: 1,
        r: tmpColor.r, g: tmpColor.g, b: tmpColor.b, drag: 1.2, grav: rc.grav, spin: Math.random() * 6, spinV: rand(-4, 4),
      });
    }
    if (rc.dust) burst(new THREE.Vector3(position.x, groundY(position.x, position.z), position.z), 'dust', { count: rc.dust, scale: 0.8 });
    if (rc.burst) burst(position, rc.burst, { count: 14, color: rc.color });
    impactFlash(position, new THREE.Color(rc.flash), kind === 'blunt' ? 1.2 : 0.9);
    groundRing(position, rc.ring, rc.ringSize, rc.ringAdd);
  }

  // ---- debris: physics-lite low-poly pieces that bounce on the board and fade ----
  const DEBRIS_CAP = 40;
  const boneColor = '#e6dfc9';
  function boneGeo() {
    const shaft = new THREE.CylinderGeometry(0.016, 0.016, 0.13, 5).rotateZ(Math.PI / 2);
    const knobs = [-0.065, 0.065].flatMap((x) => [-0.014, 0.014].map((z) => new THREE.SphereGeometry(0.022, 5, 4).translate(x, 0, z)));
    return mergeGeometries([shaft, ...knobs].map((g) => g.toNonIndexed()));
  }
  const debrisVariants = {
    bone: { geo: boneGeo(), mat: new THREE.MeshStandardMaterial({ color: boneColor, roughness: 0.7 }), r: 0.03 },
    rib: { geo: new THREE.TorusGeometry(0.07, 0.012, 4, 8, Math.PI), mat: null, r: 0.02 },
    skull: { geo: new THREE.SphereGeometry(0.065, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2), mat: null, r: 0.03 },
    plate: { geo: new THREE.BoxGeometry(0.12, 0.022, 0.09), mat: new THREE.MeshStandardMaterial({ color: '#9aa3ad', metalness: 0.7, roughness: 0.35 }), r: 0.015 },
    splinter: { geo: new THREE.BoxGeometry(0.16, 0.025, 0.03), mat: new THREE.MeshStandardMaterial({ color: '#8a5a30', roughness: 0.8 }), r: 0.015 },
  };
  debrisVariants.rib.mat = debrisVariants.bone.mat;
  debrisVariants.skull.mat = new THREE.MeshStandardMaterial({ color: boneColor, roughness: 0.7, side: THREE.DoubleSide });
  const DEBRIS_KINDS = { bones: ['bone', 'bone', 'rib', 'skull'], armor: ['plate'], wood: ['splinter'] };
  for (const v of Object.values(debrisVariants)) {
    v.mesh = new THREE.InstancedMesh(v.geo, v.mat, DEBRIS_CAP);
    v.mesh.count = 0;
    v.mesh.castShadow = true;
    v.mesh.frustumCulled = false;
    v.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    v.pieces = [];
    root.add(v.mesh);
  }
  const dm = new THREE.Matrix4();
  const dq = new THREE.Quaternion();
  const de = new THREE.Euler();
  const dpos = new THREE.Vector3();
  const dscale = new THREE.Vector3();

  function debris(position, { kind = 'bones', count = 10, direction } = {}) {
    const names = DEBRIS_KINDS[kind] || DEBRIS_KINDS.bones;
    const d = direction ? direction.clone().setY(0) : new THREE.Vector3();
    if (d.lengthSq() > 1e-6) d.normalize();
    for (let i = 0; i < count; i++) {
      const v = debrisVariants[names[i % names.length]];
      if (v.pieces.length >= DEBRIS_CAP) v.pieces.shift(); // recycle the oldest piece
      const a = Math.random() * Math.PI * 2;
      const hs = rand(0.6, 1.6);
      v.pieces.push({
        p: new THREE.Vector3(position.x + rand(-0.1, 0.1), position.y + rand(0, 0.25), position.z + rand(-0.1, 0.1)),
        v: new THREE.Vector3(Math.cos(a) * hs + d.x * 1.6, rand(1.5, 3.2), Math.sin(a) * hs + d.z * 1.6),
        rot: new THREE.Vector3(rand(0, 6), rand(0, 6), rand(0, 6)),
        av: new THREE.Vector3(rand(-12, 12), rand(-12, 12), rand(-12, 12)),
        age: 0,
        life: rand(2.2, 2.8),
        r: v.r,
        s: rand(0.8, 1.25),
      });
    }
  }
  function updateDebris(dt) {
    for (const v of Object.values(debrisVariants)) {
      const list = v.pieces;
      for (let i = list.length - 1; i >= 0; i--) {
        const pc = list[i];
        pc.age += dt;
        if (pc.age >= pc.life) list.splice(i, 1);
      }
      for (let i = 0; i < list.length; i++) {
        const pc = list[i];
        pc.v.y -= 9.8 * dt;
        pc.p.addScaledVector(pc.v, dt);
        pc.rot.addScaledVector(pc.av, dt);
        const floor = groundY(pc.p.x, pc.p.z) + pc.r;
        if (pc.p.y < floor) {
          pc.p.y = floor;
          if (pc.v.y < 0) pc.v.y = Math.abs(pc.v.y) < 0.6 ? 0 : -pc.v.y * 0.35;
          pc.v.x *= 0.7;
          pc.v.z *= 0.7;
          pc.av.multiplyScalar(0.6);
        }
        // shrink and sink during the last half second
        const fade = Math.min(1, (pc.life - pc.age) / 0.5);
        dpos.copy(pc.p);
        if (fade < 1) dpos.y -= (1 - fade) * 0.05;
        dq.setFromEuler(de.set(pc.rot.x, pc.rot.y, pc.rot.z));
        dm.compose(dpos, dq, dscale.setScalar(pc.s * fade));
        v.mesh.setMatrixAt(i, dm);
      }
      v.mesh.count = list.length;
      if (list.length) v.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---- decals: scorch / crack on the ground, fade after a few seconds ----
  const decalTex = { scorch: decalTexture('scorch'), crack: decalTexture('crack') };
  const decalGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const decals = [];
  const decalPool = [];
  const MAX_DECALS = 12;
  function decal(position, kind = 'scorch') {
    if (decals.length >= MAX_DECALS) decals[0].t = Math.max(decals[0].t, 3.5); // hurry the oldest out
    const m = decalPool.pop() || new THREE.Mesh(decalGeo, new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    m.material.map = decalTex[kind] || decalTex.scorch;
    m.material.needsUpdate = true;
    m.position.set(position.x, groundY(position.x, position.z) + 0.002, position.z);
    m.rotation.y = Math.random() * Math.PI * 2;
    m.scale.setScalar(kind === 'crack' ? 0.95 : 1.15);
    m.renderOrder = 1;
    root.add(m);
    decals.push({ m, t: 0 });
  }
  function updateDecals(dt) {
    for (let i = decals.length - 1; i >= 0; i--) {
      const d = decals[i];
      d.t += dt;
      if (d.t >= 5) {
        root.remove(d.m);
        decalPool.push(d.m);
        decals.splice(i, 1);
        continue;
      }
      d.m.material.opacity = Math.min(1, d.t / 0.1) * Math.min(1, (5 - d.t) / 1.5);
    }
  }

  // ---- trails: camera-facing ribbon following an object's world position ----
  const TRAIL_SAMPLES = 24;
  const MAX_TRAILS = 8;
  const trails = new Set();
  const trailPool = [];
  function makeTrailMesh() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 6), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 6), 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < TRAIL_SAMPLES - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    return mesh;
  }
  // trail(object3D, { color, width = 0.12, length = 16, life = 0.22, offset }) -> { stop() }
  function trail(object3D, { color = '#fff1c8', width = 0.12, length = 16, life = 0.22, offset = null } = {}) {
    if (trails.size >= MAX_TRAILS) [...trails][0].stopped = true;
    const job = {
      obj: object3D, mesh: trailPool.pop() || makeTrailMesh(), samples: [], stopped: false,
      color: new THREE.Color(color), width, length: Math.min(length, TRAIL_SAMPLES), life,
      offset: offset ? offset.clone() : new THREE.Vector3(),
    };
    root.add(job.mesh);
    trails.add(job);
    return { stop() { job.stopped = true; } };
  }
  const tA = new THREE.Vector3();
  const tSide = new THREE.Vector3();
  const tCam = new THREE.Vector3();
  function updateTrails(dt) {
    for (const job of [...trails]) {
      for (const s of job.samples) s.age += dt;
      if (!job.stopped && job.obj.parent) {
        job.obj.updateWorldMatrix(true, false);
        job.samples.unshift({ p: job.obj.localToWorld(job.offset.clone()), age: 0 });
      }
      while (job.samples.length > job.length || (job.samples.length && job.samples[job.samples.length - 1].age > job.life)) job.samples.pop();
      if (job.stopped && !job.samples.length) {
        trails.delete(job);
        root.remove(job.mesh);
        trailPool.push(job.mesh);
        continue;
      }
      const pos = job.mesh.geometry.attributes.position;
      const col = job.mesh.geometry.attributes.color;
      const n = job.samples.length;
      for (let i = 0; i < n; i++) {
        const s = job.samples[i];
        const prev = job.samples[Math.max(0, i - 1)].p;
        const next = job.samples[Math.min(n - 1, i + 1)].p;
        tA.subVectors(prev, next);
        if (camera) tCam.subVectors(camera.position, s.p);
        else tCam.set(0, 1, 0);
        tSide.crossVectors(tA, tCam);
        if (tSide.lengthSq() < 1e-10) tSide.set(0, 1, 0);
        const t = n > 1 ? i / (n - 1) : 0;
        tSide.normalize().multiplyScalar(job.width * 0.5 * (1 - t * 0.8));
        const f = Math.max(0, 1 - s.age / job.life) * (1 - t);
        pos.setXYZ(i * 2, s.p.x + tSide.x, s.p.y + tSide.y, s.p.z + tSide.z);
        pos.setXYZ(i * 2 + 1, s.p.x - tSide.x, s.p.y - tSide.y, s.p.z - tSide.z);
        col.setXYZ(i * 2, job.color.r * f, job.color.g * f, job.color.b * f);
        col.setXYZ(i * 2 + 1, job.color.r * f, job.color.g * f, job.color.b * f);
      }
      job.mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }
  }

  let emberClock = 0;
  function update(dt) {
    for (const job of [...active]) job.step(dt);
    updateFlashes(dt);
    updateRings(dt);
    updateDebris(dt);
    updateDecals(dt);
    updateTrails(dt);
    // a few embers rising from the torches
    emberClock += dt;
    while (emberPoints.length && emberClock > 0.09) {
      emberClock -= 0.09;
      const p = emberPoints[Math.floor(Math.random() * emberPoints.length)];
      tmpColor.set('#ffb347');
      systems.ambient.spawn({
        px: p.x + rand(-0.08, 0.08), py: p.y - 0.2, pz: p.z + rand(-0.08, 0.08),
        vx: rand(-0.15, 0.15), vy: rand(0.5, 1.0), vz: rand(-0.15, 0.15),
        life: rand(0.6, 1.1), s0: 0.06, s1: 0.01, a0: 0.9,
        r: tmpColor.r, g: tmpColor.g, b: tmpColor.b, drag: 0.6, grav: 0.2, spin: 0, spinV: 0,
      });
    }
    systems.soft.update(dt);
    systems.glow.update(dt);
    systems.ambient.update(dt);
    fxLight.intensity = flash;
    flash = Math.max(0, flash - dt * 16);
  }

  // Finish every in-flight effect and clear pools (used by skip). Decals stay and fade normally.
  function finishAll() {
    for (const job of [...active]) job.finish();
    updateFlashes(1);
    updateRings(1);
    for (const job of trails) job.stopped = true;
    updateTrails(1);
    for (const v of Object.values(debrisVariants)) v.pieces.length = 0;
    updateDebris(0);
    systems.soft.clear();
    systems.glow.clear();
    flash = 0;
    fxLight.intensity = 0;
  }

  function alive() {
    return {
      particles: systems.soft.count() + systems.glow.count(),
      trails: trails.size,
      debris: Object.values(debrisVariants).reduce((n, v) => n + v.pieces.length, 0),
      decals: decals.length,
      impacts: rings.length + flashes.length,
      projectiles: active.size,
    };
  }
  // True while anything non-ambient is animating (drives render-on-demand).
  function busy() {
    const a = alive();
    return flash > 0 || a.particles + a.trails + a.debris + a.decals + a.impacts + a.projectiles > 0;
  }

  return {
    burst, projectile, impact, debris, decal, trail, update, finishAll, alive, busy,
    particleCount: () => systems.soft.count() + systems.glow.count(),
  };
}

// Height of the surface under (x, z): board, frame, plinth tiers or arena floor.
export function groundY(x, z) {
  const m = Math.max(Math.abs(x), Math.abs(z));
  if (m <= 4.04) return 0;
  if (m <= 4.9) return 0.06;
  if (m <= 5.1) return -0.34;
  if (m <= 5.9) return -0.84;
  return -1.25;
}
