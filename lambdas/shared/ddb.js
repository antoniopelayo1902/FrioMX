const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const clientConfig = { region: process.env.AWS_REGION || 'us-east-1' };

// DDB_ENDPOINT solo existe en local (DynamoDB Local); en Lambda no se define.
if (process.env.DDB_ENDPOINT) {
    clientConfig.endpoint = process.env.DDB_ENDPOINT;
    clientConfig.credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig), {
    marshallOptions: { removeUndefinedValues: true },
});

// Código de cancelación por ítem de una TransactionCanceledException, en el orden de la petición.
function cancellationCodes(err) {
    if (err && err.name === 'TransactionCanceledException' && Array.isArray(err.CancellationReasons)) {
        return err.CancellationReasons.map((r) => (r && r.Code) || 'None');
    }
    return null;
}

module.exports = { ddb, cancellationCodes };
