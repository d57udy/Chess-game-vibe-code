// Lets node import the battle3d ES modules: maps the import-map specifiers 'three' and
// 'three/addons/...' to a local three.js install, and provides the few browser globals the modules
// touch (location, document canvas 2D, fetch for files, createImageBitmap). three is not a repo
// dependency: it is taken from node_modules/three or from B3D_THREE_DIR (a directory containing
// node_modules/three or the three package itself). findThree() returns null when it is missing,
// and the tests skip.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { ROOT } = require('./loadEngine');

const THREE_VERSION = '0.186.1';

function findThree() {
    const candidates = [path.join(ROOT, 'node_modules', 'three')];
    if (process.env.B3D_THREE_DIR) {
        candidates.push(path.join(process.env.B3D_THREE_DIR, 'node_modules', 'three'), process.env.B3D_THREE_DIR);
    }
    for (const dir of candidates) {
        const pkg = path.join(dir, 'package.json');
        if (fs.existsSync(pkg) && fs.existsSync(path.join(dir, 'build', 'three.module.js'))) {
            return { dir, version: JSON.parse(fs.readFileSync(pkg, 'utf8')).version };
        }
    }
    return null;
}

let registered = false;
function registerThree(threeDir) {
    if (registered) return;
    registered = true;
    const base = pathToFileURL(threeDir + '/').href;
    const hooks = `
const BASE = ${JSON.stringify(base)};
export async function resolve(specifier, context, next) {
    // main.js's scene: a wrapper that merges globalThis.__b3dSceneOptions (e.g. an injected fake
    // renderer) into createScene's options; without that global it behaves like scene.js.
    if (specifier === './scene.js' && context.parentURL && context.parentURL.split('?')[0].endsWith('/battle3d/main.js')) {
        const real = new URL('./scene.js', context.parentURL).href.split('?')[0];
        const src = 'import * as real from ' + JSON.stringify(real) + '; export * from ' + JSON.stringify(real) + ';' +
            'export const createScene = (c, o = {}) => real.createScene(c, globalThis.__b3dSceneOptions ? { ...o, ...globalThis.__b3dSceneOptions } : o);';
        return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
    }
    if (specifier === 'three') return { url: BASE + 'build/three.module.js', shortCircuit: true };
    if (specifier.startsWith('three/addons/')) return { url: BASE + 'examples/jsm/' + specifier.slice(13), shortCircuit: true };
    return next(specifier, context);
}
// battle3d/*.js are browser ES modules; say so instead of letting node sniff the syntax.
export async function load(url, context, next) {
    if (url.includes('/battle3d/') && url.endsWith('.js')) return next(url, { ...context, format: 'module' });
    return next(url, context);
}`;
    register('data:text/javascript,' + encodeURIComponent(hooks));
}

// 2D canvas context stub: every method is a no-op, measureText returns a width.
function fakeContext2d(canvas) {
    return new Proxy({ canvas }, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (prop === 'measureText') return (t) => ({ width: String(t).length * 10 });
            if (prop === 'getImageData' || prop === 'createImageData') return (x, y, w = 1, h = 1) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
            if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop() {} });
            return () => {};
        },
        set(target, prop, value) { target[prop] = value; return true; },
    });
}

function fakeCanvas() {
    const canvas = {
        width: 300, height: 150, style: {},
        getContext: (kind) => (kind === '2d' ? fakeContext2d(canvas) : null),
        addEventListener() {}, removeEventListener() {},
        toDataURL: () => 'data:image/png;base64,',
    };
    return canvas;
}

// Installs browser-ish globals. `pageUrl` is what location.href reports (a file:// URL of the page),
// so relative fetches resolve against the repo. Returns a restore function.
// With dom=false, document and location are left alone (only fetch & friends are installed), and
// relative fetches resolve against the repo root.
function installBrowserGlobals(pageUrl = pathToFileURL(path.join(ROOT, 'index.html')).href, { dom = true } = {}) {
    const saved = {};
    const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
    const realFetch = globalThis.fetch;
    const fetched = [];
    if (dom) set('location', new URL(pageUrl));
    if (dom) set('document', {
        createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : { style: {}, appendChild() {}, setAttribute() {} }),
        createElementNS: (ns, tag) => (tag === 'canvas' ? fakeCanvas() : { style: {}, setAttribute() {} }),
    });
    set('fetch', async (input, init) => {
        let url = String(input && input.url ? input.url : input);
        if (!/^[a-z]+:/i.test(url) && globalThis.location?.href) url = new URL(url, globalThis.location.href).href;
        if (url.startsWith('http://localhost/')) url = pathToFileURL(path.join(ROOT, decodeURIComponent(new URL(url).pathname))).href;
        if (url.startsWith('file:')) {
            fetched.push(url);
            const file = fileURLToPath(url);
            if (!fs.existsSync(file)) return new Response(null, { status: 404, statusText: 'Not Found' });
            return new Response(fs.readFileSync(file), { status: 200 });
        }
        return realFetch(input, init);
    });
    if (typeof globalThis.ProgressEvent === 'undefined') {
        set('ProgressEvent', class ProgressEvent extends Event {
            constructor(type, init = {}) { super(type); Object.assign(this, { lengthComputable: false, loaded: 0, total: 0, ...init }); }
        });
    }
    set('createImageBitmap', async () => ({ width: 1, height: 1, close() {} }));
    if (typeof globalThis.self === 'undefined') set('self', globalThis);
    return {
        fetched,
        restore() {
            for (const [k, d] of Object.entries(saved)) {
                if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
            }
        },
    };
}

module.exports = { findThree, registerThree, installBrowserGlobals, THREE_VERSION, ROOT };
