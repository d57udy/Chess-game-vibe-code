// Asset catalog for the cast system: models, weapon loadouts, per-army clip defaults. The default roles are
// resolved from cast.js PRESETS.classic so the manifest and the in-game editor always agree.
const BASE_SCALE = 0.38; // KayKit characters are ~2.2-2.3 units tall in bind pose -> ~0.85 world units
const TARGET_HEIGHT = 0.85;

const MODELS = {
  Knight: { label: 'Knight', army: 'heroes', cloth: [330, 14], gear: ['Knight_Helmet', 'Knight_Cape'], defaultGear: ['Knight_Helmet', 'Knight_Cape'], defaultLoadout: 'sword_badge' },
  Barbarian: { label: 'Barbarian', army: 'heroes', cloth: [190, 230], gear: ['Barbarian_Hat', 'Barbarian_Cape'], defaultGear: ['Barbarian_Hat', 'Barbarian_Cape'], defaultLoadout: 'greataxe' },
  Mage: { label: 'Mage', army: 'heroes', cloth: [235, 345], gear: ['Mage_Hat', 'Mage_Cape'], defaultGear: ['Mage_Hat', 'Mage_Cape'], defaultLoadout: 'staff' },
  Rogue: { label: 'Rogue', army: 'heroes', cloth: [75, 180], gear: ['Rogue_Cape'], defaultGear: ['Rogue_Cape'], defaultLoadout: 'dual_daggers' },
  Rogue_Hooded: { label: 'Hooded Rogue', army: 'heroes', cloth: [75, 180], gear: ['Rogue_Cape'], defaultGear: [], defaultLoadout: 'dagger_buckler' },
  Skeleton_Minion: { label: 'Skeleton Minion', army: 'skeletons', cloth: [240, 14], gear: [], defaultGear: [], defaultLoadout: 'bone_blade' },
  Skeleton_Warrior: { label: 'Skeleton Warrior', army: 'skeletons', cloth: [240, 14], gear: ['Skeleton_Warrior_Helmet'], defaultGear: ['Skeleton_Warrior_Helmet'], defaultLoadout: 'bone_blade_shield' },
  Skeleton_Mage: { label: 'Skeleton Mage', army: 'skeletons', cloth: [240, 14], gear: ['Skeleton_Mage_Hat'], defaultGear: ['Skeleton_Mage_Hat'], defaultLoadout: 'bone_staff' },
  Skeleton_Rogue: { label: 'Skeleton Rogue', army: 'skeletons', cloth: [240, 14], gear: ['Skeleton_Rogue_Hood', 'Skeleton_Rogue_Cape'], defaultGear: ['Skeleton_Rogue_Hood', 'Skeleton_Rogue_Cape'], defaultLoadout: 'dual_bone_blades' },
};

// Prop file -> embedded hero node it is identical to (mount copied from that node). R/L = hand.
const PROPS = {
  sword_1handed: { R: '1H_Sword', L: '1H_Sword_Offhand' },
  sword_2handed: { R: '2H_Sword' },
  axe_1handed: { R: '1H_Axe', L: '1H_Axe_Offhand' },
  axe_2handed: { R: '2H_Axe' },
  dagger: { R: 'Knife', L: 'Knife_Offhand' },
  staff: { R: '2H_Staff' },
  wand: { R: '1H_Wand' },
  spellbook_open: { L: 'Spellbook_open' },
  mug_full: { R: 'Mug' },
  shield_round: { L: 'Round_Shield' },
  shield_badge: { L: 'Badge_Shield' },
  shield_square: { L: 'Rectangle_Shield' },
  shield_spikes: { L: 'Spike_Shield' },
  // Skeleton props have no embedded twin: mount like the closest hero item.
  Skeleton_Blade: { R: ['1H_Sword'], L: ['1H_Sword_Offhand'] },
  Skeleton_Axe: { R: ['1H_Axe'] },
  Skeleton_Staff: { R: ['2H_Staff'] },
  Skeleton_Shield_Small_A: { L: ['Round_Shield'] },
  Skeleton_Shield_Small_B: { L: ['Round_Shield'] },
  Skeleton_Shield_Large_A: { L: ['Round_Shield'] },
  Skeleton_Shield_Large_B: { L: ['Round_Shield'] },
};

const ONE_H = ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Slice_Horizontal'];
const LOADOUTS = {
  dagger_buckler: { label: 'Dagger + buckler', army: 'heroes', props: [['dagger', 'R'], ['shield_round', 'L']], attack: ['1H_Melee_Attack_Stab', '1H_Melee_Attack_Slice_Horizontal', 'Unarmed_Melee_Attack_Kick'] },
  sword_badge: { label: 'Sword + crest shield', army: 'heroes', props: [['sword_1handed', 'R'], ['shield_badge', 'L']], attack: ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', 'Block_Attack'] },
  sword_spikes: { label: 'Sword + spiked shield', army: 'heroes', props: [['sword_1handed', 'R'], ['shield_spikes', 'L']], attack: ['1H_Melee_Attack_Slice_Horizontal', '1H_Melee_Attack_Chop', 'Block_Attack'] },
  greatsword: { label: 'Greatsword', army: 'heroes', props: [['sword_2handed', 'R']], attack: ['2H_Melee_Attack_Slice', '2H_Melee_Attack_Chop', '2H_Melee_Attack_Stab'], idle: '2H_Melee_Idle' },
  dual_swords: { label: 'Two swords', army: 'heroes', props: [['sword_1handed', 'R'], ['sword_1handed', 'L']], attack: ['Dualwield_Melee_Attack_Chop', 'Dualwield_Melee_Attack_Slice', 'Dualwield_Melee_Attack_Stab'] },
  axe_tower: { label: 'Axe + tower shield', army: 'heroes', props: [['axe_1handed', 'R'], ['shield_square', 'L']], attack: ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Horizontal', 'Block_Attack'] },
  greataxe: { label: 'Great axe', army: 'heroes', props: [['axe_2handed', 'R']], attack: ['2H_Melee_Attack_Chop', '2H_Melee_Attack_Spin', '2H_Melee_Attack_Slice'], idle: '2H_Melee_Idle' },
  dual_axes: { label: 'Two axes', army: 'heroes', props: [['axe_1handed', 'R'], ['axe_1handed', 'L']], attack: ['Dualwield_Melee_Attack_Chop', 'Dualwield_Melee_Attack_Slice'] },
  dual_daggers: { label: 'Two daggers', army: 'heroes', props: [['dagger', 'R'], ['dagger', 'L']], attack: ['Dualwield_Melee_Attack_Chop', 'Dualwield_Melee_Attack_Slice', 'Dualwield_Melee_Attack_Stab'] },
  staff: { label: 'Staff (ranged magic)', army: 'heroes', props: [['staff', 'R']], attack: ['Spellcast_Shoot', 'Spellcast_Long'], ranged: true },
  wand_book: { label: 'Wand + spellbook (ranged)', army: 'heroes', props: [['wand', 'R'], ['spellbook_open', 'L']], attack: ['Spellcast_Shoot', 'Spellcast_Raise'], ranged: true },
  mug: { label: 'Tavern mug (brawler)', army: 'heroes', props: [['mug_full', 'R']], attack: ['Unarmed_Melee_Attack_Punch_A', 'Unarmed_Melee_Attack_Kick'] },
  bone_blade: { label: 'Bone blade', army: 'skeletons', props: [['Skeleton_Blade', 'R']], attack: ['1H_Melee_Attack_Stab', '1H_Melee_Attack_Slice_Horizontal', 'Unarmed_Melee_Attack_Punch_A'] },
  bone_blade_shield: { label: 'Blade + small shield', army: 'skeletons', props: [['Skeleton_Blade', 'R'], ['Skeleton_Shield_Small_A', 'L']], attack: ['1H_Melee_Attack_Jump_Chop', '1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal'], idle: 'Idle_Combat' },
  bone_axe_tower: { label: 'Axe + tower shield', army: 'skeletons', props: [['Skeleton_Axe', 'R'], ['Skeleton_Shield_Large_A', 'L']], attack: ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Jump_Chop', 'Block_Attack'], idle: 'Idle_Combat' },
  bone_staff: { label: 'Bone staff (ranged magic)', army: 'skeletons', props: [['Skeleton_Staff', 'R']], attack: ['Spellcast_Shoot', 'Spellcast_Long'], ranged: true },
  dual_bone_blades: { label: 'Two bone blades', army: 'skeletons', props: [['Skeleton_Blade', 'R'], ['Skeleton_Blade', 'L']], attack: ['Dualwield_Melee_Attack_Chop', 'Dualwield_Melee_Attack_Slice', 'Dualwield_Melee_Attack_Stab'] },
  bone_king: { label: 'Blade + great shield', army: 'skeletons', props: [['Skeleton_Blade', 'R'], ['Skeleton_Shield_Large_B', 'L']], attack: ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Horizontal', 'Block_Attack'] },
  bone_axe: { label: 'Bone axe', army: 'skeletons', props: [['Skeleton_Axe', 'R']], attack: ONE_H },
  none: { label: 'Unarmed', army: 'any', props: [], attack: ['Unarmed_Melee_Attack_Punch_A', 'Unarmed_Melee_Attack_Punch_B', 'Unarmed_Melee_Attack_Kick'], idle: 'Unarmed_Idle' },
};

const ARMY_ANIMS = {
  heroes: { idle: 'Idle', walk: 'Walking_A', death: ['Death_A', 'Death_B'], hit: ['Hit_A', 'Hit_B'], block: 'Block_Hit', cheer: 'Cheer', spawn: 'Spawn_Air', jump: 'Jump_Full_Long' },
  skeletons: { idle: 'Idle_B', walk: 'Walking_D_Skeletons', death: ['Death_C_Skeletons', 'Death_A'], hit: ['Hit_A', 'Hit_B'], block: 'Block_Hit', cheer: 'Taunt', spawn: 'Spawn_Ground_Skeletons', jump: 'Jump_Full_Long' },
};

// mounts: embedded node name -> { bone, position, quaternion } read from the raw hero GLBs.
function buildCatalog({ mounts, bindModels }) {
  const models = {};
  for (const [id, m] of Object.entries(MODELS)) {
    const bm = bindModels[id];
    for (const g of [...m.gear, ...m.defaultGear]) if (!bm.accessories.some(a => a.name === g)) throw new Error(`${id}: unknown gear ${g}`);
    models[id] = { file: `characters/${id}.glb`, ...m, bind: bm.bind, accessories: bm.accessories };
  }
  const loadouts = {};
  const propFiles = new Set();
  for (const [id, l] of Object.entries(LOADOUTS)) {
    const props = l.props.map(([name, hand]) => {
      const spec = PROPS[name][hand];
      if (!spec) throw new Error(`${id}: ${name} has no ${hand} mount`);
      const ref = Array.isArray(spec) ? spec[0] : spec;
      const mt = mounts[ref];
      if (!mt) throw new Error(`no embedded mount ${ref}`);
      propFiles.add(name);
      const r = v => Math.round(v * 1e5) / 1e5;
      return {
        file: `props/${name}.gltf`, bone: mt.bone,
        position: mt.position.map(r), quaternion: mt.quaternion.map(r), rotation: quatToEuler(mt.quaternion).map(r),
        embedded: Array.isArray(spec) ? [] : [spec],
      };
    });
    loadouts[id] = { label: l.label, army: l.army, props, attack: l.attack, ...(l.idle ? { idle: l.idle } : {}), ranged: !!l.ranged };
  }
  return { models, loadouts, propFiles: [...propFiles], armyAnims: ARMY_ANIMS };
}

// XYZ euler (three.js default order) from a quaternion.
function quatToEuler([x, y, z, w]) {
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
  return [Math.atan2(m32, m22), ey, 0];
}

function buildManifest({ impacts, clipDurations, catalog, roles, meshopt }) {
  const fight = {};
  for (const color of ['w', 'b']) {
    for (const [type, role] of Object.entries(roles[color])) {
      for (const name of [role.anims.idle, role.anims.walk, role.anims.block, role.anims.cheer, role.anims.spawn, role.anims.jump, ...role.anims.attack, ...role.anims.death, ...role.anims.hit]) {
        if (!(name in clipDurations)) throw new Error(`casting uses unknown clip ${name}`);
      }
      fight[color + type] = { attack: [...role.anims.attack], impact: Object.fromEntries(role.anims.attack.map(a => [a, impacts[a]])), ranged: role.ranged };
      const f = fight[type] || (fight[type] = { attack: [], impact: {}, ranged: role.ranged });
      for (const a of role.anims.attack) { if (!f.attack.includes(a)) f.attack.push(a); f.impact[a] = impacts[a]; }
    }
  }
  for (const l of Object.values(catalog.loadouts)) for (const a of l.attack) {
    if (!(a in clipDurations)) throw new Error(`loadout uses unknown clip ${a}`);
    if (impacts[a] == null) throw new Error(`no impact for ${a}`);
  }
  return {
    version: 2,
    source: 'KayKit Adventurers 1.0 + Skeletons 1.0 by Kay Lousberg (CC0), see CREDITS.md',
    meshopt: !!meshopt,
    forward: [0, 0, 1],
    up: [0, 1, 0],
    baseScale: BASE_SCALE,
    targetHeight: TARGET_HEIGHT,
    notes: [
      'roles = cast.js resolveRoles(manifest, PRESETS.classic). Use cast.js to build roles for other casts; units.js consumes the same shape.',
      'meshopt: true means characters/*.glb and anims/*.glb use EXT_meshopt_compression + KHR_mesh_quantization: call loader.setMeshoptDecoder(MeshoptDecoder). Props are plain glTF.',
      'Models face local +Z. White units (face -z) need rotation.y = PI, Black units (face +z) need 0.',
      'Bone and node names are glTF names. three.js GLTFLoader strips . : / [ ] from node names: look up "handslot.r" as "handslotr".',
      'roles[c][t].anims holds the per-role clip choices; fight[color+type] holds that role\'s attacks with impact times; fight[t] is the union; impacts covers every attack clip.',
      'props: position + rotation (euler XYZ radians) or the equivalent quaternion are the local transform relative to the bone.',
      'show: accessory nodes to make visible; hide: every other embedded accessory of that model.',
      'accessories (crown, tiara, cape, aura, plume, banner, glow) and recolor/tint are rendered by unit-visuals.js decorateUnit.',
      'Clips with "_Pose" and T-Pose are single-frame (duration 0). All clips are in place (no root motion).',
    ],
    clips: { file: 'anims/clips.glb', skeletonFile: 'anims/clips_skeleton.glb' },
    roles,
    fight,
    impacts,
    clipDurations,
    models: catalog.models,
    loadouts: catalog.loadouts,
    armyAnims: catalog.armyAnims,
  };
}

module.exports = { buildCatalog, buildManifest, BASE_SCALE, TARGET_HEIGHT, PROPS };
