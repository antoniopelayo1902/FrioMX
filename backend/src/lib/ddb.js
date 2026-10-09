const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { config } = require('../config/env');

const clientConfig = { region: config.region };

// En local se apunta a DynamoDB Local; en la nube se usa el endpoint normal.
if (config.ddbEndpoint) {
    clientConfig.endpoint = config.ddbEndpoint;
    clientConfig.credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig), {
    marshallOptions: { removeUndefinedValues: true },
});

// Regresa el código de cancelación por ítem de una TransactionCanceledException.
function cancellationCodes(err) {
    if (err && err.name === 'TransactionCanceledException' && Array.isArray(err.CancellationReasons)) {
        return err.CancellationReasons.map((r) => (r && r.Code) || 'None');
    }
    return null;
}

module.exports = { ddb, cancellationCodes };
