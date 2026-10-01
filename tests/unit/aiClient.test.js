'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadEngine, source, uci, GLOBALS_EXPR } = require('../helpers/loadEngine');

const MATE_IN_1 = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'; // Ra8#
const BLACK_PROMO = '8/8/8/8/8/k7/1p6/7K b - - 0 1'; // ...b1=Q
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs aiWorker.js in its own vm context with importScripts/postMessage shims.
function makeWorkerScope(onPost, logs = []) {
    const scope = {
        console: { log() {}, warn() {}, error: (...a) => logs.push(a.map(String).join(' ')) },
        performance,
        importScripts: (...files) => { for (const f of files) vm.runInContext(source(f), scope, { filename: f }); },
        postMessage: (data) => onPost(JSON.parse(JSON.stringify(data))), // structured clone
    };
    scope.self = scope;
    vm.createContext(scope);
    vm.runInContext(source('aiWorker.js'), scope, { filename: 'aiWorker.js' });
    return scope;
}

// Browser-like Worker backed by aiWorker.js. mode: 'ok' | 'throw' (constructor throws, as on
// file://) | 'loaderror' (script fails to load -> onerror). Messages are asynchronous and
// structured-cloned (JSON round trip).
function makeWorkerClass(mode) {
    class FakeWorker {
        constructor(url) {
            if (mode === 'throw') throw new Error('SecurityError: cannot create worker from file://');
            assert.equal(url, 'aiWorker.js');
            this.terminated = false;
            this.ready = false;
            FakeWorker.instances.push(this);
            setTimeout(() => {
                if (mode === 'loaderror') {
                    if (this.onerror) this.onerror({ message: 'NetworkError: failed to load', preventDefault() {} });
                    return;
                }
                this.scope = makeWorkerScope((data) => setTimeout(() => {
                    if (!this.terminated && this.onmessage) this.onmessage({ data: JSON.parse(JSON.stringify(data)) });
                }, 0));
                this.ready = true;
            }, 0);
        }
        postMessage(msg) {
            const data = JSON.parse(JSON.stringify(msg));
            FakeWorker.posted.push(data);
            const deliver = () => {
                if (this.terminated) return;
                if (!this.ready) { if (mode !== 'loaderror') setTimeout(deliver, 1); return; }
                this.scope.onmessage({ data });
            };
            setTimeout(deliver, 1);
        }
        terminate() { this.terminated = true; FakeWorker.terminations++; }
    }
    FakeWorker.instances = [];
    FakeWorker.posted = [];
    FakeWorker.terminations = 0;
    return FakeWorker;
}

function page(mode) {
    const Worker = mode ? makeWorkerClass(mode) : undefined;
    const P = loadEngine({ client: true, globals: Worker ? { Worker } : {} });
    P.Worker = Worker;
    P.fen(MATE_IN_1);
    P.run('gameHistory = []; currentMoveIndex = -1; pushHistoryState({ truncate: false });');
    // Snapshot of another position, while the live globals stay on MATE_IN_1.
    P.snapshotOf = (fen) => {
        P.set('__fen2', fen);
        return P.run('(() => { const live = getCurrentGameStateSnapshot(); parseFen(__fen2); const s = getCurrentGameStateSnapshot(); loadGameStateSnapshot(live); return s; })()');
    };
    P.request = (state, elo, opts) => P.run('requestAIMove')(state, elo, opts);
    return P;
}

describe('requestAIMove on every transport', () => {
    for (const mode of [undefined, 'throw', 'loaderror', 'ok']) {
        const name = mode === undefined ? 'no Worker (main-thread fallback)'
            : mode === 'throw' ? 'Worker constructor throws (fallback)'
                : mode === 'loaderror' ? 'worker script fails to load (onerror fallback)' : 'working Worker';

        test(`${name}: finds moves, cancels cleanly, leaves globals untouched`, async () => {
            const P = page(mode);
            const before = P.run(GLOBALS_EXPR);

            const m1 = await P.request(P.run('getCurrentGameStateSnapshot()'), 2500, { timeMs: 500 }).promise;
            assert.equal(uci(m1), 'a1a8');

            const m2 = await P.request(P.snapshotOf(BLACK_PROMO), 2000).promise;
            assert.equal(uci(m2), 'b2b1q');
            assert.equal(m2.promotionPiece, 'Q');

            const r3 = P.request(P.run('getCurrentGameStateSnapshot()'), 2500, { timeMs: 1500 });
            const t0 = Date.now();
            r3.cancel();
            assert.equal(await r3.promise, null, 'cancel resolves null');
            assert.ok(Date.now() - t0 < 200, 'cancel resolves promptly');
            r3.cancel(); // no-op after settling

            const m4 = await P.request(P.run('getCurrentGameStateSnapshot()'), 2500, { timeMs: 200 }).promise;
            assert.equal(uci(m4), 'a1a8', 'works again after a cancel');

            const noMove = await P.request(P.snapshotOf('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), 1200).promise;
            assert.equal(noMove, null, 'stalemate -> null');

            assert.equal(P.run(GLOBALS_EXPR), before, 'live globals untouched');
            assert.deepEqual(P.logs.error, []);

            if (mode === 'ok') {
                assert.ok(P.Worker.instances.length >= 1);
                assert.ok(P.Worker.terminations >= 1, 'cancel terminates the busy worker');
                assert.equal(P.Worker.posted.length, 5, 'all requests went through the worker');
            }
            if (mode === 'throw' || mode === 'loaderror') {
                assert.ok(P.run('aiWorkerUnavailable'));
            }
            if (mode === 'loaderror') {
                assert.equal(P.Worker.instances.length, 1, 'no new worker after it failed');
            }
        });
    }
});

describe('cancel', () => {
    test('main thread: a cancelled request never runs the search and never resolves to a move', async () => {
        const P = page(undefined);
        P.run('var __calls = 0; const __orig = calculateBestMove; calculateBestMove = function (...a) { __calls++; return __orig(...a); };');
        const r = P.request(P.run('getCurrentGameStateSnapshot()'), 2500, { timeMs: 1000 });
        r.cancel();
        assert.equal(await r.promise, null);
        await sleep(100); // past AI_MAIN_THREAD_DELAY_MS
        assert.equal(P.run('__calls'), 0);
    });

    test('worker: cancelling one of two queued requests only drops that one', async () => {
        const P = page('ok');
        const a = P.request(P.run('getCurrentGameStateSnapshot()'), 2500, { timeMs: 800 });
        const b = P.request(P.snapshotOf(BLACK_PROMO), 2000, { timeMs: 200 });
        a.cancel();
        const [ma, mb] = await Promise.all([a.promise, b.promise]);
        assert.equal(ma, null);
        assert.equal(uci(mb), 'b2b1q', 're-posted to a fresh worker');
        assert.equal(P.Worker.instances.length, 2);
    });

    test('worker: a late reply for a cancelled id is ignored', async () => {
        const P = page('ok');
        const r = P.request(P.run('getCurrentGameStateSnapshot()'), 2500, { timeMs: 200 });
        const worker = P.Worker.instances[0];
        r.cancel();
        assert.equal(await r.promise, null);
        // Simulate the terminated worker's message still arriving.
        const handler = worker.onmessage;
        handler({ data: { id: 1, move: { from: { row: 7, col: 0 }, to: { row: 0, col: 0 } } } });
        assert.equal(await r.promise, null);
    });
});

describe('state snapshots', () => {
    test('getCurrentGameStateSnapshot deep-copies and lists positions up to currentMoveIndex', () => {
        const P = page(undefined);
        P.run(`ChessAI.applyMoveToGlobals({ from: { row: 7, col: 6 }, to: { row: 7, col: 7 } }); pushHistoryState({});
               ChessAI.applyMoveToGlobals({ from: { row: 0, col: 6 }, to: { row: 0, col: 7 } }); pushHistoryState({});`);
        let snap = P.run('getCurrentGameStateSnapshot()');
        assert.equal(snap.positionHistory.length, 3);
        assert.equal(snap.positionHistory[0], '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - -');
        assert.equal(snap.positionHistory[2], P.run('getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget })'));

        snap.board[7][0] = null;
        snap.castlingRights.w.K = true;
        assert.equal(P.run('board[7][0]'), 'R');
        assert.equal(P.run('castlingRights.w.K'), false);

        // While reviewing (currentMoveIndex < last), later positions are excluded.
        P.run('currentMoveIndex = 1; loadGameStateSnapshot(gameHistory[1]);');
        snap = P.run('getCurrentGameStateSnapshot()');
        assert.equal(snap.positionHistory.length, 2);
        assert.equal(snap.currentPlayer, 'b');
    });

    test('requestAIMove copies the state it is given', async () => {
        const P = page(undefined);
        const state = P.run('getCurrentGameStateSnapshot()');
        const r = P.request(state, 2500, { timeMs: 200 });
        state.board[7][0] = null; // mutate after the request: must not affect the search
        state.board[0][6] = null;
        assert.equal(uci(await r.promise), 'a1a8');
    });
});

describe('aiWorker.js message handler', () => {
    test('replies { id, move } for a request', () => {
        const posted = [];
        const scope = makeWorkerScope((d) => posted.push(d));
        const P = page(undefined);
        const state = JSON.parse(JSON.stringify(P.run('getCurrentGameStateSnapshot()')));
        scope.onmessage({ data: { id: 7, state, elo: 2500, timeMs: 300 } });
        assert.equal(posted.length, 1);
        assert.equal(posted[0].id, 7);
        assert.equal(uci(posted[0].move), 'a1a8');
    });

    test('uses positionHistory for repetition and survives a missing one', () => {
        const posted = [];
        const scope = makeWorkerScope((d) => posted.push(d));
        const repeated = '6k1/8/8/8/8/8/Q7/6K1 b - -';
        const state = {
            board: [[null, null, null, null, null, null, 'k', null], ...Array.from({ length: 6 }, () => Array(8).fill(null)), ['Q', null, null, null, null, null, 'K', null]],
            currentPlayer: 'w', castlingRights: {}, enPassantTarget: null, halfmoveClock: 10, fullmoveNumber: 40,
        };
        for (let i = 0; i < 5; i++) scope.onmessage({ data: { id: i, state: { ...state, positionHistory: [repeated, 'x', repeated, 'y'] }, elo: 2500, timeMs: 150 } });
        for (const p of posted) assert.notEqual(uci(p.move), 'a1a2', 'avoids the drawing repetition');
        scope.onmessage({ data: { id: 99, state, elo: 1200, timeMs: 50 } });
        assert.equal(posted.at(-1).id, 99);
        assert.ok(posted.at(-1).move);
    });

    test('replies with move null on a broken request instead of throwing', () => {
        const posted = [];
        const errors = [];
        const scope = makeWorkerScope((d) => posted.push(d), errors);
        scope.onmessage({ data: { id: 3, state: null, elo: 1200 } });
        assert.deepEqual(posted, [{ id: 3, move: null }]);
        assert.equal(errors.length, 1);
    });
});
