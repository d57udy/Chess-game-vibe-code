// Cast configuration for the 3D battle: which character, weapons, colours and scale play each chess piece.
// Pure module (no three.js import, no DOM at import time) so node can use it too: the asset build resolves
// the default preset into assets/manifest.json with resolveRoles().
//
// CastConfig = {
//   version: 1, preset: 'classic' | ... | 'custom', name,
//   roles: { w: { p: RoleConfig, n, b, r, q, k }, b: { ... } }
// }
// RoleConfig = {
//   model: 'Knight' | 'Skeleton_Mage' | ... | 'custom:<id>',   // id from manifest.models or an imported model
//   loadout: 'sword_badge' | ... | 'none',                     // weapon set from manifest.loadouts (props + attack clips)
//   gear: ['Knight_Helmet', ...],                              // embedded hats/helmets/capes to show (default: model's defaultGear)
//   scale: 1,                                                  // multiplier on the piece's standard size
//   recolor: { to: 215, sat: 1, light: 1 } | null,             // cloth hue swap (degrees) on the model texture
//   tint: '#rrggbb' | null,                                    // multiply colour on all materials
//   accessories: ['crown', 'cape', 'aura', ...]                // procedural extras; default depends on the piece type
// }
// Limits: animations only work on models with the KayKit humanoid rig (same bone names). Other models are shown
// in a static pose (role.static = true) and importCustomModel reports why.

export const TYPES = ['p', 'n', 'b', 'r', 'q', 'k'];
export const COLORS = ['w', 'b'];
export const TYPE_NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
export const COLOR_NAMES = { w: 'White', b: 'Black' };
export const GLYPHS = {
    w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
    b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' }
};
// Size of each piece type relative to a standard piece (silhouette hierarchy).
export const TYPE_SIZE = { p: 0.9, n: 1.0, b: 1.0, r: 1.25, q: 1.05, k: 1.1 };
// Procedural accessories unit-visuals.js adds by default for each type.
export const TYPE_ACCESSORIES = { p: [], n: ['plume'], b: ['glow'], r: ['banner'], q: ['tiara', 'aura'], k: ['crown', 'cape', 'aura'] };
export const ACCESSORIES = {
    crown: 'Gold crown', tiara: 'Tiara', cape: 'Royal cape', aura: 'Aura', plume: 'Helmet plume',
    banner: 'Banner', glow: 'Glowing weapon tip'
};

// Bones the KayKit rig animates. A custom model needs these names (dots optional) to play the shared clips.
export const REQUIRED_BONES = [
    'root', 'hips', 'spine', 'chest', 'head',
    'upperarm.l', 'lowerarm.l', 'wrist.l', 'hand.l', 'handslot.l',
    'upperarm.r', 'lowerarm.r', 'wrist.r', 'hand.r', 'handslot.r',
    'upperleg.l', 'lowerleg.l', 'foot.l', 'toes.l',
    'upperleg.r', 'lowerleg.r', 'foot.r', 'toes.r'
];

const STORAGE_KEY = 'battle3d.cast.v1';
const CUSTOM_PREFIX = 'custom:';

// --- presets --------------------------------------------------------------------------------------

const BLUE = 215, VIOLET = 280, EMBER = 18;

const HEROES = {
    p: { model: 'Rogue_Hooded', loadout: 'dagger_buckler', gear: [], recolor: { to: BLUE, light: 1.05 } },
    n: { model: 'Knight', loadout: 'sword_badge', gear: ['Knight_Helmet', 'Knight_Cape'], recolor: { to: BLUE } },
    b: { model: 'Mage', loadout: 'staff', gear: ['Mage_Hat', 'Mage_Cape'] },
    r: { model: 'Barbarian', loadout: 'axe_tower', gear: ['Barbarian_Hat', 'Barbarian_Cape'] },
    q: { model: 'Rogue', loadout: 'dual_daggers', gear: ['Rogue_Cape'], recolor: { to: VIOLET } },
    k: { model: 'Knight', loadout: 'greatsword', gear: ['Knight_Cape'] }
};
const SKELETONS = {
    p: { model: 'Skeleton_Minion', loadout: 'bone_blade', gear: [] },
    n: { model: 'Skeleton_Warrior', loadout: 'bone_blade_shield', gear: ['Skeleton_Warrior_Helmet'] },
    b: { model: 'Skeleton_Mage', loadout: 'bone_staff', gear: ['Skeleton_Mage_Hat'] },
    r: { model: 'Skeleton_Warrior', loadout: 'bone_axe_tower', gear: ['Skeleton_Warrior_Helmet'] },
    q: { model: 'Skeleton_Rogue', loadout: 'dual_bone_blades', gear: ['Skeleton_Rogue_Hood', 'Skeleton_Rogue_Cape'], recolor: { to: VIOLET } },
    k: { model: 'Skeleton_Mage', loadout: 'bone_king', gear: [] }
};
const withRecolor = (army, recolor, keep = []) => Object.fromEntries(TYPES.map(t =>
    [t, keep.includes(t) ? { ...army[t] } : { ...army[t], recolor: { ...recolor } }]));

export const PRESETS = {
    classic: {
        name: 'Heroes vs Skeletons', description: 'The default: KayKit adventurers (White) against the skeleton army (Black).',
        roles: { w: HEROES, b: SKELETONS }
    },
    swapped: {
        name: 'Skeletons vs Heroes', description: 'Same armies, sides swapped. Skeleton cloth turns blue, hero cloth turns ember.',
        roles: { w: withRecolor(SKELETONS, { to: BLUE }, ['q']), b: withRecolor(HEROES, { to: EMBER, light: 0.85 }, ['q']) }
    },
    heroes: {
        name: 'Heroes mirror', description: 'Adventurers on both sides; Black wears ember cloth.',
        roles: { w: HEROES, b: withRecolor(HEROES, { to: EMBER, light: 0.85 }, ['q']) }
    },
    skeletons: {
        name: 'Skeleton mirror', description: 'Skeletons on both sides; White wears blue cloth.',
        roles: { w: withRecolor(SKELETONS, { to: BLUE }, ['q']), b: SKELETONS }
    },
    mixed: {
        name: 'Mixed armies', description: 'Each side fields heroes and skeletons together.',
        roles: {
            w: { p: HEROES.p, n: { ...SKELETONS.n, recolor: { to: BLUE } }, b: HEROES.b, r: { ...SKELETONS.r, recolor: { to: BLUE } }, q: HEROES.q, k: HEROES.k },
            b: { p: SKELETONS.p, n: { ...HEROES.n, recolor: { to: EMBER, light: 0.85 } }, b: SKELETONS.b, r: { ...HEROES.r, recolor: { to: EMBER, light: 0.85 } }, q: SKELETONS.q, k: SKELETONS.k }
        }
    }
};
export const DEFAULT_PRESET = 'classic';

const clone = o => JSON.parse(JSON.stringify(o));

export function presetCast(id = DEFAULT_PRESET) {
    const p = PRESETS[id] || PRESETS[DEFAULT_PRESET];
    return { version: 1, preset: PRESETS[id] ? id : DEFAULT_PRESET, name: p.name, roles: clone(p.roles) };
}

export function cloneCast(cast) { return clone(cast); }

// Fill gaps so every colour/type has a RoleConfig (missing ones come from the default preset).
export function normalizeCast(cast) {
    const base = presetCast(cast?.preset && PRESETS[cast.preset] ? cast.preset : DEFAULT_PRESET);
    const preset = PRESETS[cast?.preset] || cast?.preset === 'custom' ? cast.preset : base.preset;
    const out = { version: 1, preset, name: (preset === cast?.preset && cast?.name) || base.name, roles: { w: {}, b: {} } };
    for (const c of COLORS) for (const t of TYPES) {
        const r = cast?.roles?.[c]?.[t];
        out.roles[c][t] = r && typeof r === 'object' && r.model ? clone(r) : base.roles[c][t];
    }
    return out;
}

// --- persistence ------------------------------------------------------------------------------------

function storage() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

export function loadUserCast() {
    try {
        const raw = storage()?.getItem(STORAGE_KEY);
        if (!raw) return null;
        const cast = JSON.parse(raw);
        return cast && cast.roles ? normalizeCast(cast) : null;
    } catch (e) { return null; }
}

export function saveUserCast(cast) {
    try {
        const s = storage();
        if (!s) return false;
        if (!cast) s.removeItem(STORAGE_KEY);
        else s.setItem(STORAGE_KEY, JSON.stringify(cast));
        return true;
    } catch (e) { return false; }
}

export function clearUserCast() { return saveUserCast(null); }

// --- catalog helpers --------------------------------------------------------------------------------

const customModels = new Map(); // id -> { id, name, url, ok, problems, animated, height }

export function listModels(manifest) {
    const list = Object.entries(manifest?.models || {}).map(([id, m]) => ({ id, label: m.label || id, army: m.army, custom: false }));
    for (const m of customModels.values()) list.push({ id: m.id, label: m.name, army: 'custom', custom: true, ok: m.ok });
    return list;
}

export function listLoadouts(manifest) {
    return Object.entries(manifest?.loadouts || {}).map(([id, l]) => ({ id, label: l.label, army: l.army, ranged: !!l.ranged }));
}

export function modelInfo(manifest, id) {
    if (id && id.startsWith(CUSTOM_PREFIX)) return customModels.get(id) || null;
    return manifest?.models?.[id] || null;
}

// Gear the editor may toggle for a model (embedded accessories not held in a hand).
export function gearOptions(manifest, id) {
    return modelInfo(manifest, id)?.gear || [];
}

// --- resolution -------------------------------------------------------------------------------------

// RoleConfig -> manifest-shaped role used by units.js.
export function resolveRole(manifest, color, type, cfg = {}) {
    const fallback = PRESETS[DEFAULT_PRESET].roles[color][type];
    const custom = cfg.model && cfg.model.startsWith(CUSTOM_PREFIX) ? customModels.get(cfg.model) : null;
    const modelId = custom || manifest?.models?.[cfg.model] ? cfg.model : fallback.model;
    const info = custom ? null : manifest.models[modelId];
    const army = custom ? 'custom' : info.army;
    const armyAnims = manifest.armyAnims?.[army === 'skeletons' ? 'skeletons' : 'heroes'] || {};
    const loadoutId = cfg.loadout === 'none' ? 'none' : (manifest.loadouts?.[cfg.loadout] ? cfg.loadout : (info?.defaultLoadout || fallback.loadout));
    const loadout = loadoutId === 'none' ? manifest.loadouts?.none : manifest.loadouts?.[loadoutId];

    // Embedded accessories: show chosen gear, hide everything else (hand weapons come from the loadout props).
    const all = info ? info.accessories.map(a => a.name) : [];
    const gearAllowed = new Set(info?.gear || []);
    const gear = (Array.isArray(cfg.gear) ? cfg.gear : info?.defaultGear || []).filter(n => gearAllowed.has(n));
    const show = [...gear];
    const props = [];
    for (const p of loadout?.props || []) {
        // Prefer the model's own embedded copy of a weapon when it has one (no extra download, exact mount).
        const embedded = info && p.embedded && p.embedded.find(n => all.includes(n));
        if (embedded) show.push(embedded);
        else props.push({ file: p.file, bone: p.bone, position: p.position, quaternion: p.quaternion, rotation: p.rotation });
    }
    const hide = all.filter(n => !show.includes(n));

    const anims = {
        ...armyAnims,
        ...(loadout?.idle ? { idle: loadout.idle } : {}),
        attack: [...(loadout?.attack?.length ? loadout.attack : armyAnims.attack || ['1H_Melee_Attack_Chop'])]
    };
    const scaleMul = Number.isFinite(cfg.scale) && cfg.scale > 0 ? cfg.scale : 1;
    const baseScale = custom ? (manifest.targetHeight || 0.85) / Math.max(0.05, custom.height || 2.2) : manifest.baseScale || 0.38;
    const accessories = Array.isArray(cfg.accessories) ? cfg.accessories.filter(a => ACCESSORIES[a]) : TYPE_ACCESSORIES[type];

    return {
        model: custom ? custom.url : info.file,
        modelId,
        name: custom ? custom.name : info.label,
        army,
        scale: Math.round(baseScale * TYPE_SIZE[type] * scaleMul * 1000) / 1000,
        show, hide, props,
        crown: accessories.includes('crown'),
        accessories,
        recolor: cfg.recolor && Number.isFinite(cfg.recolor.to)
            ? { from: info?.cloth || [0, 360], to: cfg.recolor.to, sat: cfg.recolor.sat ?? 1, light: cfg.recolor.light ?? 1 }
            : null,
        tint: typeof cfg.tint === 'string' ? cfg.tint : null,
        label: TYPE_NAMES[type],
        glyph: GLYPHS[color][type],
        loadout: loadoutId,
        ranged: !!loadout?.ranged,
        idle: anims.idle,
        walk: anims.walk,
        forward: '+z',
        skeleton: army === 'skeletons',
        static: custom ? !custom.animated : false,
        anims
    };
}

export function resolveRoles(manifest, cast) {
    const c = normalizeCast(cast || presetCast());
    const roles = { w: {}, b: {} };
    for (const color of COLORS) for (const type of TYPES) roles[color][type] = resolveRole(manifest, color, type, c.roles[color][type]);
    return roles;
}

// "Who's who": one entry per colour/type for legends.
export function legendFor(roles) {
    const out = [];
    for (const color of COLORS) for (const type of TYPES) {
        const r = roles?.[color]?.[type] || {};
        out.push({ color, type, glyph: GLYPHS[color][type], name: TYPE_NAMES[type], model: r.name || r.modelId || '', loadout: r.loadout || '' });
    }
    return out;
}

// --- custom models ----------------------------------------------------------------------------------

const sanitize = n => String(n).replace(/\s/g, '_').replace(/[[\].:/]/g, '');

// Loads a user .glb/.gltf (single file), checks the rig against the KayKit skeleton and registers it.
// Returns { id, url, name, ok, animated, problems: [] }. ok=false means it cannot be shown at all.
export async function importCustomModel(file, THREE, GLTFLoader, { meshoptDecoder = null, persist = true } = {}) {
    const problems = [];
    const name = (file?.name || 'Custom model').replace(/\.(glb|gltf)$/i, '');
    if (!file) return { id: null, url: null, name, ok: false, animated: false, problems: ['No file selected.'] };
    if (!/\.(glb|gltf)$/i.test(file.name || '')) problems.push('Expected a .glb file (a .gltf must embed its buffers and textures).');
    if (file.size > 25 * 1024 * 1024) problems.push(`The file is large (${(file.size / 1048576).toFixed(1)} MB); loading may be slow.`);

    let gltf;
    try {
        const loader = new GLTFLoader();
        if (meshoptDecoder && loader.setMeshoptDecoder) loader.setMeshoptDecoder(meshoptDecoder);
        const buffer = await file.arrayBuffer();
        gltf = await loader.parseAsync(buffer, '');
    } catch (e) {
        return { id: null, url: null, name, ok: false, animated: false, problems: [...problems, `Could not read the model: ${e.message || e}`] };
    }

    const scene = gltf.scene;
    let skinned = 0, meshes = 0;
    const boneNames = new Set();
    scene.traverse(o => {
        if (o.isMesh) meshes++;
        if (o.isSkinnedMesh) { skinned++; for (const b of o.skeleton.bones) boneNames.add(sanitize(b.name)); }
    });
    if (!meshes) problems.push('The file has no meshes.');
    const missing = REQUIRED_BONES.filter(b => !boneNames.has(sanitize(b)));
    if (!skinned) problems.push('No skinned mesh: the model will stand in a static pose (no walking or fighting animations).');
    else if (missing.length) problems.push(`Rig is not KayKit-compatible, missing bones: ${missing.join(', ')}. The model will stand in a static pose.`);
    const animated = skinned > 0 && missing.length === 0;

    const box = new THREE.Box3().setFromObject(scene);
    const height = box.isEmpty() ? 2.2 : box.max.y - Math.min(0, box.min.y);
    if (!box.isEmpty() && box.min.y < -0.05 * height) problems.push('The model origin is not at its feet; it may float or sink.');
    const size = box.getSize(new THREE.Vector3());
    if (size.z > size.x * 1.6 && !animated) problems.push('The model may not face +Z (KayKit convention); it could stand sideways.');

    const id = CUSTOM_PREFIX + name.replace(/[^\w-]+/g, '_') + '_' + (file.size || 0).toString(36);
    const url = URL.createObjectURL(file);
    const entry = { id, name, url, ok: meshes > 0, animated, problems, height };
    customModels.set(id, entry);
    if (persist) await idbPut(id, { name, blob: file, animated, problems, height }).catch(() => { });
    return { ...entry };
}

export function getCustomModel(id) { return customModels.get(id) || null; }

export function removeCustomModel(id) {
    const m = customModels.get(id);
    if (m) { try { URL.revokeObjectURL(m.url); } catch (e) { /* ignore */ } customModels.delete(id); }
    return idbDelete(id).catch(() => { });
}

// Re-registers models imported in earlier sessions (IndexedDB). Call before resolveRoles on startup.
export async function restoreCustomModels() {
    try {
        const all = await idbAll();
        for (const { id, value } of all) {
            if (customModels.has(id) || !value?.blob) continue;
            customModels.set(id, { id, name: value.name, url: URL.createObjectURL(value.blob), ok: true, animated: !!value.animated, problems: value.problems || [], height: value.height || 2.2 });
        }
    } catch (e) { /* storage unavailable: custom models are session-only */ }
    return [...customModels.values()];
}

// Minimal IndexedDB key/value store for imported model blobs (localStorage is too small for meshes).
function idb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
        const req = indexedDB.open('battle3d-cast', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('models');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function idbTx(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('models', mode);
        const out = fn(tx.objectStore('models'));
        tx.oncomplete = () => { db.close(); resolve(out.result ?? out.value); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    });
}
function idbPut(id, value) { return idbTx('readwrite', s => s.put(value, id)); }
function idbDelete(id) { return idbTx('readwrite', s => s.delete(id)); }
async function idbAll() {
    const db = await idb();
    return new Promise((resolve, reject) => {
        const out = [];
        const req = db.transaction('models', 'readonly').objectStore('models').openCursor();
        req.onsuccess = () => {
            const c = req.result;
            if (c) { out.push({ id: c.key, value: c.value }); c.continue(); } else { db.close(); resolve(out); }
        };
        req.onerror = () => { db.close(); reject(req.error); };
    });
}
