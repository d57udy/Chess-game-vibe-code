// Installable app support: service worker registration, "Install app" menu section, update notice.
//   registerServiceWorker({ disabled, url = 'sw.js', onUpdate }) -> Promise<ServiceWorkerRegistration | null>
//   mountInstallUI(containerEl, { host }) -> { refresh(), destroy() }
//     host: element hidden together with the section when the app runs installed (default: the closest
//     .menu-section around containerEl, whose heading then replaces our own title)
//   isInstalled() -> boolean
//   showInstallHint(parentEl = document.body) -> boolean  (optional one-time toast when the browser offers install)
//   mountOfflineStatus(el) -> { destroy() }   one line: "Ready to play offline." / "Preparing offline play: 60%" / ...
//   watchOfflineStatus(onChange) -> stop(), offlineMarker() -> marker | null, offlineStatusText(status) -> string
//   offlineReport() -> { marker, lastError }  (debug: the last failed download, which the pages do not show)
//   applyUpdate()  switch to the complete new version that waits, then reload (the update toast's Reload)
//   updateIfWaiting() -> boolean  applyUpdate() when a complete new version waits (a boot that failed)
// Import this module early (main.js top level): Chrome fires `beforeinstallprompt` soon after load, before the
// menu is opened, and the event is kept here until the button uses it.

const HINT_KEY = 'battle3d.installHint.v1';
const listeners = new Set();
let deferredPrompt = null;
let installedNow = false;

const hasWindow = typeof window !== 'undefined';
const notify = () => { for (const fn of listeners) { try { fn(); } catch (e) { /* ignore */ } } };

if (hasWindow) {
    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault(); // our menu button (and the optional hint) offer the install instead of the mini-infobar
        deferredPrompt = event;
        notify();
    });
    window.addEventListener('appinstalled', () => {
        installedNow = true;
        deferredPrompt = null;
        notify();
    });
}

function query() {
    try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(); }
}

export function isInstalled() {
    if (!hasWindow) return false;
    const mode = m => { try { return window.matchMedia(`(display-mode: ${m})`).matches; } catch (e) { return false; } };
    // Not 'fullscreen': a normal browser window in OS full screen matches it too.
    return mode('standalone') || mode('window-controls-overlay') || navigator.standalone === true;
}

// --- service worker -----------------------------------------------------------------------------------

export async function registerServiceWorker({ disabled = false, url = 'sw.js', onUpdate } = {}) {
    if (!hasWindow || !('serviceWorker' in navigator) || !window.isSecureContext) return null;
    const q = query();
    if (q.get('nosw') === '1') {
        // Explicit opt-out (tests, debugging stale caches): also drop an existing worker for this site.
        try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch (e) { /* ignore */ }
        return null;
    }
    if (disabled || q.get('debug') === '1') return null;

    // A complete new version waits (sw.js) until the player reloads: offer that once, never force it mid-game.
    const hadController = !!navigator.serviceWorker.controller;
    let offered = false;
    const offer = () => {
        if (offered || !navigator.serviceWorker.controller) return;
        offered = true;
        if (typeof onUpdate === 'function') onUpdate();
        else showUpdateToast();
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return; // the first version took this page over
        if (updating) { location.reload(); return; } // our Reload asked for it (applyUpdate)
        offered = false; // another tab switched versions: offer a reload again, even if the last offer was dismissed
        offer();
    });

    await new Promise(resolve => {
        if (document.readyState === 'complete') resolve();
        else window.addEventListener('load', resolve, { once: true });
    });
    try {
        const swUrl = new URL(url, document.baseURI);
        const registration = await navigator.serviceWorker.register(swUrl.href, { scope: new URL('./', swUrl).pathname });
        const watch = worker => worker?.addEventListener?.('statechange', () => { if (worker.state === 'installed') offer(); });
        if (registration.waiting) offer();
        watch(registration.installing);
        registration.addEventListener?.('updatefound', () => watch(registration.installing));
        // An installed app resumed from the recent apps list loads no page, so the browser checks for no update:
        // check when it comes back, at most once an hour
        let checked = Date.now();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || Date.now() - checked < UPDATE_CHECK_MS) return;
            checked = Date.now();
            registration.update?.().catch(() => { });
        });
        // The installed app asks to keep its offline files when the device runs low on space (Chrome answers
        // without a prompt). A browser tab does not ask.
        if (isInstalled()) navigator.storage?.persist?.().catch(() => { });
        return registration;
    } catch (e) {
        return null;
    }
}

function toast(parent, text, actions) {
    const el = document.createElement('div');
    el.className = 'b3d-toast panel';
    el.setAttribute('role', 'status');
    const span = document.createElement('span');
    span.textContent = text;
    el.append(span);
    for (const { label, primary, onClick } of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = primary ? 'btn b3d-toast-btn primary' : 'b3d-toast-close';
        b.textContent = label;
        if (!primary) b.setAttribute('aria-label', 'Dismiss');
        b.addEventListener('click', () => { onClick?.(); el.remove(); });
        el.append(b);
    }
    parent.append(el);
    return el;
}

const UPDATE_CHECK_MS = 3600000;
const waitingWorker = () => navigator.serviceWorker?.getRegistration?.().then(r => r?.waiting || null).catch(() => null) ?? Promise.resolve(null);

// Switches to the version that waits (sw.js answers SKIP_WAITING) and reloads once it controls the page; without a
// waiting version (another tab switched already) it just reloads. If the switch does not come within `fallbackMs`,
// it reloads anyway (it only ever follows a click or a failed boot).
let updating = false;
export async function applyUpdate({ reload = () => location.reload(), fallbackMs = 5000 } = {}) {
    updating = true;
    const waiting = await waitingWorker();
    if (!waiting) { reload(); return; }
    waiting.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(reload, fallbackMs);
}

// A boot that failed: when a complete newer version waits, switch to it at once (no game is in progress, and nothing
// waits after the switch). Returns whether it switched.
export async function updateIfWaiting(options) {
    if (!(await waitingWorker())) return false;
    await applyUpdate(options);
    return true;
}

export function showUpdateToast(parent = document.body) {
    const shown = parent.querySelector?.('.b3d-toast[data-kind="update"]');
    if (shown) return shown; // one at a time
    const el = toast(parent, 'A new version is ready.', [
        { label: 'Reload', primary: true, onClick: () => applyUpdate() },
        { label: '×' }
    ]);
    el.dataset.kind = 'update';
    return el;
}

// --- install UI -------------------------------------------------------------------------------------

function platform() {
    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'ios-other' : 'ios-safari';
    if (/Android/.test(ua)) {
        if (/SamsungBrowser/.test(ua)) return 'android-samsung';
        if (/Firefox/.test(ua)) return 'android-firefox';
        return 'android-chrome';
    }
    if (/Edg\//.test(ua)) return 'desktop-edge';
    if (/Chrome\//.test(ua)) return 'desktop-chrome';
    if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return 'desktop-safari';
    return 'other';
}

const HOW_TO = {
    'android-chrome': 'In Chrome, open the menu ⋮ and choose “Install app” (or “Add to Home screen”).',
    'android-samsung': 'In Samsung Internet, open the menu ≡ and choose “Add page to” > “Home screen”.',
    'android-firefox': 'In Firefox, open the menu ⋮ and choose “Install” (or “Add to Home screen”).',
    'ios-safari': 'In Safari, tap Share (the square with an arrow) and choose “Add to Home Screen”.',
    'ios-other': 'Open this page in Safari, tap Share and choose “Add to Home Screen”.',
    'desktop-chrome': 'In Chrome, click the install icon in the address bar, or menu ⋮ > “Cast, save and share” > “Install page as app”.',
    'desktop-edge': 'In Edge, click the “App available” icon in the address bar, or menu … > “Apps” > “Install this site as an app”.',
    'desktop-safari': 'In Safari, choose File > “Add to Dock”.',
    other: 'Use your browser menu to add this page to your home screen or install it as an app.'
};

export function mountInstallUI(container, { host = container.closest('.menu-section') } = {}) {
    const section = document.createElement('section');
    section.className = 'b3d-install';
    section.setAttribute('aria-label', 'Install app');
    const title = document.createElement('div');
    title.className = 'b3d-install-title';
    title.innerHTML = '<img src="icons/icon-192.png" alt="" width="28" height="28"><span>Install the app</span>';
    const text = document.createElement('p');
    text.className = 'b3d-install-text';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn primary b3d-install-btn';
    button.textContent = 'Install app';
    const how = document.createElement('p');
    how.className = 'b3d-install-how';
    section.append(...(host ? [] : [title]), text, button, how);
    container.append(section);

    async function install() {
        const prompt = deferredPrompt;
        if (!prompt) return;
        button.disabled = true;
        try {
            await prompt.prompt();
            const choice = await prompt.userChoice;
            deferredPrompt = null; // a prompt can only be used once
            if (choice?.outcome === 'accepted') installedNow = true;
        } catch (e) { /* ignore */ }
        button.disabled = false;
        render();
    }
    button.addEventListener('click', install);

    function render() {
        const installed = isInstalled();
        section.hidden = installed;
        if (host) host.hidden = installed;
        if (installed) return;
        if (installedNow) {
            text.textContent = 'Installed. Start “Chess 3D” from your home screen or app list; it also works offline.';
            button.hidden = true;
            how.hidden = true;
        } else if (deferredPrompt) {
            text.textContent = 'Play full screen from your home screen, even offline.';
            button.hidden = false;
            button.textContent = 'Install app';
            how.hidden = true;
        } else {
            text.textContent = 'Play full screen from your home screen, even offline.';
            button.hidden = true;
            how.hidden = false;
            how.textContent = HOW_TO[platform()] || HOW_TO.other;
        }
    }

    const onChange = () => render();
    listeners.add(onChange);
    let mq = null;
    try { mq = window.matchMedia('(display-mode: standalone)'); mq.addEventListener?.('change', onChange); } catch (e) { mq = null; }
    render();
    return {
        refresh: render,
        destroy() {
            listeners.delete(onChange);
            mq?.removeEventListener?.('change', onChange);
            section.remove();
        }
    };
}

// One gentle, one-time suggestion when the browser says the app can be installed. Returns true if shown.
export function showInstallHint(parent = document.body) {
    if (!deferredPrompt || isInstalled()) return false;
    try { if (localStorage.getItem(HINT_KEY)) return false; localStorage.setItem(HINT_KEY, '1'); } catch (e) { return false; }
    toast(parent, 'Install Chess 3D as an app to play full screen and offline?', [
        { label: 'Install', primary: true, onClick: () => { const p = deferredPrompt; deferredPrompt = null; p?.prompt(); p?.userChoice.then(c => { if (c?.outcome === 'accepted') installedNow = true; notify(); }).catch(() => { }); } },
        { label: '×' }
    ]);
    return true;
}

// --- offline readiness --------------------------------------------------------------------------------
// sw.js stores OFFLINE_MARKER in its shell cache (chess3d-shell-<version>) once everything both games need offline
// is downloaded, and posts OFFLINE_STATUS messages ({ state: 'installing' | 'ready' | 'failed', done, total }) while
// a version downloads. A version that could not finish never takes over, so a shell cache with the marker means the
// app starts offline. A failed try leaves OFFLINE_ERROR in its own shell cache.

const OFFLINE_MARKER = 'offline-ready.json';
const OFFLINE_ERROR = 'offline-error.json';
const SHELL_PREFIX = 'chess3d-shell-';
const swScope = (url = 'sw.js') => new URL('./', new URL(url, document.baseURI)).href;

// The marker of the version that serves offline ({ version, files, missing, completed }), or null.
export async function offlineMarker({ url = 'sw.js' } = {}) {
    if (!hasWindow || !('caches' in window)) return null;
    try {
        const key = new URL(OFFLINE_MARKER, swScope(url)).href;
        for (const cacheName of (await caches.keys()).filter(k => k.startsWith(SHELL_PREFIX))) {
            const hit = await caches.match(key, { cacheName });
            if (hit) return await hit.json();
        }
    } catch (e) { /* storage blocked */ }
    return null;
}

// What the debug view shows: the marker that serves offline and the last failed download ({ version, error, at }).
export async function offlineReport({ url = 'sw.js' } = {}) {
    let lastError = null;
    try {
        const key = new URL(OFFLINE_ERROR, swScope(url)).href;
        for (const cacheName of (await caches.keys()).filter(k => k.startsWith(SHELL_PREFIX))) {
            const hit = await caches.match(key, { cacheName });
            const note = hit ? await hit.json() : null;
            if (note && (!lastError || note.at > lastError.at)) lastError = note;
        }
    } catch (e) { /* storage blocked */ }
    return { marker: await offlineMarker({ url }), lastError };
}

/**
 * Follows the offline download. onChange({ state, percent, online }) with state
 *   'unsupported'  no service worker or Cache Storage (also on insecure origins)
 *   'ready'        the app starts offline; `percent` is set while a newer version downloads, `update` once a complete
 *                  newer version waits for a reload
 *   'preparing'    the first download runs (`percent` once known) or is about to start
 *   'incomplete'   not ready and not downloading (the last try failed); an existing worker tries again when the
 *                  device comes online (a page never registers one here: pages that do not use the worker stay as they are)
 * @returns {() => void} stop
 */
export function watchOfflineStatus(onChange, { url = 'sw.js' } = {}) {
    const online = () => navigator.onLine !== false;
    if (!hasWindow || !('serviceWorker' in navigator) || !('caches' in window) || !window.isSecureContext) {
        onChange({ state: 'unsupported', percent: null, online: hasWindow && online() });
        return () => { };
    }
    const sw = navigator.serviceWorker;
    let stopped = false, progress = null, failed = false, timer = null, last = '';
    const registration = () => sw.getRegistration(swScope(url)).catch(() => null);

    async function refresh() {
        clearTimeout(timer);
        if (stopped) return;
        const [marker, reg] = await Promise.all([offlineMarker({ url }), registration()]);
        if (stopped) return;
        const downloading = !!reg?.installing && !failed;
        let state = 'incomplete';
        if (marker) state = 'ready';
        else if (downloading || (!reg && !failed && online())) state = 'preparing';
        const status = { state, percent: downloading ? progress : null, online: online(), update: !!marker && !!reg?.waiting };
        const key = JSON.stringify(status);
        if (key !== last) { last = key; onChange(status); }
        // The 3D page registers the worker after its first frame: look again until offline play is ready (and while a
        // newer version downloads, until it waits)
        if (state !== 'ready' || downloading) timer = setTimeout(refresh, 3000);
    }
    const onMessage = event => {
        const s = event.data;
        if (s?.type !== 'OFFLINE_STATUS') return;
        failed = s.state === 'failed';
        progress = s.state === 'installing' && s.total > 0 ? Math.min(99, Math.floor((100 * s.done) / s.total)) : null;
        refresh();
    };
    // Back online after a failed or interrupted download: the worker tries again now instead of on the next visit
    const onOnline = async () => {
        const reg = await registration();
        if (reg && !(await offlineMarker({ url }))) {
            failed = false;
            reg.update().catch(() => { });
        }
        refresh();
    };
    const onOffline = () => refresh();
    sw.addEventListener('message', onMessage);
    sw.startMessages?.();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    // A download that started before this page: ask it where it stands; a new one: follow it
    registration().then(reg => {
        reg?.installing?.postMessage({ type: 'GET_STATUS' });
        reg?.addEventListener('updatefound', () => { failed = false; progress = 0; refresh(); });
    });
    refresh();
    return () => {
        stopped = true;
        clearTimeout(timer);
        sw.removeEventListener('message', onMessage);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
    };
}

export function offlineStatusText({ state, percent, online, update = false }) {
    if (state === 'ready' && update) return 'Ready to play offline. An update is ready. Reload to use it.';
    if (state === 'ready') return percent == null ? 'Ready to play offline.' : `Ready to play offline. Downloading an update: ${percent}%`;
    if (state === 'preparing') return percent == null ? 'Preparing offline play...' : `Preparing offline play: ${percent}%`;
    if (state === 'incomplete') return online
        ? 'Offline play is not ready yet. The download continues the next time you open the game.'
        : 'Offline play is not ready yet. Connect to the internet once to finish the download.';
    return '';
}

// One quiet status line in `el`; hidden where offline play is not supported. Screen readers hear a change of state
// (a visually hidden live region next to it), not every percent. Returns { destroy() }.
export function mountOfflineStatus(el, { url = 'sw.js' } = {}) {
    if (!el) return { destroy() { } };
    const live = document.createElement('span');
    live.setAttribute('aria-live', 'polite');
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
    el.after(live);
    let announced = null;
    const stop = watchOfflineStatus(status => {
        const text = offlineStatusText(status);
        el.hidden = !text;
        el.textContent = text;
        el.dataset.state = status.state;
        // The state the page opens with is in the menu; what changes while it is open is announced
        const key = status.state + (status.update ? '+update' : '');
        if (announced !== null && key !== announced) live.textContent = offlineStatusText({ ...status, percent: null });
        announced = key;
    }, { url });
    return { destroy() { stop(); live.remove(); } };
}

// For tests / debugging.
export function installState() {
    return { installed: isInstalled(), installedNow, canPrompt: !!deferredPrompt, platform: hasWindow ? platform() : 'none' };
}
