'use strict';
// Save / Load in a real browser at phone size (RUN_SLOW=1, needs Google Chrome): both pages in headless
// Chrome, 360 x 740 like a small Android phone. What jsdom cannot show: the shared scripts load as an ES
// module import on the 3D page and as script tags on the 2D page, the panel fits the screen (also with
// the visual viewport cut down as by the on-screen keyboard), nothing sticks out of it, the real
// clipboard works on a user gesture, and a reload brings the game back.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { haveChrome, withBrowser, sleep, CHROME } = require('../helpers/headlessChrome');

const skip = !process.env.RUN_SLOW ? 'slow: set RUN_SLOW=1 (npm run test:slow)' : (!haveChrome() && `Chrome not found at ${CHROME} (set CHROME_PATH)`);
const PHONE = { width: 360, height: 740, deviceScaleFactor: 2, mobile: true };
const KEYBOARD_OPEN = { ...PHONE, height: 400 };

// Geometry of the open panel: the card inside the viewport, every visible control inside the card
const LAYOUT = `(() => {
    const card = document.querySelector('.save-card'), r = card.getBoundingClientRect(), out = { outside: [] };
    out.card = [r.left, r.top, r.right, r.bottom].map(Math.round);
    out.viewport = [innerWidth, innerHeight];
    out.pageScrollsSideways = document.documentElement.scrollWidth > innerWidth;
    out.cardScrollsSideways = card.scrollWidth > card.clientWidth;
    out.cardScrolls = card.scrollHeight > card.clientHeight;
    for (const el of card.querySelectorAll('button, input, textarea, label, p, li')) {
        if (el.closest('[hidden]')) continue;
        const b = el.getBoundingClientRect();
        if (b.width && (b.left < r.left - 0.5 || b.right > r.right + 0.5)) out.outside.push(el.id || el.className || el.tagName);
    }
    out.minButton = Math.min(...[...card.querySelectorAll('button')].filter((b) => !b.closest('[hidden]')).map((b) => Math.round(b.getBoundingClientRect().height)));
    out.active = document.activeElement.id;
    return out;
})()`;

function assertFits(layout, what) {
    const [left, top, right, bottom] = layout.card, [width, height] = layout.viewport;
    assert.ok(left >= 0 && right <= width && top >= 0 && bottom <= height, `${what}: the panel is inside the screen ${JSON.stringify(layout)}`);
    assert.deepEqual(layout.outside, [], `${what}: nothing sticks out of the panel`);
    assert.equal(layout.pageScrollsSideways || layout.cardScrollsSideways, false, `${what}: no sideways scrolling`);
    assert.ok(layout.minButton >= 32, `${what}: buttons are tall enough to tap (${layout.minButton}px)`);
}

// Same journey on both pages; `page` holds the few things that differ
async function journey(C, origin, page) {
    await C.send('Emulation.setDeviceMetricsOverride', PHONE);
    await C.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await C.send('Page.navigate', { url: origin + page.url });
    await C.waitFor(page.ready, 120000);
    assert.equal(await C.evaluate('typeof SaveGame + " " + typeof SavePanel'), 'object object', 'the shared scripts are loaded');
    await page.play(C);
    const key = `chess.autosave.${page.view}`;
    assert.deepEqual(await C.evaluate(`JSON.parse(localStorage.getItem("${key}")).moves.slice(0, 1)`), ['e2e4'], 'autosaved');

    await C.evaluate('document.getElementById("save-open").click()');
    assert.equal(await C.evaluate('document.getElementById("save-modal").hidden'), false);
    const first = await C.evaluate(LAYOUT);
    assertFits(first, 'saved games');
    assert.equal(first.active, 'save-title');
    for (const name of ['First', 'A second save with a long name that has to wrap somewhere', 'Third']) {
        await C.evaluate(`document.getElementById("save-name").value = ${JSON.stringify(name)}; document.getElementById("save-submit").click()`);
    }
    assert.equal(await C.evaluate('document.querySelectorAll("#save-list .save-item").length'), 3);
    assertFits(await C.evaluate(LAYOUT), 'three saves');
    await C.evaluate('document.querySelector("#save-list [data-action=rename]").click()');
    assertFits(await C.evaluate(LAYOUT), 'renaming');
    await C.evaluate('document.querySelector("#save-list [data-action=rename-cancel]").click(); document.querySelector("#save-list [data-action=delete]").click()');
    assertFits(await C.evaluate(LAYOUT), 'delete question');
    await C.evaluate('document.getElementById("save-confirm-no").click(); document.getElementById("save-tab-export").click()');
    assertFits(await C.evaluate(LAYOUT), 'export');
    assert.match(await C.evaluate('document.getElementById("save-pgn").value'), new RegExp(`^\\[Event "${page.event}"\\]\\n\\[Site "http://localhost:\\d+"\\][^]*\\n\\n1\\. e4 `));
    await C.evaluate('document.getElementById("save-copy").click()');
    await C.waitFor('document.getElementById("save-status").textContent !== ""', 5000);
    assert.equal(await C.evaluate('document.getElementById("save-status").textContent'), 'Moves copied.', 'the real clipboard takes the text on a user gesture');

    // On-screen keyboard: the visual viewport shrinks; the panel shrinks with it and scrolls inside
    await C.evaluate('document.getElementById("save-tab-import").click()');
    assertFits(await C.evaluate(LAYOUT), 'import');
    await C.send('Emulation.setDeviceMetricsOverride', KEYBOARD_OPEN);
    await C.evaluate('document.getElementById("save-import-text").focus(); document.getElementById("save-import-text").value = "1. e4 e5 2. Ke3"; document.getElementById("save-import-play").click()');
    // The panel follows the visual viewport on its resize event, which a busy 3D page delivers a little later
    await C.waitFor('document.querySelector(".save-card").getBoundingClientRect().bottom <= innerHeight', 5000);
    const typing = await C.evaluate(LAYOUT);
    assertFits(typing, 'import with the keyboard open');
    assert.equal(typing.cardScrolls, true, 'the panel scrolls inside when it is taller than the free part of the screen');
    assert.equal(await C.evaluate('document.getElementById("save-import-error").textContent'), 'Move 2 for White ("Ke3") is not a legal move in that position. Nothing was loaded.');
    const error = await C.evaluate('(() => { const b = document.getElementById("save-import-error").getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom), innerHeight]; })()');
    assert.ok(error[0] >= 0 && error[1] <= error[2], `the message is on screen above the keyboard ${error}`);
    await C.evaluate('document.getElementById("save-tab-saves").click(); document.getElementById("save-name").focus()');
    assertFits(await C.evaluate(LAYOUT), 'saved games with the keyboard open');
    await C.send('Emulation.setDeviceMetricsOverride', PHONE);

    // Import, then reload: the imported game is the current game and comes back
    await C.evaluate('document.getElementById("save-tab-import").click(); document.getElementById("save-import-text").value = "1. d4 d5 2. c4 e6 3. Nc3 Nf6"; document.getElementById("save-import-play").click()');
    await C.evaluate('document.getElementById("save-confirm").hidden || document.getElementById("save-confirm-yes").click()');
    await C.waitFor('document.getElementById("save-modal").hidden', 5000);
    const fen = await C.evaluate('battle3dFen()');
    assert.equal(fen, 'rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 2 4');
    await C.send('Page.reload');
    await C.waitFor(page.ready, 120000);
    await sleep(300);
    assert.equal(await C.evaluate('battle3dFen()'), fen, 'the game is back after a reload');
    assert.equal(await C.evaluate(page.shownMoves), 6, 'with its move list');
    assert.deepEqual(C.problems(), [], 'no exceptions or console errors');
}

// withBrowser() serves the repo, starts Chrome, stops the test at its time limit and always cleans up
test('3D page in headless Chrome at phone size: save, export, import, reload', { skip, timeout: 330000 }, () => withBrowser(({ C, S }) => journey(C, S.origin, {
    view: '3d', url: '?debug=1', event: 'Chess Battle 3D',
    ready: '!!window.__b3d && document.getElementById("loading").hidden',
    shownMoves: 'document.querySelectorAll("#move-list .mv").length',
    async play() {
        await C.evaluate('localStorage.setItem("battle3d.tipSeen", "1"); document.getElementById("mode-select").value = "human-human"; document.getElementById("mode-select").dispatchEvent(new Event("change")); document.getElementById("speed-fast").click()');
        await C.evaluate('__b3d.controller.clickSquare(6, 4); __b3d.controller.clickSquare(4, 4)');
        await C.waitFor('__b3d.state().history.length === 1 && !__b3d.state().busy', 60000);
    },
}), { timeoutMs: 300000 }));

test('2D page in headless Chrome at phone size: save, export, import, reload', { skip, timeout: 150000 }, () => withBrowser(({ C, S }) => journey(C, S.origin, {
    view: '2d', url: '2d.html?nosw=1', event: 'Chess \\(2D\\)',
    ready: 'typeof SaveHost !== "undefined"',
    shownMoves: 'document.querySelectorAll("#move-history .move-text").length',
    async play() {
        await C.evaluate('document.getElementById("game-mode-select").value = "human-human"; document.getElementById("game-mode-select").dispatchEvent(new Event("change"))');
        await C.evaluate('document.querySelector(\'#chess-board .square[data-row="6"][data-col="4"]\').click(); document.querySelector(\'#chess-board .square[data-row="4"][data-col="4"]\').click()');
        await C.waitFor('!isAnimating && gameHistory.length === 2', 10000);
        await sleep(100);
    },
}), { timeoutMs: 120000 }));
