// Renders library thumbnails (192 px WebP, transparent) with headless Chrome + three.js (tools/thumb.html):
//   built-in KayKit characters -> battle3d/assets/thumbs/<id>.webp
//   every pack model           -> battle3d/assets/packs/<pack>/thumbs/<model>.webp
//   node battle3d/tools/make_thumbs.mjs        (needs network for three.js from jsDelivr; CHROME=... to override)
// Debug helpers: --measure prints each pack model's facing in its idle pose; THUMB_PROBE=url,outDir,clip renders
// one model at all four facings; BONE_PROBE=url,clip prints bone world positions (used to place mount saddles).
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const ASSETS = path.join(REPO, 'battle3d', 'assets');
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find(p => fs.existsSync(p));
const PORT = 9341, SERVE = 8799;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.png': 'image/png', '.webp': 'image/webp' };

const server = http.createServer((req, res) => {
    const p = path.join(REPO, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(REPO) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
}).listen(SERVE);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b3d-thumbs-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch (e) { await sleep(200); } }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
    return r.result?.result?.value;
};

const jobs = [];
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
for (const [mid, m] of Object.entries(manifest.models || {})) {
    const army = manifest.armyAnims?.[m.army] || {};
    jobs.push({ url: `battle3d/assets/${m.file}`, out: path.join(ASSETS, 'thumbs', `${mid}.webp`), opts: { forward: '+z', anim: army.idle || 'Idle', show: m.defaultGear || [], hide: m.accessories.map(a => a.name).filter(n => !(m.defaultGear || []).includes(n)) }, clips: true });
}
for (const dir of fs.existsSync(path.join(ASSETS, 'packs')) ? fs.readdirSync(path.join(ASSETS, 'packs')) : []) {
    const pj = path.join(ASSETS, 'packs', dir, 'pack.json');
    if (!fs.existsSync(pj)) continue;
    const pack = JSON.parse(fs.readFileSync(pj, 'utf8'));
    for (const m of pack.models) jobs.push({ url: `battle3d/assets/packs/${dir}/${m.file}`, out: path.join(ASSETS, 'packs', dir, m.thumb), opts: { forward: m.forward, anim: m.anims.idle } });
}

try {
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://localhost:${SERVE}/battle3d/tools/thumb.html` });
    for (let i = 0; i < 100 && !(await evaluate('!!window.thumbReady').catch(() => false)); i++) await sleep(200);
    // KayKit characters have no embedded clips: load the shared clip file so idle poses are not T-poses.
    await evaluate(`(async () => {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
        const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder);
        window.sharedClips = [...(await l.loadAsync('../assets/anims/clips.glb')).animations, ...(await l.loadAsync('../assets/anims/clips_skeleton.glb')).animations];
        const orig = GLTFLoader.prototype.parse;
        GLTFLoader.prototype.parse = function (data, p, onLoad, onError) {
            return orig.call(this, data, p, g => { if (!g.animations.length) g.animations = window.sharedClips; onLoad(g); }, onError);
        };
        return true;
    })()`);
    if (process.env.BONE_PROBE) {
        const [url, anim] = process.env.BONE_PROBE.split(',');
        console.log(await evaluate(`(async () => { const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'); const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
            const THREE = await import('three'); const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder); const g = await l.loadAsync(${JSON.stringify(url)});
            const m = new THREE.AnimationMixer(g.scene); const c = g.animations.find(a => a.name === ${JSON.stringify(anim)}); if (c) { m.clipAction(c).play(); m.update(0.1); }
            g.scene.updateMatrixWorld(true); const out = {}; g.scene.traverse(o => { if (o.isBone) out[o.name] = o.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(2)).join(','); }); return JSON.stringify(out); })()`));
        jobs.length = 0;
    }
    if (process.env.THUMB_PROBE) {
        // debug: render one model at every facing into the given directory
        const [url, dir, anim] = process.env.THUMB_PROBE.split(',');
        for (const f of ['+z', '-z', '+x', '-x']) {
            const data = await evaluate(`renderThumb(${JSON.stringify(url)}, ${JSON.stringify({ forward: f, anim })})`);
            fs.writeFileSync(path.join(dir, `probe${f.replace('+', 'p').replace('-', 'm')}.webp`), Buffer.from(data.split(',')[1], 'base64'));
        }
        jobs.length = 0;
    }
    if (process.argv.includes('--measure')) {
        for (const j of jobs.filter(j => !j.clips)) console.log(j.url, JSON.stringify(await evaluate(`measureFacing(${JSON.stringify('/' + j.url)}, ${JSON.stringify(j.opts.anim)})`)));
        jobs.length = 0;
    }
    for (const j of jobs) {
        const data = await evaluate(`renderThumb(${JSON.stringify('/' + j.url)}, ${JSON.stringify(j.opts)})`);
        fs.mkdirSync(path.dirname(j.out), { recursive: true });
        fs.writeFileSync(j.out, Buffer.from(data.split(',')[1], 'base64'));
        console.log(path.relative(REPO, j.out), fs.statSync(j.out).size);
    }
} finally {
    ws.close(); chrome.kill(); server.close();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
}
