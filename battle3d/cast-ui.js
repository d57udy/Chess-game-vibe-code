// Cast editor panel: preset picker, per-role character from a model library (Built-in / More packs /
// Import your own), weapons / gear / mount / size / colour, live 3D preview, "Who's who" legend.
// Mounted by main.js inside the cast modal.
//   mountCastEditor(containerEl, { manifest, cast, onApply(cast), assetBase }) -> { destroy(), getCast() }
// onApply receives a normalized cast whose packs are already loaded (prepareCast has run).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
    PRESETS, TYPE_NAMES, COLOR_NAMES, GLYPHS, ACCESSORIES, TYPE_ACCESSORIES, IMPORT_BUDGET,
    presetCast, normalizeCast, cloneCast, resolveRole, resolveRoles, legendFor, creditsFor,
    listModels, listLoadouts, listPacks, listMounts, gearOptions, modelInfo, modelSource,
    importCustomModel, restoreCustomModels, removeCustomModel, loadLibraryIndex, loadPack, prepareCast, isPackLoaded,
    isCustomUsable, setCustomConsent
} from './cast.js';
import { decorateUnit } from './unit-visuals.js';

const DEFAULT_BASE = new URL('./assets/', import.meta.url).href;
const ORDER = ['k', 'q', 'r', 'b', 'n', 'p'];
const FACINGS = [['+z', 'Forward (+Z)'], ['-z', 'Backward (-Z)'], ['+x', 'Right (+X)'], ['-x', 'Left (-X)']];
const KIND_LABELS = { all: 'All', humanoid: 'People', creature: 'Monsters', animal: 'Animals' };

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
const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

export function mountCastEditor(container, { manifest, cast, onApply, assetBase = DEFAULT_BASE } = {}) {
    let state = normalizeCast(cast || presetCast());
    let sel = { color: 'w', type: 'k' };
    let destroyed = false;
    let lib = { tab: 'builtin', search: '', kind: 'all', pack: 'all' };
    const busyPacks = new Set();
    const preview = createPreview(manifest, assetBase);
    const asset = p => (/^(blob:|data:|https?:)/.test(p) ? p : new URL(p, assetBase).href);

    const root = el('div', { class: 'ce' });
    container.append(root);

    // --- header: presets + actions ---
    const presetSelect = el('select', { class: 'ce-select', 'aria-label': 'Preset', onchange: () => {
        if (presetSelect.value === 'custom') return;
        state = presetCast(presetSelect.value);
        ensurePacks().then(renderAll);
    } });
    const presetDesc = el('p', { class: 'ce-desc' });
    const status = el('div', { class: 'ce-status', role: 'status', 'aria-live': 'polite' });
    const applyBtn = el('button', { type: 'button', class: 'btn ce-btn ce-primary', onclick: apply }, 'Apply');
    const head = el('div', { class: 'ce-head' },
        el('label', { class: 'ce-field ce-preset' }, el('span', { text: 'Preset' }), presetSelect),
        el('div', { class: 'ce-actions' },
            el('button', { type: 'button', class: 'btn ce-btn', onclick: () => { state = presetCast(state.preset in PRESETS ? state.preset : 'classic'); ensurePacks().then(renderAll); }, title: 'Undo your changes to this preset' }, 'Reset'),
            applyBtn));

    // --- left: role cards ---
    const roleList = el('div', { class: 'ce-roles', role: 'listbox', 'aria-label': 'Pieces' });

    // --- right: editor ---
    const previewBox = el('div', { class: 'ce-preview' }, preview.canvas,
        el('div', { class: 'ce-preview-bar' },
            ['attack', 'walk', 'hit', 'cheer'].map(k => el('button', { type: 'button', class: 'ce-chip', onclick: () => preview.play(k) }, k[0].toUpperCase() + k.slice(1)))));
    const title = el('h3', { class: 'ce-title' });
    const sub = el('p', { class: 'ce-subline' });
    const warn = el('div', { class: 'ce-warn', hidden: true });
    const form = el('div', { class: 'ce-form' });
    const library = el('section', { class: 'ce-lib', 'aria-label': 'Character library' });
    const editor = el('div', { class: 'ce-editor' },
        el('div', { class: 'ce-top' }, previewBox, el('div', { class: 'ce-top-text' }, title, sub, warn, status)),
        library, form);

    // --- bottom: legend + credits ---
    const legend = el('table', { class: 'ce-legend' });
    const credits = el('p', { class: 'ce-note' });

    root.append(head, presetDesc, el('div', { class: 'ce-body' }, roleList, editor),
        el('h3', { class: 'ce-subtitle', text: "Who's who" }), legend, credits,
        el('p', { class: 'ce-note', text: 'Built-in characters and library packs are CC0 (see CREDITS.md). Imported models stay in this browser only. Models with the KayKit rig animate fully; other humanoid rigs are retargeted when possible; anything else stands in a static pose but still plays.' }));

    function role() { return state.roles[sel.color][sel.type]; }
    function edit(fn) {
        fn(role());
        if (state.preset !== 'custom') { state.preset = 'custom'; state.name = 'Custom'; }
        renderAll();
    }

    async function ensurePacks() {
        try {
            const { failed } = await prepareCast(state, { assetBase });
            status.textContent = failed.length ? `Could not download: ${failed.map(f => f.id).join(', ')}. Those pieces use the default characters.` : '';
        } catch (e) { status.textContent = `Library unavailable: ${e.message || e}`; }
    }

    async function apply() {
        if (applyBtn.disabled) return;
        applyBtn.disabled = true;
        applyBtn.textContent = 'Loading...';
        try {
            await ensurePacks();
            if (!destroyed) await onApply?.(normalizeCast(state));
        } catch (e) {
            status.textContent = `Could not apply the cast: ${e.message || e}`;
        } finally {
            applyBtn.disabled = false;
            applyBtn.textContent = 'Apply';
        }
    }

    async function download(packId) {
        if (busyPacks.has(packId)) return;
        busyPacks.add(packId);
        renderLibrary();
        try { await loadPack(packId, assetBase); status.textContent = ''; }
        catch (e) { status.textContent = `Download failed: ${e.message || e}`; }
        busyPacks.delete(packId);
        if (!destroyed) renderAll();
    }

    function renderPresets() {
        presetSelect.textContent = '';
        for (const [id, p] of Object.entries(PRESETS)) presetSelect.append(el('option', { value: id, text: p.name }));
        presetSelect.append(el('option', { value: 'custom', text: 'Custom', disabled: state.preset !== 'custom' }));
        presetSelect.value = state.preset in PRESETS ? state.preset : 'custom';
        presetDesc.textContent = PRESETS[state.preset]?.description || 'Your own cast. Apply saves it in this browser.';
    }

    function renderRoles(resolved) {
        roleList.textContent = '';
        for (const color of ['w', 'b']) {
            roleList.append(el('div', { class: `ce-side ce-side-${color}`, text: COLOR_NAMES[color] }));
            for (const type of ORDER) {
                const r = resolved[color][type];
                const active = sel.color === color && sel.type === type;
                roleList.append(el('button', {
                    type: 'button', role: 'option', 'aria-selected': active ? 'true' : 'false',
                    class: `ce-role ce-role-${color}${active ? ' is-active' : ''}`,
                    onclick: () => {
                        sel = { color, type };
                        const src = modelSource(state.roles[color][type].model);
                        lib.tab = src === 'builtin' ? 'builtin' : src === 'pack' ? 'pack' : 'custom';
                        renderAll();
                    }
                }, el('span', { class: 'ce-glyph', text: GLYPHS[color][type] }),
                el('span', { class: 'ce-role-text' }, el('b', { text: TYPE_NAMES[type] }), el('small', { text: r.name + (r.mount ? ` on ${r.mount.name}` : '') }))));
            }
        }
    }

    function field(label, control, hint, wide = false) {
        return el('label', { class: wide ? 'ce-field ce-wide' : 'ce-field' }, el('span', { text: label }), control, hint ? el('small', { class: 'ce-hint', text: hint }) : null);
    }

    // --- library browser ---
    function card(m, current) {
        const thumb = m.thumb ? el('img', { src: asset(m.thumb), alt: '', loading: 'lazy', width: 72, height: 72 }) : el('span', { class: 'ce-card-noimg', text: m.source === 'custom' ? '3D' : '?' });
        const badges = [];
        if (m.native) badges.push('own moves');
        if (m.ranged) badges.push('ranged');
        if (m.mountable) badges.push('mount');
        if (m.source === 'custom') {
            const info = modelInfo(manifest, m.id);
            badges.push(m.rig === 'kaykit' ? 'animated' : m.rig === 'none' ? 'static' : m.rig);
            if (info?.license) badges.push(info.license.authors[0] ? `by ${info.license.authors[0]}` : (info.license.license || 'VRM'));
            if (info?.needsConsent && !info.consent) badges.push('needs permission');
        }
        return el('button', {
            type: 'button', class: `ce-card${current ? ' is-active' : ''}`, title: `Use ${m.label} for the ${COLOR_NAMES[sel.color]} ${TYPE_NAMES[sel.type]}`,
            'aria-pressed': current ? 'true' : 'false',
            onclick: () => {
                if (m.source === 'custom' && !isCustomUsable(m.id)) {
                    status.textContent = `${m.label}: its license restricts use in fights. Confirm you have permission below before using it.`;
                    return;
                }
                edit(x => {
                x.model = m.id;
                for (const k of ['gear', 'recolor', 'loadout', 'forward']) delete x[k];
                const info = modelInfo(manifest, m.id);
                if (m.source === 'builtin' && info?.defaultLoadout) x.loadout = info.defaultLoadout;
                if (m.source !== 'builtin') delete x.mount;
                });
            }
        }, thumb, el('span', { class: 'ce-card-name', text: m.label }), badges.length ? el('span', { class: 'ce-card-badges', text: badges.join(' · ') }) : null);
    }

    function filtered(list) {
        const q = lib.search.trim().toLowerCase();
        return list.filter(m => (lib.kind === 'all' || m.kind === lib.kind) &&
            (lib.pack === 'all' || m.packId === lib.pack) &&
            (!q || `${m.label} ${m.army} ${(m.tags || []).join(' ')} ${m.packId || ''}`.toLowerCase().includes(q)));
    }

    function renderLibrary() {
        library.textContent = '';
        const models = listModels(manifest);
        const current = role().model;
        const counts = { builtin: models.filter(m => m.source === 'builtin').length, pack: models.filter(m => m.source === 'pack').length, custom: models.filter(m => m.source === 'custom').length };
        const tab = (id, label) => el('button', { type: 'button', role: 'tab', class: `ce-tab${lib.tab === id ? ' is-active' : ''}`, 'aria-selected': lib.tab === id ? 'true' : 'false', onclick: () => { lib.tab = id; renderLibrary(); } }, label);
        library.append(el('div', { class: 'ce-lib-head' },
            el('span', { class: 'ce-lib-title', text: 'Character' }),
            el('div', { class: 'ce-tabs', role: 'tablist' },
                tab('builtin', `Built-in (${counts.builtin})`), tab('pack', 'More packs'), tab('custom', `Import your own${counts.custom ? ` (${counts.custom})` : ''}`))));

        if (lib.tab !== 'custom') {
            const search = el('input', { type: 'search', class: 'ce-search', placeholder: 'Search', value: lib.search, 'aria-label': 'Search characters',
                oninput: () => { lib.search = search.value; renderGrid(); } });
            const kinds = el('div', { class: 'ce-kinds' }, Object.entries(KIND_LABELS).map(([k, label]) =>
                el('button', { type: 'button', class: `ce-chip${lib.kind === k ? ' is-on' : ''}`, onclick: () => { lib.kind = k; renderLibrary(); } }, label)));
            library.append(el('div', { class: 'ce-filters' }, search, lib.tab === 'pack' ? kinds : null));
        }

        const grid = el('div', { class: 'ce-grid' });
        function renderGrid() {
            grid.textContent = '';
            const list = filtered(models.filter(m => m.source === lib.tab));
            for (const m of list) grid.append(card(m, m.id === current));
            if (!list.length && lib.tab !== 'pack') grid.append(el('p', { class: 'ce-hint', text: 'Nothing matches.' }));
        }

        if (lib.tab === 'pack') {
            const packList = el('div', { class: 'ce-packs' });
            const packs = listPacks();
            if (!packs.length) packList.append(el('p', { class: 'ce-hint', text: 'Loading the library...' }));
            for (const p of packs) {
                const busy = busyPacks.has(p.id);
                packList.append(el('div', { class: `ce-pack${lib.pack === p.id ? ' is-on' : ''}` },
                    el('img', { src: asset(p.thumb), alt: '', width: 48, height: 48, loading: 'lazy' }),
                    el('div', { class: 'ce-pack-text' },
                        el('b', { text: p.name }),
                        el('small', { text: `${p.models} models · ${mb(p.bytes)} · ${p.license} · by ${p.author}` }),
                        el('small', { class: 'ce-hint', text: p.description })),
                    p.loaded
                        ? el('button', { type: 'button', class: 'ce-chip', onclick: () => { lib.pack = lib.pack === p.id ? 'all' : p.id; renderLibrary(); } }, lib.pack === p.id ? 'Show all' : 'Show')
                        : el('button', { type: 'button', class: 'btn ce-btn', disabled: busy, onclick: () => download(p.id) }, busy ? 'Downloading...' : 'Download')));
            }
            library.append(packList);
        }

        if (lib.tab === 'custom') {
            const input = el('input', { type: 'file', accept: '.glb,.gltf,.vrm,.fbx,model/gltf-binary', hidden: true, onchange: () => { const f = input.files?.[0]; input.value = ''; if (f) importFile(f); } });
            const drop = el('div', { class: 'ce-drop', tabindex: '0', role: 'button', 'aria-label': 'Choose a .glb or .vrm file',
                onclick: () => input.click(), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
                ondragover: e => { e.preventDefault(); drop.classList.add('is-over'); }, ondragleave: () => drop.classList.remove('is-over'),
                ondrop: e => { e.preventDefault(); drop.classList.remove('is-over'); const f = e.dataTransfer?.files?.[0]; if (f) importFile(f); } },
                el('b', { text: 'Drop a .glb or .vrm here, or click to choose' }),
                el('small', { text: `Budget: up to ${IMPORT_BUDGET.trisWarn.toLocaleString()} triangles and ${IMPORT_BUDGET.textureWarn} px textures recommended. FBX must be converted first: Blender > File > Import > FBX, then Export > glTF 2.0 (.glb).` }),
                input);
            library.append(drop);
            for (const m of models.filter(x => x.source === 'custom')) {
                const info = modelInfo(manifest, m.id);
                grid.append(el('div', { class: 'ce-custom-row' }, card(m, m.id === current),
                    el('div', { class: 'ce-custom-info' },
                        el('small', { text: `${info?.stats?.tris?.toLocaleString?.() ?? '?'} triangles · rig: ${info?.rig || 'unknown'}${info?.vrm ? ' (VRM)' : ''}` }),
                        info?.license ? el('small', {}, `${info.license.title}${info.license.authors.length ? ` by ${info.license.authors.join(', ')}` : ''} · license: `,
                            info.license.url ? el('a', { href: info.license.url, target: '_blank', rel: 'noopener', text: info.license.license || 'see terms' }) : (info.license.license || 'not stated')) : null,
                        info?.needsConsent ? el('label', { class: `ce-consent${info.consent ? ' is-ok' : ''}` },
                            el('input', { type: 'checkbox', checked: !!info.consent, onchange: async e => { await setCustomConsent(m.id, e.target.checked); renderAll(); } }),
                            el('span', { text: 'Its license forbids violent use or use by others. I have the author\'s permission to use it in battles.' })) : null,
                        ...(info?.warnings || []).concat(info?.problems || []).map(t => el('small', { class: 'ce-hint', text: t })),
                        el('button', { type: 'button', class: 'ce-link', onclick: async () => { await removeCustomModel(m.id); renderAll(); } }, 'Remove'))));
            }
            library.append(grid);
            return;
        }
        renderGrid();
        library.append(grid);
        if (lib.tab === 'pack' && !models.some(m => m.source === 'pack')) grid.append(el('p', { class: 'ce-hint', text: 'Download a pack to see its characters. Packs are fetched only when you choose them, then work offline.' }));
    }

    async function importFile(file) {
        status.textContent = `Reading ${file.name}...`;
        const res = await importCustomModel(file, THREE, GLTFLoader, { meshoptDecoder: MeshoptDecoder });
        if (destroyed) return;
        if (!res.ok) { status.textContent = `Could not use ${file.name}: ${res.problems.join(' ')}`; renderLibrary(); return; }
        status.textContent = res.animated ? `${res.name} imported: KayKit rig, fully animated.`
            : res.retarget ? `${res.name} imported: ${res.rig} rig, animations are retargeted.` : `${res.name} imported: static pose.`;
        if (res.needsConsent) {
            status.textContent += ' Its license restricts fights: confirm permission below to use it.';
            renderAll();
            return;
        }
        edit(x => { x.model = res.id; for (const k of ['gear', 'recolor', 'loadout', 'mount']) delete x[k]; });
    }

    // --- per-role form ---
    function renderForm(resolved) {
        const r = role();
        const src = modelSource(resolved.modelId);
        title.textContent = `${COLOR_NAMES[sel.color]} ${TYPE_NAMES[sel.type]} ${GLYPHS[sel.color][sel.type]}`;
        sub.textContent = `${resolved.name}${resolved.mount ? ` on a ${resolved.mount.name.toLowerCase()}` : ''}` +
            (src === 'pack' ? ' · own weapons and moves' : src === 'custom' ? ` · ${resolved.static ? 'static pose' : resolved.retarget ? 'retargeted animations' : 'KayKit animations'}` : '');
        form.textContent = '';

        if (src === 'builtin') {
            const loadSel = el('select', { class: 'ce-select', onchange: () => edit(x => { x.loadout = loadSel.value; }) });
            const loads = listLoadouts(manifest);
            for (const [army, label] of [['heroes', 'Hero weapons'], ['skeletons', 'Skeleton weapons'], ['any', 'Other']]) {
                const group = loads.filter(l => l.army === army);
                if (group.length) loadSel.append(el('optgroup', { label }, group.map(l => el('option', { value: l.id, text: l.label }))));
            }
            loadSel.value = resolved.loadout;
            form.append(field('Weapons', loadSel, resolved.ranged ? 'Ranged: attacks with a magic bolt.' : null));

            // Mount: any mountable pack model; the farm pack downloads on first use.
            const mounts = listMounts();
            const mountSel = el('select', { class: 'ce-select', onchange: async () => {
                const v = mountSel.value;
                if (v === '__farm') { await download('quaternius-farm'); const h = listMounts()[0]; if (h) edit(x => { x.mount = h.id; }); return; }
                edit(x => { if (v) x.mount = v; else delete x.mount; });
            } },
            el('option', { value: '', text: 'On foot' }),
            mounts.map(m => el('option', { value: m.id, text: `Riding a ${m.label.toLowerCase()}` })),
            !isPackLoaded('quaternius-farm') ? el('option', { value: '__farm', text: 'Riding a horse (downloads the farm pack)' }) : null);
            mountSel.value = r.mount && mounts.some(m => m.id === r.mount) ? r.mount : '';
            form.append(field('Mount', mountSel, sel.type === 'n' && !r.mount ? 'Knights look great on horseback.' : null));

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
        }

        if (src === 'custom' && resolved.static) {
            const faceSel = el('select', { class: 'ce-select', onchange: () => edit(x => { x.forward = faceSel.value; }) },
                FACINGS.map(([v, label]) => el('option', { value: v, text: label })));
            faceSel.value = resolved.forward;
            form.append(field('Facing', faceSel, 'Which way the model looks in its own file. Fix it if the piece walks sideways.'));
        }

        // Role marks (procedural accessories)
        const extras = new Set(resolved.accessories);
        form.append(el('fieldset', { class: 'ce-checks' }, el('legend', { text: 'Role marks' }),
            Object.entries(ACCESSORIES).map(([id, label]) => el('label', { class: 'ce-check' },
                el('input', { type: 'checkbox', checked: extras.has(id), onchange: e => edit(x => {
                    const cur = new Set(Array.isArray(x.accessories) ? x.accessories : TYPE_ACCESSORIES[sel.type]);
                    e.target.checked ? cur.add(id) : cur.delete(id);
                    x.accessories = [...cur];
                }) }), el('span', { text: label }))),
            Array.isArray(r.accessories) ? el('button', { type: 'button', class: 'ce-link', onclick: () => edit(x => { delete x.accessories; }) }, 'Default marks') : null));

        const scale = r.scale ?? 1;
        const sizeOut = el('output', { text: `${Math.round(scale * 100)}%` });
        const size = el('input', { type: 'range', min: '0.6', max: '1.5', step: '0.05', value: String(scale),
            oninput: () => { sizeOut.textContent = `${Math.round(size.value * 100)}%`; },
            onchange: () => edit(x => { x.scale = +size.value; if (Math.abs(x.scale - 1) < 1e-3) delete x.scale; }) });
        form.append(field('Size', el('div', { class: 'ce-row' }, size, sizeOut)));

        const info = src === 'builtin' ? modelInfo(manifest, resolved.modelId) : null;
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

        const teamTint = sel.color === 'w' ? '#cfe0ff' : '#ffc9a6';
        const tintIn = el('input', { type: 'color', value: r.tint || '#ffffff', onchange: () => edit(x => { x.tint = tintIn.value.toLowerCase() === '#ffffff' ? undefined : tintIn.value; if (!x.tint) delete x.tint; }) });
        form.append(field('Tint', el('div', { class: 'ce-row' }, tintIn,
            el('button', { type: 'button', class: 'ce-link', onclick: () => edit(x => { x.tint = teamTint; }) }, 'Team tint'),
            r.tint ? el('button', { type: 'button', class: 'ce-link', onclick: () => edit(x => { delete x.tint; }) }, 'Clear') : null),
        src === 'builtin' ? 'Multiplies every colour of the model.' : 'Helps tell the sides apart when both use similar models.'));

        const other = sel.color === 'w' ? 'b' : 'w';
        form.append(el('div', { class: 'ce-row ce-copy' },
            el('button', { type: 'button', class: 'ce-link', onclick: () => edit(() => { state.roles[other][sel.type] = cloneCast(role()); }) }, `Copy to ${COLOR_NAMES[other]} ${TYPE_NAMES[sel.type]}`)));

        const custom = src === 'custom' ? modelInfo(manifest, resolved.modelId) : null;
        const notes = custom ? [...(custom.problems || []), ...(custom.warnings || [])] : [];
        warn.hidden = !notes.length;
        warn.textContent = notes.join(' ');
    }

    function renderLegend(resolved) {
        const rows = legendFor(resolved);
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
        const list = creditsFor(resolved);
        credits.textContent = list.length ? `Pack credits: ${list.join('; ')}.` : '';
    }

    function renderAll() {
        if (destroyed) return;
        const resolved = resolveRoles(manifest, state);
        renderPresets();
        renderRoles(resolved);
        renderLibrary();
        renderForm(resolved[sel.color][sel.type]);
        renderLegend(resolved);
        preview.show(resolved[sel.color][sel.type], sel.color, sel.type);
    }

    Promise.all([restoreCustomModels(), loadLibraryIndex(assetBase), ensurePacks()]).then(() => {
        const src = modelSource(role().model);
        lib.tab = src === 'builtin' ? 'builtin' : src === 'pack' ? 'pack' : 'custom';
        if (!destroyed) renderAll();
    });
    renderAll();

    return {
        getCast: () => normalizeCast(state),
        destroy() { destroyed = true; preview.dispose(); root.remove(); }
    };
}

// --- live preview -------------------------------------------------------------------------------

const YAW = { '+z': 0, '-z': Math.PI, '+x': -Math.PI / 2, '-x': Math.PI / 2 };

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
    const camera = new THREE.PerspectiveCamera(32, 220 / 240, 0.05, 50);
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
        const abs = /^(blob:|data:|https?:)/.test(url) ? url : new URL(url, assetBase).href;
        if (!cache.has(abs)) cache.set(abs, loader.loadAsync(abs));
        return cache.get(abs);
    };
    // Retargeted (non-KayKit humanoid) imports: prepared once per file by retarget.js, then cloned.
    const prepared = new Map();
    const prepare = (role) => {
        if (!prepared.has(role.model)) prepared.set(role.model, (async () => {
            const rt = await import('./retarget.js');
            let gltf;
            if (role.vrm) { const v = await import('./vrm.js'); gltf = await v.loadVRM(role.model, { GLTFLoader, meshoptDecoder: MeshoptDecoder }); }
            else gltf = await loader.loadAsync(role.model);
            await sharedReady;
            return rt.prepare(gltf, THREE, { sourceClips: shared });
        })());
        return prepared.get(role.model);
    };
    const shared = new Map();
    const sharedReady = Promise.all([manifest.clips?.file, manifest.clips?.skeletonFile].filter(Boolean).map(f =>
        load(f).then(g => { for (const a of g.animations) if (!shared.has(a.name)) shared.set(a.name, a); }).catch(() => { })));

    let unit = null, mixer = null, mountMixer = null, mountClips = new Map(), clips = shared, current = null, roleNow = null, token = 0, raf = 0, last = 0, angle = -0.5;
    const byName = (o, n) => n && (o.getObjectByName(n) || o.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n)));

    function clear() {
        if (!unit) return;
        unit.visuals?.dispose();
        turntable.remove(unit.root);
        mixer?.stopAllAction();
        mountMixer?.stopAllAction();
        unit = null; mixer = null; mountMixer = null; current = null;
    }

    function loopClip(m, map, name) {
        const clip = map.get(name);
        if (!m || !clip) return null;
        const a = m.clipAction(clip);
        a.reset().setLoop(THREE.LoopRepeat, Infinity).play();
        return a;
    }

    async function show(role, color, type) {
        const my = ++token;
        roleNow = role;
        let gltf, mountGltf = null, prep = null;
        try {
            if (role.retarget) { prep = await prepare(role).catch(() => null); }
            gltf = prep ? { scene: prep.root, animations: [] } : await load(role.model);
            if (role.mount) mountGltf = await load(role.mount.model).catch(() => null);
        } catch (e) { if (my === token) clear(); return; }
        const props = await Promise.all((role.props || []).map(p => load(p.file).catch(() => null)));
        await sharedReady;
        if (my !== token || !renderer) return;
        clear();
        clips = role.native ? new Map(gltf.animations.map(a => [a.name, a]))
            : prep && !prep.static ? { get: name => { try { return prep.clipMap(name); } catch (e) { return null; } } } : shared;

        const model = SkeletonUtils.clone(gltf.scene);
        model.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
        for (const n of role.hide || []) { const o = byName(model, n); if (o) o.visible = false; }
        for (const n of role.show || []) { const o = byName(model, n); if (o) o.visible = true; }
        (role.props || []).forEach((p, i) => {
            const bone = byName(model, p.bone);
            if (!props[i] || !bone) return;
            const obj = props[i].scene.clone(true);
            obj.position.fromArray(p.position || [0, 0, 0]);
            if (p.quaternion) obj.quaternion.fromArray(p.quaternion);
            bone.add(obj);
        });
        model.scale.setScalar(role.scale);
        model.position.y = 0.04;
        model.rotation.y = prep ? 0 : YAW[role.forward] ?? 0;
        const root = new THREE.Group();
        root.add(model);
        const b = role.bones || {};
        unit = { root, model, bones: {
            head: byName(model, b.head || 'head'), chest: byName(model, b.chest || 'chest'),
            handR: byName(model, b.handR || 'handslot.r'), handL: byName(model, b.handL || 'handslot.l')
        } };
        turntable.add(root);
        if (!role.static && !(prep && prep.static)) { mixer = new THREE.AnimationMixer(model); if (!mountGltf) play('idle'); }

        // Mounted: horse under the rider, rider's hips on the saddle in the riding pose.
        if (mountGltf) {
            const horse = SkeletonUtils.clone(mountGltf.scene);
            horse.scale.setScalar(role.mount.scale);
            horse.rotation.y = YAW[role.mount.forward] ?? 0;
            horse.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
            root.add(horse);
            mountMixer = new THREE.AnimationMixer(horse);
            mountClips = new Map(mountGltf.animations.map(a => [a.name, a]));
            loopClip(mountMixer, mountClips, role.mount.anims.idle);
            mountMixer.update(0);
            if (mixer) { const sit = loopClip(mixer, clips, role.mount.riderAnim); if (sit) current = sit; mixer.update(0); }
            root.updateMatrixWorld(true);
            const saddle = new THREE.Vector3().fromArray(role.mount.saddle).applyMatrix4(horse.matrixWorld);
            const hips = byName(model, b.hips || 'hips');
            const hy = hips ? hips.getWorldPosition(new THREE.Vector3()).y - model.getWorldPosition(new THREE.Vector3()).y : 0.3 * role.scale * 2.2;
            model.position.set(saddle.x, saddle.y - hy, saddle.z);
        }
        decorateUnit(unit, { THREE, color, type, role, labels: false });

        // Skinned bounds (pack models keep tiny bind-space vertices that only bones scale up).
        root.updateMatrixWorld(true);
        const box = new THREE.Box3();
        root.traverse(o => {
            if (!o.isMesh || !o.visible) return;
            if (o.isSkinnedMesh) { o.skeleton.update(); o.computeBoundingBox(); box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld)); }
            else box.union(new THREE.Box3().setFromObject(o));
        });
        const h = Math.max(0.6, box.isEmpty() ? 1 : box.max.y);
        const w = box.isEmpty() ? h : Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
        const d = Math.max(h, w * 0.8);
        camera.position.set(0.8 * d, 0.3 + 0.55 * h, 1.9 * d);
        camera.lookAt(0, 0.45 * h, 0);
        start();
    }

    function play(kind) {
        if (!mixer || !roleNow) return;
        const a = roleNow.anims || {};
        const pickOne = v => Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v;
        if (roleNow.mount && (kind === 'idle' || kind === 'walk')) {
            // Mounted: the horse idles or walks, the rider stays in the riding pose.
            mountMixer?.stopAllAction();
            loopClip(mountMixer, mountClips, kind === 'walk' ? roleNow.mount.anims.walk : roleNow.mount.anims.idle);
            return;
        }
        const name = kind === 'attack' ? pickOne(a.attack) : kind === 'hit' ? pickOne(a.hit) : a[kind];
        const clip = clips.get(name) || clips.get(a.idle);
        if (!clip) return;
        const action = mixer.clipAction(clip);
        action.reset();
        if (kind === 'idle' || kind === 'walk') action.setLoop(THREE.LoopRepeat, Infinity);
        else { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
        action.fadeIn(0.15).play();
        if (current && current !== action) current.fadeOut(0.15);
        const prev = current;
        current = action;
        if (kind !== 'idle' && kind !== 'walk') {
            const back = () => {
                mixer?.removeEventListener('finished', back);
                if (current !== action) return;
                if (roleNow.mount && prev) { prev.reset().fadeIn(0.15).play(); action.fadeOut(0.15); current = prev; }
                else play('idle');
            };
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
        mountMixer?.update(dt);
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
