// Small orbit camera rig (replaces OrbitControls so the scene owns all camera state).
// Drag rotates, wheel / pinch zooms, no pan. The rig chases a goal view with exponential smoothing;
// scripted camera moves call set() which snaps both current and goal.
import * as THREE from 'three';

const ROTATE_PER_PX = 0.0065;

export function createRig(camera, canvas, { minPhi, maxPhi, onInput = () => {} } = {}) {
  const cur = { theta: 0, phi: Math.PI / 4, radius: 14, target: new THREE.Vector3() };
  const goal = { theta: 0, phi: Math.PI / 4, radius: 14, target: new THREE.Vector3() };
  const limits = { minPhi, maxPhi, minRadius: 3, maxRadius: 40 };
  const pointers = new Map(); // id -> { x, y }
  let pinchDist = 0;
  let enabled = true;

  const wrap = (a) => {
    a = (a + Math.PI) % (Math.PI * 2);
    if (a < 0) a += Math.PI * 2;
    return a - Math.PI;
  };
  const clampGoal = () => {
    goal.phi = THREE.MathUtils.clamp(goal.phi, limits.minPhi, limits.maxPhi);
    goal.radius = THREE.MathUtils.clamp(goal.radius, limits.minRadius, limits.maxRadius);
  };

  function apply() {
    camera.position.setFromSphericalCoords(cur.radius, cur.phi, cur.theta).add(cur.target);
    camera.lookAt(cur.target);
  }

  function pinchDistance() {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onPointerDown(e) {
    if (!enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture?.(e.pointerId);
    if (pointers.size === 2) pinchDist = pinchDistance();
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
    if (pointers.size === 1) {
      goal.theta -= dx * ROTATE_PER_PX;
      goal.phi -= dy * ROTATE_PER_PX;
    } else if (pointers.size === 2) {
      const d = pinchDistance();
      if (pinchDist > 0 && d > 0) goal.radius *= pinchDist / d;
      pinchDist = d;
    }
    clampGoal();
    onInput();
  }
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);
    if (pointers.size === 2) pinchDist = pinchDistance();
  }
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
      if (!enabled) pointers.clear();
    },
    isEnabled: () => enabled,
    isDragging: () => pointers.size > 0,
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
