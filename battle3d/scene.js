// battle3d scene: renderer, world, camera rig + director, picking, highlights, VFX, cinematics and a
// render-on-demand loop. See battle3d/CONTRACT.md ("scene.js API" and the v2 additions).
// Extensions beyond the contract are marked "extension".
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildWorld, FRAME_OUTER } from './scene-world.js';
import { createFx, createHint } from './scene-fx.js';
import { highlightTexture } from './scene-textures.js';
import { createRig } from './scene-rig.js';
import { createCinematic } from './cinematic.js';
import { createBubbles } from './bubbles.js';

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
  move: '#ffc83d', // a full gold: the old pale '#fff1bf' vanished on the light squares
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
  const hint = createHint(scene);

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
  // pan clamp: board half-width (4) plus about one square
  const rig = createRig(camera, canvas, { minPhi: MIN_PHI, maxPhi: MAX_PHI, panLimit: 5, onInput: () => noteActivity() });
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

  // Back to the fitted default for the current side (undoes pan, zoom, orbit and the double-tap zoom).
  // During a fight shot it replaces the stored player view instead, so end() lands on the default.
  function resetView({ animate = true } = {}) {
    closeView = null;
    if (scripted) {
      savedView = defaultView();
      return Promise.resolve();
    }
    return tweenCamera(defaultView(), animate ? 0.6 : 0);
  }
  // Pan offset of the player's view target from the side's default target (debug/tests).
  function getPan() {
    const t = (scripted && savedView ? savedView : getView()).target;
    const d = defaultView().target;
    return { x: t.x - d.x, z: t.z - d.z };
  }

  // ---- picking registry (used by cinematics for occlusion too) ----
  const proxies = new Map(); // object3D -> () => { row, col }
  const proxyBodies = new Map(); // object3D -> the unit as drawn (Object3D), when the unit registered one

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

  // ---- speech bubbles (talking kings) ----
  const bubbles = createBubbles({
    container, camera,
    isLetterboxed: () => cine.isLetterboxed(),
    reducedMotion: () => reduceMotion,
  });
  // say({ side, text, square | unitWorldPos | anchor | target, durationMs, name, showInCinematic }) -> Promise
  function say(opts) {
    noteActivity();
    return bubbles.say(opts);
  }
  function sayClear(side) {
    bubbles.clear(side);
    requestRender();
  }
  function clearSpeech() {
    bubbles.clearNow();
    requestRender();
  }

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
    bubbles?.onResize();
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
    target: highlightTexture('target'),
    outline: highlightTexture('outline'),
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
  // en passant: the captured pawn's square is neither from nor to, so it gets its own (red) frame
  const lastCaptured = hlMesh(hlMat(hlTex.frame, HL_COLORS.capture, 0.7), 1, 0.005, 2);
  lastCaptured.name = 'last-captured';
  const checkMesh = hlMesh(hlMat(hlTex.glow, HL_COLORS.check, 0.85, true), 1.5, 0.006, 3);
  const selectedMesh = hlMesh(hlMat(hlTex.frame, HL_COLORS.selected, 1, true), 1.04, 0.008, 4);
  const hoverMesh = hlMesh(hlMat(hlTex.frame, HL_COLORS.hover, 0.4), 1.0, 0.01, 5);
  // The dot of an offered empty square is drawn over everything (no depth test): a figure standing in front
  // of the square, or its label, must not hide it. A click on it plays the move (pickAt reports `marker`).
  const DOT_SIZE = 0.4;
  const dotMat = hlMat(hlTex.target, HL_COLORS.move, 0.95);
  dotMat.depthTest = false;
  const ringMat = hlMat(hlTex.ring, HL_COLORS.capture, 0.95);
  // while a pawn that can take en passant is selected: the pawn it would remove (same frame as after the move)
  const victimMesh = hlMesh(hlMat(hlTex.frame, HL_COLORS.capture, 0.7), 1, 0.005, 2);
  victimMesh.name = 'capture-victim';
  const dots = [];
  const rings = [];
  const outlines = [];
  const poolMesh = (pool, i, mat, size) => pool[i] || (pool[i] = hlMesh(mat, size, 0.012, 6));
  // A unit in front hides the middle of the square behind it, dot included: every offered empty square also
  // gets a soft outline that reaches its visible part. (Order 5.5: the targets themselves are the order 6 meshes.)
  const outlineMat = hlMat(hlTex.outline, HL_COLORS.move, 0.7);
  const outlineMesh = (i) => outlines[i] || (outlines[i] = hlMesh(outlineMat, 0.94, 0.011, 5.5));

  const hlState = { selected: null, moves: [], lastMove: null, check: null, hover: null, victim: null };
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
    place(lastCaptured, hlState.lastMove?.captured);
    place(victimMesh, hlState.victim);
    let di = 0;
    let ri = 0;
    for (const m of hlState.moves || []) {
      if (!validSq(m)) continue;
      if (!m.capture) place(outlineMesh(di), m);
      place(m.capture ? poolMesh(rings, ri++, ringMat, 1.0) : poolMesh(dots, di++, dotMat, DOT_SIZE), m);
    }
    for (let i = di; i < dots.length; i++) dots[i].visible = false;
    for (let i = di; i < outlines.length; i++) outlines[i].visible = false;
    for (let i = ri; i < rings.length; i++) rings[i].visible = false;
    requestRender();
  }
  // Move hint arrow. It stays through camera moves and view changes; the pulse runs at the idle
  // frame rate (no keepAlive token), and is static under reduced motion.
  function setHint(h) {
    hint.set(h);
    requestRender();
  }

  // Review arrows: several at once, told apart by colour AND shape. 'better' looks like the hint
  // (solid gold, pulsing); 'played' is a dimmer, thinner, dashed steel-blue arrow with a hollow head
  // and a smaller square outline. Arrows that share a square are shifted sideways so neither hides
  // the other. Independent of setHint. Renders synchronously (no rAF needed).
  const ARROW_STYLES = {
    better: { name: 'arrow-better', yOffset: 0.004, order: 9 },
    played: {
      name: 'arrow-played', yOffset: -0.004, order: 7, dashed: true, pulse: false, alpha: 0.85,
      color: '#6ea8e6', captureColor: '#6ea8e6', halfW: 0.085, headW: 0.22, glow: 0.42,
    },
  };
  const arrowPools = { better: [], played: [] };
  let arrowState = [];
  const sameSq = (p, q) => p.row === q.row && p.col === q.col;
  function setArrows(list) {
    const arrows = (Array.isArray(list) ? list : [])
      .filter((a) => a && validSq(a.from) && validSq(a.to) && !sameSq(a.from, a.to))
      .map((a) => ({ from: { row: a.from.row, col: a.from.col }, to: { row: a.to.row, col: a.to.col }, kind: a.kind === 'played' ? 'played' : 'better', capture: !!a.capture }));
    const used = { better: 0, played: 0 };
    arrows.forEach((a, i) => {
      const shares = arrows.some((o, j) => j !== i && (sameSq(o.from, a.from) || sameSq(o.to, a.to)));
      // better goes left of its line, played right; a second arrow of the same kind alternates
      const sign = (a.kind === 'better' ? 1 : -1) * (used[a.kind] % 2 ? -1 : 1);
      const pool = arrowPools[a.kind];
      const mesh = pool[used[a.kind]] || (pool[used[a.kind]] = createHint(scene, ARROW_STYLES[a.kind]));
      used[a.kind]++;
      mesh.set(a, { offset: shares ? 0.16 * sign : 0 });
      mesh.update(time, reduceMotion);
    });
    for (const kind of Object.keys(arrowPools)) {
      for (let i = used[kind]; i < arrowPools[kind].length; i++) arrowPools[kind][i].set(null);
    }
    arrowState = arrows;
    requestRender();
    render(); // show it now, also in a background tab where rAF is throttled
  }
  const clearArrows = () => setArrows([]);

  function clearHighlights() {
    setHighlights({ selected: null, moves: [], lastMove: null, check: null, hover: null, victim: null });
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

  // The square under the pointer: a unit's pick proxy wins over the board behind it. A proxy is larger than
  // the figure (easy to hit on a touch screen) and so also covers the middle of the square behind it. With
  // `detail` the result says what the pointer really is on: `ground` is the board square on the same ray (or
  // null off the board), `figure` is the square of the nearest unit whose own meshes the ray meets (or null
  // when it only passes proxies), and `marker` is the offered empty square whose move dot the pointer is on
  // (the dot is drawn over figures and labels, so it can be clicked wherever it shows).
  function pickAt(clientX, clientY, detail = false) {
    setRay(clientX, clientY);
    // proxies may have moved since the last render
    for (const o of proxies.keys()) o.updateWorldMatrix(true, false);
    const hits = raycaster.intersectObjects([pickPlane, ...proxies.keys()], true);
    const boardSquare = (hit) => {
      const col = Math.floor(hit.point.x + 4);
      const row = Math.floor(hit.point.z + 4);
      return row >= 0 && row < 8 && col >= 0 && col < 8 ? { row, col } : null;
    };
    let picked = null;
    const units = []; // [proxy, square] of every unit whose proxy the ray meets, nearest first
    for (const hit of hits) {
      let o = hit.object;
      while (o && !proxies.has(o) && o !== pickPlane) o = o.parent;
      if (!o) continue;
      if (o === pickPlane) {
        picked = picked || boardSquare(hit);
        break; // nothing behind the board counts
      }
      const sq = proxies.get(o)();
      if (!validSq(sq)) continue;
      picked = picked || { row: sq.row, col: sq.col };
      if (!detail) break;
      if (!units.some(([p]) => p === o)) units.push([o, sq]);
    }
    if (!picked || !detail) return picked;
    const plane = hits.find((h) => h.object === pickPlane);
    let marker = null;
    if (plane) {
      for (const m of hlState.moves || []) {
        if (m.capture || !validSq(m) || Math.hypot(plane.point.x - (m.col - 3.5), plane.point.z - (m.row - 3.5)) > DOT_SIZE / 2) continue;
        marker = { row: m.row, col: m.col };
        break;
      }
    }
    let figure = null;
    let nearest = Infinity;
    for (const [proxy, sq] of units) {
      const d = figureDistance(proxy);
      if (d < nearest) { nearest = d; figure = { row: sq.row, col: sq.col }; }
    }
    return { ...picked, ground: plane ? boardSquare(plane) : null, figure, marker };
  }

  // Distance along the current ray to the unit as drawn (its meshes in their current pose), Infinity when
  // the ray only meets its proxy. Labels (sprites) do not count: they float above the head, over the square
  // behind. A unit that registered no body counts as hit where its proxy is.
  function figureDistance(proxy) {
    const body = proxyBodies.get(proxy);
    if (!body) return raycaster.intersectObject(proxy, false)[0]?.distance ?? Infinity;
    const parts = [];
    body.updateWorldMatrix(true, false);
    body.updateMatrixWorld(true); // also refreshes the bind matrices of skinned meshes (updateWorldMatrix does not)
    body.traverseVisible((o) => {
      if (!o.isMesh || proxies.has(o)) return;
      if (o.isSkinnedMesh) o.computeBoundingSphere(); // the cached sphere belongs to an earlier pose
      parts.push(o);
    });
    return raycaster.intersectObjects(parts, false)[0]?.distance ?? Infinity;
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
    const sq = pickAt(e.clientX, e.clientY, true);
    log('click', sq);
    if (sq) for (const cb of clickCbs) cb(sq.row, sq.col, { ground: sq.ground, figure: sq.figure, marker: sq.marker });
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
    hint.update(time, reduceMotion);
    for (const pool of Object.values(arrowPools)) for (const a of pool) a.update(time, reduceMotion);
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

    bubbles.update(camDt); // after the camera settled for this frame
    if (hoverDirty) updateHover();
    if (doRender) {
      render();
      renderRequested = false;
    }
  }

  const hasActiveToken = () => [...tokens].some((t) => t !== 'idle');
  function wantsFullRate() {
    return hasActiveToken() || renderRequested || !!camTween || rigMoving || rig.isDragging() || fx.busy() || bubbles.animating()
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
  // n is rounded up to whole frames and the last one always renders (step(1 / 30) once left the canvas stale).
  function stepFrames(n = 1, dt = 1 / 60) {
    const count = Math.max(1, Math.ceil(Number(n) || 1));
    for (let i = 0; i < count; i++) frame(dt, i === count - 1);
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
      hint: hint.get(),
      arrows: arrowState,
      bubbles: bubbles.active(),
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
    bubbles.dispose();
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
    // body (optional): the unit as drawn, so a click can tell the figure from the larger proxy around it
    registerPickProxy(object3D, getSquare, body = null) {
      proxies.set(object3D, getSquare);
      if (body) proxyBodies.set(object3D, body); else proxyBodies.delete(object3D);
    },
    unregisterPickProxy(object3D) { proxies.delete(object3D); proxyBodies.delete(object3D); },
    pickAt, // extension: (clientX, clientY, detail?) -> { row, col } | null; detail adds { ground, figure, marker }
    setHighlights,
    clearHighlights, // extension
    setHint,
    say,
    sayClear,
    clearSpeech,
    // a fight shot owns the camera (between the first shot / focusOn and end / restoreView) or the letterbox is up
    isCinematicActive: () => scripted || cine.isLetterboxed(),
    getBubble: (side) => bubbles.get(side), // extension (tests)
    getHint: () => hint.get(), // extension (tests)
    setArrows,
    clearArrows,
    getArrows: () => arrowState.map((a) => ({ ...a })), // tests
    // colours and shape of an arrow kind, for a matching legend in the UI
    arrowStyle(kind) {
      const st = ARROW_STYLES[kind === 'played' ? 'played' : 'better'];
      return { color: st.color || '#ffc83d', captureColor: st.captureColor || '#ff4a2e', dashed: !!st.dashed, hollowHead: !!st.dashed };
    },
    setView,
    getViewSide: () => viewSide, // extension
    resetView,
    getPan,
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
