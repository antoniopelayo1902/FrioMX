// friomx-daily-bonus: 100 fichas al día a quien jugó en los últimos 7 días (LLD §6.2).
const { ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../shared/ddb');
const { publishToUser } = require('../shared/sns');
const { localDate } = require('../shared/time');
const metrics = require('../shared/metrics');

const BONUS = 100;
const ACTIVE_WINDOW_MS = 7 * 86400000;

// Scan paginado de jugadores activos (lastPlayedAt >= hace 7 días).
async function activeUserIds(sinceIso) {
    const ids = [];
    let ExclusiveStartKey;
    do {
        const page = await ddb.send(new ScanCommand({
            TableName: process.env.TABLE_USERS,
            FilterExpression: '#lastPlayedAt >= :since',
            ProjectionExpression: '#userId',
            ExpressionAttributeNames: { '#lastPlayedAt': 'lastPlayedAt', '#userId': 'userId' },
            ExpressionAttributeValues: { ':since': sinceIso },
            ExclusiveStartKey,
        }));
        for (const item of page.Items || []) ids.push(item.userId);
        ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return ids;
}

// true si se acreditó, false si ya tenía el bono de hoy.
async function grantBonus(userId, today) {
    try {
        await ddb.send(new UpdateCommand({
            TableName: process.env.TABLE_USERS,
            Key: { userId },
            UpdateExpression: 'ADD #balance :bonus SET #lastBonusDate = :today',
            // attribute_exists evita crear un usuario si se borró entre el Scan y el Update.
            ConditionExpression: 'attribute_exists(#userId) AND (attribute_not_exists(#lastBonusDate) OR #lastBonusDate <> :today)',
            ExpressionAttributeNames: { '#balance': 'balance', '#lastBonusDate': 'lastBonusDate', '#userId': 'userId' },
            ExpressionAttributeValues: { ':bonus': BONUS, ':today': today },
        }));
        return true;
    } catch (err) {
        if (err && err.name === 'ConditionalCheckFailedException') return false;
        throw err;
    }
}

async function run(event, now = new Date()) {
    const today = localDate(now);
    const since = new Date(now.getTime() - ACTIVE_WINDOW_MS).toISOString();
    const userIds = await activeUserIds(since);

    let granted = 0;
    let skipped = 0;
    let notificationFailed = 0;
    const errors = [];

    for (const userId of userIds) {
        let ok;
        try {
            ok = await grantBonus(userId, today);
        } catch (err) {
            errors.push({ userId, error: err.message });
            continue;
        }
        if (!ok) {
            skipped += 1;
            continue;
        }
        granted += 1;
        try {
            await publishToUser(userId, `Recibiste tu bono diario de ${BONUS} fichas. ¡Suerte hoy!`, 'FrioMx: bono diario');
        } catch (err) {
            notificationFailed += 1;
            console.error(JSON.stringify({ msg: 'No se pudo publicar el aviso de bono', userId, error: err.message }));
        }
    }

    metrics.emit({ BonusGranted: granted, BonusSkipped: skipped, NotificationFailed: notificationFailed });

    // Con errores la invocación falla (cuenta en AWS/Lambda Errors); reintentar es seguro por la condición del día.
    if (errors.length > 0) {
        console.error(JSON.stringify({ msg: 'Errores al acreditar bonos', errors }));
        throw new Error(`No se pudo acreditar el bono a ${errors.length} jugador(es)`);
    }
    return { today, granted, skipped };
}

const handler = (event) => run(event, new Date());

module.exports = { handler, run, BONUS };
