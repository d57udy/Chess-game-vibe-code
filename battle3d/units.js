// Character units for the 3D battle prototype: loading, animation, movement and fights.
// See battle3d/CONTRACT.md for the API. Every sequence runs as a generator stepped from the
// scene updater, so sceneAPI.stepFrames() alone drives all motion (no timers, no rAF).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { createFights } from './fights.js';

const DEV_MANIFEST = new URL('./manifest.dev.json', import.meta.url).href;
const DEBUG = typeof location !== 'undefined' && /[?&]debug=1/.test(location.search);
const log = (...a) => { if (DEBUG) console.log('[units]', ...a); };

// When no model, clip or prop file has made any progress for this long, the pending downloads fail like missing files
// (placeholder or default model), so a network that never answers cannot hold the loading screen. Local blob: files
// have no limit.
const LOAD_STALL_MS = 30000;

const FADE = 0.2;
const TARGET_HEIGHT = 0.85;
const MODEL_Y = 0.04;           // feet stand on the base disc
const APPROACH = 0.6;           // melee standoff from the victim
const BOARD_EDGE = 4.0;         // playing surface half-size; dead bodies stay inside it
const GROUND_REST = 0.12;       // safety net: lowest torso bone of a non-KayKit body lying on the board
const FAST = 2;                 // fast mode speed multiplier
const WALK_SPEED = 1.6;         // squares per second in full mode
const GLYPHS = {
    w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
    b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' }
};
const TEAM = {
    w: { disc: 0xefe6d2, rim: 0x2f6fd6, bolt: 0x8fd0ff, boltBurst: 0xffd36a, label: '#f4eee0', ink: '#1d3f80', yaw: Math.PI },
    b: { disc: 0x2b2d31, rim: 0xe8792b, bolt: 0x8cff6a, boltBurst: 0xb06bff, label: '#26282c', ink: '#f08a3c', yaw: 0 }
};
const DEFAULT_NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
const DEFAULT_ATTACKS = {
    p: ['1H_Melee_Attack_Stab', '1H_Melee_Attack_Chop'],
    n: ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal'],
    b: ['Spellcast_Shoot'],
    r: ['2H_Melee_Attack_Chop', '2H_Melee_Attack_Slice'],
    q: ['Dualwield_Melee_Attack_Slice', '1H_Melee_Attack_Slice_Horizontal'],
    k: ['1H_Melee_Attack_Chop']
};

const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = k => k * k * (3 - 2 * k);
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const yawBetween = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
const flatDist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
// GLTFLoader sanitizes node names (PropertyBinding drops . : / [ ]), so "handslot.r" becomes "handslotr".
const byName = (root, n) => root.getObjectByName(n) || root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n));

// ---------------------------------------------------------------------------------------------
// Generator runner. A task yields: a number (seconds of updater time), a function (polled each
// frame until it returns true), a generator or an array of generators (run in parallel, joined),
// or null (one frame).

// Overshoot past a wait (a frame rarely ends exactly on time) is carried as `debt` into the next
// wait, tween or child task, so total durations do not grow with lower frame rates.
class Runner {
    constructor() { this.tasks = []; this.dt = 1 / 60; this.time = 0; this.cur = null; }

    spawn(gen, onDone, parent = null, debt = 0) {
        const t = { gen, wait: 0, cond: null, children: null, done: false, onDone, parent, debt };
        this.tasks.push(t);
        this.advance(t);
        return t;
    }

    update(dt) {
        this.dt = dt;
        this.time += dt;
        for (const t of this.tasks.slice()) if (!t.done) this.tick(t, dt);
        this.tasks = this.tasks.filter(t => !t.done);
    }

    tick(t, dt) {
        if (t.wait > 0) {
            t.wait -= dt;
            if (t.wait > 0) return;
            t.debt = -t.wait;
        }
        if (t.cond) {
            this.cur = t;
            const ok = t.cond();
            this.cur = null;
            if (!ok) return;
        }
        if (t.children && t.children.some(c => !c.done)) return;
        this.advance(t);
    }

    // Current task's carried time; tweens and clip waits take and give it back.
    takeDebt() { const t = this.cur; if (!t) return 0; const d = t.debt; t.debt = 0; return d; }
    addDebt(x) { if (this.cur) this.cur.debt = Math.max(0, Math.min(x, this.dt)); }

    advance(t) {
        t.wait = 0; t.cond = null; t.children = null;
        const prev = this.cur;
        try {
            for (let guard = 0; guard < 10000; guard++) {
                let r;
                this.cur = t;
                try { r = t.gen.next(); } catch (e) { console.error('[units] sequence error', e); r = { done: true }; }
                if (r.done) return this.finish(t);
                const v = r.value;
                if (typeof v === 'number') {
                    const w = v - t.debt;
                    if (w > 0) { t.wait = w; t.debt = 0; return; }
                    t.debt = -w;
                    continue;
                }
                if (typeof v === 'function') { t.cond = v; return; }
                const gens = Array.isArray(v) ? v.filter(Boolean) : (v && typeof v.next === 'function' ? [v] : null);
                if (gens) {
                    const debt = t.debt;
                    t.debt = 0;
                    const kids = gens.map(g => this.spawn(g, null, t, debt));
                    this.cur = t;
                    if (kids.some(c => !c.done)) { t.children = kids; return; }
                    t.debt = Math.max(0, ...kids.map(c => c.debt));
                    continue;
                }
                t.debt = 0;
                t.wait = 1e-9;  // null: next frame
                return;
            }
            this.finish(t);
        } finally {
            this.cur = prev;
        }
    }

    finish(t) {
        if (t.done) return;
        t.done = true;
        if (t.onDone) t.onDone();
        // The last child to finish resumes its parent in the same frame (no extra frame per join).
        const p = t.parent;
        if (p && !p.done && p.children && p.children.every(c => c.done)) {
            p.debt = t.debt;
            p.children = null;
            if (!p.wait && !p.cond) this.advance(p);
        }
    }

    // Stops one task (and its children) without touching the others; onDone still runs.
    cancel(t) {
        if (!t || t.done) return;
        t.parent = null;
        for (const c of t.children || []) { c.parent = null; this.cancel(c); }
        try { t.gen.return(); } catch (e) { /* ignore */ }
        this.finish(t);
        this.tasks = this.tasks.filter(x => x !== t);
    }

    abortAll() {
        const all = this.tasks;
        this.tasks = [];
        for (const t of all) {
            t.parent = null;
            try { t.gen.return(); } catch (e) { /* ignore */ }
            this.finish(t);
        }
    }

    get busy() { return this.tasks.length > 0; }
}

// ---------------------------------------------------------------------------------------------

export async function createUnits(sceneAPI, manifestUrl = DEV_MANIFEST, { audio = null } = {}) {
    const S = sceneAPI;
    const R = new Runner();
    const H = new Runner();   // hint gestures: separate so isBusy() stays false while a hint plays
    const G = new Runner();   // king gestures (talk, taunt...): same idea, independent of hints
    // Any file the loader fetches (a model's bytes, a .gltf's buffers and textures) counts as progress for every load:
    // a load fails only when nothing at all has moved for LOAD_STALL_MS. The item counts still reach the default
    // manager, which drives main.js's progress bar.
    let lastProgress = Date.now();
    const moved = () => { lastProgress = Date.now(); };
    const manager = new THREE.LoadingManager();
    const shared = THREE.DefaultLoadingManager;
    manager.itemStart = url => { moved(); shared.itemStart(url); };
    manager.itemEnd = url => { moved(); shared.itemEnd(url); };
    manager.itemError = url => { moved(); shared.itemError(url); };
    manager.resolveURL = url => shared.resolveURL(url);
    const loader = new GLTFLoader(manager);
    loader.setMeshoptDecoder(MeshoptDecoder);
    const loadGltf = url => (/^(blob|data):/.test(url) ? loader.loadAsync(url) : new Promise((done, fail) => {
        let timer = null;
        const check = () => {
            const idle = Date.now() - lastProgress;
            if (idle >= LOAD_STALL_MS) fail(new Error(`nothing loaded for ${LOAD_STALL_MS / 1000} s: ${url}`));
            else timer = setTimeout(check, LOAD_STALL_MS - idle);
        };
        moved();
        timer = setTimeout(check, LOAD_STALL_MS);
        loader.load(url, g => { clearTimeout(timer); done(g); }, moved, e => { clearTimeout(timer); fail(e); });
    }));

    const { manifest, base } = await loadManifest(manifestUrl);
    const resolve = p => new URL(p, base).href;

    // unit-visuals.js (cast agent) decorates units; fall back to the built-in disc, label and crown.
    let visuals = null;
    try { visuals = await import('./unit-visuals.js'); } catch (e) { log('unit-visuals.js not available, using built-in decorations'); }
    const decorateUnit = typeof visuals?.decorateUnit === 'function' ? visuals.decorateUnit : null;

    // --- load assets --------------------------------------------------------------------------
    const clips = new Map();
    const protos = new Map();     // model path -> { scene, height, skinTop, headY }
    const propProtos = new Map(); // prop path -> Object3D
    const addClips = list => { for (const c of list || []) if (!clips.has(c.name)) clips.set(c.name, c); };

    const clipFiles = [manifest.clips?.file, manifest.clips?.skeletonFile].filter(Boolean);
    const clipResults = await Promise.allSettled(clipFiles.map(f => loadGltf(resolve(f))));
    clipResults.forEach((r, i) => r.status === 'fulfilled' ? addClips(r.value.animations) : log('clip file failed', clipFiles[i], r.reason));

    // Loads every model and prop referenced by a roles table that is not loaded yet.
    async function loadAssets(roleTable) {
        const roles = [];
        for (const color of ['w', 'b']) for (const type of 'pnbrqk') roles.push(roleTable?.[color]?.[type] || {});
        const modelPaths = [...new Set(roles.flatMap(r => [r.model, r.mount?.model]).filter(p => p && !protos.has(p)))];
        // Mounts (horses) are native models: they play their own embedded clips.
        // VRM: by extension, or by the cast flag for imported blob: URLs (role.vrm).
        const vrmPaths = new Set(roles.filter(r => r.vrm || r.rig === 'vrm').map(r => r.model));
        const nativePaths = new Set([...roles.filter(r => r.native).map(r => r.model), ...roles.map(r => r.mount?.model).filter(Boolean)]);
        const propPaths = [...new Set(roles.flatMap(r => (r.props || []).map(p => p.file)).filter(p => p && !propProtos.has(p)))];
        await Promise.all([
            ...modelPaths.map(async p => {
                try {
                    const g = vrmPaths.has(p) || /\.vrm(\?|#|$)/i.test(p) ? await loadVrm(resolve(p)) : await loadGltf(resolve(p));
                    protos.set(p, await protoFromGltf(g, p, nativePaths.has(p)));
                } catch (e) { console.warn('[units] model failed, using placeholder:', p, e); }
            }),
            ...propPaths.map(async p => {
                try {
                    const g = await loadGltf(resolve(p));
                    g.scene.traverse(o => { if (o.isMesh) o.castShadow = true; });
                    propProtos.set(p, g.scene);
                } catch (e) { console.warn('[units] prop failed:', p, e); }
            })
        ]);
    }
    // KayKit rigs take the fast path (shared clips bind by bone name). Other humanoids go through
    // retarget.js (b3d-retarget) when present; anything it cannot map becomes a static model.
    const isKayKitRig = scene => !!(byName(scene, 'hips') && byName(scene, 'handslot.r'));
    let retargetMod;
    async function getRetarget() {
        if (retargetMod === undefined) {
            try { retargetMod = await import('./retarget.js'); } catch (e) { retargetMod = null; log('retarget.js not available'); }
        }
        return retargetMod;
    }
    async function loadVrm(url) {
        const m = await import('./vrm.js');
        return m.loadVRM(url, { THREE, GLTFLoader, meshoptDecoder: MeshoptDecoder });
    }
    async function protoFromGltf(g, path, native = false) {
        // Native pack models (b3d-assets) play only their own embedded clips (unique names).
        if (native) {
            addClips(g.animations);
            const proto = prepareProto(g.scene);
            proto.native = true;
            proto.clipNames = new Set(g.animations.map(a => a.name));
            return proto;
        }
        if (isKayKitRig(g.scene)) {
            addClips(g.animations);
            return prepareProto(g.scene);
        }
        const rt = await getRetarget();
        if (rt?.prepare) {
            try {
                const prep = await rt.prepare(g, THREE, { sourceClips: clips });
                if (prep && !prep.static && prep.ok !== false && prep.root) {
                    for (const w of prep.warnings || []) log('retarget', path, w);
                    const proto = prepareProto(prep.root);
                    proto.retarget = prep;
                    proto.clipCache = new Map();
                    return proto;
                }
                console.warn('[units] cannot retarget', path, prep?.warnings || '');
            } catch (e) { console.warn('[units] retarget failed for', path, e); }
        }
        const proto = prepareProto(g.scene);
        proto.static = true;
        return proto;
    }

    await loadAssets(manifest.roles);
    log('loaded', protos.size, 'models,', clips.size, 'clips,', propProtos.size, 'props');

    // Measurement rig: one clone used to sample clips for locomotion speed and impact times.
    const rigProto = protos.values().next().value;
    const rig = rigProto ? makeRig(rigProto.scene) : null;
    const statsCache = new Map();

    // --- shared render resources ----------------------------------------------------------------
    const discGeo = new THREE.CylinderGeometry(0.28, 0.31, 0.04, 28);
    const rimGeo = new THREE.TorusGeometry(0.295, 0.02, 6, 36);
    const coarse = !!S.isCoarsePointer?.();
    const proxyGeo = new THREE.CylinderGeometry(coarse ? 0.4 : 0.3, coarse ? 0.4 : 0.3, coarse ? 1.0 : 0.9, 10);
    const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
    const teamMats = {};
    for (const c of ['w', 'b']) {
        teamMats[c] = {
            disc: new THREE.MeshStandardMaterial({ color: TEAM[c].disc, roughness: c === 'w' ? 0.55 : 0.4, metalness: c === 'w' ? 0.05 : 0.6 }),
            rim: new THREE.MeshStandardMaterial({ color: TEAM[c].rim, emissive: TEAM[c].rim, emissiveIntensity: 0.35, roughness: 0.4 })
        };
    }
    const labelMats = new Map();
    const crownTemplate = makeCrown();

    // --- state ------------------------------------------------------------------------------------
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    const units = new Set();         // every live unit (grid + dying)
    const finalizers = [];           // closures that force the logical end state of running moves
    let mode = 'full';
    let labelsOn = true;
    let fightCamera = true;
    let ffwd = false;
    let focused = false;
    let fidgeting = 0;
    let fightToken = false;
    let idleToken = false;
    const trails = new Set();

    S.addUpdater(dt => update(dt));

    // ===========================================================================================
    // Loading helpers

    async function loadManifest(url) {
        for (const u of [url, DEV_MANIFEST]) {
            if (!u) continue;
            try {
                const abs = new URL(u, location.href).href;
                const res = await fetch(abs, typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(LOAD_STALL_MS) } : {});
                if (res.ok) return { manifest: await res.json(), base: abs };
            } catch (e) { /* try next */ }
        }
        console.warn('[units] no manifest found, using placeholders');
        return { manifest: { roles: {} }, base: location.href };
    }

    function prepareProto(scene) {
        scene.updateMatrixWorld(true);
        const box = new THREE.Box3();
        scene.traverse(o => {
            if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
            if (o.isSkinnedMesh) box.union(new THREE.Box3().setFromObject(o));
        });
        if (box.isEmpty()) box.setFromObject(scene);
        const head = byName(scene, 'head');
        const headY = head ? head.getWorldPosition(new THREE.Vector3()).y : box.max.y - 0.6;
        return { scene, height: Math.max(0.1, box.max.y - Math.min(0, box.min.y)), skinTop: box.max.y, headY };
    }

    function makeRig(scene) {
        const model = SkeletonUtils.clone(scene);
        const get = n => byName(model, n);
        return {
            model, mixer: new THREE.AnimationMixer(model),
            footL: get('foot.l'), footR: get('foot.r'), handR: get('handslot.r'), handL: get('handslot.l')
        };
    }

    // Natural ground speed (model units / s at playback 1) and impact time for a clip.
    function clipStats(name) {
        if (statsCache.has(name)) return statsCache.get(name);
        const clip = clips.get(name);
        const st = { speed: 0, impact: null, duration: clip ? clip.duration : 0, contacts: [0, 0.5] };
        if (clip && rig && rig.footL && rig.handR) {
            const { model, mixer } = rig;
            mixer.stopAllAction();
            const a = mixer.clipAction(clip);
            a.reset(); a.setLoop(THREE.LoopRepeat, Infinity); a.play();
            const N = 48, dur = clip.duration, pts = [];
            for (let i = 0; i < N; i++) {
                const t = dur * i / N;
                mixer.setTime(t);
                model.updateMatrixWorld(true);
                pts.push({
                    t,
                    fl: rig.footL.getWorldPosition(new THREE.Vector3()), fr: rig.footR.getWorldPosition(new THREE.Vector3()),
                    hr: rig.handR.getWorldPosition(new THREE.Vector3()), hl: rig.handL.getWorldPosition(new THREE.Vector3())
                });
            }
            a.stop();
            const range = k => { const zs = pts.map(p => p[k].z); return Math.max(...zs) - Math.min(...zs); };
            // Foot contacts: the phase where each foot is lowest (one per foot per cycle).
            const lowest = k => pts.reduce((b, p) => (p[k].y < b.y ? { y: p[k].y, t: p.t } : b), { y: Infinity, t: 0 }).t / dur;
            st.contacts = [lowest('fl'), lowest('fr')];
            st.speed = (range('fl') + range('fr')) / 2 * 2 / dur;
            let best = 0;
            for (let i = 1; i < N; i++) {
                const p = pts[i], q = pts[i - 1];
                if (p.t < dur * 0.12 || p.t > dur * 0.85) continue;
                const v = Math.max(p.hr.distanceTo(q.hr), p.hl.distanceTo(q.hl));
                if (v > best) { best = v; st.impact = (p.t + q.t) / 2 + 0.02; }
            }
        }
        if (st.impact == null) st.impact = st.duration * 0.45;
        statsCache.set(name, st);
        return st;
    }

    // ===========================================================================================
    // Unit construction

    function roleFor(color, type) { return manifest.roles?.[color]?.[type] || {}; }

    // Per-role clip choice: roles[c][t].anims[key], then roles[c][t][key], then the fallback list.
    function anim(u, key, fallback) {
        const v = u.role.anims?.[key] ?? u.role[key];
        return v ? [].concat(v, fallback || []) : fallback;
    }

    function createUnit(color, type, square) {
        const role = roleFor(color, type);
        const proto = role.model ? protos.get(role.model) : null;
        const root = new THREE.Group();
        root.name = `unit-${color}${type}`;
        const u = {
            color, type, role, root, square: { ...square },
            isSkeleton: role.skeleton ?? /skeleton/i.test(role.model || ''),
            mixer: null, current: null, bones: {}, scale: 1, labelY: 1.0,
            fidget: null, look: null, headPre: new THREE.Quaternion(), dead: false, dying: false,
            nextFidget: R.time + rand(6, 20)
        };

        let model;
        if (proto) {
            model = SkeletonUtils.clone(proto.scene);
            u.model = model;
            u.proto = proto;
            const get = n => boneOf(u, n);
            u.bones = { head: get('head'), hips: get('hips'), handR: get('handslot.r'), handL: get('handslot.l'), chest: get('chest'), legR: get('upperleg.r') };
            if (u.bones.legR) u.legRest = u.bones.legR.position.clone();
            applyVisibility(model, role, u.bones);
            attachProps(u, role);
            u.scale = role.scale ?? (TARGET_HEIGHT / proto.height) * (role.heightScale ?? 1);
            if (role.crown && u.bones.head && !decorateUnit) addCrown(u, model, proto, role);
            // Static custom models (non-KayKit rigs) keep their pose: no mixer, no clips.
            if (!role.static && !proto.static) {
                // retarget.js: mixerTarget === root, so the clone itself is the mixer root.
                u.mixer = new THREE.AnimationMixer(model);
            }
            u.labelY = Math.max(0.9, (proto.skinTop * u.scale) + MODEL_Y + 0.2 + (role.crown ? 0.12 : 0));
        } else {
            model = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.4, 4, 10),
                new THREE.MeshStandardMaterial({ color: color === 'w' ? 0xdcd2bc : 0x3a3d44, roughness: 0.6 }));
            model.position.y = 0.38;
            model.castShadow = true;
            u.labelY = 1.0;
        }
        model.scale.multiplyScalar(u.scale);
        model.position.y += MODEL_Y;
        // Retargeted roots already face +z (retarget.js fixes facing inside its wrapper).
        model.rotation.y = proto?.retarget ? 0 : { '+z': 0, '-z': Math.PI, '+x': -Math.PI / 2, '-x': Math.PI / 2 }[role.forward || '+z'] ?? 0;
        u.model = model;
        u.modelPos0 = model.position.clone();
        root.add(model);
        if (role.mount && proto) mountUnit(u, role.mount);

        u.proxy = new THREE.Mesh(proxyGeo, proxyMat);
        u.proxy.position.y = coarse ? 0.5 : 0.45;
        u.proxy.userData.unit = u;
        root.add(u.proxy);
        // Third argument: the figure itself (model with its gear, or the mount carrying it), so the scene can tell a
        // click on it from one that only meets the larger proxy. Base, aura, rings and label are not the figure.
        if (S.registerPickProxy) S.registerPickProxy(u.proxy, () => (gridHas(u) ? { row: u.square.row, col: u.square.col } : null), u.horse ? u.horse.model : model);

        decorate(u);
        placeAt(u, square);
        S.scene.add(root);
        units.add(u);
        idle(u, 0);
        return u;
    }

    // Base disc, label and accessories: unit-visuals.js when present, else the built-in set.
    function decorate(u) {
        if (decorateUnit) {
            try {
                u.deco = decorateUnit(u, { THREE, color: u.color, type: u.type, role: u.role, labels: labelsOn });
            } catch (e) { console.warn('[units] decorateUnit failed, using built-in decorations', e); }
        }
        if (!u.deco) u.deco = builtinDecorations(u);
        if (Number.isFinite(u.deco.labelY)) u.labelY = u.deco.labelY;   // measured from model + gear by unit-visuals
        u.base = u.deco.base || u.base || [];
        if (!u.base.length) u.root.traverse(o => { if (o.userData.b3dBase) u.base.push(o); });
    }

    function builtinDecorations(u) {
        const disc = new THREE.Mesh(discGeo, teamMats[u.color].disc);
        disc.position.y = 0.02;
        disc.receiveShadow = true;
        const rim = new THREE.Mesh(rimGeo, teamMats[u.color].rim);
        rim.rotation.x = Math.PI / 2;
        rim.position.y = 0.04;
        disc.userData.b3dBase = rim.userData.b3dBase = true;
        const label = new THREE.Sprite(labelMaterial(u.color, u.type));
        label.scale.set(0.3, 0.3, 1);
        label.position.y = u.labelY;
        label.renderOrder = 5;   // under the board's target markers (scene.js, order 6): a label must not hide the dot behind it
        label.visible = labelsOn;
        u.root.add(disc, rim, label);
        u.label = label;
        let wantLabel = labelsOn, selected = false;
        return {
            setLabel(on) { wantLabel = !!on; label.visible = wantLabel && !selected; },
            setSelected(on) { selected = !!on; label.visible = wantLabel && !selected; }, // as unit-visuals.js does
            setThreatened() {},
            dispose() {}
        };
    }

    function setLabel(u, on) {
        try { u.deco?.setLabel(!!on); } catch (e) { /* ignore */ }
    }

    function applyVisibility(model, role, bones) {
        const show = role.show ? new Set(role.show) : null;
        if (show) {
            for (const slot of [bones.handR, bones.handL]) {
                if (!slot) continue;
                slot.traverse(o => { if (o.isMesh && !show.has(o.name)) o.visible = false; });
            }
            for (const n of show) { const o = byName(model, n); if (o) o.visible = true; }
        }
        for (const n of role.hide || []) { const o = byName(model, n); if (o) o.visible = false; }
    }

    function attachProps(u, role) {
        for (const p of role.props || []) {
            const proto = propProtos.get(p.file);
            const bone = byName(u.model, p.bone) || (/\.?l$/.test(p.bone) ? u.bones.handL : u.bones.handR);
            if (!proto || !bone) continue;
            const obj = proto.clone(true);
            const isShield = /shield/i.test(p.file);
            const pos = p.position || (isShield ? [0, 0.017, 0.156] : [0, 0.033, 0]);
            const rot = p.rotation || (isShield ? [0, 0, 0] : [0, Math.PI, 0]);
            obj.position.fromArray(pos);
            if (p.quaternion) obj.quaternion.fromArray(p.quaternion);
            else obj.rotation.set(rot[0], rot[1], rot[2]);
            if (p.scale) obj.scale.setScalar(p.scale);
            bone.add(obj);
        }
    }

    function addCrown(u, model, proto, role) {
        model.updateMatrixWorld(true);
        let top = proto.skinTop;
        u.bones.head.traverse(o => {
            if (o.isMesh && !o.isSkinnedMesh && o.visible) top = Math.max(top, new THREE.Box3().setFromObject(o).max.y);
        });
        const crown = crownTemplate.clone();
        crown.position.y = role.crownY ?? (top - proto.headY - 0.08);
        u.bones.head.add(crown);
        u.crown = crown;
    }

    function makeCrown() {
        const gold = new THREE.MeshStandardMaterial({ color: 0xf2c443, metalness: 0.85, roughness: 0.3, emissive: 0x4a3200, emissiveIntensity: 0.4 });
        const gem = new THREE.MeshStandardMaterial({ color: 0xd8203a, roughness: 0.2, metalness: 0.1, emissive: 0x400010 });
        const g = new THREE.Group();
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.3, 0.2, 10, 1, true), gold);
        band.material.side = THREE.DoubleSide;
        band.position.y = 0.1;
        g.add(band);
        const spike = new THREE.ConeGeometry(0.07, 0.2, 5);
        const gemGeo = new THREE.SphereGeometry(0.045, 6, 4);
        for (let i = 0; i < 5; i++) {
            const a = i / 5 * Math.PI * 2;
            const s = new THREE.Mesh(spike, gold);
            s.position.set(Math.sin(a) * 0.32, 0.29, Math.cos(a) * 0.32);
            g.add(s);
            const ball = new THREE.Mesh(gemGeo, gold);
            ball.position.set(Math.sin(a) * 0.32, 0.4, Math.cos(a) * 0.32);
            g.add(ball);
            const j = new THREE.Mesh(gemGeo, gem);
            j.position.set(Math.sin(a + 0.63) * 0.33, 0.1, Math.cos(a + 0.63) * 0.33);
            g.add(j);
        }
        g.traverse(o => { if (o.isMesh) o.castShadow = true; });
        return g;
    }

    function labelMaterial(color, type) {
        const key = color + type;
        if (labelMats.has(key)) return labelMats.get(key);
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d');
        g.beginPath();
        g.arc(64, 64, 56, 0, Math.PI * 2);
        g.fillStyle = TEAM[color].label;
        g.globalAlpha = 0.85;
        g.fill();
        g.globalAlpha = 1;
        g.lineWidth = 6;
        g.strokeStyle = TEAM[color].ink;
        g.stroke();
        g.fillStyle = TEAM[color].ink;
        g.font = '84px "Segoe UI Symbol", "DejaVu Sans", "Noto Sans Symbols 2", serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(GLYPHS[color][type] + '︎', 64, 70);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true });
        labelMats.set(key, mat);
        return mat;
    }

    function disposeUnit(u) {
        if (!units.has(u)) return;
        units.delete(u);
        if (u.fidget) fidgeting--;
        if (S.unregisterPickProxy) S.unregisterPickProxy(u.proxy);
        try { u.deco?.dispose(); } catch (e) { /* ignore */ }
        u.root.removeFromParent();
        if (u.mixer) { u.mixer.stopAllAction(); u.mixer.uncacheRoot(u.model); }
        if (u.horse) { u.horse.mixer.stopAllAction(); u.horse.mixer.uncacheRoot(u.horse.model); }
        u.root.traverse(o => { if (o.isMesh && o.userData.ownMaterial) [].concat(o.material).forEach(m => m.dispose()); });
        if (!u.mixer && u.model.geometry) { u.model.geometry.dispose(); u.model.material.dispose(); }
    }

    // ===========================================================================================
    // Positioning and animation primitives

    function sqPos(sq) {
        const v = S.squareToWorld ? S.squareToWorld(sq.row, sq.col).clone() : new THREE.Vector3(sq.col - 3.5, 0, sq.row - 3.5);
        v.y = 0;
        return v;
    }

    function placeAt(u, sq) {
        u.square = { row: sq.row, col: sq.col };
        u.root.position.copy(sqPos(sq));
        u.root.rotation.set(0, TEAM[u.color].yaw, 0);
        if (u.horse) u.horse.last.copy(u.root.position);
    }

    function findClip(names, u = null) {
        if (u?.proto?.native) {
            for (const n of [].concat(names)) { const m = nativeName(u, n); if (m) return clips.get(m); }
            return null;
        }
        for (const n of [].concat(names)) {
            if (!n || !clips.has(n)) continue;
            if (!u?.proto?.retarget) return clips.get(n);
            const c = retargetedClip(u.proto, n);
            if (c) return c;
        }
        return null;
    }

    // Shared clip converted for a retargeted rig, cached per model.
    function retargetedClip(proto, name) {
        if (!proto.clipCache.has(name)) {
            let c = null;
            const r = proto.retarget;
            try { c = (r.clipMap ? r.clipMap(name) : r.retargetClip?.(clips.get(name))) || null; } catch (e) { log('retarget clip failed', name, e); }
            proto.clipCache.set(name, c);
        }
        return proto.clipCache.get(name);
    }

    // A KayKit clip name requested by the choreography, mapped onto a native model's own clips by
    // meaning (role.anims keys); unmapped requests fall back to its idle so nothing T-poses.
    const NATIVE_KEYS = [
        [/^Block_Hit$/, ['block', 'hit']], [/^Blocking$|^Block$/, ['block', 'idle']],
        [/Attack|^Spellcast_Shoot$|^Throw$/, ['attack']], [/^Hit_/, ['hit']], [/^Death/, ['death']],
        [/^Walking/, ['walk']], [/^Running/, ['run', 'walk']], [/^Jump/, ['jump', 'idle']],
        [/^Cheer$|^Taunt|^Interact$|^Use_Item$|^Spellcast_Raise$/, ['cheer', 'idle']], [/^Spawn/, ['spawn', 'idle']],
        [/Idle/, ['idle']]
    ];
    function nativeName(u, n) {
        if (!n) return null;
        const own = u.proto.clipNames;
        if (own.has(n)) return n;
        const keys = (NATIVE_KEYS.find(([re]) => re.test(n)) || [null, ['idle']])[1];
        for (const key of keys) {
            const list = [].concat(u.role.anims?.[key] ?? u.role[key] ?? []).filter(x => own.has(x));
            // Stable per requested name (play and impactOf must agree), still varied across names.
            if (list.length) return list[[...n].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % list.length];
        }
        const idle = [].concat(u.role.anims?.idle ?? []).find(x => own.has(x));
        return idle || own.values().next().value || null;
    }

    // Bone by our canonical (KayKit) name: native role.bones, the retarget map, or the name itself.
    const NATIVE_BONE_KEYS = { head: 'head', chest: 'chest', hips: 'hips', 'handslot.r': 'handR', 'handslot.l': 'handL' };
    function boneOf(u, n) {
        const nb = u.role?.bones?.[NATIVE_BONE_KEYS[n]];
        if (nb) { const b = byName(u.model, nb); if (b) return b; }
        const mapped = u.proto?.retarget?.bones?.[n];
        return (mapped && byName(u.model, mapped)) || byName(u.model, n);
    }

    function play(u, names, { loop = false, fade = FADE, speed = 1, start = 0, fidget = false, fullBody = false } = {}) {
        if (!fidget && u.fidget) { u.fidget = null; fidgeting--; }
        u.look = fidget ? u.look : null;
        if (!u.mixer) return null;
        let clip = findClip(names, u) || findClip(anim(u, 'idle', ['Idle']), u);
        if (!clip) return null;
        // A mounted rider keeps its seated legs: everything but deaths plays on the upper body only.
        if (u.horse) {
            if (fullBody) u.horse.seat?.stop();
            else { clip = upperBody(clip); if (!u.horse.seat?.isRunning()) startSeat(u); }
        }
        const a = u.mixer.clipAction(clip);
        const prev = u.current;
        a.reset();
        a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        a.clampWhenFinished = true;
        a.timeScale = speed;
        a.time = start;
        a.setEffectiveWeight(1);
        a.play();
        if (prev && prev !== a) {
            if (fade > 0) a.crossFadeFrom(prev, fade, false);
            else prev.stop();
        }
        if (fade > 0 && (!prev || prev === a)) a.fadeIn(Math.min(fade, 0.1));
        u.current = a;
        return a;
    }

    function idle(u, fade = FADE) {
        if (u.dead) return;
        const a = play(u, anim(u, 'idle', ['Idle']), { loop: true, fade, speed: rand(0.9, 1.1) });
        if (a && fade === 0) a.time = Math.random() * a.getClip().duration;
    }

    function guard(u) {
        const hasShield = (u.role.show || []).some(n => /shield/i.test(n)) || (u.role.props || []).some(p => /shield/i.test(p.file));
        const names = u.role.guard ? [u.role.guard] : hasShield ? ['Blocking'] : u.isSkeleton ? ['Idle_Combat', '2H_Melee_Idle'] : ['2H_Melee_Idle'];
        play(u, names, { loop: true, fade: 0.2 });
        return hasShield;
    }

    // Wait until action `a` reaches clip time `t` (or ends / gets replaced).
    function untilClip(u, a, t) {
        if (!a) return Math.max(0.05, t * 0.5);
        const clip = a.getClip();
        const target = Math.min(t, clip.duration - 1e-3);
        let guardT = 0;
        const maxT = target / Math.max(0.05, a.timeScale) + 2;
        return () => {
            guardT += R.dt;
            if (a.time >= target && u.current === a) {
                const rate = Math.abs(a.timeScale * (u.mixer?.timeScale ?? 1)) || 1;
                R.addDebt((a.time - target) / rate);
                return true;
            }
            return u.current !== a || !a.isRunning() || guardT > maxT;
        };
    }

    function* playOnce(u, names, opts = {}) {
        const a = play(u, names, opts);
        if (!a) { yield 0.4 / (opts.speed || 1); return; }
        yield untilClip(u, a, opts.until ?? a.getClip().duration);
    }

    function* tween(dur, fn) {
        let t = R.takeDebt();
        if (dur <= 0 || t >= dur) { fn(1); R.addDebt(t - Math.max(0, dur)); return; }
        fn(t / dur);
        yield () => {
            t += R.dt;
            fn(Math.min(1, t / dur));
            if (t < dur) return false;
            R.addDebt(t - dur);
            return true;
        };
    }

    function* turnTo(u, yaw, rate = 9) {
        const from = u.root.rotation.y;
        const d = angleDiff(from, yaw);
        if (Math.abs(d) < 0.02) { u.root.rotation.y = from + d; return; }
        const dur = clamp(Math.abs(d) / rate, 0.1, 0.35) / speedMul();
        yield* tween(dur, k => { u.root.rotation.y = from + d * smooth(k); });
    }

    function* faceHome(u) { yield* turnTo(u, TEAM[u.color].yaw); }

    function speedMul() { return mode === 'fast' ? FAST : 1; }

    // Pick walk or run for a ground speed (world units/s) and the playback rate that keeps feet planted.
    // ===========================================================================================
    // Mounted units: the role model rides a native mount model (b3d-assets role.mount). The horse's
    // clips follow the unit root's motion (walk/run by ground speed, jump while airborne, death while
    // dying), so every choreography works unchanged; the rider plays upper-body clips on a seated base.

    const FACING = { '+z': 0, '-z': Math.PI, '+x': -Math.PI / 2, '-x': Math.PI / 2 };
    const LOWER_BODY = /^(root|hips|upperleg|lowerleg|foot|toes)/;
    const upperCache = new WeakMap(), lowerCache = new WeakMap();
    function filterClip(clip, keepLower, cache) {
        if (!cache.has(clip)) {
            const tracks = clip.tracks.filter(t => LOWER_BODY.test(t.name.split('.')[0]) === keepLower);
            cache.set(clip, new THREE.AnimationClip(clip.name + (keepLower ? '#lower' : '#upper'), clip.duration, tracks));
        }
        return cache.get(clip);
    }
    const upperBody = clip => filterClip(clip, false, upperCache);

    function startSeat(u) {
        const sit = findClip([u.role.mount.riderAnim, 'Sit_Chair_Idle', 'Idle'], u);
        if (!sit) return;
        const a = u.mixer.clipAction(filterClip(sit, true, lowerCache));
        a.reset().setLoop(THREE.LoopRepeat, Infinity).play();
        u.horse.seat = a;
    }

    function mountUnit(u, m) {
        const proto = protos.get(m.model);
        if (!proto) return;
        const horse = SkeletonUtils.clone(proto.scene);
        horse.scale.setScalar(m.scale ?? 1);
        if (m.tint) {
            const tint = new THREE.Color(m.tint);
            horse.traverse(o => {
                if (!o.isMesh) return;
                o.material = [].concat(o.material).map(mt => { const c = mt.clone(); c.color?.multiply(tint); return c; });
                if (o.material.length === 1) o.material = o.material[0];
                o.userData.ownMaterial = true;
            });
        }
        horse.rotation.y = FACING[m.forward || '+z'] ?? 0;
        horse.position.y = MODEL_Y;
        u.root.add(horse);
        // The rider sits at the saddle (horse-local, unscaled units) and keeps its world size.
        const rider = u.model;
        rider.removeFromParent();
        horse.add(rider);
        rider.position.fromArray(m.saddle || [0, 1, 0]);
        rider.scale.setScalar(u.scale * (m.riderScale ?? 1) / (m.scale ?? 1));
        rider.rotation.y = (u.proto?.retarget ? 0 : FACING[u.role.forward || '+z'] ?? 0) - horse.rotation.y;
        u.modelPos0 = rider.position.clone();
        u.horse = { model: horse, proto, m, mixer: new THREE.AnimationMixer(horse), current: null, key: null, last: u.root.position.clone(), dead: false, stepT: 0, fitted: false };
        horseSet(u, 'idle', 1, true);
        if (u.mixer) startSeat(u);
    }

    function horseClip(h, key) {
        const own = h.proto.clipNames || new Set();
        return [].concat(h.m.anims?.[key] ?? []).map(n => clips.get(n)).find(c => c && own.has(c.name)) || null;
    }

    function horseSet(u, key, rate, loop) {
        const h = u.horse;
        if (h.key === key) { if (h.current) h.current.timeScale = rate; return; }
        const clip = horseClip(h, key) || (key === 'run' ? horseClip(h, 'walk') : null) || horseClip(h, 'idle');
        h.key = key;
        if (!clip) return;
        const a = h.mixer.clipAction(clip);
        a.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        a.clampWhenFinished = true;
        a.timeScale = rate;
        a.play();
        if (h.current && h.current !== a) a.crossFadeFrom(h.current, 0.2, false);
        h.current = a;
    }

    function updateHorse(u, dt) {
        const h = u.horse;
        const p = u.root.position;
        const speed = dt > 0 ? Math.hypot(p.x - h.last.x, p.z - h.last.z) / dt : 0;
        h.last.copy(p);
        if (u.dying || u.dead) { if (!h.dead) { h.dead = true; horseSet(u, 'death', 1, false); } }
        else if (p.y > 0.03) horseSet(u, 'jump', 1, false);
        else if (speed > 0.05) {
            const walk = h.m.walkSpeed || 1.2, run = h.m.runSpeed || 3;
            // Hysteresis so turns and lunges don't flicker between walk and run.
            const running = (h.key === 'run' ? speed > walk * 1.3 : speed > walk * 1.7) && horseClip(h, 'run');
            horseSet(u, running ? 'run' : 'walk', clamp(speed / (running ? run : walk), 0.6, 2.2), true);
            // Hoofbeats: four per cycle, quieter than a rook's step.
            h.stepT += dt;
            const dur = h.current?.getClip().duration || 1;
            if (h.stepT >= dur / 4 / Math.max(0.1, h.current?.timeScale || 1)) {
                h.stepT = 0;
                sfxAt('step', u, { variant: 'heavy', volume: (mode === 'fast' ? 0.25 : 0.35) * sizeOf(u), rate: rand(1.05, 1.2) });
            }
        } else horseSet(u, 'idle', 1, true);
        h.mixer.update(dt);
        if (!h.fitted && u.mixer && u.bones.hips && h.seat) fitSaddle(u);
    }

    // Once, with the seated pose applied: shift the rider so its hips sit on the saddle point.
    function fitSaddle(u) {
        const h = u.horse;
        h.fitted = true;
        const rider = u.model;
        h.model.updateMatrixWorld(true);
        const hipsInHorse = h.model.worldToLocal(u.bones.hips.getWorldPosition(new THREE.Vector3()));
        rider.position.add(new THREE.Vector3().fromArray(h.m.saddle || [0, 1, 0]).sub(hipsInHorse));
        u.modelPos0 = rider.position.clone();
    }

    function startLocomotion(u, v, { quiet = false } = {}) {
        if (u.horse) { play(u, anim(u, 'idle', ['Idle']), { loop: true, fade: 0.15 }); u.loco = null; return; }
        if (u.proto?.native) {
            // No stride measurement on unknown bones: rate from the role's walk speed (world units/s at rate 1).
            const runOk = (u.role.anims?.run || []).length !== 0 && v > (u.role.walkSpeed || 1.2) * 1.6;
            const base = runOk ? (u.role.runSpeed || 3) : (u.role.walkSpeed || 1.2);
            const a = play(u, runOk ? 'Running_A' : 'Walking_A', { loop: true, fade: 0.15, speed: clamp(v / base, 0.6, 2.2) });
            u.loco = a ? { action: a, contacts: [0, 0.5], prev: a.time, quiet, last: -1 } : null;
            return;
        }
        const walk = anim(u, 'walk', [])[0] || (u.isSkeleton && u.type === 'p' ? 'Walking_D_Skeletons' : 'Walking_A');
        const run = anim(u, 'run', [])[0] || 'Running_A';
        const nat = n => (clipStats(n).speed || 0.9) * u.scale * (u.proto?.retarget?.scale || 1);
        const walkRate = v / nat(walk);
        const a = walkRate <= 1.7 || !clips.has(run)
            ? play(u, [walk, 'Walking_A'], { loop: true, fade: 0.15, speed: clamp(walkRate, 0.6, 2.2) })
            : play(u, run, { loop: true, fade: 0.15, speed: clamp(v / nat(run), 0.7, 2.0) });
        // Footsteps fire when the clip passes each foot's contact phase (see trackSteps).
        u.loco = a ? { action: a, contacts: clipStats(a.getClip().name).contacts, prev: a.time, quiet, last: -1 } : null;
    }

    // Footstep variant by role and army.
    function stepVariant(u) {
        if (u.isSkeleton) return u.type === 'r' ? 'heavy' : 'bone';
        return { n: 'armor', k: 'armor', r: 'heavy' }[u.type] || 'light';
    }
    const sizeOf = u => clamp((u.scale || 0.38) / 0.38, 0.7, 1.5);

    function trackSteps(u) {
        const L = u.loco;
        const a = L.action;
        if (u.current !== a || !a.isRunning()) { u.loco = null; return; }
        const dur = a.getClip().duration;
        const now = a.time, prev = L.prev;
        L.prev = now;
        if (ffwd || L.quiet || !dur) return;
        for (const c of L.contacts) {
            const ct = c * dur;
            const crossed = prev <= now ? ct > prev && ct <= now : ct > prev || ct <= now;
            if (crossed && R.time - L.last > 0.12) {
                L.last = R.time;
                sfxAt('step', u, { variant: stepVariant(u), volume: (mode === 'fast' ? 0.3 : 0.45) * sizeOf(u), rate: rand(0.94, 1.06) });
            }
        }
    }

    // Ground speed for a leg of `dist`: walk pace, but long legs finish within `maxT` (run).
    function travelSpeed(dist, maxT = 1.6) {
        const v = Math.max(WALK_SPEED, dist / maxT);
        return mode === 'fast' ? Math.max(v * FAST, dist / (maxT / 2)) : v;
    }

    function* moveTo(u, target, { speed, keepFacing = false } = {}) {
        const start = u.root.position.clone();
        const dist = flatDist(start, target);
        if (dist < 0.02) return;
        const v = speed ?? travelSpeed(dist);
        startLocomotion(u, v, { quiet: mode === 'fast' && dist / v < 0.4 });
        const yaw = yawBetween(start, target);
        if (!keepFacing && Math.abs(angleDiff(u.root.rotation.y, yaw)) > 2) yield* turnTo(u, yaw, 14);
        const glide = tween(dist / v, k => { u.root.position.lerpVectors(start, target, k); });
        yield keepFacing ? glide : [turnTo(u, yaw, 16), glide];
    }

    function* jumpTo(u, target, height = 0.6, hurry = 1) {
        const start = u.root.position.clone();
        const dist = flatDist(start, target);
        const m = speedMul() * hurry;
        yield* turnTo(u, yawBetween(start, target), 14);
        const a = play(u, 'Jump_Start', { speed: 1.6 * m, fade: 0.1 });
        sfxAt('jump', u, { volume: 0.6 * sizeOf(u), variant: stepVariant(u) });
        yield untilClip(u, a, 0.42);
        play(u, ['Jump_Idle', 'Jump_Start'], { loop: true, fade: 0.1 });
        const dur = (0.4 + dist * 0.09) / m;
        yield* tween(dur, k => {
            u.root.position.lerpVectors(start, target, k);
            u.root.position.y = 4 * height * k * (1 - k);
        });
        u.root.position.y = 0;
        burst(target, 'dust', { count: 10 });
        sfxAt('land', u, { volume: 0.8 * sizeOf(u), variant: stepVariant(u) });
        const land = play(u, 'Jump_Land', { speed: 1.5 * m, fade: 0.08 });
        yield untilClip(u, land, 0.45);
    }

    function* settle(u) {
        sfxAt('settle', u, { volume: 0.55 * sizeOf(u), rate: 1.1 / sizeOf(u) });
        idle(u, 0.2);
        yield* faceHome(u);
    }

    // ===========================================================================================
    // FX, audio and camera wrappers (all suppressed while fast-forwarding)

    const fxAPI = S.fx || {};
    const cine = S.cinematic || null;

    function burst(pos, kind, opts = {}) {
        if (ffwd || !S.burst) return;
        try { S.burst(pos.clone(), kind, opts); } catch (e) { log('burst failed', e); }
    }
    function shake(s) { if (!ffwd && S.shake) try { S.shake(s); } catch (e) { /* ignore */ } }
    // v4 cue names; until audio.js knows them (audio.has), fall back to the closest v2 name or stay silent.
    const LEGACY = { shatter: 'bone', slam: 'thud', fall: 'thud', land: 'thud', jump: 'whoosh', magicHit: 'magic', dissolve: 'magic', victory: 'cheer' };
    // Without audio.has() the bank is assumed to be the v2 one.
    const V2_NAMES = new Set(['step', 'whoosh', 'clang', 'hit', 'thud', 'bone', 'magic', 'zap', 'cheer', 'death', 'promote']);
    const knows = n => (typeof audio?.has === 'function' ? audio.has(n) : V2_NAMES.has(n));
    function sfx(name, opts = {}) {
        if (ffwd || !audio?.play) return;
        if (!knows(name)) {
            name = LEGACY[name];
            if (!name || !knows(name)) return;
        }
        try { audio.play(name, opts); } catch (e) { /* ignore */ }
    }
    // Positioned cue: `at` is a unit (its root position) or a world position.
    function sfxAt(name, at, opts = {}) {
        const pos = at?.root ? at.root.position.clone() : at?.clone ? at.clone() : null;
        sfx(name, { ...opts, pos });
    }
    function chestPos(u) {
        const p = u.root.position.clone();
        p.y += 0.45 * (u.scale ? u.scale / 0.38 : 1);
        return p;
    }
    function handPos(u) {
        return u.bones.handR ? u.bones.handR.getWorldPosition(new THREE.Vector3()) : chestPos(u);
    }

    function impactFx(pos, dir, kind) {
        if (ffwd) return;
        if (fxAPI.impact) { try { fxAPI.impact(pos.clone(), dir.clone(), kind); return; } catch (e) { log('impact failed', e); } }
        burst(pos, kind === 'magic' ? 'magic' : 'spark', { count: 12 });
    }
    function debrisFx(pos, opts) {
        if (ffwd) return;
        if (fxAPI.debris) { try { fxAPI.debris(pos.clone(), opts); return; } catch (e) { log('debris failed', e); } }
        burst(pos, opts.kind === 'bones' ? 'poof' : 'dust', { count: opts.count || 10 });
    }
    function decalFx(pos, kind) {
        if (ffwd) return;
        if (fxAPI.decal) { try { fxAPI.decal(pos.clone(), kind); return; } catch (e) { log('decal failed', e); } }
        burst(pos, kind === 'scorch' ? 'magic' : 'dust', { count: 8 });
    }
    // Weapon trail on the visible weapon in the given hand (or the hand slot itself).
    function trailFx(u, color, side = 'R') {
        if (ffwd || !fxAPI.trail) return null;
        const slot = side === 'L' ? u.bones.handL : u.bones.handR;
        if (!slot) return null;
        let target = slot;
        slot.traverse(o => { if (target === slot && o !== slot && o.isMesh && o.visible) target = o; });
        // Follow the weapon tip: the far end of the mesh along its long (local y) axis.
        let offset;
        if (target.isMesh && target.geometry) {
            if (!target.geometry.boundingBox) target.geometry.computeBoundingBox();
            const bb = target.geometry.boundingBox;
            offset = new THREE.Vector3(0, Math.abs(bb.max.y) >= Math.abs(bb.min.y) ? bb.max.y * 0.85 : bb.min.y * 0.85, 0);
        }
        try {
            const t = fxAPI.trail(target, { color, width: 0.1, length: 16, offset });
            if (!t) return null;
            const h = { stop() { if (trails.delete(h)) try { t.stop(); } catch (e) { /* ignore */ } } };
            trails.add(h);
            return h;
        } catch (e) { log('trail failed', e); return null; }
    }
    function stopTrails() { for (const t of [...trails]) t.stop(); }

    // Magic bolt; the caller waits `dur` on the units clock, which lands with scene.projectile's orb.
    function* bolt(from, to, color, dur, size = 1) {
        const hex = '#' + new THREE.Color(TEAM[color].bolt).getHexString();
        if (ffwd) return;
        if (S.projectile) {
            Promise.resolve(S.projectile(from, to, { duration: dur, color: hex, arc: 0.25, size })).catch(() => {});
            sfxAt('bolt', from, { volume: 0.5 * size, rate: clamp(0.35 / Math.max(0.1, dur), 0.8, 1.6) });
            yield dur;
        } else {
            sfxAt('bolt', from, { volume: 0.5 * size });
            yield* projectile(from, to, TEAM[color].bolt, dur);
        }
        sfxAt('magicHit', to, { volume: 0.6 * size });
    }

    // Camera: cinematic shots in Full when allowed, else the plain focusOn/restoreView pair.
    const cam = {
        open(A, V, spot) {
            if (ffwd || !fightCamera || mode !== 'full') return;
            focused = true;
            const pts = [(spot || A.root.position).clone().setY(0), V.root.position.clone().setY(0)];
            if (cine?.shot) {
                try { cine.letterbox?.(true); } catch (e) { /* ignore */ }
                Promise.resolve(cine.shot('two-shot', pts, { duration: 0.7 })).catch(() => {});
            } else if (S.focusOn) {
                Promise.resolve(S.focusOn(pts.map(p => p.setY(0.45)), { duration: 0.6 })).catch(() => {});
            }
        },
        finisher(A, V, shot) {
            if (ffwd || !focused || !cine?.shot) return;
            // Ranged attackers get the over-shoulder from behind the caster (scene's long-range recipe);
            // at duel range scene turns an over-shoulder into a two-shot by itself.
            const far = flatDist(A.root.position, V.root.position) > 1.5;
            const type = shot || (A.type === 'b' && far ? 'over-shoulder' : pick(['closeup', 'two-shot', 'over-shoulder']));
            const pts = type === 'closeup' ? [V.root.position.clone().setY(0)] : [A.root.position.clone().setY(0), V.root.position.clone().setY(0)];
            Promise.resolve(cine.shot(type, pts, { duration: type === 'orbit' ? 1.0 : 0.45, cut: type !== 'orbit' })).catch(() => {});
        },
        slowMo(scale, dur) {
            if (ffwd || mode !== 'full' || !cine?.slowMo) return;
            setAudioSlowMo(scale);
            Promise.resolve(cine.slowMo(scale, dur)).catch(() => {}).then(() => setAudioSlowMo(1));
        },
        close(duration = 0.5) {
            setAudioSlowMo(1);
            if (!focused) return;
            focused = false;
            const d = ffwd ? 0 : duration;
            if (cine?.end) {
                try { cine.letterbox?.(false); } catch (e) { /* ignore */ }
                Promise.resolve(cine.end({ duration: d })).catch(() => {});
            } else if (S.restoreView) {
                Promise.resolve(S.restoreView({ duration: d })).catch(() => {});
            }
        }
    };
    const camRestore = d => cam.close(d);
    function setAudioSlowMo(f) { try { audio?.setSlowMo?.(f); } catch (e) { /* ignore */ } }

    function* hitStop(list, dur = 0.07) {
        for (const u of list) if (u.mixer) u.mixer.timeScale = 0.05;
        yield dur;
        for (const u of list) if (u.mixer) u.mixer.timeScale = 1;
    }

    function* projectile(from, to, color, dur) {
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
        const orb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), mat);
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
        halo.scale.set(0.35, 0.35, 1);
        orb.add(halo);
        S.scene.add(orb);
        let trail = 0;
        try {
            yield* tween(dur, k => {
                orb.position.lerpVectors(from, to, k);
                orb.position.y += Math.sin(k * Math.PI) * 0.25;
                trail += R.dt;
                if (trail > 0.06) { trail = 0; burst(orb.position, 'magic', { color, count: 3 }); }
            });
        } finally {
            orb.removeFromParent();
            orb.geometry.dispose(); mat.dispose(); halo.material.dispose();
        }
    }

    let glowTex = null;
    function glowTexture() {
        if (glowTex) return glowTex;
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
        glowTex = new THREE.CanvasTexture(c);
        return glowTex;
    }

    // ===========================================================================================
    // Death primitives (fights.js sequences them)

    // Marks the unit as dying and gives every mesh (props and decorations included) its own
    // transparent material so it can fade independently.
    function startDeath(u) {
        if (u.dying) return;
        u.dying = true;
        setLabel(u, false);
        u.fadeMats = [];
        u.root.traverse(o => {
            if (!o.isMesh || o === u.proxy) return;
            const cloned = [].concat(o.material).map(m => {
                const c = m.clone();
                c.transparent = true;
                c.userData.baseOpacity = m.opacity;
                u.fadeMats.push(c);
                return c;
            });
            o.material = Array.isArray(o.material) ? cloned : cloned[0];
            o.userData.ownMaterial = true;
        });
    }

    // Plays the death clip with the hips pinned on the square.
    function fall(u, names, { speed = 1 } = {}) {
        startPin(u);
        play(u, names, { speed, fade: 0.1, fullBody: true });
    }

    function shrinkBase(u, dur) {
        later(0, null, (function* () {
            yield* tween(dur, k => { for (const b of u.base) b.scale.set(Math.max(1e-3, 1 - k), 1, Math.max(1e-3, 1 - k)); });
        })());
    }

    // Fades (and sinks) the body, optionally sparkling into light, then removes the unit.
    function* fadeOut(u, { dur = 0.5, sink = 0.3, sparkle = false } = {}) {
        if (!u.fadeMats) startDeath(u);
        u.fading = true;
        const y0 = u.root.position.y;
        let spark = 0;
        yield* tween(dur, k => {
            u.root.position.y = y0 - sink * k * k;
            for (const m of u.fadeMats) m.opacity = m.userData.baseOpacity * (1 - k);
            if (sparkle) {
                spark += R.dt;
                if (spark > 0.07) {
                    spark = 0;
                    const p = u.root.position.clone();
                    p.x += rand(-0.25, 0.25); p.z += rand(-0.25, 0.25); p.y = 0.1 + rand(0, 0.3);
                    burst(p, 'magic', { color: 0xfff1b0, count: 4 });
                }
            }
        });
        disposeUnit(u);
    }

    function restoreMaterials(u) {
        if (!u.fadeMats) return;
        for (const m of u.fadeMats) { m.opacity = m.userData.baseOpacity; }
        u.fadeMats = null;
        u.fading = false;
    }

    // Runs `fn` (or a generator) after `delay` seconds on the units clock.
    function later(delay, fn, gen) {
        R.spawn((function* () {
            if (delay > 0) yield delay;
            if (fn) fn();
            if (gen) yield* gen;
        })());
    }

    // ===========================================================================================
    // Attack data

    function impactOf(u, name) {
        if (!name) return 0.3;
        if (u?.proto?.native) name = nativeName(u, name);
        const f = manifest.fight?.[u.color + u.type] || manifest.fight?.[u.type] || {};
        const known = u?.role?.impacts?.[name] ?? f.impact?.[name] ?? manifest.impacts?.[name];
        if (known != null) return known;
        // Native clips can't be sampled on the KayKit measurement rig: assume the blow lands at 45%.
        if (u?.proto?.native) return (clips.get(name)?.duration ?? 1) * 0.45;
        return clipStats(name).impact;
    }

    function attackList(u) {
        const f = manifest.fight?.[u.color + u.type] || manifest.fight?.[u.type] || {};
        let list = (u.role.anims?.attack || f.attack || DEFAULT_ATTACKS[u.type] || []).filter(n => clips.has(n));
        if (!list.length) list = (f.attack || DEFAULT_ATTACKS[u.type] || DEFAULT_ATTACKS.p).filter(n => clips.has(n));
        return list;
    }

    // ===========================================================================================
    // Fights (choreography lives in fights.js)

    const kit = {
        THREE,
        get full() { return mode === 'full'; },
        get mode() { return mode; },
        lastPlan: null,
        rand, pick, smooth, flatDist, yawBetween,
        hasClip: n => clips.has(n),
        play, playOnce, untilClip, guard, anim, idle,
        tween, turnTo, moveTo, jumpTo, settle,
        walkSpeed: () => WALK_SPEED * speedMul(),
        sqPos, chestPos, handPos,
        impactOf, attackList,
        hitStop, later: (d, fn) => later(d, fn),
        sfx, sfxAt, sizeOf,
        // Melee standoff: mounted units need room for the horse.
        reach: (A, V) => 0.65 + (A.horse ? 0.3 : 0) + (V.horse ? 0.25 : 0),
        fx: {
            burst, shake, impact: impactFx, debris: debrisFx, decal: decalFx, trail: trailFx, bolt,
            get hasImpact() { return !!fxAPI.impact; }
        },
        cam,
        startDeath, fall, shrinkBase, fadeOut,
        hideLabels: list => { if (focused || mode === 'full') for (const u of list) setLabel(u, false); },
        showLabels: list => { for (const u of list) if (!u.dying) setLabel(u, labelsOn); }
    };
    const fights = createFights(kit);

    function* captureSeq(ev, A, V) {
        yield* fights.capture(ev, A, V);
    }

    function* moveSeq(ev, A) {
        const toPos = sqPos(ev.to);
        if (A.type === 'n') yield* jumpTo(A, toPos);
        else yield* moveTo(A, toPos);
        yield* settle(A);
    }

    function* castleSeq(ev, K, Rk) {
        sfxAt('castle', K, { volume: 0.7 });
        const kingGo = function* () {
            yield* moveTo(K, sqPos(ev.to));
            yield* settle(K);
        };
        const rookGo = function* () {
            if (!Rk) return;
            yield 0.15 / speedMul();
            const off = K.color === 'w' ? 0.42 : -0.42;   // step toward the back edge, behind the king
            const p0 = sqPos(ev.castling.rookFrom), p3 = sqPos(ev.castling.rookTo);
            const p1 = p0.clone().setZ(p0.z + off), p2 = p3.clone().setZ(p3.z + off);
            yield* moveTo(Rk, p1);
            yield* moveTo(Rk, p2);
            yield* moveTo(Rk, p3);
            yield* settle(Rk);
        };
        yield [kingGo(), rookGo()];
    }

    function* promoteSeq(pawn, swap) {
        const full = mode === 'full';
        const m = speedMul();
        idle(pawn, 0.15);
        yield* faceHome(pawn);
        yield* playOnce(pawn, pawn.isSkeleton ? ['Spellcast_Raise', 'Cheer'] : ['Cheer', 'Spellcast_Raise'], { speed: 1.3 * m, until: full ? 1.1 : 0.9 });
        burst(chestPos(pawn), 'magic', { count: 24 });
        sfxAt('promote', pawn);
        burst(chestPos(pawn), 'poof', { count: 16 });
        shake(0.3);
        const nu = swap();
        if (!nu) return;
        const a = play(nu, anim(nu, 'spawn', nu.isSkeleton ? ['Spawn_Ground_Skeletons', 'Spawn_Ground'] : ['Spawn_Air', 'Spawn_Ground']), { speed: (nu.isSkeleton ? 2.2 : 1.1) * m, fade: 0 });
        yield untilClip(nu, a, a ? a.getClip().duration : 0);
        idle(nu, 0.25);
    }

    // ===========================================================================================
    // Public API helpers

    function unitAtSq(sq) { return sq && grid[sq.row] ? grid[sq.row][sq.col] : null; }

    function run(gen) {
        const p = new Promise(res => { R.spawn(gen, res); });
        syncTokens();
        S.requestRender?.();
        return p;
    }

    function finalizeAll() {
        while (finalizers.length) finalizers.shift()();
    }

    // Snap every unit to its logical square and drop anything dying (used when a sequence is cut).
    function snapAll() {
        R.abortAll();
        stopTrails();
        finalizeAll();
        for (const u of [...units]) if (u.dying || !gridHas(u)) disposeUnit(u);
        for (const u of units) {
            if (u.mixer) u.mixer.timeScale = 1;
            setLabel(u, labelsOn);
            placeAt(u, u.square);
            if (!u.dead) idle(u, 0.1);
        }
        camRestore(0.3);
    }

    function gridHas(u) { return grid[u.square.row]?.[u.square.col] === u; }

    function fastForward() {
        ffwd = true;
        try {
            for (let i = 0; i < 1800 && R.busy; i++) update(1 / 30);
        } finally { ffwd = false; }
        if (R.busy) snapAll();
        finalizeAll();
        camRestore(0.3);
    }

    // ===========================================================================================
    // Per-frame update

    // Render-on-demand tokens: 'idle' while units exist (scene throttles it), 'units-fight' while animating.
    function syncTokens() {
        if (!S.keepAlive) return;
        const busy = R.busy || H.busy || G.busy;
        if (busy !== fightToken) { fightToken = busy; try { S.keepAlive('units-fight', busy); } catch (e) { /* ignore */ } }
        const want = units.size > 0;
        if (want !== idleToken) { idleToken = want; try { S.keepAlive('idle', want); } catch (e) { /* ignore */ } }
    }

    function update(dt) {
        R.update(dt);
        if (H.busy) H.update(dt);
        if (G.busy) G.update(dt);
        syncTokens();
        for (const u of units) {
            if (!u.mixer) continue;
            const head = u.bones.head;
            if (head && u.lookApplied) { head.quaternion.copy(u.headPre); u.lookApplied = false; }
            u.mixer.update(dt);
            if (u.loco) trackSteps(u);
            if (u.horse) updateHorse(u, dt);
            if (u.pin) {
                // Death_C_Skeletons detaches the right leg and leaves it standing; keep it on the body.
                if (u.bones.legR) u.bones.legR.position.copy(u.legRest);
                pinHips(u);
            }
            if (!ffwd) updateFidget(u, dt);
        }
    }

    const _q = new THREE.Quaternion();
    const _up = new THREE.Vector3(0, 1, 0);
    const _side = new THREE.Vector3(1, 0, 0);
    const _v = new THREE.Vector3();

    // Death clips move the hips (and Death_C_Skeletons the root) sideways; counter-shift the model so
    // the body stays centred on its square.
    function startPin(u) {
        if (!u.bones.hips || u.pin || u.horse) return;
        u.model.updateMatrixWorld(true);
        const p = u.model.worldToLocal(u.bones.hips.getWorldPosition(_v));
        u.pin = { x: p.x, z: p.z };
        const get = n => boneOf(u, n);
        u.pinBones = [['head', 0.4], ['handslot.r', 0.3], ['handslot.l', 0.3], ['foot.l', 0.1], ['foot.r', 0.1]]
            .map(([n, m]) => [get(n), m]).filter(([b]) => b);
        u.torsoBones = ['hips', 'chest', 'head'].map(get).filter(Boolean);
        u.pin.upright = (u.bones.head ? u.bones.head.getWorldPosition(new THREE.Vector3()).y : 0) - u.bones.hips.getWorldPosition(new THREE.Vector3()).y;
    }

    function pinHips(u) {
        const p = u.model.worldToLocal(u.bones.hips.getWorldPosition(_v));
        _v.set(p.x - u.pin.x, 0, p.z - u.pin.z).multiplyScalar(u.scale).applyQuaternion(u.model.quaternion);
        u.model.position.x = u.modelPos0.x - _v.x;
        u.model.position.z = u.modelPos0.z - _v.z;
        // Then nudge the whole body back inside the playing surface (head, hands with props, feet).
        u.model.updateMatrixWorld(true);
        let minX = 0, maxX = 0, minZ = 0, maxZ = 0;
        for (const [bone, margin] of u.pinBones) {
            bone.getWorldPosition(_v);
            minX = Math.min(minX, _v.x - margin + BOARD_EDGE);
            maxX = Math.max(maxX, _v.x + margin - BOARD_EDGE);
            minZ = Math.min(minZ, _v.z - margin + BOARD_EDGE);
            maxZ = Math.max(maxZ, _v.z + margin - BOARD_EDGE);
        }
        if (minX || maxX || minZ || maxZ) {
            _v.set(-minX - maxX, 0, -minZ - maxZ).applyQuaternion(_q.copy(u.root.quaternion).invert());
            u.model.position.x += _v.x;
            u.model.position.z += _v.z;
        }
        // Non-KayKit bodies: retargeted death clips keep the hips higher on long-legged rigs, so the
        // corpse would float. Lower the body (never above its own pose) until its lowest bone rests on the board.
        // Feet are ignored: on long-legged rigs the lying body rests on pointed toes. The clamp fades in
        // as the torso goes horizontal, so a falling body is not pushed into the board.
        if ((u.proto?.retarget || u.proto?.native) && u.torsoBones.length) {
            let low = Infinity;
            for (const b of u.torsoBones) low = Math.min(low, b.getWorldPosition(_v).y - u.root.position.y);
            const head = u.bones.head?.getWorldPosition(_v).y ?? 0;
            const hips = u.bones.hips.getWorldPosition(_v).y;
            const lying = u.pin.upright > 0.05 ? clamp(1 - (head - hips) / u.pin.upright, 0, 1) : 1;
            const drop = u.pin.drop || 0;
            const target = Math.max(0, drop + (low - GROUND_REST) * lying);
            const step = 3 * R.dt;
            u.pin.drop = clamp(target, drop - step, drop + step);
            u.model.position.y = u.modelPos0.y - u.pin.drop;
        }
    }

    function clearPin(u) {
        u.pin = null;
        u.model.position.copy(u.modelPos0);
    }

    function updateFidget(u, dt) {
        if (u.fidget && (!u.fidget.isRunning() || u.fidget.time >= u.fidget.getClip().duration - 0.01 || u.current !== u.fidget)) {
            u.fidget = null;
            fidgeting--;
            if (!R.busy) idle(u, 0.35);
        }
        if (u.look) {
            u.look.t += dt;
            const k = u.look.t / u.look.dur;
            if (k >= 1 || R.busy) u.look = null;
            else if (u.bones.head) {
                u.headPre.copy(u.bones.head.quaternion);
                u.bones.head.quaternion.multiply(_q.setFromAxisAngle(_up, u.look.angle * Math.sin(Math.PI * k)));
                u.lookApplied = true;
            }
        }
        if (u.nod && u.bones.head) {
            const n = u.nod;
            n.t += dt;
            const k = Math.min(1, n.t / n.dur);
            // talk: quick bobbing with an envelope; facepalm: one slow drop of the head
            const pitch = n.kind === 'facepalm' ? n.amp * Math.sin(Math.PI * k) : n.amp * Math.sin(2 * Math.PI * n.freq * n.t) * Math.sin(Math.PI * k);
            if (!u.lookApplied) u.headPre.copy(u.bones.head.quaternion);
            u.bones.head.quaternion.multiply(_q.setFromAxisAngle(_side, pitch));
            u.lookApplied = true;
            if (k >= 1) u.nod = null;
        }
        if (u.nod || gestureUnits.has(u)) return;
        if (R.busy || u === hintUnit || u.dead || u.dying || u.fidget || u.look || R.time < u.nextFidget) return;
        u.nextFidget = R.time + rand(9, 26);
        if (Math.random() < 0.5 || fidgeting >= 2) {
            u.look = { t: 0, dur: rand(1.6, 2.6), angle: rand(0.35, 0.6) * (Math.random() < 0.5 ? -1 : 1) };
            return;
        }
        const names = u.isSkeleton ? [pick(['Idle_B', 'Taunt', 'Idle_B'])] : [pick(['Interact', '2H_Melee_Idle'])];
        if (!findClip(names, u)) return;
        const a = play(u, names, { fade: 0.35, fidget: true });
        if (a) { u.fidget = a; fidgeting++; }
    }

    // ===========================================================================================
    // UnitsAPI

    function syncBoard(board) {
        cancelHint();
        cancelGestures();
        R.abortAll();
        stopTrails();
        finalizers.length = 0;
        camRestore(0.3);
        for (const u of [...units]) if (u.dying) disposeUnit(u);
        const old = [];
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { if (grid[r][c]) old.push(grid[r][c]); grid[r][c] = null; }
        for (const u of units) if (!old.includes(u)) old.push(u);
        const wanted = [];
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
            const p = board?.[r]?.[c];
            if (!p) continue;
            wanted.push({ r, c, color: p === p.toUpperCase() ? 'w' : 'b', type: p.toLowerCase() });
        }
        const free = new Set(old);
        const assign = (w, u) => { free.delete(u); grid[w.r][w.c] = u; resetUnit(u, { row: w.r, col: w.c }); };
        const rest = [];
        for (const w of wanted) {   // first keep units already standing on their square
            const u = old.find(o => free.has(o) && o.square.row === w.r && o.square.col === w.c && o.color === w.color && o.type === w.type);
            if (u) assign(w, u); else rest.push(w);
        }
        for (const w of rest) {
            const u = [...free].find(o => o.color === w.color && o.type === w.type);
            if (u) assign(w, u);
            else grid[w.r][w.c] = createUnit(w.color, w.type, { row: w.r, col: w.c });
        }
        for (const u of free) disposeUnit(u);
        syncTokens();
        S.requestRender?.();
    }

    function resetUnit(u, sq) {
        u.dead = false;
        u.dying = false;
        u.look = null;
        u.nod = null;
        clearPin(u);
        if (u.horse) {
            u.horse.dead = false;
            u.horse.key = null;
            u.horse.mixer.stopAllAction();
            u.horse.current = null;
            u.horse.last.set(sqPos(sq).x, 0, sqPos(sq).z);
            horseSet(u, 'idle', 1, true);
            u.horse.seat = null;
        }
        for (const b of u.base) b.scale.setScalar(1);
        restoreMaterials(u);
        if (u.mixer) { u.mixer.timeScale = 1; u.mixer.stopAllAction(); u.current = null; }
        if (u.fidget) { u.fidget = null; fidgeting--; }
        setLabel(u, labelsOn);
        placeAt(u, sq);
        idle(u, 0);
    }

    // Hint: the hinted unit hops and raises its weapon once, with a soft 'select'. Cancelled by any
    // move, syncBoard or skip; cancelling puts the unit back on the ground in its idle.
    let hintUnit = null;
    function cancelHint() {
        const u = hintUnit;
        hintUnit = null;
        H.abortAll();
        if (u && units.has(u) && !u.dying) {
            u.root.position.y = 0;
            if (!R.busy) idle(u, 0.15);
        }
    }

    function playHint(square) {
        cancelHint();
        const u = square ? unitAtSq(square) : null;
        if (!u || R.busy || u.dead) return Promise.resolve();
        hintUnit = u;
        const gesture = function* () {
            sfxAt('select', u, { volume: 0.6 });
            const a = play(u, u.isSkeleton ? ['Block', 'Taunt', 'Blocking'] : ['Block', 'Blocking', 'Cheer'], { speed: 1.6, fade: 0.08 });
            const y0 = 0;
            yield* tween(0.3, k => { u.root.position.y = y0 + 0.12 * 4 * k * (1 - k); });
            u.root.position.y = 0;
            if (a) yield untilClip(u, a, Math.min(0.45, a.getClip().duration * 0.5));
            idle(u, 0.25);
        };
        return new Promise(res => {
            H.spawn(gesture(), () => { if (hintUnit === u) hintUnit = null; res(); });
            S.requestRender?.();
            syncTokens();
        });
    }

    // King gestures for the commentary: short, interruptible, never during the unit's own animation.
    const GESTURES = {
        talk: { clips: null, dur: 1.6, amp: 0.1, freq: 2.6 },
        taunt: { clips: ['Taunt', 'Cheer', 'Interact'], dur: 1.2, amp: 0.08, freq: 1.5 },
        cheer: { clips: ['Cheer'], dur: 1.3, amp: 0.06, freq: 1.2 },
        shrug: { clips: ['Interact', 'Idle'], dur: 1.1, amp: 0.05, freq: 1 },
        facepalm: { clips: ['Use_Item', 'Interact'], dur: 1.2, amp: 0.35, freq: 1 }
    };
    const gestureUnits = new Set();
    function cancelGesture(u) {
        if (!gestureUnits.has(u)) return;
        const clip = u.gestureClip;
        gestureUnits.delete(u);
        G.cancel(u.gestureTask);
        u.gestureTask = null;
        u.nod = null;
        u.gestureClip = null;
        if (units.has(u) && !u.dying && !u.dead && clip && u.current === clip) idle(u, 0.2);
    }

    function cancelGestures() {
        // Capture the clips first: aborting runs the tasks' onDone, which clears gestureClip.
        const list = [...gestureUnits].map(u => [u, u.gestureClip]);
        gestureUnits.clear();
        G.abortAll();
        for (const [u, clip] of list) {
            u.nod = null;
            u.gestureClip = null;
            if (units.has(u) && !u.dying && !u.dead && clip && u.current === clip) idle(u, 0.2);
        }
    }

    function playGesture(square, kind = 'talk') {
        const g = GESTURES[kind] || GESTURES.talk;
        const u = square ? unitAtSq(square) : null;
        if (!u || u.dying || u.dead) return Promise.resolve();
        // A new gesture on the same unit replaces the old one; the other king keeps going.
        cancelGesture(u);
        // The nod is applied after the mixer each frame, so only units with a mixer and a head get one.
        u.nod = u.mixer && u.bones.head ? { kind, t: 0, dur: g.dur, amp: g.amp, freq: g.freq } : null;
        gestureUnits.add(u);
        const seq = function* () {
            // Clips only while the unit is idle; during a move the head nod alone carries the line.
            const a = g.clips && !R.busy && u !== hintUnit ? play(u, g.clips, { speed: 1.1, fade: 0.2 }) : null;
            u.gestureClip = a;
            if (a) yield untilClip(u, a, Math.min(a.getClip().duration * 0.95, g.dur));
            else yield g.dur;
            if (a && u.current === a && !R.busy) idle(u, 0.3);
            // Resolve only once the head nod has settled too, so nothing is left running.
            if (u.nod) yield () => !u.nod || !units.has(u);
        };
        return new Promise(res => {
            let task = null;
            task = G.spawn(seq(), () => {
                if (!task || u.gestureTask === task) { gestureUnits.delete(u); u.gestureClip = null; u.gestureTask = null; }
                res();
            });
            if (!task.done) u.gestureTask = task;
            S.requestRender?.();
            syncTokens();
        });
    }

    function playMove(ev) {
        cancelHint();
        cancelGestures();
        if (R.busy) fastForward();
        const color = ev.color;
        const type = String(ev.piece).toLowerCase();
        let A = unitAtSq(ev.from);
        if (!A) {
            log('no unit on from square, creating one', ev.from);
            A = createUnit(color, type, ev.from);
        }
        const V = ev.captured ? unitAtSq(ev.captured.square) : null;
        const Rk = ev.castling ? unitAtSq(ev.castling.rookFrom) : null;

        // Logical state first: the grid always reflects the position after the move.
        grid[ev.from.row][ev.from.col] = null;
        if (ev.captured) grid[ev.captured.square.row][ev.captured.square.col] = null;
        if (Rk) {
            grid[ev.castling.rookFrom.row][ev.castling.rookFrom.col] = null;
            grid[ev.castling.rookTo.row][ev.castling.rookTo.col] = Rk;
            Rk.square = { ...ev.castling.rookTo };
        }
        grid[ev.to.row][ev.to.col] = A;
        A.square = { ...ev.to };

        let promoted = null;
        const swap = () => {
            if (promoted || !ev.promotion) return promoted;
            if (grid[ev.to.row][ev.to.col] !== A) return null;
            disposeUnit(A);
            promoted = createUnit(color, ev.promotion.toLowerCase(), ev.to);
            grid[ev.to.row][ev.to.col] = promoted;
            return promoted;
        };
        if (ev.promotion) finalizers.push(swap);

        const seq = function* () {
            if (V) yield* captureSeq(ev, A, V);
            else if (Rk) yield* castleSeq(ev, A, Rk);
            else yield* moveSeq(ev, A);
            if (ev.promotion) yield* promoteSeq(A, swap);
            const i = finalizers.indexOf(swap);
            if (i >= 0) finalizers.splice(i, 1);
        };
        return run(seq());
    }

    function playCheck(kingSquare) {
        cancelHint();
        cancelGestures();
        const K = unitAtSq(kingSquare);
        if (!K) return Promise.resolve();
        if (R.busy) fastForward();
        return run((function* () {
            burst(chestPos(K), 'spark', { count: 6, color: 0xff4040 });
            yield* playOnce(K, mode === 'full' ? ['Hit_B', 'Block'] : ['Block', 'Hit_B'], { speed: 1.2 * speedMul(), fade: 0.1 });
            idle(K, 0.25);
        })());
    }

    function playGameOver({ result, loser, kingSquare } = {}) {
        cancelHint();
        cancelGestures();
        if (R.busy) fastForward();
        const all = [...units].filter(u => !u.dying);
        return run((function* () {
            if (result === 'checkmate' && loser) {
                const K = unitAtSq(kingSquare) || all.find(u => u.color === loser && u.type === 'k');
                const winners = all.filter(u => u.color !== loser);
                const dieKing = function* () {
                    if (!K) return;
                    burst(chestPos(K), 'spark', { count: 16 });
                    shake(0.8);
                    yield* playOnce(K, 'Hit_B', { speed: 1.2, until: 0.4 });
                    startPin(K);
                    play(K, K.isSkeleton ? ['Death_C_Skeletons', 'Death_A'] : ['Death_A', 'Death_B'], { fade: 0.1 });
                    later(0.5, () => sfxAt('fall', K, { volume: 0.9 * sizeOf(K) }));
                    later(0.9, () => sfxAt('death', K, { volume: 0.6 }));
                    K.dead = true;
                    yield 1.2;
                };
                const cheer = function* (u, delay) {
                    yield delay;
                    const names = anim(u, 'cheer', ['Cheer', 'Spellcast_Raise']);
                    const clip = findClip(names, u);
                    const reps = clip && clip.duration > 2 ? 1 : 2;
                    for (let i = 0; i < reps; i++) yield* playOnce(u, names, { speed: rand(0.9, 1.1) });
                    idle(u, 0.3);
                };
                later(0.6, () => sfx('victory', { pos: winners.length ? winners[0].root.position.clone() : null }));
                yield [dieKing(), ...winners.map((u, i) => cheer(u, 0.5 + i * 0.06 + rand(0, 0.2)))];
            } else {
                const kings = all.filter(u => u.type === 'k');
                yield kings.map(k => (function* () {
                    yield* playOnce(k, ['Interact', 'Idle'], { speed: 0.9 });
                    idle(k, 0.3);
                })());
            }
        })());
    }

    function skip() {
        cancelHint();
        cancelGestures();
        if (R.busy) fastForward();
        stopTrails();
        cam.close(0);
        for (const f of [S.skipEffects, S.fx?.skip]) if (typeof f === 'function') try { f(); } catch (e) { /* ignore */ }
        syncTokens();
        S.requestRender?.();
    }

    // Swaps the cast (roles table shaped like manifest.roles) and rebuilds every unit in place.
    async function setCast(roles) {
        if (!roles) return;
        skip();
        await loadAssets(roles);
        manifest.roles = roles;
        const board = grid.map(row => row.map(u => (u ? (u.color === 'w' ? u.type.toUpperCase() : u.type) : null)));
        for (const u of [...units]) disposeUnit(u);
        for (const row of grid) row.fill(null);
        syncBoard(board);
    }

    function getLegend() {
        const out = [];
        for (const color of ['w', 'b']) for (const type of 'pnbrqk') {
            const r = roleFor(color, type);
            const file = /^blob:/.test(r.model || '') ? '' : String(r.model || '').split('/').pop().replace(/\.(glb|gltf)$/i, '').replace(/_/g, ' ');
            out.push({ color, type, role: r.label || DEFAULT_NAMES[type], name: r.name || file || (r.model ? 'Imported model' : DEFAULT_NAMES[type]), model: file || null, glyph: r.glyph || GLYPHS[color][type] });
        }
        return out;
    }

    function setLabels(on) {
        labelsOn = !!on;
        for (const u of units) setLabel(u, labelsOn && !u.dying);
    }

    function setMode(m) { mode = m === 'fast' ? 'fast' : 'full'; }

    return {
        syncBoard,
        unitAt: (row, col) => grid[row]?.[col] ?? null,
        playMove,
        playCheck,
        playGameOver,
        setMode,
        getMode: () => mode,
        skip,
        isBusy: () => R.busy,
        setLabels,
        setFightCamera: on => { fightCamera = !!on; },   // extra: controller turns close-ups off in AI vs AI
        setCast,
        getLegend,
        playHint,
        playGesture,
        lastFightPlan: () => kit.lastPlan,
        // debug
        _clips: clips,
        _clipStats: clipStats,
        _units: units
    };
}
