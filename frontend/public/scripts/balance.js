// FrioMx: saldo y recargas de fichas virtuales.
// Una recarga: POST con Idempotency-Key -> 202 PENDING -> se consulta cada 2 s hasta COMPLETED o FAILED.
// La recarga en curso se guarda en sessionStorage para retomarla si se recarga la página.
(function () {
    'use strict';
    const F = window.FrioMx;
    const UI = window.FrioUI;
    const { api, el, chips } = F;

    const STORE = 'friomx-recharge';
    const POLL_MS = 2000;
    const POLL_MAX_MS = 60000;

    const packsBox = document.getElementById('packs');
    const status = document.getElementById('recharge-status');
    let buttons = [];
    let busy = false;

    // ---------- Recarga guardada ----------
    function saved() {
        try { return JSON.parse(sessionStorage.getItem(STORE)) || null; } catch { return null; }
    }
    function save(data) { sessionStorage.setItem(STORE, JSON.stringify(data)); }
    function forget() { sessionStorage.removeItem(STORE); }

    // ---------- Estado en pantalla ----------
    function show(kind, text, action) {
        status.hidden = false;
        status.className = `recharge-status ${kind}`;
        const parts = [];
        if (kind === 'pending') parts.push(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
        parts.push(el('p', { text }));
        if (action) parts.push(action);
        status.replaceChildren(...parts);
    }
    function actionBtn(label, fn) {
        return el('button', { class: 'btn btn-sm', type: 'button', text: label, onclick: fn });
    }
    function setBusy(on, activeBtn) {
        busy = on;
        buttons.forEach((b) => {
            const isBusy = b.getAttribute('aria-busy') === 'true';
            if (on && b === activeBtn && !isBusy) UI.busy(b, true, 'Procesando…');
            else if (!on && isBusy) UI.busy(b, false);
            b.disabled = on;
        });
    }

    // ---------- Consulta del estado ----------
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function finish(rec) {
        forget();
        setBusy(false);
        if (rec.status === 'COMPLETED') {
            try {
                const data = await api('/user/balance');
                F.setBalance(data.balance);
            } catch { /* el saldo se actualiza en la próxima carga */ }
            const msg = `Listo, se sumaron ${chips(rec.chips)} a tu saldo.`;
            show('ok', msg);
            F.toast(msg, 'success');
        } else {
            // FAILED solo indica que tardó demasiado: la Lambda todavía puede acreditarla más tarde.
            show('error', 'No pudimos confirmar tu recarga. Si se completa más tarde, verás las fichas en tu saldo.');
        }
    }

    async function poll(rechargeId, { waitFirst = true } = {}) {
        setBusy(true, buttons.find((b) => b.dataset.pkg === (saved() || {}).packageId));
        show('pending', 'Procesando tu recarga…');
        const start = Date.now();
        let first = true;
        while (Date.now() - start < POLL_MAX_MS) {
            if (waitFirst || !first) await sleep(POLL_MS);
            first = false;
            try {
                const rec = await api('/wallet/recharges/' + encodeURIComponent(rechargeId));
                if (rec.status === 'COMPLETED' || rec.status === 'FAILED') return finish(rec);
            } catch (err) {
                if (err.status === 401) return undefined;
                // Sin conexión o error pasajero: se sigue intentando hasta el tope.
                if (err.status === 0 || err.status >= 500 || err.code === 'CONFLICT') continue;
                forget();
                setBusy(false);
                show('error', 'No encontramos tu recarga. ' + err.message);
                return undefined;
            }
        }
        // Tope alcanzado: la recarga sigue guardada y se puede revisar después.
        setBusy(false);
        show('pending-slow', 'Tu recarga sigue en proceso y está tardando más de lo normal. Revisa en un momento.',
            actionBtn('Revisar de nuevo', () => poll(rechargeId, { waitFirst: false })));
        return undefined;
    }

    // ---------- Solicitud sin respuesta (clave guardada sin rechargeId) ----------
    // Tras un 503/5xx la recarga pudo quedar creada (PENDING) en el servidor y ya gastó un cupo del día.
    // Solo se permite reintentar ese paquete con la misma clave, que vuelve a encolarla sin cobrar otro cupo.
    function unsent() {
        const prev = saved();
        return prev && prev.key && !prev.rechargeId ? prev : null;
    }
    function lockToUnsent() {
        const prev = unsent();
        if (!prev) return;
        buttons.forEach((b) => { b.disabled = b.dataset.pkg !== prev.packageId; });
    }
    function retryUnsentBtn(prev) {
        return actionBtn('Intentar de nuevo', () => recharge({ packageId: prev.packageId, chips: prev.chips },
            buttons.find((b) => b.dataset.pkg === prev.packageId)));
    }
    function showUnsent(prev) {
        show('pending-slow', `Tu recarga de ${chips(prev.chips)} no se pudo confirmar. Intenta de nuevo con ese mismo paquete antes de pedir otro.`,
            retryUnsentBtn(prev));
        lockToUnsent();
    }

    // ---------- Pedir una recarga ----------
    async function recharge(pkg, btn) {
        if (busy) return;
        const prev = saved();
        if (prev && prev.rechargeId) {
            // Hay una recarga sin confirmar: primero se resuelve esa, sea el mismo paquete u otro.
            if (prev.packageId === pkg.packageId) { poll(prev.rechargeId, { waitFirst: false }); return; }
            show('pending-slow', `Tienes una recarga de ${chips(prev.chips)} en proceso. Espera a que termine para pedir otra.`,
                actionBtn('Revisar', () => poll(prev.rechargeId, { waitFirst: false })));
            return;
        }
        if (prev && prev.key && prev.packageId !== pkg.packageId) { showUnsent(prev); return; }
        // Un reintento del mismo paquete usa la misma clave: el servidor no crea dos recargas.
        const key = prev && prev.packageId === pkg.packageId ? prev.key : F.uuidv4();
        save({ key, packageId: pkg.packageId, chips: pkg.chips });
        setBusy(true, btn);
        show('pending', 'Procesando tu recarga…');
        let data;
        try {
            data = await api('/wallet/recharges', { method: 'POST', body: { packageId: pkg.packageId }, headers: { 'Idempotency-Key': key } });
        } catch (err) {
            if (err.status === 401) return;
            setBusy(false);
            const retry = actionBtn('Intentar de nuevo', () => recharge(pkg, btn));
            if (err.code === 'QUEUE_UNAVAILABLE') {
                show('error', 'Las recargas no están disponibles por ahora. Intenta de nuevo en un momento.', retry);
                lockToUnsent();
            } else if (err.code === 'DAILY_LIMIT') {
                forget();
                show('error', 'Ya usaste tus 3 recargas de hoy. Vuelve mañana por más.');
            } else if (err.status === 0 || err.code === 'CONFLICT' || err.status >= 500) {
                show('error', err.message, retry);
                lockToUnsent();
            } else {
                forget();
                show('error', err.message);
            }
            return;
        }
        save({ key, packageId: pkg.packageId, chips: pkg.chips, rechargeId: data.rechargeId });
        if (data.status === 'COMPLETED' || data.status === 'FAILED') {
            finish({ ...data, chips: data.chips || pkg.chips });
            return;
        }
        poll(data.rechargeId);
    }

    // ---------- Paquetes ----------
    function packCard(pkg) {
        const btn = el('button', {
            class: 'btn btn-primary btn-sm btn-block', type: 'button', 'data-pkg': pkg.packageId,
            'aria-label': `Recargar ${chips(pkg.chips)}`, text: 'Recargar',
        });
        btn.addEventListener('click', () => recharge(pkg, btn));
        buttons.push(btn);
        return el('div', { class: 'pack' },
            el('div', { class: 'chips' }, F.num(pkg.chips), el('small', { text: 'fichas' })),
            btn);
    }

    async function loadPacks() {
        packsBox.setAttribute('aria-busy', 'true');
        try {
            const list = await api('/wallet/packages');
            buttons = [];
            packsBox.replaceChildren(...list.map(packCard));
        } catch (err) {
            if (err.status === 401) return;
            packsBox.replaceChildren(el('div', { class: 'load-error packs-error' },
                el('p', { class: 'lose', text: 'No pudimos cargar los paquetes. ' + err.message }),
                actionBtn('Reintentar', loadPacks)));
            return;
        } finally {
            packsBox.removeAttribute('aria-busy');
        }
        // Si había una recarga en curso (por ejemplo, se recargó la página), se retoma.
        const prev = saved();
        if (prev && prev.rechargeId) poll(prev.rechargeId, { waitFirst: false });
        else if (unsent()) showUnsent(unsent());
    }
    loadPacks();
})();
