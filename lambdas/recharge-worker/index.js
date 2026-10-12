// friomx-recharge-worker: acredita recargas encoladas en friomx-recharges (LLD §6.1).
const { GetCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, cancellationCodes } = require('../shared/ddb');
const { publishToUser } = require('../shared/sns');
const metrics = require('../shared/metrics');

// Acredita una recarga. Regresa 'COMPLETED' o 'DUPLICATE'; lanza en cualquier otro caso.
async function processRecharge(rechargeId, now = new Date()) {
    if (typeof rechargeId !== 'string' || rechargeId === '') {
        throw new Error('Mensaje sin rechargeId');
    }
    const res = await ddb.send(new GetCommand({
        TableName: process.env.TABLE_RECHARGES, Key: { rechargeId }, ConsistentRead: true,
    }));
    const recharge = res.Item;
    if (!recharge) throw new Error(`La recarga ${rechargeId} no existe`);

    try {
        await ddb.send(new TransactWriteCommand({
            TransactItems: [
                {
                    Update: {
                        TableName: process.env.TABLE_RECHARGES,
                        Key: { rechargeId },
                        UpdateExpression: 'SET #status = :completed, #completedAt = :now',
                        ConditionExpression: '#status = :pending',
                        ExpressionAttributeNames: { '#status': 'status', '#completedAt': 'completedAt' },
                        ExpressionAttributeValues: { ':completed': 'COMPLETED', ':pending': 'PENDING', ':now': now.toISOString() },
                    },
                },
                {
                    Update: {
                        TableName: process.env.TABLE_USERS,
                        Key: { userId: recharge.userId },
                        UpdateExpression: 'ADD #balance :chips',
                        ConditionExpression: 'attribute_exists(#userId)',
                        ExpressionAttributeNames: { '#balance': 'balance', '#userId': 'userId' },
                        ExpressionAttributeValues: { ':chips': recharge.chips },
                    },
                },
            ],
        }));
    } catch (err) {
        const codes = cancellationCodes(err);
        // Ítem 0 falló: la recarga ya no está PENDING, o sea ya se acreditó. Duplicado, sin correo.
        if (codes && codes[0] === 'ConditionalCheckFailed') return { status: 'DUPLICATE', recharge };
        throw err;
    }
    return { status: 'COMPLETED', recharge };
}

async function notify(recharge) {
    try {
        await publishToUser(recharge.userId, `Tu recarga de ${recharge.chips} fichas está lista`, 'FrioMx: recarga lista');
        return true;
    } catch (err) {
        console.error(JSON.stringify({ msg: 'No se pudo publicar el aviso de recarga', rechargeId: recharge.rechargeId, error: err.message }));
        return false;
    }
}

async function run(event, now = new Date()) {
    const records = (event && event.Records) || [];
    const batchItemFailures = [];
    let completed = 0;
    let failed = 0;
    let notificationFailed = 0;

    for (const record of records) {
        try {
            const body = JSON.parse(record.body);
            const result = await processRecharge(body && body.rechargeId, now);
            if (result.status === 'COMPLETED') {
                completed += 1;
                if (!(await notify(result.recharge))) notificationFailed += 1;
            }
        } catch (err) {
            failed += 1;
            console.error(JSON.stringify({ msg: 'Fallo al procesar recarga', messageId: record.messageId, error: err.message }));
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }

    metrics.emit({ RechargesCompleted: completed, RechargeFailed: failed, NotificationFailed: notificationFailed });
    return { batchItemFailures };
}

const handler = (event) => run(event, new Date());

module.exports = { handler, run, processRecharge };
