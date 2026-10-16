// Saldo en tiempo real (SSE): el servidor empuja balanceUpdate por /api/stream y la barra superior
// se actualiza sola, sin recargar la página ni volver a pedir el saldo.
const { test, expect } = require('@playwright/test');
const { registerViaApi, useSession, apiBalance, expectTopbarBalance, trackConsole } = require('./helpers');

let user;
test.beforeAll(async ({ request }) => { user = await registerViaApi(request, 'sse'); });
test.beforeEach(async ({ context }) => { await useSession(context, user); });

const auth = () => ({ Authorization: `Bearer ${user.token}` });

// Abre la página y espera a que el EventSource quede conectado antes de apostar.
async function openWithStream(page, path) {
    const stream = page.waitForResponse((r) => r.url().includes('/api/stream'));
    await page.goto(path);
    expect((await stream).status()).toBe(200);
    // Marca en window: si la página se recargara, la marca desaparece.
    await page.evaluate(() => { window.__sinRecarga = true; });
}

// Peticiones a /api que hace la página (sin contar el stream).
function trackApiCalls(page) {
    const calls = [];
    page.on('request', (r) => {
        const url = new URL(r.url());
        if (url.pathname.startsWith('/api/') && url.pathname !== '/api/stream') calls.push(`${r.method()} ${url.pathname}`);
    });
    return calls;
}

test('una apuesta hecha fuera de la página actualiza el saldo del DOM por SSE', async ({ page, request }) => {
    const errors = trackConsole(page);
    let navigations = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations += 1; });

    await openWithStream(page, '/roulette');
    const before = await apiBalance(request, user);
    await expectTopbarBalance(page, before);
    const navigationsBefore = navigations;
    const calls = trackApiCalls(page);

    // La apuesta va por API, no por la página: la única forma de que el DOM cambie es el evento SSE.
    const res = await request.post('/api/games/roulette', {
        headers: auth(), data: { bets: [{ type: 'color', value: 'Rojo', amount: 10 }] },
    });
    expect(res.status(), await res.text()).toBe(200);
    const { newBalance } = await res.json();
    // Una sola apuesta a color siempre gana o pierde 10: el saldo nunca queda igual.
    expect(Math.abs(newBalance - before)).toBe(10);

    await expectTopbarBalance(page, newBalance);
    expect(await page.evaluate(() => window.__sinRecarga)).toBe(true);
    expect(navigations).toBe(navigationsBefore);
    expect(calls, 'la página no debe volver a pedir el saldo').toEqual([]);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('la conexión sigue viva: varias jugadas seguidas llegan en orden', async ({ page, request }) => {
    await openWithStream(page, '/lobby');
    await expectTopbarBalance(page, await apiBalance(request, user));

    // Repartir en Hi-Lo cobra la apuesta: el saldo baja exactamente 25.
    const deal = await request.post('/api/games/hi-lo/deal', { headers: auth(), data: { betAmount: 25 } });
    expect(deal.status(), await deal.text()).toBe(201);
    const afterDeal = (await deal.json()).newBalance;
    await expectTopbarBalance(page, afterDeal);

    const spin = await request.post('/api/games/roulette', {
        headers: auth(), data: { bets: [{ type: 'parity', value: 'par', amount: 15 }] },
    });
    expect(spin.status(), await spin.text()).toBe(200);
    await expectTopbarBalance(page, (await spin.json()).newBalance);
    expect(await page.evaluate(() => window.__sinRecarga)).toBe(true);
});

test('una apuesta desde la interfaz también llega como evento balanceUpdate', async ({ page, request }) => {
    // El cliente SSE (app.js) registra en consola cada saldo que recibe.
    const pushed = [];
    page.on('console', (m) => {
        const match = /Actualización de saldo en tiempo real!?\s+(-?\d+)/.exec(m.text());
        if (match) pushed.push(Number(match[1]));
    });

    await openWithStream(page, '/roulette');
    await expectTopbarBalance(page, await apiBalance(request, user));

    await page.locator('#rl-chips .bet-chip-50').click();
    await page.locator('[data-key="color:Negro"]').click();
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/games/roulette') && r.request().method() === 'POST');
    await page.click('#rl-spin');
    const { newBalance } = await (await resp).json();

    await expect.poll(() => pushed).toContain(newBalance);
    await page.waitForSelector('#rl-result-done:not([hidden])', { timeout: 20_000 });
    await expectTopbarBalance(page, newBalance);
});
