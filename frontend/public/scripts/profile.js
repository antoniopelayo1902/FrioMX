// FrioMx: perfil (nombre, correo y contraseña).
(function () {
    'use strict';
    const F = window.FrioMx;
    const UI = window.FrioUI;
    const $ = (id) => document.getElementById(id);

    let profile = null;

    function apply(p) {
        profile = p;
        document.querySelectorAll('[data-user-name]').forEach((n) => { n.textContent = p.name; });
        document.querySelectorAll('[data-user-initial]').forEach((n) => { n.textContent = F.initials(p.name); });
        $('side-email').textContent = p.email;
        $('side-age').textContent = `${p.age} años`;
        if (typeof p.balance === 'number') F.setBalance(p.balance, { animate: false });
        if (!editing) $('name').value = p.name;
    }

    // ---------- Nombre (edición en línea) ----------
    const nameForm = $('name-form');
    const nameInput = $('name');
    const editBtn = $('name-edit');
    const saveBtn = $('name-save');
    const cancelBtn = $('name-cancel');
    let editing = false;

    function setEditing(on) {
        editing = on;
        nameInput.readOnly = !on;
        editBtn.hidden = on;
        saveBtn.hidden = !on;
        cancelBtn.hidden = !on;
        UI.clearErrors(nameForm);
        if (on) { nameInput.focus(); nameInput.select(); } else if (profile) nameInput.value = profile.name;
    }
    editBtn.addEventListener('click', () => setEditing(true));
    cancelBtn.addEventListener('click', () => { setEditing(false); editBtn.focus(); });
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && editing) { e.preventDefault(); setEditing(false); editBtn.focus(); }
    });
    nameInput.addEventListener('dblclick', () => { if (!editing) setEditing(true); });
    nameForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!editing) return;
        if (!UI.check(nameForm, [[nameInput, UI.rules.name]])) return;
        const value = nameInput.value.trim();
        if (profile && value === profile.name) { setEditing(false); return; }
        UI.busy(saveBtn, true, 'Guardando…');
        try {
            const p = await F.api('/user/profile', { method: 'PUT', body: { field: 'username', newValue: value } });
            UI.busy(saveBtn, false);
            editing = false;
            apply(p);
            setEditing(false);
            F.toast('Nombre actualizado.', 'success');
        } catch (err) {
            UI.busy(saveBtn, false);
            UI.serverError(nameForm, err, { name: nameInput });
        }
    });

    // ---------- Correo ----------
    const emailForm = $('email-form');
    const newEmail = $('new-email');
    const emailCurrent = $('email-current');
    emailForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ok = UI.check(emailForm, [
            [newEmail, (v) => UI.rules.email(v) || (profile && v.trim().toLowerCase() === profile.email ? 'Ese ya es tu correo actual.' : '')],
            [emailCurrent, UI.rules.required('Escribe tu contraseña actual.')],
        ]);
        if (!ok) return;
        const btn = $('email-save');
        UI.busy(btn, true, 'Guardando…');
        try {
            const p = await F.api('/user/profile', { method: 'PUT', body: { field: 'email', newValue: newEmail.value.trim(), currentPassword: emailCurrent.value } });
            UI.busy(btn, false);
            apply(p);
            emailForm.reset();
            F.toast(`Correo actualizado. Desde ahora inicia sesión con ${p.email}.`, 'success', 6000);
        } catch (err) {
            UI.busy(btn, false);
            UI.serverError(emailForm, err, { email: newEmail, current: emailCurrent });
        }
    });

    // ---------- Contraseña ----------
    const pwForm = $('pw-form');
    const pwCurrent = $('pw-current');
    const pwNew = $('pw-new');
    const pwConfirm = $('pw-confirm');
    pwForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ok = UI.check(pwForm, [
            [pwCurrent, UI.rules.required('Escribe tu contraseña actual.')],
            [pwNew, (v) => UI.rules.password(v) || (v && v === pwCurrent.value ? 'La contraseña nueva debe ser distinta de la actual.' : '')],
            [pwConfirm, (v) => (!v ? 'Vuelve a escribir la contraseña nueva.' : v !== pwNew.value ? 'Las contraseñas no coinciden.' : '')],
        ]);
        if (!ok) return;
        const btn = $('pw-save');
        UI.busy(btn, true, 'Guardando…');
        try {
            const p = await F.api('/user/profile', { method: 'PUT', body: { field: 'password', newValue: pwNew.value, currentPassword: pwCurrent.value } });
            // El token anterior deja de servir: se guarda el nuevo para seguir dentro.
            if (p.token) F.setToken(p.token);
            UI.busy(btn, false);
            pwForm.reset();
            F.toast('Contraseña actualizada. Cerramos tus sesiones en otros dispositivos.', 'success', 6000);
        } catch (err) {
            UI.busy(btn, false);
            UI.serverError(pwForm, err, { password: pwNew, current: pwCurrent });
        }
    });

    UI.passwordToggles(document.querySelector('.settings'));
    [nameForm, emailForm, pwForm].forEach(UI.liveClear);
    $('logout').addEventListener('click', () => F.logout());

    // Un solo intento compartido con app.js (FrioMx.loadMe) y un solo estado de error con Reintentar.
    const errBox = $('profile-error');
    const retryBtn = $('profile-retry');
    async function load() {
        errBox.hidden = true;
        editBtn.disabled = true;
        try {
            apply(await F.loadMe());
            document.querySelector('.profile-side').classList.remove('is-error');
            editBtn.disabled = false;
        } catch (err) {
            if (err.status === 401) return;
            $('profile-error-msg').textContent = 'No pudimos cargar tu perfil. ' + err.message;
            ['side-name', 'side-email', 'side-age'].forEach((id) => { if ($(id).textContent === '…') $(id).textContent = '—'; });
            document.querySelectorAll('.profile-side [data-balance]').forEach((n) => { if (n.textContent === '…') n.textContent = '—'; });
            document.querySelector('.profile-side').classList.add('is-error');
            errBox.hidden = false;
        }
    }
    retryBtn.addEventListener('click', async () => {
        UI.busy(retryBtn, true, 'Cargando…');
        await load();
        UI.busy(retryBtn, false);
        if (errBox.hidden) editBtn.focus();
    });
    load();
})();
