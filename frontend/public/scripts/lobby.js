// FrioMx: lobby. Saludo y saldo (con estado de error y Reintentar) y las últimas 5 partidas.
(function () {
    'use strict';
    const F = window.FrioMx;
    const { api, el, date, chips } = F;
    const UI = window.FrioUI;
    const box = document.getElementById('recent');

    // ---------- Aviso de llegada (p. ej. "¡Bienvenido! Tienes 1,000 fichas") ----------
    // Este script es defer: corre antes de que app.js lea el aviso en DOMContentLoaded,
    // así que lo consume aquí y lo muestra como banner dentro de la página, sin tapar las tarjetas.
    const flash = sessionStorage.getItem('friomx-flash');
    if (flash) {
        sessionStorage.removeItem('friomx-flash');
        const banner = document.getElementById('flash');
        document.getElementById('flash-msg').textContent = flash.trim();
        banner.hidden = false;
        document.getElementById('flash-close').addEventListener('click', () => { banner.hidden = true; });
    }
    document.getElementById('lobby-logout').addEventListener('click', () => F.logout());

    // ---------- Saludo y saldo ----------
    const card = document.getElementById('balance-card');
    const meError = document.getElementById('me-error');
    const meRetry = document.getElementById('me-retry');
    async function loadMe() {
        meError.hidden = true;
        card.hidden = false;
        try {
            await F.loadMe();
        } catch (err) {
            if (err.status === 401) return;
            document.getElementById('me-error-msg').textContent = 'No pudimos cargar tu saldo. ' + err.message;
            card.hidden = true;
            meError.hidden = false;
        }
    }
    meRetry.addEventListener('click', async () => {
        UI.busy(meRetry, true, 'Cargando…');
        await loadMe();
        UI.busy(meRetry, false);
        if (meError.hidden) card.focus();
    });

    // ---------- Últimas partidas ----------
    function row(item) {
        const g = UI.game(item.nameGame);
        const when = item.result === 'EN_CURSO'
            ? `${date(item.dateGame)} · Apostado: ${chips(item.bet || 0)}`
            : date(item.dateGame);
        return el('li', {},
            UI.gameThumb(item.nameGame),
            el('div', {}, el('b', { text: g.label }), el('span', { class: 'when', text: when })),
            UI.resultBadge(item.result),
            UI.continueLink(item) || UI.net(item));
    }

    async function load() {
        try {
            const data = await api('/user/activity?limit=5');
            if (!data.items.length) {
                box.replaceChildren(el('div', { class: 'empty' },
                    el('p', { text: 'Aún no has jugado. ¡Elige un juego y haz tu primera apuesta!' }),
                    el('a', { class: 'btn btn-primary', href: '/roulette', text: 'Probar la ruleta' })));
                return;
            }
            box.replaceChildren(el('ul', { class: 'recent-list' }, data.items.map(row)));
        } catch (err) {
            if (err.status === 401) return;
            const retry = el('button', { class: 'btn btn-sm', type: 'button', text: 'Reintentar' });
            retry.addEventListener('click', load);
            box.replaceChildren(el('div', { class: 'load-error' },
                el('p', { class: 'lose', text: 'No pudimos cargar tus partidas. ' + err.message }), retry));
        }
    }
    loadMe();
    load();
})();
