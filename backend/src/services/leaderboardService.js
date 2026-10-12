const { GetCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../lib/ddb');
const { config } = require('../config/env');
const { AppError, badRequest } = require('../lib/errors');
const { isoWeekId } = require('../lib/time');

const TOP_SIZE = 10;
const WEEK_ID = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const WEEK_MS = 7 * 24 * 3600 * 1000;

// Mismo orden que la Lambda de cierre: neto, luego partidas, luego userId para desempatar siempre igual.
function byRank(a, b) {
    return (b.net - a.net) || ((b.gamesPlayed || 0) - (a.gamesPlayed || 0)) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
}

async function weekRows(weekId) {
    const rows = [];
    let start;
    do {
        const res = await ddb.send(new QueryCommand({
            TableName: config.tables.weeklyStats,
            KeyConditionExpression: 'weekId = :w',
            ExpressionAttributeValues: { ':w': weekId },
            ExclusiveStartKey: start,
        }));
        rows.push(...(res.Items || []));
        start = res.LastEvaluatedKey;
    } while (start);
    return rows;
}

async function current(user, now = new Date()) {
    const weekId = isoWeekId(now);
    const rows = (await weekRows(weekId)).sort(byRank);
    const top = rows.slice(0, TOP_SIZE).map((r, i) => ({ rank: i + 1, name: r.name, net: r.net }));
    const idx = rows.findIndex((r) => r.userId === user.userId);
    const mine = idx === -1 ? null : rows[idx];
    return {
        weekId,
        top,
        me: { rank: mine ? idx + 1 : null, net: mine ? mine.net : 0, gamesPlayed: mine ? (mine.gamesPlayed || 0) : 0 },
    };
}

async function last(query = {}, now = new Date()) {
    const thisWeek = isoWeekId(now);
    let weekId = query.weekId;
    let res;
    if (weekId === undefined || weekId === '') {
        // Sin weekId: la semana anterior; si aún no se cierra (lunes temprano), la más reciente cerrada.
        weekId = isoWeekId(new Date(now.getTime() - WEEK_MS));
        res = await ddb.send(new GetCommand({ TableName: config.tables.leaderboard, Key: { weekId } }));
        if (!res.Item) {
            const latest = (await weeks()).find((w) => w < thisWeek);
            if (latest && latest !== weekId) {
                weekId = latest;
                res = await ddb.send(new GetCommand({ TableName: config.tables.leaderboard, Key: { weekId } }));
            }
        }
    } else if (typeof weekId !== 'string' || !WEEK_ID.test(weekId)) {
        throw badRequest('weekId debe tener el formato AAAA-Wss');
    } else if (weekId >= thisWeek) {
        throw badRequest('Solo se pueden consultar semanas pasadas');
    }
    if (!res) res = await ddb.send(new GetCommand({ TableName: config.tables.leaderboard, Key: { weekId } }));
    if (!res.Item) throw new AppError(404, 'NOT_FOUND', 'Esa semana no tiene ranking cerrado');
    const top = (res.Item.top || []).map((r) => ({ rank: r.rank, name: r.name, net: r.net, prize: r.prize }));
    return { weekId, top };
}

async function weeks() {
    const ids = [];
    let start;
    do {
        const res = await ddb.send(new ScanCommand({
            TableName: config.tables.leaderboard,
            ProjectionExpression: '#w',
            ExpressionAttributeNames: { '#w': 'weekId' },
            ExclusiveStartKey: start,
        }));
        ids.push(...(res.Items || []).map((i) => i.weekId));
        start = res.LastEvaluatedKey;
    } while (start);
    // El formato AAAA-Wss ordena bien como texto.
    return ids.sort().reverse();
}

module.exports = { current, last, weeks, byRank };
