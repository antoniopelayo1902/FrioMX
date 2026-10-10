const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { config } = require('./env');
const aws = require('../lib/aws');

// Deja listo config.jwtSecret. Si JWT_SECRET existe se usa tal cual y no se llama a Secrets Manager;
// si no, se lee JWT_SECRET_ARN una sola vez al arrancar y queda en memoria.
async function loadJwtSecret() {
    if (config.jwtSecret) return config.jwtSecret;
    if (!config.jwtSecretArn) throw new Error('Falta JWT_SECRET o JWT_SECRET_ARN');
    const res = await aws.secrets().send(new GetSecretValueCommand({ SecretId: config.jwtSecretArn }));
    if (typeof res.SecretString !== 'string' || res.SecretString.length < 32) {
        throw new Error('El secreto JWT está vacío o es demasiado corto');
    }
    config.jwtSecret = res.SecretString;
    return config.jwtSecret;
}

module.exports = { loadJwtSecret };
