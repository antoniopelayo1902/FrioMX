const crypto = require('crypto');
const { GetCommand, UpdateCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, cancellationCodes } = require('../lib/ddb');
const { config } = require('../config/env');
const { AppError, badRequest } = require('../lib/errors');
const { isoWeekId } = require('../lib/time');
const v = require('../lib/validate');
const engine = require('./gameEngine');
const { getUser } = require('./userService');

const T = config.tables;
const ROUND_TTL_SECONDS = 3600;

const insufficientFunds = () => new AppError(409, 'INSUFFICIENT_FUNDS', 'Fondos insuficientes');
const gameFinished = () => new AppError(409, 'GAME_FINISHED', 'La partida ya terminó');
const notFound = () => new AppError(404, 'NOT_FOUND', 'Partida no encontrada');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'La partida es de otro jugador');

// ---------- piezas de transacción ----------

function debitItem(userId, bet, nowIso) {
    return {
        Update: {
            TableName: T.users, Key: { userId },
            UpdateExpression: 'SET balance = balance - :bet, lastPlayedAt = :now',
            ConditionExpression: 'balance >= :bet',
            ExpressionAttributeValues: { ':bet': bet, ':now': nowIso },
        },
    };
}

function creditItem(userId, amount) {
    return {
        Update: {
            TableName: T.users, Key: { userId },
            UpdateExpression: 'ADD balance :amt',
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':amt': amount },
        },
    };
}

function activityItem(userId, gameId, nameGame, net, nowIso) {
    return {
        Put: {
            TableName: T.activity,
            Item: { userId, sk: `${nowIso}#${gameId}`, gameId, nameGame, BetStatus: net > 0, balance: net, dateGame: nowIso },
            ConditionExpression: 'attribute_not_exists(sk)',
        },
    };
}

function weeklyItem(weekId, user, net, countGame) {
    const expr = countGame ? 'ADD net :net, gamesPlayed :one SET #name = :name' : 'ADD net :net SET #name = :name';
    const values = { ':net': net, ':name': user.name };
    if (countGame) values[':one'] = 1;
    return {
        Update: {
            TableName: T.weeklyStats, Key: { weekId, userId: user.userId },
            UpdateExpression: expr,
            ExpressionAttributeNames: { '#name': 'name' },
            ExpressionAttributeValues: values,
        },
    };
}

// Ejecuta una transacción. `onConditionFailed[i]` decide el error si falla la condición del ítem i.
// Reintenta hasta 3 veces ante TransactionConflict.
async function runTx(items, onConditionFailed = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await ddb.send(new TransactWriteCommand({ TransactItems: items }));
            return;
        } catch (err) {
            const codes = cancellationCodes(err);
            if (!codes) throw err;
            const failed = codes.findIndex((c) => c === 'ConditionalCheckFailed');
            if (failed !== -1) {
                const make = onConditionFailed[failed];
                throw make ? make() : new AppError(409, 'CONFLICT', 'Conflicto, intenta de nuevo');
            }
            if (!codes.includes('TransactionConflict')) throw err;
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
    }
    throw new AppError(409, 'CONFLICT', 'Conflicto, intenta de nuevo');
}

async function balanceOf(userId) {
    const user = await getUser(userId);
    return user ? user.balance : 0;
}

async function getRound(gameId, userId, game) {
    v.uuidV4(gameId, game === 'hilo' ? 'roundId' : 'gameId');
    const res = await ddb.send(new GetCommand({ TableName: T.gameRounds, Key: { gameId }, ConsistentRead: true }));
    const round = res.Item;
    if (!round || round.expiresAt * 1000 < Date.now()) throw notFound();
    if (round.userId !== userId || round.game !== game) throw forbidden();
    if (round.status !== 'ACTIVE') throw gameFinished();
    return round;
}

// ---------- Hi-lo ----------

async function hiloDeal(user, body = {}, rng) {
    const bet = v.betAmount(body.betAmount);
    const roundId = crypto.randomUUID();
    const oldCard = engine.hiloDraw(rng);
    const now = new Date();
    const nowIso = now.toISOString();
    const weekId = isoWeekId(now);

    await runTx([
        debitItem(user.userId, bet, nowIso),
        {
            Put: {
                TableName: T.gameRounds,
                Item: {
                    gameId: roundId, userId: user.userId, game: 'hilo', oldCard, bet, weekId,
                    status: 'ACTIVE', createdAt: nowIso, expiresAt: Math.floor(now.getTime() / 1000) + ROUND_TTL_SECONDS,
                },
            },
        },
        weeklyItem(weekId, user, -bet, true),
    ], { 0: insufficientFunds });

    return { roundId, oldCard, newBalance: await balanceOf(user.userId) };
}

async function hiloPlay(user, body = {}, rng) {
    const round = await getRound(body.roundId, user.userId, 'hilo');
    const prediction = body.prediction;
    if (prediction !== 'higher' && prediction !== 'lower') throw badRequest('prediction debe ser "higher" o "lower"');

    const newCard = engine.hiloDraw(rng);
    const { won, payout, net } = engine.hiloResolve(round.oldCard, newCard, prediction, round.bet);
    const nowIso = new Date().toISOString();

    const items = [
        {
            Update: {
                TableName: T.gameRounds, Key: { gameId: round.gameId },
                UpdateExpression: 'SET #status = :done',
                ConditionExpression: '#status = :active AND userId = :me',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':done': 'DONE', ':active': 'ACTIVE', ':me': user.userId },
            },
        },
        activityItem(user.userId, round.gameId, 'Hi-Lo', net, nowIso),
    ];
    if (won) {
        items.push(creditItem(user.userId, payout));
        items.push(weeklyItem(round.weekId, user, payout, false));
    }
    await runTx(items, { 0: gameFinished });

    return { won, oldCard: round.oldCard, newCard, amountChange: net, newBalance: await balanceOf(user.userId) };
}

// ---------- Ruleta ----------

async function roulettePlay(user, body = {}, rng) {
    const spin = engine.rouletteSpin(body.bets, rng);
    const gameId = crypto.randomUUID();
    const now = new Date();
    const nowIso = now.toISOString();

    await runTx([
        {
            Update: {
                TableName: T.users, Key: { userId: user.userId },
                UpdateExpression: 'SET balance = balance + :net, lastPlayedAt = :now',
                ConditionExpression: 'balance >= :total',
                ExpressionAttributeValues: { ':net': spin.net, ':total': spin.total, ':now': nowIso },
            },
        },
        activityItem(user.userId, gameId, 'Ruleta', spin.net, nowIso),
        weeklyItem(isoWeekId(now), user, spin.net, true),
    ], { 0: insufficientFunds });

    return {
        winningSlot: spin.winningSlot,
        winningIndex: spin.winningIndex,
        results: spin.results,
        totalAmountChange: spin.net,
        newBalance: await balanceOf(user.userId),
    };
}

// ---------- Minas ----------

async function minesStart(user, body = {}, rng) {
    const bet = v.betAmount(body.betAmount);
    const gameId = crypto.randomUUID();
    const now = new Date();
    const nowIso = now.toISOString();
    const weekId = isoWeekId(now);

    await runTx([
        debitItem(user.userId, bet, nowIso),
        {
            Put: {
                TableName: T.gameRounds,
                Item: {
                    gameId, userId: user.userId, game: 'mines', bet, weekId,
                    mines: engine.minesPlace(rng), revealed: [], status: 'ACTIVE', version: 0,
                    createdAt: nowIso, expiresAt: Math.floor(now.getTime() / 1000) + ROUND_TTL_SECONDS,
                },
            },
        },
        // La pérdida cuenta en el ranking desde que se apuesta; abandonar no mejora la posición.
        weeklyItem(weekId, user, -bet, true),
    ], { 0: insufficientFunds });

    return {
        gameId,
        boardSize: engine.MINES_BOARD_SIZE,
        minesCount: engine.MINES_COUNT,
        newBalance: await balanceOf(user.userId),
    };
}

function roundVersionCondition(version) {
    return {
        ConditionExpression: '#version = :v AND #status = :active',
        names: { '#version': 'version', '#status': 'status' },
        values: { ':v': version, ':active': 'ACTIVE', ':one': 1 },
    };
}

async function minesReveal(user, body = {}) {
    const round = await getRound(body.gameId, user.userId, 'mines');
    const index = engine.minesIndex(body.x, body.y);
    const cell = { x: body.x, y: body.y };

    if (round.revealed.includes(index)) {
        return { result: 'safe', cell, status: round.status };
    }

    const cond = roundVersionCondition(round.version);
    const nowIso = new Date().toISOString();

    if (round.mines.includes(index)) {
        await runTx([
            {
                Update: {
                    TableName: T.gameRounds, Key: { gameId: round.gameId },
                    UpdateExpression: 'SET #status = :lost, #version = #version + :one',
                    ConditionExpression: cond.ConditionExpression,
                    ExpressionAttributeNames: cond.names,
                    ExpressionAttributeValues: { ...cond.values, ':lost': 'LOST' },
                },
            },
            activityItem(user.userId, round.gameId, 'Mines', -round.bet, nowIso),
        ], { 0: () => new AppError(409, 'CONFLICT', 'Conflicto, repite el destape') });

        return {
            result: 'mine', cell, status: 'LOST',
            mines: engine.minesToCells(round.mines), newBalance: await balanceOf(user.userId),
        };
    }

    const revealed = [...round.revealed, index];

    if (revealed.length === engine.MINES_SAFE_CELLS) {
        await runTx([
            {
                Update: {
                    TableName: T.gameRounds, Key: { gameId: round.gameId },
                    UpdateExpression: 'SET #status = :won, revealed = :r, #version = #version + :one',
                    ConditionExpression: cond.ConditionExpression,
                    ExpressionAttributeNames: cond.names,
                    ExpressionAttributeValues: { ...cond.values, ':won': 'WON', ':r': revealed },
                },
            },
            creditItem(user.userId, 3 * round.bet),
            activityItem(user.userId, round.gameId, 'Mines', 2 * round.bet, nowIso),
            // Sobre el -bet de start deja +2 x apuesta en la semana en que empezó la partida.
            weeklyItem(round.weekId, user, 3 * round.bet, false),
        ], { 0: () => new AppError(409, 'CONFLICT', 'Conflicto, repite el destape') });

        return {
            result: 'safe', cell, status: 'WON',
            mines: engine.minesToCells(round.mines), newBalance: await balanceOf(user.userId),
        };
    }

    try {
        await ddb.send(new UpdateCommand({
            TableName: T.gameRounds, Key: { gameId: round.gameId },
            UpdateExpression: 'SET revealed = :r, #version = #version + :one',
            ConditionExpression: cond.ConditionExpression,
            ExpressionAttributeNames: cond.names,
            ExpressionAttributeValues: { ...cond.values, ':r': revealed },
        }));
    } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
            throw new AppError(409, 'CONFLICT', 'Conflicto, repite el destape');
        }
        throw err;
    }

    return { result: 'safe', cell, status: 'ACTIVE' };
}

module.exports = { hiloDeal, hiloPlay, roulettePlay, minesStart, minesReveal, runTx };
