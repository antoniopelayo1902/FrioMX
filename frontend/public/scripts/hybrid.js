// FrioMx: páginas de contenido (Reglas, Acerca de) que sirven con o sin sesión.
// Va en el <head> ANTES de app.js. Con sesión se muestra el menú de la app;
// sin sesión, el encabezado público (las reglas se pueden leer antes de registrarse).
(function () {
    'use strict';
    if (!localStorage.getItem('token')) return;
    document.documentElement.dataset.session = 'in';
    // Este listener se registra antes que el de app.js, así que el shell se arma con data-shell puesto.
    document.addEventListener('DOMContentLoaded', () => {
        document.body.setAttribute('data-shell', '');
        setTimeout(() => {
            window.FrioMx.loadMe().catch((e) => { if (e.status !== 401) window.FrioMx.toast(e.message, 'error'); });
        }, 0);
    });
})();
