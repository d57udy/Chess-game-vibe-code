// --- START OF FILE battleFx.js ---
// "Battle chess" capture scenes: short procedural GSAP animations played in place on the board.
// Classic script exposing window.BattleFX. It works on screen-space clones of the piece glyphs inside
// .battle-layer, so it does not care how the board is oriented. It does not depend on ui.js at load
// time; playSound/sounds/PIECES/debugLog are looked up when a scene runs.
//
// A capture scene is composed as: signature[attacker>victim] if one exists, else
// attack[attacker] + impact + death[victim]; then optional promotion and check beats, then the
// attacker walks back to its square (ui.js then slides the real piece to the destination).
// Every scene resolves on the first of: timeline complete, skip(), cancelAll(), a timeout, or the
// page becoming hidden (requestAnimationFrame, and so GSAP, stops in background tabs).
(function () {
    'use strict';

    const MODES = ['full', 'fast', 'off'];
    const TIME_SCALE = { full: 1, fast: 2 };
    const STORAGE_KEY = 'chess.battleMode';
    const PARTICLE_CAP = 30;
    const TIMEOUT_SLACK_MS = 500;
    const FLASH_SECONDS = 0.03;
    const HIT_STOP_SECONDS = 0.07;

    function fxLog(...args) {
        if (typeof debugLog === 'function') debugLog(...args);
    }

    // --- Settings (localStorage may be missing or throw, e.g. in private mode) ---
    function readStoredMode() {
        try {
            const value = window.localStorage.getItem(STORAGE_KEY);
            return MODES.includes(value) ? value : null;
        } catch (e) {
            return null;
        }
    }

    function storeMode(value) {
        try {
            window.localStorage.setItem(STORAGE_KEY, value);
        } catch (e) {
            fxLog('BattleFX: could not store the mode', e);
        }
    }

    function prefersReducedMotion() {
        try {
            return typeof window.matchMedia === 'function' &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (e) {
            return false;
        }
    }

    const storedMode = readStoredMode();
    let currentMode = storedMode || (prefersReducedMotion() ? 'off' : 'full');
    let modeIsUserSet = storedMode !== null;

    function isAvailable() {
        return typeof gsap !== 'undefined' && typeof gsap.timeline === 'function' && !!findLayer();
    }

    function findLayer() {
        return document.querySelector('.battle-layer');
    }

    // --- Geometry (layer pixel coordinates) ---
    function boxOf(el, layerBox) {
        const r = el.getBoundingClientRect();
        return { x: r.left - layerBox.left, y: r.top - layerBox.top, w: r.width, h: r.height };
    }

    function centerOf(box) {
        return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    }

    // Where the attacker clone stops in front of the victim: `gap` square widths short of its center
    function contact(s, gap) {
        return { x: s.dx - s.ux * s.size * gap, y: s.dy - s.uy * s.size * gap };
    }

    // Screen offset of a logical square from the attacker's square. The board may be drawn from
    // either side; s.flip is derived by comparing the logical and screen direction to the victim.
    function offsetOfSquare(s, row, col) {
        const sign = s.flip ? -1 : 1;
        return { x: (col - s.from.col) * s.size * sign, y: (row - s.from.row) * s.size * sign };
    }

    function pointAbove(point, s, squares) {
        return { x: point.x, y: point.y - s.size * squares };
    }

    // --- Scene building blocks ---
    // Screen-space copy of a piece element; the original is hidden until the scene ends.
    function addActor(s, el) {
        const box = boxOf(el, s.layerBox);
        const clone = el.cloneNode(true);
        clone.removeAttribute('data-row');
        clone.removeAttribute('data-col');
        clone.classList.remove('toppled');
        clone.classList.add('battle-actor');
        Object.assign(clone.style, {
            left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`,
            transform: '', visibility: '', opacity: '', zIndex: ''
        });
        s.layer.appendChild(clone);
        s.nodes.push(clone);
        el.style.visibility = 'hidden';
        s.hidden.push(el);
        return { el: clone, box, center: centerOf(box) };
    }

    // Small FX element centered on a layer point; null once the particle cap is reached
    function spawn(s, className, point, text = '') {
        if (s.particles >= PARTICLE_CAP) return null;
        s.particles++;
        const el = document.createElement('div');
        el.className = `battle-fx ${className}`;
        el.textContent = text;
        el.style.left = `${point.x}px`;
        el.style.top = `${point.y}px`;
        s.layer.appendChild(el);
        s.nodes.push(el);
        gsap.set(el, { xPercent: -50, yPercent: -50, opacity: 0 });
        return el;
    }

    // n particles fly outward from a point (evenly spread with a little jitter) and fade
    function burst(s, className, text, point, n, at, { radius = 0.5, duration = 0.4, lift = 0, spin = 0 } = {}) {
        for (let i = 0; i < n; i++) {
            const el = spawn(s, className, point, typeof text === 'function' ? text(i) : text);
            if (!el) return;
            const angle = (i / n) * Math.PI * 2 + Math.random() * 0.5;
            const reach = s.size * radius * (0.7 + Math.random() * 0.5);
            s.tl.fromTo(el, { opacity: 1, scale: 0.6 }, {
                x: Math.cos(angle) * reach,
                y: Math.sin(angle) * reach - s.size * lift,
                rotation: spin * (Math.random() - 0.5),
                scale: 1,
                opacity: 0,
                duration,
                ease: 'power2.out',
                immediateRender: false // stay hidden until this beat
            }, at);
        }
    }

    function dust(s, point, n, at) {
        burst(s, 'battle-dust', '', point, n, at, { radius: 0.45, duration: 0.35, lift: 0.15 });
    }

    function sparkles(s, point, n, at) {
        burst(s, 'battle-sparkle', '✦', point, n, at, { radius: 0.6, duration: 0.45, spin: 180 });
    }

    const CONFETTI_COLORS = ['#e63946', '#f4a261', '#2a9d8f', '#457b9d', '#ffd166'];
    function confetti(s, point, n, at) {
        const start = s.particles;
        burst(s, 'battle-confetti', '', point, n, at, { radius: 0.9, duration: 0.5, lift: 0.3, spin: 540 });
        s.nodes.slice(s.nodes.length - (s.particles - start)).forEach((el, i) => {
            el.style.backgroundColor = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        });
    }

    // Speech-bubble text ("!?", "!") that pops in, holds, and fades
    function textPop(s, text, point, at, hold = 0.25) {
        const el = spawn(s, 'battle-bubble', point, text);
        if (!el) return;
        s.tl.fromTo(el, { opacity: 1, scale: 0 }, { scale: 1, duration: 0.12, ease: 'back.out(3)', immediateRender: false }, at)
            .to(el, { opacity: 0, y: -s.size * 0.2, duration: 0.12 }, `>${hold}`);
    }

    // A thin light bar from one point toward another, growing with scaleX from its start
    function beam(s, from, to, className = 'battle-beam') {
        const el = spawn(s, className, from);
        if (!el) return null;
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        el.style.width = `${length}px`;
        gsap.set(el, {
            xPercent: 0, yPercent: -50, transformOrigin: '0% 50%', scaleX: 0, opacity: 1,
            rotation: Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI
        });
        return el;
    }

    function shake(s, at, strength = 1) {
        const px = 5 * strength;
        s.tl.to(s.container, {
            keyframes: { x: [-px, px, -px * 0.6, px * 0.6, 0] },
            duration: FLASH_SECONDS + HIT_STOP_SECONDS,
            ease: 'none'
        }, at);
    }

    // Dims the board except around the two squares involved
    function spotlight(s, points) {
        const el = document.createElement('div');
        el.className = 'battle-spotlight';
        const mx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
        const my = points.reduce((sum, p) => sum + p.y, 0) / points.length;
        const radius = Math.max(...points.map(p => Math.hypot(p.x - mx, p.y - my))) + s.size * 0.8;
        el.style.background = `radial-gradient(circle at ${mx}px ${my}px, transparent ${radius}px, ` +
            `rgba(0, 0, 0, 0.3) ${radius + s.size}px)`;
        s.layer.insertBefore(el, s.layer.firstChild);
        s.nodes.push(el);
        s.tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.15 }, 0);
        return el;
    }

    // Contact frame: capture sound, white flash, short freeze (hit-stop) and board shake.
    // It starts at s.contactAt when an attack left trailing FX, else at the end of the timeline,
    // and adds the 'death' label where the victim's reaction starts.
    function impact(s, { hitStop = HIT_STOP_SECONDS, strength = 1 } = {}) {
        const { tl, v } = s;
        const at = s.contactAt !== undefined ? s.contactAt : tl.duration();
        tl.addLabel('impact', at)
            .addLabel('death', at + FLASH_SECONDS + hitStop)
            .call(() => { s.soundPlayed = playCaptureSound(); }, null, 'impact')
            .set(v.el, { filter: 'brightness(3)' }, 'impact')
            .set(v.el, { filter: 'none' }, 'death')
            .to({}, { duration: FLASH_SECONDS + hitStop }, 'impact');
        shake(s, 'impact', strength);
    }

    function playCaptureSound() {
        if (typeof playSound !== 'function' || typeof sounds === 'undefined' || !sounds.capture) return false;
        playSound(sounds.capture);
        return true;
    }

    // --- Attacks (by attacker type). Each ends at the contact frame. ---
    const attacks = {
        // Eager recruit: short hop forward, two quick jabs
        p(s) {
            const { tl, a } = s;
            const c = contact(s, 0.55);
            tl.to(a.el, { x: c.x * 0.6, y: c.y * 0.6 - s.size * 0.15, duration: 0.12, ease: 'power2.out' })
                .to(a.el, { y: c.y * 0.6, duration: 0.06, ease: 'power2.in' })
                .to(a.el, { x: c.x, y: c.y, duration: 0.05, ease: 'power1.in' })
                .to(a.el, { x: c.x * 0.8, y: c.y * 0.8, duration: 0.04 })
                .to(a.el, { x: c.x, y: c.y, duration: 0.04, ease: 'power1.in' });
        },
        // Show-off: rears back, arcs up and stomps down from above, dust on landing
        n(s) {
            const { tl, a } = s;
            const c = contact(s, 0.45);
            tl.to(a.el, { rotation: -15 * s.side, scaleY: 0.9, duration: 0.08 })
                .to(a.el, { x: c.x * 0.6, y: c.y * 0.6 - s.size * 0.9, rotation: 10 * s.side, scale: 1.15, duration: 0.2, ease: 'power2.out' })
                .to(a.el, { x: c.x, y: c.y, rotation: 0, scale: 1, duration: 0.12, ease: 'power4.in' });
            s.contactAt = tl.duration();
            dust(s, { x: s.A.x + c.x, y: s.A.y + c.y + s.size * 0.35 }, 4, s.contactAt);
        },
        // Wizard: sways, glows, fires a thin beam
        b(s) {
            const { tl, a } = s;
            tl.to(a.el, { rotation: -8, duration: 0.08 })
                .to(a.el, { rotation: 8, duration: 0.1 })
                .set(a.el, { filter: 'brightness(1.6)' })
                .to(a.el, { rotation: 0, duration: 0.07 });
            const ray = beam(s, s.A, s.V);
            if (ray) tl.to(ray, { scaleX: 1, duration: 0.14, ease: 'power2.in' });
            s.contactAt = tl.duration();
            if (ray) tl.to(ray, { opacity: 0, duration: 0.1 }, s.contactAt);
            tl.set(a.el, { filter: 'none' }, s.contactAt);
        },
        // Heavy brute: slow wind-up squash, straight charge, slam (extra shake in impact)
        r(s) {
            const { tl, a } = s;
            const c = contact(s, 0.55);
            tl.to(a.el, { x: -s.ux * s.size * 0.12, y: -s.uy * s.size * 0.12, scaleX: 1.2, scaleY: 0.75, duration: 0.14, ease: 'power1.out' })
                .to(a.el, { x: c.x, y: c.y, scaleX: 0.9, scaleY: 1.1, duration: 0.16, ease: 'power3.in' })
                .to(a.el, { scaleX: 1.15, scaleY: 0.85, duration: 0.05 });
            s.impactStrength = 2;
        },
        // Diva: a quick spin, then a volley of stars toward the victim
        q(s) {
            const { tl, a } = s;
            tl.to(a.el, { rotation: 360, scale: 1.15, duration: 0.25, ease: 'power2.inOut' })
                .set(a.el, { rotation: 0 })
                .addLabel('volley')
                .to(a.el, { scale: 1, duration: 0.1 }, 'volley');
            for (let i = 0; i < 5; i++) {
                const star = spawn(s, 'battle-star', s.A, '★');
                if (!star) break;
                tl.fromTo(star, { opacity: 1, scale: 0.5 },
                    { x: s.dx, y: s.dy, scale: 1, rotation: 180, duration: 0.15, ease: 'power1.in', immediateRender: false }, `volley+=${i * 0.03}`)
                    .set(star, { opacity: 0 }, '>');
            }
        },
        // Reluctant royal: dignified walk, a tiny "ahem" pause, one bonk with a bounce
        k(s) {
            const { tl, a } = s;
            const c = contact(s, 0.6);
            tl.to(a.el, { x: c.x * 0.5, y: c.y * 0.5, rotation: 4, duration: 0.15, ease: 'none' })
                .to(a.el, { x: c.x * 0.85, y: c.y * 0.85, rotation: -4, duration: 0.12, ease: 'none' })
                .to(a.el, { rotation: 0, duration: 0.06 })
                .to(a.el, { x: c.x, y: c.y - s.size * 0.12, duration: 0.06, ease: 'power2.in' })
                .to(a.el, { y: c.y, duration: 0.06, ease: 'bounce.out' });
        }
    };

    // Fallback attack for unknown types: a quick lunge
    function lunge(s) {
        const c = contact(s, 0.6);
        s.tl.to(s.a.el, { x: c.x, y: c.y, duration: 0.2, ease: 'power2.in' });
    }

    // --- Deaths (by victim type), starting at the 'death' label. The king is never captured. ---
    const deaths = {
        // Flattened, then a dust poof
        p(s) {
            const { tl, v } = s;
            tl.to(v.el, { scaleY: 0.1, scaleX: 1.3, transformOrigin: '50% 85%', duration: 0.12, ease: 'power2.in' }, 'death')
                .to(v.el, { opacity: 0, duration: 0.15 }, 'death+=0.12');
            dust(s, { x: s.V.x, y: s.V.y + s.size * 0.3 }, 6, 'death+=0.08');
        },
        // Launched: spins off in an arc and fades
        n(s) {
            const { tl, v } = s;
            tl.to(v.el, { x: s.side * s.size * 2.5, rotation: 540 * s.side, duration: 0.45, ease: 'none' }, 'death')
                .to(v.el, { y: -s.size * 1.1, duration: 0.18, ease: 'power2.out' }, 'death')
                .to(v.el, { y: s.size * 0.6, duration: 0.27, ease: 'power2.in' }, 'death+=0.18')
                .to(v.el, { opacity: 0, duration: 0.15 }, 'death+=0.3');
        },
        // Topples over, then rolls away
        b(s) {
            const { tl, v } = s;
            tl.to(v.el, { rotation: 90 * s.side, transformOrigin: '50% 85%', duration: 0.18, ease: 'bounce.out' }, 'death')
                .to(v.el, { x: s.side * s.size * 1.4, rotation: `+=${360 * s.side}`, opacity: 0, duration: 0.22, ease: 'power1.in' }, '>');
        },
        // Crumbles: four quadrant copies (clip-path) fall with gravity and fade
        r(s) {
            const { tl, v } = s;
            const quadrants = [
                ['inset(0 50% 50% 0)', -1, 0], ['inset(0 0 50% 50%)', 1, 0],
                ['inset(50% 50% 0 0)', -1, 1], ['inset(50% 0 0 50%)', 1, 1]
            ];
            tl.set(v.el, { opacity: 0 }, 'death');
            quadrants.forEach(([clip, sx, low]) => {
                if (s.particles >= PARTICLE_CAP) return;
                s.particles++;
                const chunk = v.el.cloneNode(true);
                chunk.classList.replace('battle-actor', 'battle-fx');
                chunk.style.clipPath = chunk.style.webkitClipPath = clip;
                chunk.style.opacity = '0';
                s.layer.appendChild(chunk);
                s.nodes.push(chunk);
                tl.fromTo(chunk, { opacity: 1 }, {
                    x: sx * s.size * (0.2 + Math.random() * 0.15),
                    y: s.size * (0.5 + low * 0.2),
                    rotation: sx * (15 + Math.random() * 25),
                    opacity: 0,
                    duration: 0.45,
                    ease: 'power2.in',
                    immediateRender: false
                }, 'death');
            });
            dust(s, { x: s.V.x, y: s.V.y + s.size * 0.3 }, 5, 'death');
        },
        // Dramatic swoon: sway, faint, sparkle fade
        q(s) {
            const { tl, v } = s;
            tl.to(v.el, { rotation: -12, transformOrigin: '50% 85%', duration: 0.15, ease: 'sine.inOut' }, 'death')
                .to(v.el, { rotation: 10, duration: 0.12, ease: 'sine.inOut' }, '>')
                .to(v.el, { rotation: -80, y: s.size * 0.2, scale: 0.9, duration: 0.15, ease: 'power2.in' }, '>')
                .to(v.el, { opacity: 0, duration: 0.1 }, '>');
            sparkles(s, s.V, 6, '<-0.1');
        }
    };

    // Fallback death for unknown types
    function fade(s) {
        s.tl.to(s.v.el, { opacity: 0, scale: 0.6, duration: 0.25 }, 'death');
    }

    // --- Signature scenes (replace attack + impact + death for special pairings) ---
    const signatures = {
        // Underdog: the pawn hesitates ("!?"), a tiny jab, the queen overacts a very long swoon
        'p>q'(s) {
            const { tl, a, v } = s;
            const c = contact(s, 0.55);
            tl.to(a.el, { x: c.x * 0.3, y: c.y * 0.3, duration: 0.15 })
                .to(a.el, { x: c.x * 0.15, y: c.y * 0.15, duration: 0.12, ease: 'sine.inOut' });
            textPop(s, '!?', pointAbove(s.A, s, 0.6), '<', 0.2);
            tl.to(a.el, { x: c.x, y: c.y, duration: 0.08, ease: 'power2.in' }, '>0.05');
            impact(s, { hitStop: 0.12 });
            tl.to(v.el, { rotation: -15, transformOrigin: '50% 85%', duration: 0.14, ease: 'sine.inOut' }, 'death')
                .to(v.el, { rotation: 12, duration: 0.14, ease: 'sine.inOut' }, '>')
                .to(v.el, { rotation: -18, duration: 0.14, ease: 'sine.inOut' }, '>')
                .to(v.el, { rotation: 8, duration: 0.12, ease: 'sine.inOut' }, '>')
                .to(v.el, { rotation: -90, y: s.size * 0.2, duration: 0.2, ease: 'bounce.out' }, '>')
                .to(v.el, { opacity: 0, duration: 0.15 }, '>');
            sparkles(s, s.V, 8, '<-0.1');
        },
        // Overkill: a flick of the wrist and the pawn is launched off the board with a "ping"
        'q>p'(s) {
            const { tl, a, v } = s;
            tl.to(a.el, { rotation: -20 * s.side, duration: 0.15, ease: 'power1.out' })
                .to(a.el, { rotation: 15 * s.side, duration: 0.06, ease: 'power3.in' });
            impact(s, { hitStop: 0.05 });
            tl.to(v.el, { x: s.side * s.size * 6, y: -s.size * 3, rotation: 720 * s.side, scale: 0.5, duration: 0.5, ease: 'power1.in' }, 'death')
                .to(v.el, { opacity: 0, duration: 0.15 }, 'death+=0.35')
                .to(a.el, { rotation: 0, duration: 0.15 }, 'death');
            textPop(s, 'ping!', pointAbove(s.V, s, 0.5), 'death', 0.15);
        },
        // Joust: both lean in, the knight vaults over, the queen spins out
        'n>q'(s) {
            const { tl, a, v } = s;
            const beyond = { x: s.dx + s.ux * s.size * 0.7, y: s.dy + s.uy * s.size * 0.7 };
            tl.to(a.el, { rotation: 12 * s.side, duration: 0.2 })
                .to(v.el, { rotation: -12 * s.side, duration: 0.2 }, '<')
                .to(a.el, { x: s.dx * 0.5, y: s.dy * 0.5 - s.size * 0.8, rotation: -10 * s.side, duration: 0.2, ease: 'power2.out' })
                .to(a.el, { x: s.dx, y: s.dy - s.size * 1.1, rotation: 0, duration: 0.12, ease: 'none' });
            impact(s);
            tl.to(a.el, { x: beyond.x, y: beyond.y, duration: 0.18, ease: 'power2.in' }, 'death')
                .to(v.el, { rotation: 720 * s.side, scale: 0.3, opacity: 0, x: -s.uy * s.size, y: s.ux * s.size, duration: 0.45, ease: 'power2.in' }, 'death');
            dust(s, { x: s.A.x + beyond.x, y: s.A.y + beyond.y + s.size * 0.35 }, 4, 'death+=0.18');
        },
        // Sumo shove: both squash against each other, then the victim is pushed off
        'r>r'(s) {
            const { tl, a, v } = s;
            const c = contact(s, 0.8);
            const push = { x: s.ux * s.size * 0.15, y: s.uy * s.size * 0.15 };
            tl.to(a.el, { x: c.x, y: c.y, duration: 0.25, ease: 'power2.in' })
                .to([a.el, v.el], { scaleX: 1.2, scaleY: 0.85, duration: 0.1 })
                .to(a.el, { x: c.x - push.x, y: c.y - push.y, duration: 0.12, ease: 'sine.inOut' })
                .to(v.el, { x: -push.x, y: -push.y, duration: 0.12, ease: 'sine.inOut' }, '<')
                .to(a.el, { x: c.x + push.x, y: c.y + push.y, duration: 0.12, ease: 'sine.inOut' })
                .to(v.el, { x: push.x, y: push.y, duration: 0.12, ease: 'sine.inOut' }, '<');
            impact(s, { strength: 2 });
            tl.to(a.el, { scaleX: 1, scaleY: 1, duration: 0.1 }, 'death')
                .to(v.el, { x: s.ux * s.size * 2.2, y: s.uy * s.size * 2.2, rotation: 25 * s.side, scaleX: 1, scaleY: 1, opacity: 0, duration: 0.4, ease: 'power2.in' }, 'death');
            dust(s, { x: s.V.x, y: s.V.y + s.size * 0.3 }, 5, 'death');
        },
        // Wizard duel: two beams meet in the middle, the victim's beam loses
        'b>b'(s) {
            const { tl, a, v } = s;
            const middle = { x: (s.A.x + s.V.x) / 2, y: (s.A.y + s.V.y) / 2 };
            tl.set([a.el, v.el], { filter: 'brightness(1.6)' })
                .to([a.el, v.el], { rotation: 8, duration: 0.1 })
                .to([a.el, v.el], { rotation: 0, duration: 0.1 });
            const mine = beam(s, s.A, s.V);
            const theirs = beam(s, s.V, middle, 'battle-beam battle-beam-enemy');
            if (mine && theirs) {
                tl.addLabel('beams')
                    .to(mine, { scaleX: 0.5, duration: 0.18, ease: 'power2.out' }, 'beams')
                    .to(theirs, { scaleX: 1, duration: 0.18, ease: 'power2.out' }, 'beams')
                    .to(mine, { scaleX: 0.42, duration: 0.15, ease: 'sine.inOut' }, '>')
                    .to(theirs, { scaleX: 1.15, duration: 0.15, ease: 'sine.inOut' }, '<')
                    .to(mine, { scaleX: 1, duration: 0.15, ease: 'power3.in' }, '>')
                    .to(theirs, { scaleX: 0, duration: 0.15, ease: 'power3.in' }, '<');
            }
            s.contactAt = tl.duration();
            if (mine && theirs) sparkles(s, middle, 5, 'beams+=0.18');
            impact(s);
            if (mine) tl.to(mine, { opacity: 0, duration: 0.1 }, 'impact');
            tl.set(a.el, { filter: 'none' }, 'impact');
            deaths.b(s);
        },
        // En passant: step behind the victim, tap its shoulder, a double take, and it slides off
        enPassant(s) {
            const { tl, a, v } = s;
            const behind = offsetOfSquare(s, s.to.row, s.to.col);
            const lean = { x: (s.dx - behind.x) * 0.25, y: (s.dy - behind.y) * 0.25 };
            tl.to(a.el, { x: behind.x, y: behind.y - s.size * 0.15, duration: 0.15, ease: 'power2.out' })
                .to(a.el, { y: behind.y, duration: 0.08, ease: 'power2.in' })
                .to(a.el, { x: behind.x + lean.x, y: behind.y + lean.y, rotation: 10 * s.side, duration: 0.08 })
                .to(a.el, { x: behind.x, y: behind.y, rotation: 0, duration: 0.08 })
                .to(v.el, { rotation: 15, duration: 0.07 })
                .to(v.el, { rotation: -15, duration: 0.07 })
                .to(v.el, { rotation: 0, duration: 0.07 });
            textPop(s, '?', pointAbove(s.V, s, 0.6), '<', 0.15);
            tl.to(a.el, { x: behind.x + lean.x, y: behind.y + lean.y, duration: 0.06 }, '>0.05');
            impact(s, { hitStop: 0.05 });
            tl.to(v.el, { x: s.side * s.size * 1.5, opacity: 0, duration: 0.3, ease: 'power2.in' }, 'death');
        }
    };

    // --- Closing beats ---
    // The attacker clone walks back to its own square (ui.js then slides the real piece)
    function settle(s) {
        s.tl.to(s.a.el, { x: 0, y: 0, rotation: 0, scale: 1, filter: 'none', duration: 0.15, ease: 'power2.inOut' });
    }

    // Promotion: the pawn glows, spins, and pops into its new piece with confetti
    function promote(s) {
        const { tl, a } = s;
        const glyph = glyphFor(s.promotedPiece);
        tl.set(a.el, { filter: 'brightness(1.8)' })
            .to(a.el, { rotation: 360, scale: 1.3, duration: 0.25, ease: 'power2.in' })
            .call(() => {
                if (glyph) a.el.textContent = glyph;
                a.el.dataset.piece = s.promotedPiece;
            })
            .set(a.el, { rotation: 0, filter: 'none' })
            .to(a.el, { scale: 1, duration: 0.15, ease: 'back.out(3)' });
        confetti(s, s.A, 10, '<');
    }

    // Check: a "!" pops above the enemy king
    function pointAtKing(s, kingEl) {
        const king = centerOf(boxOf(kingEl, s.layerBox));
        textPop(s, '!', pointAbove(king, s, 0.55), '>', 0.3);
    }

    function fadeSpotlight(s) {
        if (s.spot) s.tl.to(s.spot, { opacity: 0, duration: 0.15 }, Math.max(0, s.tl.duration() - 0.15));
    }

    function glyphFor(piece) {
        return typeof PIECES !== 'undefined' && PIECES[piece] ? PIECES[piece] : null;
    }

    function pieceType(piece) {
        return typeof piece === 'string' ? piece.toLowerCase() : '';
    }

    // --- Scene runner ---
    let finishActive = null; // finish() of the running scene, if any

    const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'];
    // Keys that operate the focused control; everything else skips the scene
    const CONTROL_KEYS = {
        BUTTON: [' ', 'Enter'],
        SELECT: [' ', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']
    };

    function isTextEntry(target) {
        const tag = target && target.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || !!(target && target.isContentEditable);
    }

    function isSkipKey(event) {
        if (event.metaKey || event.ctrlKey || event.altKey || MODIFIER_KEYS.includes(event.key)) return false;
        if (isTextEntry(event.target)) return false;
        const controlKeys = CONTROL_KEYS[event.target && event.target.tagName];
        return !(controlKeys && controlKeys.includes(event.key));
    }

    // Builds a scene with build(s), plays it, and resolves s.soundPlayed when it ends for any reason.
    // cleanup(s) runs once, after the clones are gone and the hidden originals are visible again.
    function runScene(mode, build, cleanup) {
        const layer = findLayer();
        const container = layer.closest('.board-container') || layer.parentElement;
        const s = {
            tl: gsap.timeline({ paused: true }),
            layer, container, layerBox: layer.getBoundingClientRect(),
            nodes: [], hidden: [], particles: 0, soundPlayed: false
        };

        return new Promise(resolve => {
            let done = false;
            let timeoutId = null;
            const onVisibilityChange = () => {
                if (document.visibilityState === 'hidden') finish();
            };
            // Capture phase on the board area: a click skips the scene and never reaches the board
            const onClick = (event) => {
                event.stopPropagation();
                event.preventDefault();
                finish();
            };
            const onKeyDown = (event) => {
                if (!isSkipKey(event)) return;
                event.stopPropagation();
                event.preventDefault();
                finish();
            };

            function finish() {
                if (done) return;
                done = true;
                clearTimeout(timeoutId);
                document.removeEventListener('visibilitychange', onVisibilityChange);
                container.removeEventListener('click', onClick, true);
                window.removeEventListener('keydown', onKeyDown, true);
                s.tl.kill();
                s.nodes.forEach(node => { gsap.killTweensOf(node); node.remove(); });
                gsap.killTweensOf(container);
                gsap.set(container, { clearProps: 'transform' });
                s.hidden.forEach(el => { el.style.visibility = ''; });
                try {
                    cleanup(s);
                } catch (error) {
                    console.error('BattleFX: cleanup failed:', error);
                }
                if (finishActive === finish) finishActive = null;
                resolve(s.soundPlayed);
            }

            finishActive = finish;
            try {
                build(s);
            } catch (error) {
                console.error('BattleFX: could not build the scene:', error);
                finish();
                return;
            }
            if (document.visibilityState === 'hidden') {
                finish();
                return;
            }
            s.tl.timeScale(TIME_SCALE[mode] || 1);
            const expectedMs = (s.tl.duration() / s.tl.timeScale()) * 1000;
            timeoutId = setTimeout(() => {
                fxLog('BattleFX: scene timed out');
                finish();
            }, expectedMs + TIMEOUT_SLACK_MS);
            document.addEventListener('visibilitychange', onVisibilityChange);
            container.addEventListener('click', onClick, true);
            window.addEventListener('keydown', onKeyDown, true);
            s.tl.eventCallback('onComplete', finish);
            s.tl.play();
        });
    }

    // Fills in the actors and directions shared by all capture scenes
    function setUpCapture(s, args) {
        s.a = addActor(s, args.attackerEl);
        s.v = addActor(s, args.victimEl);
        s.A = s.a.center;
        s.V = s.v.center;
        s.size = s.a.box.w || s.v.box.w;
        s.dx = s.V.x - s.A.x;
        s.dy = s.V.y - s.A.y;
        const dist = Math.hypot(s.dx, s.dy);
        s.ux = dist ? s.dx / dist : 0;
        s.uy = dist ? s.dy / dist : 0;
        s.side = s.dx < 0 ? -1 : 1;
        s.ctx = args.ctx || {};
        s.from = args.from || null;
        s.to = args.to || null;
        s.flip = isFlipped(s, args);
        s.a.el.style.zIndex = '2';
        s.spot = spotlight(s, [s.A, s.V]);
    }

    // True when the board is drawn from Black's side (screen direction opposes logical direction)
    function isFlipped(s, args) {
        if (!s.from) return false;
        const sq = args.victimSquareEl && args.victimSquareEl.dataset;
        const row = sq && sq.row !== undefined ? Number(sq.row) : (s.to ? s.to.row : s.from.row);
        const col = sq && sq.col !== undefined ? Number(sq.col) : (s.to ? s.to.col : s.from.col);
        return (col - s.from.col) * s.dx + (row - s.from.row) * s.dy < 0;
    }

    function composeCapture(s, attackerType, victimType, args) {
        const signature = s.ctx.enPassant && s.from && s.to
            ? signatures.enPassant
            : signatures[`${attackerType}>${victimType}`];
        if (signature) {
            signature(s);
        } else {
            (attacks[attackerType] || lunge)(s);
            impact(s, { strength: s.impactStrength || 1 });
            (deaths[victimType] || fade)(s);
        }
        settle(s);
        if (s.ctx.promotionTo) {
            const white = args.attackerPiece === args.attackerPiece.toUpperCase();
            s.promotedPiece = white ? s.ctx.promotionTo.toUpperCase() : s.ctx.promotionTo.toLowerCase();
            promote(s);
        }
        if (args.checkedKingEl) pointAtKing(s, args.checkedKingEl);
        fadeSpotlight(s);
    }

    // --- Public API ---
    // Resolves true if the scene played the capture sound. The victim element is always removed
    // and the attacker element visible again when it resolves; it never rejects.
    function play(args = {}) {
        const { attackerEl, victimEl } = args;
        const mode = args.mode || currentMode;
        cancelAll();
        if (mode === 'off' || !isAvailable() || !attackerEl || !victimEl) {
            if (victimEl) victimEl.remove();
            return Promise.resolve(false);
        }
        const attackerPiece = args.attackerPiece || attackerEl.dataset.piece || '';
        const victimPiece = args.victimPiece || victimEl.dataset.piece || '';
        const fullArgs = { ...args, attackerPiece, victimPiece };
        fxLog(`BattleFX: ${attackerPiece} takes ${victimPiece} (${mode})`);
        return runScene(mode, s => {
            setUpCapture(s, fullArgs);
            composeCapture(s, pieceType(attackerPiece), pieceType(victimPiece), fullArgs);
        }, s => {
            victimEl.remove();
            // The logical board already holds the promoted piece; show it on the real element too
            if (s.promotedPiece) {
                attackerEl.dataset.piece = s.promotedPiece;
                const glyph = glyphFor(s.promotedPiece);
                if (glyph) attackerEl.textContent = glyph;
            }
        });
    }

    // Checkmate: the king wobbles, topples, and a tiny crown rolls off. The real king element is
    // left with the .toppled class (renderBoard replaces it on undo/navigation).
    function playFinale(args = {}) {
        const { kingEl } = args;
        const mode = args.mode || currentMode;
        cancelAll();
        if (mode === 'off' || !isAvailable() || !kingEl) return Promise.resolve();
        return runScene(mode, s => {
            const king = addActor(s, kingEl);
            s.size = king.box.w;
            s.spot = spotlight(s, [king.center]);
            const { tl } = s;
            tl.to(king.el, { rotation: -10, transformOrigin: '50% 85%', duration: 0.12, ease: 'sine.inOut' }, 0.15);
            for (let i = 0; i < 3; i++) {
                tl.to(king.el, { rotation: 10, duration: 0.12, ease: 'sine.inOut' })
                    .to(king.el, { rotation: -10, duration: 0.12, ease: 'sine.inOut' });
            }
            tl.to(king.el, { rotation: 90, duration: 0.5, ease: 'bounce.out' });
            dust(s, { x: king.center.x + s.size * 0.3, y: king.center.y + s.size * 0.35 }, 6, '<0.15');
            const crown = spawn(s, 'battle-crown', pointAbove(king.center, s, 0.35), glyphFor(args.kingPiece || kingEl.dataset.piece) || '♚');
            if (crown) {
                tl.set(crown, { opacity: 1 }, '<')
                    .to(crown, { x: s.size * 1.3, y: s.size * 0.65, rotation: 360, duration: 0.7, ease: 'power1.in' }, '<')
                    .to(crown, { opacity: 0, duration: 0.2 }, '>-0.2');
            }
            tl.to({}, { duration: 0.3 });
            fadeSpotlight(s);
        }, () => {
            kingEl.classList.add('toppled');
        }).then(() => undefined);
    }

    function skip() {
        if (finishActive) finishActive();
    }

    // Ends any running scene immediately (undo, new game, navigation). Same cleanup as skip().
    function cancelAll() {
        if (finishActive) finishActive();
    }

    window.BattleFX = {
        play,
        playFinale,
        skip,
        cancelAll,
        isPlaying: () => finishActive !== null,
        isAvailable,
        get mode() { return currentMode; },
        set mode(value) {
            if (!MODES.includes(value)) {
                fxLog('BattleFX: ignoring unknown mode', value);
                return;
            }
            currentMode = value;
            modeIsUserSet = true;
            storeMode(value);
            if (value === 'off') skip();
        },
        // False until the user picks a mode (the default may then be adjusted, e.g. Fast for AI vs AI)
        get modeIsUserSet() { return modeIsUserSet; },
        modes: MODES.slice(),
        attacks,
        deaths,
        signatures
    };
})();
// --- END OF FILE battleFx.js ---
