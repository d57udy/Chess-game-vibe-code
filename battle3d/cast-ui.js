// Cast editor panel: preset picker, per-role model / weapons / gear / size / colour, live 3D preview,
// "Who's who" legend, custom .glb import. Mounted by main.js inside the cast modal.
//   mountCastEditor(containerEl, { manifest, cast, onApply(cast), assetBase }) -> { destroy(), getCast() }

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
    PRESETS, TYPES, TYPE_NAMES, COLOR_NAMES, GLYPHS, ACCESSORIES, TYPE_ACCESSORIES,
    presetCast, normalizeCast, cloneCast, resolveRole, resolveRoles, legendFor,
    listModels, listLoadouts, gearOptions, modelInfo, importCustomModel, restoreCustomModels
} from './cast.js';
import { decorateUnit } from './unit-visuals.js';

const DEFAULT_BASE = new URL('./assets/', import.meta.url).href;
const ORDER = ['k', 'q', 'r', 'b', 'n', 'p'];

function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k === 'text') e.textContent = v;
        else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) e.append(c);
    return e;
}

const hueCss = (h, l = 50) => `hsl(${h}, 65%, ${l}%)`;

export function mountCastEditor(container, { manifest, cast, onApply, assetBase = DEFAULT_BASE } = {}) {
    let state = normalizeCast(cast || presetCast());
    let sel = { color: 'w', type: 'k' };
    let destroyed = false;
    const preview = createPreview(manifest, assetBase);

    const root = el('div', { class: 'ce' });
    container.append(root);

    // --- header: presets + actions ---
    const presetSelect = el('select', { class: 'ce-select', 'aria-label': 'Preset', onchange: () => {
        if (presetSelect.value === 'custom') return;
        state = presetCast(presetSelect.value);
        renderAll();
    } });
    const presetDesc = el('p', { class: 'ce-desc' });
    const fileInput = el('input', { type: 'file', accept: '.glb,.gltf,model/gltf-binary', hidden: true, onchange: onImport });
    const status = el('div', { class: 'ce-status', role: 'status', 'aria-live': 'polite' });
    const head = el('div', { class: 'ce-head' },
        el('label', { class: 'ce-field ce-preset' }, el('span', { text: 'Preset' }), presetSelect),
        el('div', { class: 'ce-actions' },
            el('button', { type: 'button', class: 'btn ce-btn', onclick: () => fileInput.click(), title: 'Load your own .glb character (KayKit rig for animations)' }, 'Import model...'),
            el('button', { type: 'button', class: 'btn ce-btn', onclick: () => { state = presetCast(state.preset in PRESETS ? state.preset : 'classic'); renderAll(); }, title: 'Undo your changes to this preset' }, 'Reset'),
            el('button', { type: 'button', class: 'btn ce-btn ce-primary', onclick: () => onApply?.(normalizeCast(state)) }, 'Apply')
        ),
        fileInput
    );

    // --- left: role cards ---
    const roleList = el('div', { class: 'ce-roles', role: 'listbox', 'aria-label': 'Pieces' });

    // --- right: editor ---
    const previewBox = el('div', { class: 'ce-preview' }, preview.canvas,
        el('div', { class: 'ce-preview-bar' },
            el('button', { type: 'button', class: 'ce-chip', onclick: () => preview.play('attack') }, 'Attack'),
            el('button', { type: 'button', class: 'ce-chip', onclick: () => preview.play('walk') }, 'Walk'),
            el('button', { type: 'button', class: 'ce-chip', onclick: () => preview.play('hit') }, 'Hit'),
            el('button', { type: 'button', class: 'ce-chip', onclick: () => preview.play('cheer') }, 'Cheer')));
    const title = el('h3', { class: 'ce-title' });
    const form = el('div', { class: 'ce-form' });
    const warn = el('div', { class: 'ce-warn', hidden: true });
    const editor = el('div', { class: 'ce-editor' }, el('div', { class: 'ce-top' }, previewBox, el('div', { class: 'ce-top-text' }, title, warn, status)), form);

    // --- bottom: legend ---
    const legend = el('table', { class: 'ce-legend' });

    root.append(head, presetDesc, el('div', { class: 'ce-body' }, roleList, editor),
        el('h3', { class: 'ce-subtitle', text: "Who's who" }), legend,
        el('p', { class: 'ce-note', text: 'Custom models animate only with the KayKit humanoid rig (same bone names as the bundled characters). Other models stand in a static pose. Imported files stay in this browser only.' }));

    function role() { return state.roles[sel.color][sel.type]; }
    function edit(fn) {
        fn(role());
        if (state.preset !== 'custom') { state.preset = 'custom'; state.name = 'Custom'; }
        renderAll();
    }

    function renderPresets() {
        presetSelect.textContent = '';
        for (const [id, p] of Object.entries(PRESETS)) presetSelect.append(el('option', { value: id, text: p.name }));
        presetSelect.append(el('option', { value: 'custom', text: 'Custom', disabled: state.preset !== 'custom' }));
        presetSelect.value = state.preset in PRESETS ? state.preset : 'custom';
        presetDesc.textContent = PRESETS[state.preset]?.description || 'Your own cast. Apply saves it in this browser.';
    }

    function renderRoles() {
        roleList.textContent = '';
        const resolved = resolveRoles(manifest, state);
        for (const color of ['w', 'b']) {
            roleList.append(el('div', { class: `ce-side ce-side-${color}`, text: COLOR_NAMES[color] }));
            for (const type of ORDER) {
                const r = resolved[color][type];
                const active = sel.color === color && sel.type === type;
                roleList.append(el('button', {
                    type: 'button', role: 'option', 'aria-selected': active ? 'true' : 'false',
                    class: `ce-role ce-role-${color}${active ? ' is-active' : ''}`,
                    onclick: () => { sel = { color, type }; renderAll(); }
                }, el('span', { class: 'ce-glyph', text: GLYPHS[color][type] }),
                el('span', { class: 'ce-role-text' }, el('b', { text: TYPE_NAMES[type] }), el('small', { text: r.name }))));
            }
        }
    }

    function field(label, control, hint, wide = false) {
        return el('label', { class: wide ? 'ce-field ce-wide' : 'ce-field' }, el('span', { text: label }), control, hint ? el('small', { class: 'ce-hint', text: hint }) : null);
    }

    function renderForm() {
        const r = role();
        const resolved = resolveRole(manifest, sel.color, sel.type, r);
        title.textContent = `${COLOR_NAMES[sel.color]} ${TYPE_NAMES[sel.type]} ${GLYPHS[sel.color][sel.type]}`;
        form.textContent = '';

        // Model
        const models = listModels(manifest);
        const modelSel = el('select', { class: 'ce-select', onchange: () => edit(x => {
            x.model = modelSel.value;
            const info = modelInfo(manifest, x.model);
            delete x.gear;
            if (info?.defaultLoadout) x.loadout = info.defaultLoadout;
            if (x.recolor && !info?.cloth) delete x.recolor;
        }) });
        for (const [army, label] of [['heroes', 'Heroes'], ['skeletons', 'Skeletons'], ['custom', 'Imported']]) {
            const group = models.filter(m => m.army === army);
            if (!group.length) continue;
            modelSel.append(el('optgroup', { label }, group.map(m => el('option', { value: m.id, text: m.label }))));
        }
        modelSel.value = resolved.modelId;
        form.append(field('Character', modelSel));

        // Weapons
        const loadSel = el('select', { class: 'ce-select', onchange: () => edit(x => { x.loadout = loadSel.value; }) });
        const loads = listLoadouts(manifest);
        for (const [army, label] of [['heroes', 'Hero weapons'], ['skeletons', 'Skeleton weapons'], ['any', 'Other']]) {
            const group = loads.filter(l => l.army === army);
            if (group.length) loadSel.append(el('optgroup', { label }, group.map(l => el('option', { value: l.id, text: l.label }))));
        }
        loadSel.value = resolved.loadout;
        form.append(field('Weapons', loadSel, resolved.ranged ? 'Ranged: attacks with a magic bolt.' : null));

        // Gear
        const gear = gearOptions(manifest, resolved.modelId);
        if (gear.length) {
            const shown = new Set(resolved.show);
            form.append(el('fieldset', { class: 'ce-checks' }, el('legend', { text: 'Gear' }),
                gear.map(name => el('label', { class: 'ce-check' },
                    el('input', { type: 'checkbox', checked: shown.has(name), onchange: e => edit(x => {
                        const cur = new Set(Array.isArray(x.gear) ? x.gear : modelInfo(manifest, resolved.modelId)?.defaultGear || []);
                        e.target.checked ? cur.add(name) : cur.delete(name);
                        x.gear = [...cur];
                    }) }),
                    el('span', { text: name.replace(/^(Skeleton_)?[A-Za-z]+?_/, '').replace(/_/g, ' ') })))));
        }

        // Extras (procedural accessories)
        const extras = new Set(resolved.accessories);
        form.append(el('fieldset', { class: 'ce-checks' }, el('legend', { text: 'Role marks' }),
            Object.entries(ACCESSORIES).map(([id, label]) => el('label', { class: 'ce-check' },
                el('input', { type: 'checkbox', checked: extras.has(id), onchange: e => edit(x => {
                    const cur = new Set(Array.isArray(x.accessories) ? x.accessories : TYPE_ACCESSORIES[sel.type]);
                    e.target.checked ? cur.add(id) : cur.delete(id);
                    x.accessories = [...cur];
                }) }), el('span', { text: label }))),
            Array.isArray(r.accessories) ? el('button', { type: 'button', class: 'ce-link', onclick: () => edit(x => { delete x.accessories; }) }, 'Default marks') : null));

        // Size
        const scale = r.scale ?? 1;
        const sizeOut = el('output', { text: `${Math.round(scale * 100)}%` });
        const size = el('input', { type: 'range', min: '0.75', max: '1.35', step: '0.05', value: String(scale),
            oninput: () => { sizeOut.textContent = `${Math.round(size.value * 100)}%`; },
            onchange: () => edit(x => { x.scale = +size.value; if (Math.abs(x.scale - 1) < 1e-3) delete x.scale; }) });
        form.append(field('Size', el('div', { class: 'ce-row' }, size, sizeOut)));

        // Cloth colour
        const info = modelInfo(manifest, resolved.modelId);
        if (info?.cloth) {
            const on = !!r.recolor;
            const hue = r.recolor?.to ?? (sel.color === 'w' ? 215 : 18);
            const swatch = el('span', { class: 'ce-swatch', style: `background:${hueCss(hue)}` });
            const hueIn = el('input', { type: 'range', class: 'ce-hue', min: '0', max: '359', step: '1', value: String(hue), disabled: !on,
                oninput: () => { swatch.style.background = hueCss(hueIn.value); },
                onchange: () => edit(x => { x.recolor = { ...(x.recolor || {}), to: +hueIn.value }; }) });
            const toggle = el('input', { type: 'checkbox', checked: on, onchange: e => edit(x => {
                if (e.target.checked) x.recolor = { to: +hueIn.value }; else delete x.recolor;
            }) });
            form.append(field('Cloth colour', el('div', { class: 'ce-row' }, el('label', { class: 'ce-check' }, toggle, el('span', { text: 'Recolour' })), hueIn, swatch), null, true));
        }

        // Tint
        const tintIn = el('input', { type: 'color', value: r.tint || '#ffffff', onchange: () => edit(x => { x.tint = tintIn.value.toLowerCase() === '#ffffff' ? undefined : tintIn.value; if (!x.tint) delete x.tint; }) });
        form.append(field('Tint', el('div', { class: 'ce-row' }, tintIn,
            r.tint ? el('button', { type: 'button', class: 'ce-link', onclick: () => edit(x => { delete x.tint; }) }, 'Clear') : el('small', { class: 'ce-hint', text: 'Multiplies every colour of the model.' }))));

        // Copy helpers
        const other = sel.color === 'w' ? 'b' : 'w';
        form.append(el('div', { class: 'ce-row ce-copy' },
            el('button', { type: 'button', class: 'ce-link', onclick: () => edit(() => { state.roles[other][sel.type] = cloneCast(role()); }) }, `Copy to ${COLOR_NAMES[other]} ${TYPE_NAMES[sel.type]}`)));

        // Warnings for custom models
        const custom = resolved.army === 'custom' ? modelInfo(manifest, resolved.modelId) : null;
        warn.hidden = !(custom && custom.problems?.length);
        warn.textContent = custom?.problems?.join(' ') || '';

        preview.show(resolved, sel.color, sel.type);
    }

    function renderLegend() {
        const rows = legendFor(resolveRoles(manifest, state));
        legend.textContent = '';
        legend.append(el('thead', {}, el('tr', {}, el('th', { text: 'Piece' }), el('th', { text: 'White' }), el('th', { text: 'Black' }))));
        const body = el('tbody');
        for (const type of ORDER) {
            const w = rows.find(x => x.color === 'w' && x.type === type);
            const b = rows.find(x => x.color === 'b' && x.type === type);
            body.append(el('tr', {},
                el('td', {}, el('span', { class: 'ce-glyph-sm', text: GLYPHS.w[type] + ' ' + GLYPHS.b[type] }), ' ', TYPE_NAMES[type]),
                el('td', { text: w.model }), el('td', { text: b.model })));
        }
        legend.append(body);
    }

    function renderAll() {
        if (destroyed) return;
        renderPresets();
        renderRoles();
        renderForm();
        renderLegend();
    }

    async function onImport() {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        status.textContent = `Reading ${file.name}...`;
        const res = await importCustomModel(file, THREE, GLTFLoader, { meshoptDecoder: MeshoptDecoder });
        if (!res.ok) { status.textContent = `Could not use ${file.name}: ${res.problems.join(' ')}`; return; }
        status.textContent = res.animated ? `${res.name} imported (KayKit rig found, fully animated).` : `${res.name} imported with warnings.`;
        edit(x => { x.model = res.id; delete x.gear; delete x.recolor; });
    }

    restoreCustomModels().then(() => { if (!destroyed) renderAll(); });
    renderAll();

    return {
        getCast: () => normalizeCast(state),
        destroy() { destroyed = true; preview.dispose(); root.remove(); }
    };
}

// --- live preview -------------------------------------------------------------------------------

function createPreview(manifest, assetBase) {
    const canvas = document.createElement('canvas');
    canvas.className = 'ce-canvas';
    canvas.width = 220; canvas.height = 240;
    let renderer = null;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        renderer.setSize(220, 240, false);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
    } catch (e) { renderer = null; }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 220 / 240, 0.1, 50);
    camera.position.set(1.15, 1.25, 2.3);
    camera.lookAt(0, 0.5, 0);
    scene.add(new THREE.HemisphereLight(0xe8eeff, 0x3a3226, 1.5));
    const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
    key.position.set(2, 3, 2.5);
    scene.add(key);
    const turntable = new THREE.Group();
    scene.add(turntable);

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const cache = new Map();
    const load = url => {
        const abs = new URL(url, assetBase).href;
        if (!cache.has(abs)) cache.set(abs, loader.loadAsync(abs));
        return cache.get(abs);
    };
    const clips = new Map();
    const clipsReady = Promise.all([manifest.clips?.file, manifest.clips?.skeletonFile].filter(Boolean).map(f =>
        load(f).then(g => { for (const a of g.animations) if (!clips.has(a.name)) clips.set(a.name, a); }).catch(() => { })));

    let unit = null, mixer = null, current = null, roleNow = null, token = 0, raf = 0, last = 0, angle = -0.5;
    const byName = (o, n) => o.getObjectByName(n) || o.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n));

    function clear() {
        if (!unit) return;
        unit.visuals?.dispose();
        turntable.remove(unit.root);
        mixer?.stopAllAction();
        unit = null; mixer = null; current = null;
    }

    async function show(role, color, type) {
        const my = ++token;
        roleNow = role;
        let gltf;
        try { gltf = await load(role.model); } catch (e) { if (my === token) clear(); return; }
        const props = await Promise.all(role.props.map(p => load(p.file).catch(() => null)));
        await clipsReady;
        if (my !== token || !renderer) return;
        clear();
        const model = SkeletonUtils.clone(gltf.scene);
        model.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
        for (const n of role.hide || []) { const o = byName(model, n); if (o) o.visible = false; }
        for (const n of role.show || []) { const o = byName(model, n); if (o) o.visible = true; }
        role.props.forEach((p, i) => {
            const bone = byName(model, p.bone);
            if (!props[i] || !bone) return;
            const obj = props[i].scene.clone(true);
            obj.position.fromArray(p.position || [0, 0, 0]);
            if (p.quaternion) obj.quaternion.fromArray(p.quaternion);
            bone.add(obj);
        });
        model.scale.setScalar(role.scale);
        model.position.y = 0.04;
        const root = new THREE.Group();
        root.add(model);
        unit = { root, model, bones: { head: byName(model, 'head'), chest: byName(model, 'chest'), handR: byName(model, 'handslot.r'), handL: byName(model, 'handslot.l') } };
        turntable.add(root);
        decorateUnit(unit, { THREE, color, type, role, labels: false });
        // Frame tall pieces (rook banners) a little further away.
        const box = new THREE.Box3().setFromObject(root);
        const h = Math.max(1, box.max.y);
        camera.position.set(0.75 * h, 0.35 + 0.55 * h, 1.65 * h);
        camera.lookAt(0, 0.44 * h, 0);
        if (!role.static) { mixer = new THREE.AnimationMixer(model); play('idle'); }
        start();
    }

    function play(kind) {
        if (!mixer || !roleNow) return;
        const a = roleNow.anims || {};
        const pickOne = v => Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v;
        const name = kind === 'attack' ? pickOne(a.attack) : kind === 'hit' ? pickOne(a.hit) : a[kind];
        const clip = clips.get(name) || clips.get(a.idle) || clips.get('Idle');
        if (!clip) return;
        const action = mixer.clipAction(clip);
        action.reset();
        if (kind === 'idle' || kind === 'walk') action.setLoop(THREE.LoopRepeat, Infinity);
        else { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
        action.fadeIn(0.15).play();
        if (current && current !== action) current.fadeOut(0.15);
        current = action;
        if (kind !== 'idle' && kind !== 'walk') {
            const back = () => { mixer?.removeEventListener('finished', back); if (current === action) play('idle'); };
            mixer.addEventListener('finished', back);
        }
    }

    function frame(t) {
        raf = 0;
        if (!renderer || !canvas.isConnected) { last = 0; return; }
        const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
        last = t;
        angle += dt * 0.35;
        turntable.rotation.y = Math.sin(angle) * 0.6 - 0.15;
        mixer?.update(dt);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
    }
    function start() { if (!raf && renderer) raf = requestAnimationFrame(frame); }

    return {
        canvas,
        show,
        play,
        dispose() {
            token++;
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
            clear();
            renderer?.dispose();
            renderer?.forceContextLoss?.();
            renderer = null;
        }
    };
}
