'use strict';
// battleFx.js in jsdom with the real GSAP (pretendToBeVisual gives it requestAnimationFrame).
// Pieces get fake screen rectangles so the scenes have real geometry to work with.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { ROOT, square } = require('../helpers/loadEngine');

const SQUARE_PX = 50;
const PAGE = `<!DOCTYPE html><html><body>
    <div class="board-container"><div id="chess-board"></div><div class="battle-layer"></div></div>
    <input id="text-input"><button id="a-button">Go</button>
    <select id="a-select"><option>one</option><option>two</option></select></body></html>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} [options]
 * @param {number} [options.speed] global GSAP time scale (default 20, so scenes take a few frames)
 * @param {(w: Window) => void} [options.setup] runs before battleFx.js (seed storage, matchMedia)
 */
function loadFx(options = {}) {
    const dom = new JSDOM(PAGE, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    const errors = [];
    w.console.error = (...a) => errors.push(a.map(String).join(' '));
    w.console.warn = (...a) => errors.push(a.map(String).join(' '));
    w.console.log = () => {};
    const ctx = dom.getInternalVMContext();
    const g = (code, filename = 'test-expr') => new vm.Script(code, { filename }).runInContext(ctx);
    const file = (rel) => g(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel);
    if (options.setup) options.setup(w);
    file('node_modules/gsap/dist/gsap.js');
    g(`gsap.globalTimeline.timeScale(${options.speed || 20});`);
    file('gameLogic.js');
    // Stand-ins for ui.js globals that BattleFX looks up at runtime
    g(`var __played = []; var sounds = { capture: { name: 'capture' } };
       function playSound(a) { __played.push(a.name); }`);
    file('battleFx.js');

    const doc = w.document;
    const board = doc.getElementById('chess-board');
    const layer = doc.querySelector('.battle-layer');
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 8 * SQUARE_PX, height: 8 * SQUARE_PX });

    const fx = {
        w, doc, g, board, layer, errors,
        FX: w.BattleFX,
        played: () => JSON.parse(g('JSON.stringify(__played)')),
        flipped: false,
        // Screen rect of a logical square, honoring the orientation like ui.js toVisual()
        rectOf(row, col) {
            const vr = fx.flipped ? 7 - row : row;
            const vc = fx.flipped ? 7 - col : col;
            return { left: vc * SQUARE_PX, top: vr * SQUARE_PX, width: SQUARE_PX, height: SQUARE_PX };
        },
        square(name) {
            const { row, col } = square(name);
            const el = doc.createElement('div');
            el.className = 'square';
            el.dataset.row = row;
            el.dataset.col = col;
            el.getBoundingClientRect = () => fx.rectOf(row, col);
            board.appendChild(el);
            return el;
        },
        piece(code, name) {
            const { row, col } = square(name);
            const el = doc.createElement('div');
            el.className = 'piece';
            el.textContent = g(`PIECES[${JSON.stringify(code)}]`);
            el.dataset.piece = code;
            el.dataset.row = row;
            el.dataset.col = col;
            el.getBoundingClientRect = () => fx.rectOf(row, col);
            board.appendChild(el);
            return el;
        },
        // Sets up attacker and victim and returns the arguments for BattleFX.play
        capture(attacker, from, victim, to, extra = {}) {
            const victimSquare = extra.victimAt || to;
            return {
                attackerEl: fx.piece(attacker, from),
                victimEl: fx.piece(victim, victimSquare),
                attackerPiece: attacker,
                victimPiece: victim,
                from: square(from),
                to: square(to),
                victimSquareEl: fx.square(victimSquare),
                ctx: extra.ctx || {},
                ...(extra.args || {})
            };
        },
        hiddenPieces: () => Array.from(board.querySelectorAll('.piece')).filter(p => p.style.visibility === 'hidden'),
        close() { w.close(); },
    };
    return fx;
}

function withFx(options, fn) {
    if (typeof options === 'function') { fn = options; options = {}; }
    return async () => {
        const fx = loadFx(options);
        try { await fn(fx); } finally { fx.close(); }
    };
}

// Cleanup contract checked after every scene
function assertCleanedUp(fx, args) {
    assert.equal(fx.layer.children.length, 0, 'battle layer empty');
    assert.equal(args.victimEl.isConnected, false, 'victim element removed');
    assert.equal(args.attackerEl.isConnected, true, 'attacker element still in the board');
    assert.equal(args.attackerEl.style.visibility, '', 'attacker element visible');
    assert.equal(fx.FX.isPlaying(), false);
    assert.equal(fx.doc.querySelector('.board-container').style.transform, '', 'shake cleared');
}

// Typical capture geometry for each attacker (white, from d4) against a black victim
const ATTACK_SQUARES = { P: 'e5', N: 'f5', B: 'g7', R: 'd8', Q: 'd7', K: 'e5' };

describe('BattleFX scenes', () => {
    test('all 30 attacker x victim pairings resolve, play the sound once, and clean up', withFx(async (fx) => {
        for (const attacker of 'PNBRQK') {
            for (const victim of 'pnbrq') {
                const args = fx.capture(attacker, 'd4', victim, ATTACK_SQUARES[attacker]);
                const before = fx.played().length;
                const started = Date.now();
                const promise = fx.FX.play(args);
                assert.equal(fx.FX.isPlaying(), true, `${attacker}x${victim} playing`);
                assert.ok(fx.layer.querySelectorAll('.battle-fx').length <= 30, 'particle cap');
                assert.equal(fx.layer.querySelectorAll('.battle-actor').length, 2);
                assert.equal(args.attackerEl.style.visibility, 'hidden', 'original hidden during the scene');
                const result = await promise;
                assert.equal(result, true, `${attacker}x${victim} reports the capture sound`);
                assert.ok(Date.now() - started < 1000, `${attacker}x${victim} finished by its timeline, not the timeout`);
                assert.deepEqual(fx.played().slice(before), ['capture'], `${attacker}x${victim} sound once`);
                assertCleanedUp(fx, args);
                args.attackerEl.remove();
                fx.board.innerHTML = '';
            }
        }
        assert.deepEqual(fx.errors, []);
    }));

    test('effects stay hidden until their beat (no particles at the start of a scene)', withFx({ speed: 1 }, async (fx) => {
        const cases = [
            ['R', 'd4', 'p', 'd8', {}],
            ['Q', 'd4', 'r', 'd7', {}],
            ['B', 'd4', 'q', 'g7', {}],
            ['P', 'b7', 'r', 'a8', { ctx: { promotionTo: 'Q' } }],
            ['N', 'd4', 'q', 'f5', { ctx: { givesCheck: true } }],
        ];
        for (const [attacker, from, victim, to, extra] of cases) {
            const args = fx.capture(attacker, from, victim, to, extra);
            const promise = fx.FX.play(args);
            const visible = Array.from(fx.layer.querySelectorAll('.battle-fx'))
                // Beams start at full opacity but zero width, which is equally invisible
                .filter(el => parseFloat(el.style.opacity || '1') > 0 && fx.w.gsap.getProperty(el, 'scaleX') > 0);
            assert.equal(visible.length, 0, `${attacker}x${victim}: ${visible.length} effects visible at t=0`);
            fx.FX.skip();
            await promise;
            args.attackerEl.remove();
            fx.board.innerHTML = '';
        }
    }));

    test('signature pairings are defined and the king is never a victim', withFx(async (fx) => {
        assert.deepEqual(Object.keys(fx.FX.signatures).sort(), ['b>b', 'enPassant', 'n>q', 'p>q', 'q>p', 'r>r']);
        assert.deepEqual(Object.keys(fx.FX.attacks).sort(), ['b', 'k', 'n', 'p', 'q', 'r']);
        assert.deepEqual(Object.keys(fx.FX.deaths).sort(), ['b', 'n', 'p', 'q', 'r']);
    }));

    test('en passant, promotion capture and check pointer', withFx(async (fx) => {
        const ep = fx.capture('P', 'e5', 'p', 'd6', { victimAt: 'd5', ctx: { enPassant: true } });
        assert.equal(await fx.FX.play(ep), true);
        assertCleanedUp(fx, ep);

        const promo = fx.capture('P', 'b7', 'r', 'a8', { ctx: { promotionTo: 'Q' } });
        assert.equal(await fx.FX.play(promo), true);
        assertCleanedUp(fx, promo);
        assert.equal(promo.attackerEl.dataset.piece, 'Q', 'real element shows the promoted piece');
        assert.equal(promo.attackerEl.textContent, fx.g('PIECES.Q'));

        const blackPromo = fx.capture('p', 'g2', 'N', 'h1', { ctx: { promotionTo: 'N' } });
        await fx.FX.play(blackPromo);
        assert.equal(blackPromo.attackerEl.dataset.piece, 'n', 'promotion keeps the mover color');

        const king = fx.piece('k', 'e8');
        const check = fx.capture('B', 'c4', 'p', 'f7', { args: { checkedKingEl: king } });
        const promise = fx.FX.play(check);
        assert.ok(Array.from(fx.layer.querySelectorAll('.battle-bubble')).some(b => b.textContent === '!'), 'check "!" bubble');
        assert.equal(await promise, true);
        assertCleanedUp(fx, check);
        assert.equal(king.isConnected, true);
        assert.deepEqual(fx.errors, []);
    }));

    test('checkmate finale topples the king and cleans up', withFx(async (fx) => {
        const king = fx.piece('k', 'g8');
        const promise = fx.FX.playFinale({ kingEl: king, kingPiece: 'k' });
        assert.equal(king.style.visibility, 'hidden');
        assert.ok(fx.layer.querySelector('.battle-crown'), 'crown');
        assert.equal(await promise, undefined);
        assert.equal(fx.layer.children.length, 0);
        assert.equal(king.style.visibility, '');
        assert.ok(king.classList.contains('toppled'));
        assert.deepEqual(fx.played(), [], 'the finale leaves the game-over sound to ui.js');
    }));

    for (const flipped of [false, true]) {
        test(`attacks move toward the victim in screen space (${flipped ? 'Black' : 'White'} at the bottom)`, withFx({ speed: 2 }, async (fx) => {
            fx.flipped = flipped;
            const sign = flipped ? 1 : -1; // a8 is above a1 with White at the bottom
            const track = async (args, prop) => {
                const extremes = [];
                const sample = () => {
                    const clone = fx.layer.querySelector('.battle-actor');
                    if (clone) extremes.push(fx.w.gsap.getProperty(clone, prop));
                };
                fx.w.gsap.ticker.add(sample);
                await fx.FX.play(args);
                fx.w.gsap.ticker.remove(sample);
                return extremes.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
            };
            const rookY = await track(fx.capture('R', 'a1', 'r', 'a8'), 'y');
            assert.ok(Math.sign(rookY) === sign && Math.abs(rookY) > 4 * SQUARE_PX, `rook charges toward a8 (y=${rookY})`);
            fx.board.innerHTML = '';
            const pawnX = await track(fx.capture('P', 'e5', 'p', 'd6', { victimAt: 'd5', ctx: { enPassant: true } }), 'x');
            assert.ok(Math.sign(pawnX) === sign && Math.abs(pawnX) >= SQUARE_PX * 0.9, `en passant pawn steps toward the d file (x=${pawnX})`);
            fx.board.innerHTML = '';
            const pawnY = await track(fx.capture('P', 'e5', 'p', 'd6', { victimAt: 'd5', ctx: { enPassant: true } }), 'y');
            assert.ok(Math.sign(pawnY) === sign && Math.abs(pawnY) >= SQUARE_PX * 0.9, `en passant pawn steps behind the victim, toward rank 6 (y=${pawnY})`);
        }));
    }
});

describe('BattleFX guards', () => {
    test('skip() mid-scene resolves promptly and cleans up; before impact no sound is reported', withFx({ speed: 1 }, async (fx) => {
        const args = fx.capture('Q', 'd1', 'q', 'd8');
        const promise = fx.FX.play(args);
        await sleep(50);
        const t0 = Date.now();
        fx.FX.skip();
        assert.equal(await promise, false);
        assert.ok(Date.now() - t0 < 50);
        assert.deepEqual(fx.played(), []);
        assertCleanedUp(fx, args);
        fx.FX.skip(); // no scene: harmless
    }));

    test('cancelAll() resolves and cleans up; a new play() ends the previous scene', withFx({ speed: 1 }, async (fx) => {
        const first = fx.capture('R', 'a1', 'n', 'a5');
        const p1 = fx.FX.play(first);
        const second = fx.capture('B', 'c1', 'p', 'h6');
        const p2 = fx.FX.play(second);
        assert.equal(await p1, false);
        assert.equal(first.victimEl.isConnected, false);
        assert.equal(first.attackerEl.style.visibility, '');
        assert.equal(fx.layer.querySelectorAll('.battle-actor').length, 2, 'only the second scene remains');
        fx.FX.cancelAll();
        assert.equal(await p2, false);
        assertCleanedUp(fx, second);
    }));

    test('the timeout resolves a scene when the GSAP ticker is frozen', withFx({ speed: 1 }, async (fx) => {
        fx.w.gsap.globalTimeline.pause();
        const args = fx.capture('P', 'd4', 'p', 'e5');
        const t0 = Date.now();
        const result = await fx.FX.play({ ...args, mode: 'fast' });
        const elapsed = Date.now() - t0;
        assert.equal(result, false, 'the impact frame never ran');
        assert.ok(elapsed >= 500 && elapsed < 2000, `resolved by the timeout after ${elapsed} ms`);
        assertCleanedUp(fx, args);
        fx.w.gsap.globalTimeline.resume();
    }));

    test('the page becoming hidden resolves the scene', withFx({ speed: 1 }, async (fx) => {
        const args = fx.capture('N', 'd4', 'b', 'e6');
        const promise = fx.FX.play(args);
        await sleep(30);
        Object.defineProperty(fx.doc, 'visibilityState', { value: 'hidden', configurable: true });
        fx.doc.dispatchEvent(new fx.w.Event('visibilitychange'));
        await promise;
        assertCleanedUp(fx, args);
        // Already hidden when the capture starts: no scene at all
        const later = fx.capture('P', 'a2', 'p', 'b3');
        await fx.FX.play(later);
        assertCleanedUp(fx, later);
    }));

    test('a click on the board skips the scene and never reaches the board', withFx({ speed: 1 }, async (fx) => {
        let boardClicks = 0;
        fx.board.addEventListener('click', () => boardClicks++);
        const args = fx.capture('K', 'e1', 'p', 'e2');
        const promise = fx.FX.play(args);
        args.victimSquareEl.dispatchEvent(new fx.w.MouseEvent('click', { bubbles: true }));
        await promise;
        assertCleanedUp(fx, args);
        assert.equal(boardClicks, 0);
        fx.board.dispatchEvent(new fx.w.MouseEvent('click', { bubbles: true }));
        assert.equal(boardClicks, 1, 'clicks reach the board again after the scene');
    }));

    test('a key skips the scene unless typed in a form control or with a modifier', withFx({ speed: 1 }, async (fx) => {
        let docKeys = 0;
        fx.doc.addEventListener('keydown', () => docKeys++);
        const args = fx.capture('B', 'c1', 'q', 'g5');
        const promise = fx.FX.play(args);
        const input = fx.doc.getElementById('text-input');
        input.dispatchEvent(new fx.w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        fx.doc.dispatchEvent(new fx.w.KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true }));
        assert.equal(fx.FX.isPlaying(), true, 'form-control and modifier keys do not skip');
        assert.equal(docKeys, 2);
        fx.doc.dispatchEvent(new fx.w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        await promise;
        assert.equal(docKeys, 2, 'the skipping key is not handled by the page');
        assertCleanedUp(fx, args);
    }));

    test('a focused button or select keeps its own keys; other keys and no modifiers skip', withFx({ speed: 1 }, async (fx) => {
        const key = (target, k) => target.dispatchEvent(new fx.w.KeyboardEvent('keydown', { key: k, bubbles: true }));
        const button = fx.doc.getElementById('a-button');
        const select = fx.doc.getElementById('a-select');
        const args = fx.capture('B', 'c1', 'q', 'g5');
        const promise = fx.FX.play(args);
        key(button, ' ');
        key(button, 'Enter');
        key(select, 'ArrowDown');
        key(fx.doc, 'Shift');
        key(fx.doc, 'CapsLock');
        assert.equal(fx.FX.isPlaying(), true, 'control keys and lone modifiers do not skip');
        key(button, 'x');
        await promise;
        assert.equal(fx.FX.isPlaying(), false, 'any other key skips, even with a button focused');
        assertCleanedUp(fx, args);
    }));

    test('mode "off" and missing elements resolve at once without a scene', withFx(async (fx) => {
        const args = fx.capture('P', 'd4', 'p', 'e5');
        assert.equal(await fx.FX.play({ ...args, mode: 'off' }), false);
        assert.equal(args.victimEl.isConnected, false);
        assert.equal(fx.layer.children.length, 0);
        assert.equal(await fx.FX.play({ victimEl: null, attackerEl: null }), false);
        assert.equal(await fx.FX.playFinale({}), undefined);
    }));
});

describe('BattleFX mode setting', () => {
    test('defaults to full, persists choices, ignores unknown values', withFx(async (fx) => {
        assert.equal(fx.FX.mode, 'full');
        assert.equal(fx.FX.modeIsUserSet, false);
        fx.FX.mode = 'fast';
        assert.equal(fx.FX.mode, 'fast');
        assert.equal(fx.FX.modeIsUserSet, true);
        assert.equal(fx.w.localStorage.getItem('chess.battleMode'), 'fast');
        fx.FX.mode = 'slow-motion';
        assert.equal(fx.FX.mode, 'fast');
    }));

    test('a stored mode is restored; an invalid stored value is ignored', async () => {
        for (const [stored, expected, userSet] of [['off', 'off', true], ['fast', 'fast', true], ['bogus', 'full', false]]) {
            const fx = loadFx({ setup: (w) => w.localStorage.setItem('chess.battleMode', stored) });
            try {
                assert.equal(fx.FX.mode, expected);
                assert.equal(fx.FX.modeIsUserSet, userSet);
            } finally { fx.close(); }
        }
    });

    test('works when localStorage throws', withFx({
        setup: (w) => {
            Object.defineProperty(w, 'localStorage', { get() { throw new Error('denied'); }, configurable: true });
        }
    }, async (fx) => {
        assert.equal(fx.FX.mode, 'full');
        fx.FX.mode = 'off';
        assert.equal(fx.FX.mode, 'off', 'kept in memory');
        assert.deepEqual(fx.errors, []);
    }));

    test('prefers-reduced-motion defaults to off; a stored choice wins', async () => {
        const reduce = (w) => { w.matchMedia = (q) => ({ matches: q.includes('reduce'), media: q }); };
        let fx = loadFx({ setup: reduce });
        try { assert.equal(fx.FX.mode, 'off'); } finally { fx.close(); }
        fx = loadFx({ setup: (w) => { reduce(w); w.localStorage.setItem('chess.battleMode', 'full'); } });
        try { assert.equal(fx.FX.mode, 'full'); } finally { fx.close(); }
    });

    test('switching to off skips a running scene', withFx({ speed: 1 }, async (fx) => {
        const args = fx.capture('R', 'h1', 'b', 'h7');
        const promise = fx.FX.play(args);
        fx.FX.mode = 'off';
        await promise;
        assertCleanedUp(fx, args);
    }));
});
