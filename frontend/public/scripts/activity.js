// FrioMx: historial de partidas con paginación por cursor y filtro por juego.
(function () {
    'use strict';
    const F = window.FrioMx;
    const { api, el, date, chips } = F;
    const UI = window.FrioUI;

    const table = document.getElementById('table');
    const rows = document.getElementById('rows');
    const status = document.getElementById('status');
    const more = document.getElementById('more');
    const summary = document.getElementById('summary');
    const filterBtns = document.querySelectorAll('[data-filter]');

    const items = [];
    let cursor = null;
    let filter = '';
    let searching = false;

    const label = (item) => UI.game(item.nameGame).label;

    function row(item) {
        const g = UI.game(item.nameGame);
        return el('tr', {},
            el('td', { class: 'c-game' }, el('span', { class: 'game' }, UI.gameThumb(item.nameGame),
                el('span', { class: 'game-text' }, el('span', { text: g.label }),
                    item.detail ? el('span', { class: 'detail', text: item.detail }) : null))),
            el('td', { class: 'c-date', text: date(item.dateGame) }),
            el('td', { class: 'c-bet right num', text: chips(item.bet || 0) }),
            el('td', { class: 'c-res' }, el('span', { class: 'res' }, UI.resultBadge(item.result), UI.continueLink(item))),
            el('td', { class: 'c-net right' }, UI.net(item)));
    }

    // Neto de una partida terminada (una ronda en curso todavía no cuenta).
    function netOf(item) {
        if (item.result === 'EN_CURSO') return null;
        if (item.result === 'ABANDONADA') return -Math.abs(item.bet || Math.abs(item.balance || 0));
        return Number(item.balance) || 0;
    }
    const sameDay = (iso, d) => { const x = new Date(iso); return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate(); };
    const games = (n) => (n === 1 ? '1 partida' : `${F.num(n)} partidas`);
    function tally(list) {
        const done = list.filter((i) => netOf(i) !== null);
        return { n: done.length, net: done.reduce((s, i) => s + netOf(i), 0) };
    }
    function summaryLine(title, t, cls) {
        const kind = t.net > 0 ? 'pos' : t.net < 0 ? 'neg' : 'zero';
        return el('p', { class: cls },
            el('span', { class: 'k', text: title }),
            el('span', { class: `amount ${kind}`, text: chips(t.net, { sign: true }) }),
            el('span', { class: 'muted', text: ` en ${games(t.n)}` }));
    }
    // Resumen de lo cargado hasta ahora (lo que se ve en la lista, con el filtro aplicado).
    function renderSummary(shown) {
        const todayItems = shown.filter((i) => sameDay(i.dateGame, new Date()));
        const all = tally(shown);
        summary.hidden = all.n === 0;
        if (summary.hidden) return;
        // "Hoy" solo se afirma si ya están cargadas todas las partidas de hoy: no hay más páginas,
        // o la última partida cargada ya es de otro día. Si no, se habla solo de lo que se ve.
        const last = items[items.length - 1];
        const todayComplete = !cursor || (last && !sameDay(last.dateGame, new Date()));
        const lines = [];
        if (todayComplete && todayItems.length) lines.push(summaryLine('Hoy: ', tally(todayItems), 'today'));
        lines.push(summaryLine(cursor ? 'En las partidas que se ven: ' : 'En total: ', all, 'total'));
        summary.replaceChildren(...lines);
    }

    function render() {
        const shown = filter ? items.filter((i) => label(i) === filter) : items;
        renderSummary(shown);
        rows.replaceChildren(...shown.map(row));
        table.hidden = shown.length === 0;
        more.hidden = !cursor || searching;
        if (!items.length) {
            status.replaceChildren(el('div', { class: 'empty' },
                el('p', { text: 'Aún no hay partidas. ¡Ve a Juegos y haz tu primera apuesta!' }),
                el('a', { class: 'btn btn-primary', href: '/index_logIn', text: 'Ir a Juegos' })));
        } else if (!shown.length) {
            status.replaceChildren(el('p', { class: 'empty', text: !cursor
                ? `No tienes partidas de ${filter}.`
                : searching
                    ? `Buscando partidas de ${filter} en tu historial…`
                    : `No encontramos partidas de ${filter} en tus últimas ${items.length}. Toca "Ver más" para seguir buscando.` }));
        } else {
            status.replaceChildren();
        }
    }

    // Una sola petición a la vez: el filtro y "Ver más" no deben pedir dos veces la misma página.
    let inflight = null;
    function load() {
        if (!inflight) inflight = loadPage().finally(() => { inflight = null; });
        return inflight;
    }
    async function loadPage() {
        more.disabled = true;
        try {
            const q = '/user/activity?limit=20' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
            const data = await api(q);
            items.push(...data.items);
            cursor = data.nextCursor;
            render();
            return true;
        } catch (err) {
            if (err.status === 401) return false;
            const retry = el('button', { class: 'btn btn-sm', type: 'button', text: 'Reintentar' });
            retry.addEventListener('click', () => { status.replaceChildren(el('p', { class: 'empty', text: 'Cargando partidas…' })); load(); });
            status.replaceChildren(el('div', { class: 'load-error' },
                el('p', { class: 'lose', text: 'No pudimos cargar tu historial. ' + err.message }), retry));
            return false;
        } finally {
            more.disabled = false;
        }
    }

    // Con un filtro activo y sin coincidencias entre lo cargado, se siguen pidiendo páginas
    // hasta encontrar una partida de ese juego o llegar al final (el backend no filtra).
    let search = 0;
    async function fill() {
        const mine = ++search;
        const want = filter;
        const missing = () => filter === want && cursor && !items.some((i) => label(i) === want);
        if (!missing()) { if (searching) { searching = false; render(); } return; }
        let pages = 0;
        let failed = false;
        searching = true;
        render();
        try {
            while (missing() && pages < 50) {
                pages += 1;
                if (!(await load())) { failed = true; return; }
                if (mine !== search) return;
            }
        } finally {
            if (mine === search) {
                searching = false;
                if (failed) more.hidden = !cursor; else render();
            }
        }
    }
    filterBtns.forEach((btn) => btn.addEventListener('click', () => {
        filter = btn.dataset.filter;
        filterBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        render();
        fill();
    }));
    more.addEventListener('click', async () => { if (await load()) fill(); });
    load();
})();
