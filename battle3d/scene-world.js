// Static world for battle3d: sky, lights, board, frame + coordinates, plinth, arena floor and props.
// Board top is y = 0, one square = 1 unit, square centers at (col - 3.5, 0, row - 3.5).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  makeRng, stoneTexture, woodTexture, flagstoneTexture, labelTexture, bannerTexture, highlightTexture,
} from './scene-textures.js';

export const PALETTE = {
  lightSquare: '#efe1c2',
  darkSquare: '#74503a',
  grout: '#2e2018',
  wood: '#8a5530',
  trim: '#d8aa4c',
  stone: '#9a9084',
  stoneDark: '#6c645b',
  floor: '#8f8577',
  skyTop: '#26243f',
  skyMid: '#6a4d63',
  fog: '#7a5a55',
  hemiSky: '#ffe8c8',
  hemiGround: '#4d3b30',
  key: '#ffe0b5',
  rim: '#9fb4ff',
  torch: '#ff9a3c',
  white: { cloth: '#f3ead6', accent: '#2f5fb3', emblem: 'shield' },
  black: { cloth: '#2a2430', accent: '#e07a2a', emblem: 'skull' },
};

export const FRAME_INNER = 4.04;
export const FRAME_OUTER = 4.9;
export const FRAME_TOP = 0.06;
export const FLOOR_Y = -1.25;
const PLINTH1_TOP = -0.34;
const PLINTH2_TOP = -0.84;

export function buildWorld(scene, renderer, { lowPower = false } = {}) {
  const anisotropy = Math.min(8, renderer.capabilities?.getMaxAnisotropy?.() ?? 1);
  const occluders = []; // solid props the cinematic camera must see around
  const rng = makeRng(42);
  const updaters = [];
  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);

  // ---- sky dome + fog (horizon color == fog color so the floor fades seamlessly) ----
  scene.fog = new THREE.Fog(PALETTE.fog, 20, 55);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(140, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(PALETTE.skyTop) },
        uMid: { value: new THREE.Color(PALETTE.skyMid) },
        uHorizon: { value: new THREE.Color(PALETTE.fog) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHorizon;
        varying vec3 vDir;
        void main() {
          float h = vDir.y;
          vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.22, h));
          col = mix(col, uTop, smoothstep(0.22, 0.75, h));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  root.add(sky);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 1.15);
  root.add(hemi);

  // Key light from front-left of White so shadows fall back/right; shadow frustum hugs the plinth.
  const key = new THREE.DirectionalLight(PALETTE.key, 2.4);
  key.position.set(-5, 12, 7);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  const sm = lowPower ? 1024 : 2048;
  key.shadow.mapSize.set(sm, sm);
  const sc = key.shadow.camera;
  sc.left = -7.5;
  sc.right = 7.5;
  sc.top = 7.5;
  sc.bottom = -7.5;
  sc.near = 4;
  sc.far = 32;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  root.add(key, key.target);

  const rim = new THREE.DirectionalLight(PALETTE.rim, 0.55);
  rim.position.set(6, 7, -9);
  root.add(rim);

  // ---- board squares (two instanced meshes, beveled) ----
  const tileGeo = new RoundedBoxGeometry(0.965, 0.14, 0.965, 2, 0.028);
  const tileTex = stoneTexture({ seed: 5, veins: 3, anisotropy });
  const lightMat = new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.42, metalness: 0 });
  const darkMat = new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.5, metalness: 0 });
  const lightTiles = new THREE.InstancedMesh(tileGeo, lightMat, 32);
  const darkTiles = new THREE.InstancedMesh(tileGeo, darkMat, 32);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const col3 = new THREE.Color();
  let li = 0;
  let di = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const light = (row + col) % 2 === 0; // a1 (row 7, col 0) is dark
      // rotate each tile by a random multiple of 90 degrees so the texture does not repeat visibly
      q.setFromAxisAngle(yAxis, Math.floor(rng() * 4) * Math.PI / 2);
      m4.compose(new THREE.Vector3(col - 3.5, -0.07, row - 3.5), q, new THREE.Vector3(1, 1, 1));
      col3.set(light ? PALETTE.lightSquare : PALETTE.darkSquare).offsetHSL(0, (rng() - 0.5) * 0.04, (rng() - 0.5) * 0.05);
      const mesh = light ? lightTiles : darkTiles;
      const idx = light ? li++ : di++;
      mesh.setMatrixAt(idx, m4);
      mesh.setColorAt(idx, col3);
    }
  }
  for (const mesh of [lightTiles, darkTiles]) {
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    root.add(mesh);
  }

  const grout = new THREE.Mesh(
    new THREE.BoxGeometry(8.1, 0.24, 8.1),
    new THREE.MeshStandardMaterial({ color: PALETTE.grout, roughness: 0.9 }),
  );
  grout.position.y = -0.15;
  grout.receiveShadow = true;
  root.add(grout);

  // ---- carved wooden frame (extruded square ring with bevels) ----
  const woodTex = woodTexture({ repeat: [0.4, 0.4], anisotropy });
  const frameMat = new THREE.MeshStandardMaterial({ color: PALETTE.wood, map: woodTex, roughness: 0.55 });
  const frameGeo = new THREE.ExtrudeGeometry(squareRing(FRAME_OUTER, FRAME_INNER), {
    depth: 0.32,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 2,
    curveSegments: 1,
  });
  frameGeo.rotateX(-Math.PI / 2);
  frameGeo.translate(0, FRAME_TOP - 0.36, 0);
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.castShadow = true;
  frame.receiveShadow = true;
  root.add(frame);
  occluders.push(frame);

  // gold inlay lines on the frame top
  const trimMat = new THREE.MeshStandardMaterial({
    color: PALETTE.trim, metalness: 0.85, roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -2,
  });
  for (const [outer, inner] of [[4.2, 4.13], [4.79, 4.73]]) {
    const g = new THREE.ShapeGeometry(squareRing(outer, inner));
    g.rotateX(-Math.PI / 2);
    const trim = new THREE.Mesh(g, trimMat);
    trim.position.y = FRAME_TOP + 0.002;
    trim.receiveShadow = true;
    root.add(trim);
  }

  // ---- coordinate labels (files a-h, ranks 1-8) on all four sides ----
  const labelGeo = new THREE.PlaneGeometry(0.4, 0.4);
  const labelMats = {};
  const labelMat = (text) => {
    if (!labelMats[text]) {
      labelMats[text] = new THREE.MeshBasicMaterial({
        map: labelTexture(text), transparent: true, depthWrite: false, toneMapped: false, color: '#d9c08a',
      });
    }
    return labelMats[text];
  };
  const labels = [];
  const labelR = (4.2 + 4.73) / 2;
  const addLabel = (text, x, z) => {
    const m = new THREE.Mesh(labelGeo, labelMat(text));
    m.position.set(x, FRAME_TOP + 0.004, z);
    m.rotation.set(-Math.PI / 2, 0, 0);
    m.renderOrder = 1;
    root.add(m);
    labels.push(m);
  };
  for (let i = 0; i < 8; i++) {
    const file = 'abcdefgh'[i];
    addLabel(file, i - 3.5, labelR);
    addLabel(file, i - 3.5, -labelR);
    const rank = String(8 - i); // row i -> rank 8 - i
    addLabel(rank, -labelR, i - 3.5);
    addLabel(rank, labelR, i - 3.5);
  }
  // Rotate the glyphs in place so they read upright from the current side.
  function setLabelSide(side) {
    for (const m of labels) m.rotation.z = side === 'b' ? Math.PI : 0;
  }

  // ---- stone plinth (two tiers) ----
  const stoneTex = stoneTexture({ seed: 19, veins: 0, repeat: [2, 2], anisotropy });
  const stoneMat = new THREE.MeshStandardMaterial({ color: PALETTE.stone, map: stoneTex, roughness: 0.92 });
  const stoneDarkMat = new THREE.MeshStandardMaterial({ color: PALETTE.stoneDark, map: stoneTex, roughness: 0.95 });
  const tier1 = new THREE.Mesh(new RoundedBoxGeometry(10.2, 0.5, 10.2, 2, 0.07), stoneMat);
  tier1.position.y = PLINTH1_TOP - 0.25;
  const tier2 = new THREE.Mesh(new RoundedBoxGeometry(11.8, 0.44, 11.8, 2, 0.07), stoneDarkMat);
  tier2.position.y = PLINTH2_TOP - 0.22;
  for (const t of [tier1, tier2]) {
    t.castShadow = true;
    t.receiveShadow = true;
    root.add(t);
  }

  // ---- arena floor, ring wall and rocks ----
  const floorTex = flagstoneTexture({ repeat: [16, 16], anisotropy });
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(48, 48),
    new THREE.MeshStandardMaterial({ color: PALETTE.floor, map: floorTex, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  root.add(floor);

  const wallCount = 60;
  const wallMat = new THREE.MeshStandardMaterial({ color: '#7b7268', roughness: 1, flatShading: true });
  const wall = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), wallMat, wallCount);
  for (let i = 0; i < wallCount; i++) {
    const a = (i / wallCount) * Math.PI * 2;
    const r = 17 + (rng() - 0.5) * 0.3;
    const pillar = i % 6 === 0;
    const h = pillar ? 2.6 : 1.3 + rng() * 0.35;
    q.setFromAxisAngle(yAxis, -a + (rng() - 0.5) * 0.08);
    m4.compose(
      new THREE.Vector3(Math.cos(a) * r, FLOOR_Y + h / 2, Math.sin(a) * r),
      q,
      new THREE.Vector3(pillar ? 1.1 : 0.85, h, pillar ? 1.1 : 1.75),
    );
    wall.setMatrixAt(i, m4);
    wall.setColorAt(i, col3.set('#ffffff').offsetHSL(0, 0, (rng() - 0.5) * 0.12));
  }
  root.add(wall);

  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, wallMat, 16);
  for (let i = 0; i < 16; i++) {
    const a = rng() * Math.PI * 2;
    const r = 8 + rng() * 6;
    const s = 0.2 + rng() * 0.35;
    q.setFromEuler(new THREE.Euler(rng() * 3, rng() * 3, rng() * 3));
    m4.compose(new THREE.Vector3(Math.cos(a) * r, FLOOR_Y + s * 0.4, Math.sin(a) * r), q, new THREE.Vector3(s, s * 0.7, s));
    rocks.setMatrixAt(i, m4);
    rocks.setColorAt(i, col3.set('#ffffff').offsetHSL(0, 0, (rng() - 0.5) * 0.2));
  }
  root.add(rocks);

  // ---- torches on the plinth corners (point lights, no shadows) ----
  const ironMat = new THREE.MeshStandardMaterial({ color: '#2b2622', roughness: 0.6, metalness: 0.6 });
  const flameOuterMat = new THREE.MeshBasicMaterial({
    color: '#ff7a1f', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const flameInnerMat = new THREE.MeshBasicMaterial({
    color: '#ffe08a', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const glowMat = new THREE.SpriteMaterial({
    map: highlightTexture('glow'), color: '#ff9a3c', transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const postGeo = new THREE.CylinderGeometry(0.06, 0.09, 1.4, 6);
  const bowlGeo = new THREE.CylinderGeometry(0.21, 0.1, 0.2, 8);
  const flameGeo = new THREE.ConeGeometry(0.13, 0.42, 6);
  flameGeo.translate(0, 0.21, 0);
  const torches = [];
  const emberPoints = [];
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const g = new THREE.Group();
    g.position.set(sx * 5.5, PLINTH2_TOP, sz * 5.5);
    const post = new THREE.Mesh(postGeo, ironMat);
    post.position.y = 0.7;
    post.castShadow = true;
    const bowl = new THREE.Mesh(bowlGeo, ironMat);
    bowl.position.y = 1.45;
    bowl.castShadow = true;
    const outer = new THREE.Mesh(flameGeo, flameOuterMat);
    outer.position.y = 1.52;
    const inner = new THREE.Mesh(flameGeo, flameInnerMat);
    inner.position.y = 1.53;
    inner.scale.setScalar(0.55);
    const glow = new THREE.Sprite(glowMat);
    glow.position.y = 1.72;
    glow.scale.setScalar(1.3);
    const light = new THREE.PointLight(PALETTE.torch, lowPower ? 4 : 5.5, 8, 1.6);
    light.position.y = 1.85;
    g.add(post, bowl, outer, inner, glow, light);
    root.add(g);
    occluders.push(post, bowl);
    torches.push({ outer, inner, light, glow, base: light.intensity, phase: rng() * 10 });
    emberPoints.push(new THREE.Vector3(g.position.x, g.position.y + 1.8, g.position.z));
  }
  updaters.push((dt, t) => {
    for (const tc of torches) {
      const f = 0.82 + 0.1 * Math.sin(t * 12.7 + tc.phase) + 0.07 * Math.sin(t * 7.3 + tc.phase * 2) + 0.05 * Math.sin(t * 23.1);
      tc.light.intensity = tc.base * f;
      tc.outer.scale.set(1, 0.85 + 0.25 * f, 1);
      tc.inner.scale.set(0.55, 0.5 + 0.18 * f, 0.55);
      tc.outer.rotation.y += dt * 1.5;
      tc.glow.material.opacity = 0.45 + 0.12 * f;
    }
  });

  // ---- banners: White heroes (ivory/blue) on the +z half, Black skeletons (dark/orange) on the -z half ----
  const poleMat = new THREE.MeshStandardMaterial({ color: '#4a3020', roughness: 0.7 });
  const goldMat = new THREE.MeshStandardMaterial({ color: PALETTE.trim, metalness: 0.9, roughness: 0.3 });
  const banners = [];
  for (const team of ['white', 'black']) {
    const pal = PALETTE[team];
    const tex = bannerTexture(pal);
    const clothMat = new THREE.MeshStandardMaterial({
      map: tex, side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.85,
    });
    for (const sx of [-1, 1]) {
      const z = team === 'white' ? 2.6 : -2.6;
      const g = new THREE.Group();
      g.position.set(sx * 7.0, FLOOR_Y, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 4.4, 6), poleMat);
      pole.position.y = 2.2;
      const finial = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), goldMat);
      finial.position.y = 4.5;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.25, 6), poleMat);
      bar.rotation.z = Math.PI / 2;
      bar.position.set(0, 4.15, 0.06);
      const clothGeo = new THREE.PlaneGeometry(1.05, 2.0, 4, 10);
      clothGeo.translate(0, -1.0, 0); // hang from the top edge
      const cloth = new THREE.Mesh(clothGeo, clothMat);
      cloth.position.set(0, 4.13, 0.1);
      cloth.castShadow = true;
      g.add(pole, finial, bar, cloth);
      pole.castShadow = true;
      root.add(g);
      occluders.push(pole, cloth);
      // face toward the team's own camera side
      g.lookAt(0, FLOOR_Y, team === 'white' ? 16 : -16);
      banners.push({ geo: clothGeo, rest: Float32Array.from(clothGeo.attributes.position.array), phase: rng() * 6 });
    }
  }
  updaters.push((dt, t) => {
    for (const b of banners) {
      const pos = b.geo.attributes.position;
      const arr = pos.array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = b.rest[i];
        const y = b.rest[i + 1];
        const hang = -y / 2; // 0 at the top edge, 1 at the bottom
        arr[i + 2] = b.rest[i + 2]
          + Math.sin(t * 2.1 + y * 2.3 + b.phase) * 0.07 * hang
          + Math.sin(t * 3.3 + x * 4.0 + b.phase) * 0.025 * hang;
      }
      pos.needsUpdate = true;
    }
  });

  function update(dt, t) {
    for (const fn of updaters) fn(dt, t);
  }

  return { root, update, setLabelSide, emberPoints, occluders, keyLight: key };
}

// Outer square with a square hole, centered on the origin.
function squareRing(outer, inner) {
  const s = new THREE.Shape();
  s.moveTo(-outer, -outer);
  s.lineTo(outer, -outer);
  s.lineTo(outer, outer);
  s.lineTo(-outer, outer);
  s.closePath();
  const h = new THREE.Path();
  h.moveTo(-inner, -inner);
  h.lineTo(-inner, inner);
  h.lineTo(inner, inner);
  h.lineTo(inner, -inner);
  h.closePath();
  s.holes.push(h);
  return s;
}
