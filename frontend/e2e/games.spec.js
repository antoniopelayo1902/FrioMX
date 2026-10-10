// Los 3 juegos: cada partida mueve el saldo exactamente lo que dice el servidor, y la barra
// superior y el historial cuadran con /api/user/balance.
const { test, expect } = require('@playwright/test');
const { registerViaApi, useSession, apiBalance, apiGet, expectTopbarBalance, trackConsole } = require('./helpers');

let user;
test.beforeAll(async ({ request }) => { user = await registerViaApi(request, 'games'); });
test.beforeEach(async ({ context }) => { await useSession(context, user); });

// La partida más reciente del historial (API) tiene el neto que movió el saldo.
async function lastActivity(request) {
    const data = await apiGet(request, user, '/user/activity?limit=1');
    return data.items[0];
}

test('ruleta: apuesta con el control común y el saldo cuadra', async ({ page, request }) => {
    const errors = trackConsole(page);
    await page.goto('/roulette');
    const before = await apiBalance(request, user);
    await expectTopbarBalance(page, before);

    // Valor de la ficha con el mismo control que Hi-Lo y Minas: ficha rápida de 50 y luego 25 escrito.
    const bet = page.locator('#rl-chips');
    await bet.locator('.bet-chip-50').click();
    await expect(bet.locator('.bet-chip-50')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-key="color:Rojo"]').click();
    await bet.locator('input').fill('25');
    await page.locator('[data-key="parity:par"]').click();
    await page.locator('[data-key="parity:par"]').click();
    await expect(page.locator('#rl-total')).toHaveText('100');

    const resp = page.waitForResponse((r) => r.url().endsWith('/api/games/roulette') && r.request().method() === 'POST');
    await page.click('#rl-spin');
    const data = await (await resp).json();
    await page.waitForSelector('#rl-result-done:not([hidden])', { timeout: 20_000 });
    expect(data.totalBet).toBe(100);

    const after = await apiBalance(request, user);
    expect(after - before).toBe(data.totalAmountChange);
    await expectTopbarBalance(page, after);
    await expect(page.locator('#rl-res-list li')).toHaveCount(2);
    const last = await lastActivity(request);
    expect(last.nameGame).toMatch(/roulette|ruleta/i);
    expect(last.detail).toContain('apostaste');
    expect(errors, errors.join('\n')).toEqual([]);
});

test('ruleta: valor de ficha inválido no pone fichas', async ({ page }) => {
    await page.goto('/roulette');
    await page.locator('#rl-chips input').fill('0');
    await expect(page.locator('#rl-chips .error')).toContainText('mínima');
    await page.locator('[data-key="color:Negro"]').click();
    await expect(page.locator('#rl-total')).toHaveText('0');
});

test('hi-lo: repartir, elegir y el saldo cuadra', async ({ page, request }) => {
    const errors = trackConsole(page);
    await page.goto('/hi-lo');
    await page.waitForSelector('#btnDeal:visible');
    const before = await apiBalance(request, user);
    await expectTopbarBalance(page, before);

    await page.locator('#betHost .bet-chip-50').click();
    await page.click('#btnDeal');
    await page.waitForSelector('#hlChoices:not([hidden])');
    const pick = (await page.locator('#btnHigher').isEnabled()) ? '#btnHigher' : '#btnLower';
    const resp = page.waitForResponse((r) => r.url().endsWith('/api/games/hi-lo') && r.request().method() === 'POST');
    await page.click(pick);
    const data = await (await resp).json();
    await page.waitForSelector('#hlOutcome:not([hidden])');

    const after = await apiBalance(request, user);
    expect(after).toBe(data.newBalance);
    const last = await lastActivity(request);
    expect(after - before).toBe(Number(last.balance));
    await expectTopbarBalance(page, after);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('minas: empezar, destapar y cobrar (o pisar mina) y el saldo cuadra', async ({ page, request }) => {
    const errors = trackConsole(page);
    await page.goto('/mines');
    await page.waitForSelector('#btnStart:visible');
    const before = await apiBalance(request, user);

    await page.locator('#betHost input').fill('20');
    await page.click('#btnStart');
    await page.waitForSelector('#mnLive:not([hidden])');
    await expectTopbarBalance(page, before - 20);

    // Destapa hasta 3 casillas; si sale mina la partida termina sola.
    for (let i = 0; i < 3; i += 1) {
        if (!(await page.locator('#mnOutcome').isHidden())) break;
        const resp = page.waitForResponse((r) => r.url().endsWith('/api/games/mines/reveal'));
        await page.locator('#board .tile.hidden').first().click();
        await resp;
        await page.waitForFunction(() => !document.querySelector('#board .tile.pending'));
    }
    if (await page.locator('#mnOutcome').isHidden()) {
        await expect(page.locator('#btnCash')).toBeEnabled();
        await page.click('#btnCash');
    }
    await page.waitForSelector('#mnOutcome:not([hidden])');

    const after = await apiBalance(request, user);
    const last = await lastActivity(request);
    expect(last.result).not.toBe('EN_CURSO');
    expect(after - before).toBe(Number(last.balance));
    await expectTopbarBalance(page, after);
    expect(errors, errors.join('\n')).toEqual([]);
});
