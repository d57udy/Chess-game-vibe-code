// Readability layer for battle units: team base with an engraved piece icon, rim colours, role accessories
// (crown, tiara, cape, aura, plume, banner, glowing weapon tip), floating glyph label, selection/threat rings,
// and per-role cloth recolour / tint. See CONTRACT.md (v2) for the API.
//
// Accessories are parented to bones of the (already scaled) character model, so their sizes below are in
// KayKit model units (a character is ~2.2 units tall, head bone ~1.24 above the feet).

const GLYPHS = {
    w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
    b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' }
};
const SOLID = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const LETTERS = { p: 'P', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K' };
const FONT = '"Apple Symbols", "Segoe UI Symbol", "Noto Sans Symbols 2", "Noto Sans Symbols", "DejaVu Sans", "Arial Unicode MS", serif';
const TYPE_ACCESSORIES = { p: [], n: ['plume'], b: ['glow'], r: ['banner'], q: ['tiara', 'aura'], k: ['crown', 'cape', 'aura'] };

export const TEAM_STYLE = {
    w: {
        disc: 0xefe6d2, discEdge: 0xd8ccb2, rim: 0x2f6fd6, ink: '#1d3f80', inkLight: '#ffffff', inkDark: '#0c1d40',
        plate: '#e9dfc8', label: '#f4eee0', accent: 0x3a78e0, accent2: 0xf4f0e6, glow: 0x9fdcff, cape: 0x2a4ea8
    },
    b: {
        disc: 0x2b2d31, discEdge: 0x1c1d20, rim: 0xe8792b, ink: '#f08a3c', inkLight: '#ffc58a', inkDark: '#120a04',
        plate: '#33363b', label: '#26282c', accent: 0xe8792b, accent2: 0x2a2124, glow: 0x9cff7a, cape: 0x6a1f2e
    }
};
const AURA = { k: 0xffcf4a, q: 0xb46bff };
const STATE = { selected: 0xffd54a, threatened: 0xff3b3b };

const BASE_R = 0.37;
const BASE_H = 0.04;

// Shared resources are cached per THREE namespace (the page and tests could use different instances).
const caches = new WeakMap();
function cacheFor(THREE) {
    let c = caches.get(THREE);
    if (!c) { c = { geo: null, mats: new Map(), textures: new Map(), recolor: new Map() }; caches.set(THREE, c); }
    return c;
}
function once(map, key, make) {
    if (!map.has(key)) map.set(key, make());
    return map.get(key);
}

// --- canvas helpers ------------------------------------------------------------------------------

function canvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
}

function glyphFits(g, glyph, size) {
    // Missing glyphs often render as a narrow box or nothing; fall back to letters when the width looks wrong.
    g.font = `${size}px ${FONT}`;
    const w = g.measureText(glyph).width;
    return w > size * 0.45 && w < size * 1.3;
}

function drawGlyph(g, type, x, y, size, fill, { light, dark, emboss = 0 } = {}) {
    const solid = SOLID[type] + '︎';
    const text = glyphFits(g, solid, size) ? solid : LETTERS[type];
    g.font = `${text === LETTERS[type] ? 'bold ' : ''}${size}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (emboss) {
        g.fillStyle = dark; g.fillText(text, x + emboss, y + emboss);
        g.fillStyle = light; g.fillText(text, x - emboss, y - emboss);
    }
    g.fillStyle = fill;
    g.fillText(text, x, y);
}

function texture(THREE, c) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
}

// Top face of the base: engraved ring plus the piece glyph on the half nearest the camera.
function iconTexture(THREE, color, type) {
    return once(cacheFor(THREE).textures, `icon-${color}${type}`, () => {
        const S = 512, c = canvas(S), g = c.getContext('2d'), st = TEAM_STYLE[color];
        g.clearRect(0, 0, S, S);
        // engraved outer ring
        g.lineWidth = 10;
        g.strokeStyle = st.inkDark; g.globalAlpha = 0.35;
        g.beginPath(); g.arc(S / 2 + 3, S / 2 + 3, S * 0.455, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = st.ink; g.globalAlpha = 0.9;
        g.beginPath(); g.arc(S / 2, S / 2, S * 0.455, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = 1;
        // glyph medallion toward the bottom of the texture (= toward the camera)
        const cx = S / 2, cy = S * 0.77, r = S * 0.2;
        g.fillStyle = st.ink; g.globalAlpha = 0.18;
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1;
        drawGlyph(g, type, cx, cy + S * 0.012, S * 0.3, st.ink, { light: st.inkLight, dark: st.inkDark, emboss: 4 });
        return texture(THREE, c);
    });
}

function labelTexture(THREE, color, type) {
    return once(cacheFor(THREE).textures, `label-${color}${type}`, () => {
        const S = 128, c = canvas(S), g = c.getContext('2d'), st = TEAM_STYLE[color];
        g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2);
        g.fillStyle = st.label; g.globalAlpha = 0.88; g.fill(); g.globalAlpha = 1;
        g.lineWidth = 6; g.strokeStyle = st.ink; g.stroke();
        drawGlyph(g, type, 64, 70, 84, st.ink);
        return texture(THREE, c);
    });
}

function bannerTexture(THREE, color) {
    return once(cacheFor(THREE).textures, `banner-${color}`, () => {
        const W = 256, H = 320, c = document.createElement('canvas'), st = TEAM_STYLE[color];
        c.width = W; c.height = H;
        const g = c.getContext('2d');
        const base = '#' + st.accent.toString(16).padStart(6, '0');
        g.fillStyle = base;
        g.beginPath(); g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W, H); g.lineTo(W / 2, H * 0.8); g.lineTo(0, H); g.closePath(); g.fill();
        g.lineWidth = 14; g.strokeStyle = color === 'w' ? '#f4f0e6' : '#2a2124'; g.stroke();
        drawGlyph(g, 'r', W / 2, H * 0.4, 150, color === 'w' ? '#f4f0e6' : '#1b1612', { light: 'rgba(255,255,255,0.35)', dark: 'rgba(0,0,0,0.35)', emboss: 3 });
        return texture(THREE, c);
    });
}

function radialTexture(THREE) {
    return once(cacheFor(THREE).textures, 'radial', () => {
        const S = 128, c = canvas(S), g = c.getContext('2d');
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad; g.fillRect(0, 0, S, S);
        const t = new THREE.CanvasTexture(c);
        return t;
    });
}

function columnTexture(THREE) {
    return once(cacheFor(THREE).textures, 'column', () => {
        const c = document.createElement('canvas'); c.width = 4; c.height = 128;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 128, 0, 0);
        grad.addColorStop(0, 'rgba(255,255,255,0.9)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad; g.fillRect(0, 0, 4, 128);
        return new THREE.CanvasTexture(c);
    });
}

// --- geometry/material cache -------------------------------------------------------------------------

function shared(THREE) {
    const c = cacheFor(THREE);
    if (c.geo) return c.geo;
    const disc = new THREE.CylinderGeometry(BASE_R, BASE_R + 0.025, BASE_H, 40);
    disc.translate(0, BASE_H / 2, 0);
    c.geo = {
        disc,
        rim: new THREE.TorusGeometry(BASE_R + 0.008, 0.02, 8, 48).rotateX(Math.PI / 2).translate(0, BASE_H, 0),
        icon: new THREE.CircleGeometry(BASE_R - 0.012, 40),
        ring: new THREE.RingGeometry(BASE_R + 0.03, BASE_R + 0.085, 48).rotateX(-Math.PI / 2),
        auraDisc: new THREE.CircleGeometry(0.62, 32).rotateX(-Math.PI / 2),
        auraColumn: new THREE.CylinderGeometry(0.3, 0.36, 1.0, 24, 1, true).translate(0, 0.5, 0),
    };
    return c.geo;
}

function mat(THREE, key, make) { return once(cacheFor(THREE).mats, key, make); }

const gold = THREE => mat(THREE, 'gold', () => new THREE.MeshStandardMaterial({ color: 0xf2c443, metalness: 0.85, roughness: 0.28, emissive: 0x5a3c00, emissiveIntensity: 0.45 }));
const silver = THREE => mat(THREE, 'silver', () => new THREE.MeshStandardMaterial({ color: 0xe6e8f0, metalness: 0.9, roughness: 0.25, emissive: 0x30303a, emissiveIntensity: 0.3 }));
const gemMat = (THREE, hex) => mat(THREE, 'gem' + hex, () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.15, metalness: 0.1, emissive: hex, emissiveIntensity: 0.35 }));
const flat = (THREE, hex, extra = {}) => mat(THREE, 'flat' + hex + JSON.stringify(extra), () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.6, metalness: 0.05, ...extra }));
const additive = (THREE, key, map, hex, opacity) => mat(THREE, `add-${key}-${hex}-${opacity}`, () => new THREE.MeshBasicMaterial({
    map, color: hex, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
}));

// --- bones and measurements ------------------------------------------------------------------------

const sanitize = n => n.replace(/[[\].:/]/g, '');
function findBone(THREE, model, name) {
    return model.getObjectByName(name) || model.getObjectByName(sanitize(name)) || null;
}

function skinnedBox(THREE, model) {
    const box = new THREE.Box3();
    model.updateMatrixWorld(true);
    model.traverse(o => {
        if (!o.visible) return;
        if (o.isSkinnedMesh) {
            o.skeleton.update();
            o.computeBoundingBox();
            box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld));
        }
    });
    return box;
}

function visibleBox(THREE, root, filter = () => true) {
    const box = new THREE.Box3();
    root.updateMatrixWorld(true);
    root.traverse(o => {
        if (!o.isMesh || o.isSkinnedMesh || !filter(o)) return;
        for (let p = o; p; p = p.parent) if (!p.visible) return;
        o.geometry.computeBoundingBox();
        box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    });
    return box;
}

// Highest point of the head (helmet/hat/hood included), in head-local units.
function headTop(THREE, model, head) {
    const body = skinnedBox(THREE, model);
    const gear = visibleBox(THREE, head, o => !o.userData.b3dAccessory);
    let top = body.isEmpty() ? -Infinity : body.max.y;
    if (!gear.isEmpty()) top = Math.max(top, gear.max.y);
    const hp = head.getWorldPosition(new THREE.Vector3());
    const local = head.worldToLocal(new THREE.Vector3(hp.x, top, hp.z));
    return Number.isFinite(local.y) ? local.y : 1.0;
}

// --- accessories -------------------------------------------------------------------------------------

function tag(obj) {
    obj.userData.b3dAccessory = true;
    obj.traverse(o => { o.userData.b3dAccessory = true; if (o.isMesh) o.castShadow = true; });
    return obj;
}

function makeCrown(THREE, big = true) {
    const g = new THREE.Group();
    const R = big ? 0.42 : 0.36, H = big ? 0.26 : 0.2;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.9, H, 14, 1, true), gold(THREE));
    band.material.side = THREE.DoubleSide;
    band.position.y = H / 2;
    g.add(band);
    const spike = new THREE.ConeGeometry(0.075, 0.26, 5);
    const ball = new THREE.SphereGeometry(0.05, 8, 6);
    const jewel = new THREE.SphereGeometry(0.055, 8, 6);
    const n = 7;
    for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2;
        const s = new THREE.Mesh(spike, gold(THREE));
        s.position.set(Math.sin(a) * R, H + 0.11, Math.cos(a) * R);
        const b = new THREE.Mesh(ball, gold(THREE));
        b.position.set(Math.sin(a) * R, H + 0.26, Math.cos(a) * R);
        const j = new THREE.Mesh(jewel, gemMat(THREE, i % 2 ? 0x2b5fd9 : 0xd8203a));
        j.position.set(Math.sin(a + Math.PI / n) * (R + 0.01), H * 0.45, Math.cos(a + Math.PI / n) * (R + 0.01));
        g.add(s, b, j);
    }
    // velvet cap
    const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 0.92, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), flat(THREE, 0x8a1630));
    cap.position.y = H * 0.4;
    cap.scale.y = 0.55;
    g.add(cap);
    return g;
}

function makeTiara(THREE) {
    const g = new THREE.Group();
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.035, 6, 28), silver(THREE));
    band.rotation.x = Math.PI / 2;
    g.add(band);
    const peak = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.32, 4), silver(THREE));
    peak.position.set(0, 0.17, 0.36);
    g.add(peak);
    for (const s of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.18, 4), silver(THREE));
        p.position.set(s * 0.2, 0.09, 0.31);
        g.add(p);
    }
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.075), gemMat(THREE, 0xb46bff));
    gem.position.set(0, 0.1, 0.39);
    g.add(gem);
    return g;
}

function makePlume(THREE, color) {
    const st = TEAM_STYLE[color];
    const g = new THREE.Group();
    const geo = new THREE.SphereGeometry(0.11, 8, 6);
    const n = 7;
    for (let i = 0; i < n; i++) {
        const k = i / (n - 1);
        const a = -0.35 + k * 2.2; // arc from front over the top to the back
        const m = new THREE.Mesh(geo, flat(THREE, i % 2 ? st.accent : st.accent2, { roughness: 0.85 }));
        m.position.set(0, Math.sin(a) * 0.32 + 0.12, Math.cos(a) * 0.32 - 0.05);
        m.scale.set(0.75, 1.15 - Math.abs(k - 0.4) * 0.5, 1.5);
        m.rotation.x = -a;
        g.add(m);
    }
    const holder = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.14, 6), gold(THREE));
    holder.position.y = 0.04;
    g.add(holder);
    return g;
}

function makeCape(THREE, color) {
    const st = TEAM_STYLE[color];
    const g = new THREE.Group();
    const w0 = 0.42, w1 = 0.62, L = 1.2;
    const geo = new THREE.BufferGeometry();
    const seg = 6, pos = [], idx = [];
    for (let j = 0; j <= seg; j++) {
        const t = j / seg, w = w0 + (w1 - w0) * t, y = -t * L, z = -0.06 * t - Math.sin(t * Math.PI) * 0.05;
        for (const s of [-1, 0, 1]) pos.push(s * w, y, z + (s === 0 ? -0.06 : 0));
    }
    for (let j = 0; j < seg; j++) for (let i = 0; i < 2; i++) {
        const a = j * 3 + i, b = a + 1, c = a + 3, d = a + 4;
        idx.push(a, c, b, b, c, d);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const cloth = new THREE.Mesh(geo, flat(THREE, st.cape, { side: THREE.DoubleSide, roughness: 0.75 }));
    g.add(cloth);
    const clasp = new THREE.Mesh(new THREE.BoxGeometry(w0 * 2 + 0.06, 0.08, 0.08), gold(THREE));
    g.add(clasp);
    return g;
}

function makeBanner(THREE, color) {
    const g = new THREE.Group();
    const H = 3.0;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, H, 6), flat(THREE, 0x5a3b22, { roughness: 0.8 }));
    pole.position.y = H / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 6), gold(THREE));
    tip.position.y = H + 0.1;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.85, 6), gold(THREE));
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0.4, H - 0.1, 0);
    const flagMat = mat(THREE, 'banner-' + color, () => new THREE.MeshStandardMaterial({ map: bannerTexture(THREE, color), side: THREE.DoubleSide, roughness: 0.8, transparent: true, alphaTest: 0.5 }));
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.0), flagMat);
    flag.position.set(0.42, H - 0.62, 0);
    g.add(pole, tip, bar, flag);
    return g;
}

function makeGlow(THREE, color) {
    const m = mat(THREE, 'glow-' + color, () => new THREE.SpriteMaterial({
        map: radialTexture(THREE), color: TEAM_STYLE[color].glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    const s = new THREE.Sprite(m);
    s.scale.setScalar(0.75);
    s.castShadow = false;
    return s;
}

function makeAura(THREE, type) {
    const hex = AURA[type] || AURA.k;
    const g = new THREE.Group();
    const geo = shared(THREE);
    const disc = new THREE.Mesh(geo.auraDisc, additive(THREE, 'disc', radialTexture(THREE), hex, 0.45));
    disc.position.y = BASE_H + 0.004;
    disc.renderOrder = 2;
    const col = new THREE.Mesh(geo.auraColumn, additive(THREE, 'col', columnTexture(THREE), hex, 0.16));
    col.position.y = BASE_H;
    col.renderOrder = 2;
    g.add(disc, col);
    g.userData.pulse = [disc, col];
    return g;
}

// --- recolour / tint --------------------------------------------------------------------------------

function inHue(h, [a, b]) { return a <= b ? h >= a && h <= b : h >= a || h <= b; }

function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
}
function hslToRgb(h, s, l) {
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)];
}

function recolorTexture(THREE, map, rc) {
    const key = `${map.uuid}|${rc.from}|${rc.to}|${rc.sat}|${rc.light}`;
    return once(cacheFor(THREE).recolor, key, () => {
        const img = map.image;
        const w = img?.width || 0, h = img?.height || 0;
        if (!w || !h) return map;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const data = g.getImageData(0, 0, w, h);
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
            const [hh, s, l] = rgbToHsl(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
            if (s < 0.25 || l < 0.06 || l > 0.96 || !inHue(hh, rc.from)) continue;
            const [r, gg, b] = hslToRgb(rc.to, Math.min(1, s * rc.sat), Math.min(1, l * rc.light));
            px[i] = r * 255; px[i + 1] = gg * 255; px[i + 2] = b * 255;
        }
        g.putImageData(data, 0, 0);
        const t = map.clone();
        t.source = new (THREE.TextureSource || THREE.Source)(c); // Source was renamed in r186
        t.needsUpdate = true;
        return t;
    });
}

function applyLook(THREE, model, role) {
    const rc = role.recolor && Number.isFinite(role.recolor.to)
        ? { from: role.recolor.from || [0, 360], to: role.recolor.to, sat: role.recolor.sat ?? 1, light: role.recolor.light ?? 1 } : null;
    const tint = role.tint ? new THREE.Color(role.tint) : null;
    if (!rc && !tint) return;
    const cache = cacheFor(THREE).mats;
    model.traverse(o => {
        if (!o.isMesh || o.userData.b3dAccessory) return;
        const swap = m => {
            if (!m) return m;
            const key = `look|${m.uuid}|${rc ? [rc.from, rc.to, rc.sat, rc.light].join() : ''}|${role.tint || ''}`;
            return once(cache, key, () => {
                const n = m.clone();
                if (rc && m.map) n.map = recolorTexture(THREE, m.map, rc);
                if (tint) n.color.multiply(tint);
                n.userData.b3dShared = true;
                return n;
            });
        };
        o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
}

// --- main ----------------------------------------------------------------------------------------------

export function decorateUnit(unit, { THREE, color, type, role = {}, labels = true } = {}) {
    const st = TEAM_STYLE[color] || TEAM_STYLE.w;
    const geo = shared(THREE);
    const root = unit.root;
    const model = unit.model;
    const owned = [];        // objects we add (removed on dispose)
    const ownMats = [];      // per-unit materials (disposed on dispose)
    const pulses = [];       // [object, baseOpacity|null, speed]

    if (model) applyLook(THREE, model, role);

    // Base: disc, coloured rim, engraved icon (rotated toward the camera every frame).
    const disc = new THREE.Mesh(geo.disc, mat(THREE, 'disc-' + color, () => new THREE.MeshStandardMaterial({
        color: st.disc, roughness: color === 'w' ? 0.55 : 0.4, metalness: color === 'w' ? 0.05 : 0.55
    })));
    disc.receiveShadow = true;
    disc.name = 'b3d-base';
    const rimMat = new THREE.MeshStandardMaterial({ color: st.rim, emissive: st.rim, emissiveIntensity: 0.35, roughness: 0.4, metalness: 0.2 });
    ownMats.push(rimMat);
    const rim = new THREE.Mesh(geo.rim, rimMat);
    rim.castShadow = true;
    const icon = new THREE.Mesh(geo.icon, mat(THREE, 'icon-' + color + type, () => new THREE.MeshStandardMaterial({
        map: iconTexture(THREE, color, type), transparent: true, depthWrite: false, roughness: 0.6,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    })));
    icon.position.y = BASE_H + 0.002;
    icon.renderOrder = 1;
    icon.rotation.order = 'YXZ';
    icon.rotation.x = -Math.PI / 2;
    const camPos = new THREE.Vector3(), wp = new THREE.Vector3();
    icon.onBeforeRender = (renderer, scene, camera) => {
        const parent = icon.parent;
        if (!parent) return;
        const m = parent.matrixWorld.elements;
        wp.setFromMatrixPosition(parent.matrixWorld);
        camPos.setFromMatrixPosition(camera.matrixWorld);
        const want = Math.atan2(-(wp.x - camPos.x), -(wp.z - camPos.z));
        const parentYaw = Math.atan2(m[8], m[10]);
        icon.rotation.y = want - parentYaw;
        icon.updateMatrix();
        icon.matrixWorld.multiplyMatrices(parent.matrixWorld, icon.matrix);
        icon.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, icon.matrixWorld);
        icon.normalMatrix.getNormalMatrix(icon.modelViewMatrix);
    };
    disc.add(icon);

    // Selection / threat ring (additive, pulsing).
    const ringMat = new THREE.MeshBasicMaterial({ color: STATE.selected, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    ownMats.push(ringMat);
    const ring = new THREE.Mesh(geo.ring, ringMat);
    ring.position.y = 0.006;
    ring.visible = false;
    ring.renderOrder = 3;
    root.add(disc, rim, ring);
    owned.push(disc, rim, ring);
    for (const o of [disc, rim, ring, icon]) o.userData.b3dBase = true; // units.js shrinks these on death

    // Role accessories.
    const wanted = new Set(Array.isArray(role.accessories) ? role.accessories : [...TYPE_ACCESSORIES[type] || [], ...(role.crown ? ['crown'] : [])]);
    const bones = unit.bones || {};
    const head = bones.head || (model && findBone(THREE, model, 'head'));
    const chest = bones.chest || (model && findBone(THREE, model, 'chest'));
    const handR = bones.handR || (model && findBone(THREE, model, 'handslot.r'));
    const modelScale = model ? model.scale.x || 1 : 1;
    const attach = (obj, parent, fallbackY) => {
        tag(obj);
        if (parent) parent.add(obj);
        else { // no rig: put it above the model in root space, sized like model units
            obj.scale.multiplyScalar(modelScale);
            obj.position.y = fallbackY;
            root.add(obj);
        }
        owned.push(obj);
        return obj;
    };
    let topY = null;
    const modelTop = () => {
        if (topY == null) { const b = new THREE.Box3().setFromObject(model || root); topY = b.isEmpty() ? 0.85 : b.max.y - root.position.y; }
        return topY;
    };
    const headY = head ? headTop(THREE, model, head) : 0;

    if (wanted.has('crown')) {
        const c = attach(makeCrown(THREE, true), head, modelTop());
        if (head) c.position.y = headY - 0.14;
        unit.crown = c;
    }
    if (wanted.has('tiara')) {
        const t = attach(makeTiara(THREE), head, modelTop());
        if (head) t.position.set(0, headY - 0.2, 0.02);
    }
    if (wanted.has('plume')) {
        const p = attach(makePlume(THREE, color), head, modelTop());
        if (head) p.position.y = headY - 0.08;
    }
    if (wanted.has('cape')) {
        let hasCape = false;
        if (model) model.traverse(o => { if (o.isMesh && /cape|cloak/i.test(o.name) && o.visible && o.parent?.visible !== false) hasCape = true; });
        if (!hasCape && chest) {
            const c = attach(makeCape(THREE, color), chest, 0);
            c.position.set(0, 0.28, -0.36);
            c.rotation.x = 0.12;
        }
    }
    if (wanted.has('banner')) {
        const b = attach(makeBanner(THREE, color), chest, 0.3);
        b.traverse(o => { o.userData.b3dTall = true; });
        if (chest) { b.position.set(0.3, -0.45, -0.45); b.rotation.set(-0.08, 0, 0.06); }
    }
    if (wanted.has('glow')) {
        let tipY = null;
        if (handR) {
            const box = visibleBox(THREE, handR, o => !o.userData.b3dAccessory);
            if (!box.isEmpty()) {
                // highest point of the held weapon, in hand-slot space
                const inv = new THREE.Matrix4().copy(handR.matrixWorld).invert();
                const corners = [];
                for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z).applyMatrix4(inv));
                tipY = Math.max(...corners.map(v => v.y));
            }
        }
        const g = attach(makeGlow(THREE, color), handR, modelTop() * 0.6);
        if (handR) g.position.set(0, (tipY ?? 0.1) - 0.08, 0);
        pulses.push([g, null, 3.1]);
    }
    if (wanted.has('aura')) {
        const a = makeAura(THREE, type === 'q' ? 'q' : 'k');
        tag(a);
        a.userData.b3dBase = true;
        a.traverse(o => { o.castShadow = false; });
        root.add(a);
        owned.push(a);
        for (const m of a.userData.pulse) pulses.push([m, m.material.opacity, 1.6]);
    }

    // Floating glyph label above everything.
    const labelMat = mat(THREE, 'label-' + color + type, () => new THREE.SpriteMaterial({ map: labelTexture(THREE, color, type), depthWrite: false, transparent: true }));
    const label = new THREE.Sprite(labelMat);
    label.scale.set(0.3, 0.3, 1);
    label.renderOrder = 10;
    root.updateMatrixWorld(true);
    const all = new THREE.Box3();
    if (model) {
        const body = skinnedBox(THREE, model);
        const extra = visibleBox(THREE, model, o => !o.userData.b3dTall);
        all.union(body).union(extra);
    }
    const top = all.isEmpty() ? 0.85 : all.max.y - root.getWorldPosition(new THREE.Vector3()).y;
    label.position.y = Math.max(0.95, top + 0.2);
    label.visible = !!labels;
    root.add(label);
    owned.push(label);

    // Gentle pulse for glows/auras/rings, driven by the render clock (render-on-demand friendly).
    let selected = false, threatened = false;
    const pulseHost = disc;
    pulseHost.onBeforeRender = () => {
        const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
        for (const [o, base, speed] of pulses) {
            const k = 0.75 + 0.25 * Math.sin(t * speed);
            if (base == null) o.scale.setScalar(0.75 * (0.85 + 0.15 * k));
            else o.material.opacity = base * k;
        }
        if (ring.visible) {
            const k = 0.5 + 0.5 * Math.sin(t * (threatened ? 7 : 4));
            ringMat.opacity = 0.55 + 0.4 * k;
            const s = 1 + 0.04 * k;
            ring.scale.set(s, 1, s);
        }
    };

    function refreshState() {
        const hex = threatened ? STATE.threatened : selected ? STATE.selected : null;
        ring.visible = hex != null;
        if (hex != null) ringMat.color.setHex(hex);
        rimMat.color.setHex(hex ?? st.rim);
        rimMat.emissive.setHex(hex ?? st.rim);
        rimMat.emissiveIntensity = hex != null ? 0.9 : 0.35;
    }

    unit.base = [disc, rim];
    unit.label = label;
    unit.labelY = label.position.y;

    const handle = {
        base: [disc, rim],
        label,
        labelY: label.position.y,
        setLabel(on) { label.visible = !!on; },
        setSelected(on) { selected = !!on; refreshState(); },
        setThreatened(on) { threatened = !!on; refreshState(); },
        dispose() {
            for (const o of owned) o.removeFromParent();
            for (const m of ownMats) m.dispose();
            pulseHost.onBeforeRender = () => { };
        }
    };
    unit.visuals = handle;
    return handle;
}

// Team colours for other modules (HUD legend, projectiles).
export function teamStyle(color) { return TEAM_STYLE[color] || TEAM_STYLE.w; }
export { GLYPHS };
