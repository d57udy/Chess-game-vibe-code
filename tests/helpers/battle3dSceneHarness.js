// Runs battle3d/scene.js in node: jsdom window/document as globals, a fake WebGL renderer injected
// through createScene's `renderer` option (counts render calls), a controllable clock
// (performance.now) and a manual requestAnimationFrame so the render-on-demand loop can be driven.
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { findThree, registerThree, ROOT } = require('./loadBattle3dThree');

function fakeContext2d(canvas) {
    return new Proxy({ canvas }, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (prop === 'measureText') return (t) => ({ width: String(t).length * 10 });
            if (prop === 'getImageData' || prop === 'createImageData') return (x, y, w = 1, h = 1) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h) * 4) });
            if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} });
            return () => {};
        },
        set(target, prop, value) { target[prop] = value; return true; },
    });
}

const GLOBALS = ['window', 'document', 'navigator', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'performance', 'ResizeObserver', 'HTMLElement', 'HTMLCanvasElement', 'Event', 'KeyboardEvent', 'PointerEvent', 'MouseEvent', 'screen', 'location'];

/**
 * Installs the browser globals and loads scene.js. Returns null when three is missing.
 * @returns {{ createScene, THREE, dom, clock, raf, restore }}
 */
async function loadSceneModule() {
    const three = findThree();
    if (!three) return null;
    registerThree(three.dir);
    const dom = new JSDOM('<!doctype html><html><body><div id="stage" style="width:800px;height:600px"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/battle3d.html' });
    const w = dom.window;
    w.HTMLCanvasElement.prototype.getContext = function (kind) { return kind === '2d' ? fakeContext2d(this) : null; };
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
    w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    const clock = { t: 1000, now() { return clock.t; }, advance(ms) { clock.t += ms; } };
    const raf = {
        queue: [],
        next: 1,
        request(cb) { const id = raf.next++; raf.queue.push({ id, cb }); return id; },
        cancel(id) { raf.queue = raf.queue.filter((e) => e.id !== id); },
        // Advances the clock by ms and runs one animation frame.
        tick(ms = 1000 / 60) {
            clock.advance(ms);
            const q = raf.queue; raf.queue = [];
            for (const e of q) e.cb(clock.t);
        },
        run(seconds, fps = 60) { const n = Math.round(seconds * fps); for (let i = 0; i < n; i++) raf.tick(1000 / fps); },
    };
    const saved = {};
    for (const k of GLOBALS) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    set('window', w);
    set('document', w.document);
    set('navigator', { hardwareConcurrency: 8, userAgent: 'node' });
    set('getComputedStyle', w.getComputedStyle.bind(w));
    set('requestAnimationFrame', raf.request);
    set('cancelAnimationFrame', raf.cancel);
    set('performance', { now: clock.now });
    set('ResizeObserver', undefined);
    set('HTMLElement', w.HTMLElement);
    set('HTMLCanvasElement', w.HTMLCanvasElement);
    set('screen', { width: 1920, height: 1080 });
    set('location', new URL('http://localhost/battle3d.html'));
    for (const k of ['Event', 'KeyboardEvent', 'MouseEvent']) set(k, w[k]);
    set('PointerEvent', w.PointerEvent || class PointerEvent extends w.MouseEvent {
        constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType || 'mouse'; this.isPrimary = true; }
    });
    const THREE = await import('three');
    const { createScene } = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'scene.js')).href);
    return {
        THREE, createScene, dom, clock, raf,
        restore() { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } },
    };
}

function fakeRenderer(document) {
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 });
    const r = {
        domElement: canvas,
        renders: 0,
        lastCamera: null,
        shadowMap: { enabled: false, type: 0 },
        capabilities: { getMaxAnisotropy: () => 8, isWebGL2: true },
        info: { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } },
        render(scene, camera) { r.renders++; r.lastCamera = camera; },
        setSize() {}, setPixelRatio() {}, getPixelRatio: () => 1,
        getSize: (v) => (v ? v.set(800, 600) : { x: 800, y: 600 }),
        setClearColor() {}, compile() {}, dispose() {},
    };
    return r;
}

module.exports = { loadSceneModule, fakeRenderer };
