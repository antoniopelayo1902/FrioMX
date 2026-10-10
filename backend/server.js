require('dotenv').config();
const { config, assertConfig } = require('./src/config/env');
const { loadJwtSecret } = require('./src/config/secrets');
const metrics = require('./src/services/metrics');

// Tiempo máximo total del apagado (métricas + peticiones en vuelo); systemd espera 90 s por defecto.
const SHUTDOWN_FLUSH_MS = 3000;

// Al apagar (deploy = systemctl restart): deja terminar las peticiones en vuelo y manda las
// métricas del minuto en curso, todo con un solo límite de tiempo.
function onShutdown(server) {
    let closing = false;
    return async (signal) => {
        if (closing) return;
        closing = true;
        console.log(`${signal} recibido: enviando métricas pendientes y cerrando`);
        metrics.stop();
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeIdleConnections();
        let timer;
        const limit = new Promise((resolve) => { timer = setTimeout(resolve, SHUTDOWN_FLUSH_MS); });
        try {
            await Promise.race([Promise.all([metrics.flush(), closed]), limit]);
        } catch (err) {
            console.warn('No se pudieron enviar las métricas al cerrar', err.message);
        }
        clearTimeout(timer);
        process.exit(0);
    };
}

async function main() {
    assertConfig();
    // El secreto JWT tiene que estar en memoria antes de aceptar peticiones.
    await loadJwtSecret();
    const { createApp } = require('./src/app');
    const app = createApp();
    metrics.start();

    // Solo escucha en loopback: en la nube nginx (mismo host) es la única entrada.
    const server = app.listen(config.port, config.host, () => {
        console.log(`API de FrioMx escuchando en el puerto ${server.address().port}`);
    });
    const shutdown = onShutdown(server);
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
    // systemd reinicia el servicio cada 5 s (Restart=always), así que salir es seguro.
    console.error('No se pudo arrancar la API:', err.message);
    process.exit(1);
});
