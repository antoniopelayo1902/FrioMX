// Clientes de AWS (salvo DynamoDB, que vive en lib/ddb.js). Se crean al primer uso,
// así en local nunca se construyen si la función está apagada.
const { SQSClient } = require('@aws-sdk/client-sqs');
const { SNSClient } = require('@aws-sdk/client-sns');
const { S3Client } = require('@aws-sdk/client-s3');
const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
const { CloudWatchClient } = require('@aws-sdk/client-cloudwatch');
const { config } = require('../config/env');

const cache = {};

function lazy(name, Client, options = {}) {
    return () => {
        if (!cache[name]) cache[name] = new Client({ region: config.region, ...options });
        return cache[name];
    };
}

// SNS va en el camino del registro y del cambio de correo: si tarda, se corta rápido.
const SNS_OPTIONS = { maxAttempts: 2, requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 } };

module.exports = {
    SNS_OPTIONS,
    sqs: lazy('sqs', SQSClient),
    sns: lazy('sns', SNSClient, SNS_OPTIONS),
    s3: lazy('s3', S3Client),
    secrets: lazy('secrets', SecretsManagerClient),
    cloudwatch: lazy('cloudwatch', CloudWatchClient),
};
