// FrioMx · Ruleta con fichas (un solo 0).
// La rueda se dibuja en <canvas> (sin librerías) y se detiene en el winningIndex del servidor.
(function () {
    'use strict';
    const F = window.FrioMx;
    if (!F) return;
    const $ = (id) => document.getElementById(id);

    // ---------- Datos de la rueda (mismo orden que backend/src/services/gameEngine.js) ----------
    const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
    const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
    const colorOf = (n) => (n === 0 ? 'Verde' : REDS.has(n) ? 'Rojo' : 'Negro');
    const N = ORDER.length;
    const SEG = (Math.PI * 2) / N;
    const TAU = Math.PI * 2;
    const MAX_TOTAL = 10000;
    const SPIN_MS = 4600;
    const PALETTE = { Rojo: '#d22f3c', Negro: '#161b27', Verde: '#0e9b57' };

    // ---------- Casillas de apuesta ----------
    // payLong / payShort: lo que ganas si aciertas, en palabras (el texto corto es para celular).
    const SAME = { payLong: 'ganas lo mismo que apuestas', payShort: 'ganas lo mismo' };
    const DOUBLE = { payLong: 'ganas el doble', payShort: 'ganas el doble' };
    const CELLS = [
        { key: 'color:Rojo', type: 'color', value: 'Rojo', label: 'Rojo', ...SAME, group: 'color', tone: 'red' },
        { key: 'color:Negro', type: 'color', value: 'Negro', label: 'Negro', ...SAME, group: 'color', tone: 'black' },
        { key: 'color:Verde', type: 'color', value: 'Verde', label: 'Verde 0', payLong: 'ganas 35 veces tu apuesta', payShort: 'ganas 35 veces', group: 'color', tone: 'green' },
        { key: 'parity:par', type: 'parity', value: 'par', label: 'Par', ...SAME, group: 'parity' },
        { key: 'parity:impar', type: 'parity', value: 'impar', label: 'Impar', ...SAME, group: 'parity' },
        { key: 'dozen:1', type: 'dozen', value: '1', label: '1 al 12', ...DOUBLE, group: 'dozen' },
        { key: 'dozen:2', type: 'dozen', value: '2', label: '13 al 24', ...DOUBLE, group: 'dozen' },
        { key: 'dozen:3', type: 'dozen', value: '3', label: '25 al 36', ...DOUBLE, group: 'dozen' },
    ];
    const CELL = Object.fromEntries(CELLS.map((c) => [c.key, c]));
    const DOZEN_LABEL = { 1: '1 al 12', 2: '13 al 24', 3: '25 al 36' };
    const DEBUG = (() => { try { return localStorage.getItem('friomxDebug') === '1'; } catch { return false; } })();
    const DEBUG_MAX_SPINS = 50;
    const HIST_MAX = 10;
    const CHIP_VALUES = [1, 5, 10, 50, 100, 500];

    // ---------- Estado ----------
    const SS_LAST = 'friomx-roulette-last';
    const SS_PENDING = 'friomx-roulette-pending';
    // "Últimos" se guarda por usuario en localStorage para que siga ahí al recargar o volver a entrar.
    const LS_HIST = 'friomx-roulette-history:';
    const readSS = (k, d) => { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } };
    // Solo casillas conocidas con montos enteros positivos (lo guardado puede venir de otra versión).
    function cleanBets(b) {
        if (!b || typeof b !== 'object') return null;
        const out = {};
        Object.keys(b).forEach((k) => { if (CELL[k] && Number.isInteger(b[k]) && b[k] > 0) out[k] = b[k]; });
        return Object.keys(out).length ? out : null;
    }
    const writeSS = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };
    const validHist = (h) => h && typeof h.label === 'string' && /^(Rojo|Negro|Verde)$/.test(h.color);
    let histKey = null;     // se fija cuando sabemos quién es el usuario
    function readHistory() {
        if (!histKey) return [];
        try {
            const v = JSON.parse(localStorage.getItem(histKey));
            return Array.isArray(v) ? v.filter(validHist).slice(0, HIST_MAX) : [];
        } catch { return []; }
    }
    function saveHistory() {
        if (!histKey) return;
        try { localStorage.setItem(histKey, JSON.stringify(state.history.slice(0, HIST_MAX))); } catch { /* sin almacenamiento */ }
    }
    const state = {
        chip: 10,
        customChip: null,
        bets: {},               // key -> monto (la mesa; queda vacía después de cada giro)
        undo: [],               // instantáneas anteriores de bets
        lastBets: cleanBets(readSS(SS_LAST, null)),
        history: [],            // [{label,color}] más reciente primero
        busy: false,
        error: '',              // último error del servidor; se borra al cambiar la apuesta o girar
    };

    // ---------- DOM ----------
    const fieldset = $('rl-fieldset');
    const spinBtn = $('rl-spin');
    const msg = $('rl-msg');
    const totalEl = $('rl-total');
    const maxWinEl = $('rl-maxwin');
    const cellButtons = {};

    function buildChips() {
        const host = $('rl-chips');
        CHIP_VALUES.forEach((v) => {
            host.append(F.el('button', {
                type: 'button', class: `rl-chip rl-chip-${v}`, 'data-chip': v,
                'aria-pressed': 'false', 'aria-label': `Ficha de ${F.chips(v)}`,
                onclick: () => selectChip(v),
            }, F.el('span', { text: F.num(v) })));
        });
        host.append(F.el('button', {
            type: 'button', class: 'rl-chip rl-chip-custom', id: 'rl-chip-custom', 'data-chip': 'custom',
            'aria-pressed': 'false', 'aria-label': 'Ficha de otro valor', onclick: askCustomChip,
        }, F.el('span', { text: 'Otro' })));
    }

    function buildCells() {
        CELLS.forEach((c) => {
            const amount = F.el('span', { class: 'rl-stake num', 'aria-hidden': 'true' });
            const btn = F.el('button', {
                type: 'button', class: `rl-cell${c.tone ? ' rl-cell-' + c.tone : ''}`, 'data-key': c.key,
                onclick: () => addBet(c.key),
            },
            F.el('span', { class: 'rl-cell-label', text: c.label }),
            F.el('span', { class: 'rl-cell-pay rl-pay-long', text: c.payLong }),
            F.el('span', { class: 'rl-cell-pay rl-pay-short', 'aria-hidden': 'true', text: c.payShort }),
            amount);
            cellButtons[c.key] = { btn, amount };
            $(`rl-g-${c.group}`).append(btn);
        });
    }

    // Mismo formato en la ficha y en la mesa ("5,000"); la ficha encoge la letra si el número es largo.
    function setChipText(btn, v) {
        const text = F.num(v);
        btn.firstChild.textContent = text;
        btn.dataset.len = String(Math.min(text.length, 6));
    }

    function selectChip(v) {
        state.chip = v;
        document.querySelectorAll('.rl-chip').forEach((b) => {
            const on = b.dataset.chip === 'custom' ? (state.customChip !== null && v === state.customChip && !CHIP_VALUES.includes(v)) : Number(b.dataset.chip) === v;
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    // La ficha "Otro" llega como máximo a tu saldo (y nunca más de 10,000 por giro).
    const customMax = () => Math.min(MAX_TOTAL, Math.max(0, Math.floor(F.getBalance() ?? 0)));
    async function askCustomChip() {
        const max = customMax();
        if (max < 1) {
            F.toast('No tienes fichas para crear una ficha nueva.', 'error');
            return;
        }
        const raw = await F.dialog({
            title: 'Ficha de otro valor', text: max === MAX_TOTAL
                ? `Escribe un número entero de 1 a ${F.num(max)} (el máximo por giro).`
                : `Escribe un número entero de 1 a ${F.num(max)} (tu saldo).`,
            confirmText: 'Usar ficha', input: { type: 'text', label: 'Valor de la ficha', placeholder: 'Ej. 25' },
        });
        if (raw === null) return;
        const typed = String(raw).trim().replace(/\s/g, '');
        // Acepta "1500" y "1,500"; nada de decimales.
        const clean = /^\d{1,3}(,\d{3})+$/.test(typed) ? typed.replace(/,/g, '') : typed;
        const lim = customMax();
        if (!/^\d+$/.test(clean) || Number(clean) < 1 || Number(clean) > lim) {
            F.toast(`El valor de la ficha debe ser un número entero de 1 a ${F.num(lim)}.`, 'error');
            return;
        }
        const v = Number(clean);
        state.customChip = v;
        const b = $('rl-chip-custom');
        setChipText(b, v);
        b.setAttribute('aria-label', `Ficha de otro valor: ${F.chips(v)}`);
        selectChip(v);
    }

    // ---------- Apuestas ----------
    const total = () => Object.values(state.bets).reduce((a, b) => a + b, 0);
    const snapshot = () => ({ ...state.bets });
    function changed() { state.error = ''; render(); }

    function addBet(key) {
        if (state.busy) return;
        state.undo.push(snapshot());
        state.bets[key] = (state.bets[key] || 0) + state.chip;
        changed();
    }
    function undo() {
        if (state.busy || !state.undo.length) return;
        state.bets = state.undo.pop();
        changed();
    }
    function clearBets() {
        if (state.busy || !total()) return;
        state.undo.push(snapshot());
        state.bets = {};
        changed();
    }
    function repeatLast() {
        if (state.busy || !state.lastBets) return;
        state.undo.push(snapshot());
        state.bets = { ...state.lastBets };
        changed();
    }
    const sameBets = (a, b) => {
        if (!a || !b) return false;
        const ka = Object.keys(a).filter((k) => a[k]);
        const kb = Object.keys(b).filter((k) => b[k]);
        return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
    };

    function problem() {
        const t = total();
        const bal = F.getBalance();
        if (bal === null) return { text: 'Cargando tu saldo…', soft: true };
        if (bal < 1) return { text: 'Te quedaste sin fichas. Las recargas todavía no están disponibles.', zero: true };
        if (t === 0) return { text: state.lastBets ? 'Mesa vacía: toca una casilla o «Repetir apuesta».' : 'Toca una casilla para poner tu ficha.', soft: true };
        if (t > MAX_TOTAL) return { text: `El máximo por giro es ${F.chips(MAX_TOTAL)}. Quita fichas con Deshacer o Limpiar.` };
        if (t > bal) return { text: `Tu apuesta (${F.chips(t)}) es mayor que tu saldo (${F.chips(bal)}).` };
        return null;
    }

    function render() {
        const t = total();
        totalEl.textContent = F.num(t);
        // Lo más que puede regresar esta mesa (el mejor número posible), para ver cuánto puedes ganar antes de girar.
        const PAY = { color: 1, parity: 1, dozen: 2 };
        let best = 0;
        for (const label of ORDER) {
            const n = Number(label);
            const slot = {
                color: n === 0 ? 'Verde' : (REDS.has(n) ? 'Rojo' : 'Negro'),
                parity: n === 0 ? null : (n % 2 === 0 ? 'par' : 'impar'),
                dozen: n === 0 ? null : String(Math.ceil(n / 12)),
            };
            let back = 0;
            Object.entries(state.bets).forEach(([key, amt]) => {
                const c = CELL[key];
                if (slot[c.type] === c.value) back += amt * (1 + (c.value === 'Verde' ? 35 : PAY[c.type]));
            });
            best = Math.max(best, back);
        }
        maxWinEl.textContent = t ? ` Si aciertas, recibes hasta ${F.chips(best)}` : '';
        CELLS.forEach((c) => {
            const { btn, amount } = cellButtons[c.key];
            const a = state.bets[c.key] || 0;
            amount.textContent = a ? F.num(a) : '';
            btn.classList.toggle('has-bet', a > 0);
            btn.setAttribute('aria-label', `${c.label}: si aciertas ${c.payLong}. ${a ? `Apostado: ${F.chips(a)}` : 'Sin apuesta'}`);
        });
        $('rl-undo').disabled = state.busy || !state.undo.length;
        $('rl-clear').disabled = state.busy || !t;
        const rep = $('rl-repeat');
        const lastTotal = state.lastBets ? Object.values(state.lastBets).reduce((x, y) => x + y, 0) : 0;
        rep.disabled = state.busy || !lastTotal || sameBets(state.lastBets, state.bets);
        const rep2 = $('rl-res-repeat');
        rep2.disabled = rep.disabled;
        rep2.hidden = !lastTotal || sameBets(state.lastBets, state.bets);
        rep.setAttribute('aria-label', lastTotal ? `Repetir apuesta: vuelve a poner lo del giro anterior (${F.chips(lastTotal)})` : 'Repetir apuesta: aún no hay un giro anterior');
        const p = problem();
        if (state.busy) {
            msg.textContent = '';
            spinBtn.disabled = true;
        } else {
            const text = p ? p.text : state.error;
            if (p && p.zero) {
                msg.replaceChildren(text, ' ', F.el('a', { href: '/balance', text: 'Ver mi saldo' }));
            } else if (msg.textContent !== text || msg.children.length) {
                msg.textContent = text;
            }
            msg.classList.toggle('is-error', !!((p && !p.soft) || (!p && state.error)));
            msg.classList.toggle('is-zero', !!(p && p.zero));
            spinBtn.disabled = !!p;
        }
        spinBtn.textContent = state.busy ? 'Girando…' : (t ? `Girar · ${F.chips(t)}` : 'Girar');
    }

    // ---------- Rueda en canvas ----------
    const canvas = $('rl-wheel');
    const ctx = canvas.getContext('2d');
    const wrap = $('rl-wheel-wrap');
    const wheel = { size: 0, dpr: 1, angle: 0, layer: null, winner: null, showBall: false, spinning: false };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    function resize() {
        const rect = wrap.getBoundingClientRect();
        const size = Math.max(110, Math.floor(Math.min(rect.width, rect.height || rect.width)));
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        if (size === wheel.size && dpr === wheel.dpr) return;
        wheel.size = size;
        wheel.dpr = dpr;
        canvas.style.width = size + 'px';
        canvas.style.height = size + 'px';
        canvas.width = Math.round(size * dpr);
        canvas.height = Math.round(size * dpr);
        buildLayer();
        draw();
    }

    // Capa que gira: aro de números y bolsillos. Se dibuja una vez por tamaño.
    function buildLayer() {
        const px = Math.round(wheel.size * wheel.dpr);
        const layer = document.createElement('canvas');
        layer.width = px; layer.height = px;
        const g = layer.getContext('2d');
        g.scale(wheel.dpr, wheel.dpr);
        const s = wheel.size; const c = s / 2; const R = s / 2 - 6;
        g.translate(c, c);

        // Aro exterior de madera
        let grad = g.createRadialGradient(0, 0, R * 0.8, 0, 0, R);
        grad.addColorStop(0, '#4a2f12'); grad.addColorStop(0.6, '#6e4519'); grad.addColorStop(1, '#2b1a08');
        g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fillStyle = grad; g.fill();

        const rOut = R * 0.93; const rNum = R * 0.78; const rPocket = R * 0.64;
        for (let i = 0; i < N; i++) {
            const n = ORDER[i];
            const a0 = -Math.PI / 2 + i * SEG - SEG / 2;
            const a1 = a0 + SEG;
            const base = PALETTE[colorOf(n)];
            // Franja del número
            g.beginPath(); g.arc(0, 0, rOut, a0, a1); g.arc(0, 0, rNum, a1, a0, true); g.closePath();
            g.fillStyle = base; g.fill();
            // Bolsillo (más oscuro)
            g.beginPath(); g.arc(0, 0, rNum, a0, a1); g.arc(0, 0, rPocket, a1, a0, true); g.closePath();
            g.fillStyle = shade(base, -0.35); g.fill();
            // Separadores dorados
            g.save(); g.rotate(a0);
            g.beginPath(); g.moveTo(rPocket, 0); g.lineTo(rOut, 0);
            g.strokeStyle = 'rgba(232, 196, 120, .85)'; g.lineWidth = Math.max(1, s / 360); g.stroke();
            g.restore();
            // Número, de pie mirando hacia afuera
            g.save();
            g.rotate(a0 + SEG / 2 + Math.PI / 2);
            g.fillStyle = '#fff';
            g.font = `500 ${Math.round(R * 0.095)}px Khand, Switzer, sans-serif`;
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(String(n), 0, -(rOut + rNum) / 2);
            g.restore();
        }
        // Filetes dorados
        [[rOut, 2], [rNum, 1], [rPocket, 2]].forEach(([r, w]) => {
            g.beginPath(); g.arc(0, 0, r, 0, TAU);
            g.strokeStyle = '#d9b46a'; g.lineWidth = Math.max(1, (w * s) / 400); g.stroke();
        });
        // Cono interior
        grad = g.createRadialGradient(-R * 0.15, -R * 0.15, R * 0.05, 0, 0, rPocket);
        grad.addColorStop(0, '#2c3d66'); grad.addColorStop(1, '#0d1427');
        g.beginPath(); g.arc(0, 0, rPocket - 1, 0, TAU); g.fillStyle = grad; g.fill();
        // Rayos decorativos
        g.strokeStyle = 'rgba(217, 180, 106, .5)'; g.lineWidth = Math.max(1, s / 260);
        for (let k = 0; k < 8; k++) {
            g.save(); g.rotate((k * TAU) / 8);
            g.beginPath(); g.moveTo(R * 0.3, 0); g.lineTo(rPocket - 4, 0); g.stroke();
            g.restore();
        }
        wheel.layer = layer;
    }

    function shade(hex, amt) {
        const n = parseInt(hex.slice(1), 16);
        const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt));
        return `rgb(${ch.join(',')})`;
    }

    function draw() {
        const s = wheel.size; if (!s || !wheel.layer) return;
        const c = s / 2; const R = s / 2 - 6;
        ctx.setTransform(wheel.dpr, 0, 0, wheel.dpr, 0, 0);
        ctx.clearRect(0, 0, s, s);

        // Sombra exterior
        ctx.save();
        ctx.beginPath(); ctx.arc(c, c, R, 0, TAU);
        ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
        ctx.fillStyle = '#2b1a08'; ctx.fill();
        ctx.restore();

        // Capa giratoria
        ctx.save();
        ctx.translate(c, c); ctx.rotate(wheel.angle); ctx.translate(-c, -c);
        ctx.drawImage(wheel.layer, 0, 0, s, s);
        ctx.restore();

        // Resaltado del ganador (en la posición del puntero, arriba)
        if (wheel.winner !== null && !wheel.spinning) {
            const rOut = R * 0.93; const rPocket = R * 0.64;
            const a0 = -Math.PI / 2 - SEG / 2 + angleOffsetInSegment();
            ctx.save();
            ctx.translate(c, c);
            ctx.beginPath(); ctx.arc(0, 0, rOut + 1, a0, a0 + SEG); ctx.arc(0, 0, rPocket, a0 + SEG, a0, true); ctx.closePath();
            ctx.lineWidth = Math.max(2, s / 120); ctx.strokeStyle = '#ffe08a';
            ctx.shadowColor = '#ffd56e'; ctx.shadowBlur = 16; ctx.stroke();
            ctx.restore();
        }

        // Bola en el bolsillo ganador
        if (wheel.showBall) {
            const rBall = R * 0.71;
            const a = -Math.PI / 2 + angleOffsetInSegment();
            const bx = c + Math.cos(a) * rBall; const by = c + Math.sin(a) * rBall;
            const br = Math.max(4, R * 0.04);
            const bg = ctx.createRadialGradient(bx - br / 3, by - br / 3, br / 6, bx, by, br);
            bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, '#b8c0cf');
            ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fillStyle = bg;
            ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4; ctx.fill(); ctx.shadowBlur = 0;
        }

        // Centro fijo con el número ganador
        const hubR = R * 0.3;
        const hub = ctx.createRadialGradient(c - hubR / 3, c - hubR / 3, hubR / 8, c, c, hubR);
        const winCol = wheel.winner !== null && !wheel.spinning ? PALETTE[colorOf(ORDER[wheel.winner])] : null;
        if (winCol) { hub.addColorStop(0, shade(winCol, 0.25)); hub.addColorStop(1, shade(winCol, -0.3)); }
        else { hub.addColorStop(0, '#f3d58f'); hub.addColorStop(1, '#a87a2a'); }
        ctx.beginPath(); ctx.arc(c, c, hubR, 0, TAU); ctx.fillStyle = hub; ctx.fill();
        ctx.lineWidth = Math.max(2, s / 160); ctx.strokeStyle = '#e8c478'; ctx.stroke();
        if (winCol) {
            ctx.fillStyle = '#fff';
            ctx.font = `500 ${Math.round(hubR * 1.05)}px Khand, Switzer, sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(ORDER[wheel.winner]), c, c + hubR * 0.06);
        } else {
            ctx.beginPath(); ctx.arc(c, c, hubR * 0.35, 0, TAU); ctx.fillStyle = 'rgba(80, 52, 10, .55)'; ctx.fill();
        }

        // Puntero fijo arriba
        const pw = Math.max(9, R * 0.06); const top = c - R - 3; const tip = c - R * 0.9;
        ctx.save();
        ctx.beginPath(); ctx.moveTo(c - pw, top); ctx.lineTo(c + pw, top); ctx.lineTo(c, tip); ctx.closePath();
        ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
        ctx.fillStyle = '#ffd56e'; ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#7a5310'; ctx.stroke();
        ctx.restore();
    }

    // Distancia (en radianes) entre el centro del segmento bajo el puntero y el puntero.
    function angleOffsetInSegment() {
        const i = indexUnderPointer();
        const segCenter = i * SEG + wheel.angle;           // centro del segmento i medido desde arriba
        let d = ((segCenter % TAU) + TAU) % TAU;
        if (d > Math.PI) d -= TAU;
        return d;
    }
    function indexUnderPointer() {
        const a = ((-wheel.angle % TAU) + TAU) % TAU;
        return Math.round(a / SEG) % N;
    }

    function spinTo(index) {
        return new Promise((resolve) => {
            const jitter = (Math.random() - 0.5) * SEG * 0.6;          // queda dentro del bolsillo
            const targetMod = (((-index * SEG + jitter) % TAU) + TAU) % TAU;
            const turns = 5 + Math.floor(Math.random() * 2);
            const start = wheel.angle;
            const base = start + turns * TAU;
            const delta = (((targetMod - base) % TAU) + TAU) % TAU;
            const end = base + delta;
            wheel.winner = null; wheel.showBall = false;
            const finish = () => {
                wheel.angle = ((end % TAU) + TAU) % TAU;
                wheel.spinning = false; wheel.winner = index; wheel.showBall = true;
                draw();
                resolve();
            };
            if (reduceMotion.matches) { wheel.angle = end; finish(); return; }
            wheel.spinning = true;
            const t0 = performance.now();
            const ease = (t) => 1 - Math.pow(1 - t, 4);
            const frame = (now) => {
                const t = Math.min(1, (now - t0) / SPIN_MS);
                wheel.angle = start + (end - start) * ease(t);
                draw();
                if (t < 1) requestAnimationFrame(frame); else finish();
            };
            requestAnimationFrame(frame);
        });
    }

    // ---------- Jugar ----------
    async function spin() {
        if (state.busy) return;
        const p = problem();
        if (p) { render(); return; }
        const bets = Object.entries(state.bets).filter(([, a]) => a > 0)
            .map(([key, amount]) => ({ type: CELL[key].type, value: CELL[key].value, amount }));
        const placed = snapshot();
        state.error = '';
        state.busy = true;
        fieldset.disabled = true;
        showPanel('spin');
        render();
        revealClear(canvas);
        let data;
        try {
            data = await F.api('/games/roulette', { method: 'POST', body: { bets } });
        } catch (e) {
            state.busy = false;
            fieldset.disabled = false;
            showPanel(lastPanel);
            // El error se muestra una sola vez: en el texto de la barra de Girar.
            state.error = e.message;
            render();
            revealClear(msg.textContent ? msg : spinBtn);
            if (e.status === 409) F.refreshBalance().then(render).catch(() => {});
            return;
        }
        // Si se recarga a media animación, al volver se muestra este resultado.
        try { sessionStorage.setItem(SS_PENDING, JSON.stringify({ data, placed })); } catch { /* sin almacenamiento */ }
        // El servidor ya cobró: mientras gira se muestra el saldo sin la apuesta.
        F.setBalance(data.newBalance - data.totalAmountChange - data.totalBet);
        await spinTo(data.winningIndex);
        F.setBalance(data.newBalance);
        settle(data, placed);
        state.busy = false;
        fieldset.disabled = false;
        render();
        revealClear($('rl-result'));
        if (debug) {
            debug.spins.push({
                winningIndex: data.winningIndex, label: data.winningSlot.label,
                stoppedIndex: indexUnderPointer(), angle: wheel.angle, net: data.totalAmountChange, newBalance: data.newBalance,
            });
            if (debug.spins.length > DEBUG_MAX_SPINS) debug.spins.splice(0, debug.spins.length - DEBUG_MAX_SPINS);
        }
    }

    // Guarda la tirada terminada: última apuesta, historial y panel. La mesa queda vacía;
    // "Repetir apuesta" vuelve a poner exactamente lo mismo.
    function settle(data, placed) {
        state.lastBets = placed;
        writeSS(SS_LAST, placed);
        state.bets = {};
        state.undo = [];
        state.history.unshift({ label: data.winningSlot.label, color: data.winningSlot.color });
        state.history = state.history.slice(0, HIST_MAX);
        saveHistory();

        showResult(data);
        renderHistory();
        try { sessionStorage.removeItem(SS_PENDING); } catch { /* sin almacenamiento */ }
    }

    // Tirada que quedó resuelta en el servidor pero la página se recargó antes de terminar de girar.
    function restorePending() {
        const p = readSS(SS_PENDING, null);
        if (!p || !p.data || typeof p.data.winningIndex !== 'number' || !p.data.winningSlot) {
            sessionStorage.removeItem(SS_PENDING);
            return false;
        }
        wheel.angle = ((-p.data.winningIndex * SEG) % TAU + TAU) % TAU;
        wheel.winner = p.data.winningIndex;
        wheel.showBall = true;
        settle(p.data, cleanBets(p.placed) || {});
        $('rl-announce').textContent = `Tu última tirada terminó: ${$('rl-announce').textContent}`;
        return true;
    }

    // Lleva un elemento a la zona visible que no tapan la barra superior, la de Girar ni la inferior.
    function clearArea() {
        let top = 0; let bottom = window.innerHeight;
        const tb = document.querySelector('.topbar');
        if (tb && /sticky|fixed/.test(getComputedStyle(tb).position)) top = Math.max(top, tb.getBoundingClientRect().bottom);
        [document.querySelector('.rl-spinbar'), document.querySelector('.bottombar')].forEach((n) => {
            if (!n) return;
            const cs = getComputedStyle(n);
            if (cs.display === 'none' || cs.position !== 'fixed') return;
            bottom = Math.min(bottom, n.getBoundingClientRect().top);
        });
        return { top: top + 8, bottom: bottom - 8 };
    }
    function revealClear(node) {
        if (!node) return;
        const r = node.getBoundingClientRect();
        const a = clearArea();
        let dy = 0;
        if (r.height > a.bottom - a.top || r.top < a.top) dy = r.top - a.top;
        else if (r.bottom > a.bottom) dy = r.bottom - a.bottom;
        if (Math.abs(dy) < 1) return;
        window.scrollTo({ top: window.scrollY + dy, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }

    // ---------- Panel de resultado ----------
    let lastPanel = 'idle';
    function showPanel(which) {
        $('rl-result').dataset.state = which;
        $('rl-result-idle').hidden = which !== 'idle';
        $('rl-result-spin').hidden = which !== 'spin';
        $('rl-result-done').hidden = which !== 'done';
        if (which !== 'spin') lastPanel = which;
    }

    function slotText(slot) {
        const parts = [slot.color];
        if (slot.parity) parts.push(slot.parity === 'par' ? 'Par' : 'Impar');
        if (slot.dozen) parts.push(DOZEN_LABEL[slot.dozen]);
        return parts;
    }

    function showResult(data) {
        const slot = data.winningSlot;
        const ball = $('rl-res-ball');
        ball.textContent = slot.label;
        ball.className = `rl-ball rl-ball-lg is-${slot.color.toLowerCase()}`;
        const slotEl = $('rl-res-slot');
        slotEl.replaceChildren(...[slot.label, ...slotText(slot)].flatMap((t, i) => [
            i ? F.el('span', { class: 'rl-sep', 'aria-hidden': 'true', text: ' · ' }) : null,
            F.el('span', { class: 'rl-part', text: t }),
        ]).filter(Boolean));

        const net = data.totalAmountChange;
        const kind = net > 0 ? 'win' : net < 0 ? 'lose' : 'even';
        $('rl-result').dataset.outcome = kind;
        $('rl-res-net-label').textContent = kind === 'win' ? 'Ganaste' : kind === 'lose' ? 'Perdiste' : 'Quedaste igual';
        $('rl-res-net-amount').textContent = F.chips(net, { sign: true });

        const list = $('rl-res-list');
        $('rl-res-bet').textContent = `Apostaste ${F.chips(data.totalBet)}${data.results.length > 1 ? ` en ${data.results.length} casillas` : ''}:`;
        list.replaceChildren(...data.results.map((r) => {
            const c = CELL[`${r.type}:${r.value}`];
            const gain = Math.abs(r.change);
            // Espacios reales entre partes: así lo lee igual un lector de pantalla.
            return F.el('li', { class: r.won ? 'is-won' : 'is-lost' },
                F.el('span', { class: 'rl-bd-name', text: `${c ? c.label : r.value}:` }), ' ',
                F.el('span', { class: 'rl-bd-amount', text: `apostaste ${F.num(r.amount)}` }), ' ',
                F.el('span', { class: 'rl-bd-arrow', 'aria-hidden': 'true', text: '→' }), ' ',
                F.el('span', { class: `rl-bd-change ${r.won ? 'win' : 'lose'}`, text: r.won ? `ganaste ${F.num(gain)}` : `perdiste ${F.num(gain)}` }));
        }));
        showPanel('done');

        const spokenSlot = [slot.label, ...slotText(slot).map((t) => t.replace('–', ' a '))].join(', ');
        $('rl-announce').textContent = `Cayó ${spokenSlot}. ${kind === 'even' ? 'Quedaste igual.' : `${kind === 'win' ? 'Ganaste' : 'Perdiste'} ${F.chips(Math.abs(net))}.`}`;
    }

    function renderHistory() {
        const host = $('rl-history');
        if (!state.history.length) {
            host.replaceChildren(F.el('li', { class: 'rl-history-empty muted', text: 'Aún no hay tiradas' }));
            return;
        }
        host.replaceChildren(...state.history.map((h, i) => F.el('li', {
            class: `rl-ball is-${String(h.color).toLowerCase()}${i === 0 ? ' is-latest' : ''}`,
            'aria-label': `${h.label} ${h.color}`, text: h.label,
        })));
    }

    // ---------- Arranque ----------
    let debug = null;
    function init() {
        buildChips();
        buildCells();
        selectChip(state.chip);
        renderHistory();
        showPanel('idle');
        let restored = false;
        // "Últimos" es por usuario: primero sabemos quién es y luego leemos su lista y la tirada pendiente.
        const afterMe = (me) => {
            if (me && me.id != null) histKey = LS_HIST + String(me.id);
            state.history = readHistory();
            renderHistory();
            restored = restorePending();
            if (restored) draw();
            render();
        };
        F.loadMe().then(afterMe, () => afterMe(null));
        render();
        const head = $('rl-head');
        const setHead = () => {
            const cs = getComputedStyle(head);
            document.documentElement.style.setProperty('--rl-head-h', `${Math.ceil(head.offsetHeight + parseFloat(cs.marginBottom || 0))}px`);
        };
        new ResizeObserver(setHead).observe(head);
        setHead();
        // Alto de la barra fija de Girar (solo en celular) para que el foco con Tab no quede debajo (R3-01).
        const spinbar = document.querySelector('.rl-spinbar');
        const setBar = () => {
            const fixed = getComputedStyle(spinbar).position === 'fixed';
            document.documentElement.style.setProperty('--game-bar-h', `${fixed ? Math.ceil(spinbar.offsetHeight) : 0}px`);
        };
        new ResizeObserver(setBar).observe(spinbar);
        window.addEventListener('resize', setBar);
        setBar();
        $('rl-undo').addEventListener('click', undo);
        $('rl-clear').addEventListener('click', clearBets);
        $('rl-repeat').addEventListener('click', repeatLast);
        $('rl-res-repeat').addEventListener('click', repeatLast);
        spinBtn.addEventListener('click', spin);
        // Enter juega cuando el foco no está en un control que ya usa Enter.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.repeat) return;
            const t = e.target;
            if (t.closest && t.closest('button, a, input, textarea, select, .dialog-backdrop')) return;
            e.preventDefault();
            spin();
        });
        F.onBalance(() => render());

        new ResizeObserver(resize).observe(wrap);
        window.addEventListener('resize', resize);
        resize();
        if (document.fonts && document.fonts.load) {
            document.fonts.load('500 20px Khand').then(() => { buildLayer(); draw(); }).catch(() => {});
        }

        // Solo para pruebas: se activa con localStorage.friomxDebug = '1'.
        if (DEBUG) {
            debug = {
                get angle() { return wheel.angle; },
                get indexUnderPointer() { return indexUnderPointer(); },
                get labelUnderPointer() { return String(ORDER[indexUnderPointer()]); },
                get spinning() { return wheel.spinning; },
                get busy() { return state.busy; },
                get bets() { return { ...state.bets }; },
                get lastBets() { return state.lastBets ? { ...state.lastBets } : null; },
                get history() { return state.history.map((h) => ({ ...h })); },
                get restored() { return restored; },
                order: ORDER.slice(),
                spins: [],
            };
            Object.defineProperty(window, '__rouletteDebug', { value: debug, configurable: true });
        }
    }
    init();
})();
