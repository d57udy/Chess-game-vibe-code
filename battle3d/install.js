// Installable app support: service worker registration, "Install app" menu section, update notice.
//   registerServiceWorker({ disabled, url = 'sw.js', onUpdate }) -> Promise<ServiceWorkerRegistration | null>
//   mountInstallUI(containerEl, { host }) -> { refresh(), destroy() }
//     host: element hidden together with the section when the app runs installed (default: the closest
//     .menu-section around containerEl, whose heading then replaces our own title)
//   isInstalled() -> boolean
//   showInstallHint(parentEl = document.body) -> boolean  (optional one-time toast when the browser offers install)
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

    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        // A new version took over an already controlled page: offer a reload (never force one mid-game).
        if (!hadController || reloading) return;
        reloading = true;
        if (typeof onUpdate === 'function') onUpdate();
        else showUpdateToast();
    });

    await new Promise(resolve => {
        if (document.readyState === 'complete') resolve();
        else window.addEventListener('load', resolve, { once: true });
    });
    try {
        const swUrl = new URL(url, document.baseURI);
        return await navigator.serviceWorker.register(swUrl.href, { scope: new URL('./', swUrl).pathname });
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

export function showUpdateToast(parent = document.body) {
    return toast(parent, 'A new version is ready.', [
        { label: 'Reload', primary: true, onClick: () => location.reload() },
        { label: '×' }
    ]);
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

// For tests / debugging.
export function installState() {
    return { installed: isInstalled(), installedNow, canPrompt: !!deferredPrompt, platform: hasWindow ? platform() : 'none' };
}
