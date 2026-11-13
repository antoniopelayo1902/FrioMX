const metrics = require('../services/metrics');

// Mide la latencia de cada petición y cuenta las respuestas 5xx (LLD §11).
function requestMetrics(req, res, next) {
    // El stream SSE queda abierto minutos u horas: medirlo inflaría la latencia p95 del dashboard.
    if (!metrics.enabled() || req.path === '/api/stream') return next();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        metrics.recordRequest(ms, res.statusCode);
    });
    return next();
}

module.exports = { requestMetrics };
