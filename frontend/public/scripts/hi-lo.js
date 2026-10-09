// Hi-Lo: repartir -> elegir Mayor/Menor -> resultado con las dos cartas.
(function () {
    'use strict';
    const F = window.FrioMx;
    const $ = (id) => document.getElementById(id);

    const SUITS = [
        { s: '♠', name: 'picas', red: false },
        { s: '♥', name: 'corazones', red: true },
        { s: '♦', name: 'diamantes', red: true },
        { s: '♣', name: 'tréboles', red: false },
    ];
    const rankLabel = (v) => (v === 11 ? 'J' : v === 12 ? 'Q' : String(v));
    const rankName = (v) => (v === 11 ? 'J (11)' : v === 12 ? 'Q (12)' : String(v));
    // Palo determinista: sale del roundId, así una ronda retomada muestra la misma carta.
    function suitIndex(seed) {
        let h = 2166136261;
        for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
        return (h >>> 0) % SUITS.length;
    }

    const els = {
        stage: document.querySelector('.hl-stage'), table: $('hlTable'),
        cardOld: $('cardOld'), cardNew: $('cardNew'), slotNew: $('slotNew'), arrow: $('hlArrow'),
        labelOld: $('labelOld'), cardsText: $('cardsText'),
        hint: $('hlHint'), choices: $('hlChoices'), outcome: $('hlOutcome'),
        higher: $('btnHigher'), lower: $('btnLower'), subHigher: $('subHigher'), subLower: $('subLower'),
        result: $('hlResult'), resTitle: $('resTitle'), resDetail: $('resDetail'),
        deal: $('btnDeal'), action: $('hlAction'), statusBadge: $('hlStatusBadge'), statusText: $('hlStatusText'),
        empty: $('hlEmpty'), edit: $('btnEditBet'), betHost: $('betHost'),
        banner: $('hlBanner'), odds: $('hlOdds'), warn: $('hlWarn'),
    };

    const bet = F.betControl(els.betHost, { initial: 10, label: 'Tu apuesta', onEnter: () => deal() });

    let state = 'loading'; // loading | idle | open | done
    let busy = false;
    let round = null;      // {roundId, oldCard, bet, options, suit}
    let lastRoundId = null;
    let broke = false;     // saldo 0
    let focusAfterBusy = null;

    const mobile = window.matchMedia('(max-width: 900px)');

    // ---------- Apuesta y botón principal ----------
    function betTyped() {
        const raw = bet.input.value.trim();
        return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null;
    }
    function statusLine(prefix, amount, suffix = '') {
        els.statusText.replaceChildren(prefix, F.el('strong', { class: 'num', text: amount == null ? '—' : F.chips(amount) }), suffix);
    }

    function refreshAction() {
        const live = state === 'open';
        broke = F.getBalance() === 0 && !live;
        els.empty.hidden = !broke;
        els.statusBadge.hidden = !live;
        if (state === 'loading') {
            els.statusText.textContent = 'Cargando tu ronda…';
        } else if (live) {
            statusLine('· ', round.bet);
        } else {
            if (broke) els.statusText.replaceChildren('Sin fichas · ', F.el('a', { href: '/balance', text: 'Ver mi saldo' }));
            else statusLine('Apuesta: ', betTyped());
        }
        els.deal.hidden = live;
        els.edit.hidden = live || state === 'loading';
        if (state === 'done') {
            const n = betTyped();
            els.deal.textContent = n ? `Jugar otra vez · ${F.chips(n)}` : 'Jugar otra vez';
        } else {
            els.deal.textContent = 'Repartir';
        }
        els.deal.disabled = busy || broke || state === 'loading';
        bet.setDisabled(live || broke || state === 'loading');
        els.action.classList.toggle('live', live);
    }

    // La etiqueta sigue al campo: teclado, ½, ×2, Máx y fichas rápidas.
    bet.input.addEventListener('input', refreshAction);
    els.betHost.addEventListener('click', () => setTimeout(refreshAction, 0));
    F.onBalance(() => refreshAction());

    // Celular: altura real de la barra fija para reservar espacio abajo.
    function measureBar() {
        const fixed = getComputedStyle(els.action).position === 'fixed';
        const h = fixed ? els.action.offsetHeight + 'px' : '0px';
        document.documentElement.style.setProperty('--gm-bar-h', h);
        document.documentElement.style.setProperty('--game-bar-h', h);
    }
    if ('ResizeObserver' in window) new ResizeObserver(measureBar).observe(els.action);
    window.addEventListener('resize', measureBar);

    function scrollToStage() {
        if (!mobile.matches) return;
        els.stage.scrollIntoView({ block: 'start' });
    }

    els.edit.addEventListener('click', () => {
        els.betHost.scrollIntoView({ block: 'center' });
        bet.input.focus({ preventScroll: true });
        bet.input.select();
    });

    // ---------- Cartas ----------
    function renderCard(node, value, suit) {
        node.replaceChildren();
        node.className = 'pcard';
        if (value == null) { node.classList.add('empty'); return; }
        if (suit.red) node.classList.add('red');
        const corner = (cls) => F.el('span', { class: 'corner ' + cls },
            F.el('span', { class: 'r', text: rankLabel(value) }), F.el('span', { class: 's', text: suit.s }));
        node.append(corner('tl'), F.el('span', { class: 'pip', text: suit.s }),
            F.el('span', { class: 'big num', text: rankLabel(value) }), corner('br'));
        node.classList.add('flip');
    }
    function renderBack(node) {
        node.replaceChildren(F.el('span', { class: 'logo', text: 'FrioMx' }));
        node.className = 'pcard back';
    }

    function fmtMult(m) { return 'x' + m.toFixed(2); }
    // Porcentajes enteros que suman 100: lo que no es Mayor ni Menor es empate.
    function chances(o) {
        const hi = o.higher ? Math.round(o.higher.chance * 100) : 0;
        const lo = o.lower ? Math.round(o.lower.chance * 100) : 0;
        return { hi, lo, tie: Math.max(0, 100 - hi - lo) };
    }

    // El botón muestra el pago exacto del servidor (options[].payout): es lo que recibes si aciertas.
    function setChoice(btn, sub, opt, label, pct) {
        const amount = round.bet;
        if (!opt) {
            btn.disabled = true;
            sub.textContent = 'Imposible con ' + rankName(round.oldCard);
            btn.setAttribute('aria-label', `${label}: imposible con ${rankName(round.oldCard)}`);
            return false;
        }
        btn.disabled = false;
        const pay = opt.payout;
        const gain = pay - amount;
        const flat = gain <= 0;
        const payText = flat ? `Si aciertas: recibes ${F.num(pay)}, sin ganancia` : `Si aciertas: ganas ${F.num(gain)} (recibes ${F.num(pay)})`;
        sub.replaceChildren(
            F.el('span', { class: 'pay' + (flat ? ' flat' : ''), text: payText }),
            F.el('span', { class: 'odds', text: `${pct}\u00a0% · ${fmtMult(opt.multiplier)}` }));
        btn.setAttribute('aria-label', flat
            ? `${label}: si aciertas recibes ${F.chips(pay)}, sin ganancia; probabilidad ${pct} %`
            : `${label}: si aciertas ganas ${F.chips(gain)} y recibes ${F.chips(pay)}; probabilidad ${pct} %`);
        return flat;
    }

    function showBanner(text) {
        els.banner.textContent = text;
        els.banner.hidden = !text;
    }

    function setStep(n) {
        document.querySelectorAll('.hl-steps li').forEach((li) => {
            const s = Number(li.dataset.step);
            li.classList.toggle('active', s === n);
            li.classList.toggle('done', s < n);
            if (s === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
        });
    }

    // ---------- Estados ----------
    function showIdle({ loading = false } = {}) {
        state = loading ? 'loading' : 'idle';
        els.stage.classList.add('idle');
        round = null;
        setStep(1);
        renderBack(els.cardOld);
        renderCard(els.cardNew, null);
        els.slotNew.hidden = true; els.arrow.hidden = true; els.table.classList.remove('two');
        els.labelOld.textContent = 'Tu carta';
        els.hint.textContent = '';
        if (loading) els.hint.append('Cargando tu ronda…');
        else els.hint.append('Elige cuánto apostar y pulsa ', F.el('strong', { text: 'Repartir' }), '.');
        els.hint.hidden = false; els.choices.hidden = true; els.outcome.hidden = true;
        els.odds.hidden = true; els.warn.hidden = true;
        refreshAction();
    }

    function showOpen(r, { restored = false } = {}) {
        state = 'open';
        els.stage.classList.remove('idle');
        round = { ...r, suit: SUITS[suitIndex(r.roundId)] };
        lastRoundId = r.roundId;
        setStep(2);
        renderCard(els.cardOld, round.oldCard, round.suit);
        els.slotNew.hidden = true; els.arrow.hidden = true; els.table.classList.remove('two');
        els.labelOld.textContent = 'Tu carta';
        els.hint.hidden = true; els.outcome.hidden = true; els.choices.hidden = false;
        const pct = chances(round.options);
        const flatHi = setChoice(els.higher, els.subHigher, round.options.higher, 'Mayor', pct.hi);
        const flatLo = setChoice(els.lower, els.subLower, round.options.lower, 'Menor', pct.lo);
        els.odds.textContent = `Mayor ${pct.hi} % · Menor ${pct.lo} % · Empate ${pct.tie} %`;
        els.odds.hidden = false;
        // U3-12: si una opción paga lo mismo que la apuesta (o menos), se avisa en fichas.
        const live = ['higher', 'lower'].filter((k) => round.options[k]).length;
        const nFlat = (flatHi ? 1 : 0) + (flatLo ? 1 : 0);
        const who = nFlat === live ? (live === 1 ? 'esta jugada no te da' : 'ninguna jugada te da') : `${flatHi ? 'Mayor' : 'Menor'} no te da`;
        els.warn.textContent = `Con ${F.chips(round.bet)} ${who} ganancia; sube tu apuesta.`;
        els.warn.hidden = nFlat === 0;
        if (!restored) showBanner('');
        bet.set(round.bet);
        refreshAction();
        els.cardsText.textContent = `${restored ? 'Ronda retomada. ' : ''}Tu carta es ${rankName(round.oldCard)}. ¿La siguiente será mayor o menor?`;
        scrollToStage();
        (els.higher.disabled ? els.lower : els.higher).focus({ preventScroll: true });
    }

    function showDone(res) {
        state = 'done';
        els.stage.classList.remove('idle');
        setStep(3);
        const oldIdx = suitIndex(lastRoundId || 'x');
        let newIdx = suitIndex((lastRoundId || 'x') + ':new');
        if (res.newCard === res.oldCard && newIdx === oldIdx) newIdx = (newIdx + 1) % SUITS.length;
        els.labelOld.textContent = 'Anterior';
        els.slotNew.hidden = false; els.arrow.hidden = false; els.table.classList.add('two');
        renderCard(els.cardNew, res.newCard, SUITS[newIdx]);
        els.choices.hidden = true; els.hint.hidden = true; els.outcome.hidden = false;
        els.odds.hidden = true; els.warn.hidden = true;
        showBanner('');
        round = null;

        const pick = res.prediction === 'higher' ? 'Mayor' : 'Menor';
        const cards = `${rankLabel(res.oldCard)} → ${rankLabel(res.newCard)}`;
        els.result.classList.remove('win', 'lose', 'even');
        if (res.won && res.amountChange <= 0) {
            els.result.classList.add('even');
            els.resTitle.textContent = `Acertaste: recibes ${F.chips(res.payout)} y quedas igual`;
            els.resDetail.textContent = `${cards} · elegiste ${pick} · recibes ${F.chips(res.payout)}, sin ganancia`;
        } else if (res.won) {
            els.result.classList.add('win');
            els.resTitle.textContent = `Ganaste ${F.chips(res.amountChange, { sign: true })}`;
            els.resDetail.textContent = `${cards} · elegiste ${pick} · recibes ${F.chips(res.payout)}`;
        } else if (res.tie) {
            els.result.classList.add('lose');
            els.resTitle.textContent = `Empate: pierdes ${F.chips(res.bet)}`;
            els.resDetail.textContent = `${cards} · salió la misma carta`;
        } else {
            els.result.classList.add('lose');
            els.resTitle.textContent = `Perdiste ${F.chips(res.bet)}`;
            els.resDetail.textContent = `${cards} · elegiste ${pick}`;
        }
        bet.set(res.bet);
        refreshAction();
        els.cardsText.textContent = '';
        focusAfterBusy = els.deal;
    }

    // La ronda se resolvió en otra pestaña (o expiró): se dice qué pasó y dónde verlo.
    function showFinishedElsewhere(expired) {
        showIdle();
        state = 'done';
        setStep(3);
        els.stage.classList.remove('idle');
        els.hint.hidden = true; els.outcome.hidden = false;
        els.result.classList.remove('win', 'lose', 'even');
        els.result.classList.add('even');
        els.resTitle.textContent = expired ? 'Esta partida ya terminó o expiró' : 'Esta partida ya terminó en otra pestaña';
        els.resDetail.replaceChildren('Tu saldo ya está actualizado. ',
            F.el('a', { href: '/activity', text: 'Ver el resultado en Historial' }), '.');
        refreshAction();
        focusAfterBusy = els.result;
    }

    function setBusy(b) {
        busy = b;
        els.stage.setAttribute('aria-busy', b ? 'true' : 'false');
        if (state === 'open' && round) {
            els.higher.disabled = b || !round.options.higher;
            els.lower.disabled = b || !round.options.lower;
        }
        refreshAction();
        if (!b && focusAfterBusy) {
            const target = focusAfterBusy;
            focusAfterBusy = null;
            if (target.disabled) els.result.focus({ preventScroll: true });
            else target.focus({ preventScroll: true });
        }
    }

    // ---------- Acciones ----------
    async function restoreActive({ notify = true } = {}) {
        const data = await F.api('/games/hi-lo/active');
        if (data.round) {
            showOpen(data.round, { restored: true });
            if (notify) showBanner('Retomamos tu ronda en curso.');
            return true;
        }
        return false;
    }

    async function deal() {
        if (busy || state === 'open' || state === 'loading' || broke) return;
        const amount = bet.value();
        if (amount === null) { bet.input.focus(); return; }
        F.clearToasts();
        showBanner('');
        setBusy(true);
        try {
            const data = await F.api('/games/hi-lo/deal', { method: 'POST', body: { betAmount: amount } });
            F.setBalance(data.newBalance);
            showOpen(data);
        } catch (e) {
            if (e.code === 'ROUND_ACTIVE') {
                try { await restoreActive(); } catch (e2) { F.toast(e2.message, 'error'); }
            } else if (e.status === 409) {
                F.refreshBalance().catch(() => {});
                bet.setError(e.message);
                F.toast(e.message, 'error');
            } else if (e.status !== 401) {
                bet.setError(e.message);
                F.toast(e.message, 'error');
            }
        } finally {
            setBusy(false);
        }
    }

    async function play(prediction) {
        if (busy || state !== 'open' || !round) return;
        if (!round.options[prediction]) return;
        F.clearToasts();
        setBusy(true);
        try {
            const data = await F.api('/games/hi-lo', { method: 'POST', body: { roundId: round.roundId, prediction } });
            F.setBalance(data.newBalance);
            showDone(data);
        } catch (e) {
            if (e.code === 'GAME_FINISHED' || e.status === 404) {
                F.refreshBalance().catch(() => {});
                let restored = false;
                try { restored = await restoreActive({ notify: false }); } catch { /* sin conexión */ }
                if (restored) showBanner('Esa ronda ya terminó en otra pestaña. Retomamos la que tienes abierta.');
                else showFinishedElsewhere(e.status === 404);
            } else if (e.status === 409) {
                F.refreshBalance().catch(() => {});
                F.toast(e.message, 'error');
                let restored = false;
                try { restored = await restoreActive({ notify: false }); } catch { /* sin conexión */ }
                if (!restored) showIdle();
            } else if (e.status !== 401) {
                F.toast(e.message, 'error');
            }
        } finally {
            setBusy(false);
        }
    }

    els.deal.addEventListener('click', deal);
    els.higher.addEventListener('click', () => play('higher'));
    els.lower.addEventListener('click', () => play('lower'));

    showIdle({ loading: true });
    measureBar();
    setBusy(true);
    restoreActive()
        .then((had) => { if (!had) showIdle(); })
        .catch((e) => { showIdle(); if (e.status !== 401) F.toast(e.message, 'error'); })
        .finally(() => setBusy(false));
})();
