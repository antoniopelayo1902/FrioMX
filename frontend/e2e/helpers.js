// Utilidades comunes de la suite e2e. Cada archivo crea sus propias cuentas (correo aleatorio),
// así ninguna prueba depende de otra ni del orden en que corren.
const crypto = require('crypto');
const { expect } = require('@playwright/test');

const PASSWORD = 'secreto123';

function randomEmail(tag) {
    return `e2e.${tag}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}@example.com`;
}

// Registro por API (rápido) para las pruebas que no son del flujo de registro.
async function registerViaApi(request, tag) {
    const email = randomEmail(tag);
    const name = `E2E ${tag}`;
    // El backend permite 10 registros por minuto por IP: si dos corridas van seguidas, espera y reintenta.
    let res;
    for (let i = 0; i < 8; i += 1) {
        res = await request.post('/api/auth/register', { data: { name, age: 25, email, password: PASSWORD } });
        if (res.status() !== 429) break;
        await new Promise((r) => setTimeout(r, 10_000));
    }
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    return { email, name, password: PASSWORD, token: body.token, id: body.user && body.user.id };
}

// Abre la sesión en el navegador guardando el token igual que lo hace login.js.
async function useSession(context, user) {
    await context.addInitScript((t) => { localStorage.setItem('token', t); }, user.token);
}

async function apiGet(request, user, path) {
    const res = await request.get('/api' + path, { headers: { Authorization: `Bearer ${user.token}` } });
    expect(res.ok(), `${path}: ${res.status()}`).toBeTruthy();
    return res.json();
}

const apiBalance = async (request, user) => (await apiGet(request, user, '/user/balance')).balance;
const digits = (s) => Number(String(s).replace(/\D/g, ''));

// El saldo de la barra superior debe ser exactamente el de /api/user/balance.
async function expectTopbarBalance(page, expected) {
    await expect.poll(async () => digits(await page.locator('.topbar [data-balance]').first().innerText()))
        .toBe(expected);
}

// Errores de consola/CSP: los HTTP esperados (503 de recargas, 404 de la página 404) no cuentan.
function trackConsole(page, allowed = []) {
    const errors = [];
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const url = (m.location() && m.location().url) || '';
        if (/Failed to load resource/.test(m.text()) && allowed.some((re) => re.test(url))) return;
        errors.push(`${m.text()} @ ${url}`);
    });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    return errors;
}

async function expectNoHorizontalScroll(page) {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(r.sw, JSON.stringify(r)).toBeLessThanOrEqual(r.cw);
}

module.exports = {
    PASSWORD, randomEmail, registerViaApi, useSession, apiGet, apiBalance, digits,
    expectTopbarBalance, trackConsole, expectNoHorizontalScroll,
};
