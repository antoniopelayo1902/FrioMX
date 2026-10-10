// FrioMx: ranking semanal (semana en curso y semanas cerradas con sus premios).
(function () {
    'use strict';
    const F = window.FrioMx;
    const { api, el, chips } = F;
    const $ = (id) => document.getElementById(id);

    // ---------- Semanas ISO ("2026-W41") ----------
    const WEEK = /^(\d{4})-W(\d{2})$/;
    function weekRange(weekId) {
        const m = WEEK.exec(weekId || '');
        if (!m) return null;
        const year = Number(m[1]);
        const week = Number(m[2]);
        // La semana 1 es la que contiene el 4 de enero; empieza en lunes.
        const jan4 = new Date(Date.UTC(year, 0, 4));
        const monday = new Date(jan4);
        monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
        const sunday = new Date(monday);
        sunday.setUTCDate(monday.getUTCDate() + 6);
        const fmt = (d, opts) => d.toLocaleDateString('es-MX', { timeZone: 'UTC', ...opts });
        const sameMonth = monday.getUTCMonth() === sunday.getUTCMonth();
        const from = sameMonth ? fmt(monday, { day: 'numeric' }) : fmt(monday, { day: 'numeric', month: 'short' });
        const to = fmt(sunday, { day: 'numeric', month: 'short', year: 'numeric' });
        return { week, text: `Semana ${week}: del ${from} al ${to}` };
    }
    const rangeText = (weekId) => (weekRange(weekId) || { text: weekId }).text;

    // ---------- Tabla ----------
    function netNode(n) {
        const kind = n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero';
        return el('span', { class: `amount ${kind}`, text: chips(n, { sign: true }) });
    }
    function rankNode(rank) {
        return el('span', { class: `rank-pos${rank <= 3 ? ' r' + rank : ''}`, text: String(rank) });
    }
    function table(rows, { withPrize = false, myRank = null } = {}) {
        const head = el('tr', {},
            el('th', { scope: 'col', class: 'c-rank', text: 'Lugar' }),
            el('th', { scope: 'col', text: 'Jugador' }),
            el('th', { scope: 'col', class: 'right', text: 'Ganancia' }),
            withPrize ? el('th', { scope: 'col', class: 'right', text: 'Premio' }) : null);
        const body = rows.map((r) => {
            const mine = myRank !== null && r.rank === myRank;
            return el('tr', { class: mine ? 'is-me' : undefined, 'aria-current': mine ? 'true' : undefined },
                el('td', { class: 'c-rank' }, rankNode(r.rank)),
                el('td', { class: 'c-name' }, el('span', { class: 'name', text: r.name }), mine ? el('span', { class: 'badge badge-win you', text: 'Tú' }) : null),
                el('td', { class: 'right' }, netNode(r.net)),
                withPrize ? el('td', { class: 'right prize-cell', text: r.prize ? '+' + F.num(r.prize) : '—' }) : null);
        });
        return el('div', { class: 'table-wrap' },
            el('table', { class: 'table rank-table' }, el('thead', {}, head), el('tbody', {}, body)));
    }
    function errorBox(text, retry) {
        return el('div', { class: 'load-error' },
            el('p', { class: 'lose', text }),
            el('button', { class: 'btn btn-sm', type: 'button', text: 'Reintentar', onclick: retry }));
    }
    const games = (n) => (n === 1 ? '1 partida' : `${F.num(n)} partidas`);

    // ---------- Semana en curso ----------
    async function loadCurrent() {
        const box = $('current');
        const meBox = $('current-me');
        try {
            const data = await api('/leaderboard/current');
            $('current-range').textContent = rangeText(data.weekId);
            const me = data.me || { rank: null, net: 0, gamesPlayed: 0 };
            meBox.hidden = false;
            if (me.rank === null) {
                meBox.className = 'rank-me none';
                meBox.replaceChildren(
                    el('p', { text: 'Aún no has jugado esta semana. Juega una partida para aparecer en el ranking.' }),
                    el('a', { class: 'btn btn-sm btn-primary', href: '/index_logIn', text: 'Elegir un juego' }));
            } else {
                meBox.className = 'rank-me';
                const lines = [el('p', {},
                    el('span', { text: 'Vas en el ' }), el('strong', { text: `lugar ${F.num(me.rank)}` }),
                    el('span', { text: ' con ' }), netNode(me.net),
                    el('span', { class: 'muted', text: ` en ${games(me.gamesPlayed)}.` }))];
                if (me.net <= 0) lines.push(el('p', { class: 'muted small', text: 'Para ganar premio necesitas terminar la semana con ganancia.' }));
                else if (me.rank > 3) lines.push(el('p', { class: 'muted small', text: 'Sube al top 3 antes del domingo para ganar premio.' }));
                meBox.replaceChildren(...lines);
            }
            if (!data.top.length) {
                box.replaceChildren(el('p', { class: 'empty', text: 'Nadie ha jugado esta semana todavía. ¡Juega una partida y sé el primero!' }));
                return;
            }
            box.replaceChildren(table(data.top, { myRank: me.rank }));
        } catch (err) {
            if (err.status === 401) return;
            meBox.hidden = true;
            box.replaceChildren(errorBox('No pudimos cargar el ranking. ' + err.message, () => {
                box.replaceChildren(el('p', { class: 'empty', text: 'Cargando ranking…' }));
                loadCurrent();
            }));
        }
    }

    // ---------- Semanas cerradas ----------
    const select = $('week');
    let lastReq = 0;
    async function loadWeek(weekId) {
        const box = $('last');
        const mine = ++lastReq;
        $('last-range').textContent = rangeText(weekId);
        box.replaceChildren(el('p', { class: 'empty', text: 'Cargando…' }));
        try {
            const data = await api('/leaderboard/last?weekId=' + encodeURIComponent(weekId));
            if (mine !== lastReq) return;
            if (!data.top.length) {
                box.replaceChildren(el('p', { class: 'empty', text: 'Esa semana nadie terminó con ganancia, así que no hubo premios.' }));
                return;
            }
            box.replaceChildren(table(data.top, { withPrize: true }));
        } catch (err) {
            if (err.status === 401 || mine !== lastReq) return;
            if (err.status === 404) {
                box.replaceChildren(el('p', { class: 'empty', text: 'No encontramos resultados de esa semana.' }));
                return;
            }
            box.replaceChildren(errorBox('No pudimos cargar esa semana. ' + err.message, () => loadWeek(weekId)));
        }
    }
    function setUrl(weekId) {
        const url = new URL(location.href);
        url.searchParams.set('weekId', weekId);
        history.replaceState(null, '', url.pathname + url.search);
    }
    async function loadWeeks() {
        const box = $('last');
        try {
            const weeks = await api('/leaderboard/weeks');
            if (!weeks.length) {
                $('week-pick').hidden = true;
                box.replaceChildren(el('p', { class: 'empty', text: 'Todavía no se cierra ninguna semana. Los primeros premios se entregan el próximo lunes.' }));
                return;
            }
            select.replaceChildren(...weeks.map((w) => {
                const r = weekRange(w);
                return el('option', { value: w, text: r ? r.text : w });
            }));
            $('week-pick').hidden = false;
            const asked = new URLSearchParams(location.search).get('weekId');
            const chosen = weeks.includes(asked) ? asked : weeks[0];
            select.value = chosen;
            loadWeek(chosen);
        } catch (err) {
            if (err.status === 401) return;
            box.replaceChildren(errorBox('No pudimos cargar las semanas. ' + err.message, () => {
                box.replaceChildren(el('p', { class: 'empty', text: 'Cargando semanas…' }));
                loadWeeks();
            }));
        }
    }
    select.addEventListener('change', () => { setUrl(select.value); loadWeek(select.value); });

    loadCurrent();
    loadWeeks();
})();
