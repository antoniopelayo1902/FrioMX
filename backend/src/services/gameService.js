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

const GAMES = {
    hilo: { label: 'Hi-Lo', idAttr: 'activeHiloId', expAttr: 'activeHiloExp' },
    mines: { label: 'Minas', idAttr: 'activeMinesId', expAttr: 'activeMinesExp' },
};

const insufficientFunds = () => new AppError(409, 'INSUFFICIENT_FUNDS', 'No tienes fichas suficientes para esa apuesta');
const gameFinished = () => new AppError(409, 'GAME_FINISHED', 'La partida ya terminó');
const notFound = () => new AppError(404, 'NOT_FOUND', 'Partida no encontrada o expirada');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'La partida es de otro jugador');
const conflict = () => new AppError(409, 'CONFLICT', 'Otra acción llegó al mismo tiempo, intenta de nuevo');

const nowSeconds = () => Math.floor(Date.now() / 1000);

function resultOf(net) {
    return net > 0 ? 'GANADA' : net < 0 ? 'PERDIDA' : 'IGUAL';
}

const CARD = (n) => ({ 11: 'J', 12: 'Q' }[n] || String(n));
const DOZEN = { 1: '1–12', 2: '13–24', 3: '25–36' };
function slotText(slot) {
    return [slot.label, slot.color, slot.parity === 'par' ? 'Par' : slot.parity === 'impar' ? 'Impar' : null, slot.dozen ? DOZEN[slot.dozen] : null]
        .filter(Boolean).join(' · ');
}

// ---------- piezas de transacción ----------

function activityPut(userId, sk, { gameId, nameGame, bet, net, result, dateGame, detail }, onlyNew) {
    const put = {
        TableName: T.activity,
        Item: { userId, sk, gameId, nameGame, bet, balance: net, result, BetStatus: result === 'GANADA', dateGame, detail },
    };
    if (onlyNew) put.ConditionExpression = 'attribute_not_exists(sk)';
    return { Put: put };
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
                throw make ? await make() : conflict();
            }
            if (!codes.includes('TransactionConflict')) throw err;
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
    }
    throw conflict();
}

async function balanceOf(userId) {
    const user = await getUser(userId);
    return user ? user.balance : 0;
}

async function readRound(gameId) {
    const res = await ddb.send(new GetCommand({ TableName: T.gameRounds, Key: { gameId }, ConsistentRead: true }));
    return res.Item || null;
}

async function getRound(gameId, userId, game) {
    v.uuidV4(gameId, game === 'hilo' ? 'roundId' : 'gameId');
    const round = await readRound(gameId);
    if (!round || round.expiresAt < nowSeconds()) throw notFound();
    if (round.userId !== userId) throw forbidden();
    if (round.game !== game) throw notFound();
    if (round.status !== 'ACTIVE') throw gameFinished();
    return round;
}

// ---------- rondas con estado (hi-lo y minas) ----------
// El usuario guarda un puntero a su ronda activa de cada juego: al recargar la página se retoma,
// y no se puede abrir otra ronda del mismo juego mientras haya una viva.

async function startRound(user, game, bet, extra) {
    const g = GAMES[game];
    const gameId = crypto.randomUUID();
    const now = new Date();
    const nowIso = now.toISOString();
    const exp = Math.floor(now.getTime() / 1000) + ROUND_TTL_SECONDS;
    const weekId = isoWeekId(now);
    const activitySk = `${nowIso}#${gameId}`;

    // La condición del usuario falló: se averigua la causa real en vez de suponer falta de fondos.
    const whyFailed = async () => {
        const fresh = await getUser(user.userId);
        if (fresh && fresh[g.idAttr] && fresh[g.expAttr] >= nowSeconds()) {
            const live = await activeRound(fresh, game);
            if (live) {
                const err = new AppError(409, 'ROUND_ACTIVE', 'Ya tienes una partida en curso');
                err.extra = { gameId: live.gameId };
                return err;
            }
            // El puntero apunta a una ronda que ya terminó o venció: se libera y se reintenta.
            await clearPointer(user.userId, g, fresh[g.idAttr]);
            return retry;
        }
        if (fresh && fresh.balance < bet) return insufficientFunds();
        return conflict();
    };
    const retry = new AppError(409, 'RETRY', 'retry');

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await openTx();
            return gameId;
        } catch (err) {
            if (err !== retry) throw err;
        }
    }
    throw conflict();

    async function openTx() {
    await runTx([
        {
            Update: {
                TableName: T.users, Key: { userId: user.userId },
                UpdateExpression: 'SET balance = balance - :bet, lastPlayedAt = :now, #aid = :id, #aexp = :exp',
                ConditionExpression: 'balance >= :bet AND (attribute_not_exists(#aid) OR #aexp < :nowSec)',
                ExpressionAttributeNames: { '#aid': g.idAttr, '#aexp': g.expAttr },
                ExpressionAttributeValues: { ':bet': bet, ':now': nowIso, ':id': gameId, ':exp': exp, ':nowSec': nowSeconds() },
            },
        },
        {
            Put: {
                TableName: T.gameRounds,
                Item: {
                    gameId, userId: user.userId, game, bet, weekId, activitySk,
                    status: 'ACTIVE', version: 0, createdAt: nowIso, expiresAt: exp, ...extra,
                },
            },
        },
        // La apuesta cuenta como perdida desde que se hace: si la ronda se abandona, el historial lo explica.
        activityPut(user.userId, activitySk, { gameId, nameGame: g.label, bet, net: -bet, result: 'EN_CURSO', dateGame: nowIso }, true),
        // La pérdida cuenta en el ranking desde que se apuesta; abandonar no mejora la posición.
        weeklyItem(weekId, user, -bet, true),
    ], { 0: whyFailed });
    }
}

// Quita el puntero solo si sigue apuntando a esa ronda (nunca borra el de una ronda más nueva).
async function clearPointer(userId, g, gameId) {
    try {
        await ddb.send(new UpdateCommand({
            TableName: T.users, Key: { userId },
            UpdateExpression: 'REMOVE #aid, #aexp',
            ConditionExpression: '#aid = :gid',
            ExpressionAttributeNames: { '#aid': g.idAttr, '#aexp': g.expAttr },
            ExpressionAttributeValues: { ':gid': gameId },
        }));
    } catch (err) {
        if (err.name !== 'ConditionalCheckFailedException') throw err;
    }
}

// Cierra la ronda: cambia su estado, acredita el pago, libera el puntero y deja el resultado en el historial.
async function finishRound(user, round, { status, payout, setRound = {}, detail }) {
    const g = GAMES[round.game];
    const net = payout - round.bet;
    const names = { '#status': 'status', '#version': 'version' };
    const values = { ':st': status, ':active': 'ACTIVE', ':v': round.version, ':one': 1, ':now': nowSeconds() };
    let setExpr = 'SET #status = :st, #version = #version + :one';
    Object.entries(setRound).forEach(([key, value], i) => {
        names[`#f${i}`] = key;
        values[`:f${i}`] = value;
        setExpr += `, #f${i} = :f${i}`;
    });

    await runTx([
        {
            Update: {
                TableName: T.gameRounds, Key: { gameId: round.gameId },
                UpdateExpression: setExpr,
                ConditionExpression: '#status = :active AND #version = :v AND expiresAt >= :now',
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
            },
        },
        {
            Update: {
                TableName: T.users, Key: { userId: user.userId },
                UpdateExpression: 'ADD balance :p',
                ConditionExpression: 'attribute_exists(userId)',
                ExpressionAttributeValues: { ':p': payout },
            },
        },
        activityPut(user.userId, round.activitySk, {
            gameId: round.gameId, nameGame: g.label, bet: round.bet, net,
            result: status === 'LOST' ? 'PERDIDA' : resultOf(net), dateGame: round.createdAt, detail,
        }, false),
        ...(payout > 0 ? [weeklyItem(round.weekId, user, payout, false)] : []),
    ], { 0: async () => {
        const fresh = await readRound(round.gameId);
        if (fresh && fresh.status !== 'ACTIVE') return gameFinished();
        if (fresh && fresh.expiresAt < nowSeconds()) return notFound();
        return conflict();
    } });
    await clearPointer(user.userId, g, round.gameId);
    return net;
}

async function activeRound(user, game) {
    const g = GAMES[game];
    if (!user[g.idAttr] || user[g.expAttr] < nowSeconds()) return null;
    const round = await readRound(user[g.idAttr]);
    if (!round || round.status !== 'ACTIVE' || round.expiresAt < nowSeconds() || round.userId !== user.userId) return null;
    return round;
}

// ---------- Hi-lo ----------

function hiloView(round) {
    return { roundId: round.gameId, oldCard: round.oldCard, bet: round.bet, options: engine.hiloMultipliers(round.oldCard, round.bet) };
}

async function hiloDeal(user, body = {}, rng) {
    const bet = v.betAmount(body.betAmount);
    const oldCard = engine.hiloDrawVisible(rng);
    const roundId = await startRound(user, 'hilo', bet, { oldCard });
    return { ...hiloView({ gameId: roundId, oldCard, bet }), newBalance: await balanceOf(user.userId) };
}

async function hiloActive(user) {
    const round = await activeRound(user, 'hilo');
    return { round: round ? hiloView(round) : null };
}

async function hiloPlay(user, body = {}, rng) {
    const round = await getRound(body.roundId, user.userId, 'hilo');
    const prediction = body.prediction;
    if (prediction !== 'higher' && prediction !== 'lower') throw badRequest('prediction debe ser "higher" o "lower"');
    const newCard = engine.hiloDraw(rng);
    const { won, payout } = engine.hiloResolve(round.oldCard, newCard, prediction, round.bet);
    const detail = `${CARD(round.oldCard)} → ${CARD(newCard)} · elegiste ${prediction === 'higher' ? 'Mayor' : 'Menor'}`;
    const net = await finishRound(user, round, { status: won ? 'WON' : 'LOST', payout, setRound: { newCard, prediction }, detail });
    return {
        won, tie: newCard === round.oldCard, oldCard: round.oldCard, newCard, prediction,
        bet: round.bet, payout, amountChange: net, newBalance: await balanceOf(user.userId),
    };
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
        activityPut(user.userId, `${nowIso}#${gameId}`, {
            gameId, nameGame: 'Ruleta', bet: spin.total, net: spin.net, result: resultOf(spin.net), dateGame: nowIso,
            detail: `Cayó ${slotText(spin.winningSlot)}`,
        }, true),
        weeklyItem(isoWeekId(now), user, spin.net, true),
    ], { 0: insufficientFunds });
    return {
        winningSlot: spin.winningSlot,
        winningIndex: spin.winningIndex,
        results: spin.results,
        totalBet: spin.total,
        totalAmountChange: spin.net,
        newBalance: await balanceOf(user.userId),
    };
}

// ---------- Minas ----------

function minesView(round) {
    const safe = round.revealed.length;
    // El pago tiene tope: el multiplicador anunciado nunca promete más de lo que se paga.
    const cap = engine.MINES_MAX_PAYOUT / round.bet;
    const capped = (m) => (m === null ? null : Math.min(m, Math.floor(cap * 100) / 100));
    return {
        gameId: round.gameId,
        bet: round.bet,
        boardSize: engine.MINES_BOARD_SIZE,
        minesCount: engine.MINES_COUNT,
        revealed: engine.minesToCells(round.revealed),
        safeCount: safe,
        multiplier: capped(engine.minesMultiplier(safe)),
        nextMultiplier: safe < engine.MINES_SAFE_CELLS ? capped(engine.minesMultiplier(safe + 1)) : null,
        // Pagos exactos en fichas: lo que se cobra ahora y lo que se cobraría con una casilla segura más.
        cashoutAmount: safe > 0 ? engine.minesPayout(round.bet, safe) : 0,
        nextCashoutAmount: safe < engine.MINES_SAFE_CELLS ? engine.minesPayout(round.bet, safe + 1) : null,
        maxPayout: engine.MINES_MAX_PAYOUT,
        atCap: engine.minesMultiplier(safe) >= cap,
    };
}

async function minesStart(user, body = {}, rng) {
    const bet = v.betAmount(body.betAmount);
    const mines = engine.minesPlace(rng);
    const gameId = await startRound(user, 'mines', bet, { mines, revealed: [] });
    return { ...minesView({ gameId, bet, revealed: [] }), newBalance: await balanceOf(user.userId) };
}

async function minesActive(user) {
    const round = await activeRound(user, 'mines');
    return { round: round ? minesView(round) : null };
}

async function minesReveal(user, body = {}, rng) {
    const round = await getRound(body.gameId, user.userId, 'mines');
    const index = engine.minesIndex(body.x, body.y);
    const cell = { x: body.x, y: body.y };

    if (round.revealed.includes(index)) {
        return { result: 'safe', cell, status: 'ACTIVE', ...minesView(round) };
    }

    if (round.mines.includes(index)) {
        const n = round.revealed.length;
        await finishRound(user, round, {
            status: 'LOST', payout: 0, setRound: { hit: index },
            detail: n === 0 ? 'Pisaste una mina en la primera casilla' : `Pisaste una mina tras ${n} ${n === 1 ? 'casilla segura' : 'casillas seguras'}`,
        });
        return {
            result: 'mine', cell, status: 'LOST', ...minesView(round),
            mines: engine.minesToCells(round.mines), amountChange: -round.bet, newBalance: await balanceOf(user.userId),
        };
    }

    const revealed = [...round.revealed, index];
    if (revealed.length === engine.MINES_SAFE_CELLS) {
        const payout = engine.minesPayout(round.bet, revealed.length);
        const net = await finishRound(user, round, { status: 'WON', payout, setRound: { revealed }, detail: 'Destapaste las 20 casillas seguras' });
        return {
            result: 'safe', cell, status: 'WON', ...minesView({ ...round, revealed }), payout,
            mines: engine.minesToCells(round.mines), amountChange: net, newBalance: await balanceOf(user.userId),
        };
    }

    try {
        await ddb.send(new UpdateCommand({
            TableName: T.gameRounds, Key: { gameId: round.gameId },
            UpdateExpression: 'SET revealed = :r, #version = #version + :one',
            ConditionExpression: '#version = :v AND #status = :active',
            ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
            ExpressionAttributeValues: { ':v': round.version, ':active': 'ACTIVE', ':one': 1, ':r': revealed },
        }));
    } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') throw conflict();
        throw err;
    }
    return { result: 'safe', cell, status: 'ACTIVE', ...minesView({ ...round, revealed }) };
}

async function minesCashout(user, body = {}, rng) {
    const round = await getRound(body.gameId, user.userId, 'mines');
    if (round.revealed.length === 0) throw badRequest('Destapa al menos una casilla antes de cobrar');
    const n = round.revealed.length;
    const payout = engine.minesPayout(round.bet, n);
    const net = await finishRound(user, round, {
        status: 'CASHED', payout, detail: `Cobraste tras ${n} ${n === 1 ? 'casilla segura' : 'casillas seguras'}`,
    });
    return {
        status: 'CASHED', ...minesView(round), payout, amountChange: net,
        mines: engine.minesToCells(round.mines), newBalance: await balanceOf(user.userId),
    };
}

module.exports = {
    hiloDeal, hiloActive, hiloPlay, roulettePlay, minesStart, minesActive, minesReveal, minesCashout, runTx,
};
