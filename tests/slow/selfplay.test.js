'use strict';
// Slow checks: engine self-play and a timing table. Run with `npm run test:slow`
// (skipped by `npm test` unless RUN_SLOW=1).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, uci } = require('../helpers/loadEngine');

const skip = process.env.RUN_SLOW ? false : 'slow: set RUN_SLOW=1 (npm run test:slow)';
const POSITION = 'getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget })';

// Plays one game; returns { winner: 'strong'|'weak'|null, reason, plies, strongMs[] }.
function playGame(E, strongElo, weakElo, strongColor, maxPlies = 300) {
    E.run('parseFen(INITIAL_BOARD_FEN)');
    const hist = [E.run(POSITION)];
    const strongMs = [];
    for (let ply = 0; ply < maxPlies; ply++) {
        const stm = E.run('currentPlayer');
        const elo = stm === strongColor ? strongElo : weakElo;
        E.set('__args', [elo, undefined, hist]);
        const t0 = Date.now();
        const move = E.get('calculateBestMove(...__args)');
        if (elo === strongElo) strongMs.push(Date.now() - t0);
        if (!move) {
            const mated = E.run('isKingInCheck(currentPlayer)');
            return { winner: mated ? (stm === strongColor ? 'weak' : 'strong') : null, reason: mated ? 'mate' : 'stalemate', plies: ply, strongMs };
        }
        E.set('__m', move);
        assert.equal(E.run('ChessAI.applyMoveToGlobals(__m)'), true, `illegal ${uci(move)}`);
        const pos = E.run(POSITION);
        hist.push(pos);
        if (hist.filter((p) => p === pos).length >= 3) return { winner: null, reason: 'repetition', plies: ply + 1, strongMs };
        if (E.run('halfmoveClock') >= 100) return { winner: null, reason: '50-move', plies: ply + 1, strongMs };
        if (E.run('hasInsufficientMaterial()')) return { winner: null, reason: 'material', plies: ply + 1, strongMs };
    }
    return { winner: null, reason: 'ply cap', plies: maxPlies, strongMs };
}

describe('self-play', { skip }, () => {
    for (const [strong, weak, games] of [[1000, 500, 4], [1600, 1000, 4], [2100, 1300, 2]]) {
        test(`ELO ${strong} beats ELO ${weak}`, (t) => {
            const E = loadEngine();
            let score = 0;
            for (let g = 0; g < games; g++) {
                const color = g % 2 === 0 ? 'w' : 'b';
                const r = playGame(E, strong, weak, color);
                score += r.winner === 'strong' ? 1 : r.winner === null ? 0.5 : 0;
                const avg = r.strongMs.length ? Math.round(r.strongMs.reduce((a, b) => a + b, 0) / r.strongMs.length) : 0;
                t.diagnostic(`game ${g + 1}: strong as ${color} -> ${r.winner || 'draw'} (${r.reason}) after ${r.plies} plies, strong avg ${avg}ms/move`);
            }
            assert.ok(score >= games * 0.75, `strong scored ${score}/${games}`);
        });
    }
});

describe('timing', { skip }, () => {
    // v5: strength is a node budget; time is only a safety cap (timeCapMs). Report both.
    test('search per ELO stays within its node budget and well under the safety time cap', (t) => {
        const E = loadEngine();
        const fens = {
            start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            italian: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
            middlegame: 'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8',
        };
        t.diagnostic('position    ELO   nodes   capMs  maxD | ms (depth, nodes) x3');
        for (const [name, fen] of Object.entries(fens)) {
            for (const elo of [600, 1200, 1800, 2100, 2400]) {
                const p = E.get(`ChessAI.eloParams(${elo})`);
                const runs = [];
                for (let i = 0; i < 3; i++) {
                    E.fen(fen);
                    const t0 = Date.now();
                    E.run(`calculateBestMove(${elo}, undefined, [])`);
                    const ms = Date.now() - t0;
                    const info = E.get('ChessAI.getLastSearchInfo()');
                    runs.push(`${ms} (d${info ? info.depth : '-'}, ${info ? info.nodes : '-'})`);
                    assert.ok(ms < p.timeCapMs, `${name} ELO ${elo}: ${ms}ms hit the ${p.timeCapMs}ms safety cap on this machine`);
                    if (info && elo >= 1300) assert.ok(info.nodes <= p.nodeBudget + 1, `${name} ELO ${elo}: ${info.nodes} nodes > ${p.nodeBudget}`);
                }
                t.diagnostic(`${name.padEnd(11)} ${String(elo).padEnd(5)} ${String(p.nodeBudget).padStart(6)} ${String(p.timeCapMs).padStart(6)}  ${String(p.maxDepth).padStart(4)} | ${runs.join(', ')}`);
            }
            // Hint: full-strength node budget, finishes inside its own safety cap on this machine
            const h = E.get('ChessAI.hintParams()');
            E.fen(fen);
            const t0 = Date.now();
            E.run('calculateBestMove(400, undefined, [], { hint: true })');
            const ms = Date.now() - t0;
            const info = E.get('ChessAI.getLastSearchInfo()');
            assert.ok(info.nodes <= h.nodeBudget + 1 && info.stoppedBy !== 'time', `${name} hint: ${info.nodes} nodes, ${info.stoppedBy}`);
            assert.ok(ms < h.timeCapMs, `${name} hint ${ms}ms >= cap ${h.timeCapMs}ms`);
            t.diagnostic(`${name.padEnd(11)} hint  ${String(h.nodeBudget).padStart(6)} ${String(h.timeCapMs).padStart(6)}       | ${ms} (d${info.depth}, ${info.nodes})`);
        }
    });
});
