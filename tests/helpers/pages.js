// Locates the game pages by content, so tests survive the v3 rename (3D at index.html, 2D at 2d.html,
// battle3d.html as a redirect) as well as the older layout.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./loadEngine');

const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return ''; } };
const find = (test, candidates) => candidates.find((f) => test(read(f)));

/** File name of the 3D game page (loads battle3d/main.js). */
function page3d() {
    const f = find((h) => /src=["'][^"']*battle3d\/main\.js/.test(h), ['index.html', 'battle3d.html']);
    if (!f) throw new Error('3D page not found');
    return f;
}
/** File name of the 2D game page (loads ui.js). */
function page2d() {
    const f = find((h) => /src=["'][^"']*\bui\.js/.test(h), ['2d.html', 'index.html']);
    if (!f) throw new Error('2D page not found');
    return f;
}

module.exports = { page3d, page2d, read, ROOT };
