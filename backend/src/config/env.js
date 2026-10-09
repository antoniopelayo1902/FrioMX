// Configuración leída de variables de entorno.
// En EC2 vienen de /etc/friomx/backend.env (EnvironmentFile de systemd); en local, de backend/.env.

function read(name, fallback) {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
}

const config = {
    port: Number(read('PORT', 3000)),
    region: read('AWS_REGION', 'us-east-1'),
    ddbEndpoint: read('DDB_ENDPOINT', undefined),
    jwtSecret: read('JWT_SECRET', undefined),
    tz: read('APP_TZ', 'America/Mexico_City'),
    tables: {
        users: read('TABLE_USERS', 'friomx-users'),
        userEmails: read('TABLE_USER_EMAILS', 'friomx-user-emails'),
        activity: read('TABLE_ACTIVITY', 'friomx-activity'),
        weeklyStats: read('TABLE_WEEKLY_STATS', 'friomx-weekly-stats'),
        gameRounds: read('TABLE_GAME_ROUNDS', 'friomx-game-rounds'),
    },
};

function assertConfig() {
    if (!config.jwtSecret) {
        throw new Error('Falta JWT_SECRET');
    }
}

module.exports = { config, assertConfig };
