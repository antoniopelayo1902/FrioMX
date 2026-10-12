// Pasada en celular (390x844 táctil) y en celular horizontal (844x390).
const { test, expect } = require('@playwright/test');
const { registerViaApi, useSession, apiBalance, expectTopbarBalance, trackConsole, expectNoHorizontalScroll } = require('./helpers');

let user;
test.beforeAll(async ({ request }) => { user = await registerViaApi(request, 'cel'); });
test.beforeEach(async ({ context }) => { await useSession(context, user); });

test('celular: navegación con la barra inferior y sin scroll horizontal', async ({ page }) => {
    const errors = trackConsole(page);
    await page.goto('/index_logIn');
    await expect(page.locator('.bottombar')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
    for (const [href, label] of [['/ranking', 'Ranking'], ['/activity', 'Historial'], ['/balance', 'Saldo'], ['/rules', 'Reglas'], ['/profile', 'Perfil']]) {
        await page.locator(`.bottombar a[href="${href}"]`).click();
        await page.waitForURL(new RegExp(href + '$'));
        await expect(page.locator('.bottombar a[aria-current="page"]')).toContainText(label);
        await expectNoHorizontalScroll(page);
    }
    expect(errors.filter((e) => !/\/api\/(wallet|profile)/.test(e)), errors.join('\n')).toEqual([]);
});

test('celular: ruleta con barra fija de Girar y el historial completo', async ({ page, request }) => {
    const errors = trackConsole(page);
    await page.goto('/roulette');
    const before = await apiBalance(request, user);
    await page.locator('#rl-chips .bet-chip-100').click();
    await page.locator('[data-key="color:Verde"]').click();
    await page.locator('#rl-chips .bet-chip-50').click();
    await page.locator('[data-key="parity:par"]').click();
    await expect(page.locator('.rl-spinbar')).toHaveCSS('position', 'fixed');
    await expectNoHorizontalScroll(page);
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/games/roulette'));
    await page.click('#rl-spin');
    const data = await (await resp).json();
    await page.waitForSelector('#rl-result-done:not([hidden])', { timeout: 20_000 });
    const after = await apiBalance(request, user);
    expect(after - before).toBe(data.totalAmountChange);
    await expectTopbarBalance(page, after);

    await page.goto('/activity');
    const bets = page.locator('#rows tr').first().locator('.detail-bets');
    await expect(bets).toHaveText('Apostaste: Verde: 100, Par: 50');
    // Se ve entero: no queda cortado por el ancho de la tarjeta.
    const box = await bets.evaluate((n) => ({ sw: n.scrollWidth, cw: n.clientWidth }));
    expect(box.sw).toBeLessThanOrEqual(box.cw);
    await expectNoHorizontalScroll(page);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('celular horizontal: en Minas los contadores quedan arriba, a la vista', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/mines');
    await page.waitForSelector('#btnStart:visible');
    await page.locator('#betHost input').fill('10');
    await page.click('#btnStart');
    await page.waitForSelector('#mnLive:not([hidden])');
    const vh = page.viewportSize().height;
    const stats = await page.locator('.mn-stats').boundingBox();
    const board = await page.locator('.mn-board-wrap').boundingBox();
    // Al lado del tablero (a la derecha) y dentro de la pantalla sin hacer scroll.
    expect(stats.x).toBeGreaterThanOrEqual(board.x + board.width);
    expect(stats.y + stats.height).toBeLessThanOrEqual(vh);
    await expectNoHorizontalScroll(page);
});
