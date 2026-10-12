// Utilidades de prueba: errores de DynamoDB con la forma que lanza el SDK.
const { TransactionCanceledException, ConditionalCheckFailedException } = require('@aws-sdk/client-dynamodb');

function txCanceled(codes) {
    return new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: codes.map((Code) => ({ Code })),
    });
}

function conditionalFailed() {
    return new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
}

// Lee las líneas EMF que se imprimieron con console.log.
function emfLines(logSpy) {
    return logSpy.mock.calls
        .map((args) => { try { return JSON.parse(args[0]); } catch { return null; } })
        .filter((l) => l && l._aws);
}

module.exports = { txCanceled, conditionalFailed, emfLines };
