// Configuración leída de variables de entorno.
// En EC2 vienen de /etc/friomx/backend.env (EnvironmentFile de systemd); en local, de backend/.env.
// Lo que depende de AWS se apaga limpio cuando falta su variable (ver contrato de Fase 2).

function read(name, fallback) {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
}

const config = {
    port: Number(read('PORT', 3000)),
    host: read('HOST', '127.0.0.1'),
    region: read('AWS_REGION', 'us-east-1'),
    ddbEndpoint: read('DDB_ENDPOINT', undefined),
    // En local se usa JWT_SECRET; en la nube se carga de Secrets Manager al arrancar (config/secrets.js).
    jwtSecret: read('JWT_SECRET', undefined),
    jwtSecretArn: read('JWT_SECRET_ARN', undefined),
    tz: read('APP_TZ', 'America/Mexico_City'),
    tables: {
        users: read('TABLE_USERS', 'friomx-users'),
        userEmails: read('TABLE_USER_EMAILS', 'friomx-user-emails'),
        activity: read('TABLE_ACTIVITY', 'friomx-activity'),
        weeklyStats: read('TABLE_WEEKLY_STATS', 'friomx-weekly-stats'),
        recharges: read('TABLE_RECHARGES', 'friomx-recharges'),
        gameRounds: read('TABLE_GAME_ROUNDS', 'friomx-game-rounds'),
        leaderboard: read('TABLE_LEADERBOARD', 'friomx-leaderboard'),
    },
    // Opcionales: sin ellas la función correspondiente responde 503 o no hace nada.
    uploadsBucket: read('UPLOADS_BUCKET', undefined),
    rechargeQueueUrl: read('RECHARGE_QUEUE_URL', undefined),
    userTopicArn: read('USER_TOPIC_ARN', undefined),
    metricsNamespace: read('METRICS_NAMESPACE', 'FrioMx'),
    metricsEnabled: read('METRICS_ENABLED', 'false') === 'true',
};

function assertConfig() {
    if (!config.jwtSecret && !config.jwtSecretArn) {
        throw new Error('Falta JWT_SECRET o JWT_SECRET_ARN');
    }
}

module.exports = { config, assertConfig };
