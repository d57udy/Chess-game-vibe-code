// battle3d scene: renderer, world, camera rig + director, picking, highlights, VFX, cinematics and a
// render-on-demand loop. See battle3d/CONTRACT.md ("scene.js API" and the v2 additions).
// Extensions beyond the contract are marked "extension".
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildWorld, FRAME_OUTER } from './scene-world.js';
import { createFx } from './scene-fx.js';
import { highlightTexture } from './scene-textures.js';
import { createRig } from './scene-rig.js';
import { createCinematic } from './cinematic.js';

const DEG = Math.PI / 180;
const VIEW_PHI = 45 * DEG; // classic three-quarter view, measured from straight down (+y)
const PORTRAIT_PHI = 32 * DEG; // steeper on portrait screens so the board can fill the width
const MIN_PHI = 20 * DEG;
const MAX_PHI = 70 * DEG;
const MAX_DT = 0.05;
const DEFAULT_TARGET = new THREE.Vector3(0, 0.25, 0);
const CLICK_SLOP_PX = 6;
const TOUCH_SLOP_PX = 12;
const DOUBLE_TAP_MS = 320;
const IDLE_FPS = 20;
const SLEEP_AFTER_S = 45;
const POKE_S = 0.6; // full frame rate this long after input or a game event

const HL_COLORS = {
  selected: '#ffd25e',
  hover: '#ffffff',
  lastMove: '#ffc65c',
  move: '#fff1bf',
  capture: '#ff3d2e',
  check: '#ff2a1a',
};

const EASE = {
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  out: (k) => 1 - Math.pow(1 - k, 3),
  sine: (k) => 0.5 - 0.5 * Math.cos(Math.PI * k),
  linear: (k) => k,
};

const media = (q) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);
const nowMs = () => performance.now();

// createScene(container, { debug, renderer, sleepAfter }) -> SceneAPI. `renderer` lets tests inject a fake
// (no WebGL); `sleepAfter` (seconds, default 45) lets tests shorten the no-input sleep delay.
export async function createScene(container, { debug = false, renderer: injected = null, sleepAfter = SLEEP_AFTER_S } = {}) {
  const log = (...args) => { if (debug) console.log('[scene]', ...args); };
  const reducedMotionQuery = media('(prefers-reduced-motion: reduce)');
  let reduceMotion = !!reducedMotionQuery?.matches;
  const onMotionPref = (e) => { reduceMotion = e.matches; };
  reducedMotionQuery?.addEventListener?.('change', onMotionPref);
  const coarseQuery = media('(pointer: coarse)');
  const isCoarsePointer = () => !!coarseQuery?.matches;

  const scr = globalThis.screen || { width: 1280, height: 800 };
  const lowPower = Math.min(scr.width, scr.height) < 700 || (navigator.hardwareConcurrency || 8) <= 4;

  // ---- renderer ----
  const renderer = injected || new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    // r186 removed PCFSoftShadowMap; PCFShadowMap with light.shadow.radius gives the soft look.
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  if (canvas.parentNode !== container) container.appendChild(canvas);

  // soft vignette over the canvas (pure CSS, never blocks input)
  const vignette = document.createElement('div');
  vignette.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
    + 'background:radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 55%, rgba(12,6,2,0.42) 100%);';
  container.appendChild(vignette);

  // ---- scene, environment, world ----
  const scene = new THREE.Scene();
  if (!injected) {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new RoomEnvironment();
      scene.environment = pmrem.fromScene(envScene, 0.04).texture;
      scene.environmentIntensity = 0.4;
      envScene.dispose?.();
      pmrem.dispose();
    } catch (err) {
      log('environment map skipped', err);
    }
  }
  const world = buildWorld(scene, renderer, { lowPower });
  // near plane small enough that close fight shots never clip (shots keep >= 1.5 units from units)
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
  const fx = createFx(scene, { emberPoints: world.emberPoints, camera });

  // ---- render-on-demand state ----
  const tokens = new Set();
  let renderRequested = true;
  let fullUntil = 0;
  let lastActivity = nowMs();
  let mode = 'full';
  let renderedFrames = 0;
  function noteActivity(seconds = POKE_S) {
    const n = nowMs();
    lastActivity = n;
    fullUntil = Math.max(fullUntil, n + seconds * 1000);
  }
  function requestRender() {
    renderRequested = true;
    lastActivity = nowMs();
  }
  function keepAlive(token, on) {
    if (on) {
      tokens.add(token);
      noteActivity();
    } else {
      tokens.delete(token);
      renderRequested = true;
    }
  }
  function render() {
    renderer.render(scene, camera);
    renderedFrames++;
  }

  // ---- camera rig + director ----
  const rig = createRig(camera, canvas, { minPhi: MIN_PHI, maxPhi: MAX_PHI, onInput: () => noteActivity() });
  let viewSide = 'w';
  let fitDist = 14;
  let camTween = null; // { segs: [{ to, duration, ease }], i, from, to, t, resolve }
  let scripted = false; // fight camera owns the view; the player's view is in savedView
  let savedView = null;
  let closeView = null; // double-tap zoom: { prev }
  let rigMoving = false;
  const shakeOffset = new THREE.Vector3();
  let shakeAmt = 0;
  const timers = []; // { left, resolve } on the camera clock

  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const cloneView = (v) => ({ theta: v.theta, phi: v.phi, radius: v.radius, target: v.target.clone() });
  const getView = () => rig.get();
  const isPortrait = () => camera.aspect < 1;
  const viewPhi = () => (isPortrait() ? PORTRAIT_PHI : VIEW_PHI);
  function applyView(v) {
    shakeOffset.set(0, 0, 0);
    rig.set(v);
  }
  function defaultView(side = viewSide) {
    const target = defaultTarget.clone();
    if (side === 'b') target.z = -target.z;
    return { theta: side === 'b' ? Math.PI : 0, phi: viewPhi(), radius: fitDist, target };
  }

  // Default framing. Landscape: whole frame + standing units with margins. Portrait (phones): the
  // squares fill the width (the outer frame and side labels may be cropped) and the board is centred
  // vertically by sliding the look-at target along z.
  const fitCam = new THREE.PerspectiveCamera();
  const fitCornerSets = { landscape: [], portrait: [] };
  for (const [key, E] of [['landscape', FRAME_OUTER + 0.05], ['portrait', 4.2]]) {
    for (const x of [-E, E]) for (const z of [-E, E]) for (const y of [-0.35, 1.0]) fitCornerSets[key].push(new THREE.Vector3(x, y, z));
  }
  const footprint = [];
  for (const x of [-4.9, 4.9]) for (const z of [-4.9, 4.9]) footprint.push(new THREE.Vector3(x, 0, z));
  const tmpV = new THREE.Vector3();
  let defaultTarget = DEFAULT_TARGET.clone(); // White-side target; mirrored in z for Black

  function placeFitCam(d, phi, target) {
    fitCam.position.setFromSphericalCoords(d, phi, 0).add(target);
    fitCam.lookAt(target);
    fitCam.updateMatrixWorld();
  }
  function computeFit(aspect) {
    const portrait = aspect < 1;
    const phi = portrait ? PORTRAIT_PHI : VIEW_PHI;
    const mx = portrait ? 0.99 : 0.92;
    const my = portrait ? 0.98 : 0.84;
    fitCam.fov = camera.fov;
    fitCam.aspect = aspect;
    fitCam.near = camera.near;
    fitCam.far = camera.far;
    fitCam.updateProjectionMatrix();
    const target = DEFAULT_TARGET.clone();
    const corners = fitCornerSets[portrait ? 'portrait' : 'landscape'];
    const fitDistance = () => {
      const fits = (d) => {
        placeFitCam(d, phi, target);
        for (const c of corners) {
          tmpV.copy(c).project(fitCam);
          if (Math.abs(tmpV.x) > mx || Math.abs(tmpV.y) > my || tmpV.z > 1) return false;
        }
        return true;
      };
      let lo = 3;
      let hi = 150;
      for (let i = 0; i < 28; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    let dist = fitDistance();
    if (portrait) {
      // put the board's centre at ~53% of the viewport height (NDC y = -0.06)
      for (let i = 0; i < 6; i++) {
        placeFitCam(dist, phi, target);
        let lo = Infinity;
        let hi = -Infinity;
        for (const c of footprint) {
          const y = tmpV.copy(c).project(fitCam).y;
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
        const err = (lo + hi) / 2 + 0.06;
        if (Math.abs(err) < 0.005) break;
        target.z -= err * dist * Math.tan((camera.fov * DEG) / 2) * 1.2;
        dist = fitDistance();
      }
    }
    return { dist, target };
  }

  function onCameraSettled() {
    if (!scripted) {
      rig.settle();
      rig.setEnabled(true);
    }
  }

  // Scripted camera move on the camera clock: one or more segments played back to back inside the
  // frame loop (no promise chaining, so stepFrames alone drives whole shots). duration 0 = cut.
  // A newer move releases the older promise.
  function tweenSequence(segments) {
    if (camTween) {
      const prev = camTween;
      camTween = null;
      prev.resolve();
    }
    rig.setEnabled(false);
    rig.settle();
    noteActivity();
    const segs = segments.map((sg) => ({
      to: cloneView(sg.to), duration: reduceMotion ? 0 : sg.duration || 0, ease: EASE[sg.ease] || EASE.inOut,
    }));
    return new Promise((resolve) => {
      camTween = { segs, i: -1, t: 0, resolve };
      nextSegment(camTween, 0);
    });
  }
  const tweenCamera = (to, duration, ease = 'inOut') => tweenSequence([{ to, duration, ease }]);

  // Start the next segment (cuts apply immediately); finish the tween after the last one.
  function nextSegment(tw, carry) {
    while (camTween === tw) {
      tw.i++;
      const sg = tw.segs[tw.i];
      if (!sg) {
        camTween = null;
        onCameraSettled();
        tw.resolve();
        return;
      }
      if (sg.duration > 0) {
        tw.from = getView();
        tw.t = carry;
        return;
      }
      applyView(sg.to);
    }
  }
  function finishCameraTween() {
    if (!camTween) return;
    const tw = camTween;
    camTween = null;
    applyView(tw.segs[tw.segs.length - 1].to);
    onCameraSettled();
    tw.resolve();
  }
  const tweenTarget = new THREE.Vector3();
  function updateCameraTween(dt) {
    const tw = camTween;
    if (!tw) return;
    const sg = tw.segs[tw.i];
    tw.t += dt;
    const k = Math.min(1, tw.t / sg.duration);
    const e = sg.ease(k);
    const from = tw.from;
    const to = sg.to;
    applyView({
      theta: from.theta + wrapAngle(to.theta - from.theta) * e,
      phi: from.phi + (to.phi - from.phi) * e,
      radius: from.radius + (to.radius - from.radius) * e,
      target: tweenTarget.lerpVectors(from.target, to.target, e),
    });
    if (k >= 1) nextSegment(tw, tw.t - sg.duration);
  }

  function wait(seconds) {
    return new Promise((resolve) => timers.push({ left: seconds, resolve }));
  }
  function updateTimers(dt) {
    for (let i = timers.length - 1; i >= 0; i--) {
      timers[i].left -= dt;
      if (timers[i].left <= 0) {
        const [t] = timers.splice(i, 1);
        t.resolve();
      }
    }
  }

  function beginScripted() {
    if (!scripted) {
      savedView = camTween ? cloneView(camTween.segs[camTween.segs.length - 1].to) : getView();
      scripted = true;
      rig.setEnabled(false);
      rig.settle();
    }
    noteActivity();
  }
  function endScripted(duration = 0.6) {
    if (!scripted) return Promise.resolve();
    const v = savedView || defaultView();
    savedView = null;
    scripted = false;
    return tweenCamera(v, duration);
  }

  function setView(side, { animate = true } = {}) {
    viewSide = side === 'b' ? 'b' : 'w';
    world.setLabelSide(viewSide);
    scripted = false;
    savedView = null;
    closeView = null;
    log('setView', viewSide);
    return tweenCamera(defaultView(viewSide), animate ? 1.1 : 0);
  }

  // ---- picking registry (used by cinematics for occlusion too) ----
  const proxies = new Map(); // object3D -> () => { row, col }

  // ---- cinematics ----
  let timeScale = 1;
  let slowFactor = 1;
  const rawUpdaters = new Set();
  const cine = createCinematic({
    THREE, camera, container, scene, proxies, occluders: world.occluders || [], log,
    getView, playerView: () => savedView || getView(),
    tween: tweenCamera, tweenSequence, wait, beginScripted, endScripted, isScripted: () => scripted,
    setSlowFactor: (f) => { slowFactor = f; },
    addRawUpdater: (fn) => rawUpdaters.add(fn),
    removeRawUpdater: (fn) => rawUpdaters.delete(fn),
    reducedMotion: () => reduceMotion,
    requestRender,
    fov: () => {
      const tanV = Math.tan((camera.fov * DEG) / 2);
      return { tanV, tanH: tanV * camera.aspect };
    },
  });

  function focusOn(points, { duration = 0.6, distance } = {}) {
    if (!points || !points.length) return Promise.resolve();
    beginScripted();
    return tweenCamera(cine.twoShotView(points, { distance }), duration);
  }
  const restoreView = ({ duration = 0.6 } = {}) => endScripted(duration);

  // ---- resize ----
  let wasPortrait = null;
  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const fit = computeFit(camera.aspect);
    const newFit = fit.dist;
    const oldDefault = defaultView().target;
    defaultTarget = fit.target;
    const newDefault = defaultView().target;
    // keep following the default target unless the player moved it (double-tap zoom)
    const retarget = (v) => { if (v.target.distanceTo(oldDefault) < 0.05) v.target.copy(newDefault); };
    const ratio = newFit / fitDist;
    fitDist = newFit;
    rig.limits.minRadius = fitDist * 0.4;
    rig.limits.maxRadius = fitDist * 1.25;
    const portraitChanged = wasPortrait !== isPortrait(); // also true on the first resize
    wasPortrait = isPortrait();
    if (portraitChanged) {
      // orientation flip: snap to the fitted default for the current side
      closeView = null;
      if (scripted) savedView = defaultView();
      else {
        finishCameraTween();
        applyView(defaultView());
      }
    } else {
      if (camTween) {
        if (!scripted) for (const sg of camTween.segs) sg.to.radius *= ratio;
      } else if (!scripted) {
        const v = getView();
        v.radius = THREE.MathUtils.clamp(v.radius * ratio, rig.limits.minRadius, rig.limits.maxRadius);
        retarget(v);
        applyView(v);
      }
      if (savedView) {
        savedView.radius *= ratio;
        retarget(savedView);
      }
    }
    noteActivity();
    render();
  }
  applyView(defaultView('w'));
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(container);
  } else {
    window.addEventListener('resize', resize);
  }
  resize(); // fits the default view to the container

  // ---- highlights ----
  const hlGroup = new THREE.Group();
  hlGroup.name = 'highlights';
  scene.add(hlGroup);
  const hlGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const hlTex = {
    frame: highlightTexture('frame'),
    fill: highlightTexture('fill'),
    dot: highlightTexture('dot'),
    ring: highlightTexture('ring'),
    glow: highlightTexture('glow'),
  };
  function hlMat(tex, color, opacity, additive = false) {
    return new THREE.MeshBasicMaterial({
      map: tex, color, opacity, transparent: true, depthWrite: false, toneMapped: false, fog: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
  }
  function hlMesh(mat, size, y, order) {
    const m = new THREE.Mesh(hlGeo, mat);
    m.scale.setScalar(size);
    m.position.y = y;
    m.renderOrder = order;
    m.visible = false;
    hlGroup.add(m);
    return m;
  }
  // y offsets are tiny but distinct so nothing z-fights with the board (top at y = 0) or each other
  const lastMoveMat = hlMat(hlTex.fill, HL_COLORS.lastMove, 0.3);
  const lastFrom = hlMesh(lastMoveMat, 1, 0.004, 2);
  const lastTo = hlMesh(lastMoveMat, 1, 0.004, 2);
  const checkMesh = hlMesh(hlMat(hlTex.glow, HL_COLORS.check, 0.85, true), 1.5, 0.006, 3);
  const selectedMesh = hlMesh(hlMat(hlTex.frame, HL_COLORS.selected, 1, true), 1.04, 0.008, 4);
  const hoverMesh = hlMesh(hlMat(hlTex.frame, HL_COLORS.hover, 0.4), 1.0, 0.01, 5);
  const dotMat = hlMat(hlTex.dot, HL_COLORS.move, 0.8);
  const ringMat = hlMat(hlTex.ring, HL_COLORS.capture, 0.95);
  const dots = [];
  const rings = [];
  const poolMesh = (pool, i, mat, size) => pool[i] || (pool[i] = hlMesh(mat, size, 0.012, 6));

  const hlState = { selected: null, moves: [], lastMove: null, check: null, hover: null };
  const validSq = (s) => !!s && Number.isInteger(s.row) && Number.isInteger(s.col) && s.row >= 0 && s.row < 8 && s.col >= 0 && s.col < 8;
  function place(mesh, sq) {
    mesh.visible = validSq(sq);
    if (mesh.visible) mesh.position.set(sq.col - 3.5, mesh.position.y, sq.row - 3.5);
  }

  // Omitted keys keep their previous value; pass null / [] to clear (extension of the contract).
  function setHighlights(h = {}) {
    for (const k of Object.keys(hlState)) if (h[k] !== undefined) hlState[k] = h[k];
    place(selectedMesh, hlState.selected);
    place(hoverMesh, hlState.hover);
    place(checkMesh, hlState.check);
    place(lastFrom, hlState.lastMove?.from);
    place(lastTo, hlState.lastMove?.to);
    let di = 0;
    let ri = 0;
    for (const m of hlState.moves || []) {
      if (!validSq(m)) continue;
      place(m.capture ? poolMesh(rings, ri++, ringMat, 1.0) : poolMesh(dots, di++, dotMat, 0.34), m);
    }
    for (let i = di; i < dots.length; i++) dots[i].visible = false;
    for (let i = ri; i < rings.length; i++) rings[i].visible = false;
    requestRender();
  }
  function clearHighlights() {
    setHighlights({ selected: null, moves: [], lastMove: null, check: null, hover: null });
  }
  function updateHighlights(t) {
    const p = 0.5 + 0.5 * Math.sin(t * 5);
    selectedMesh.material.opacity = 0.75 + 0.25 * p;
    checkMesh.material.opacity = 0.55 + 0.4 * p;
    checkMesh.scale.setScalar(1.35 + 0.2 * p);
    ringMat.opacity = 0.75 + 0.2 * p;
  }

  // ---- picking ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pickPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  pickPlane.name = 'pickPlane';
  scene.add(pickPlane);
  const clickCbs = [];
  const hoverCbs = [];

  function setRay(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
  }

  function pickAt(clientX, clientY) {
    setRay(clientX, clientY);
    // proxies may have moved since the last render
    for (const o of proxies.keys()) o.updateWorldMatrix(true, false);
    const hits = raycaster.intersectObjects([pickPlane, ...proxies.keys()], true);
    for (const hit of hits) {
      let o = hit.object;
      while (o && !proxies.has(o) && o !== pickPlane) o = o.parent;
      if (!o) continue;
      if (o === pickPlane) {
        const col = Math.floor(hit.point.x + 4);
        const row = Math.floor(hit.point.z + 4);
        if (row >= 0 && row < 8 && col >= 0 && col < 8) return { row, col };
        continue;
      }
      const sq = proxies.get(o)();
      if (validSq(sq)) return { row: sq.row, col: sq.col };
    }
    return null;
  }

  // Double-tap (touch): toggle a closer view centred on the tapped board point.
  function toggleCloseView(clientX, clientY) {
    if (scripted) return;
    if (closeView) {
      const prev = closeView.prev;
      closeView = null;
      tweenCamera(prev, 0.35);
      return;
    }
    setRay(clientX, clientY);
    const p = raycaster.ray.intersectPlane(boardPlane, new THREE.Vector3());
    if (!p) return;
    p.x = THREE.MathUtils.clamp(p.x, -3, 3);
    p.z = THREE.MathUtils.clamp(p.z, -3, 3);
    p.y = DEFAULT_TARGET.y;
    const cur = getView();
    closeView = { prev: cur };
    tweenCamera({ theta: cur.theta, phi: cur.phi, radius: Math.max(rig.limits.minRadius, fitDist * 0.5), target: p }, 0.35);
  }

  let down = null; // { id, x, y, type, multi }
  const activePointers = new Set();
  let hoverPos = null;
  let hoverDirty = false;
  let hoverSq = null;
  let lastTap = null;

  function onPointerDown(e) {
    noteActivity();
    activePointers.add(e.pointerId);
    if (activePointers.size > 1) {
      if (down) down.multi = true;
      return;
    }
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, multi: false };
  }
  function onPointerUp(e) {
    activePointers.delete(e.pointerId);
    const d = down;
    if (!d || d.id !== e.pointerId) return;
    down = null;
    noteActivity();
    const slop = d.type === 'touch' ? TOUCH_SLOP_PX : CLICK_SLOP_PX;
    if (d.multi || Math.hypot(e.clientX - d.x, e.clientY - d.y) > slop) return; // a drag (orbit/zoom)
    if (d.type === 'touch') {
      const t = nowMs();
      if (lastTap && t - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = null;
        toggleCloseView(e.clientX, e.clientY); // the second tap does not click
        return;
      }
      lastTap = { t, x: e.clientX, y: e.clientY };
    }
    const sq = pickAt(e.clientX, e.clientY);
    log('click', sq);
    if (sq) for (const cb of clickCbs) cb(sq.row, sq.col);
  }
  function onPointerCancel(e) {
    activePointers.delete(e.pointerId);
    if (down && down.id === e.pointerId) down = null;
  }
  function onPointerMove(e) {
    if (e.pointerType === 'touch') return;
    hoverPos = { x: e.clientX, y: e.clientY };
    hoverDirty = true;
    noteActivity();
  }
  function onPointerLeave() {
    hoverPos = null;
    hoverDirty = true;
    noteActivity();
  }
  function updateHover() {
    hoverDirty = false;
    const sq = hoverPos && !down ? pickAt(hoverPos.x, hoverPos.y) : null;
    if ((sq?.row ?? null) === (hoverSq?.row ?? null) && (sq?.col ?? null) === (hoverSq?.col ?? null)) return;
    hoverSq = sq;
    for (const cb of hoverCbs) cb(sq ? sq.row : null, sq ? sq.col : null);
  }
  const onKey = () => noteActivity();
  const onVisibility = () => { if (!document.hidden) noteActivity(); };
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);

  // ---- loop ----
  const updaters = new Set();
  let time = 0;
  let paused = false;
  let rafId = 0;
  let last = nowMs();
  let idleAcc = 0;

  function shake(strength = 1) {
    if (reduceMotion) return;
    shakeAmt = Math.min(0.35, shakeAmt + 0.08 * strength);
    noteActivity();
  }

  // One simulation + render step. Clocks: raw (cinematic fades / slow-mo), camera (raw * timeScale),
  // game (camera * slow-mo factor) which updaters receive.
  function frame(rawDt, doRender = true) {
    const raw = Math.min(Math.max(rawDt, 0), MAX_DT);
    const camDt = raw * timeScale;
    for (const fn of [...rawUpdaters]) fn(raw);
    const dt = camDt * slowFactor;
    time += dt;
    camera.position.sub(shakeOffset);
    shakeOffset.set(0, 0, 0);

    for (const fn of [...updaters]) {
      try {
        fn(dt, time);
      } catch (err) {
        console.error('[scene] updater failed', err);
      }
    }
    world.update(dt, time);
    fx.update(dt);
    updateHighlights(time);
    updateTimers(camDt);
    updateCameraTween(camDt);
    rigMoving = !camTween && !scripted ? rig.update(camDt) : false;

    if (shakeAmt > 0.002) {
      shakeOffset.set(
        Math.sin(time * 47.3) + Math.sin(time * 91.1) * 0.5,
        Math.sin(time * 53.7 + 1.3) + Math.sin(time * 83.9) * 0.5,
        Math.sin(time * 61.1 + 2.1) * 0.5,
      ).multiplyScalar(shakeAmt * 0.5);
      camera.position.add(shakeOffset);
      shakeAmt *= Math.exp(-dt * 7);
    } else {
      shakeAmt = 0;
    }

    if (hoverDirty) updateHover();
    if (doRender) {
      render();
      renderRequested = false;
    }
  }

  const hasActiveToken = () => [...tokens].some((t) => t !== 'idle');
  function wantsFullRate() {
    return hasActiveToken() || renderRequested || !!camTween || rigMoving || rig.isDragging() || fx.busy()
      || shakeAmt > 0 || cine.isSlow() || cine.isFading() || timers.length > 0 || nowMs() < fullUntil;
  }

  // Render-on-demand: full rate while something moves, ~20 fps for idle animation, nothing after
  // 45 s without input or game events, nothing while the tab is hidden.
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const raw = (now - last) / 1000;
    last = now;
    if (paused || document.hidden) return;
    if (wantsFullRate()) {
      if (hasActiveToken()) lastActivity = nowMs();
      mode = 'full';
      idleAcc = 0;
      frame(raw);
      return;
    }
    if (nowMs() - lastActivity > sleepAfter * 1000) {
      mode = 'sleep';
      return;
    }
    mode = 'idle';
    idleAcc += raw;
    if (idleAcc >= 1 / IDLE_FPS - 0.004) {
      frame(idleAcc);
      idleAcc = 0;
    }
  }
  if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(loop);

  // Debug/test: advance n frames synchronously (works in hidden tabs, independent of rAF).
  function stepFrames(n = 1, dt = 1 / 60) {
    for (let i = 0; i < n; i++) frame(dt, i === n - 1);
  }

  // Skip: finish every effect and any fight shot instantly; the camera snaps back to the player's
  // view, letterbox off, slow motion off.
  function skipEffects() {
    finishCameraTween();
    cine.reset();
    cine.letterbox(false);
    if (scripted) endScripted(0);
    fx.finishAll();
    for (const t of timers.splice(0)) t.resolve();
    shakeAmt = 0;
    camera.position.sub(shakeOffset);
    shakeOffset.set(0, 0, 0);
    requestRender();
  }

  function stats() {
    const v = getView();
    return {
      renderedFrames,
      mode,
      activeTokens: [...tokens],
      fxAlive: fx.alive(),
      camera: { position: camera.position.toArray(), target: v.target.toArray(), scripted, tweening: !!camTween },
      timeScale,
      slowFactor,
    };
  }

  function dispose() {
    cancelAnimationFrame?.(rafId);
    ro?.disconnect();
    window.removeEventListener('resize', resize);
    reducedMotionQuery?.removeEventListener?.('change', onMotionPref);
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    rig.dispose();
    cine.dispose();
    renderer.dispose?.();
    canvas.remove();
    vignette.remove();
  }

  log('ready', { lowPower, fitDist: fitDist.toFixed(2), injected: !!injected });

  return {
    THREE,
    scene,
    camera,
    renderer,
    squareToWorld: (row, col) => new THREE.Vector3(col - 3.5, 0, row - 3.5),
    worldToSquare(v) { // extension
      const col = Math.floor(v.x + 4);
      const row = Math.floor(v.z + 4);
      return row >= 0 && row < 8 && col >= 0 && col < 8 ? { row, col } : null;
    },
    onSquareClick(cb) {
      clickCbs.push(cb);
      return () => clickCbs.splice(clickCbs.indexOf(cb) >>> 0, 1);
    },
    onSquareHover(cb) {
      hoverCbs.push(cb);
      return () => hoverCbs.splice(hoverCbs.indexOf(cb) >>> 0, 1);
    },
    registerPickProxy(object3D, getSquare) { proxies.set(object3D, getSquare); },
    unregisterPickProxy(object3D) { proxies.delete(object3D); },
    pickAt, // extension: (clientX, clientY) -> { row, col } | null
    setHighlights,
    clearHighlights, // extension
    setView,
    getViewSide: () => viewSide, // extension
    focusOn,
    restoreView,
    cinematic: { shot: cine.shot, slowMo: cine.slowMo, letterbox: cine.letterbox, end: cine.end },
    isCameraBusy: () => !!camTween, // extension
    isFocused: () => scripted, // extension
    addUpdater(fn) { updaters.add(fn); },
    removeUpdater(fn) { updaters.delete(fn); },
    setTimeScale(s) { timeScale = Math.max(0, Number(s) || 0); },
    getTimeScale: () => timeScale,
    getTime: () => time, // extension: scaled scene clock in seconds
    shake,
    burst: fx.burst,
    projectile: fx.projectile,
    fx: {
      trail: fx.trail,
      impact: fx.impact,
      debris: fx.debris,
      decal: fx.decal,
      burst: fx.burst,
      projectile: fx.projectile,
    },
    skipEffects, // extension
    particleCount: fx.particleCount, // extension (debug)
    requestRender,
    keepAlive,
    isCoarsePointer,
    stats, // extension (debug/QA)
    stepFrames,
    setPaused(p) { paused = !!p; last = nowMs(); },
    isPaused: () => paused,
    render, // extension
    dispose, // extension
  };
}
