// Fight cinematography for battle3d: camera shots that frame subjects without occluders, slow motion,
// letterbox bars and a clean return to the player's view. Created by scene.js (sceneAPI.cinematic).
//
// Views are spherical around a target: { theta, phi, radius, target }, theta = 0 looks from +z (White side).
import * as THREE from 'three';

const DEG = Math.PI / 180;
const UNIT_MID = 0.45; // about half a unit's height
const UNIT_H = 0.95; // a unit incl. hat / weapon
const MIN_EYE_DIST = 1.6 * UNIT_H; // never closer than this to any unit
const MAX_FRAC = 0.45; // max projected unit height as a fraction of the view height
const NEAR_FRAC = 0.3; // the foreground caster in an over-shoulder shot
const SUBJECT_RADIUS = 0.45; // proxies this close to a subject belong to that subject
const MIN_EYE_Y = 0.35;

export function createCinematic(ctx) {
  const { camera, container, proxies, log = () => {} } = ctx;
  const occluders = ctx.occluders || [];
  const probe = new THREE.PerspectiveCamera();
  const raycaster = new THREE.Raycaster();
  const tmp = new THREE.Vector3();
  const proxyPos = new THREE.Vector3();
  let shotId = 0;

  // ---- overlays: letterbox bars and a fade layer (used instead of cuts under reduced motion) ----
  const mk = (css) => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:0;right:0;pointer-events:none;background:#000;z-index:1;${css}`;
    container.appendChild(d);
    return d;
  };
  const barTop = mk('top:0;height:9%;transform:translateY(-100%);transition:transform 0.35s ease;');
  const barBottom = mk('bottom:0;height:9%;transform:translateY(100%);transition:transform 0.35s ease;');
  const fadeEl = mk('top:0;bottom:0;opacity:0;');
  let fade = 0;
  let fadeJob = null;

  function letterbox(on) {
    const t = ctx.reducedMotion() ? 'none' : 'transform 0.35s ease';
    barTop.style.transition = barBottom.style.transition = t;
    barTop.style.transform = on ? 'translateY(0)' : 'translateY(-100%)';
    barBottom.style.transform = on ? 'translateY(0)' : 'translateY(100%)';
    ctx.requestRender?.();
  }

  // Fade layer driven by the scene clock so stepFrames controls it too. onDone runs synchronously
  // inside the frame (no promise hops), so whole fade sequences progress under stepFrames.
  function fadeTo(alpha, duration, onDone = () => {}) {
    if (fadeJob) fadeJob.resolve();
    fadeJob = { from: fade, to: alpha, t: 0, duration, resolve: onDone };
    if (!(duration > 0)) step(0);
  }
  function step(dt) {
    if (!fadeJob) return;
    const j = fadeJob;
    j.t += dt;
    const k = j.duration > 0 ? Math.min(1, j.t / j.duration) : 1;
    fade = j.from + (j.to - j.from) * k;
    fadeEl.style.opacity = String(fade);
    if (k >= 1) {
      fadeJob = null;
      j.resolve();
    }
  }
  ctx.addRawUpdater(step);

  // ---- slow motion (raw clock; scales global time via the scene's slow factor) ----
  let slowJob = null;
  function slowMo(scale = 0.25, duration = 0.35) {
    if (slowJob) slowJob.finish();
    return new Promise((resolve) => {
      const job = { t: 0 };
      job.finish = () => {
        if (slowJob !== job) return;
        slowJob = null;
        ctx.removeRawUpdater(job.step);
        ctx.setSlowFactor(1);
        resolve();
      };
      job.step = (dt) => {
        job.t += dt;
        const easeIn = Math.min(1, job.t / 0.06);
        const easeOut = Math.min(1, Math.max(0, (duration - job.t) / 0.12));
        ctx.setSlowFactor(1 + (scale - 1) * Math.min(easeIn, easeOut));
        if (job.t >= duration) job.finish();
      };
      slowJob = job;
      ctx.addRawUpdater(job.step);
    });
  }

  // ---- occlusion ----
  function eyeOf(v) {
    return new THREE.Vector3().setFromSphericalCoords(v.radius, v.phi, v.theta).add(v.target);
  }
  function viewFromEye(eye, target) {
    const s = new THREE.Spherical().setFromVector3(tmp.subVectors(eye, target));
    return { theta: s.theta, phi: s.phi, radius: s.radius, target: target.clone() };
  }
  // Solid things to see around: world props, other units' proxies, and tall unit accessories
  // (objects flagged userData.b3dTall, e.g. banners) that do not belong to a subject.
  const nearSubject = (pos, subjects) => subjects.some((q) => Math.hypot(q.x - pos.x, q.z - pos.z) < SUBJECT_RADIUS);
  function occluderList(subjects) {
    const objs = [...occluders];
    for (const o of proxies.keys()) {
      o.getWorldPosition(proxyPos);
      if (!nearSubject(proxyPos, subjects)) objs.push(o);
    }
    ctx.scene?.traverse((o) => {
      if (!o.userData?.b3dTall || !o.visible) return;
      o.getWorldPosition(proxyPos);
      if (!nearSubject(proxyPos, subjects)) objs.push(o);
    });
    return objs;
  }

  // Number of blocked sight lines from eye. Infinity for invalid eyes.
  function blockedCount(eye, sights, objs) {
    if (eye.y < MIN_EYE_Y) return Infinity;
    const m = Math.max(Math.abs(eye.x), Math.abs(eye.z));
    if (m > 3.9 && m < 5.3 && eye.y < 0.6) return Infinity; // inside / skimming the frame
    let n = 0;
    for (const p of sights) {
      const dir = tmp.subVectors(p, eye);
      const len = dir.length();
      raycaster.set(eye, dir.normalize());
      raycaster.far = Math.max(0, len - 0.3);
      if (raycaster.intersectObjects(objs, true).length) n++;
    }
    return n;
  }

  // Unit centres (mid-height) of every unit on the board: subjects plus all registered proxies.
  function unitCentres(subjects) {
    const pts = subjects.map((q) => ({ p: q.clone().setY(q.y + UNIT_MID), subject: true, q }));
    for (const o of proxies.keys()) {
      o.getWorldPosition(proxyPos);
      if (nearSubject(proxyPos, subjects)) continue;
      const p = proxyPos.clone();
      if (p.y < 0.3) p.y += UNIT_MID; // proxy origin at the feet
      pts.push({ p, subject: false });
    }
    return pts;
  }

  // Framing rules: the eye keeps MIN_EYE_DIST from every unit, and no unit in frame is taller than
  // MAX_FRAC of the view (nearLimit for subjects[nearIndex], the over-shoulder caster).
  function framingOk(view, centres, { nearIndex = -1, nearLimit = NEAR_FRAC } = {}) {
    const eye = eyeOf(view);
    probe.fov = camera.fov;
    probe.aspect = camera.aspect;
    probe.near = 0.05;
    probe.far = 200;
    probe.updateProjectionMatrix();
    probe.position.copy(eye);
    probe.lookAt(view.target);
    probe.updateMatrixWorld();
    const { tanV } = ctx.fov();
    for (let i = 0; i < centres.length; i++) {
      const { p } = centres[i];
      if (eye.distanceTo(p) < MIN_EYE_DIST) return false;
      const ndc = tmp.copy(p).project(probe);
      if (ndc.z > 1 || Math.abs(ndc.x) > 1.15 || Math.abs(ndc.y) > 1.15) continue; // out of frame
      const depth = -tmp.copy(p).applyMatrix4(probe.matrixWorldInverse).z;
      const frac = UNIT_H / (2 * depth * tanV);
      if (frac > (i === nearIndex ? nearLimit : MAX_FRAC)) return false;
    }
    return true;
  }

  // Candidate search: views that satisfy the framing rules, first clear one wins, else the least
  // blocked. If nothing frames well, the generator is retried further out.
  function pick(gen, sights, subjects, framing = {}) {
    for (const o of proxies.keys()) o.updateWorldMatrix(true, false);
    const objs = occluderList(subjects);
    const centres = unitCentres(subjects);
    let fallback = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidates = gen(Math.pow(1.25, attempt));
      let best = null;
      let bestN = Infinity;
      for (const v of candidates) {
        if (!framingOk(v, centres, framing)) continue;
        const n = blockedCount(eyeOf(v), sights, objs);
        if (n === 0) return v;
        if (n < bestN) {
          bestN = n;
          best = v;
        }
      }
      if (best) return best;
      fallback = fallback || candidates[0];
    }
    return fallback;
  }
  const sightsFor = (points) => points.flatMap((q) => [q.clone().setY(q.y + 0.15), q.clone().setY(q.y + 0.6)]);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const closeness = (a, b) => Math.abs(wrap(a - b));

  // ---- shot builders ----
  function twoShotView(points, { distance } = {}) {
    const center = new THREE.Vector3();
    for (const p of points) center.add(p);
    center.divideScalar(points.length);
    center.y = Math.max(...points.map((p) => p.y)) + UNIT_MID;
    let span = 0;
    for (const a of points) for (const b of points) span = Math.max(span, Math.hypot(a.x - b.x, a.z - b.z));
    const base = ctx.playerView().theta;
    let perps = [base];
    if (points.length >= 2 && span > 0.05) {
      const a = points[0];
      const b = points[points.length - 1];
      const axis = Math.atan2(b.x - a.x, b.z - a.z);
      perps = [axis + Math.PI / 2, axis - Math.PI / 2].sort((x, y) => closeness(x, base) - closeness(y, base));
    }
    const { tanV, tanH } = ctx.fov();
    // a unit fills ~45% of the view height; both subjects fit horizontally
    const radius = distance > 0 ? distance : Math.max((span / 2 + 0.55) / (tanH * 0.9), UNIT_H / (2 * MAX_FRAC * tanV), 2.2);
    // long pairs: start a bit higher so the line of sight clears the units in between
    const phis = (span > 2.5 ? [48, 41, 34, 28] : [55, 48, 41, 34, 28]).map((d) => d * DEG);
    const gen = (k) => {
      const candidates = [];
      for (const p of perps) {
        for (const off of [0, 20 * DEG, -20 * DEG]) {
          for (const phi of phis) candidates.push({ theta: p + off, phi, radius: radius * k, target: center });
        }
      }
      return candidates;
    };
    return pick(gen, [center, ...sightsFor(points)], points);
  }

  function closeupView(p) {
    const target = p.clone().setY(p.y + UNIT_MID);
    const base = ctx.playerView().theta;
    const radius = UNIT_H / (2 * MAX_FRAC * ctx.fov().tanV) * 1.02;
    const gen = (k) => {
      const candidates = [];
      for (const off of [0, 35, -35, 70, -70, 110, -110, 180]) {
        for (const d of [64, 56, 48, 40]) candidates.push({ theta: base + off * DEG, phi: d * DEG, radius: radius * k, target });
      }
      return candidates;
    };
    return pick(gen, sightsFor([p]), [p]);
  }

  function overShoulderView(a, b) {
    const back = new THREE.Vector3(a.x - b.x, 0, a.z - b.z);
    if (back.lengthSq() < 1e-6) back.set(0, 0, 1);
    back.normalize();
    const perp = new THREE.Vector3(-back.z, 0, back.x);
    // prefer the shoulder on the player's side of the line
    const player = eyeOf(ctx.playerView());
    const s1 = Math.sign(perp.dot(tmp.subVectors(player, a))) || 1;
    // the caster sits in a side third of the frame, at most NEAR_FRAC of the view height
    const target = new THREE.Vector3().lerpVectors(a, b, 0.55);
    target.y = Math.max(a.y, b.y) + UNIT_MID;
    const gen = (k) => {
      const candidates = [];
      for (const side of [s1, -s1]) {
        // high first: looking down over the caster keeps rank-mates out of the foreground
        for (const h of [2.6, 3.2, 2.0]) {
          for (const d of [2.4, 3.0]) {
            for (const w of [0.8, 1.1]) {
              const eye = a.clone().addScaledVector(back, d * k).addScaledVector(perp, side * w * k);
              eye.y = a.y + h * k;
              candidates.push(viewFromEye(eye, target));
            }
          }
        }
      }
      return candidates;
    };
    return pick(gen, sightsFor([b]), [a, b], { nearIndex: 0 });
  }

  // ---- playback ----
  // Every shot resolves after `duration` (camera clock). Multi-step shots are a single camera
  // sequence or synchronous callbacks, so stepFrames alone plays them start to finish.
  function shot(type, subjects, { duration = 0.8, cut = false } = {}) {
    if (!subjects || !subjects.length) return Promise.resolve();
    const pts = subjects.map((p) => p.clone());
    ctx.beginScripted();
    const id = ++shotId;
    let view;
    let endView = null;
    if (type === 'closeup') view = closeupView(pts[0]);
    else if (type === 'over-shoulder' && pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      // at duel range the caster would fill the frame; a two-shot reads better
      view = Math.hypot(a.x - b.x, a.z - b.z) < 1.5 ? twoShotView(pts) : overShoulderView(a, b);
    }
    else if (type === 'orbit') {
      view = pts.length >= 2 ? twoShotView(pts) : closeupView(pts[0]);
      const sweep = 45 * DEG;
      const ends = [1, -1].map((s) => ({ ...view, theta: view.theta + s * sweep }));
      const objs = occluderList(pts);
      const centres = unitCentres(pts);
      const score = (v) => (framingOk(v, centres) ? 0 : 10) + blockedCount(eyeOf(v), sightsFor(pts), objs);
      endView = score(ends[0]) <= score(ends[1]) ? ends[0] : ends[1];
    } else view = twoShotView(pts);
    log('shot', type, { cut, phi: (view.phi / DEG).toFixed(0), radius: view.radius.toFixed(2) });

    if (ctx.reducedMotion()) {
      // no cuts or sweeps: short fade out, place the camera, fade back in, then hold
      return new Promise((resolve) => {
        fadeTo(1, 0.12, () => {
          if (id !== shotId) return resolve();
          ctx.tween(endView || view, 0);
          fadeTo(0, 0.12, () => {
            if (id !== shotId) return resolve();
            ctx.wait(Math.max(0, duration - 0.24)).then(resolve);
          });
        });
      });
    }
    if (type === 'orbit') {
      const lead = cut ? 0 : Math.min(0.35, duration * 0.4);
      return ctx.tweenSequence([
        { to: view, duration: lead },
        { to: endView, duration: duration - lead, ease: 'sine' },
      ]);
    }
    if (cut) {
      // hard cut, then a gentle push-in for the rest of the shot
      return ctx.tweenSequence([
        { to: { ...view, radius: view.radius * 1.08 }, duration: 0 },
        { to: view, duration, ease: 'out' },
      ]);
    }
    return ctx.tween(view, duration, 'inOut');
  }

  function end({ duration = 0.5 } = {}) {
    shotId++;
    letterbox(false);
    if (slowJob) slowJob.finish();
    if (ctx.reducedMotion() && ctx.isScripted()) {
      return new Promise((resolve) => {
        fadeTo(1, 0.12, () => {
          ctx.endScripted(0);
          fadeTo(0, 0.12, resolve);
        });
      });
    }
    if (fade > 0) fadeTo(0, 0.1);
    return ctx.endScripted(duration);
  }

  // Instantly drop overlays and slow motion (skip).
  function reset() {
    shotId++;
    if (slowJob) slowJob.finish();
    if (fadeJob) fadeJob.resolve();
    fadeJob = null;
    fade = 0;
    fadeEl.style.opacity = '0';
  }

  function dispose() {
    ctx.removeRawUpdater(step);
    barTop.remove();
    barBottom.remove();
    fadeEl.remove();
  }

  return {
    shot, slowMo, letterbox, end,
    // used by scene.js
    twoShotView, reset, dispose,
    isSlow: () => !!slowJob,
    isFading: () => !!fadeJob || fade > 0,
  };
}
