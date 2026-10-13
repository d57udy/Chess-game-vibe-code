// Save / Load for the 3D game: autosave and resume, the Save / Load panel, PGN export and import.
// The logic and the panel are shared with the 2D game and live at the site root as plain scripts that
// define globals (savegame.js -> SaveGame, savepanel.js -> SavePanel); importing them here runs them
// once, and this module re-exports the globals and wires them to the controller and the coach.
import '../savegame.js';
import '../savepanel.js';

const g = globalThis; // classic-script globals from gameLogic.js / rules.js
export const SaveGame = g.SaveGame;
export const SavePanel = g.SavePanel;

const PANEL_CLASSES = { modal: 'modal', card: 'modal-card panel', button: 'btn', primary: 'btn primary', icon: 'icon-btn' };

// Call once after the controller and the coach exist, in place of the first controller.newGame():
// when `resumed` is true the autosaved game is already on the board. `notice` is a short text to show
// when stored data could not be used. notify(text, { force, seconds }) is main.js showNotice.
export function setupSaves({ controller, coach = null, notify = null }) {
    const $ = (id) => document.getElementById(id);
    const session = SaveGame.createSession({
        view: '3d',
        title: 'Chess Battle 3D',
        settings: () => {
            const s = controller.state();
            return { mode: s.mode, humanColor: s.humanColor, elo: s.elo };
        },
        // controller.loadGame stops whatever is in flight (also a running fight), replaces the game and redraws
        adopt(apply, settings, { review }) {
            const result = controller.loadGame(apply, settings);
            if (result?.ok && review) coach?.openReview?.();
            return result;
        },
        // While an earlier position is shown (review), "Copy position" means the one on the board
        fen() {
            const index = controller.state().reviewIndex;
            return index === null || index === undefined ? g.battle3dFen() : SaveGame.fenAt(index);
        }
    });
    // 'change' fires right after every move is applied (before its animation), and on new game, undo,
    // load and when mode, side or AI strength change
    controller.onEvent((event) => { if (event.type === 'change') session.autosave(event.reason); });

    const panel = SavePanel.create({
        session,
        classes: PANEL_CLASSES,
        notify: (text) => notify?.(text, { force: true, seconds: 5 })
    });
    $('save-open')?.addEventListener('click', (event) => panel.open('saves', event.currentTarget));
    $('export-open')?.addEventListener('click', (event) => panel.open('export', event.currentTarget));

    const { resumed, notice } = session.resume();
    return { session, panel, resumed, notice };
}
