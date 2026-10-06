'use strict';
// v3 page layout: 3D at index.html, 2D at 2d.html, battle3d.html redirects to ./ keeping the query
// string and hash. All links are relative (GitHub Pages subpath) and every local target exists.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { ROOT } = require('../helpers/loadEngine');
const { page2d, page3d } = require('../helpers/pages');

const html = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const docOf = (f) => new JSDOM(html(f)).window.document;
const isExternal = (u) => /^(https?:)?\/\//i.test(u) || /^(data|mailto|blob|javascript):/i.test(u);

describe('battle3d v3 pages and links', () => {
    test('3D is the default page (index.html) and 2D lives at 2d.html', () => {
        assert.equal(page3d(), 'index.html');
        assert.equal(page2d(), '2d.html');
    });

    test('2D page links to the 3D game with "./"', () => {
        const a = docOf('2d.html').getElementById('play-3d-link') || [...docOf('2d.html').querySelectorAll('a')].find((x) => /3D/i.test(x.textContent));
        assert.ok(a, '2D page has a Play in 3D link');
        assert.equal(a.getAttribute('href'), './');
    });

    test('3D page: back link and WebGL fallback point to 2d.html; boot error link too', () => {
        const d = docOf('index.html');
        const back = d.querySelector('a.back-link');
        assert.equal(back?.getAttribute('href'), '2d.html');
        const fallback = d.querySelector('#fallback a');
        assert.equal(fallback?.getAttribute('href'), '2d.html');
        const main = fs.readFileSync(path.join(ROOT, 'battle3d', 'main.js'), 'utf8');
        const hrefs = [...main.matchAll(/\.href\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
        assert.ok(hrefs.length > 0, 'main.js sets a fallback link');
        for (const h of hrefs) assert.equal(h, '2d.html', `main.js link ${h}`);
        assert.ok(!/['"](\.\/)?index\.html['"]/.test(main), 'main.js does not send players to index.html (now the 3D page)');
    });

    for (const f of ['index.html', '2d.html', 'battle3d.html']) {
        test(`${f}: every local href/src is relative and exists`, () => {
            const d = docOf(f);
            const refs = [];
            for (const el of d.querySelectorAll('[href], [src]')) {
                const u = el.getAttribute('href') ?? el.getAttribute('src');
                if (!u || u.startsWith('#') || isExternal(u)) continue;
                refs.push(u);
            }
            assert.ok(refs.length > 0);
            for (const u of refs) {
                assert.ok(!u.startsWith('/'), `${f}: absolute path ${u} breaks under the GitHub Pages subpath`);
                const target = decodeURIComponent(u.split(/[?#]/)[0]) || './';
                const file = target === './' || target.endsWith('/') ? path.join(ROOT, target, 'index.html') : path.join(ROOT, target);
                assert.ok(fs.existsSync(file), `${f}: ${u} -> missing ${path.relative(ROOT, file)}`);
            }
        });
    }

    test('battle3d.html redirects to ./ keeping query string and hash', () => {
        const src = html('battle3d.html');
        assert.match(src, /<meta http-equiv="refresh" content="0; ?url=\.\/"/i, 'meta refresh fallback for no-JS');
        const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
        assert.ok(scripts.length, 'inline redirect script');
        for (const [search, hash] of [['?debug=1', ''], ['', ''], ['?a=1&b=2', '#x'], ['', '#moves']]) {
            const calls = [];
            const location = { search, hash, href: 'http://h/Chess-game-vibe-code/battle3d.html' + search + hash, replace: (u) => calls.push(['replace', u]), assign: (u) => calls.push(['assign', u]) };
            Object.defineProperty(location, 'href', { set: (u) => calls.push(['href', u]), get: () => 'x' });
            for (const s of scripts) vm.runInNewContext(s, { location, window: { location }, document: {} });
            assert.equal(calls.length, 1, `one navigation for ${search}${hash}`);
            assert.equal(calls[0][1], './' + search + hash);
            assert.equal(calls[0][0], 'replace', 'replace() so the redirect page is not in history');
        }
        const d = docOf('battle3d.html');
        assert.ok(!d.querySelector('script[src*="main.js"]'), 'no game code on the redirect page');
    });

    test('3D page title and 2D page title are distinct', () => {
        const t3 = docOf('index.html').title, t2 = docOf('2d.html').title;
        assert.match(t3, /3D/);
        assert.notEqual(t3, t2);
    });
});
