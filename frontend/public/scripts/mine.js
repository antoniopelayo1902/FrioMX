// Minas 5x5 con 5 minas: destapa casillas seguras y cobra cuando quieras.
(function () {
    'use strict';
    const F = window.FrioMx;
    const $ = (id) => document.getElementById(id);
    const N = 5;
    const SAFE_TOTAL = 20;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---------- Iconos SVG ----------
    const SVG = 'http://www.w3.org/2000/svg';
    function svg(parts, cls) {
        const s = document.createElementNS(SVG, 'svg');
        s.setAttribute('viewBox', '0 0 24 24');
        s.setAttribute('aria-hidden', 'true');
        s.setAttribute('focusable', 'false');
        if (cls) s.setAttribute('class', cls);
        for (const [tag, attrs] of parts) {
            const n = document.createElementNS(SVG, tag);
            for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
            s.append(n);
        }
        return s;
    }
    const ICON = {
        gem: () => svg([
            ['polygon', { points: '12,22 2,9 22,9', fill: '#19d3c5' }],
            ['polygon', { points: '2,9 6.5,3 17.5,3 22,9', fill: '#7af3e8' }],
            ['polygon', { points: '7.5,9 12,3 16.5,9', fill: '#c7fbf6' }],
            ['polygon', { points: '7.5,9 16.5,9 12,22', fill: '#2fe4d6' }],
        ], 'ic-gem'),
        // Bomba con mecha, como la ilustración de la portada.
        mine: () => svg([
            ['circle', { cx: '10.5', cy: '14', r: '7.5', fill: '#ef3b4f' }],
            ['circle', { cx: '10.5', cy: '14', r: '7.5', fill: 'none', stroke: '#9e1f30', 'stroke-width': '1' }],
            ['rect', { x: '13.2', y: '5.2', width: '4', height: '3.4', rx: '.8', fill: '#c62a3d', transform: 'rotate(40 15.2 6.9)' }],
            ['path', { d: 'M16.6 5.2c.6-1.6 2-2.4 3.4-1.8', stroke: '#1b1f2b', 'stroke-width': '1.6', fill: 'none', 'stroke-linecap': 'round' }],
            ['path', { d: 'M20.4 1.2v1.6M20.4 4.4V6M18.4 3.6h1.4M21.2 3.6h1.6', stroke: '#ffd166', 'stroke-width': '1.3', 'stroke-linecap': 'round' }],
            ['circle', { cx: '7.6', cy: '11.2', r: '2', fill: '#ffffff', opacity: '.55' }],
        ], 'ic-mine'),
        flag: () => svg([
            ['path', { d: 'M6 21V3', stroke: '#e9efff', 'stroke-width': '2', 'stroke-linecap': 'round' }],
            ['path', { d: 'M6 4h11l-3 4 3 4H6z', fill: '#f05252' }],
        ], 'ic-flag'),
    };
    document.querySelectorAll('[data-icon]').forEach((n) => n.append(ICON[n.dataset.icon]()));

    // ---------- Elementos ----------
    const els = {
        board: $('board'), hint: $('mnHint'), live: $('mnLive'), outcome: $('mnOutcome'),
        multNow: $('multNow'), multNext: $('multNext'), safe: $('safeCount'), cash: $('btnCash'),
        cashNow: $('cashNow'), cashNext: $('cashNext'), cashMain: $('cashMain'), cashSub: $('cashSub'),
        banner: $('mnBanner'), warn: $('mnWarn'),
        result: $('mnResult'), resTitle: $('resTitle'), resDetail: $('resDetail'),
        start: $('btnStart'), action: $('mnAction'), statusBadge: $('mnStatusBadge'), statusText: $('mnStatusText'),
        empty: $('mnEmpty'), edit: $('btnEditBet'), betHost: $('betHost'), cap: $('mnCap'),
        stage: document.querySelector('.mn-stage'), boardWrap: document.querySelector('.mn-board-wrap'),
        flag: $('btnFlag'), flagText: $('flagText'), sr: $('mnLiveText'),
    };
    const bet = F.betControl(els.betHost, { initial: 10, label: 'Tu apuesta', onEnter: () => start() });
    const mobile = window.matchMedia('(max-width: 900px)');

    // ---------- Estado ----------
    let game = null;      // {gameId, bet, safeCount, multiplier, nextMultiplier, cashoutAmount, nextCashoutAmount, atCap}
    let phase = 'loading'; // loading | idle | playing | over
    let checking = false; // consultando /active tras un clic en reposo
    let broke = false;    // saldo 0
    let busy = false;     // empezando o cobrando
    let flagMode = false;
    let focusIdx = 12;
    const cells = [];     // {btn, state: hidden|flag|pending|safe|mine|boom}
    const queue = [];
    let pumping = false;
    let cashRequested = false;

    const LABEL = {
        hidden: 'tapada', flag: 'con bandera', pending: 'destapando', safe: 'segura', mine: 'mina', boom: 'mina que pisaste',
    };

    // ---------- Tablero ----------
    function buildBoard() {
        for (let x = 0; x < N; x++) {
            for (let y = 0; y < N; y++) {
                const i = x * N + y;
                const btn = F.el('button', { class: 'tile', type: 'button', 'data-x': x, 'data-y': y, tabindex: i === focusIdx ? '0' : '-1' });
                btn.addEventListener('click', () => onCell(i));
                btn.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleFlag(i); });
                btn.addEventListener('focus', () => setFocus(i, false));
                btn.addEventListener('keydown', (e) => onKey(e, i));
                cells.push({ btn, state: 'hidden' });
                els.board.append(btn);
            }
        }
        cells.forEach((_, i) => paint(i));
    }

    function paint(i, { animate = false } = {}) {
        const c = cells[i];
        const x = Math.floor(i / N), y = i % N;
        c.btn.className = 'tile ' + c.state + (animate ? ' pop' : '') + (phase === 'over' && c.state === 'hidden' ? ' rest' : '');
        c.btn.replaceChildren();
        if (c.state === 'safe') c.btn.append(ICON.gem());
        else if (c.state === 'mine' || c.state === 'boom') c.btn.append(ICON.mine());
        else if (c.state === 'flag') c.btn.append(ICON.flag());
        else if (c.state === 'pending') c.btn.append(F.el('span', { class: 'spin', 'aria-hidden': 'true' }));
        c.btn.setAttribute('aria-label', `Fila ${x + 1}, columna ${y + 1}, ${LABEL[c.state]}`);
        c.btn.setAttribute('aria-busy', c.state === 'pending' ? 'true' : 'false');
    }

    function setFocus(i, move = true) {
        cells[focusIdx].btn.tabIndex = -1;
        focusIdx = i;
        cells[i].btn.tabIndex = 0;
        if (move) cells[i].btn.focus();
    }

    function onKey(e, i) {
        const x = Math.floor(i / N), y = i % N;
        let t = null;
        if (e.key === 'ArrowRight') t = x * N + Math.min(N - 1, y + 1);
        else if (e.key === 'ArrowLeft') t = x * N + Math.max(0, y - 1);
        else if (e.key === 'ArrowDown') t = Math.min(N - 1, x + 1) * N + y;
        else if (e.key === 'ArrowUp') t = Math.max(0, x - 1) * N + y;
        else if (e.key === 'Home') t = x * N;
        else if (e.key === 'End') t = x * N + N - 1;
        else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFlag(i); return; }
        if (t !== null) { e.preventDefault(); setFocus(t); }
    }

    function resetBoard() {
        queue.length = 0;
        cells.forEach((c, i) => { c.state = 'hidden'; paint(i); });
    }

    // ---------- Panel ----------
    const fmtMult = (m) => 'x' + Number(m).toFixed(2);
    // Montos exactos del servidor: nunca se calcula apuesta × multiplicador aquí.
    function takeView(g) {
        return {
            gameId: g.gameId, bet: g.bet, safeCount: g.safeCount, multiplier: g.multiplier, nextMultiplier: g.nextMultiplier,
            cashoutAmount: g.cashoutAmount, nextCashoutAmount: g.nextCashoutAmount, atCap: !!g.atCap,
        };
    }
    function showBanner(text) { els.banner.textContent = text; els.banner.hidden = !text; }

    function betTyped() {
        const raw = bet.input.value.trim();
        return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null;
    }
    function statusLine(prefix, amount, suffix = '') {
        els.statusText.replaceChildren(prefix, F.el('strong', { class: 'num', text: amount == null ? '—' : F.chips(amount) }), suffix);
    }

    // Estado + botón principal: uno solo (Empezar / Jugar otra vez / Cobrar), en celular va en la barra fija.
    function refreshAction() {
        const live = phase === 'playing';
        broke = F.getBalance() === 0 && !live;
        els.empty.hidden = !broke;
        els.statusBadge.hidden = !live;
        if (phase === 'loading') els.statusText.textContent = 'Cargando tu partida…';
        else if (live) statusLine('· ', game.bet);
        else if (broke) els.statusText.replaceChildren('Sin fichas · ', F.el('a', { href: '/balance', text: 'Ver mi saldo' }));
        else statusLine('Apuesta: ', betTyped());
        els.start.hidden = live;
        els.cash.hidden = !live;
        els.edit.hidden = live || phase === 'loading';
        if (phase === 'over') {
            const n = betTyped();
            els.start.textContent = n ? `Jugar otra vez · ${F.chips(n)}` : 'Jugar otra vez';
        } else {
            els.start.textContent = 'Empezar partida';
        }
        els.start.disabled = busy || broke || phase === 'loading';
        bet.setDisabled(live || broke || phase === 'loading');
        els.action.classList.toggle('live', live);
        if (live) updateLive();
    }
    bet.input.addEventListener('input', refreshAction);
    els.betHost.addEventListener('click', () => setTimeout(refreshAction, 0));
    F.onBalance(() => refreshAction());

    function measureBar() {
        const fixed = getComputedStyle(els.action).position === 'fixed';
        const h = fixed ? els.action.offsetHeight + 'px' : '0px';
        document.documentElement.style.setProperty('--gm-bar-h', h);
        document.documentElement.style.setProperty('--game-bar-h', h);
    }
    if ('ResizeObserver' in window) new ResizeObserver(measureBar).observe(els.action);
    window.addEventListener('resize', measureBar);

    function scrollToBoard() {
        if (mobile.matches) els.boardWrap.scrollIntoView({ block: 'start' });
    }
    els.edit.addEventListener('click', () => {
        els.betHost.scrollIntoView({ block: 'center' });
        bet.input.focus({ preventScroll: true });
        bet.input.select();
    });

    function setCash(main, sub = '') {
        els.cashMain.textContent = main;
        els.cashSub.textContent = sub;
        els.cashSub.hidden = !sub;
    }
    function updateLive() {
        if (!game) return;
        const last = game.safeCount >= SAFE_TOTAL || game.atCap;
        els.cashNow.textContent = F.num(game.cashoutAmount);
        els.cashNext.textContent = last ? '—' : F.num(game.nextCashoutAmount);
        els.multNow.textContent = fmtMult(game.multiplier);
        els.multNext.textContent = last ? '' : fmtMult(game.nextMultiplier);
        els.safe.textContent = `${game.safeCount}/${SAFE_TOTAL}`;
        const waiting = cashRequested || busy;
        const noGain = game.safeCount > 0 && game.cashoutAmount <= game.bet;
        els.cap.hidden = !game.atCap;
        els.warn.hidden = !noGain;
        els.cash.classList.toggle('cap', !!game.atCap && !cashRequested);
        statusLine('· ', game.bet, ` · ${game.safeCount} ${game.safeCount === 1 ? 'segura' : 'seguras'}`);
        const amount = F.chips(game.cashoutAmount);
        if (cashRequested) {
            setCash('Cobrando…');
        } else if (game.atCap) {
            setCash(`Cobra ya: ${amount}`, 'llegaste al pago máximo');
        } else if (game.safeCount === 0) {
            setCash('Destapa una casilla para cobrar');
        } else if (noGain) {
            setCash(`Cobrar ${amount}`, 'aún no ganas nada al cobrar');
        } else {
            setCash(`Cobrar ${amount}`, last ? '' : `si destapas otra: ${F.num(game.nextCashoutAmount)}`);
        }
        els.cash.setAttribute('aria-label', els.cashSub.hidden ? els.cashMain.textContent : `${els.cashMain.textContent}; ${els.cashSub.textContent}`);
        els.cash.disabled = waiting || game.safeCount === 0;
    }

    const layout = document.querySelector('.mn-layout');
    function showIdle({ loading = false } = {}) {
        phase = loading ? 'loading' : 'idle';
        layout.classList.add('idle');
        game = null;
        els.hint.textContent = '';
        if (loading) els.hint.append('Cargando tu partida…');
        else els.hint.append('Elige tu apuesta y pulsa ', F.el('strong', { text: 'Empezar partida' }), '.');
        els.hint.hidden = false; els.live.hidden = true; els.outcome.hidden = true;
        els.board.classList.remove('live', 'over');
        els.board.classList.toggle('loading', loading);
        els.board.setAttribute('aria-busy', loading ? 'true' : 'false');
        refreshAction();
    }

    function showPlaying(g, { restored = false } = {}) {
        phase = 'playing';
        layout.classList.remove('idle');
        game = takeView(g);
        if (!restored) showBanner('');
        cashRequested = false;
        resetBoard();
        (g.revealed || []).forEach(({ x, y }) => { cells[x * N + y].state = 'safe'; paint(x * N + y); });
        els.hint.hidden = true; els.outcome.hidden = true; els.live.hidden = false;
        bet.set(game.bet);
        els.board.classList.add('live');
        els.board.classList.remove('over', 'loading');
        els.board.setAttribute('aria-busy', 'false');
        refreshAction();
        els.sr.textContent = restored
            ? `Retomamos tu partida: ${game.safeCount} casillas seguras, cobras ahora ${F.chips(game.cashoutAmount)}.`
            : 'Partida iniciada. Destapa una casilla.';
        scrollToBoard();
        cells[focusIdx].btn.focus({ preventScroll: true });
    }

    function showOver(data) {
        phase = 'over';
        layout.classList.remove('idle');
        queue.length = 0;
        const mines = new Set((data.mines || []).map(({ x, y }) => x * N + y));
        const hit = data.result === 'mine' && data.cell ? data.cell.x * N + data.cell.y : -1;
        (data.revealed || []).forEach(({ x, y }) => { cells[x * N + y].state = 'safe'; });
        cells.forEach((c, i) => {
            if (i === hit) c.state = 'boom';
            else if (mines.has(i)) c.state = 'mine';
            else if (c.state !== 'safe') c.state = 'hidden';
            paint(i, { animate: mines.has(i) });
        });
        els.board.classList.remove('live');
        els.board.classList.add('over');
        els.live.hidden = true; els.hint.hidden = true; els.outcome.hidden = false;
        showBanner('');
        bet.set(game ? game.bet : data.bet);

        const b = data.bet;
        const safe = data.safeCount;
        els.result.classList.remove('win', 'lose', 'even');
        if (data.status === 'LOST') {
            els.result.classList.add('lose');
            els.resTitle.textContent = `Pisaste una mina: perdiste ${F.chips(b)}`;
            els.resDetail.textContent = safe
                ? `Llevabas ${safe} ${safe === 1 ? 'casilla segura' : 'casillas seguras'}.`
                : 'Fue tu primera casilla.';
        } else {
            els.result.classList.add('win');
            const prefix = data.status === 'WON' ? '¡Tablero limpio! ' : '';
            els.resTitle.textContent = data.amountChange > 0
                ? `${prefix}Ganaste ${F.chips(data.amountChange, { sign: true })}`
                : `${prefix}Cobraste ${F.chips(data.payout)}: quedas igual`;
            if (data.amountChange <= 0) { els.result.classList.remove('win'); els.result.classList.add('even'); }
            const mult = document.createElement('span');
            mult.className = 'mult num';
            mult.textContent = ` · ${fmtMult(data.multiplier)}`;
            els.resDetail.replaceChildren(`Recibes ${F.chips(data.payout)} por tu apuesta de ${F.num(b)} con ${safe} ${safe === 1 ? 'casilla segura' : 'casillas seguras'}.`);
        }
        els.sr.textContent = '';
        game = null;
        refreshAction();
        if (mobile.matches) els.result.scrollIntoView({ block: 'nearest' });
        (els.start.disabled ? els.result : els.start).focus({ preventScroll: true });
    }

    // La partida se resolvió en otra pestaña (o expiró): se dice qué pasó y dónde verlo.
    function showFinishedElsewhere(expired) {
        resetBoard();
        showIdle();
        phase = 'over';
        layout.classList.remove('idle');
        els.board.classList.add('over');
        els.hint.hidden = true; els.outcome.hidden = false;
        els.result.classList.remove('win', 'lose', 'even');
        els.result.classList.add('even');
        els.resTitle.textContent = expired ? 'Esta partida ya terminó o expiró' : 'Esta partida ya terminó en otra pestaña';
        els.resDetail.replaceChildren('Tu saldo ya está actualizado. ',
            F.el('a', { href: '/activity', text: 'Ver el resultado en Historial' }), '.');
        cells.forEach((_, i) => paint(i));
        refreshAction();
        els.result.focus({ preventScroll: true });
    }

    async function finishedElsewhere(e) {
        queue.length = 0;
        F.refreshBalance().catch(() => {});
        let restored = false;
        try { restored = await restoreActive({ notify: false }); } catch { /* sin conexión */ }
        if (restored) showBanner('Esa partida ya terminó en otra pestaña. Retomamos la que tienes abierta.');
        else showFinishedElsewhere(e.status === 404);
    }

    // ---------- Acciones ----------
    async function restoreActive({ notify = true } = {}) {
        const data = await F.api('/games/mines/active');
        if (data.round) {
            showPlaying(data.round, { restored: true });
            if (notify) showBanner('Retomamos tu partida en curso.');
            return true;
        }
        return false;
    }

    function setBusy(b) {
        busy = b;
        refreshAction();
    }

    async function start() {
        if (busy || phase === 'playing' || phase === 'loading' || broke) return;
        const amount = bet.value();
        if (amount === null) { bet.input.focus(); return; }
        F.clearToasts();
        showBanner('');
        setBusy(true);
        try {
            const data = await F.api('/games/mines/start', { method: 'POST', body: { betAmount: amount } });
            F.setBalance(data.newBalance);
            showPlaying(data);
        } catch (e) {
            if (e.code === 'ROUND_ACTIVE') {
                try { await restoreActive(); } catch (e2) { F.toast(e2.message, 'error'); }
            } else if (e.status !== 401) {
                if (e.status === 409) F.refreshBalance().catch(() => {});
                bet.setError(e.message);
                F.toast(e.message, 'error');
            }
        } finally {
            setBusy(false);
        }
    }

    function onCell(i) {
        setFocus(i, false);
        const c = cells[i];
        if (phase === 'loading' || checking) { F.toast('Cargando tu partida…', 'info', 2000); return; }
        if (phase !== 'playing') { checkElsewhere(); return; }
        if (cashRequested) { F.toast('Estamos cobrando tu partida.', 'info', 2000); return; }
        if (flagMode) { toggleFlag(i); return; }
        if (c.state === 'flag') { F.toast('Esta casilla tiene bandera. Quítala para destaparla.', 'info', 2500); return; }
        if (c.state !== 'hidden') return; // ya destapada o en cola
        c.state = 'pending';
        paint(i);
        queue.push(i);
        pump();
    }

    // En reposo: antes de pedir «Empezar partida», se mira si hay una partida viva (p. ej. de otra pestaña).
    async function checkElsewhere() {
        if (busy) return;
        checking = true;
        const wasOver = phase === 'over';
        let restored = false;
        try {
            restored = await restoreActive({ notify: false });
        } catch (e) {
            if (e.status === 401) return;
        } finally {
            checking = false;
        }
        if (restored) { showBanner('Retomamos tu partida en curso.'); return; }
        if (F.getBalance() === 0) { F.toast('Te quedaste sin fichas.', 'info', 3000); return; }
        F.toast(wasOver ? 'La partida terminó. Pulsa «Jugar otra vez» para seguir.' : 'Primero pulsa «Empezar partida».', 'info', 2500);
    }

    function toggleFlag(i) {
        if (phase !== 'playing') return;
        const c = cells[i];
        if (c.state === 'hidden') c.state = 'flag';
        else if (c.state === 'flag') c.state = 'hidden';
        else return;
        paint(i);
    }

    async function pump() {
        if (pumping) return;
        pumping = true;
        try {
            while (queue.length && phase === 'playing') {
                await revealOne(queue.shift());
            }
        } finally {
            pumping = false;
        }
        if (cashRequested && phase === 'playing') doCashout();
    }

    async function revealOne(i) {
        const x = Math.floor(i / N), y = i % N;
        for (let attempt = 0; ; attempt++) {
            try {
                const data = await F.api('/games/mines/reveal', { method: 'POST', body: { gameId: game.gameId, x, y } });
                applyReveal(i, data);
                return;
            } catch (e) {
                if (e.code === 'CONFLICT' && attempt < 4) { await sleep(120 * (attempt + 1)); continue; }
                if (e.status === 401) return;
                if (e.code === 'GAME_FINISHED' || e.status === 404) { await finishedElsewhere(e); return; }
                cells[i].state = 'hidden';
                paint(i);
                F.toast(`No pudimos destapar la fila ${x + 1}, columna ${y + 1}: ${e.message}`, 'error');
                return;
            }
        }
    }

    function applyReveal(i, data) {
        if (data.status === 'ACTIVE') {
            Object.assign(game, takeView({ ...data, gameId: game.gameId, bet: game.bet }));
            (data.revealed || []).forEach(({ x, y }) => {
                const k = x * N + y;
                if (cells[k].state !== 'safe') { cells[k].state = 'safe'; paint(k, { animate: k === i }); }
            });
            updateLive();
            els.sr.textContent = `Fila ${Math.floor(i / N) + 1}, columna ${(i % N) + 1}: segura. Cobras ahora ${F.chips(game.cashoutAmount)}.`;
            return;
        }
        if (typeof data.newBalance === 'number') F.setBalance(data.newBalance);
        showOver(data);
    }

    async function cashout() {
        if (phase !== 'playing' || !game || game.safeCount === 0 || cashRequested) return;
        cashRequested = true;
        updateLive();
        if (!pumping && !queue.length) doCashout();
    }

    async function doCashout() {
        try {
            const data = await F.api('/games/mines/cashout', { method: 'POST', body: { gameId: game.gameId } });
            F.setBalance(data.newBalance);
            cashRequested = false;
            showOver(data);
        } catch (e) {
            cashRequested = false;
            if (e.status === 401) return;
            if (e.code === 'GAME_FINISHED' || e.status === 404) { await finishedElsewhere(e); return; }
            F.toast(e.message, 'error');
            if (e.status === 409) {
                F.refreshBalance().catch(() => {});
                let restored = false;
                try { restored = await restoreActive({ notify: false }); } catch { /* sin conexión */ }
                if (!restored) { resetBoard(); showIdle(); }
            } else {
                updateLive();
            }
        }
    }

    function setFlagMode(on) {
        flagMode = on;
        els.flag.setAttribute('aria-pressed', on ? 'true' : 'false');
        els.flag.classList.toggle('on', on);
        els.flagText.textContent = on ? 'Modo bandera: encendido' : 'Modo bandera: apagado';
        els.board.classList.toggle('flagging', on);
    }

    els.start.addEventListener('click', start);
    els.cash.addEventListener('click', cashout);
    els.flag.addEventListener('click', () => setFlagMode(!flagMode));

    buildBoard();
    showIdle({ loading: true });
    measureBar();
    restoreActive()
        .then((had) => { if (!had) showIdle(); })
        .catch((e) => { showIdle(); if (e.status !== 401) F.toast(e.message, 'error'); });
})();
