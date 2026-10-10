// Registro, login, logout y guardia de sesión.
const { test, expect } = require('@playwright/test');
const { PASSWORD, randomEmail, trackConsole, apiBalance, expectTopbarBalance } = require('./helpers');

test('registro, logout y login con la misma cuenta', async ({ page, request }) => {
    test.setTimeout(150_000);
    // El 401 del intento con contraseña incorrecta es esperado.
    const errors = trackConsole(page, [/\/api\/auth\/(login|register)$/]);
    const email = randomEmail('auth');
    const name = 'E2E Auth';

    await page.goto('/register');
    await page.fill('#name', name);
    await page.fill('#age', '25');
    await page.fill('#email', email);
    await page.fill('#password', PASSWORD);
    await page.fill('#confirm', PASSWORD);
    // Si otra corrida acaba de gastar el límite de registros (10/min), la página lo dice: se reintenta.
    for (let i = 0; i < 8; i += 1) {
        await page.click('#submit');
        const outcome = await Promise.race([
            page.waitForURL(/\/index_logIn$/).then(() => 'ok'),
            page.locator('#register-form').getByText(/Demasiados intentos/).waitFor().then(() => 'limit'),
        ]);
        if (outcome === 'ok') break;
        await page.waitForTimeout(10_000);
    }
    await page.waitForURL(/\/index_logIn$/);
    await expect(page.locator('.topbar')).toContainText(name);
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeTruthy();
    await expectTopbarBalance(page, await apiBalance(request, { token }));

    // Logout desde el menú: pide confirmación y borra el token.
    await page.locator('.sidebar button:has-text("Cerrar sesión")').click();
    await page.locator('.dialog .btn-danger').click();
    await page.waitForURL(/\/logIn$/);
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();

    // Una página privada sin sesión manda al login.
    await page.goto('/activity');
    await page.waitForURL(/\/logIn/);

    // Contraseña incorrecta: mensaje claro y sigue en el login.
    await page.goto('/logIn');
    await page.fill('#email', email);
    await page.fill('#password', 'otra-cosa-123');
    await page.click('#submit');
    await expect(page.locator('#login-form')).toContainText('Correo o contraseña incorrectos');

    await page.fill('#password', PASSWORD);
    await page.click('#submit');
    await page.waitForURL(/\/index_logIn$/);
    await expect(page.locator('.topbar')).toContainText(name);

    expect(errors, errors.join('\n')).toEqual([]);
});

test('registro: valida campos sin llamar al servidor', async ({ page }) => {
    await page.goto('/register');
    await page.fill('#email', 'no-es-correo');
    await page.fill('#password', 'corta');
    await page.fill('#confirm', 'distinta');
    await page.click('#submit');
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.locator('#email-err')).not.toBeEmpty();
    await expect(page.locator('#password-err')).not.toBeEmpty();
});
