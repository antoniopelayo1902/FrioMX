const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../lib/ddb');
const { config } = require('../config/env');
const { badRequest } = require('../lib/errors');

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
        Limit: size,
    };
    if (cursor) params.ExclusiveStartKey = decodeCursor(String(cursor), userId);

    const res = await ddb.send(new QueryCommand(params));
    const items = (res.Items || []).map((a) => ({
        nameGame: a.nameGame, BetStatus: a.BetStatus, balance: a.balance, dateGame: a.dateGame,
    }));
    return { items, nextCursor: res.LastEvaluatedKey ? encodeCursor(res.LastEvaluatedKey) : null };
}

module.exports = { listActivity, encodeCursor, decodeCursor };
