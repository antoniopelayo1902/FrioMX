// Métricas con Embedded Metric Format: una línea JSON en el log que CloudWatch convierte en métrica.
function namespace() {
    return process.env.METRICS_NAMESPACE || 'FrioMx';
}

// values: { NombreMetrica: numero }. Las métricas en 0 también se emiten para que la serie no tenga huecos.
function emit(values, unit = 'Count') {
    const names = Object.keys(values || {});
    if (names.length === 0) return null;
    const line = {
        _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [{
                Namespace: namespace(),
                Dimensions: [[]],
                Metrics: names.map((Name) => ({ Name, Unit: unit })),
            }],
        },
    };
    for (const name of names) line[name] = values[name];
    console.log(JSON.stringify(line));
    return line;
}

module.exports = { emit };
