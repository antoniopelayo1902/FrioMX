// friomx-weekly-ranking: cierra la semana anterior y paga a los 3 primeros (LLD §6.3).
const { QueryCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, cancellationCodes } = require('../shared/ddb');
const { publishToUser } = require('../shared/sns');
const { isoWeekId, previousWeekId, isValidWeekId } = require('../shared/time');
const metrics = require('../shared/metrics');

const PRIZES = [1000, 500, 250];
const MAX_CONFLICT_RETRIES = 3;

// Semana a cerrar: la del evento (si es pasada) o la anterior a la semana local en curso.
function resolveWeekId(event, now) {
    const current = isoWeekId(now);
    if (event && event.weekId !== undefined) {
        if (!isValidWeekId(event.weekId)) throw new Error(`weekId inválido: ${event.weekId}`);
        if (event.weekId >= current) {
            throw new Error(`Solo se pueden cerrar semanas pasadas (${event.weekId} >= ${current})`);
        }
        return event.weekId;
    }
    return previousWeekId(now);
}

async function weekStats(weekId) {
    const rows = [];
    let ExclusiveStartKey;
    do {
        const page = await ddb.send(new QueryCommand({
            TableName: process.env.TABLE_WEEKLY_STATS,
            KeyConditionExpression: '#weekId = :weekId',
            ExpressionAttributeNames: { '#weekId': 'weekId' },
            ExpressionAttributeValues: { ':weekId': weekId },
            ExclusiveStartKey,
        }));
        rows.push(...(page.Items || []));
        ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return rows;
}

// Orden: net desc, gamesPlayed desc, userId asc. Solo cuentan los net > 0.
function rankCandidates(rows) {
    return rows
        .map((r) => ({ userId: r.userId, name: r.name || 'Jugador', net: Number(r.net) || 0, gamesPlayed: Number(r.gamesPlayed) || 0 }))
        .filter((r) => r.net > 0)
        .sort((a, b) => (b.net - a.net) || (b.gamesPlayed - a.gamesPlayed) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

function buildTop(candidates) {
    return candidates.slice(0, PRIZES.length).map((c, i) => ({
        rank: i + 1, userId: c.userId, name: c.name, net: c.net, prize: PRIZES[i],
    }));
}

function closeTransaction(weekId, top, closedAt) {
    return new TransactWriteCommand({
        TransactItems: [
            {
                Put: {
                    TableName: process.env.TABLE_LEADERBOARD,
                    Item: { weekId, top, closedAt },
                    ConditionExpression: 'attribute_not_exists(#weekId)',
                    ExpressionAttributeNames: { '#weekId': 'weekId' },
                },
            },
            ...top.map((w) => ({
                Update: {
                    TableName: process.env.TABLE_USERS,
                    Key: { userId: w.userId },
                    UpdateExpression: 'ADD #balance :prize',
                    ConditionExpression: 'attribute_exists(#userId)',
                    ExpressionAttributeNames: { '#balance': 'balance', '#userId': 'userId' },
                    ExpressionAttributeValues: { ':prize': w.prize },
                },
            })),
        ],
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(event, now = new Date()) {
    const weekId = resolveWeekId(event, now);
    let candidates = rankCandidates(await weekStats(weekId));
    let conflicts = 0;
    let top;

    for (;;) {
        top = buildTop(candidates);
        try {
            await ddb.send(closeTransaction(weekId, top, now.toISOString()));
            break;
        } catch (err) {
            const codes = cancellationCodes(err);
            if (!codes) throw err;
            if (codes[0] === 'ConditionalCheckFailed') {
                console.log(JSON.stringify({ msg: 'La semana ya estaba cerrada', weekId }));
                return { weekId, status: 'ALREADY_CLOSED' };
            }
            const missing = new Set(top.filter((_, i) => codes[i + 1] === 'ConditionalCheckFailed').map((w) => w.userId));
            if (missing.size > 0) {
                // Cuenta inexistente: se quita del ranking y se vuelve a armar el top.
                console.log(JSON.stringify({ msg: 'Ganador sin cuenta, se quita del top', weekId, userIds: [...missing] }));
                candidates = candidates.filter((c) => !missing.has(c.userId));
                continue;
            }
            if (codes.includes('TransactionConflict') && conflicts < MAX_CONFLICT_RETRIES) {
                conflicts += 1;
                await sleep(50 * conflicts);
                continue;
            }
            throw err;
        }
    }

    let notificationFailed = 0;
    for (const w of top) {
        try {
            await publishToUser(
                w.userId,
                `Quedaste en el lugar ${w.rank} de la semana ${weekId} con ${w.net} fichas netas y ganaste ${w.prize} fichas.`,
                'FrioMx: premio semanal',
            );
        } catch (err) {
            notificationFailed += 1;
            console.error(JSON.stringify({ msg: 'No se pudo publicar el aviso de premio', userId: w.userId, error: err.message }));
        }
    }
    if (notificationFailed > 0) metrics.emit({ NotificationFailed: notificationFailed });

    console.log(JSON.stringify({ msg: 'Semana cerrada', weekId, winners: top.length }));
    return { weekId, status: 'CLOSED', top };
}

const handler = (event) => run(event, new Date());

module.exports = { handler, run, resolveWeekId, rankCandidates, buildTop, PRIZES };
