// FrioMx: registro. Valida en el navegador y, si sale bien, entra directo al lobby.
(function () {
    'use strict';
    const { api, setToken, chips, LOBBY } = window.FrioMx;
    const UI = window.FrioUI;

    const form = document.getElementById('register-form');
    const name = document.getElementById('name');
    const age = document.getElementById('age');
    const email = document.getElementById('email');
    const password = document.getElementById('password');
    const confirm = document.getElementById('confirm');
    const submit = document.getElementById('submit');

    UI.passwordToggles(form);
    UI.liveClear(form);
    // Edad: no se recorta en silencio ("25.5" no debe volverse 25); se avisa en cuanto aparece algo que no es dígito.
    age.addEventListener('input', () => {
        if (/\D/.test(age.value.trim())) UI.setFieldError(age, 'La edad debe ser un número entero.');
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ok = UI.check(form, [
            [name, UI.rules.name],
            [age, UI.rules.age],
            [email, UI.rules.email],
            [password, UI.rules.password],
            [confirm, (v) => (!v ? 'Vuelve a escribir la contraseña.' : v !== password.value ? 'Las contraseñas no coinciden.' : '')],
        ]);
        if (!ok) return;
        UI.busy(submit, true, 'Creando cuenta…');
        try {
            const data = await api('/auth/register', {
                method: 'POST', auth: false,
                body: { name: name.value.trim(), age: Number(age.value), email: email.value.trim(), password: password.value },
            });
            setToken(data.token);
            sessionStorage.setItem('friomx-flash', `¡Bienvenido! Tienes ${chips(data.user.balance)}`);
            location.replace(window.FrioMx.safeNext(new URLSearchParams(location.search).get('next'), LOBBY));
        } catch (err) {
            UI.busy(submit, false);
            UI.serverError(form, err, { name, age, email, password });
        }
    });
})();

// Conserva ?next= en los enlaces a iniciar sesión.
(function () {
    const next = new URLSearchParams(location.search).get('next');
    if (!next) return;
    document.querySelectorAll('a[href="/logIn"], a[href="/login"]').forEach((a) => { a.href = '/logIn?next=' + encodeURIComponent(next); });
})();
