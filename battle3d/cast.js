// Cast configuration for the 3D battle: which character, weapons, colours and scale play each chess piece.
// Pure module (no three.js import, no DOM at import time) so node can use it too: the asset build resolves
// the default preset into assets/manifest.json with resolveRoles().
//
// CastConfig = {
//   version: 1, preset: 'classic' | ... | 'custom', name,
//   roles: { w: { p: RoleConfig, n, b, r, q, k }, b: { ... } }
// }
// RoleConfig = {
//   model: 'Knight' | ... | 'pack:<packId>/<modelId>' | 'custom:<id>',  // built-in, library pack or imported model
//   loadout: 'sword_badge' | ... | 'none',                     // weapon set from manifest.loadouts (props + attack clips)
//   gear: ['Knight_Helmet', ...],                              // embedded hats/helmets/capes to show (default: model's defaultGear)
//   scale: 1,                                                  // multiplier on the piece's standard size
//   recolor: { to: 215, sat: 1, light: 1 } | null,             // cloth hue swap (degrees) on the model texture
//   tint: '#rrggbb' | null,                                    // multiply colour on all materials
//   accessories: ['crown', 'cape', 'aura', ...],               // procedural extras; default depends on the piece type
//   mount: 'pack:quaternius-farm/Horse' | null,                // ride a mountable pack model (mounted knights)
//   forward: '+z' | '-z' | '+x' | '-x'                         // facing fix for imported models
// }
// Model sources: Built-in (manifest.models, KayKit rig, shared clips), library packs (assets/library.json ->
// packs/<id>/pack.json, fetched when a cast uses them and precached by sw.js for offline play; each model plays its
// own embedded clips, role.native = true)
// and imported files (.glb / .vrm in IndexedDB; KayKit rigs animate directly, other humanoids through
// retarget.js when it can map them, everything else stands in a static pose). FBX must be converted first.
// Call prepareCast(cast, { assetBase }) before resolveRoles so pack data and imported models are registered.

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
const PACK_PREFIX = 'pack:';
// Import budgets: above WARN the model works but may slow phones; above MAX it is refused.
export const IMPORT_BUDGET = { trisWarn: 40000, trisMax: 250000, textureWarn: 2048, textureMax: 8192, bytesWarn: 15 * 1048576, bytesMax: 60 * 1048576 };

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
// Library pack casts (packs load when a cast uses them).
const RPG = 'pack:quaternius-rpg/', MON = 'pack:quaternius-monsters/', FARM = 'pack:quaternius-farm/';
const ADVENTURERS = {
    p: { model: RPG + 'Rogue' }, n: { model: RPG + 'Monk' }, b: { model: RPG + 'Wizard' },
    r: { model: RPG + 'Warrior' }, q: { model: RPG + 'Ranger' }, k: { model: RPG + 'Cleric' }
};
const MONSTERS = {
    p: { model: MON + 'Slime' }, n: { model: MON + 'Bat' }, b: { model: 'Skeleton_Mage', loadout: 'bone_staff', gear: ['Skeleton_Mage_Hat'], recolor: { to: 120, light: 0.9 } },
    r: { model: MON + 'Skeleton' }, q: { model: MON + 'Dragon' }, k: { model: 'Skeleton_Warrior', loadout: 'bone_king', gear: [], recolor: { to: 120, light: 0.9 } }
};
const BARNYARD = {
    p: { model: FARM + 'Pug' }, n: { model: FARM + 'Horse' }, b: { model: FARM + 'Llama' },
    r: { model: FARM + 'Cow' }, q: { model: FARM + 'Zebra' }, k: { model: FARM + 'Pig', scale: 1.25 }
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
    mounted: {
        name: 'Mounted knights', description: 'Heroes vs Skeletons with both knights on horseback (horse pack, about 0.3 MB).',
        roles: { w: { ...HEROES, n: { ...HEROES.n, mount: FARM + 'Horse' } }, b: { ...SKELETONS, n: { ...SKELETONS.n, mount: FARM + 'Horse', mountTint: '#6b6f7a' } } },
        packs: ['quaternius-farm']
    },
    adventurers: {
        name: 'Adventurers vs Skeletons', description: 'Quaternius RPG adventurers with their own weapons and moves (pack, about 1.5 MB).',
        roles: { w: ADVENTURERS, b: SKELETONS }, packs: ['quaternius-rpg']
    },
    monsters: {
        name: 'Heroes vs Monsters', description: 'A slime, bat and dragon horde led by a bone king (monster pack, about 0.4 MB).',
        roles: { w: HEROES, b: MONSTERS }, packs: ['quaternius-monsters']
    },
    barnyard: {
        name: 'Barnyard brawl', description: 'The farm rises against the skeletons: pug pawns, horse knights, a pig king (farm pack, about 0.7 MB).',
        roles: { w: BARNYARD, b: SKELETONS }, packs: ['quaternius-farm']
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

const customModels = new Map(); // id -> { id, name, url, ok, problems, animated, rig, retarget, forward, height, stats }
const packs = new Map();        // packId -> pack.json
const packModels = new Map();   // 'pack:<packId>/<modelId>' -> model entry (+ packId, file/thumb relative to assets)
let libraryIndex = null;

const round3 = x => Math.round(x * 1000) / 1000;
const isPack = id => typeof id === 'string' && id.startsWith(PACK_PREFIX);
const isCustom = id => typeof id === 'string' && id.startsWith(CUSTOM_PREFIX);
export const packModelId = (packId, modelId) => `${PACK_PREFIX}${packId}/${modelId}`;
const packIdOf = id => (isPack(id) ? id.slice(PACK_PREFIX.length).split('/')[0] : null);

// Registers a parsed pack.json (also usable from node tests without fetch).
export function registerPack(pack) {
    if (!pack?.id || !Array.isArray(pack.models)) throw new Error('invalid pack.json');
    packs.set(pack.id, pack);
    for (const m of pack.models) {
        packModels.set(packModelId(pack.id, m.id), {
            ...m, packId: pack.id, army: m.army || pack.army, kind: m.kind || pack.kind, credit: pack.credit,
            file: `packs/${pack.id}/${m.file}`, thumb: m.thumb ? `packs/${pack.id}/${m.thumb}` : null
        });
    }
    return pack;
}

export async function loadLibraryIndex(assetBase, fetchFn = globalThis.fetch) {
    if (libraryIndex) return libraryIndex;
    try {
        const res = await fetchFn(new URL('library.json', assetBase).href);
        libraryIndex = res.ok ? await res.json() : { packs: [] };
    } catch (e) { libraryIndex = { packs: [] }; }
    return libraryIndex;
}

export async function loadPack(packId, assetBase, fetchFn = globalThis.fetch) {
    if (packs.has(packId)) return packs.get(packId);
    const index = await loadLibraryIndex(assetBase, fetchFn);
    const entry = index.packs.find(p => p.id === packId);
    const url = new URL(entry?.path || `packs/${packId}/pack.json`, assetBase).href;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`pack ${packId}: HTTP ${res.status}`);
    return registerPack(await res.json());
}

export function isPackLoaded(packId) { return packs.has(packId); }

// Pack ids a cast needs (role models and mounts).
export function castPackIds(cast) {
    const ids = new Set();
    for (const c of COLORS) for (const t of TYPES) {
        const r = cast?.roles?.[c]?.[t];
        for (const id of [r?.model, r?.mount]) { const p = packIdOf(id); if (p) ids.add(p); }
    }
    return [...ids];
}

// Everything resolveRoles needs that lives outside the manifest: imported models (IndexedDB) and the pack.json
// of every pack the cast uses. Returns the packs that failed to load (their roles fall back to the defaults).
export async function prepareCast(cast, { assetBase, fetch: fetchFn = globalThis.fetch } = {}) {
    await restoreCustomModels();
    const failed = [];
    await Promise.all(castPackIds(cast).map(id => loadPack(id, assetBase, fetchFn).catch(e => failed.push({ id, error: String(e.message || e) }))));
    return { failed };
}

// Library browser data. source: 'builtin' | 'pack' | 'custom'. thumb is relative to the assets folder (or a blob URL).
export function listModels(manifest) {
    const list = Object.entries(manifest?.models || {}).map(([id, m]) => ({
        id, label: m.label || id, army: m.army, source: 'builtin', kind: 'humanoid', rig: 'kaykit', native: false,
        thumb: `thumbs/${id}.webp`, custom: false, tags: []
    }));
    for (const [id, m] of packModels) list.push({
        id, label: m.label, army: m.army, source: 'pack', packId: m.packId, kind: m.kind, rig: m.rig, native: true,
        thumb: m.thumb, custom: false, tags: m.tags || [], tris: m.tris, mountable: !!m.mount, ranged: !!m.ranged
    });
    for (const m of customModels.values()) list.push({
        id: m.id, label: m.name, army: 'custom', source: 'custom', kind: m.stats?.humanoid === false ? 'creature' : 'humanoid',
        rig: m.rig || 'unknown', native: false, thumb: null, custom: true, ok: m.ok, tags: [], tris: m.stats?.tris
    });
    return list;
}

export function listPacks() {
    return (libraryIndex?.packs || []).map(p => ({ ...p, loaded: packs.has(p.id) }));
}

export function listMounts() {
    return [...packModels.entries()].filter(([, m]) => m.mount).map(([id, m]) => ({ id, label: m.label, thumb: m.thumb }));
}

export function listLoadouts(manifest) {
    return Object.entries(manifest?.loadouts || {}).map(([id, l]) => ({ id, label: l.label, army: l.army, ranged: !!l.ranged }));
}

export function modelInfo(manifest, id) {
    if (isCustom(id)) return customModels.get(id) || null;
    if (isPack(id)) return packModels.get(id) || null;
    return manifest?.models?.[id] || null;
}

export function modelSource(id) { return isCustom(id) ? 'custom' : isPack(id) ? 'pack' : 'builtin'; }

// Gear the editor may toggle for a model (embedded accessories not held in a hand). Built-in models only.
export function gearOptions(manifest, id) {
    return isPack(id) || isCustom(id) ? [] : modelInfo(manifest, id)?.gear || [];
}

// --- resolution -------------------------------------------------------------------------------------

function common(color, type, cfg) {
    const scaleMul = Number.isFinite(cfg.scale) && cfg.scale > 0 ? cfg.scale : 1;
    const accessories = Array.isArray(cfg.accessories) ? cfg.accessories.filter(a => ACCESSORIES[a]) : TYPE_ACCESSORIES[type];
    return {
        scaleMul, accessories,
        base: {
            crown: accessories.includes('crown'), accessories,
            accScale: round3(0.38 * TYPE_SIZE[type] * scaleMul), // size of crowns/plumes/banners in world units per KayKit unit
            tint: typeof cfg.tint === 'string' ? cfg.tint : null,
            label: TYPE_NAMES[type], glyph: GLYPHS[color][type]
        }
    };
}

function resolveMount(cfg) {
    const m = isPack(cfg.mount) ? packModels.get(cfg.mount) : null;
    if (!m?.mount) return null;
    return {
        model: m.file, modelId: cfg.mount, name: m.label, scale: m.mount.scale, forward: m.forward,
        walkSpeed: m.walkSpeedNative ? round3(m.walkSpeedNative * m.mount.scale) : null,
        runSpeed: m.runSpeedNative ? round3(m.runSpeedNative * m.mount.scale) : null,
        saddle: m.mount.saddle, riderAnim: 'Sit_Chair_Idle', bones: m.bones,
        riderScale: m.mount.riderScale ?? 1, // multiply the rider's scale while mounted (big-headed riders on a real horse)
        anims: { idle: m.anims.idle, walk: m.anims.walk, run: m.anims.run, jump: m.anims.jump, death: [...m.anims.death], hit: [...m.anims.hit] },
        tint: typeof cfg.mountTint === 'string' ? cfg.mountTint : null
    };
}

function resolvePackRole(color, type, cfg, m) {
    const { scaleMul, base } = common(color, type, cfg);
    const anims = JSON.parse(JSON.stringify(m.anims));
    const scale = round3(m.scale * TYPE_SIZE[type] * scaleMul);
    return {
        ...base,
        model: m.file, modelId: cfg.model, name: m.label, army: m.army, source: 'pack', credit: m.credit,
        native: true, rig: m.rig, kind: m.kind,
        scale,
        // world units/s at playback rate 1 (units.js syncs walk/run playback to ground speed); null = use defaults
        walkSpeed: m.walkSpeedNative ? round3(m.walkSpeedNative * scale) : null,
        runSpeed: m.runSpeedNative ? round3(m.runSpeedNative * scale) : null,
        show: [], hide: [], props: [], recolor: null,
        loadout: 'native', ranged: !!m.ranged,
        idle: anims.idle, walk: anims.walk, forward: m.forward || '+z',
        skeleton: false, static: false, bones: { ...m.bones },
        anims, impacts: { ...m.impacts }, clipDurations: { ...m.clipDurations },
        mount: null
    };
}

function resolveCustomRole(manifest, color, type, cfg, custom) {
    const { scaleMul, base } = common(color, type, cfg);
    const armyAnims = manifest.armyAnims?.heroes || {};
    const kaykit = custom.rig === 'kaykit' || custom.animated;
    const anims = { ...armyAnims, attack: ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', 'Unarmed_Melee_Attack_Punch_A'] };
    return {
        ...base,
        model: custom.url, modelId: custom.id, name: custom.name, army: 'custom', source: 'custom',
        native: false, rig: custom.rig || 'unknown', retarget: !kaykit && !!custom.retarget,
        scale: round3((manifest.targetHeight || 0.85) / Math.max(0.05, custom.height || 2.2) * TYPE_SIZE[type] * scaleMul),
        show: [], hide: [], props: [], recolor: null, loadout: 'none', ranged: false,
        idle: anims.idle, walk: anims.walk,
        forward: ['+z', '-z', '+x', '-x'].includes(cfg.forward) ? cfg.forward : custom.forward || '+z',
        skeleton: false, static: !kaykit && !custom.retarget, anims, mount: null, vrm: !!custom.vrm
    };
}

// RoleConfig -> manifest-shaped role used by units.js.
export function resolveRole(manifest, color, type, cfg = {}) {
    const fallback = PRESETS[DEFAULT_PRESET].roles[color][type];
    if (isPack(cfg.model) && packModels.has(cfg.model)) return resolvePackRole(color, type, cfg, packModels.get(cfg.model));
    if (isCustom(cfg.model) && isCustomUsable(cfg.model)) return resolveCustomRole(manifest, color, type, cfg, customModels.get(cfg.model));
    if (!manifest?.models?.[cfg.model]) cfg = { ...fallback, mount: cfg.mount, mountTint: cfg.mountTint };
    const modelId = cfg.model;
    const info = manifest.models[modelId];
    const army = info.army;
    const armyAnims = manifest.armyAnims?.[army === 'skeletons' ? 'skeletons' : 'heroes'] || {};
    const loadoutId = cfg.loadout === 'none' ? 'none' : (manifest.loadouts?.[cfg.loadout] ? cfg.loadout : (info?.defaultLoadout || fallback.loadout));
    const loadout = loadoutId === 'none' ? manifest.loadouts?.none : manifest.loadouts?.[loadoutId];

    // Embedded accessories: show chosen gear, hide everything else (hand weapons come from the loadout props).
    const all = info.accessories.map(a => a.name);
    const gearAllowed = new Set(info.gear || []);
    const gear = (Array.isArray(cfg.gear) ? cfg.gear : info.defaultGear || []).filter(n => gearAllowed.has(n));
    const show = [...gear];
    const props = [];
    for (const p of loadout?.props || []) {
        // Prefer the model's own embedded copy of a weapon when it has one (no extra download, exact mount).
        const embedded = p.embedded && p.embedded.find(n => all.includes(n));
        if (embedded) show.push(embedded);
        else props.push({ file: p.file, bone: p.bone, position: p.position, quaternion: p.quaternion, rotation: p.rotation });
    }
    const hide = all.filter(n => !show.includes(n));

    const anims = {
        ...armyAnims,
        ...(loadout?.idle ? { idle: loadout.idle } : {}),
        attack: [...(loadout?.attack?.length ? loadout.attack : armyAnims.attack || ['1H_Melee_Attack_Chop'])]
    };
    const { scaleMul, base } = common(color, type, cfg);
    return {
        ...base,
        model: info.file,
        modelId,
        name: info.label,
        army,
        source: 'builtin',
        scale: round3((manifest.baseScale || 0.38) * TYPE_SIZE[type] * scaleMul),
        show, hide, props,
        recolor: cfg.recolor && Number.isFinite(cfg.recolor.to)
            ? { from: info.cloth || [0, 360], to: cfg.recolor.to, sat: cfg.recolor.sat ?? 1, light: cfg.recolor.light ?? 1 }
            : null,
        loadout: loadoutId,
        ranged: !!loadout?.ranged,
        idle: anims.idle,
        walk: anims.walk,
        forward: '+z',
        skeleton: army === 'skeletons',
        static: false,
        anims,
        mount: resolveMount(cfg)
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
        const model = (r.name || r.modelId || '') + (r.mount ? ` on ${r.mount.name}` : '');
        out.push({ color, type, glyph: GLYPHS[color][type], name: TYPE_NAMES[type], model, loadout: r.loadout || '' });
    }
    return out;
}

// Credits for the packs a set of roles uses (shown in the editor and the about box).
export function creditsFor(roles) {
    const set = new Set();
    for (const color of COLORS) for (const type of TYPES) {
        const r = roles?.[color]?.[type];
        if (r?.credit) set.add(r.credit);
        if (r?.mount) { const m = packModels.get(r.mount.modelId); if (m?.credit) set.add(m.credit); }
    }
    return [...set];
}

// --- custom models ----------------------------------------------------------------------------------

const sanitize = n => String(n).replace(/\s/g, '_').replace(/[[\].:/]/g, '');

function measure(THREE, scene) {
    let tris = 0, meshes = 0, skinned = 0, maxTex = 0;
    const bones = new Set(), textures = new Set();
    scene.traverse(o => {
        if (!o.isMesh) return;
        meshes++;
        const g = o.geometry;
        tris += (g.index ? g.index.count : g.attributes.position?.count || 0) / 3;
        if (o.isSkinnedMesh) { skinned++; for (const b of o.skeleton.bones) bones.add(b.name); }
        for (const m of [].concat(o.material)) for (const k of ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap']) {
            const t = m?.[k];
            if (t?.image && !textures.has(t)) { textures.add(t); maxTex = Math.max(maxTex, t.image.width || 0, t.image.height || 0); }
        }
    });
    const box = new THREE.Box3().setFromObject(scene);
    return { tris: Math.round(tris), meshes, skinned, bones: [...bones], textures: textures.size, maxTex, box };
}

// Facing guess for a humanoid: the toes (or feet) sit in front of the ankles. Falls back to +z.
function guessForward(THREE, scene) {
    scene.updateMatrixWorld(true);
    const find = re => { let r = null; scene.traverse(o => { if (!r && o.isBone && re.test(o.name)) r = o; }); return r; };
    const toe = find(/toe/i), foot = find(/foot|ankle/i);
    if (!toe || !foot || toe === foot) return '+z';
    const a = foot.getWorldPosition(new THREE.Vector3()), b = toe.getWorldPosition(new THREE.Vector3());
    const dx = b.x - a.x, dz = b.z - a.z;
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return '+z';
    return Math.abs(dz) >= Math.abs(dx) ? (dz > 0 ? '+z' : '-z') : (dx > 0 ? '+x' : '-x');
}

// Loads a user .glb / .gltf (single file) or .vrm, validates budgets and rig, and registers it.
// Returns { id, url, name, ok, animated, retarget, rig, forward, problems: [], warnings: [], stats }.
// ok=false means it cannot be used (unreadable, no meshes, over the hard budget, FBX).
export async function importCustomModel(file, THREE, GLTFLoader, { meshoptDecoder = null, persist = true, retarget = null, vrm = null } = {}) {
    const problems = [], warnings = [];
    const fileName = file?.name || 'Custom model';
    const name = fileName.replace(/\.(glb|gltf|vrm)$/i, '');
    const fail = msg => ({ id: null, url: null, name, ok: false, animated: false, retarget: false, problems: [...problems, msg], warnings });
    if (!file) return fail('No file selected.');
    if (/\.fbx$/i.test(fileName)) return fail('FBX cannot be loaded in the browser. Convert it in Blender: File > Import > FBX, then File > Export > glTF 2.0 (.glb), and import the .glb.');
    if (!/\.(glb|gltf|vrm)$/i.test(fileName)) return fail('Expected a .glb, .gltf (with embedded buffers) or .vrm file.');
    if (file.size > IMPORT_BUDGET.bytesMax) return fail(`The file is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${IMPORT_BUDGET.bytesMax / 1048576} MB.`);
    if (file.size > IMPORT_BUDGET.bytesWarn) warnings.push(`Large file (${(file.size / 1048576).toFixed(1)} MB): loading may be slow on phones.`);

    const isVrm = /\.vrm$/i.test(fileName);
    let scene, gltf;
    try {
        if (isVrm) {
            const mod = vrm || await import('./vrm.js').catch(() => null);
            if (!mod?.loadVRM) return fail('VRM support is not available in this build.');
            gltf = await mod.loadVRM(file, { GLTFLoader, meshoptDecoder });
            scene = gltf.scene;
        } else {
            const loader = new GLTFLoader();
            if (meshoptDecoder && loader.setMeshoptDecoder) loader.setMeshoptDecoder(meshoptDecoder);
            gltf = await loader.parseAsync(await file.arrayBuffer(), '');
            scene = gltf.scene;
        }
    } catch (e) {
        return fail(`Could not read the model: ${e.message || e}`);
    }

    const st = measure(THREE, scene);
    if (!st.meshes) return fail('The file has no meshes.');
    if (st.tris > IMPORT_BUDGET.trisMax) return fail(`Too detailed: ${st.tris.toLocaleString()} triangles (limit ${IMPORT_BUDGET.trisMax.toLocaleString()}). Decimate it in Blender first.`);
    if (st.tris > IMPORT_BUDGET.trisWarn) warnings.push(`${st.tris.toLocaleString()} triangles: 32 pieces of this may be slow on phones (budget ${IMPORT_BUDGET.trisWarn.toLocaleString()}).`);
    if (st.maxTex > IMPORT_BUDGET.textureMax) return fail(`Texture of ${st.maxTex} px is too large (limit ${IMPORT_BUDGET.textureMax} px).`);
    if (st.maxTex > IMPORT_BUDGET.textureWarn) warnings.push(`Textures up to ${st.maxTex} px use a lot of memory; 1024 px is plenty for a chess piece.`);

    // Rig: KayKit names animate directly; other humanoids go through retarget.js (detectRig) when it can map them.
    const kaykitMissing = REQUIRED_BONES.filter(b => !st.bones.some(n => sanitize(n) === sanitize(b)));
    let rig = st.skinned ? 'unknown' : 'none', retargetable = false, humanoid = st.skinned > 0, detected = null;
    if (st.skinned && !kaykitMissing.length) rig = 'kaykit';
    else if (st.skinned || isVrm) {
        const rt = retarget || await import('./retarget.js').catch(() => null);
        if (rt?.detectRig) {
            try {
                detected = await rt.detectRig(gltf);
                rig = detected?.type || rig;
                retargetable = !!detected?.animatable;
                humanoid = retargetable || (detected?.confidence ?? 0) > 0;
                for (const w of detected?.warnings || []) if (retargetable || !/static pose/.test(w)) warnings.push(w);
            } catch (e) { warnings.push(`Rig check failed: ${e.message || e}`); }
        } else warnings.push('The retargeting module is not available, so this model will stand in a static pose.');
    }
    const animated = rig === 'kaykit';
    if (!st.skinned && !isVrm) problems.push('No skeleton: the model will stand in a static pose (it still moves and fights, without animation).');
    else if (!animated && !retargetable) {
        const missing = (detected?.missing?.length ? detected.missing : kaykitMissing).map(readableBone);
        problems.push(`Rig "${rig}" can't be mapped onto the game's animations${missing.length ? ` (missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''})` : ''}: the model will stand in a static pose.`);
    }
    else if (!animated && retargetable) warnings.push(`Rig "${rig}" is retargeted onto the game's animations.`);

    const box = st.box;
    const height = box.isEmpty() ? 2.2 : box.max.y - Math.min(0, box.min.y);
    if (!box.isEmpty() && box.min.y < -0.05 * height) warnings.push('The model origin is not at its feet; it may float or sink.');
    // retarget.prepare turns retargeted models to +Z itself; static models use the detected facing.
    let forward = '+z';
    if (!retargetable && ['+z', '-z', '+x', '-x'].includes(detected?.facing)) forward = detected.facing;
    else if (!retargetable && !detected && humanoid) forward = guessForward(THREE, scene);
    if (forward !== '+z') warnings.push(`The model seems to face ${forward}; it is turned automatically (change "Facing" if it looks wrong).`);

    // VRM avatars carry usage terms. Avatars whose license forbids violent use (or allows only the author) need
    // an explicit confirmation before they can play a piece (setCustomConsent); until then roles fall back.
    const meta = isVrm ? (gltf.userData?.vrmMeta || null) : null;
    const license = meta ? { title: meta.title || name, authors: meta.authors || [], license: meta.license || '', url: meta.licenseUrl || '', violentUse: meta.violentUse, permission: meta.avatarPermission || '' } : null;
    for (const w of meta?.warnings || []) warnings.unshift(w);
    const needsConsent = !!meta && ((meta.version === '0' && !meta.violentUse) || meta.avatarPermission === 'onlyAuthor');

    const id = CUSTOM_PREFIX + name.replace(/[^\w-]+/g, '_') + '_' + (file.size || 0).toString(36);
    const url = URL.createObjectURL(file);
    const stats = { tris: st.tris, textures: st.textures, maxTex: st.maxTex, humanoid, bones: st.bones.length };
    const entry = { id, name, url, ok: true, animated, retarget: retargetable, rig, forward, problems, warnings, height, stats, vrm: isVrm, license, needsConsent, consent: false };
    customModels.set(id, entry);
    if (persist) await idbPut(id, { name, blob: file, animated, retarget: retargetable, rig, forward, problems, warnings, height, stats, vrm: isVrm, license, needsConsent, consent: false }).catch(() => { });
    return { ...entry };
}

export function getCustomModel(id) { return customModels.get(id) || null; }

// True when an imported model may play a piece (no license restriction, or the user confirmed permission).
export function isCustomUsable(id) { const m = customModels.get(id); return !!m && (!m.needsConsent || m.consent); }

// The user confirms they have permission to use a restricted avatar in fights (stored with the model).
export async function setCustomConsent(id, consent = true) {
    const m = customModels.get(id);
    if (!m) return false;
    m.consent = !!consent;
    try {
        const all = await idbAll();
        const rec = all.find(r => r.id === id);
        if (rec) await idbPut(id, { ...rec.value, consent: m.consent });
    } catch (e) { /* session only */ }
    return true;
}

const readableBone = n => String(n).replace(/[_.]?([lr])$/i, (x, s) => ` ${s.toLowerCase() === 'l' ? 'left' : 'right'}`).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^(upper|lower)(arm|leg)/i, '$1 $2').toLowerCase();

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
            customModels.set(id, {
                id, name: value.name, url: URL.createObjectURL(value.blob), ok: true, animated: !!value.animated,
                retarget: !!value.retarget, rig: value.rig || (value.animated ? 'kaykit' : 'unknown'), forward: value.forward || '+z',
                problems: value.problems || [], warnings: value.warnings || [], height: value.height || 2.2, stats: value.stats || null, vrm: !!value.vrm,
                license: value.license || null, needsConsent: !!value.needsConsent, consent: !!value.consent
            });
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
