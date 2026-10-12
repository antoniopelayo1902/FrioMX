const { PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const aws = require('../lib/aws');
const { config } = require('../config/env');

// Métricas del backend (LLD §11): se acumulan en memoria y se mandan cada 60 s con PutMetricData.
// Solo con METRICS_ENABLED=true; en local todo esto no hace nada.
const FLUSH_MS = 60 * 1000;
const MAX_VALUES_PER_DATUM = 150;
const MAX_DATA_PER_CALL = 20;

let games = new Map(); // Game -> partidas
let latency = new Map(); // ms redondeados a 10 -> veces
let errors5xx = 0;
let timer = null;

function enabled() {
    return config.metricsEnabled === true;
}

function countGame(game) {
    if (!enabled()) return;
    games.set(game, (games.get(game) || 0) + 1);
}

function recordRequest(ms, status) {
    if (!enabled()) return;
    const bucket = Math.max(0, Math.round(ms / 10) * 10);
    latency.set(bucket, (latency.get(bucket) || 0) + 1);
    if (status >= 500) errors5xx += 1;
}

// Arma los datos y vacía el buffer. La latencia va como Values/Counts para que CloudWatch saque percentiles.
function drain(now = new Date()) {
    const data = [];
    for (const [game, n] of games) {
        data.push({ MetricName: 'GamesPlayed', Dimensions: [{ Name: 'Game', Value: game }], Unit: 'Count', Value: n, Timestamp: now });
    }
    const pairs = [...latency.entries()].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < pairs.length; i += MAX_VALUES_PER_DATUM) {
        const chunk = pairs.slice(i, i + MAX_VALUES_PER_DATUM);
        data.push({
            MetricName: 'ApiLatency', Unit: 'Milliseconds', Timestamp: now,
            Values: chunk.map((p) => p[0]), Counts: chunk.map((p) => p[1]),
        });
    }
    // Con tráfico en el minuto se manda Api5xx aunque sea 0, así la gráfica no queda con huecos.
    if (pairs.length || errors5xx) data.push({ MetricName: 'Api5xx', Unit: 'Count', Value: errors5xx, Timestamp: now });
    games = new Map();
    latency = new Map();
    errors5xx = 0;
    return data;
}

async function flush() {
    if (!enabled()) return 0;
    const data = drain();
    let calls = 0;
    for (let i = 0; i < data.length; i += MAX_DATA_PER_CALL) {
        try {
            await aws.cloudwatch().send(new PutMetricDataCommand({
                Namespace: config.metricsNamespace, MetricData: data.slice(i, i + MAX_DATA_PER_CALL),
            }));
            calls += 1;
        } catch (err) {
            // Se pierden los datos de este minuto, pero la API sigue sirviendo.
            console.warn('No se pudieron enviar métricas', err.name, err.message);
        }
    }
    return calls;
}

function start() {
    if (!enabled() || timer) return;
    timer = setInterval(() => { flush(); }, FLUSH_MS);
    // unref: el timer no mantiene vivo el proceso (ni cuelga jest).
    timer.unref();
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { enabled, countGame, recordRequest, drain, flush, start, stop, MAX_VALUES_PER_DATUM };
