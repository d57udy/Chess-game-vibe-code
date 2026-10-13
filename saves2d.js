// --- START OF FILE saves2d.js ---
// Save / Load for the 2D game: autosave and resume, the Save / Load panel, PGN export and import.
// Wires the shared savegame.js (SaveGame) and savepanel.js (SavePanel) to ui.js; loaded after ui.js.
// The 3D game does the same in battle3d/saves.js.
//
// ui.js is not changed for this. What this file uses of it, by name (the scripts of the page share one
// scope): abortInFlightWork(), navigateToHistoryState(index), isInputLocked(), and it reads gameMode,
// playerColor, aiElo and gameHistory. Settings of a loaded game are applied through the page's own
// controls (mode select, strength slider, colour button), like a player would. Changes are noticed on
// screen: the move list is redrawn after every move, undo, redo and new game. Loads replay through
// battle3d/rules.js, which 2d.html loads for that purpose.
(function () {
    'use strict';

    // Records use the 3D names for the game mode
    const TO_RECORD = { 'ai-human': 'human-ai', 'human-human': 'human-human', 'ai-ai': 'ai-ai' };
    const TO_UI = { 'human-ai': 'ai-human', 'human-human': 'human-human', 'ai-ai': 'ai-ai' };
    const NOTICE_SECONDS = 6;
    const $ = (id) => document.getElementById(id);

    // Short message at the bottom of the page (a game was loaded, stored data could not be read)
    let noticeTimer = null;
    function showNotice(text) {
        let notice = $('save-notice');
        if (!notice) {
            notice = document.createElement('div');
            notice.id = 'save-notice';
            notice.className = 'save-notice';
            notice.setAttribute('role', 'status');
            document.body.append(notice);
        }
        notice.textContent = text;
        notice.hidden = false;
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => { notice.hidden = true; }, NOTICE_SECONDS * 1000);
    }

    const fire = (element, type) => element.dispatchEvent(new Event(type, { bubbles: true }));

    // Puts a game that savegame.js has just replayed into the rules state on screen. index: the history
    // position to show (the last one unless an earlier one was being looked at, or for stepping through).
    function showLoadedGame(settings, index) {
        abortInFlightWork();
        const mode = $('game-mode-select'), slider = $('ai-elo-slider');
        if (TO_UI[settings.mode] && mode.value !== TO_UI[settings.mode]) { mode.value = TO_UI[settings.mode]; fire(mode, 'change'); }
        if (Number.isFinite(settings.elo) && Number(slider.value) !== settings.elo) {
            slider.value = String(Math.max(Number(slider.min), Math.min(Number(slider.max), settings.elo)));
            fire(slider, 'input');
            fire(slider, 'change');
        }
        if ((settings.humanColor === 'w' || settings.humanColor === 'b') && settings.humanColor !== playerColor) $('switch-colors-button').click();
        // Position, status, last move, review mode, board, move list, and the AI's turn if it is due
        navigateToHistoryState(index);
    }

    function setup() {
        const session = SaveGame.createSession({
            view: '2d',
            title: document.title || 'Chess (2D)',
            settings: () => ({ mode: TO_RECORD[gameMode], humanColor: playerColor, elo: aiElo }),
            busy: () => (isInputLocked() ? 'Wait until the move has finished, then try again.' : null),
            adopt(apply, settings, { review, cursor }) {
                const result = apply();
                if (!result.ok) return result;
                const last = gameHistory.length - 1;
                const shown = review ? 0 : cursor;
                showLoadedGame(settings, Number.isInteger(shown) && shown >= 0 && shown < last ? shown : last);
                return result;
            }
        });

        // Autosave: ui.js redraws the move list after every move, undo, redo, resume and new game
        const changed = () => session.autosave();
        new MutationObserver(changed).observe($('move-history'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        $('game-mode-select').addEventListener('change', changed);
        $('ai-elo-slider').addEventListener('change', changed);
        $('switch-colors-button').addEventListener('click', changed);
        // A new game restarts the clock for the PGN Date (and clears the autosave through the redraw)
        $('new-game-button').addEventListener('click', () => session.autosave('newGame'));

        const panel = SavePanel.create({ session, classes: { primary: 'primary' }, notify: showNotice });
        $('save-open')?.addEventListener('click', (event) => panel.open('saves', event.currentTarget));
        $('export-open')?.addEventListener('click', (event) => panel.open('export', event.currentTarget));

        const { notice } = session.resume();
        if (notice) showNotice(notice);
        // For tests and the console: what the panel does, without the panel
        window.SaveHost = { session, panel, load: (record, options) => session.load(record, options), record: () => session.record() };
    }

    function start() {
        try { setup(); } catch (error) { console.error('Save and load are unavailable:', error); }
    }
    // After ui.js has started its game: its DOMContentLoaded listener was registered before this one.
    // (When the scripts are added to a running page the game already exists.)
    if (gameHistory.length) start();
    else document.addEventListener('DOMContentLoaded', start);
})();
// --- END OF FILE saves2d.js ---
