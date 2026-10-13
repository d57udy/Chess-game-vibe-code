'use strict';
// Structure behind two layout fixes that only a real browser can measure (tests/slow/battle3dLayoutBrowser.test.js
// does that in headless Chrome). These checks run everywhere and catch the markup or the rules being undone:
//   - notices (#tip), the coach card and the install / update toasts stand in one column (.bottom-stack),
//     so a notice can no longer sit on top of the coach card;
//   - the game review list's columns cannot grow past the panel, and the badge is never the part that is cut.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { ROOT } = require('../helpers/loadEngine');
const { page3d } = require('../helpers/pages');

const css = fs.readFileSync(path.join(ROOT, 'battle3d/hud.css'), 'utf8').replace(/\/\*[^]*?\*\//g, '');
// Declarations of every rule whose selector list contains `selector` exactly (outside or inside @media)
function rules(selector) {
    const out = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (m[1].split(',').map((s) => s.trim()).includes(selector)) out.push(m[2].replace(/\s+/g, ' ').trim());
    }
    return out;
}

describe('battle3d HUD layout: structure', () => {
    test('the notice, the coach card and the toasts share one bottom stack, the notice on top', () => {
        const doc = new JSDOM(fs.readFileSync(path.join(ROOT, page3d()), 'utf8')).window.document;
        const stack = doc.querySelector('.bottom-stack');
        assert.ok(stack, 'a .bottom-stack container');
        assert.deepEqual([...stack.children].map((e) => e.id), ['tip', 'coach-card'], 'the notice first (above), then the coach card');
        assert.ok(doc.getElementById('tip-text') && doc.getElementById('tip-close') && doc.getElementById('coach-text'), 'their parts are still there');
        assert.ok(rules('.bottom-stack').some((r) => /position: fixed/.test(r) && /flex-direction: column/.test(r)), 'the stack is the fixed column');
        for (const sel of ['.tip', '.coach-card']) {
            assert.ok(rules(sel).length > 0, sel);
            for (const r of rules(sel)) assert.doesNotMatch(r, /position: fixed|translateX/, `${sel} is placed by the stack, not by itself`);
        }
        assert.ok(rules('.bottom-stack > .b3d-toast').some((r) => /position: static/.test(r)), 'a toast inside the stack flows with it');
        const main = fs.readFileSync(path.join(ROOT, 'battle3d/main.js'), 'utf8');
        assert.match(main, /showInstallHint\?\.\(bottomStack\(\)\)/, 'main.js puts the install hint into the stack');
        assert.match(main, /showUpdateToast\?\.\(bottomStack\(\)\)/, 'main.js puts the update toast into the stack');
    });

    test('the review list cannot widen past its panel; the move text gives way before the badge', () => {
        const columns = rules('.review-moves').map((r) => (r.match(/grid-template-columns: ([^;]+)/) || [])[1]).filter(Boolean);
        assert.equal(columns.length, 2, 'desktop and phone');
        for (const c of columns) assert.match(c, /^repeat\(\d, minmax\(0, (auto|1fr)\)\)$/, `no automatic minimum: ${c}`);
        assert.ok(rules('.review-moves > li').some((r) => /min-width: 0/.test(r)));
        assert.ok(rules('.review-move').some((r) => /min-width: 0/.test(r)));
        assert.ok(rules('.review-move .mv').some((r) => /min-width: 0/.test(r) && /text-overflow: ellipsis/.test(r) && /white-space: nowrap/.test(r)), 'the move is what gets shortened');
        assert.ok(rules('.review-move .tag').some((r) => /flex: none/.test(r) && /white-space: nowrap/.test(r)), 'the badge keeps its width');
        assert.ok(rules('.review-move .no').some((r) => /flex: none/.test(r)));
        // The HUD move list has the same guard
        assert.match(rules('.move-list').map((r) => (r.match(/grid-template-columns: ([^;]+)/) || [])[1]).filter(Boolean)[0], /minmax\(0, 1fr\) minmax\(0, 1fr\)$/);
    });
});
