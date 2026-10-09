const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../lib/ddb');
const { config } = require('../config/env');
const { badRequest } = require('../lib/errors');

const ROUND_TTL_MS = 3600 * 1000;
const SK_FORMAT = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z#[0-9a-f-]{36}$/i;

function encodeCursor(key) {
    return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(cursor, userId) {
    let key;
    try {
        key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
        throw badRequest('Cursor inválido');
    }
    const keys = key && typeof key === 'object' ? Object.keys(key).sort() : [];
    if (keys.join(',') !== 'sk,userId' || key.userId !== userId || typeof key.sk !== 'string' || !SK_FORMAT.test(key.sk)) {
        throw badRequest('Cursor inválido');
    }
    return key;
}

async function listActivity(userId, { limit, cursor } = {}) {
    let size = limit === undefined ? 20 : Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 50) throw badRequest('limit debe ser un entero de 1 a 50');

    const params = {
        TableName: config.tables.activity,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ScanIndexForward: false,
        // Se pide una fila de más para saber si hay otra página sin regresar una página vacía.
        Limit: size + 1,
    };
    if (cursor) params.ExclusiveStartKey = decodeCursor(String(cursor), userId);

    const res = await ddb.send(new QueryCommand(params));
    const rows = res.Items || [];
    const page = rows.slice(0, size);
    // Una ronda que sigue EN_CURSO después de su hora de vida se abandonó: la apuesta ya se perdió.
    const staleBefore = Date.now() - ROUND_TTL_MS;
    const items = page.map((a) => {
        let result = a.result || (a.BetStatus ? 'GANADA' : 'PERDIDA');
        if (result === 'EN_CURSO' && Date.parse(a.dateGame) < staleBefore) result = 'ABANDONADA';
        return { nameGame: a.nameGame, BetStatus: a.BetStatus, balance: a.balance, dateGame: a.dateGame, bet: a.bet, result, detail: a.detail || null };
    });
    const last = page[page.length - 1];
    const more = rows.length > size;
    return { items, nextCursor: more && last ? encodeCursor({ userId: last.userId, sk: last.sk }) : null };
}

module.exports = { listActivity, encodeCursor, decodeCursor };
