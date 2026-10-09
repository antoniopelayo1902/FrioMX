// FrioMx: utilidades de las páginas de cuenta (formularios, juegos, montos).
// Se carga con defer después de app.js; expone window.FrioUI.
(function () {
    'use strict';
    const { el, chips, icon } = window.FrioMx;

    // ---------- Juegos ----------
    const GAMES = {
        Ruleta: { label: 'Ruleta', key: 'roulette', href: '/roulette' },
        'Hi-Lo': { label: 'Hi-Lo', key: 'hilo', href: '/hi-lo' },
        Minas: { label: 'Minas', key: 'mines', href: '/mines' },
    };
    GAMES.Mines = GAMES.Minas; // nombre viejo guardado en el historial
    function game(name) {
        return GAMES[name] || { label: name || 'Juego', key: 'lobby', href: '/index_logIn' };
    }
    // Icono propio del juego en un círculo de color (el arte de los juegos trae texto en inglés).
    function gameThumb(name) {
        const g = game(name);
        return el('span', { class: `game-ico ico-${g.key}`, 'aria-hidden': 'true' }, icon(g.key));
    }

    const RESULTS = {
        GANADA: ['Ganada', 'badge-win'],
        PERDIDA: ['Perdida', 'badge-lose'],
        IGUAL: ['Igual', ''],
        EN_CURSO: ['En curso', 'badge-live'],
        ABANDONADA: ['Abandonada', 'badge-lose'],
    };
    // Neto de una fila del historial. Una ronda en curso todavía no gana ni pierde: se muestra lo apostado.
    // Una abandonada ya perdió la apuesta.
    function net(item) {
        if (item.result === 'EN_CURSO') return el('span', { class: 'amount zero', title: 'La ronda sigue abierta', text: '—' });
        if (item.result === 'ABANDONADA') return amount(-Math.abs(item.bet || Math.abs(item.balance || 0)));
        return amount(item.balance);
    }
    function continueLink(item) {
        if (item.result !== 'EN_CURSO') return null;
        const g = game(item.nameGame);
        return el('a', { class: 'btn btn-sm btn-primary continue', href: g.href, 'aria-label': `Continuar la ronda de ${g.label}`, text: 'Continuar' });
    }
    function resultBadge(result) {
        const [label, cls] = RESULTS[result] || [result || '—', ''];
        return el('span', { class: `badge ${cls}`.trim(), text: label });
    }
    function amount(n) {
        const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero';
        return el('span', { class: `amount ${cls}`, text: chips(n, { sign: true }) });
    }

    // ---------- Formularios ----------
    function errNode(input) { return document.getElementById(input.id + '-err'); }
    function setFieldError(input, msg) {
        const node = errNode(input);
        if (node) node.textContent = msg || '';
        input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    }
    function setFormError(form, msg) {
        const node = form.querySelector('.form-error');
        if (node) node.textContent = msg || '';
    }
    function clearErrors(form) {
        form.querySelectorAll('.input').forEach((i) => setFieldError(i, ''));
        setFormError(form, '');
    }
    // Revisa cada campo con su validador; marca errores y enfoca el primero. Devuelve true si todo está bien.
    function check(form, rules) {
        clearErrors(form);
        let first = null;
        for (const [input, rule] of rules) {
            const msg = rule(input.value);
            if (msg) {
                setFieldError(input, msg);
                if (!first) first = input;
            }
        }
        if (first) first.focus();
        return !first;
    }
    // Quita el error de un campo en cuanto el usuario lo corrige.
    function liveClear(form) {
        form.querySelectorAll('.input').forEach((i) => i.addEventListener('input', () => {
            if (i.getAttribute('aria-invalid') === 'true') setFieldError(i, '');
        }));
    }

    function busy(btn, on, label) {
        if (on) {
            btn.dataset.label = btn.textContent;
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            btn.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
        } else {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = btn.dataset.label || btn.textContent;
        }
    }

    function passwordToggles(scope = document) {
        scope.querySelectorAll('.pw-wrap').forEach((wrap) => {
            const input = wrap.querySelector('input');
            const btn = el('button', { type: 'button', class: 'pw-toggle', 'aria-label': 'Mostrar contraseña', 'aria-pressed': 'false', text: 'Mostrar' });
            btn.addEventListener('click', () => {
                const show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                btn.textContent = show ? 'Ocultar' : 'Mostrar';
                btn.setAttribute('aria-pressed', String(show));
                btn.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
            });
            wrap.append(btn);
        });
    }

    const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const rules = {
        name(v) {
            const t = v.trim();
            if (!t) return 'Escribe tu nombre.';
            if (t.length > 40) return 'El nombre puede tener máximo 40 caracteres.';
            if (/[<>]/.test(v)) return 'No puede llevar los signos < ni >.';
            return '';
        },
        age(v) {
            const t = v.trim();
            if (!t) return 'Escribe tu edad.';
            if (!/^\d{1,3}$/.test(t)) return 'La edad debe ser un número entero.';
            const n = Number(t);
            if (n < 18) return 'Debes tener al menos 18 años.';
            if (n > 99) return 'La edad debe ser de 99 años o menos.';
            return '';
        },
        email(v) {
            const t = v.trim();
            if (!t) return 'Escribe tu correo.';
            if (!EMAIL.test(t) || t.length > 254) return 'Escribe un correo válido, por ejemplo nombre@correo.com.';
            return '';
        },
        password(v) {
            if (!v) return 'Escribe una contraseña.';
            if (v.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
            if (new TextEncoder().encode(v).length > 72) return 'La contraseña es demasiado larga: máximo 72 caracteres (menos si lleva acentos o emojis).';
            return '';
        },
        required(msg) { return (v) => (v ? '' : msg); },
    };

    // Coloca un error del servidor en el campo que corresponde; si no se sabe cuál, arriba del formulario.
    function serverError(form, err, fields = {}) {
        const msg = err.message;
        let target = null;
        if (err.code === 'EMAIL_IN_USE') target = fields.email;
        else if (err.code === 'WRONG_PASSWORD') target = fields.current;
        else if (err.code === 'VALIDATION_ERROR') {
            const m = msg.toLowerCase();
            if (m.includes('nombre')) target = fields.name;
            else if (m.includes('edad')) target = fields.age;
            else if (m.includes('correo')) target = fields.email;
            else if (m.includes('contraseña')) target = fields.password;
        }
        if (target) {
            setFieldError(target, msg.endsWith('.') ? msg : msg + '.');
            target.focus();
        } else {
            setFormError(form, msg);
        }
    }

    window.FrioUI = {
        game, gameThumb, resultBadge, amount, net, continueLink,
        setFieldError, setFormError, clearErrors, check, liveClear, busy, passwordToggles, rules, serverError,
    };
})();
