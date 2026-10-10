const metrics = require('../services/metrics');

// Mide la latencia de cada petición y cuenta las respuestas 5xx (LLD §11).
function requestMetrics(req, res, next) {
    if (!metrics.enabled()) return next();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        metrics.recordRequest(ms, res.statusCode);
    });
    return next();
}

module.exports = { requestMetrics };
