// Small orbit camera rig (replaces OrbitControls so the scene owns all camera state).
// 1 finger / left drag orbits; 2 fingers pinch-zoom + pan (midpoint drag) + twist (rotate around the
// vertical axis); right drag or shift+drag pans; wheel zooms. Pan moves the look-at target over the
// board plane, clamped to the board plus a margin. The rig chases a goal view with exponential
// smoothing; scripted camera moves call set() which snaps both current and goal.
import * as THREE from 'three';

const ROTATE_PER_PX = 0.0065;

export function createRig(camera, canvas, { minPhi, maxPhi, panLimit = 5, onInput = () => {} } = {}) {
  const cur = { theta: 0, phi: Math.PI / 4, radius: 14, target: new THREE.Vector3() };
  const goal = { theta: 0, phi: Math.PI / 4, radius: 14, target: new THREE.Vector3() };
  const limits = { minPhi, maxPhi, minRadius: 3, maxRadius: 40, pan: panLimit };
  const pointers = new Map(); // id -> { x, y }
  let gesture = null; // two-finger reference: { mid: {x, y}, dist, angle }
  let afterMulti = false; // a two-finger gesture happened: the last finger does not orbit
  let mousePan = false; // right drag or shift+drag
  let enabled = true;

  const wrap = (a) => {
    a = (a + Math.PI) % (Math.PI * 2);
    if (a < 0) a += Math.PI * 2;
    return a - Math.PI;
  };
  const clampGoal = () => {
    goal.phi = THREE.MathUtils.clamp(goal.phi, limits.minPhi, limits.maxPhi);
    goal.radius = THREE.MathUtils.clamp(goal.radius, limits.minRadius, limits.maxRadius);
    goal.target.x = THREE.MathUtils.clamp(goal.target.x, -limits.pan, limits.pan);
    goal.target.z = THREE.MathUtils.clamp(goal.target.z, -limits.pan, limits.pan);
  };

  // Screen-space drag (px) -> move the target over the ground so the board follows the finger.
  function pan(dx, dy) {
    const h = canvas.clientHeight || 1;
    const perPx = (2 * goal.radius * Math.tan((camera.fov * Math.PI) / 360)) / h;
    const th = goal.theta;
    const groundScale = 1 / Math.max(0.3, Math.cos(goal.phi)); // screen-vertical drag covers more ground
    // camera right = (cos th, 0, -sin th); forward over the ground = (-sin th, 0, -cos th)
    goal.target.x += (-Math.cos(th) * dx + -Math.sin(th) * dy * groundScale) * perPx;
    goal.target.z += (Math.sin(th) * dx + -Math.cos(th) * dy * groundScale) * perPx;
  }

  function twoFinger() {
    const [a, b] = [...pointers.values()];
    return {
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  function apply() {
    camera.position.setFromSphericalCoords(cur.radius, cur.phi, cur.theta).add(cur.target);
    camera.lookAt(cur.target);
  }

  function onPointerDown(e) {
    if (!enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    if (pointers.size >= 2) return; // a third finger is ignored
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture?.(e.pointerId);
    if (pointers.size === 2) {
      gesture = twoFinger();
      afterMulti = true;
    } else {
      mousePan = e.pointerType === 'mouse' && (e.button === 2 || e.shiftKey);
    }
    onInput();
  }
  function onPointerMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (!enabled) return;
    if (pointers.size === 2 && gesture) {
      const g = twoFinger();
      if (g.dist > 10 && gesture.dist > 10) {
        goal.radius *= gesture.dist / g.dist; // pinch
        goal.theta += Math.atan2(Math.sin(g.angle - gesture.angle), Math.cos(g.angle - gesture.angle)); // twist
      }
      pan(g.mid.x - gesture.mid.x, g.mid.y - gesture.mid.y);
      gesture = g;
    } else if (pointers.size === 1 && !afterMulti) {
      if (mousePan) pan(dx, dy);
      else {
        goal.theta -= dx * ROTATE_PER_PX;
        goal.phi -= dy * ROTATE_PER_PX;
      }
    } else {
      return;
    }
    clampGoal();
    onInput();
  }
  function onPointerUp(e) {
    if (!pointers.delete(e.pointerId)) return;
    canvas.releasePointerCapture?.(e.pointerId);
    gesture = pointers.size === 2 ? twoFinger() : null;
    if (pointers.size === 0) {
      afterMulti = false;
      mousePan = false;
    }
  }
  const onContextMenu = (e) => e.preventDefault(); // right drag pans
  function onWheel(e) {
    if (!enabled) return;
    e.preventDefault();
    goal.radius *= Math.exp(THREE.MathUtils.clamp(e.deltaY, -100, 100) * 0.0015);
    clampGoal();
    onInput();
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);

  return {
    limits,
    // Snap to a view (both current and goal), e.g. from a scripted tween.
    set(v) {
      for (const o of [cur, goal]) {
        o.theta = v.theta;
        o.phi = v.phi;
        o.radius = v.radius;
        o.target.copy(v.target);
      }
      apply();
    },
    get: () => ({ theta: cur.theta, phi: cur.phi, radius: cur.radius, target: cur.target.clone() }),
    // Advance smoothing toward the goal; returns true while still moving.
    update(dt) {
      const k = 1 - Math.exp(-dt * 12);
      const dTheta = wrap(goal.theta - cur.theta);
      const dPhi = goal.phi - cur.phi;
      const dRad = goal.radius - cur.radius;
      const moving = Math.abs(dTheta) > 1e-4 || Math.abs(dPhi) > 1e-4 || Math.abs(dRad) > 1e-3
        || cur.target.distanceToSquared(goal.target) > 1e-6;
      if (!moving) return false;
      cur.theta += dTheta * k;
      cur.phi += dPhi * k;
      cur.radius += dRad * k;
      cur.target.lerp(goal.target, k);
      apply();
      return true;
    },
    // Drop any pending smoothing (used by skip and before scripted moves).
    settle() {
      goal.theta = cur.theta;
      goal.phi = cur.phi;
      goal.radius = cur.radius;
      goal.target.copy(cur.target);
    },
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) {
        pointers.clear();
        gesture = null;
        afterMulti = false;
        mousePan = false;
      }
    },
    isEnabled: () => enabled,
    isDragging: () => pointers.size > 0,
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
