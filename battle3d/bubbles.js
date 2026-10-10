// Comic speech bubbles for the talking kings: HTML overlays positioned every frame by projecting a
// world anchor (a king's head) through the camera. One bubble per side; a new remark replaces the
// old one. Driven by the scene clock (stepFrames works), typewriter reveal, fade in/out, clamped to
// the viewport and kept clear of the HUD (#hud children and any [data-bubble-avoid] element).
// Styling lives in an injected <style id="b3d-bubbles-css"> using CSS variables, so the page can
// override colours without editing this file.
import * as THREE from 'three';

const HEAD_HEIGHT = 1.05; // above a unit's root
const CHARS_PER_S = 38;
const FADE_IN = 0.15;
const FADE_OUT = 0.3;
const MARGIN = 8; // px from viewport edges and avoided elements
const GAP = 14; // px between the anchor and the bubble's tail tip
const AVOID_SELECTOR = '#hud > *, [data-bubble-avoid]';

const CSS = `
.b3d-bubble {
  --bubble-bg: #fbf6e9; --bubble-text: #1f2430; --bubble-border: #2f5fb3; --bubble-accent: #2f5fb3;
  position: absolute; left: 0; top: 0; z-index: 5; pointer-events: none;
  max-width: min(260px, 70vw); padding: 8px 12px 9px;
  background: var(--bubble-bg); color: var(--bubble-text);
  border: 2.5px solid var(--bubble-border); border-radius: 16px;
  box-shadow: 0 3px 0 rgba(0,0,0,0.25), 0 6px 18px rgba(0,0,0,0.35);
  font: 600 15px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  overflow-wrap: break-word; opacity: 0; will-change: transform, opacity;
}
.b3d-bubble[data-side="b"] {
  --bubble-bg: #2a2430; --bubble-text: #f6eadb; --bubble-border: #e07a2a; --bubble-accent: #f09a4a;
}
.b3d-bubble .b3d-bubble-name {
  display: block; margin-bottom: 2px; font: 700 11px/1.2 'Cinzel', Georgia, serif;
  letter-spacing: 0.04em; text-transform: uppercase; color: var(--bubble-accent);
}
.b3d-bubble .b3d-bubble-rest { color: transparent; }
.b3d-bubble .b3d-bubble-tail {
  position: absolute; width: 16px; height: 16px; left: 0; bottom: -9.5px;
  background: var(--bubble-bg); border: 2.5px solid var(--bubble-border);
  border-top: none; border-left: none; transform: translateX(-50%) rotate(45deg);
}
.b3d-bubble.below .b3d-bubble-tail { bottom: auto; top: -9.5px; transform: translateX(-50%) rotate(225deg); }
@media (prefers-color-scheme: light) {
  .b3d-bubble { box-shadow: 0 3px 0 rgba(0,0,0,0.18), 0 6px 16px rgba(0,0,0,0.22); }
}
@media (prefers-color-scheme: dark) {
  .b3d-bubble[data-side="w"] { --bubble-bg: #f3ecdc; }
}
@media (max-width: 480px) {
  .b3d-bubble { font-size: 14px; max-width: min(230px, 72vw); }
}
`;

function injectCss() {
  if (document.getElementById('b3d-bubbles-css')) return;
  const style = document.createElement('style');
  style.id = 'b3d-bubbles-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function createBubbles({ container, camera, isLetterboxed = () => false, reducedMotion = () => false }) {
  injectCss();
  const bubbles = {}; // side -> state of the visible bubble
  const doms = {}; // side -> reusable DOM nodes
  const tmp = new THREE.Vector3();
  const rectsOverlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  function makeEl(side) {
    const el = document.createElement('div');
    el.className = 'b3d-bubble';
    el.dataset.side = side;
    el.setAttribute('aria-hidden', 'true'); // captions go to the page's aria-live region
    const name = document.createElement('span');
    name.className = 'b3d-bubble-name';
    const shown = document.createElement('span');
    const rest = document.createElement('span');
    rest.className = 'b3d-bubble-rest';
    const tail = document.createElement('span');
    tail.className = 'b3d-bubble-tail';
    el.append(name, shown, rest, tail);
    container.appendChild(el);
    return { el, name, shown, rest, tail };
  }

  // say({ side, text, square | unitWorldPos | anchor | target, durationMs, name, showInCinematic }) -> Promise
  // anchor: exact world point; unitWorldPos: a unit's root (head = +1.05 y); square: {row, col};
  // target: an Object3D to follow (its world position + 1.05 y). Resolves when the bubble is gone.
  function say(opts = {}) {
    const side = opts.side === 'b' ? 'b' : 'w';
    const text = String(opts.text ?? '').trim();
    if (!text) return Promise.resolve();
    const old = bubbles[side];
    if (old) old.finish(); // one bubble per king
    const dom = doms[side] || (doms[side] = makeEl(side));
    dom.name.textContent = opts.name || '';
    dom.name.style.display = opts.name ? '' : 'none';
    dom.shown.textContent = '';
    dom.rest.textContent = text;
    dom.el.style.opacity = '0';
    dom.el.style.display = '';
    const duration = (opts.durationMs ?? Math.max(2600, 1000 + text.length * 55)) / 1000;
    return new Promise((resolve) => {
      const b = {
        dom, text, side, t: 0, shownChars: -1, duration, closing: -1,
        showInCinematic: !!opts.showInCinematic,
        anchorFn: anchorOf(opts),
        size: null,
      };
      b.finish = () => {
        if (bubbles[side] !== b) return;
        delete bubbles[side];
        dom.el.style.display = 'none';
        dom.el.style.opacity = '0';
        resolve();
      };
      bubbles[side] = b;
      measure(b);
      update(0);
    });
  }

  function anchorOf(opts) {
    if (opts.target && opts.target.isObject3D) {
      const o = opts.target;
      return (out) => { o.updateWorldMatrix(true, false); return o.getWorldPosition(out).setY(out.y + HEAD_HEIGHT); };
    }
    if (opts.anchor) { const a = opts.anchor.clone(); return (out) => out.copy(a); }
    if (opts.unitWorldPos) { const a = opts.unitWorldPos.clone(); a.y += HEAD_HEIGHT; return (out) => out.copy(a); }
    if (opts.square) {
      const a = new THREE.Vector3(opts.square.col - 3.5, HEAD_HEIGHT, opts.square.row - 3.5);
      return (out) => out.copy(a);
    }
    return (out) => out.set(0, HEAD_HEIGHT, 0);
  }

  function measure(b) {
    b.size = { w: b.dom.el.offsetWidth, h: b.dom.el.offsetHeight };
  }

  // Hide every bubble now (new game, undo, skip, commentary off); their promises resolve.
  function clearNow() {
    for (const b of Object.values(bubbles)) b.finish();
  }

  // Fade out early. side omitted: all bubbles.
  function clear(side) {
    for (const s of side ? [side] : Object.keys(bubbles)) {
      const b = bubbles[s];
      if (!b) continue;
      if (reducedMotion()) b.finish();
      else if (b.closing < 0) b.closing = 0;
    }
  }

  function avoidRects(cRect) {
    const out = [];
    for (const el of document.querySelectorAll(AVOID_SELECTOR)) {
      if (el.classList.contains('b3d-bubble')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({ left: r.left - cRect.left - MARGIN, right: r.right - cRect.left + MARGIN, top: r.top - cRect.top - MARGIN, bottom: r.bottom - cRect.top + MARGIN });
    }
    return out;
  }

  // Place one bubble: above the anchor (tail down), or below it near the top edge; clamp to the
  // viewport; slide off any avoided rect with the smallest move that keeps it on screen.
  function place(b, ax, ay, W, H, avoid) {
    const { w, h } = b.size;
    let below = ay - GAP - h < MARGIN;
    let x = ax - w / 2;
    let y = below ? ay + GAP : ay - GAP - h;
    const clampX = (v) => Math.min(Math.max(v, MARGIN), Math.max(MARGIN, W - w - MARGIN));
    const clampY = (v) => Math.min(Math.max(v, MARGIN), Math.max(MARGIN, H - h - MARGIN));
    x = clampX(x);
    y = clampY(y);
    for (let pass = 0; pass < 3; pass++) {
      const rect = { left: x, right: x + w, top: y, bottom: y + h };
      const hit = avoid.find((r) => rectsOverlap(rect, r));
      if (!hit) break;
      const options = [
        { x: hit.right, y }, { x: hit.left - w, y }, { x, y: hit.bottom }, { x, y: hit.top - h },
      ].map((o) => ({ x: clampX(o.x), y: clampY(o.y) }))
        .filter((o) => !rectsOverlap({ left: o.x, right: o.x + w, top: o.y, bottom: o.y + h }, hit))
        .sort((p, q) => Math.hypot(p.x - x, p.y - y) - Math.hypot(q.x - x, q.y - y));
      if (!options.length) break;
      ({ x, y } = options[0]);
    }
    below = y > ay;
    b.dom.el.classList.toggle('below', below);
    b.dom.tail.style.left = `${Math.min(Math.max(ax - x, 16), w - 16)}px`;
    b.dom.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    return { left: x - MARGIN, right: x + w + MARGIN, top: y - MARGIN, bottom: y + h + MARGIN };
  }

  // Advance timers (camera clock dt) and reposition. Call after the camera moved for the frame.
  function update(dt) {
    const sides = Object.keys(bubbles);
    if (!sides.length) return;
    const W = container.clientWidth;
    const H = container.clientHeight;
    const cRect = container.getBoundingClientRect();
    const avoid = avoidRects(cRect);
    const boxed = isLetterboxed();
    camera.updateMatrixWorld();
    for (const side of sides) {
      const b = bubbles[side];
      b.t += dt;
      if (b.closing < 0 && b.t >= b.duration) b.closing = 0;
      else if (b.closing >= 0) b.closing += dt;
      if (b.closing >= FADE_OUT) {
        b.finish();
        continue;
      }
      // typewriter (instant under reduced motion); the hidden rest keeps the size stable
      const n = reducedMotion() ? b.text.length : Math.min(b.text.length, Math.floor(b.t * CHARS_PER_S));
      if (n !== b.shownChars) {
        b.shownChars = n;
        b.dom.shown.textContent = b.text.slice(0, n);
        b.dom.rest.textContent = b.text.slice(n);
      }
      let alpha = reducedMotion() ? 1 : Math.min(1, b.t / FADE_IN);
      if (b.closing >= 0) alpha *= reducedMotion() ? 0 : 1 - b.closing / FADE_OUT;
      b.anchorFn(tmp).project(camera);
      const offscreen = tmp.z > 1 || Math.abs(tmp.x) > 1.3 || Math.abs(tmp.y) > 1.3;
      if (offscreen || (boxed && !b.showInCinematic)) alpha = 0;
      b.dom.el.style.opacity = alpha.toFixed(3);
      if (alpha <= 0) continue;
      const ax = ((tmp.x + 1) / 2) * W;
      const ay = ((1 - tmp.y) / 2) * H;
      avoid.push(place(b, ax, ay, W, H, avoid)); // the other king's bubble avoids this one
    }
  }

  return {
    say,
    clear,
    clearNow,
    update,
    onResize: () => { for (const b of Object.values(bubbles)) measure(b); },
    // typing or fading: worth full frame rate; holding still only needs repositioning
    animating: () => Object.values(bubbles).some((b) => b.closing >= 0 || b.t < FADE_IN || b.shownChars < b.text.length),
    active: () => Object.keys(bubbles),
    get: (side) => {
      const b = bubbles[side];
      return b ? { side, text: b.text, shown: b.dom.shown.textContent, opacity: Number(b.dom.el.style.opacity), el: b.dom.el } : null;
    },
    dispose() {
      for (const b of Object.values(bubbles)) b.finish();
      for (const el of container.querySelectorAll('.b3d-bubble')) el.remove();
    },
  };
}
