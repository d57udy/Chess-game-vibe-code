'use strict';
// Layout of the 3D page in a real browser (RUN_SLOW=1, needs Google Chrome). jsdom lays nothing out, so
// these two bugs were only visible in Chrome:
//   1. Game review: with the reported 20-move game ("20... axb3 e.p." beside its badge) the right column of
//      the move list grew past the panel and every badge in it was cut off.
//   2. The en passant notice sat on top of the coach card (both bottom centre) and hid its text for 12 s.
//   3. Move markers: the pale dot and outline vanished on the light squares (d3 with the d2 pawn selected, f3
//      with Ng1), which read as "hidden under the label badge". Pixels are read back from the WebGL canvas.
// Measured at desktop size and at 360 px (the review is a bottom sheet there), with an overlay and with a
// classic 15 px scrollbar, with and without the install toast.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { haveChrome, serveRepo, launchChrome, sleep, CHROME } = require('../helpers/headlessChrome');

const skip = !process.env.RUN_SLOW ? 'slow: set RUN_SLOW=1 (npm run test:slow)' : (!haveChrome() && `Chrome not found at ${CHROME} (set CHROME_PATH)`);
const DESKTOP = { width: 1456, height: 839, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 360, height: 740, deviceScaleFactor: 1, mobile: true };
const GAME = ('e2e4 d7d6 f1b5 b8c6 h2h3 g8f6 b1c3 f6e4 c3e4 c8h3 h1h3 e7e6 d2d4 f8e7 f2f4 e7h4 e1f1 d6d5 e4c5 h4e1 f1e1 e6e5 ' +
    'c5b7 d8f6 d4e5 f6e6 d1d3 e8g8 d3c3 c6e7 c3c7 e6h3 g2h3 e7f5 b5d7 a7a5 d7f5 a5a4 b2b4 a4b3').split(' ');
const NOTICE = 'En passant: your pawn moved two squares and landed beside their pawn, so it can be taken as if it had moved one.';

// Plays moves through the controller, skipping the fights
const PLAY = `async (moves) => {
    const B = window.__b3d, sq = (s) => ({ row: 8 - Number(s[1]), col: s.charCodeAt(0) - 97 });
    for (const mv of moves) {
        const n = B.state().history.length;
        B.controller.move(sq(mv.slice(0, 2)), sq(mv.slice(2, 4)));
        for (let i = 0; i < 400 && (B.state().moving || B.state().history.length === n); i++) { B.controller.skip(); B.step(4); await new Promise((r) => setTimeout(r, 5)); }
    }
    return B.state().history.length;
}`;
// The review list: rows whose badge (or whole button, where badges are hidden) leaves the list's client box,
// and moves that had to be shortened with an ellipsis
const LIST = `(() => {
    const list = document.getElementById('coach-review-list'), box = list.getBoundingClientRect();
    const left = box.left + list.clientLeft, right = left + list.clientWidth;
    const rows = [...list.querySelectorAll('button.review-move')], clipped = [], shortened = [];
    for (const b of rows) {
        const tag = b.querySelector('.tag'), mv = b.querySelector('.mv'), br = b.getBoundingClientRect();
        const badge = getComputedStyle(tag).display !== 'none' && tag.textContent ? tag.getBoundingClientRect() : br;
        if (badge.right > right + 0.5 || br.right > right + 0.5 || br.left < left - 0.5) clipped.push(b.textContent);
        if (mv.scrollWidth > mv.clientWidth + 1) shortened.push(mv.textContent);
    }
    const panel = document.getElementById('coach-review').getBoundingClientRect();
    return { rows: rows.length, clipped, shortened, scrollbar: list.offsetWidth - list.clientWidth, scrolls: list.scrollHeight > list.clientHeight,
        sideways: list.scrollWidth - list.clientWidth, labels: rows.map((b) => b.querySelector('.mv').textContent), panelInside: panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight };
})()`;
// Everything that can stand at the bottom of the screen: overlapping pairs, and what leaves the viewport
const BOTTOM = `(() => {
    const els = { notice: document.getElementById('tip'), card: document.getElementById('coach-card'), toast: document.querySelector('.b3d-toast'),
        panel: document.getElementById('coach-review'), chip: document.getElementById('coach-review-chip'), bar: document.getElementById('review-bar') };
    const rects = {};
    for (const [k, el] of Object.entries(els)) if (el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0) rects[k] = el.getBoundingClientRect();
    const names = Object.keys(rects), overlaps = [], outside = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const a = rects[names[i]], b = rects[names[j]];
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps.push(names[i] + '/' + names[j]);
    }
    for (const n of names) { const r = rects[n]; if (r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5) outside.push(n); }
    return { visible: names, overlaps, outside, order: rects.notice && rects.card ? (rects.notice.bottom <= rects.card.top + 0.5 ? 'notice above card' : 'card above notice') : null };
})()`;

async function boot(C, origin) {
    await C.send('Emulation.setDeviceMetricsOverride', DESKTOP);
    await C.send('Page.navigate', { url: `${origin}?debug=1&nosw=1` });
    await C.waitFor('!!window.__b3d && document.getElementById("loading").hidden', 120000);
    await C.evaluate(`(localStorage.setItem('battle3d.settings', JSON.stringify({ mode: 'human-human', speed: 'fast', talk: 'off', coach: true, coachFrequency: 'every' })), localStorage.setItem('battle3d.tipSeen', '1'), true)`);
    await C.send('Page.reload');
    await C.waitFor('!!window.__b3d && document.getElementById("loading").hidden', 120000);
    await C.evaluate('(window.__b3d.controller.newGame(), true)');
}

test('game review list in Chrome: both columns fit the panel for the reported game, every badge inside the list', { skip, timeout: 400000 }, async (t) => {
    const S = await serveRepo();
    const C = await launchChrome();
    try {
        await boot(C, S.origin);
        for (const [label, moves] of [['the reported game', GAME], ['a short game without a scrollbar', GAME.slice(0, 6)]]) {
            await C.evaluate('(window.__b3d.coach.closeReview(), window.__b3d.controller.newGame(), true)');
            assert.equal(await C.evaluate(`(${PLAY})(${JSON.stringify(moves)})`), moves.length);
            await C.evaluate('(document.getElementById("coach-review-open").click(), true)');
            await C.waitFor('!/Analysing/.test(document.getElementById("coach-review-intro").textContent)', 180000);
            for (const [size, metrics] of [['desktop', DESKTOP], ['phone', PHONE]]) {
                await C.send('Emulation.setDeviceMetricsOverride', metrics);
                for (const classic of [false, true]) { // macOS draws overlay scrollbars; the second pass forces a 15 px one
                    await C.evaluate(`(() => { document.getElementById('test-scrollbar')?.remove(); if (${classic}) { const st = document.createElement('style'); st.id = 'test-scrollbar'; st.textContent = '#coach-review-list { scrollbar-width: auto !important; } #coach-review-list::-webkit-scrollbar { width: 15px; }'; document.head.append(st); } return true; })()`);
                    await sleep(300);
                    const m = await C.evaluate(LIST);
                    const what = `${label}, ${size}${classic ? ', classic scrollbar' : ''}`;
                    assert.equal(m.rows, moves.length, what);
                    assert.deepEqual(m.clipped, [], `${what}: no row or badge leaves the list`);
                    assert.equal(m.sideways, 0, `${what}: the list does not scroll sideways`);
                    assert.equal(m.panelInside, true, `${what}: the panel is on screen`);
                    assert.deepEqual(m.shortened, [], `${what}: no move text had to be shortened for this game`);
                    if (classic && moves.length > 20) assert.ok(m.scrollbar >= 10, `${what}: a scrollbar that takes room (${m.scrollbar}px)`);
                    if (moves.length === GAME.length) assert.equal(m.labels.at(-1), 'axb3 e.p.', what);
                }
            }
        }
        t.diagnostic('40 rows and 6 rows, desktop 1456 x 839 and phone 360 x 740, overlay and classic scrollbar: 0 clipped, 0 shortened');
        assert.deepEqual(C.problems(), [], 'no exceptions or console errors');
    } finally {
        await C.close();
        S.server.close();
    }
});

test('the bottom of the screen in Chrome: notice, coach card, install toast, review panel and chip never overlap', { skip, timeout: 400000 }, async () => {
    const S = await serveRepo();
    const C = await launchChrome();
    try {
        await boot(C, S.origin);
        const epCapture = async () => {
            await C.evaluate(`(localStorage.removeItem('battle3d.enPassantSeen'), window.__b3d.coach.closeReview(), window.__b3d.controller.newGame(), true)`);
            await C.evaluate(`(${PLAY})(['e2e4', 'a7a6', 'e4e5', 'd7d5'])`);
            // 3. exd6 e.p. with the fight played out: the notice comes up as the move starts, the card when it is judged
            await C.evaluate(`(() => { const sq = (s) => ({ row: 8 - Number(s[1]), col: s.charCodeAt(0) - 97 }); window.__b3d.controller.move(sq('e5'), sq('d6')); return true; })()`);
            assert.equal(await C.evaluate('document.getElementById("tip").hidden'), false, 'the notice shows as the capture starts');
            assert.match(await C.evaluate('document.getElementById("tip-text").textContent'), /^En passant: /);
            await C.waitFor(`!window.__b3d.state().moving && !document.getElementById('coach-card').hidden && /exd6/.test(document.getElementById('coach-move').textContent)`, 60000);
            // The notice hides itself after 12 s; a slow engine can take that long, then it is put back for the measurement
            await C.evaluate(`(() => { const t = document.getElementById('tip'); if (t.hidden) { document.getElementById('tip-text').textContent = ${JSON.stringify(NOTICE)}; t.hidden = false; } return true; })()`);
        };
        const check = async (what, expectVisible) => {
            const entering = await C.evaluate(BOTTOM); // the notice is still sliding in
            await sleep(600);
            const settled = await C.evaluate(BOTTOM);
            for (const m of [entering, settled]) {
                assert.deepEqual(m.overlaps, [], `${what}: nothing overlaps ${JSON.stringify(m)}`);
                assert.deepEqual(m.outside, [], `${what}: everything is on screen`);
            }
            for (const name of expectVisible) assert.ok(settled.visible.includes(name), `${what}: ${name} is showing (${settled.visible})`);
            return settled;
        };
        for (const [size, metrics] of [['desktop', DESKTOP], ['phone', PHONE]]) {
            await C.send('Emulation.setDeviceMetricsOverride', metrics);
            for (const toast of [false, true]) {
                // The page's own toast (install.js), placed where main.js places it, with the longer of its two texts
                await C.evaluate(`(async () => {
                    document.querySelectorAll('.b3d-toast').forEach((e) => e.remove());
                    if (!${toast}) return true;
                    const el = (await import('./battle3d/install.js')).showUpdateToast(document.querySelector('.bottom-stack'));
                    el.querySelector('span').textContent = 'Install Chess 3D as an app to play full screen and offline?';
                    el.querySelector('button.primary').textContent = 'Install';
                    return true;
                })()`);
                await epCapture();
                if (toast) assert.ok(await C.evaluate(`!!document.querySelector('.bottom-stack > .b3d-toast')`), 'the toast is part of the stack');
                const m = await check(`${size}${toast ? ', install toast' : ''}`, ['notice', 'card', ...(toast ? ['toast'] : [])]);
                assert.equal(m.order, 'notice above card', `${size}: the notice stands above the coach card`);
            }
            await C.evaluate(`(document.querySelectorAll('.b3d-toast').forEach((e) => e.remove()), true)`);
            // The review panel (a bottom sheet on a phone) open, then minimised to its chip
            await C.evaluate('(document.getElementById("coach-review-open").click(), true)');
            await check(`${size}, review open`, ['notice', 'panel']);
            await C.evaluate('(document.getElementById("coach-review-min").click(), true)');
            await check(`${size}, review minimised`, ['notice', 'chip']);
            await C.evaluate('(document.getElementById("tip").hidden = true, window.__b3d.coach.closeReview(), true)');
        }
        // With the long review list the docked panel reaches the bottom of the screen: the notice keeps clear of it
        await C.send('Emulation.setDeviceMetricsOverride', DESKTOP);
        await C.evaluate('(window.__b3d.controller.newGame(), true)');
        await C.evaluate(`(${PLAY})(${JSON.stringify(GAME)})`);
        await C.evaluate(`(document.getElementById('coach-review-open').click(), document.getElementById('tip-text').textContent = ${JSON.stringify(NOTICE)}, document.getElementById('tip').hidden = false, true)`);
        for (const metrics of [DESKTOP, { ...DESKTOP, width: 1024, height: 700 }, { ...DESKTOP, width: 700, height: 800 }, PHONE]) {
            await C.send('Emulation.setDeviceMetricsOverride', metrics);
            await check(`review of the 40-move game at ${metrics.width} x ${metrics.height}`, ['notice', 'panel']);
        }
        assert.deepEqual(C.problems(), [], 'no exceptions or console errors');
    } finally {
        await C.close();
        S.server.close();
    }
});

// Selects a unit and measures, for each offered square, how much its marker changes the picture: four renders
// of the same instant (markers on / off, labels on / off) read back from the WebGL canvas. Per square:
//   dot / ring  share of the marker's own pixels that change strongly (summed RGB difference of 90 or more of 765)
//   mean        mean summed RGB difference on those pixels
//   outline     share of the points on the square's outline that change (60 or more); empty squares only
const MARKERS = `(async (fen, side, from) => {
    const B = window.__b3d, S = B.sceneAPI, sq = (s) => ({ row: 8 - Number(s[1]), col: s.charCodeAt(0) - 97 });
    const name = (m) => String.fromCharCode(97 + m.col) + (8 - m.row);
    document.getElementById(side === 'w' ? 'side-w' : 'side-b').click();
    if (fen) B.controller.loadFen(fen); else B.controller.newGame();
    for (let i = 0; i < 900 && (S.isCameraBusy() || i < 40); i++) { B.step(1); if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0)); }
    const f = sq(from);
    B.controller.clickSquare(f.row, f.col);
    const moves = generateLegalMoves(f.row, f.col);
    const gl = S.renderer.getContext(), canvas = S.renderer.domElement, W = canvas.width, H = canvas.height;
    const hl = S.scene.getObjectByName('highlights');
    const shot = (labels, marks) => { B.controller.setLabels(labels); hl.visible = marks; S.stepFrames(1, 0); const buf = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf); return buf; };
    const R = { on: [shot(true, true), shot(true, false)], off: [shot(false, true), shot(false, false)] };
    hl.visible = true; B.controller.setLabels(true); S.stepFrames(1, 0);
    const pixel = (x, y, z) => { const p = new S.THREE.Vector3(x, y, z).project(S.camera); return [Math.round((p.x + 1) / 2 * W), Math.round((p.y + 1) / 2 * H)]; };
    const delta = (pair, px, py) => { if (px < 0 || py < 0 || px >= W || py >= H) return 0; const i = (py * W + px) * 4; return Math.abs(pair[0][i] - pair[1][i]) + Math.abs(pair[0][i + 1] - pair[1][i + 1]) + Math.abs(pair[0][i + 2] - pair[1][i + 2]); };
    const out = [];
    for (const m of moves) {
        const cx = m.col - 3.5, cz = m.row - 3.5, capture = !!getPieceAt(m.row, m.col) || m.isEnPassant;
        const pts = [], line = [];
        for (let a = 0; a < 24; a++) for (const r of capture ? [0.36, 0.38, 0.40] : [0.02, 0.06, 0.10]) pts.push(pixel(cx + r * Math.cos(a * Math.PI / 12), 0.012, cz + r * Math.sin(a * Math.PI / 12)));
        if (!capture) for (let t = -0.3; t <= 0.301; t += 0.075) for (const [x, z] of [[t, -0.376], [t, 0.376], [-0.376, t], [0.376, t]]) line.push(pixel(cx + x, 0.011, cz + z));
        for (const labels of ['on', 'off']) {
            out.push({ square: name(m), light: (m.row + m.col) % 2 === 0, capture, labels,
                marker: pts.filter(([x, y]) => delta(R[labels], x, y) >= 90).length / pts.length,
                mean: pts.reduce((sum, [x, y]) => sum + delta(R[labels], x, y), 0) / pts.length,
                outline: line.length ? line.filter(([x, y]) => delta(R[labels], x, y) >= 60).length / line.length : null });
        }
    }
    return out;
})`;

test('move markers in Chrome: the dot (or ring) and the outline show on every offered square, light or dark, labels on or off', { skip, timeout: 400000 }, async (t) => {
    const S = await serveRepo();
    const C = await launchChrome();
    const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-markers-'));
    try {
        await boot(C, S.origin);
        await C.evaluate(`(document.getElementById('coach-toggle').checked && document.getElementById('coach-toggle').click(), true)`);
        const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
        const CASES = [
            [null, 'w', 'd2', ['d3', 'd4']], [null, 'w', 'g1', ['f3', 'h3']], ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'w', 'e5', ['d6', 'e6']],
            [AFTER_E4, 'b', 'd7', ['d5', 'd6']], [AFTER_E4, 'b', 'g8', ['f6', 'h6']], ['4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1', 'b', 'e4', ['d3', 'e3']],
        ];
        const report = [];
        for (const [fen, side, from, targets] of CASES) {
            const rows = await C.evaluate(`(${MARKERS})(${JSON.stringify(fen)}, '${side}', '${from}')`);
            assert.deepEqual([...new Set(rows.map((r) => r.square))].sort(), targets, `${side} ${from}: offered squares`);
            for (const r of rows) {
                const what = `${side === 'w' ? 'White' : 'Black'}'s view, ${from} selected, ${r.square} (${r.light ? 'light' : 'dark'} square, ${r.capture ? 'capture ring' : 'dot'}), labels ${r.labels}`;
                // A dot is drawn over figures and labels, so all of it shows; a capture ring lies on the board around its piece
                assert.ok(r.marker >= (r.capture ? 0.5 : 0.95), `${what}: the marker shows on ${(100 * r.marker).toFixed(0)}% of its pixels`);
                assert.ok(r.mean >= (r.capture ? 80 : 120), `${what}: it stands out (mean colour change ${r.mean.toFixed(0)} of 765)`);
                if (!r.capture) assert.ok(r.outline >= 0.6, `${what}: the outline shows on ${(100 * r.outline).toFixed(0)}% of its line`);
            }
            report.push(`${side} ${from}: ${rows.filter((r) => r.labels === 'on').map((r) => `${r.square} ${(100 * r.marker).toFixed(0)}%${r.outline === null ? '' : `/${(100 * r.outline).toFixed(0)}%`}`).join(', ')}`);
            // A screenshot of the case (the unit is still selected, labels on), to look at
            await C.evaluate(`(window.__b3d.sceneAPI.stepFrames(2, 0), true)`);
            await sleep(300);
            const shot = await C.send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(shots, `markers-${side}-${from}.png`), Buffer.from(shot.result.data, 'base64'));
        }
        t.diagnostic(`marker / outline share with labels on: ${report.join('; ')}`);
        t.diagnostic(`screenshots: ${shots}`);
        assert.deepEqual(C.problems(), [], 'no exceptions or console errors');
    } finally {
        await C.close();
        S.server.close();
    }
});

