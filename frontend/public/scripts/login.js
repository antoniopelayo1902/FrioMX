// FrioMx: inicio de sesión.
(function () {
    'use strict';
    const { api, setToken, LOBBY } = window.FrioMx;
    const UI = window.FrioUI;

    const form = document.getElementById('login-form');
    const email = document.getElementById('email');
    const password = document.getElementById('password');
    const submit = document.getElementById('submit');

    // Aviso de sesión (expirada, contraseña cambiada, cerrada en otra pestaña): fijo en la tarjeta.
    // Este script corre antes que el arranque de app.js, así que lo consume aquí y app.js ya no lo muestra como toast.
    const flash = sessionStorage.getItem('friomx-flash');
    if (flash) {
        sessionStorage.removeItem('friomx-flash');
        document.getElementById('flash').textContent = /[.!?]$/.test(flash.trim()) ? flash.trim() : flash.trim() + '.';
    }

    UI.passwordToggles(form);
    UI.liveClear(form);

    // Solo se acepta un destino interno (ver FrioMx.safeNext).
    function nextUrl() {
        return window.FrioMx.safeNext(new URLSearchParams(location.search).get('next'), LOBBY);
    }

    // Conserva ?next= si el usuario se va a registrar desde aquí.
    const next = new URLSearchParams(location.search).get('next');
    if (next) document.querySelectorAll('a[href="/register"]').forEach((a) => { a.href = '/register?next=' + encodeURIComponent(next); });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ok = UI.check(form, [
            [email, UI.rules.email],
            [password, UI.rules.required('Escribe tu contraseña.')],
        ]);
        if (!ok) return;
        UI.busy(submit, true, 'Entrando…');
        try {
            const data = await api('/auth/login', { method: 'POST', auth: false, body: { email: email.value.trim(), password: password.value } });
            setToken(data.token);
            location.replace(nextUrl());
        } catch (err) {
            UI.busy(submit, false);
            if (err.code === 'INVALID_CREDENTIALS' || err.status === 401) {
                UI.setFormError(form, 'Correo o contraseña incorrectos. Revisa los datos e intenta de nuevo.');
                password.select();
                password.focus();
            } else if (err.code === 'VALIDATION_ERROR') {
                UI.serverError(form, err, { email, password });
            } else {
                // 429, red caída o error del servidor: el mensaje ya viene claro desde FrioMx.api.
                UI.setFormError(form, err.message);
            }
        }
    });
})();
