// Historial, perfil, saldo (recargas), ranking y 404.
const { test, expect } = require('@playwright/test');
const { registerViaApi, useSession, apiGet, apiBalance, expectTopbarBalance, trackConsole, digits } = require('./helpers');

// En local no hay cola de recargas ni bucket de fotos: el backend responde 503.
const EXPECTED_HTTP = [/\/api\/wallet\/recharges$/, /\/api\/profile\/(upload|image)$/];

let user;
test.beforeAll(async ({ request }) => {
    user = await registerViaApi(request, 'cuenta');
    // Una ruleta con varias apuestas para que el historial y el ranking tengan algo que mostrar.
    const res = await request.post('/api/games/roulette', {
        headers: { Authorization: `Bearer ${user.token}` },
        data: { bets: [{ type: 'color', value: 'Verde', amount: 100 }, { type: 'parity', value: 'par', amount: 50 }, { type: 'dozen', value: '2', amount: 25 }] },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
});
test.beforeEach(async ({ context }) => { await useSession(context, user); });

test('historial: muestra la ruleta con lo que se apostó completo', async ({ page }) => {
    const errors = trackConsole(page);
    await page.goto('/activity');
    const row = page.locator('#rows tr').first();
    await expect(row).toContainText('Ruleta');
    const detail = row.locator('.detail');
    await expect(detail).toContainText(/^Cayó \d+/);
    await expect(detail.locator('.detail-bets')).toHaveText('Apostaste: Verde: 100, Par: 50, 13–24: 25');
    await expect(row.locator('.c-bet')).toContainText('175');
    await expect(page.locator('#summary')).toBeVisible();

    // Filtro por juego.
    await page.locator('[data-filter="Minas"]').click();
    await expect(page.locator('#status')).toContainText('No tienes partidas de Minas');
    await page.locator('[data-filter="Ruleta"]').click();
    await expect(page.locator('#rows tr')).toHaveCount(1);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('perfil: datos de la cuenta y cambio de nombre', async ({ page, request }) => {
    const errors = trackConsole(page, EXPECTED_HTTP);
    await page.goto('/profile');
    await expect(page.locator('#side-email')).toHaveText(user.email);
    await expect(page.locator('#side-age')).toContainText('25');

    const newName = `E2E ${Date.now() % 100000}`;
    await expect(page.locator('#name-edit')).toBeEnabled();
    await page.click('#name-edit');
    await page.fill('#name', newName);
    await page.click('#name-save');
    await expect(page.locator('.toast')).toContainText('Nombre actualizado');
    await expect(page.locator('#side-name')).toHaveText(newName);
    const me = await (await request.get('/api/user/profile', { headers: { Authorization: `Bearer ${user.token}` } })).json();
    expect(me.name || me.username).toBe(newName);
    user.name = newName;
    expect(errors, errors.join('\n')).toEqual([]);
});

test('saldo: cuadra con la API y las recargas en local responden 503 sin romper la página', async ({ page, request }) => {
    const errors = trackConsole(page, EXPECTED_HTTP);
    await page.goto('/balance');
    const balance = await apiBalance(request, user);
    await expectTopbarBalance(page, balance);
    await expect.poll(async () => digits(await page.locator('.wallet [data-balance], #main [data-balance]').first().innerText())).toBe(balance);

    await page.waitForSelector('#packs .pack');
    await expect(page.locator('#packs .pack')).toHaveCount(3);
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/wallet/recharges') && r.request().method() === 'POST');
    await page.locator('#packs .pack button').first().click();
    const status = (await resp).status();
    // En local (sin cola) es 503; si el entorno sí tiene recargas, se acepta (202).
    expect([202, 503]).toContain(status);
    if (status === 503) {
        await expect(page.locator('#recharge-status.error')).toContainText('no están disponibles por ahora');
        await expect(page.locator('#packs .pack button').first()).toBeEnabled();
        expect(await apiBalance(request, user)).toBe(balance);
    }
    expect(errors, errors.join('\n')).toEqual([]);
});

test('ranking: la semana en curso muestra mi lugar igual que la API', async ({ page, request }) => {
    const errors = trackConsole(page);
    // La base local acumula cuentas de otras corridas: se compara contra lo que dice la API, no contra un lugar fijo.
    const data = await apiGet(request, user, '/leaderboard/current');
    expect(data.me.rank).not.toBeNull();
    await page.goto('/ranking');
    await page.waitForFunction(() => !/Cargando/.test(document.getElementById('current').textContent));
    await expect(page.locator('#current-range')).toHaveText(/^Semana \d+: del /);
    await expect(page.locator('#current tbody tr')).toHaveCount(data.top.length);
    const inTop = data.top.some((r) => r.rank === data.me.rank);
    await expect(page.locator('#current tr.is-me')).toHaveCount(inTop ? 1 : 0);
    await expect(page.locator('#current-me')).toContainText(`lugar ${data.me.rank.toLocaleString('en-US')}`);
    await page.waitForFunction(() => !/Cargando/.test(document.getElementById('last').textContent));
    await expect(page.locator('#last .load-error')).toHaveCount(0);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('404: ruta inexistente responde 404 con su página', async ({ page }) => {
    const res = await page.goto('/no-existe-' + Date.now());
    expect(res.status()).toBe(404);
    await expect(page.locator('h1')).toHaveText('No encontramos esta página');
    await page.locator('.notfound a[href="/"]').click();
    await expect(page).toHaveURL(/\/(index_logIn)?$/);
});
