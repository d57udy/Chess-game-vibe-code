// --- START OF FILE savepanel.js ---
// The "Save / Load" panel shared by the 2D and the 3D game: named saves, PGN export (copy, share,
// download), FEN copy and PGN import. A modal dialog with three tabs, built here so both pages only
// add a button; each page styles the save-* classes its own way (battle3d/hud.css, style.css).
// All game logic is in savegame.js (SaveGame.createSession); this file is DOM only.
//
// Loaded like savegame.js: a classic script on the 2D page, `import '../savepanel.js'` from
// battle3d/saves.js on the 3D page. Defines the global `SavePanel`.
//
//   const panel = SavePanel.create({ session, classes, notify });
//   panel.open('saves' | 'export' | 'import', openerButton);   panel.close();   panel.isOpen();
//
// classes: extra class names so the panel picks up the page's look:
//   { modal, card, button, primary, icon }   e.g. 3D: { modal: 'modal', card: 'modal-card panel', button: 'btn', ... }
// notify(text): optional, shows a short message in the game after the panel closed (a game was loaded).
(function (root) {
    'use strict';

    const TABS = [['saves', 'Saved games'], ['export', 'Export'], ['import', 'Import']];
    const MAX_FILE_BYTES = 1000000;
    const SAVE_ERRORS = {
        full: (max) => `All ${max} save slots are used. Delete a save to make room.`,
        storage: () => 'Could not save: the browser storage is full or blocked.',
        name: () => 'There is no game to save yet.',
        exists: () => 'Another save already has that name.'
    };

    // el('button', { class: 'x', type: 'button', text: 'Save', hidden: true }, child, ...)
    function el(tag, attrs = {}, ...children) {
        const node = root.document.createElement(tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (value === false || value === null || value === undefined) continue;
            if (key === 'text') node.textContent = value;
            else if (key === 'class') node.className = value;
            else node.setAttribute(key, value === true ? '' : value);
        }
        node.append(...children);
        return node;
    }

    function create({ session, classes = {}, notify = null }) {
        const doc = root.document;
        const SG = root.SaveGame;
        const cls = { modal: '', card: '', button: '', primary: '', icon: '', ...classes };
        const button = (id, text, extra = '') => el('button', { type: 'button', id, class: `${extra || cls.button} save-btn`.trim(), text });

        // --- Markup ---
        const title = el('h2', { id: 'save-title', tabindex: '-1', text: 'Save, load, export' });
        const closeButton = el('button', { type: 'button', id: 'save-close', class: `${cls.icon} save-close`.trim(), 'aria-label': 'Close', text: '×' });
        const status = el('p', { id: 'save-status', class: 'save-status', role: 'status', 'aria-live': 'polite' });

        const tabs = {}, panes = {};
        const tablist = el('div', { class: 'save-tabs', role: 'tablist', 'aria-label': 'Save, load, export' });
        for (const [key, label] of TABS) {
            tabs[key] = el('button', { type: 'button', role: 'tab', id: `save-tab-${key}`, 'aria-controls': `save-pane-${key}`, class: 'save-tab', text: label });
            panes[key] = el('section', { role: 'tabpanel', id: `save-pane-${key}`, 'aria-labelledby': `save-tab-${key}`, class: 'save-pane' });
            tablist.append(tabs[key]);
        }

        // Saved games
        const nameInput = el('input', { id: 'save-name', type: 'text', maxlength: String(SG.MAX_NAME), autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'done', spellcheck: 'false' });
        const saveButton = el('button', { type: 'submit', id: 'save-submit', class: `${cls.primary || cls.button} save-btn`.trim(), text: 'Save' });
        const count = el('p', { id: 'save-count', class: 'save-note' });
        const form = el('form', { id: 'save-form', class: 'save-form', novalidate: true },
            el('label', { for: 'save-name', text: 'Save this game as' }),
            el('div', { class: 'save-row' }, nameInput, saveButton),
            count);
        const list = el('ul', { id: 'save-list', class: 'save-list', 'aria-label': 'Saved games' });
        const empty = el('p', { id: 'save-empty', class: 'save-note', text: 'No saved games yet.' });
        panes.saves.append(form, list, empty);

        // Export
        const pgnArea = el('textarea', { id: 'save-pgn', class: 'save-text', rows: '7', readonly: true, spellcheck: 'false', wrap: 'soft' });
        const copyButton = button('save-copy', 'Copy moves', cls.primary);
        const shareButton = button('save-share', 'Share');
        const downloadButton = button('save-download', 'Download .pgn');
        const fenInput = el('input', { id: 'save-fen', class: 'save-text', type: 'text', readonly: true, spellcheck: 'false' });
        const fenButton = button('save-copy-fen', 'Copy position (FEN)');
        panes.export.append(
            el('label', { for: 'save-pgn', text: 'This game as PGN (standard notation, opens in any chess app)' }), pgnArea,
            el('div', { class: 'save-buttons' }, copyButton, shareButton, downloadButton),
            el('label', { for: 'save-fen', text: 'Position on the board (FEN)' }),
            el('div', { class: 'save-row' }, fenInput, fenButton),
            el('p', { class: 'save-note', text: 'Everything stays on this device until you share it.' }));

        // Import
        const importArea = el('textarea', { id: 'save-import-text', class: 'save-text', rows: '6', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', placeholder: '1. e4 e5 2. Nf3 Nc6 ...', 'aria-describedby': 'save-import-error' });
        const fileInput = el('input', { id: 'save-import-file', type: 'file', hidden: true, tabindex: '-1' });
        const fileButton = button('save-import-pick', 'Choose a .pgn file');
        const importError = el('p', { id: 'save-import-error', class: 'save-error', role: 'alert' });
        const playButton = button('save-import-play', 'Load and play', cls.primary);
        const reviewButton = button('save-import-review', session.view === '2d' ? 'Load and step through' : 'Load and review');
        panes.import.append(
            el('label', { for: 'save-import-text', text: 'Paste a game (PGN or just the moves)' }), importArea,
            importError,
            el('div', { class: 'save-buttons' }, playButton, reviewButton),
            el('div', { class: 'save-buttons' }, fileButton, fileInput));

        // Inline confirmation (delete, replace, leaving an unsaved game): replaces the tab content while it asks
        const confirmText = el('p', { id: 'save-confirm-text' });
        const confirmYes = button('save-confirm-yes', 'OK', cls.primary);
        const confirmNo = button('save-confirm-no', 'Cancel');
        const confirmBox = el('div', { id: 'save-confirm', class: 'save-confirm', role: 'alertdialog', 'aria-modal': 'false', 'aria-labelledby': 'save-confirm-text', hidden: true },
            confirmText, el('div', { class: 'save-buttons' }, confirmNo, confirmYes));

        const card = el('div', { class: `${cls.card} save-card`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'save-title' },
            el('div', { class: 'save-head' }, title, closeButton),
            tablist, status, confirmBox, panes.saves, panes.export, panes.import);
        const modal = el('div', { id: 'save-modal', class: `${cls.modal} save-modal`.trim(), hidden: true }, card);
        doc.body.append(modal);

        // --- State ---
        let tab = 'saves';
        let opener = null;
        let pending = null;        // { yes, back } while the confirmation shows
        let renaming = null;       // id of the save being renamed

        const say = (text) => { status.textContent = ''; status.textContent = text || ''; };
        const focus = (node) => { try { node?.focus?.(); } catch (e) { /* ignore */ } };
        const safe = (fn) => { try { return fn(); } catch (e) { return null; } };

        // --- Tabs ---
        function showTab(next, { focusTab = false } = {}) {
            tab = TABS.some(([key]) => key === next) ? next : 'saves';
            for (const [key] of TABS) {
                const on = key === tab;
                tabs[key].setAttribute('aria-selected', String(on));
                tabs[key].tabIndex = on ? 0 : -1;
                tabs[key].classList.toggle('active', on);
                panes[key].hidden = !on || !!pending;
            }
            if (tab === 'saves') renderSaves();
            if (tab === 'export') renderExport();
            if (focusTab) focus(tabs[tab]);
        }

        // --- Saved games ---
        function renderSaves() {
            const saves = session.store.list();
            const max = session.store.max;
            const current = safe(() => session.record());
            const hasMoves = !!current && (current.moves.length > 0 || !!current.startFen);
            const full = saves.length >= max;
            const savedAs = current && current.moves.length ? saves.find(s => SG.sameGame(s, current)) : null;
            nameInput.disabled = saveButton.disabled = !hasMoves;
            if (doc.activeElement !== nameInput) nameInput.value = hasMoves ? (savedAs?.name || session.defaultName()) : '';
            let note = `${saves.length} of ${max} saves used.`;
            if (!hasMoves) note = `No moves yet, so there is nothing to save. ${note}`;
            else if (full) note = `All ${max} save slots are used. Delete a save to add another, or reuse a name to replace it.`;
            else if (savedAs) note = `This game is saved as "${savedAs.name}". ${note}`;
            if (session.store.problem()) note += ' Older saves could not be read and were set aside.';
            count.textContent = note;
            count.classList.toggle('full', full);

            list.textContent = '';
            for (const save of saves) list.append(save.id === renaming ? renameItem(save) : saveItem(save));
            empty.hidden = saves.length > 0;
        }

        function saveItem(save) {
            const act = (action, text) => el('button', { type: 'button', class: `${cls.button} save-btn save-act`.trim(), 'data-action': action, 'data-id': save.id, 'aria-label': `${text} ${save.name}`, text });
            return el('li', { class: 'save-item', 'data-id': save.id },
                el('div', { class: 'save-info' },
                    el('span', { class: 'save-item-name', text: save.name }),
                    el('span', { class: 'save-item-meta', text: SG.describe(save) })),
                el('div', { class: 'save-actions' }, act('load', 'Load'), act('rename', 'Rename'), act('delete', 'Delete')));
        }

        function renameItem(save) {
            const input = el('input', { type: 'text', class: 'save-rename', maxlength: String(SG.MAX_NAME), 'aria-label': `New name for ${save.name}`, autocomplete: 'off', enterkeyhint: 'done', 'data-id': save.id });
            input.value = save.name;
            const act = (action, text, extra) => el('button', { type: 'button', class: `${extra || cls.button} save-btn save-act`.trim(), 'data-action': action, 'data-id': save.id, text });
            return el('li', { class: 'save-item renaming', 'data-id': save.id },
                input, el('div', { class: 'save-actions' }, act('rename-cancel', 'Cancel'), act('rename-ok', 'Save name', cls.primary)));
        }

        const actionButton = (id, action) => list.querySelector(`[data-id="${id}"] [data-action="${action}"]`);

        function saveError(result) {
            return (SAVE_ERRORS[result?.error] || SAVE_ERRORS.storage)(session.store.max);
        }

        function onSave(event) {
            event.preventDefault();
            const name = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, SG.MAX_NAME) || session.defaultName();
            const done = (result) => {
                if (!result.ok) { say(saveError(result)); return; }
                focus(saveButton); // off the text field first: renderSaves() leaves a focused field alone
                renderSaves();
                say(result.replaced ? `Replaced the save "${name}".` : `Saved as "${name}".`);
            };
            const first = session.saveAs(name);
            if (first.error === 'exists') {
                ask(`A save named "${session.store.get(first.id)?.name || name}" exists. Replace it with this game?`, 'Replace', () => done(session.saveAs(name, { replace: true })), saveButton);
            } else done(first);
        }

        function loadSave(id) {
            const save = session.store.get(id);
            if (!save) { renderSaves(); return; }
            const go = () => finishLoad(session.load(save), `Loaded "${save.name}".`, () => actionButton(id, 'load'));
            if (session.unsaved()) ask(`Your current game is not saved. Leave it and load "${save.name}"?`, 'Load', go, () => actionButton(id, 'load'));
            else go();
        }

        // After session.load / importPgn: close and say so in the game, or show why it failed
        function finishLoad(result, message, back, showError = say) {
            if (!result.ok) { showError(result.error); focus(typeof back === 'function' ? back() : back); return false; }
            close();
            try { notify?.(message); } catch (e) { /* ignore */ }
            return true;
        }

        function deleteSave(id) {
            const save = session.store.get(id);
            if (!save) { renderSaves(); return; }
            ask(`Delete the save "${save.name}"? This cannot be undone.`, 'Delete', () => {
                const result = session.store.remove(id);
                renderSaves();
                say(result.ok ? `Deleted "${save.name}".` : saveError(result));
                focus(list.querySelector('[data-action="load"]') || (nameInput.disabled ? title : nameInput));
            }, () => actionButton(id, 'delete'));
        }

        function startRename(id) {
            renaming = id;
            renderSaves();
            const input = list.querySelector('.save-rename');
            focus(input);
            input?.select?.();
        }

        function endRename(id, commit) {
            const input = list.querySelector('.save-rename');
            let message = '';
            if (commit && input) {
                const result = session.store.rename(id, input.value);
                if (!result.ok) { say(result.error === 'name' ? 'A save needs a name.' : saveError(result)); focus(input); return; }
                message = `Renamed to "${session.store.get(id)?.name}".`;
            }
            renaming = null;
            renderSaves();
            say(message);
            focus(actionButton(id, 'rename'));
        }

        // --- Confirmation ---
        function ask(text, yesLabel, yes, back) {
            pending = { yes, back };
            confirmText.textContent = text;
            confirmYes.textContent = yesLabel;
            confirmBox.hidden = false;
            for (const [key] of TABS) panes[key].hidden = true;
            tablist.hidden = true;
            say('');
            focus(confirmNo);
        }

        function answer(yes) {
            const was = pending;
            if (!was) return;
            pending = null;
            confirmBox.hidden = true;
            tablist.hidden = false;
            showTab(tab);
            if (yes) was.yes();
            else focus(typeof was.back === 'function' ? was.back() : was.back);
        }

        // --- Export ---
        function renderExport() {
            pgnArea.value = safe(() => session.pgn()) || '';
            pgnArea.scrollTop = pgnArea.scrollHeight; // the moves, not the tags, when the box is small
            fenInput.value = safe(() => session.fen()) || '';
            shareButton.hidden = !SG.canShare();
            copyButton.disabled = downloadButton.disabled = shareButton.disabled = !pgnArea.value;
        }

        function selectAll(field) {
            focus(field);
            try { field.select(); field.setSelectionRange?.(0, field.value.length); } catch (e) { /* ignore */ }
        }

        async function copy(field, done, what) {
            const result = await SG.copyText(field.value);
            if (result.ok) { say(done); return true; }
            selectAll(field);
            say(`Copying is blocked here. ${what} is selected: copy it by hand.`);
            return false;
        }

        async function share() {
            const result = await SG.shareText({ title: session.title || 'Chess game', text: pgnArea.value });
            if (result.ok) say('Shared.');
            else if (result.reason === 'cancelled') say('');
            else if ((await SG.copyText(pgnArea.value)).ok) say('Sharing did not work here, so the moves were copied instead.');
            else { selectAll(pgnArea); say('Sharing did not work here. The moves are selected: copy them by hand.'); }
        }

        function download() {
            const name = session.fileName();
            const result = SG.downloadText(name, pgnArea.value);
            say(result.ok ? `Saved as ${name}.` : 'Could not create a file here. Copy the moves instead.');
        }

        // --- Import ---
        const fail = (text) => {
            importError.textContent = '';
            importError.textContent = text || '';
            if (text) importError.scrollIntoView?.({ block: 'nearest' });
        };

        function importGame(review) {
            const text = importArea.value;
            fail('');
            if (!text.trim()) { fail('Paste the moves of a game first, or choose a file.'); focus(importArea); return; }
            const back = review ? reviewButton : playButton;
            const parsed = session.readPgn(text);
            if (!parsed.ok) { fail(parsed.error); focus(importArea); return; }
            const moves = Math.ceil(parsed.record.moves.length / 2);
            const message = `Loaded a game of ${moves} ${moves === 1 ? 'move' : 'moves'}.` +
                (parsed.more ? ' The text held more than one game: only the first was loaded.' : '') +
                (parsed.adjusted ? ' Its start position named castling or en passant rights that do not fit the board: they were ignored.' : '');
            const go = () => { if (finishLoad(session.load(parsed.record, { review }), message, back, fail)) importArea.value = ''; };
            if (session.unsaved()) ask('Your current game is not saved. Leave it and load the pasted game?', 'Load', go, back);
            else go();
        }

        async function readFile() {
            const file = fileInput.files?.[0];
            fileInput.value = '';
            if (!file) return;
            fail('');
            if (file.size > MAX_FILE_BYTES) { fail('That file is too large to be a chess game.'); return; }
            try {
                const text = typeof file.text === 'function' ? await file.text() : await new Promise((resolve, reject) => {
                    const reader = new root.FileReader();
                    reader.onload = () => resolve(String(reader.result));
                    reader.onerror = () => reject(reader.error);
                    reader.readAsText(file);
                });
                importArea.value = text;
                say(`Read ${file.name}. Choose how to load it.`);
                focus(playButton);
            } catch (e) {
                fail('That file could not be read.');
            }
        }

        // --- Open / close ---
        // Phones: keep the card inside the part of the screen the on-screen keyboard leaves free
        function fit() {
            const vv = root.visualViewport;
            if (!vv) return;
            modal.style.setProperty('--save-vh', `${Math.round(vv.height)}px`);
            modal.style.setProperty('--save-top', `${Math.round(vv.offsetTop)}px`);
        }

        // from: the control that opened the panel; the focus returns to it on close (Safari does not focus
        // a button that was clicked, so the active element is not enough)
        function open(which = 'saves', from = null) {
            const why = safe(() => session.busy?.());
            if (why) { try { notify?.(why); } catch (e) { /* ignore */ } return false; }
            if (modal.hidden) opener = from || doc.activeElement;
            pending = null;
            renaming = null;
            confirmBox.hidden = true;
            tablist.hidden = false;
            say('');
            fail('');
            modal.hidden = false;
            fit();
            root.visualViewport?.addEventListener?.('resize', fit);
            root.visualViewport?.addEventListener?.('scroll', fit);
            root.addEventListener?.('resize', fit);
            doc.addEventListener('keydown', onOutsideKey, true);
            showTab(which);
            focus(which === 'export' ? copyButton : title);
            return true;
        }

        function close() {
            if (modal.hidden) return;
            modal.hidden = true;
            pending = null;
            renaming = null;
            root.visualViewport?.removeEventListener?.('resize', fit);
            root.visualViewport?.removeEventListener?.('scroll', fit);
            root.removeEventListener?.('resize', fit);
            doc.removeEventListener('keydown', onOutsideKey, true);
            const back = opener;
            opener = null;
            if (back && doc.contains(back)) focus(back);
        }

        const focusable = () => [...card.querySelectorAll('button, input, textarea, select, [tabindex="0"]')]
            .filter(node => !node.disabled && !node.hidden && node.tabIndex !== -1 && !node.closest('[hidden]'));

        // Escape backs out one step: the question, the rename, then the dialog
        function escape() {
            if (pending) answer(false);
            else if (renaming) endRename(renaming, false);
            else close();
        }

        // Keys while the focus is not inside the dialog (it should be): Escape still works, Tab comes back in
        function onOutsideKey(event) {
            if (modal.hidden || modal.contains(event.target) || (event.key !== 'Escape' && event.key !== 'Tab')) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') escape();
            else focus(focusable()[0]);
        }

        function onKeyDown(event) {
            event.stopPropagation(); // the dialog is modal: board shortcuts (arrows, H, Space) stay out of it
            if (event.key === 'Escape') {
                event.preventDefault();
                escape();
                return;
            }
            if (event.key === 'Tab') {
                const nodes = focusable();
                if (!nodes.length) return;
                const first = nodes[0], last = nodes[nodes.length - 1];
                const at = doc.activeElement;
                if (event.shiftKey && (at === first || !card.contains(at) || at === title)) { event.preventDefault(); focus(last); }
                else if (!event.shiftKey && (at === last || !card.contains(at))) { event.preventDefault(); focus(first); }
                return;
            }
            if (event.target?.getAttribute?.('role') === 'tab') {
                const index = TABS.findIndex(([key]) => key === tab);
                const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 }[event.key];
                if (next === undefined) return;
                event.preventDefault();
                say('');
                showTab(TABS[(next + TABS.length) % TABS.length][0], { focusTab: true });
                return;
            }
            if (event.key === 'Enter' && event.target?.classList?.contains('save-rename')) { event.preventDefault(); endRename(event.target.dataset.id, true); }
        }

        // --- Wiring ---
        modal.addEventListener('keydown', onKeyDown);
        modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
        closeButton.addEventListener('click', close);
        for (const [key] of TABS) tabs[key].addEventListener('click', () => { say(''); showTab(key); });
        form.addEventListener('submit', onSave);
        nameInput.addEventListener('focus', () => { try { nameInput.select(); } catch (e) { /* ignore */ } });
        list.addEventListener('click', (event) => {
            const target = event.target.closest?.('[data-action]');
            if (!target) return;
            const { action, id } = target.dataset;
            if (action === 'load') loadSave(id);
            else if (action === 'delete') deleteSave(id);
            else if (action === 'rename') startRename(id);
            else if (action === 'rename-ok') endRename(id, true);
            else if (action === 'rename-cancel') endRename(id, false);
        });
        confirmYes.addEventListener('click', () => answer(true));
        confirmNo.addEventListener('click', () => answer(false));
        copyButton.addEventListener('click', () => copy(pgnArea, 'Moves copied.', 'The text'));
        shareButton.addEventListener('click', share);
        downloadButton.addEventListener('click', download);
        fenButton.addEventListener('click', () => copy(fenInput, 'Position (FEN) copied.', 'The position'));
        fileButton.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', readFile);
        playButton.addEventListener('click', () => importGame(false));
        reviewButton.addEventListener('click', () => importGame(true));
        importArea.addEventListener('input', () => fail(''));

        return { open, close, isOpen: () => !modal.hidden, element: modal, tab: () => tab };
    }

    root.SavePanel = { create };
})(globalThis);
// --- END OF FILE savepanel.js ---
