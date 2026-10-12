const { GetCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const { ddb, cancellationCodes } = require('../lib/ddb');
const aws = require('../lib/aws');
const { config } = require('../config/env');
const { AppError, badRequest } = require('../lib/errors');
const { localDate } = require('../lib/time');
const { uuidv5 } = require('../lib/uuid');
const v = require('../lib/validate');

const PACKAGES = [
    { packageId: 'p500', chips: 500 },
    { packageId: 'p1000', chips: 1000 },
    { packageId: 'p2500', chips: 2500 },
];
const PACKAGE_BY_ID = new Map(PACKAGES.map((p) => [p.packageId, p]));
const MAX_PER_DAY = 3;
// Una recarga que sigue PENDING después de esto se muestra como FAILED (no se guarda).
const FAILED_AFTER_MS = 5 * 60 * 1000;

const queueUnavailable = () => new AppError(503, 'QUEUE_UNAVAILABLE', 'No se pudo procesar la recarga, intenta de nuevo');
const dailyLimit = () => new AppError(429, 'DAILY_LIMIT', `Solo puedes hacer ${MAX_PER_DAY} recargas por día`);
const conflict = () => new AppError(409, 'CONFLICT', 'Otra acción llegó al mismo tiempo, intenta de nuevo');

function listPackages() {
    return PACKAGES.map((p) => ({ ...p }));
}

function statusOf(recharge, now = Date.now()) {
    if (recharge.status === 'COMPLETED') return 'COMPLETED';
    if (now - Date.parse(recharge.createdAt) > FAILED_AFTER_MS) return 'FAILED';
    return 'PENDING';
}

function rechargeIdFor(userId, idempotencyKey) {
    return uuidv5(`${userId}:${idempotencyKey.toLowerCase()}`);
}

async function readRecharge(rechargeId) {
    const res = await ddb.send(new GetCommand({ TableName: config.tables.recharges, Key: { rechargeId }, ConsistentRead: true }));
    return res.Item || null;
}

async function enqueue(rechargeId) {
    try {
        await aws.sqs().send(new SendMessageCommand({
            QueueUrl: config.rechargeQueueUrl,
            MessageBody: JSON.stringify({ rechargeId }),
        }));
    } catch (err) {
        console.error('No se pudo encolar la recarga', rechargeId, err.name, err.message);
        throw queueUnavailable();
    }
}

// Recarga que ya existe: un reintento con la misma clave nunca cobra otro cupo del día.
async function answerExisting(userId, recharge) {
    if (recharge.userId !== userId) throw new AppError(403, 'FORBIDDEN', 'La recarga es de otro jugador');
    // El consumidor es idempotente: volver a encolar una PENDING solo la destraba si el mensaje se perdió.
    if (recharge.status === 'PENDING') await enqueue(recharge.rechargeId);
    return { rechargeId: recharge.rechargeId, status: statusOf(recharge) };
}

function counterUpdate(userId, variant, today) {
    const base = { TableName: config.tables.users, Key: { userId } };
    if (variant === 'A') {
        // Mismo día y con cupo: suma uno.
        return {
            Update: {
                ...base,
                UpdateExpression: 'ADD rechargeCount :one',
                ConditionExpression: 'rechargeDate = :today AND rechargeCount < :max',
                ExpressionAttributeValues: { ':one': 1, ':today': today, ':max': MAX_PER_DAY },
            },
        };
    }
    // Primer uso del día: reinicia el contador.
    return {
        Update: {
            ...base,
            UpdateExpression: 'SET rechargeDate = :today, rechargeCount = :one',
            ConditionExpression: 'attribute_exists(userId) AND (attribute_not_exists(rechargeDate) OR rechargeDate <> :today)',
            ExpressionAttributeValues: { ':one': 1, ':today': today },
        },
    };
}

async function createRecharge(user, body = {}, idempotencyKey) {
    const key = v.uuidV4(idempotencyKey, 'Idempotency-Key');
    const pkg = typeof body.packageId === 'string' ? PACKAGE_BY_ID.get(body.packageId) : undefined;
    if (!pkg) throw badRequest('packageId inválido');
    // Sin cola no hay quién acredite las fichas: no se crea nada ni se gasta el cupo.
    if (!config.rechargeQueueUrl) throw queueUnavailable();

    const userId = user.userId;
    const rechargeId = rechargeIdFor(userId, key);
    const existing = await readRecharge(rechargeId);
    if (existing) return answerExisting(userId, existing);

    const now = new Date();
    const today = localDate(now);
    const recharge = { rechargeId, userId, packageId: pkg.packageId, chips: pkg.chips, status: 'PENDING', createdAt: now.toISOString() };

    let variant = 'A';
    let triedB = false;
    let conflicts = 0;
    for (;;) {
        try {
            await ddb.send(new TransactWriteCommand({
                TransactItems: [
                    counterUpdate(userId, variant, today),
                    {
                        Put: {
                            TableName: config.tables.recharges, Item: recharge,
                            ConditionExpression: 'attribute_not_exists(rechargeId)',
                        },
                    },
                ],
            }));
            break;
        } catch (err) {
            const codes = cancellationCodes(err);
            if (!codes) throw err;
            // Se revisa primero el ítem 2: otra petición con la misma clave ya la creó.
            if (codes[1] === 'ConditionalCheckFailed') {
                const again = await readRecharge(rechargeId);
                if (again) return answerExisting(userId, again);
                throw conflict();
            }
            if (codes[0] === 'ConditionalCheckFailed') {
                if (variant === 'A' && !triedB) { variant = 'B'; triedB = true; continue; }
                // B falló porque el día ya estaba abierto (quizá por otra recarga simultánea): A una vez más.
                if (variant === 'B') { variant = 'A'; continue; }
                throw dailyLimit();
            }
            if (!codes.includes('TransactionConflict')) throw err;
            conflicts += 1;
            if (conflicts > 3) throw conflict();
            await new Promise((r) => setTimeout(r, 50 * conflicts));
        }
    }

    await enqueue(rechargeId);
    return { rechargeId, status: 'PENDING' };
}

async function getRecharge(user, rechargeId) {
    const id = v.uuidV5(rechargeId, 'rechargeId');
    const recharge = await readRecharge(id);
    if (!recharge) throw new AppError(404, 'NOT_FOUND', 'Recarga no encontrada');
    if (recharge.userId !== user.userId) throw new AppError(403, 'FORBIDDEN', 'La recarga es de otro jugador');
    return {
        rechargeId: recharge.rechargeId,
        status: statusOf(recharge),
        chips: recharge.chips,
        createdAt: recharge.createdAt,
        completedAt: recharge.completedAt || null,
    };
}

module.exports = {
    listPackages, createRecharge, getRecharge, statusOf, rechargeIdFor, PACKAGES, MAX_PER_DAY, FAILED_AFTER_MS,
};
