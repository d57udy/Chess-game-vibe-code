// Capture choreography for the 3D battle prototype: data (role styles, signature pairings) plus the beat
// generators that compose a fight. units.js owns the characters and hands a kit of primitives to
// createFights(); every beat is a generator on the units runner (updater clock), so Skip and
// sceneAPI.stepFrames() drive it like any other sequence.
//
// A capture is: approach -> (intro) -> clash (0 to 3 exchanges) -> finisher -> death || aftermath.
// Fast mode skips the cinematic, intro and clash and keeps the whole capture around 1 to 1.3 s.

// Weapon feel per attacker role: impact FX kind and trail colour.
const WEAPON = {
    p: { kind: 'pierce', trail: '#e8f2ff' },
    n: { kind: 'slash', trail: '#cfe3ff' },
    b: { kind: 'magic', trail: null },
    r: { kind: 'blunt', trail: '#ffd9a0' },
    q: { kind: 'slash', trail: '#ffc8f0' },
    k: { kind: 'slash', trail: '#ffe58a' }
};

// Two or three variants per role; picked without repeating the previous one for that piece.
export const ROLE_STYLES = {
    p: [
        { name: 'lunge', clash: ['block'], finisher: 'lungeStab' },
        { name: 'scrappy', clash: ['dodge'], finisher: 'kickStab' },
        { name: 'quick', clash: ['block'], finisher: 'slash' }
    ],
    n: [
        { name: 'leap', clash: ['block'], finisher: 'jumpChop' },
        { name: 'fencer', clash: ['counter'], finisher: 'slashCombo' },
        { name: 'feint', clash: ['dodge'], finisher: 'jumpChop' }
    ],
    b: [
        { name: 'barrage', clash: ['boltBlock'], finisher: 'barrage' },
        { name: 'judgement', clash: ['boltBlock'], finisher: 'skyBolt' }
    ],
    r: [
        { name: 'crusher', clash: ['block'], finisher: 'smash' },
        { name: 'brawler', clash: ['counter'], finisher: 'smash' },
        { name: 'reaper', clash: ['block'], finisher: 'sweep' }
    ],
    q: [
        { name: 'whirlwind', clash: ['dodge'], finisher: 'spinCombo' },
        { name: 'duelist', clash: ['block'], finisher: 'twinSlash' }
    ],
    k: [
        { name: 'sovereign', clash: ['block', 'counter'], finisher: 'royalSlash' },
        { name: 'veteran', clash: ['counter', 'block'], finisher: 'royalSlash' }
    ]
};

// Signature pairings (Full mode). `chance` < 1 leaves room for the normal variants.
export const PAIRINGS = [
    { id: 'underdog', match: (A, V) => A.type === 'p' && V.type === 'q', chance: 1, intro: 'underdog', clash: [], finisher: 'tinyStab', dramatic: true },
    { id: 'queenDuel', match: (A, V) => A.type === 'q' && V.type === 'q', chance: 1, clash: ['block', 'counter'], finisher: 'spinCombo', shot: 'orbit' },
    { id: 'shieldClash', match: (A, V) => A.type === 'r' && V.type === 'r', chance: 1, clash: ['shieldBash'], finisher: 'smash' },
    { id: 'knightDuel', match: (A, V) => A.type === 'n' && V.type === 'n', chance: 1, clash: ['airParry'], finisher: 'slashCombo' },
    { id: 'spellDuel', match: (A, V) => A.type === 'b' && V.type === 'b', chance: 1, clash: ['boltCollide'], finisher: 'barrage' },
    { id: 'royal', match: (A) => A.type === 'k', chance: 0.6, clash: ['block', 'counter'], finisher: 'royalSlash', shot: 'orbit' }
];

const APPROACH = 0.65;

export function createFights(k) {
    const { THREE } = k;
    const lastVariant = new Map();
    const v3 = () => new THREE.Vector3();

    // ---------------------------------------------------------------------------------------
    // Planning

    function plan(A, V) {
        if (k.full) {
            for (const p of PAIRINGS) {
                if (p.match(A, V) && Math.random() < p.chance) return { ...p, name: p.id };
            }
        }
        const list = ROLE_STYLES[A.type] || ROLE_STYLES.p;
        const key = A.color + A.type;
        let i = Math.floor(Math.random() * list.length);
        if (list.length > 1 && i === lastVariant.get(key)) i = (i + 1) % list.length;
        lastVariant.set(key, i);
        return { ...list[i] };
    }

    // ---------------------------------------------------------------------------------------
    // Small helpers

    const dirOf = (A, V) => {
        const d = v3().subVectors(V.root.position, A.root.position).setY(0);
        return d.lengthSq() > 1e-6 ? d.normalize() : v3().set(0, 0, 1);
    };
    const between = (A, V, t = 0.5) => k.chestPos(A).lerp(k.chestPos(V), t);
    const aspeed = () => (k.full ? 1 : 1.8);

    // Attack clip from the attacker's own list, preferring `wanted` names.
    function attackClip(u, wanted = [], { quick = false } = {}) {
        const list = k.attackList(u);
        for (const n of wanted) if (k.hasClip(n)) return n;
        if (!list.length) return null;
        if (quick) return list.reduce((a, b) => (k.impactOf(u, b) < k.impactOf(u, a) ? b : a));
        return k.pick(list.filter(n => k.impactOf(u, n) <= 1.0).length ? list.filter(n => k.impactOf(u, n) <= 1.0) : list);
    }

    // Plays an attack clip with a weapon trail; resolves at the impact time and returns the action.
    function* swing(A, name, { speed = aspeed(), trail = true, fade = 0.1 } = {}) {
        const a = k.play(A, name || 'Idle', { speed, fade });
        const trails = [];
        if (trail && WEAPON[A.type]?.trail) {
            trails.push(k.fx.trail(A, WEAPON[A.type].trail));
            if (A.type === 'q') trails.push(k.fx.trail(A, WEAPON.q.trail, 'L'));
        }
        yield k.untilClip(A, a, name ? k.impactOf(A, name) : 0.3);
        k.later(0.15, () => trails.forEach(t => t && t.stop()));
        k.sfx('whoosh', { volume: 0.5, rate: k.rand(0.9, 1.15) });
        return a;
    }

    function* combatIdle(u) {
        k.play(u, u.isSkeleton ? ['Idle_Combat', '2H_Melee_Idle', 'Idle'] : ['2H_Melee_Idle', 'Idle'], { loop: true, fade: 0.15 });
    }

    // Code-driven root offset along `dir` (out and optionally back), clamped near the unit's square.
    function* nudge(u, dir, dist, dur, { back = false } = {}) {
        const start = u.root.position.clone();
        const home = k.sqPos(u.square);
        yield* k.tween(dur, t => {
            const s = back ? Math.sin(Math.PI * t) : k.smooth(t);
            const p = start.clone().addScaledVector(dir, dist * s);
            const off = p.clone().sub(home).setY(0);
            if (off.length() > 0.42) off.setLength(0.42);
            u.root.position.set(home.x + off.x, u.root.position.y, home.z + off.z);
        });
    }

    function* hop(u, height, dur) {
        const y0 = u.root.position.y;
        yield* k.tween(dur, t => { u.root.position.y = y0 + 4 * height * t * (1 - t); });
        u.root.position.y = y0;
    }

    function clang(A, V, kind = 'slash', strength = 0.3) {
        k.fx.impact(between(A, V, 0.55), dirOf(A, V), kind === 'magic' ? 'magic' : 'slash');
        k.sfx(kind === 'magic' ? 'zap' : 'clang', { volume: 0.8, rate: k.rand(0.9, 1.1) });
        k.fx.shake(strength);
    }

    // ---------------------------------------------------------------------------------------
    // Exchanges (non-lethal beats). Each returns when both fighters are back in guard.

    const EXCHANGES = {
        *block(A, V) {
            const a = yield* swing(A, attackClip(A, [], { quick: true }), { speed: 1.25 });
            k.play(V, k.anim(V, 'block', ['Block_Hit', 'Block']), { speed: 1.3, fade: 0.06 });
            clang(A, V, 'slash', 0.3);
            yield* k.hitStop([A, V], 0.05);
            yield k.untilClip(A, a, a ? a.getClip().duration * 0.7 : 0.3);
            yield* combatIdle(A);
            k.guard(V);
            yield 0.08;
        },
        *dodge(A, V) {
            const name = attackClip(A, [], { quick: true });
            const a = k.play(A, name, { speed: 1.25, fade: 0.1 });
            const tr = WEAPON[A.type]?.trail ? k.fx.trail(A, WEAPON[A.type].trail) : null;
            const impact = name ? k.impactOf(A, name) : 0.3;
            yield k.untilClip(A, a, Math.max(0, impact - 0.15));
            const side = Math.random() < 0.5 ? 1 : -1;
            const d = dirOf(A, V);
            const perp = v3().set(-d.z * side, 0, d.x * side);
            k.play(V, side > 0 ? ['Dodge_Left', 'Dodge_Right', 'Block'] : ['Dodge_Right', 'Dodge_Left', 'Block'], { speed: 1.2, fade: 0.06 });
            k.sfx('whoosh', { volume: 0.7, rate: 1.2 });
            yield [nudge(V, perp, 0.22, 0.5, { back: true }), (function* () {
                yield k.untilClip(A, a, impact + 0.2);
                if (tr) tr.stop();
            })()];
            yield* combatIdle(A);
            k.guard(V);
            yield 0.05;
        },
        *counter(A, V) {
            const name = attackClip(V, ['Block_Attack'], { quick: true });
            const a = yield* swing(V, name, { speed: 1.3 });
            k.play(A, k.anim(A, 'block', ['Block_Hit', 'Block']), { speed: 1.3, fade: 0.06 });
            clang(V, A, 'slash', 0.3);
            yield* nudge(A, dirOf(V, A), 0.1, 0.15);
            yield k.untilClip(V, a, a ? a.getClip().duration * 0.65 : 0.3);
            k.guard(V);
            yield* combatIdle(A);
            yield 0.08;
        },
        *boltBlock(A, V) {
            const a = k.play(A, ['Spellcast_Shoot', 'Spellcasting'], { speed: 1.2, fade: 0.1 });
            yield k.untilClip(A, a, k.impactOf(A, 'Spellcast_Shoot'));
            k.play(V, ['Block', 'Blocking', 'Block_Hit'], { speed: 1.4, fade: 0.06 });
            yield* k.fx.bolt(k.handPos(A), between(A, V, 0.85), A.color, 0.25, 0.8);
            clang(A, V, 'magic', 0.25);
            yield k.untilClip(A, a, a ? a.getClip().duration * 0.8 : 0.2);
            k.play(A, ['Idle'], { loop: true, fade: 0.15 });
            k.guard(V);
            yield 0.05;
        },
        // Rook vs rook: both shields slam together, both get pushed back.
        *shieldBash(A, V) {
            const d = dirOf(A, V);
            k.play(A, ['Block', 'Blocking'], { speed: 1.3, fade: 0.08 });
            k.play(V, ['Block', 'Blocking'], { speed: 1.3, fade: 0.08 });
            yield [nudge(A, d, 0.14, 0.18), nudge(V, d.clone().negate(), 0.14, 0.18)];
            k.fx.impact(between(A, V), d, 'blunt');
            k.sfx('clang', { volume: 1, rate: 0.8 });
            k.sfx('thud', { volume: 0.8 });
            k.fx.shake(0.7);
            k.fx.burst(k.sqPos(V.square).lerp(k.sqPos(A.square), 0.5), 'dust', { count: 14 });
            yield* k.hitStop([A, V], 0.08);
            yield [nudge(A, d.clone().negate(), 0.2, 0.25), nudge(V, d, 0.2, 0.25)];
            yield* combatIdle(A);
            k.guard(V);
            yield 0.15;
        },
        // Knight vs knight: the attacker's leaping chop is parried mid-air by a hopping victim.
        *airParry(A, V) {
            const name = k.hasClip('1H_Melee_Attack_Jump_Chop') ? '1H_Melee_Attack_Jump_Chop' : attackClip(A);
            const a = k.play(A, name, { speed: 1.2, fade: 0.1 });
            const tr = k.fx.trail(A, WEAPON.n.trail);
            const impact = k.impactOf(A, name);
            yield [hop(A, 0.28, impact / 1.2), (function* () {
                yield Math.max(0, impact / 1.2 - 0.3);
                k.play(V, ['Block', 'Block_Hit'], { speed: 1.4, fade: 0.06 });
                yield* hop(V, 0.18, 0.3);
            })()];
            if (tr) k.later(0.12, () => tr.stop());
            clang(A, V, 'slash', 0.45);
            yield* k.hitStop([A, V], 0.06);
            yield k.untilClip(A, a, a ? a.getClip().duration * 0.75 : 0.3);
            yield* combatIdle(A);
            k.guard(V);
            yield 0.05;
        },
        // Bishop vs bishop: both bolts meet in the middle and burst.
        *boltCollide(A, V) {
            const a = k.play(A, ['Spellcast_Shoot', 'Spellcasting'], { speed: 1.1, fade: 0.1 });
            const b = k.play(V, ['Spellcast_Shoot', 'Spellcasting'], { speed: 1.1, fade: 0.1 });
            yield k.untilClip(A, a, k.impactOf(A, 'Spellcast_Shoot'));
            const mid = between(A, V);
            yield [k.fx.bolt(k.handPos(A), mid, A.color, 0.3, 0.9), k.fx.bolt(k.handPos(V), mid, V.color, 0.3, 0.9)];
            k.fx.impact(mid, dirOf(A, V), 'magic');
            k.fx.burst(mid, 'magic', { count: 30 });
            k.sfx('magic', { volume: 1 });
            k.fx.shake(0.5);
            yield k.untilClip(A, a, a ? a.getClip().duration * 0.9 : 0.3);
            k.play(A, ['Idle'], { loop: true, fade: 0.15 });
            if (b) k.guard(V);
            yield 0.1;
        }
    };

    // ---------------------------------------------------------------------------------------
    // Finishers: deliver the lethal blow and return { kind, heavy, dramatic } at the impact moment.

    function blowFx(A, V, kind, heavy) {
        const d = dirOf(A, V);
        k.fx.impact(k.chestPos(V), d, V.isSkeleton && kind !== 'magic' ? 'bone' : kind);
        if (!k.fx.hasImpact) k.fx.burst(k.chestPos(V), kind === 'magic' ? 'magic' : 'spark', { count: heavy ? 22 : 14 });
        k.sfx(kind === 'magic' ? 'magic' : 'hit', { volume: heavy ? 1 : 0.85, rate: k.rand(0.9, 1.05) });
        k.fx.shake(heavy ? 0.9 : 0.6);
        if (k.full) k.cam.slowMo(heavy ? 0.22 : 0.3, heavy ? 0.4 : 0.3);
    }

    const FINISHERS = {
        *slash(A, V) {
            yield* swing(A, attackClip(A, [], { quick: !k.full }));
            blowFx(A, V, WEAPON[A.type].kind, false);
            return {};
        },
        *lungeStab(A, V) {
            const name = attackClip(A, ['1H_Melee_Attack_Stab']);
            const impact = k.impactOf(A, name) / aspeed();
            yield [swing(A, name), nudge(A, dirOf(A, V), 0.22, impact)];
            blowFx(A, V, 'pierce', false);
            return {};
        },
        *kickStab(A, V) {
            const kick = k.hasClip('Unarmed_Melee_Attack_Kick') ? 'Unarmed_Melee_Attack_Kick' : attackClip(A, [], { quick: true });
            yield* swing(A, kick, { speed: 1.3, trail: false });
            k.play(V, k.anim(V, 'hit', ['Hit_A']), { speed: 1.5, fade: 0.05 });
            k.sfx('thud', { volume: 0.7 });
            k.fx.burst(k.chestPos(V), 'dust', { count: 8 });
            yield* nudge(V, dirOf(A, V), 0.12, 0.15);
            yield 0.12;
            return yield* FINISHERS.lungeStab(A, V);
        },
        *jumpChop(A, V) {
            const name = k.hasClip('1H_Melee_Attack_Jump_Chop') ? '1H_Melee_Attack_Jump_Chop' : attackClip(A, ['1H_Melee_Attack_Chop']);
            const impact = k.impactOf(A, name) / aspeed();
            yield [swing(A, name), hop(A, 0.32, impact), nudge(A, dirOf(A, V), 0.15, impact)];
            k.fx.burst(k.sqPos(V.square), 'dust', { count: 12 });
            blowFx(A, V, 'slash', true);
            return { heavy: true };
        },
        *slashCombo(A, V) {
            const first = attackClip(A, ['1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Slice_Horizontal'], { quick: true });
            yield* swing(A, first, { speed: 1.3 });
            k.play(V, k.anim(V, 'hit', ['Hit_A']), { speed: 1.5, fade: 0.05 });
            k.fx.impact(k.chestPos(V), dirOf(A, V), 'slash');
            k.sfx('hit', { volume: 0.6 });
            yield 0.12;
            yield* swing(A, attackClip(A, ['1H_Melee_Attack_Chop']), { speed: 1.2 });
            blowFx(A, V, 'slash', true);
            return { heavy: true };
        },
        *barrage(A, V) {
            const a = k.play(A, ['Spellcasting', 'Spellcast_Shoot'], { loop: true, speed: 1.2, fade: 0.1 });
            for (let i = 0; i < 2; i++) {
                yield 0.12;
                yield* k.fx.bolt(k.handPos(A), k.chestPos(V), A.color, 0.2, 0.7);
                k.play(V, k.anim(V, 'hit', ['Hit_A', 'Hit_B']), { speed: 1.6, fade: 0.05 });
                k.fx.impact(k.chestPos(V), dirOf(A, V), 'magic');
                k.sfx('zap', { volume: 0.6, rate: 1 + i * 0.15 });
            }
            const s = k.play(A, ['Spellcast_Shoot'], { speed: 1.1, fade: 0.08 }) || a;
            yield k.untilClip(A, s, k.impactOf(A, 'Spellcast_Shoot'));
            yield* k.fx.bolt(k.handPos(A), k.chestPos(V), A.color, 0.25, 1.4);
            k.fx.decal(k.sqPos(V.square), 'scorch');
            blowFx(A, V, 'magic', true);
            return { heavy: true };
        },
        *skyBolt(A, V) {
            const a = k.play(A, ['Spellcast_Raise', 'Spellcast_Shoot'], { speed: 1.3 * aspeed(), fade: 0.1 });
            yield k.untilClip(A, a, k.impactOf(A, 'Spellcast_Raise'));
            const top = k.chestPos(V).add(v3().set(0, 2.2, 0));
            yield* k.fx.bolt(top, k.chestPos(V), A.color, k.full ? 0.3 : 0.12, 1.5);
            k.fx.decal(k.sqPos(V.square), 'scorch');
            blowFx(A, V, 'magic', true);
            return { heavy: true };
        },
        *smash(A, V) {
            const name = attackClip(A, ['2H_Melee_Attack_Chop', '1H_Melee_Attack_Chop']);
            yield* swing(A, name, { speed: k.full ? 1.1 : 1.8 });
            const ground = k.sqPos(V.square).lerp(k.sqPos(A.square), 0.15);
            k.fx.decal(ground, 'crack');
            k.fx.debris(ground, { kind: 'wood', count: 8, direction: dirOf(A, V) });
            k.fx.burst(ground, 'dust', { count: 20 });
            k.sfx('thud', { volume: 1 });
            blowFx(A, V, 'blunt', true);
            return { heavy: true };
        },
        *sweep(A, V) {
            yield* swing(A, attackClip(A, ['2H_Melee_Attack_Slice', '1H_Melee_Attack_Slice_Horizontal']), { speed: k.full ? 1.1 : 1.8 });
            k.fx.burst(k.sqPos(V.square), 'dust', { count: 12 });
            blowFx(A, V, 'blunt', true);
            return { heavy: true };
        },
        *spinCombo(A, V) {
            yield* swing(A, attackClip(A, ['Dualwield_Melee_Attack_Slice', 'Dualwield_Melee_Attack_Chop'], { quick: true }), { speed: 1.5 });
            k.play(V, k.anim(V, 'hit', ['Hit_A']), { speed: 1.5, fade: 0.05 });
            k.fx.impact(k.chestPos(V), dirOf(A, V), 'slash');
            k.sfx('hit', { volume: 0.6 });
            const spin = k.hasClip('2H_Melee_Attack_Spin') ? '2H_Melee_Attack_Spin' : attackClip(A);
            yield* swing(A, spin, { speed: 1.25 });
            blowFx(A, V, 'slash', true);
            return { heavy: true };
        },
        *twinSlash(A, V) {
            yield* swing(A, attackClip(A, ['Dualwield_Melee_Attack_Chop'], { quick: true }), { speed: 1.35 });
            k.play(V, k.anim(V, 'hit', ['Hit_B']), { speed: 1.5, fade: 0.05 });
            k.fx.impact(k.chestPos(V), dirOf(A, V), 'slash');
            k.sfx('hit', { volume: 0.6 });
            yield* swing(A, attackClip(A, ['Dualwield_Melee_Attack_Stab']), { speed: 1.25 });
            blowFx(A, V, 'pierce', true);
            return { heavy: true };
        },
        *royalSlash(A, V) {
            yield* swing(A, attackClip(A, ['2H_Melee_Attack_Slice', '2H_Melee_Attack_Chop', '1H_Melee_Attack_Chop']), { speed: 0.95 });
            blowFx(A, V, 'slash', true);
            k.fx.burst(k.chestPos(V), 'spark', { count: 24, color: 0xffd36a });
            return { heavy: true };
        },
        // Pawn takes queen: the tiniest stab, the biggest death.
        *tinyStab(A, V) {
            const name = attackClip(A, ['1H_Melee_Attack_Stab']);
            yield* swing(A, name, { speed: 0.85 });
            k.fx.impact(k.chestPos(V), dirOf(A, V), 'pierce');
            k.sfx('hit', { volume: 0.4, rate: 1.4 });
            k.fx.shake(0.2);
            k.cam.slowMo(0.2, 0.5);
            return { dramatic: true };
        }
    };

    // Quick single blow used by Fast mode (no clash, no camera).
    function* fastBlow(A, V) {
        if (A.type === 'b') {
            const a = k.play(A, ['Spellcast_Shoot'], { speed: 1.8, fade: 0.08 });
            yield k.untilClip(A, a, k.impactOf(A, 'Spellcast_Shoot'));
            yield* k.fx.bolt(k.handPos(A), k.chestPos(V), A.color, 0.1, 0.9);
        } else {
            yield* swing(A, attackClip(A, [], { quick: true }), { speed: 1.8 });
        }
        blowFx(A, V, WEAPON[A.type].kind, false);
        return {};
    }

    // ---------------------------------------------------------------------------------------
    // Intros (Full only)

    const INTROS = {
        *underdog(A, V) {
            // The pawn trembles; the queen laughs it off.
            const tremble = (function* () {
                k.play(A, A.isSkeleton ? ['Taunt', 'Interact'] : ['Interact', 'Idle'], { speed: 1.2, fade: 0.1 });
                const p0 = A.root.position.clone();
                yield* k.tween(0.7, t => { A.root.position.x = p0.x + Math.sin(t * 60) * 0.015 * (1 - t); });
                A.root.position.x = p0.x;
            })();
            const laugh = k.playOnce(V, V.isSkeleton ? ['Taunt', 'Cheer'] : ['Cheer', 'Taunt'], { speed: 1.3, until: 0.75 });
            k.sfx('cheer', { volume: 0.4, rate: 1.3 });
            yield [tremble, laugh];
            k.guard(V);
        },
        *taunt(A, V) {
            yield* k.playOnce(V, ['Taunt', 'Interact'], { speed: 1.4, until: 0.5 });
            k.guard(V);
        }
    };

    // ---------------------------------------------------------------------------------------
    // Death and aftermath

    function* death(A, V, info) {
        const full = k.full;
        const d = dirOf(A, V);
        k.startDeath(V);
        k.play(V, info.dramatic ? ['Hit_B', 'Hit_A'] : k.anim(V, 'hit', ['Hit_A', 'Hit_B']), { speed: 1.4, fade: 0.05 });
        yield* nudge(V, d, full ? (info.heavy ? 0.3 : 0.2) : 0.12, full ? 0.2 : 0.1);
        if (info.dramatic) yield 0.35;
        const names = V.isSkeleton ? ['Death_C_Skeletons', 'Death_A']
            : info.dramatic ? ['Death_B', 'Death_A']
                : k.anim(V, 'death', ['Death_A', 'Death_B']);
        k.fall(V, names, { speed: full ? (info.dramatic ? 0.85 : 1) : 1.8 });
        k.shrinkBase(V, full ? 0.6 : 0.25);
        if (V.isSkeleton) {
            // Skeletons collapse and shatter into bones.
            yield full ? 0.45 : 0.12;
            k.fx.debris(k.chestPos(V).setY(0.35), { kind: 'bones', count: full ? 12 : 7, direction: d });
            k.sfx('bone', { volume: 0.9 });
            yield* k.fadeOut(V, { dur: full ? 0.45 : 0.2, sink: 0.15 });
        } else {
            k.sfx('death', { volume: 0.7 });
            yield full ? (info.dramatic ? 1.0 : 0.65) : 0.2;
            // Heroes dissolve into light.
            yield* k.fadeOut(V, { dur: full ? 0.6 : 0.2, sink: 0.35, sparkle: true });
        }
    }

    function* aftermath(A, V, info, toPos, ranged) {
        const full = k.full;
        yield full ? 0.3 : 0.05;
        if (full) {
            const pose = A.isSkeleton ? ['Taunt', 'Cheer'] : k.anim(A, 'cheer', ['Cheer']);
            yield* k.playOnce(A, pose, { speed: 1.4, until: info.dramatic ? 0.9 : 0.6 });
        }
        k.cam.close();
        const dist = k.flatDist(A.root.position, toPos);
        const maxT = full ? (ranged ? 0.9 : 0.5) : (ranged ? 0.4 : 0.22);
        if (dist > 0.02) yield* k.moveTo(A, toPos, { speed: Math.max(k.walkSpeed(), dist / maxT) });
        yield* k.settle(A);
    }

    // ---------------------------------------------------------------------------------------
    // The capture sequence

    function* capture(ev, A, V) {
        const full = k.full;
        const toPos = k.sqPos(ev.to);
        const vPos = V.root.position.clone();
        const start = A.root.position.clone();
        const dist = k.flatDist(start, vPos);
        const dir = v3().subVectors(vPos, start).setY(0).normalize();
        const ranged = A.type === 'b';
        const standoff = ranged ? dist : Math.min(APPROACH, dist);
        const approach = vPos.clone().addScaledVector(dir, -standoff);
        const p = full ? plan(A, V) : { name: 'fast', clash: [], finisher: null };

        k.hideLabels([A, V]);
        k.cam.open(A, V, approach);

        // Approach: the victim turns and takes guard (or taunts) while the attacker closes in.
        const victimReady = function* () {
            yield* k.turnTo(V, k.yawBetween(vPos, approach));
            k.guard(V);
        };
        const attackerGo = function* () {
            const d = k.flatDist(start, approach);
            if (A.type === 'n' && d > 0.3) yield* k.jumpTo(A, approach, 0.5, full ? 1.35 : 1.5);
            else if (d > 0.02) yield* k.moveTo(A, approach, { speed: Math.max(k.walkSpeed(), d / (full ? 0.6 : 0.3)) });
            yield* k.turnTo(A, k.yawBetween(A.root.position, vPos), 14);
            if (!ranged) yield* combatIdle(A);
            else k.play(A, ['Idle'], { loop: true, fade: 0.12 });
        };
        yield [victimReady(), attackerGo()];

        let info;
        if (full) {
            if (p.intro) yield* INTROS[p.intro](A, V);
            else if (V.isSkeleton && !p.clash.length && Math.random() < 0.5) yield* INTROS.taunt(A, V);
            else yield 0.12;
            for (const x of p.clash) if (EXCHANGES[x]) yield* EXCHANGES[x](A, V);
            k.cam.finisher(A, V, p.shot);
            info = (yield* (FINISHERS[p.finisher] || FINISHERS.slash)(A, V)) || {};
        } else {
            info = yield* fastBlow(A, V);
        }
        info.plan = p.name;
        k.lastPlan = p.name;
        yield [death(A, V, info), aftermath(A, V, info, toPos, ranged)];
        k.cam.close();
        k.showLabels([A]);
    }

    return { capture, plan, ROLE_STYLES, PAIRINGS, EXCHANGES, FINISHERS };
}
