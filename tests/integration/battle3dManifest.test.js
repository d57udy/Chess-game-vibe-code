'use strict';
// manifest.webmanifest installability (Chrome criteria + v3 contract): required fields, relative
// start_url/scope, 192 and 512 PNG icons whose real pixel sizes (PNG IHDR) match the declared sizes,
// maskable icons, theme colours, and both pages linking the manifest and theme colour.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { ROOT } = require('../helpers/loadEngine');

const FILE = path.join(ROOT, 'manifest.webmanifest');
const have = fs.existsSync(FILE);
const manifest = have ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;

// PNG: signature + IHDR (width/height big-endian at bytes 16..23); also color type at byte 25.
function pngInfo(file) {
    const b = fs.readFileSync(file);
    assert.ok(b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${file}: not a PNG`);
    assert.equal(b.toString('ascii', 12, 16), 'IHDR', `${file}: first chunk is not IHDR`);
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25], bytes: b.length };
}
// Minimal PNG decoder (8-bit greyscale/RGB/RGBA/grey-alpha, non-interlaced): returns pixel(x, y) -> [r,g,b,a].
function decodePng(file) {
    const zlib = require('node:zlib');
    const b = fs.readFileSync(file);
    const info = pngInfo(file);
    const depth = b[24], interlace = b[28];
    const idat = [];
    for (let off = 8; off < b.length;) {
        const len = b.readUInt32BE(off), type = b.toString('ascii', off + 4, off + 8);
        if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
        off += 12 + len;
    }
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[info.colorType];
    if (depth !== 8 || interlace !== 0 || !channels) return null; // unsupported: caller skips
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = channels, stride = info.width * bpp;
    const out = Buffer.alloc(stride * info.height);
    for (let y = 0; y < info.height; y++) {
        const f = raw[y * (stride + 1)];
        for (let x = 0; x < stride; x++) {
            const v = raw[y * (stride + 1) + 1 + x];
            const a = x >= bpp ? out[y * stride + x - bpp] : 0;
            const up = y > 0 ? out[(y - 1) * stride + x] : 0;
            const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
            let r;
            if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + up; else if (f === 3) r = v + ((a + up) >> 1);
            else { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); }
            out[y * stride + x] = r & 255;
        }
    }
    return (x, y) => {
        const i = y * stride + x * bpp;
        if (channels === 1) return [out[i], out[i], out[i], 255];
        if (channels === 2) return [out[i], out[i], out[i], out[i + 1]];
        return [out[i], out[i + 1], out[i + 2], channels === 4 ? out[i + 3] : 255];
    };
}
const sizesOf = (s) => String(s || '').split(/\s+/).filter(Boolean);
const isHex = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c);

describe('manifest.webmanifest', { skip: !have && 'no manifest yet' }, () => {
    test('required installability fields (v3 contract values)', () => {
        assert.equal(manifest.name, 'Chess Battle 3D');
        assert.equal(manifest.short_name, 'Chess 3D');
        assert.ok(manifest.short_name.length <= 12, 'short_name fits under a launcher icon');
        assert.equal(manifest.start_url, './');
        assert.equal(manifest.scope, './');
        assert.ok(['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display), manifest.display);
        if (manifest.display === 'fullscreen') assert.ok((manifest.display_override || []).includes('standalone'), 'fullscreen needs a standalone fallback');
        assert.equal(manifest.orientation, 'any');
        assert.ok(isHex(manifest.background_color), manifest.background_color);
        assert.ok(isHex(manifest.theme_color), manifest.theme_color);
        if (manifest.id !== undefined) assert.ok(!/^https?:|^\//.test(manifest.id), `id ${manifest.id} is relative`);
    });

    test('start_url, scope, icons and shortcuts are relative paths (GitHub Pages subpath)', () => {
        const urls = [manifest.start_url, manifest.scope, ...manifest.icons.map((i) => i.src),
            ...(manifest.shortcuts || []).flatMap((s) => [s.url, ...(s.icons || []).map((i) => i.src)]),
            ...(manifest.screenshots || []).map((s) => s.src)];
        for (const u of urls) assert.ok(!/^(https?:)?\//.test(u), `${u} must be relative`);
        // start_url must be inside scope
        const base = 'https://example.github.io/Chess-game-vibe-code/manifest.webmanifest';
        assert.ok(new URL(manifest.start_url, base).href.startsWith(new URL(manifest.scope, base).href), 'start_url within scope');
        for (const s of manifest.shortcuts || []) assert.ok(fs.existsSync(path.join(ROOT, s.url.split(/[?#]/)[0])), `shortcut ${s.url} exists`);
    });

    test('every icon exists and PNG pixel sizes match the declared sizes', () => {
        for (const icon of manifest.icons) {
            const file = path.join(ROOT, icon.src);
            assert.ok(fs.existsSync(file), `${icon.src} missing`);
            if (icon.type === 'image/png' || /\.png$/i.test(icon.src)) {
                const info = pngInfo(file);
                const declared = sizesOf(icon.sizes);
                assert.ok(declared.length > 0, `${icon.src} declares sizes`);
                for (const s of declared) {
                    const [w, h] = s.split('x').map(Number);
                    assert.ok(w === info.width && h === info.height, `${icon.src}: declared ${s}, actual ${info.width}x${info.height}`);
                }
            } else if (/svg/.test(icon.type || icon.src)) {
                assert.match(fs.readFileSync(file, 'utf8'), /<svg[\s>]/, `${icon.src} is SVG`);
            }
        }
    });

    test('has 192 and 512 PNG icons for "any" and for "maskable"', () => {
        const has = (purpose, size) => manifest.icons.some((i) =>
            sizesOf(i.sizes).includes(size) && /png/.test(i.type || i.src) && sizesOf(i.purpose || 'any').includes(purpose));
        for (const purpose of ['any', 'maskable']) for (const size of ['192x192', '512x512']) assert.ok(has(purpose, size), `${purpose} ${size}`);
    });

    test('maskable icons are full-bleed (opaque corners and edges)', () => {
        for (const icon of manifest.icons.filter((i) => sizesOf(i.purpose).includes('maskable'))) {
            const file = path.join(ROOT, icon.src);
            const px = decodePng(file);
            assert.ok(px, `${icon.src}: decodable 8-bit PNG`);
            const { width: w, height: h } = pngInfo(file);
            for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [w >> 1, 0], [0, h >> 1]]) {
                assert.equal(px(x, y)[3], 255, `${icon.src}: transparent at ${x},${y}`);
            }
        }
    });

    test('"any" icons have transparent or rounded corners (not a maskable square reused)', () => {
        for (const icon of manifest.icons.filter((i) => /png/.test(i.type) && sizesOf(i.purpose || 'any').includes('any'))) {
            const px = decodePng(path.join(ROOT, icon.src));
            if (!px) continue;
            assert.ok(px(0, 0)[3] < 255, `${icon.src}: top-left corner is transparent`);
        }
    });

    test('icon payload is reasonable (< 600 KB total)', (t) => {
        const total = manifest.icons.reduce((n, i) => n + fs.statSync(path.join(ROOT, i.src)).size, 0);
        t.diagnostic(`icons ${(total / 1024).toFixed(0)} KB`);
        assert.ok(total < 600 * 1024);
    });

    for (const page of ['index.html', '2d.html']) {
        test(`${page} links the manifest, theme colour and touch icon`, () => {
            const d = new JSDOM(fs.readFileSync(path.join(ROOT, page), 'utf8')).window.document;
            assert.equal(d.querySelector('link[rel="manifest"]')?.getAttribute('href'), 'manifest.webmanifest');
            const theme = d.querySelector('meta[name="theme-color"]')?.getAttribute('content');
            assert.ok(theme && isHex(theme), `${page} theme-color ${theme}`);
            const touch = d.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href');
            assert.ok(touch && fs.existsSync(path.join(ROOT, touch)), `${page} apple-touch-icon ${touch}`);
            const vp = d.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';
            assert.match(vp, /width=device-width/);
        });
    }

    test('apple-touch-icon is a 180x180 PNG', () => {
        const info = pngInfo(path.join(ROOT, 'icons', 'apple-touch-icon.png'));
        assert.deepEqual([info.width, info.height], [180, 180]);
    });
});
