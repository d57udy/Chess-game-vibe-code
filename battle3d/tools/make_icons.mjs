// Generates the PWA icons (icons/*.png + icons/favicon.svg) from one SVG crest: a crowned knight on a shield
// split into the hero (blue) and skeleton (ember) team colours, in the HUD palette.
// Rendering uses headless Chrome so the output matches what browsers draw:
//   node battle3d/tools/make_icons.mjs            (CHROME=/path/to/chrome to override the binary)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', '..', 'icons');
const CHROME = process.env.CHROME || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(p => fs.existsSync(p));

const C = {
    bg0: '#2a2433', bg1: '#0d0c12', gold: '#e8c478', goldDark: '#9c7a34', goldLight: '#f8e3a8',
    ivory: '#f4eee0', ink: '#16141d', blue: '#2f6fd6', blueDark: '#1d3f80', ember: '#e8792b', emberDark: '#8a3a12'
};

// Knight piece facing left, drawn in a 200 x 200 box (base at the bottom).
const KNIGHT = `
  <path d="M58 168 C60 148 76 134 86 122 C70 121 54 124 43 118 C31 112 25 100 30 89 C36 77 52 64 66 54
           L69 33 L82 47 L94 29 C99 38 101 44 101 50 C131 58 153 84 155 120 C157 142 152 158 148 168 Z"
        fill="${C.ivory}" stroke="${C.ink}" stroke-width="7" stroke-linejoin="round"/>
  <path d="M108 64 C126 76 138 96 140 122 M118 58 C138 72 150 96 150 124" fill="none" stroke="${C.goldDark}" stroke-width="5" stroke-linecap="round" opacity="0.8"/>
  <circle cx="68" cy="78" r="7" fill="${C.ink}"/>
  <circle cx="37" cy="98" r="3.5" fill="${C.ink}"/>
  <rect x="46" y="160" width="112" height="14" rx="5" fill="${C.gold}" stroke="${C.ink}" stroke-width="6"/>
  <rect x="36" y="172" width="132" height="22" rx="7" fill="${C.ivory}" stroke="${C.ink}" stroke-width="7"/>`;

const CROWN = `
  <path d="M8 46 L4 10 L26 28 L40 2 L54 28 L76 10 L72 46 Z" fill="${C.gold}" stroke="${C.ink}" stroke-width="5" stroke-linejoin="round"/>
  <rect x="6" y="42" width="68" height="12" rx="4" fill="${C.goldLight}" stroke="${C.ink}" stroke-width="5"/>
  <circle cx="40" cy="30" r="5" fill="#d8203a"/>`;

// Shield 300 wide, 360 tall, split down the middle.
const SHIELD_PATH = 'M0 0 H300 V170 C300 270 220 330 150 360 C80 330 0 270 0 170 Z';
const SHIELD = `
  <defs>
    <clipPath id="sh"><path d="${SHIELD_PATH}"/></clipPath>
    <linearGradient id="lb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.blueDark}"/></linearGradient>
    <linearGradient id="rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.ember}"/><stop offset="1" stop-color="${C.emberDark}"/></linearGradient>
  </defs>
  <g clip-path="url(#sh)">
    <rect x="0" y="0" width="150" height="360" fill="url(#lb)"/>
    <rect x="150" y="0" width="150" height="360" fill="url(#rb)"/>
    <path d="M0 0 H300 V40 H0 Z" fill="#000" opacity="0.12"/>
  </g>
  <path d="${SHIELD_PATH}" fill="none" stroke="${C.gold}" stroke-width="16" stroke-linejoin="round"/>
  <path d="${SHIELD_PATH}" fill="none" stroke="${C.ink}" stroke-width="4" stroke-linejoin="round" transform="translate(9 9) scale(0.94)" opacity="0.5"/>`;

// The crest in a 512 box: shield, knight, crown. `k` scales it around the centre (maskable safe zone).
function crest(k = 1) {
    return `<g transform="translate(256 256) scale(${k}) translate(-256 -256)">
      <g transform="translate(106 104)">${SHIELD}</g>
      <g transform="translate(128 152) scale(1.25)">${KNIGHT}</g>
      <g transform="translate(190 150) rotate(-12 40 30) scale(1.05)">${CROWN}</g>
    </g>`;
}

function svg({ maskable = false, opaque = false } = {}) {
    const bg = `<defs><radialGradient id="bg" cx="0.5" cy="0.42" r="0.7">
        <stop offset="0" stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/></radialGradient></defs>`;
    const plate = maskable || opaque
        ? `<rect width="512" height="512" fill="url(#bg)"/>`
        : `<rect x="16" y="16" width="480" height="480" rx="104" fill="url(#bg)"/>
           <rect x="16" y="16" width="480" height="480" rx="104" fill="none" stroke="${C.gold}" stroke-opacity="0.35" stroke-width="6"/>`;
    // Maskable: everything important inside the central 80% circle (radius 205 of 256).
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${bg}${plate}${crest(maskable ? 0.74 : 0.92)}</svg>`;
}

const TARGETS = [
    { file: 'icon-192.png', size: 192, opts: {} },
    { file: 'icon-512.png', size: 512, opts: {} },
    { file: 'icon-maskable-192.png', size: 192, opts: { maskable: true } },
    { file: 'icon-maskable-512.png', size: 512, opts: { maskable: true } },
    { file: 'apple-touch-icon.png', size: 180, opts: { opaque: true } },
    { file: 'favicon-32.png', size: 32, opts: {} },
];

function render(svgText, size, out, tmp) {
    const html = path.join(tmp, 'icon.html');
    fs.writeFileSync(html, `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}
        svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svgText}</body></html>`);
    execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        '--default-background-color=00000000', `--window-size=${size},${size}`, `--screenshot=${out}`, `file://${html}`],
        { stdio: 'ignore' });
}

if (!CHROME) { console.error('Chrome not found; set CHROME=/path/to/chrome'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b3d-icons-'));
for (const t of TARGETS) {
    render(svg(t.opts), t.size, path.join(OUT, t.file), tmp);
    console.log(`${t.file} ${fs.statSync(path.join(OUT, t.file)).size} bytes`);
}
fs.writeFileSync(path.join(OUT, 'favicon.svg'), svg());
fs.writeFileSync(path.join(OUT, 'icon.svg'), svg());
fs.rmSync(tmp, { recursive: true, force: true });
