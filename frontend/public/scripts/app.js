// FrioMx: utilidades compartidas por todas las páginas.
// Se carga en el <head> SIN defer: la guardia de sesión corre antes de pintar la página.
// Uso en cada página:
//   <html lang="es" data-auth="private|guest|public" data-page="roulette">
//   <body data-shell>   -> se inyectan la barra superior, el menú lateral y la barra inferior;
//                          el contenido de la página va dentro de <main id="main" class="main">.
(function () {
    'use strict';

    const TOKEN_KEY = 'token';
    const root = document.documentElement;
    const authMode = root.dataset.auth || 'public';
    const LOBBY = '/index_logIn';
    const LOGIN = '/logIn';

    // ---------- Sesión ----------
    function getToken() { return localStorage.getItem(TOKEN_KEY); }
    function setToken(token) { localStorage.setItem(TOKEN_KEY, token); }
    function clearSession() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem('userId'); }

    // replace() para que el botón Atrás no regrese a una página que ya no corresponde.
    if (authMode === 'private' && !getToken()) {
        location.replace(LOGIN + '?next=' + encodeURIComponent(location.pathname));
        return;
    }
    if (authMode === 'guest' && getToken()) {
        location.replace(LOBBY);
        return;
    }
    // Si se cierra la sesión en otra pestaña, esta también sale.
    window.addEventListener('storage', (e) => {
        if (e.key === TOKEN_KEY && !e.newValue && authMode === 'private') {
            sessionStorage.setItem('friomx-flash', 'Tu sesión se cerró en otra pestaña.');
            location.replace(LOGIN);
        }
    });

    // Destino seguro para ?next=: solo rutas del mismo sitio (ni //otro.com ni caracteres de control).
    function safeNext(raw, fallback = LOBBY) {
        if (!raw || /[\x00-\x20\\]/.test(raw) || !raw.startsWith('/') || raw.startsWith('//')) return fallback;
        let url;
        try { url = new URL(raw, location.origin); } catch { return fallback; }
        if (url.origin !== location.origin) return fallback;
        if (/^\/(login|register)\/?$/i.test(url.pathname)) return fallback;
        return url.pathname + url.search + url.hash;
    }

    // Si se vuelve con Atrás desde la caché del navegador después de salir, se revalida.
    window.addEventListener('pageshow', (e) => {
        if (e.persisted && authMode === 'private' && !getToken()) location.replace(LOGIN);
    });

    // ---------- Formato ----------
    const nf = new Intl.NumberFormat('es-MX');
    function chips(n, { sign = false } = {}) {
        const abs = Math.abs(n);
        const s = sign ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '');
        return `${s}${nf.format(abs)} ${abs === 1 ? 'ficha' : 'fichas'}`;
    }
    function num(n) { return nf.format(n); }
    function date(iso) {
        const d = new Date(iso);
        return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    function el(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) {
            if (c === null || c === undefined || c === false) continue;
            node.append(c instanceof Node ? c : document.createTextNode(String(c)));
        }
        return node;
    }

    // ---------- API ----------
    const FRIENDLY = {
        INSUFFICIENT_FUNDS: 'No tienes fichas suficientes para esa apuesta.',
        RATE_LIMITED: 'Demasiados intentos. Espera un minuto y vuelve a intentar.',
        GAME_FINISHED: 'Esa partida ya terminó.',
        NOT_FOUND: 'La partida ya no existe o expiró.',
        CONFLICT: 'Otra acción llegó al mismo tiempo. Intenta de nuevo.',
        INTERNAL: 'Algo salió mal en el servidor. Intenta de nuevo en un momento.',
        NOT_AVAILABLE: 'Esta función estará disponible pronto.',
    };

    class ApiError extends Error {
        constructor(status, code, message, body) {
            super(message);
            this.status = status;
            this.code = code;
            this.body = body || {};
        }
    }

    async function api(path, { method = 'GET', body, auth = true } = {}) {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const token = getToken();
        if (auth && token) headers.Authorization = `Bearer ${token}`;
        let res;
        try {
            res = await fetch('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        } catch {
            throw new ApiError(0, 'NETWORK', 'No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.');
        }
        let data = {};
        try { data = await res.json(); } catch { /* respuesta sin cuerpo */ }
        if (res.status === 401 && auth && (token || authMode === 'private')) {
            clearSession();
            // En páginas públicas (Reglas, Acerca de) una sesión vencida no impide leerlas: solo se quita.
            if (authMode === 'public') {
                location.reload();
                throw new ApiError(401, 'UNAUTHORIZED', 'Sesión expirada');
            }
            const why = data.error ? data.error.replace(/\.?$/, '.') : 'Tu sesión expiró.';
            sessionStorage.setItem('friomx-flash', why + ' Inicia sesión de nuevo.');
            location.replace(LOGIN + '?next=' + encodeURIComponent(location.pathname));
            throw new ApiError(401, 'UNAUTHORIZED', data.error || 'Sesión expirada');
        }
        if (!res.ok) {
            const msg = data.code === 'VALIDATION_ERROR' || data.code === 'INVALID_CREDENTIALS' || data.code === 'EMAIL_IN_USE'
                || data.code === 'WRONG_PASSWORD' || data.code === 'ROUND_ACTIVE' || data.code === 'FORBIDDEN'
                ? (data.error || 'Petición inválida')
                : (FRIENDLY[data.code] || data.error || 'Algo salió mal. Intenta de nuevo.');
            throw new ApiError(res.status, data.code || 'HTTP_' + res.status, msg, data);
        }
        return data;
    }

    // ---------- Toasts y diálogos ----------
    function toastHost() {
        let host = document.querySelector('.toasts');
        if (!host) {
            host = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
            document.body.append(host);
        }
        return host;
    }
    // Quita los avisos abiertos (por ejemplo, al empezar una partida, un aviso viejo ya no aplica).
    function clearToasts() { document.querySelectorAll('.toasts .toast').forEach((n) => n.remove()); }
    function toast(message, type = 'info', ms = 3500) {
        const close = el('button', { class: 'close', 'aria-label': 'Cerrar aviso', text: '×' });
        const node = el('div', { class: `toast ${type}` }, el('div', {}, message), close);
        const remove = () => node.remove();
        close.addEventListener('click', remove);
        toastHost().append(node);
        if (ms) setTimeout(remove, ms);
        return node;
    }

    function dialog({ title, text, confirmText = 'Aceptar', cancelText = 'Cancelar', danger = false, input }) {
        return new Promise((resolve) => {
            const field = input ? el('input', {
                class: 'input', type: input.type || 'text', autocomplete: input.autocomplete || 'off',
                'aria-label': input.label || title, placeholder: input.placeholder || '',
            }) : null;
            const ok = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, text: confirmText });
            const cancel = el('button', { class: 'btn btn-ghost', text: cancelText });
            const box = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title' },
                el('h2', { id: 'dlg-title', text: title }),
                text ? el('p', { class: 'muted', text }) : null,
                field ? el('div', { class: 'field' }, input.label ? el('label', { text: input.label }) : null, field) : null,
                el('div', { class: 'actions' }, cancel, ok));
            const backdrop = el('div', { class: 'dialog-backdrop' }, box);
            const prevFocus = document.activeElement;
            const done = (value) => {
                backdrop.remove();
                document.removeEventListener('keydown', onKey);
                if (prevFocus && prevFocus.focus) prevFocus.focus();
                resolve(value);
            };
            const onKey = (e) => {
                if (e.key === 'Tab') {
                    // El foco no sale del diálogo mientras está abierto.
                    const items = [...box.querySelectorAll('button, input')].filter((n) => !n.disabled);
                    const first = items[0];
                    const last = items[items.length - 1];
                    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                    else if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
                    return;
                }
                if (e.key === 'Escape') done(input ? null : false);
                if (e.key === 'Enter' && field && document.activeElement === field) { e.preventDefault(); ok.click(); }
            };
            ok.addEventListener('click', () => done(input ? field.value : true));
            cancel.addEventListener('click', () => done(input ? null : false));
            backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(input ? null : false); });
            document.addEventListener('keydown', onKey);
            document.body.append(backdrop);
            // En acciones de confirmación el foco empieza en Cancelar: un Enter accidental no confirma.
            (field || (input ? ok : cancel)).focus();
        });
    }

    // ---------- Saldo y usuario ----------
    let currentBalance = null;
    let me = null;
    const listeners = new Set();
    function onBalance(fn) { listeners.add(fn); if (currentBalance !== null) fn(currentBalance); }
    function setBalance(n, { animate = true } = {}) {
        const prev = currentBalance;
        currentBalance = n;
        document.querySelectorAll('[data-balance]').forEach((node) => { node.textContent = num(n); });
        const chip = document.querySelector('.balance-chip');
        if (chip && animate && prev !== null && prev !== n) {
            chip.classList.remove('up', 'down', 'bump');
            void chip.offsetWidth;
            chip.classList.add(n > prev ? 'up' : 'down', 'bump');
            setTimeout(() => chip.classList.remove('bump'), 250);
            setTimeout(() => chip.classList.remove('up', 'down'), 1500);
        }
        listeners.forEach((fn) => fn(n));
    }
    function getBalance() { return currentBalance; }
    async function refreshBalance() {
        const data = await api('/user/balance');
        setBalance(data.balance, { animate: false });
        return data.balance;
    }
    // Si la página y el arranque piden el perfil a la vez, comparten la misma petición.
    let mePending = null;
    function loadMe() {
        if (mePending) return mePending;
        mePending = (async () => {
            me = await api('/user/profile');
            setBalance(me.balance, { animate: false });
            document.querySelectorAll('[data-user-name]').forEach((n) => { n.textContent = me.name; });
            document.querySelectorAll('[data-user-initial]').forEach((n) => { n.textContent = initials(me.name); });
            return me;
        })().finally(() => { mePending = null; });
        return mePending;
    }
    function initials(name) {
        return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    }

    async function logout({ ask = true } = {}) {
        if (ask && !(await dialog({ title: '¿Cerrar sesión?', text: 'Tendrás que volver a ingresar tu correo y contraseña.', confirmText: 'Cerrar sesión', danger: true }))) return;
        clearSession();
        location.replace(LOGIN);
    }

    // ---------- Shell ----------
    const ICONS = {
        lobby: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
        roulette: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14m0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
        hilo: 'M6 3h9a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2m13 3 1.5.5a2 2 0 0 1 1.2 2.5l-3.7 11',
        mines: 'M11 21a7 7 0 1 0 0-14 7 7 0 0 0 0 14m4.5-12.5 2-2M17 4l1.5-1.5M19 6.5l1.5-.5M8 13.5a3 3 0 0 1 3-3',
        activity: 'M12 8v4l3 2M12 3a9 9 0 1 0 9 9',
        balance: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2m14 7h.01',
        profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8m-7 9a7 7 0 0 1 14 0',
        rules: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM8 8h7M8 12h7',
        info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 9v6m0-10h.01',
        logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11',
    };
    function icon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', ICONS[name]);
        svg.append(path);
        return svg;
    }

    const NAV = [
        { section: 'Jugar' },
        { id: 'lobby', href: LOBBY, label: 'Juegos', icon: 'lobby' },
        { id: 'roulette', href: '/roulette', label: 'Ruleta', icon: 'roulette' },
        { id: 'hilo', href: '/hi-lo', label: 'Hi-Lo', icon: 'hilo' },
        { id: 'mines', href: '/mines', label: 'Minas', icon: 'mines' },
        { section: 'Mi cuenta' },
        { id: 'activity', href: '/activity', label: 'Historial', icon: 'activity' },
        { id: 'balance', href: '/balance', label: 'Saldo', icon: 'balance' },
        { id: 'profile', href: '/profile', label: 'Perfil', icon: 'profile' },
        { section: 'Ayuda' },
        { id: 'rules', href: '/rules', label: 'Reglas', icon: 'rules' },
        { id: 'info', href: '/info', label: 'Acerca de', icon: 'info' },
    ];
    const BOTTOM = ['lobby', 'activity', 'balance', 'rules', 'profile'];

    function buildShell() {
        const page = root.dataset.page;
        const main = document.getElementById('main');
        if (!main) return;
        const current = (id) => (id === page ? 'page' : undefined);

        const topbar = el('header', { class: 'topbar' },
            el('a', { class: 'brand', href: LOBBY, 'aria-label': 'FrioMx, ir a Juegos' },
                el('img', { src: '/assets/images/icon.png', alt: '' }), el('span', {}, 'Frio', el('b', { text: 'Mx' }))),
            el('div', { class: 'spacer' }),
            el('a', { class: 'balance-chip', href: '/balance', title: 'Tu saldo' },
                el('span', { class: 'coin', 'aria-hidden': 'true' }),
                el('span', { class: 'num', 'data-balance': true, text: '…' }),
                el('span', { class: 'sr-only', text: ' fichas' })),
            el('a', { class: 'user-btn', href: '/profile', 'aria-label': 'Mi perfil' },
                el('span', { class: 'avatar', 'data-user-initial': true, text: '' }),
                el('span', { class: 'name', 'data-user-name': true, text: '' })));

        const sidebar = el('nav', { class: 'sidebar', 'aria-label': 'Menú principal' },
            NAV.map((item) => (item.section
                ? el('div', { class: 'nav-section', text: item.section })
                : el('a', { class: 'nav-link', href: item.href, 'aria-current': current(item.id) }, icon(item.icon), item.label))),
            el('div', { class: 'bottom' },
                el('button', { class: 'nav-link', type: 'button', onclick: () => logout() }, icon('logout'), 'Cerrar sesión')));

        const bottombar = el('nav', { class: 'bottombar', 'aria-label': 'Menú' },
            BOTTOM.map((id) => {
                const item = NAV.find((n) => n.id === id);
                const isCurrent = id === page || (id === 'lobby' && ['roulette', 'hilo', 'mines'].includes(page));
                return el('a', { href: item.href, 'aria-current': isCurrent ? 'page' : undefined }, icon(item.icon), item.label);
            }));

        const layout = el('div', { class: 'layout' }, sidebar);
        main.classList.add('main');
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        document.body.prepend(el('a', { class: 'skip-link', href: '#main', text: 'Saltar al contenido' }));
        main.parentNode.insertBefore(layout, main);
        layout.append(main);
        document.body.querySelector('.skip-link').after(topbar);
        document.body.append(bottombar);
    }

    // ---------- Control de apuesta ----------
    // Crea un campo de apuesta con botones ½, ×2 y Máx. Solo acepta enteros de 1 a 10,000.
    function betControl(container, { initial = 10, label = 'Apuesta', onEnter } = {}) {
        const id = 'bet-' + Math.random().toString(36).slice(2, 7);
        const input = el('input', {
            class: 'input num', id, type: 'text', inputmode: 'numeric', autocomplete: 'off',
            pattern: '[0-9]*', maxlength: '5', value: String(initial), 'aria-describedby': id + '-err',
        });
        const half = el('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Mitad', text: '½' });
        const dbl = el('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Doble', text: '×2' });
        const max = el('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Máximo', text: 'Máx' });
        const err = el('div', { class: 'error', id: id + '-err', 'aria-live': 'polite' });
        const quick = el('div', { class: 'chip-row' }, [10, 50, 100, 500].map((v) => el('button', {
            class: 'chip-btn', type: 'button', text: num(v), onclick: () => { set(v); input.focus(); },
        })));
        container.append(el('div', { class: 'bet-box field' },
            el('label', { for: id, text: label }),
            el('div', { class: 'bet-input' }, input, half, dbl, max),
            quick, err));

        const limit = () => Math.max(0, Math.min(10000, currentBalance ?? 10000));
        function read() {
            const raw = input.value.trim();
            if (!/^\d+$/.test(raw)) return null;
            return Number(raw);
        }
        function validate() {
            const v = read();
            let msg = '';
            if (v === null) msg = 'Escribe una cantidad en números enteros.';
            else if (v < 1) msg = 'La apuesta mínima es 1 ficha.';
            else if (v > 10000) msg = `La apuesta máxima es ${num(10000)} fichas.`;
            else if (currentBalance !== null && v > currentBalance) msg = `Solo tienes ${chips(currentBalance)}.`;
            err.textContent = msg;
            input.setAttribute('aria-invalid', msg ? 'true' : 'false');
            return msg ? null : v;
        }
        function set(v) { input.value = String(Math.max(1, Math.floor(v))); validate(); }
        input.addEventListener('input', () => {
            const clean = input.value.replace(/\D/g, '');
            if (clean !== input.value) input.value = clean;
            validate();
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } });
        half.addEventListener('click', () => set((read() || 2) / 2));
        dbl.addEventListener('click', () => set(Math.min(limit() || 1, (read() || 1) * 2)));
        max.addEventListener('click', () => set(limit() || 1));
        onBalance(() => { if (input.value) validate(); });
        const controls = [input, half, dbl, max, ...quick.querySelectorAll('button')];
        return {
            input,
            value: validate,
            set,
            setDisabled(d) { controls.forEach((c) => { c.disabled = d; }); },
            setError(m) { err.textContent = m; },
        };
    }

    // ---------- Arranque ----------
    function start() {
        if (document.body.hasAttribute('data-shell')) buildShell();
        const flash = sessionStorage.getItem('friomx-flash');
        if (flash) { sessionStorage.removeItem('friomx-flash'); toast(flash, 'info', 5000); }
        // <html data-me-errors="page">: la página muestra su propio estado de error (perfil, lobby).
        if (authMode === 'private') loadMe().catch((e) => { if (e.status !== 401 && root.dataset.meErrors !== 'page') toast(e.message, 'error'); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    window.FrioMx = {
        api, ApiError, toast, clearToasts, dialog, chips, num, date, el, icon,
        getToken, setToken, clearSession, logout,
        setBalance, getBalance, refreshBalance, onBalance, loadMe, me: () => me, initials,
        betControl, safeNext, LOBBY, LOGIN,
    };
})();
