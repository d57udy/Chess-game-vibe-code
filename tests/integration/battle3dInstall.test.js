'use strict';
// battle3d/install.js in jsdom: isInstalled (display-mode / navigator.standalone), the install menu
// section (beforeinstallprompt button flow, per-platform instructions, hidden when installed,
// appinstalled), the one-time hint, and registerServiceWorker opt-outs, scope and update notice.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { ROOT } = require('../helpers/loadEngine');

const FILE = path.join(ROOT, 'battle3d', 'install.js');
const have = fs.existsSync(FILE);
const UA = {
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
    samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
    iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    desktopChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
};
const GLOBALS = ['window', 'document', 'navigator', 'location', 'localStorage', 'Event'];
let saved, seq = 0;

// Fresh jsdom globals + a fresh module instance (install.js keeps module state).
async function load({ url = 'https://example.github.io/Chess-game-vibe-code/', ua = UA.androidChrome, standalone = false, displayMode = null, sw = true, secure = true, iosStandalone = false } = {}) {
    const dom = new JSDOM('<!doctype html><body><section class="menu-section"><h3>Install app</h3><div id="mount"></div></section></body>', { url, pretendToBeVisual: true });
    const w = dom.window;
    const mq = new Map();
    w.matchMedia = (q) => {
        if (!mq.has(q)) {
            const l = new Set();
            mq.set(q, { media: q, matches: (standalone && /display-mode: standalone/.test(q)) || (!!displayMode && q.includes(`display-mode: ${displayMode}`)), addEventListener: (t, f) => l.add(f), removeEventListener: (t, f) => l.delete(f), _l: l });
        }
        return mq.get(q);
    };
    Object.defineProperty(w, 'isSecureContext', { value: secure, configurable: true });
    const swLog = { registered: [], unregistered: 0, controller: null, listeners: {} };
    const nav = { userAgent: ua, platform: /iPhone/.test(ua) ? 'iPhone' : 'Linux', maxTouchPoints: 5 };
    if (iosStandalone) nav.standalone = true;
    if (sw) {
        nav.serviceWorker = {
            get controller() { return swLog.controller; },
            register: async (u, opts) => { swLog.registered.push({ url: u, scope: opts?.scope }); if (swLog.fail) throw new Error('blocked'); return { scope: opts?.scope }; },
            getRegistrations: async () => [{ unregister: async () => { swLog.unregistered++; return true; } }],
            addEventListener: (t, f) => { (swLog.listeners[t] ||= []).push(f); },
        };
    }
    saved = {};
    for (const k of GLOBALS) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    set('window', w); set('document', w.document); set('navigator', nav); set('location', w.location);
    set('localStorage', w.localStorage); set('Event', w.Event);
    Object.defineProperty(w, 'navigator', { value: nav, configurable: true });
    const mod = await import(pathToFileURL(FILE).href + `?t=${++seq}`);
    // Chrome's BeforeInstallPromptEvent
    const bip = (outcome = 'accepted') => {
        const e = new w.Event('beforeinstallprompt', { cancelable: true });
        e.prompted = 0;
        e.prompt = async () => { e.prompted++; };
        e.userChoice = Promise.resolve({ outcome, platform: 'web' });
        w.dispatchEvent(e);
        return e;
    };
    return { w, mod, swLog, bip, mq, mount: w.document.getElementById('mount'), flush: () => new Promise((r) => setTimeout(r, 0)) };
}
function restore() {
    if (!saved) return;
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    saved = null;
}
const section = (T) => T.mount.querySelector('section.b3d-install');
const btn = (T) => T.mount.querySelector('.b3d-install-btn');
const visible = (el) => el && !el.hidden;

describe('battle3d install.js', { skip: !have && 'no install.js yet' }, () => {
    afterEach(() => restore());

    test('isInstalled: display-mode standalone or iOS navigator.standalone', async () => {
        let T = await load();
        assert.equal(T.mod.isInstalled(), false);
        restore();
        T = await load({ standalone: true });
        assert.equal(T.mod.isInstalled(), true);
        restore();
        T = await load({ ua: UA.iosSafari, iosStandalone: true });
        assert.equal(T.mod.isInstalled(), true);
        restore();
        T = await load({ displayMode: 'window-controls-overlay' });
        assert.equal(T.mod.isInstalled(), true, 'desktop PWA with window controls overlay');
        restore();
        T = await load({ displayMode: 'fullscreen' });
        assert.equal(T.mod.isInstalled(), false, 'a browser tab in OS full screen is not installed');
    });

    test('Android Chrome: instructions first, then an Install button once the browser offers it', async () => {
        const T = await load();
        T.mod.mountInstallUI(T.mount);
        assert.ok(visible(section(T)));
        assert.ok(!visible(btn(T)), 'no button before beforeinstallprompt');
        assert.match(T.mount.textContent, /Chrome.*menu/i);
        const e = T.bip('accepted');
        assert.equal(e.defaultPrevented, true, 'mini-infobar suppressed in favour of the menu button');
        assert.ok(visible(btn(T)), 'button appears');
        btn(T).click();
        await T.flush(); await T.flush();
        assert.equal(e.prompted, 1);
        assert.match(T.mount.textContent, /Installed/);
        assert.ok(!visible(btn(T)));
    });

    test('a dismissed prompt cannot be reused: back to instructions', async () => {
        const T = await load();
        T.mod.mountInstallUI(T.mount);
        const e = T.bip('dismissed');
        btn(T).click();
        await T.flush(); await T.flush();
        assert.equal(e.prompted, 1);
        assert.ok(!visible(btn(T)));
        assert.match(T.mount.textContent, /menu/i);
        assert.equal(T.mod.installState().canPrompt, false);
    });

    test('event fired before the menu is mounted is kept for the button', async () => {
        const T = await load();
        T.bip();
        T.mod.mountInstallUI(T.mount);
        assert.ok(visible(btn(T)));
    });

    test('appinstalled switches the section to the installed message', async () => {
        const T = await load();
        T.mod.mountInstallUI(T.mount);
        T.bip();
        T.w.dispatchEvent(new T.w.Event('appinstalled'));
        assert.match(T.mount.textContent, /Installed/);
        assert.ok(!visible(btn(T)));
    });

    test('already installed (standalone): the section and its menu host (heading) are hidden', async () => {
        const T = await load({ standalone: true });
        T.mod.mountInstallUI(T.mount);
        assert.equal(section(T).hidden, true);
        assert.equal(T.mount.closest('.menu-section').hidden, true, 'no empty "Install app" heading');
    });

    test('switching to standalone at runtime hides the host; back to browser shows it', async () => {
        const T = await load();
        T.mod.mountInstallUI(T.mount);
        const host = T.mount.closest('.menu-section');
        assert.equal(host.hidden, false);
        const mq = T.w.matchMedia('(display-mode: standalone)');
        mq.matches = true;
        for (const f of mq._l) f();
        assert.equal(host.hidden, true);
        mq.matches = false;
        for (const f of mq._l) f();
        assert.equal(host.hidden, false);
    });

    for (const [name, ua, re] of [['iOS Safari', UA.iosSafari, /Share.*Add to Home Screen/], ['Samsung Internet', UA.samsung, /Samsung/], ['desktop Chrome', UA.desktopChrome, /install/i]]) {
        test(`instructions for ${name}`, async () => {
            const T = await load({ ua });
            T.mod.mountInstallUI(T.mount);
            assert.match(T.mount.querySelector('.b3d-install-how').textContent, re);
        });
    }

    test('destroy removes the section and stops listening', async () => {
        const T = await load();
        const ui = T.mod.mountInstallUI(T.mount);
        ui.destroy();
        assert.equal(section(T), null);
        assert.doesNotThrow(() => T.bip());
    });

    test('install hint: once, only when installable and not installed', async () => {
        let T = await load();
        assert.equal(T.mod.showInstallHint(T.w.document.body), false, 'no prompt yet');
        const e = T.bip();
        assert.equal(T.mod.showInstallHint(T.w.document.body), true);
        const toast = T.w.document.querySelector('.b3d-toast');
        assert.ok(toast);
        toast.querySelector('.primary').click();
        await T.flush();
        assert.equal(e.prompted, 1);
        T.bip();
        assert.equal(T.mod.showInstallHint(T.w.document.body), false, 'only once per browser');
        restore();
        T = await load({ standalone: true });
        T.bip();
        assert.equal(T.mod.showInstallHint(T.w.document.body), false, 'not when installed');
    });

    describe('registerServiceWorker', () => {
        test('registers sw.js at the site root with the site scope (GitHub Pages subpath)', async () => {
            const T = await load({ url: 'https://example.github.io/Chess-game-vibe-code/' });
            const reg = await T.mod.registerServiceWorker();
            assert.ok(reg);
            assert.deepEqual(T.swLog.registered, [{ url: 'https://example.github.io/Chess-game-vibe-code/sw.js', scope: '/Chess-game-vibe-code/' }]);
        });

        test('also from the 2D page or a deep link the scope is the site root', async () => {
            const T = await load({ url: 'https://example.github.io/Chess-game-vibe-code/2d.html?x=1' });
            await T.mod.registerServiceWorker();
            assert.equal(T.swLog.registered[0].scope, '/Chess-game-vibe-code/');
        });

        for (const [name, opts, args] of [
            ['no service worker support', { sw: false }, {}],
            ['insecure context', { secure: false }, {}],
            ['?debug=1', { url: 'https://example.github.io/Chess-game-vibe-code/?debug=1' }, {}],
            ['disabled', {}, { disabled: true }],
        ]) {
            test(`no-op: ${name}`, async () => {
                const T = await load(opts);
                assert.equal(await T.mod.registerServiceWorker(args), null);
                assert.equal(T.swLog.registered.length, 0);
            });
        }

        test('?nosw=1 unregisters existing workers', async () => {
            const T = await load({ url: 'https://example.github.io/Chess-game-vibe-code/?nosw=1' });
            assert.equal(await T.mod.registerServiceWorker(), null);
            assert.equal(T.swLog.unregistered, 1);
            assert.equal(T.swLog.registered.length, 0);
        });

        test('register failure resolves to null', async () => {
            const T = await load();
            T.swLog.fail = true;
            assert.equal(await T.mod.registerServiceWorker(), null);
        });

        test('update notice only when a new worker takes over an already controlled page, once', async () => {
            let T = await load();
            T.swLog.controller = { state: 'activated' };
            let updates = 0;
            await T.mod.registerServiceWorker({ onUpdate: () => updates++ });
            for (const f of T.swLog.listeners.controllerchange) f();
            for (const f of T.swLog.listeners.controllerchange) f();
            assert.equal(updates, 1);
            restore();
            T = await load();
            updates = 0;
            await T.mod.registerServiceWorker({ onUpdate: () => updates++ });
            for (const f of T.swLog.listeners.controllerchange) f();
            assert.equal(updates, 0, 'first install takes control silently');
            restore();
            T = await load();
            T.swLog.controller = {};
            await T.mod.registerServiceWorker();
            for (const f of T.swLog.listeners.controllerchange) f();
            assert.ok(T.w.document.querySelector('.b3d-toast'), 'default update toast');
            assert.match(T.w.document.querySelector('.b3d-toast').textContent, /new version/i);
        });
    });

    test('main.js loads install.js before the slow boot so an early beforeinstallprompt is not lost', () => {
        const main = fs.readFileSync(path.join(ROOT, 'battle3d', 'main.js'), 'utf8');
        const staticImport = /^import\s[^;]*from\s+['"]\.\/install\.js['"]/m.test(main);
        const earlyDynamic = (() => {
            const i = main.indexOf("import('./install.js')"), b = main.indexOf('async function boot');
            return i >= 0 && b >= 0 && i < b && !/function setupInstall[\s\S]*import\('\.\/install\.js'\)/.test(main.slice(0, b));
        })();
        assert.ok(staticImport || earlyDynamic);
    });
});
