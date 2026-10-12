// Pruebas de punta a punta (Playwright) del frontend de FrioMx.
// Necesita levantados: DynamoDB Local (:8000, con tablas), el backend (:3000) y el frontend
// con proxy a /api (`npm run dev`, :8080). Otra URL: BASE_URL=http://host:puerto npm run e2e
const { defineConfig, devices } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

module.exports = defineConfig({
    testDir: './e2e',
    // El backend limita los registros a 10 por minuto por IP: pocos workers y cada archivo crea 1 o 2 cuentas.
    workers: 2,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: 0,
    // Holgado: si se agota el límite de registros, los helpers esperan hasta ~80 s.
    timeout: 120_000,
    expect: { timeout: 10_000 },
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
    outputDir: 'test-results',
    use: {
        baseURL: BASE_URL,
        locale: 'es-MX',
        timezoneId: 'America/Mexico_City',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'escritorio',
            testIgnore: /mobile\.spec\.js/,
            use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
        },
        {
            name: 'celular',
            testMatch: /mobile\.spec\.js/,
            use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } },
        },
    ],
});
