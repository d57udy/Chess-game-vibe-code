// Procedural canvas textures for the battle3d scene (no image files needed).
// Grayscale textures are meant to be tinted by material / instance colors.
import * as THREE from 'three';

// Small seeded RNG so the board looks the same on every load.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Without a 2D canvas (e.g. jsdom in node tests) textures degrade to blank ones.
function blankTexture() {
  return new THREE.Texture();
}

// jsdom has no 2D canvas and logs an error on every getContext call, so skip it there.
const NO_CANVAS_2D = /jsdom/i.test(globalThis.navigator?.userAgent || '');
function get2d(c) {
  return NO_CANVAS_2D ? null : c.getContext('2d');
}

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(canvas, { srgb = true, repeat = null, anisotropy = 4 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  return tex;
}

// Mottled stone with a few faint marble veins.
export function stoneTexture({ size = 256, seed = 7, veins = 4, repeat = null, anisotropy } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size);
  const ctx = get2d(c);
  if (!ctx) return blankTexture();
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 700; i++) {
    const r = 2 + rng() * size * 0.06;
    const dark = rng() < 0.6;
    ctx.fillStyle = dark ? `rgba(0,0,0,${0.01 + rng() * 0.022})` : `rgba(255,255,255,${0.04 + rng() * 0.08})`;
    ctx.beginPath();
    ctx.arc(rng() * size, rng() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineCap = 'round';
  for (let v = 0; v < veins; v++) {
    ctx.strokeStyle = `rgba(60,40,30,${0.05 + rng() * 0.08})`;
    ctx.lineWidth = 0.6 + rng() * 1.6;
    ctx.beginPath();
    let x = rng() * size;
    let y = 0;
    ctx.moveTo(x, y);
    while (y < size) {
      const nx = x + (rng() - 0.5) * size * 0.25;
      const ny = y + size * (0.08 + rng() * 0.12);
      ctx.quadraticCurveTo(x + (rng() - 0.5) * 30, (y + ny) / 2, nx, ny);
      x = nx;
      y = ny;
    }
    ctx.stroke();
  }
  return toTexture(c, { repeat, anisotropy });
}

// Wood grain running along U.
export function woodTexture({ size = 512, seed = 3, repeat = [1, 1], anisotropy } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size);
  const ctx = get2d(c);
  if (!ctx) return blankTexture();
  ctx.fillStyle = '#ececec';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const y0 = rng() * size;
    const amp = 2 + rng() * 6;
    const freq = 0.004 + rng() * 0.01;
    const phase = rng() * 10;
    ctx.strokeStyle = `rgba(40,20,5,${0.04 + rng() * 0.12})`;
    ctx.lineWidth = 0.6 + rng() * 2.4;
    ctx.beginPath();
    for (let x = 0; x <= size; x += 8) {
      const y = y0 + Math.sin(x * freq + phase) * amp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // a couple of knots
  for (let k = 0; k < 3; k++) {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
    g.addColorStop(0, 'rgba(50,25,10,0.35)');
    g.addColorStop(1, 'rgba(50,25,10,0)');
    ctx.save();
    ctx.translate(rng() * size, rng() * size);
    ctx.scale(2.2, 1);
    ctx.fillStyle = g;
    ctx.fillRect(-14, -14, 28, 28);
    ctx.restore();
  }
  return toTexture(c, { repeat, anisotropy });
}

// Irregular flagstones in running bond with dark mortar.
export function flagstoneTexture({ size = 512, seed = 11, repeat = [1, 1], anisotropy } = {}) {
  const rng = makeRng(seed);
  const c = makeCanvas(size);
  const ctx = get2d(c);
  if (!ctx) return blankTexture();
  ctx.fillStyle = '#6a6a6a';
  ctx.fillRect(0, 0, size, size);
  const rows = 5;
  const rh = size / rows;
  for (let r = 0; r < rows; r++) {
    let x = -rng() * rh;
    while (x < size) {
      const w = rh * (0.8 + rng() * 0.9);
      const l = 175 + Math.floor(rng() * 60);
      ctx.fillStyle = `rgb(${l},${l - 4},${l - 10})`;
      roundRect(ctx, x + 3, r * rh + 3, w - 6, rh - 6, 7);
      ctx.fill();
      // wrap the stone that crosses the right edge so the texture tiles
      if (x + w > size) {
        roundRect(ctx, x - size + 3, r * rh + 3, w - 6, rh - 6, 7);
        ctx.fill();
      }
      x += w;
    }
  }
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(0,0,0,${rng() * 0.05})`;
    ctx.fillRect(rng() * size, rng() * size, 2 + rng() * 6, 2 + rng() * 6);
  }
  return toTexture(c, { repeat, anisotropy });
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Highlight shapes, white on transparent so material.color tints them.
export function highlightTexture(kind, size = 128) {
  const c = makeCanvas(size);
  const ctx = get2d(c);
  if (!ctx) return blankTexture();
  const s = size;
  if (kind === 'frame') {
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = s * 0.1;
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(ctx, s * 0.1, s * 0.1, s * 0.8, s * 0.8, s * 0.1);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = s * 0.06;
    ctx.stroke();
  } else if (kind === 'fill') {
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = s * 0.06;
    ctx.fillStyle = '#fff';
    roundRect(ctx, s * 0.08, s * 0.08, s * 0.84, s * 0.84, s * 0.08);
    ctx.fill();
  } else if (kind === 'dot') {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  } else if (kind === 'ring') {
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = s * 0.06;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = s * 0.075;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.38, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    // 'glow': soft radial blob
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  }
  return toTexture(c, { srgb: false });
}

// One glyph for the board coordinates (gold with a dark outline).
export function labelTexture(text, size = 64) {
  const c = makeCanvas(size);
  const ctx = get2d(c);
  if (!ctx) return blankTexture();
  ctx.font = `bold ${Math.round(size * 0.66)}px Georgia, "Times New Roman", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.08;
  ctx.strokeStyle = 'rgba(35,18,6,0.85)';
  ctx.strokeText(text, size / 2, size * 0.54);
  ctx.fillStyle = '#f6dc9c';
  ctx.fillText(text, size / 2, size * 0.54);
  return toTexture(c);
}

// Banner cloth with a swallowtail cut; emblems are left/right symmetric so the back side reads fine.
export function bannerTexture({ cloth, accent, emblem }, w = 128, h = 256) {
  const c = makeCanvas(w, h);
  const ctx = get2d(c);
  if (!ctx) return blankTexture();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, h);
  ctx.lineTo(w / 2, h * 0.84);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = cloth;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = accent;
  ctx.lineWidth = w * 0.1;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.fillRect(0, h * 0.07, w, h * 0.04);
  ctx.restore();
  const cx = w / 2;
  const cy = h * 0.42;
  ctx.fillStyle = accent;
  if (emblem === 'skull') {
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - w * 0.14, cy + w * 0.12, w * 0.28, w * 0.2);
    ctx.fillStyle = cloth;
    ctx.beginPath();
    ctx.arc(cx - w * 0.09, cy - w * 0.01, w * 0.065, 0, Math.PI * 2);
    ctx.arc(cx + w * 0.09, cy - w * 0.01, w * 0.065, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - w * 0.015, cy + w * 0.17, w * 0.03, w * 0.13);
    ctx.fillRect(cx - w * 0.08, cy + w * 0.17, w * 0.03, w * 0.13);
    ctx.fillRect(cx + w * 0.05, cy + w * 0.17, w * 0.03, w * 0.13);
  } else {
    // shield with a cross
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.26, cy - w * 0.26);
    ctx.lineTo(cx + w * 0.26, cy - w * 0.26);
    ctx.lineTo(cx + w * 0.26, cy + w * 0.06);
    ctx.quadraticCurveTo(cx + w * 0.22, cy + w * 0.3, cx, cy + w * 0.4);
    ctx.quadraticCurveTo(cx - w * 0.22, cy + w * 0.3, cx - w * 0.26, cy + w * 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = cloth;
    ctx.fillRect(cx - w * 0.04, cy - w * 0.2, w * 0.08, w * 0.5);
    ctx.fillRect(cx - w * 0.18, cy - w * 0.06, w * 0.36, w * 0.08);
  }
  return toTexture(c);
}

// Ground decals, white/black on transparent: 'scorch' (dark burn) or 'crack' (radial fractures).
export function decalTexture(kind, size = 256, seed = 3) {
  const rng = makeRng(seed);
  const c = makeCanvas(size);
  const ctx = get2d(c);
  if (!ctx) return blankTexture();
  const h = size / 2;
  if (kind === 'crack') {
    ctx.strokeStyle = 'rgba(20,12,8,0.85)';
    ctx.lineCap = 'round';
    for (let i = 0; i < 9; i++) {
      let a = (i / 9) * Math.PI * 2 + rng() * 0.5;
      let x = h;
      let y = h;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const len = size * (0.25 + rng() * 0.2);
      for (let d = 0; d < len; d += 10) {
        a += (rng() - 0.5) * 0.6;
        x += Math.cos(a) * 10;
        y += Math.sin(a) * 10;
        ctx.lineTo(x, y);
        ctx.lineWidth = Math.max(0.8, 3.5 * (1 - d / len));
      }
      ctx.stroke();
    }
    const g = ctx.createRadialGradient(h, h, 0, h, h, size * 0.12);
    g.addColorStop(0, 'rgba(20,12,8,0.7)');
    g.addColorStop(1, 'rgba(20,12,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  } else {
    for (let i = 0; i < 7; i++) {
      const r = size * (0.14 + rng() * 0.2);
      const x = h + (rng() - 0.5) * size * 0.3;
      const y = h + (rng() - 0.5) * size * 0.3;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(15,8,4,0.2)');
      g.addColorStop(0.6, 'rgba(25,12,6,0.14)');
      g.addColorStop(1, 'rgba(25,12,6,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
  }
  return toTexture(c);
}
