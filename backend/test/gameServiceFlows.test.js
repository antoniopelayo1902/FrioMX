// Caminos de error, reintentos y condiciones de gameService con el motor y las validaciones reales.
// Solo se simulan DynamoDB, la lectura del usuario y las métricas.
const { GetCommand, UpdateCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../src/lib/ddb');
const userService = require('../src/services/userService');
const metrics = require('../src/services/metrics');
const engine = require('../src/services/gameEngine');
const gameService = require('../src/services/gameService');

jest.mock('../src/lib/ddb', () => ({
    ...jest.requireActual('../src/lib/ddb'),
    ddb: { send: jest.fn() },
}));
jest.mock('../src/services/userService', () => ({ getUser: jest.fn() }));
jest.mock('../src/services/metrics', () => ({ countGame: jest.fn() }));

const GAME_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const OTHER_ID = '7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d';
const USER = { userId: 'u-1', name: 'Ana', balance: 500 };
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

const canceled = (...codes) => Object.assign(new Error('cancelada'), {
    name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })),
});
const named = (name) => Object.assign(new Error(name), { name });

const round = (over = {}) => ({
    gameId: GAME_ID, userId: 'u-1', status: 'ACTIVE', expiresAt: FUTURE, bet: 100, version: 0,
    weekId: '2026-W42', activitySk: '2026-10-14T00:00:00.000Z#x', createdAt: '2026-10-14T00:00:00.000Z', ...over,
});
const minesRound = (over = {}) => round({ game: 'mines', mines: [0, 1, 2, 3, 4], revealed: [], ...over });
const hiloRound = (over = {}) => round({ game: 'hilo', oldCard: 7, ...over });

// Comandos que recibió ddb.send, por tipo.
const sent = (Type) => ddb.send.mock.calls.map((c) => c[0]).filter((c) => c instanceof Type);

beforeEach(() => {
    jest.clearAllMocks();
    ddb.send.mockReset();
    userService.getUser.mockResolvedValue(USER);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('runTx', () => {
    test('un error que no es de transacción se propaga', async () => {
        ddb.send.mockRejectedValue(new Error('red caída'));
        await expect(gameService.runTx([])).rejects.toThrow('red caída');
    });

    test('condición fallida sin manejador responde CONFLICT', async () => {
        ddb.send.mockRejectedValue(canceled('None', 'ConditionalCheckFailed'));
        await expect(gameService.runTx([])).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    });

    test('condición fallida usa el manejador de ese ítem', async () => {
        ddb.send.mockRejectedValue(canceled('None', 'ConditionalCheckFailed'));
        const make = jest.fn(() => new Error('a la medida'));
        await expect(gameService.runTx([], { 1: make })).rejects.toThrow('a la medida');
        expect(make).toHaveBeenCalled();
    });

    test('reintenta ante TransactionConflict y termina bien', async () => {
        ddb.send.mockRejectedValueOnce(canceled('TransactionConflict')).mockResolvedValueOnce({});
        await expect(gameService.runTx([])).resolves.toBeUndefined();
        expect(ddb.send).toHaveBeenCalledTimes(2);
    });

    test('tras 3 conflictos seguidos responde CONFLICT', async () => {
        ddb.send.mockRejectedValue(canceled('TransactionConflict'));
        await expect(gameService.runTx([])).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(ddb.send).toHaveBeenCalledTimes(3);
    });

    test('otro código de cancelación se propaga tal cual', async () => {
        const err = canceled('ValidationError');
        ddb.send.mockRejectedValue(err);
        await expect(gameService.runTx([])).rejects.toBe(err);
    });
});

describe('ruleta', () => {
    test('describe en el historial el número, color, paridad, docena y cada apuesta', async () => {
        ddb.send.mockResolvedValue({});
        const bets = [
            { type: 'color', value: 'Rojo', amount: 10 },
            { type: 'parity', value: 'impar', amount: 5 },
            { type: 'parity', value: 'par', amount: 5 },
            { type: 'dozen', value: '1', amount: 5 },
        ];
        // rng fijo: siempre el índice 1 de la rueda.
        const res = await gameService.roulettePlay(USER, { bets }, () => 1);
        const put = sent(TransactWriteCommand)[0].input.TransactItems[1].Put;
        const slot = engine.ROULETTE_WHEEL[1];
        expect(res.winningSlot).toEqual(slot);
        expect(put.Item.detail).toMatch(/^Cayó /);
        expect(put.Item.detail).toContain(slot.label);
        expect(put.Item.detail).toContain('apostaste Rojo 10, Impar 5, Par 5, 1–12 5');
        expect(put.ConditionExpression).toBe('attribute_not_exists(sk)');
        expect(metrics.countGame).toHaveBeenCalledWith('Roulette');
    });

    test('el detalle del 0 no incluye paridad ni docena', async () => {
        ddb.send.mockResolvedValue({});
        await gameService.roulettePlay(USER, { bets: [{ type: 'color', value: 'Verde', amount: 1 }] }, () => 0);
        const { detail } = sent(TransactWriteCommand)[0].input.TransactItems[1].Put.Item;
        expect(detail).toBe('Cayó 0 · Verde · apostaste Verde 1');
    });

    test('sin fondos responde INSUFFICIENT_FUNDS', async () => {
        ddb.send.mockRejectedValue(canceled('ConditionalCheckFailed', 'None', 'None'));
        await expect(gameService.roulettePlay(USER, { bets: [{ type: 'color', value: 'Rojo', amount: 10 }] }, () => 1))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    });

    test('si leer el saldo falla tras jugar, newBalance es null y no 500', async () => {
        ddb.send.mockResolvedValue({});
        userService.getUser.mockRejectedValue(named('ProvisionedThroughputExceededException'));
        const res = await gameService.roulettePlay(USER, { bets: [{ type: 'color', value: 'Rojo', amount: 10 }] }, () => 1);
        expect(res.newBalance).toBeNull();
        expect(console.warn).toHaveBeenCalled();
    });

    test('si el usuario ya no existe el saldo es 0', async () => {
        ddb.send.mockResolvedValue({});
        userService.getUser.mockResolvedValue(null);
        const res = await gameService.roulettePlay(USER, { bets: [{ type: 'color', value: 'Rojo', amount: 10 }] }, () => 1);
        expect(res.newBalance).toBe(0);
    });
});

describe('abrir ronda: por qué falló la condición del usuario', () => {
    test('con una ronda viva responde ROUND_ACTIVE con su gameId', async () => {
        ddb.send
            .mockRejectedValueOnce(canceled('ConditionalCheckFailed'))
            .mockResolvedValueOnce({ Item: hiloRound({ gameId: OTHER_ID }) });
        userService.getUser.mockResolvedValue({ ...USER, activeHiloId: OTHER_ID, activeHiloExp: FUTURE });
        await expect(gameService.hiloDeal(USER, { betAmount: 10 }, () => 5))
            .rejects.toMatchObject({ code: 'ROUND_ACTIVE', extra: { gameId: OTHER_ID } });
    });

    test('con un puntero a una ronda ya cerrada lo libera y reintenta', async () => {
        ddb.send
            .mockRejectedValueOnce(canceled('ConditionalCheckFailed')) // 1ª transacción
            .mockResolvedValueOnce({ Item: minesRound({ gameId: OTHER_ID, status: 'CASHED' }) }) // readRound
            .mockResolvedValueOnce({}) // clearPointer
            .mockResolvedValueOnce({}); // 2ª transacción
        userService.getUser.mockResolvedValue({ ...USER, activeMinesId: OTHER_ID, activeMinesExp: FUTURE });
        let next = 0;
        const res = await gameService.minesStart(USER, { betAmount: 10 }, () => next++);
        expect(res.bet).toBe(10);
        expect(sent(TransactWriteCommand)).toHaveLength(2);
        const clear = sent(UpdateCommand)[0].input;
        expect(clear.UpdateExpression).toBe('REMOVE #aid, #aexp');
        expect(clear.ExpressionAttributeValues).toEqual({ ':gid': OTHER_ID });
    });

    test('si otro ya liberó el puntero (condición fallida) igual reintenta', async () => {
        ddb.send
            .mockRejectedValueOnce(canceled('ConditionalCheckFailed'))
            .mockResolvedValueOnce({}) // readRound: la ronda ya no existe
            .mockRejectedValueOnce(named('ConditionalCheckFailedException'))
            .mockResolvedValueOnce({});
        userService.getUser.mockResolvedValue({ ...USER, activeHiloId: OTHER_ID, activeHiloExp: FUTURE });
        const res = await gameService.hiloDeal(USER, { betAmount: 10 }, () => 5);
        expect(res.oldCard).toBe(5);
    });

    test('otro error al liberar el puntero se propaga', async () => {
        ddb.send
            .mockRejectedValueOnce(canceled('ConditionalCheckFailed'))
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error('ddb caído'));
        userService.getUser.mockResolvedValue({ ...USER, activeHiloId: OTHER_ID, activeHiloExp: FUTURE });
        await expect(gameService.hiloDeal(USER, { betAmount: 10 }, () => 5)).rejects.toThrow('ddb caído');
    });

    test('si el puntero sigue estorbando tras reintentar responde CONFLICT', async () => {
        ddb.send.mockImplementation(async (cmd) => {
            if (cmd instanceof TransactWriteCommand) throw canceled('ConditionalCheckFailed');
            return {};
        });
        userService.getUser.mockResolvedValue({ ...USER, activeHiloId: OTHER_ID, activeHiloExp: FUTURE });
        await expect(gameService.hiloDeal(USER, { betAmount: 10 }, () => 5)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(sent(TransactWriteCommand)).toHaveLength(2);
    });

    test('sin puntero y sin saldo responde INSUFFICIENT_FUNDS', async () => {
        ddb.send.mockRejectedValue(canceled('ConditionalCheckFailed'));
        userService.getUser.mockResolvedValue({ ...USER, balance: 5 });
        await expect(gameService.hiloDeal(USER, { betAmount: 10 }, () => 5)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    });

    test('con un puntero vencido y saldo suficiente responde CONFLICT', async () => {
        ddb.send.mockRejectedValue(canceled('ConditionalCheckFailed'));
        userService.getUser.mockResolvedValue({ ...USER, activeHiloId: OTHER_ID, activeHiloExp: PAST });
        await expect(gameService.hiloDeal(USER, { betAmount: 10 }, () => 5)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    test('si el usuario desapareció responde CONFLICT', async () => {
        ddb.send.mockRejectedValue(canceled('ConditionalCheckFailed'));
        userService.getUser.mockResolvedValue(null);
        let next = 0;
        await expect(gameService.minesStart(USER, { betAmount: 10 }, () => next++)).rejects.toMatchObject({ code: 'CONFLICT' });
    });
});

describe('leer la ronda', () => {
    test.each([
        ['no existe', {}, 'NOT_FOUND'],
        ['venció', { Item: hiloRound({ expiresAt: PAST }) }, 'NOT_FOUND'],
        ['es de otro jugador', { Item: hiloRound({ userId: 'u-2' }) }, 'FORBIDDEN'],
        ['es de otro juego', { Item: minesRound() }, 'NOT_FOUND'],
        ['ya terminó', { Item: hiloRound({ status: 'WON' }) }, 'GAME_FINISHED'],
    ])('si la ronda %s responde %s', async (_, item, code) => {
        ddb.send.mockResolvedValueOnce(item);
        await expect(gameService.hiloPlay(USER, { roundId: GAME_ID, prediction: 'higher' }))
            .rejects.toMatchObject({ code });
    });

    test('roundId inválido responde 400 sin consultar DynamoDB', async () => {
        await expect(gameService.hiloPlay(USER, { roundId: 'abc', prediction: 'higher' }))
            .rejects.toMatchObject({ status: 400, message: 'roundId inválido' });
        await expect(gameService.minesReveal(USER, { gameId: 'abc', x: 0, y: 0 }))
            .rejects.toMatchObject({ status: 400, message: 'gameId inválido' });
        expect(ddb.send).not.toHaveBeenCalled();
    });
});

describe('hi-lo', () => {
    test('predicción inválida responde 400', async () => {
        ddb.send.mockResolvedValueOnce({ Item: hiloRound() });
        await expect(gameService.hiloPlay(USER, { roundId: GAME_ID, prediction: 'igual' }))
            .rejects.toMatchObject({ status: 400 });
    });

    test('perder deja el historial como PERDIDA y no suma al ranking', async () => {
        ddb.send.mockResolvedValueOnce({ Item: hiloRound({ oldCard: 7 }) }).mockResolvedValueOnce({});
        const res = await gameService.hiloPlay(USER, { roundId: GAME_ID, prediction: 'lower' }, () => 12);
        expect(res).toMatchObject({ won: false, tie: false, newCard: 12, payout: 0, amountChange: -100 });
        const items = sent(TransactWriteCommand)[0].input.TransactItems;
        expect(items).toHaveLength(3);
        expect(items[2].Put.Item).toMatchObject({ result: 'PERDIDA', detail: '7 → Q · elegiste Menor' });
        expect(metrics.countGame).toHaveBeenCalledWith('HiLo');
    });

    test('al cerrar, si la ronda ya terminó responde GAME_FINISHED', async () => {
        ddb.send
            .mockResolvedValueOnce({ Item: hiloRound() })
            .mockRejectedValueOnce(canceled('ConditionalCheckFailed', 'None', 'None'))
            .mockResolvedValueOnce({ Item: hiloRound({ status: 'WON' }) });
        await expect(gameService.hiloPlay(USER, { roundId: GAME_ID, prediction: 'higher' }, () => 11))
            .rejects.toMatchObject({ code: 'GAME_FINISHED' });
    });

    test('al cerrar, si la ronda venció responde NOT_FOUND', async () => {
        ddb.send
            .mockResolvedValueOnce({ Item: hiloRound() })
            .mockRejectedValueOnce(canceled('ConditionalCheckFailed', 'None', 'None'))
            .mockResolvedValueOnce({ Item: hiloRound({ expiresAt: PAST }) });
        await expect(gameService.hiloPlay(USER, { roundId: GAME_ID, prediction: 'higher' }, () => 11))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('al cerrar, si la ronda cambió de versión responde CONFLICT', async () => {
        ddb.send
            .mockResolvedValueOnce({ Item: hiloRound() })
            .mockRejectedValueOnce(canceled('ConditionalCheckFailed', 'None', 'None'))
            .mockResolvedValueOnce({ Item: hiloRound({ version: 1 }) });
        await expect(gameService.hiloPlay(USER, { roundId: GAME_ID, prediction: 'higher' }, () => 11))
            .rejects.toMatchObject({ code: 'CONFLICT' });
    });

    test('hiloActive sin puntero no consulta DynamoDB', async () => {
        expect(await gameService.hiloActive(USER)).toEqual({ round: null });
        expect(ddb.send).not.toHaveBeenCalled();
    });

    test('hiloActive ignora la ronda de otro jugador', async () => {
        ddb.send.mockResolvedValueOnce({ Item: hiloRound({ userId: 'u-2' }) });
        expect(await gameService.hiloActive({ ...USER, activeHiloId: GAME_ID, activeHiloExp: FUTURE })).toEqual({ round: null });
    });
});

describe('minas', () => {
    test('minesActive regresa la vista de la ronda viva', async () => {
        ddb.send.mockResolvedValueOnce({ Item: minesRound({ revealed: [10, 11] }) });
        const { round: view } = await gameService.minesActive({ ...USER, activeMinesId: GAME_ID, activeMinesExp: FUTURE });
        expect(view).toMatchObject({ gameId: GAME_ID, safeCount: 2, revealed: [{ x: 2, y: 0 }, { x: 2, y: 1 }] });
        expect(view.cashoutAmount).toBe(engine.minesPayout(100, 2));
    });

    test('minesActive sin ronda regresa null', async () => {
        ddb.send.mockResolvedValueOnce({});
        expect(await gameService.minesActive({ ...USER, activeMinesId: GAME_ID, activeMinesExp: FUTURE })).toEqual({ round: null });
    });

    test('destapar una casilla ya destapada no escribe nada', async () => {
        ddb.send.mockResolvedValueOnce({ Item: minesRound({ revealed: [10] }) });
        const res = await gameService.minesReveal(USER, { gameId: GAME_ID, x: 2, y: 0 });
        expect(res).toMatchObject({ result: 'safe', status: 'ACTIVE', safeCount: 1 });
        expect(ddb.send).toHaveBeenCalledTimes(1);
    });

    test('destapar una casilla segura guarda la lista y sube la versión', async () => {
        ddb.send.mockResolvedValueOnce({ Item: minesRound({ revealed: [10], version: 3 }) }).mockResolvedValueOnce({});
        const res = await gameService.minesReveal(USER, { gameId: GAME_ID, x: 2, y: 1 });
        expect(res).toMatchObject({ result: 'safe', status: 'ACTIVE', safeCount: 2, cell: { x: 2, y: 1 } });
        const update = sent(UpdateCommand)[0].input;
        expect(update.ExpressionAttributeValues).toMatchObject({ ':v': 3, ':r': [10, 11] });
    });

    test('si otra petición destapó al mismo tiempo responde CONFLICT', async () => {
        ddb.send.mockResolvedValueOnce({ Item: minesRound() }).mockRejectedValueOnce(named('ConditionalCheckFailedException'));
        await expect(gameService.minesReveal(USER, { gameId: GAME_ID, x: 3, y: 3 })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    test('otro error al destapar se propaga', async () => {
        ddb.send.mockResolvedValueOnce({ Item: minesRound() }).mockRejectedValueOnce(new Error('ddb caído'));
        await expect(gameService.minesReveal(USER, { gameId: GAME_ID, x: 3, y: 3 })).rejects.toThrow('ddb caído');
    });

    test.each([
        [[], 'Pisaste una mina en la primera casilla'],
        [[10], 'Pisaste una mina tras 1 casilla segura'],
        [[10, 11], 'Pisaste una mina tras 2 casillas seguras'],
    ])('pisar una mina con %j destapadas', async (revealed, detail) => {
        ddb.send.mockResolvedValueOnce({ Item: minesRound({ revealed }) }).mockResolvedValueOnce({});
        const res = await gameService.minesReveal(USER, { gameId: GAME_ID, x: 0, y: 0 });
        expect(res).toMatchObject({ result: 'mine', status: 'LOST', amountChange: -100 });
        expect(res.mines).toHaveLength(5);
        const items = sent(TransactWriteCommand)[0].input.TransactItems;
        expect(items[2].Put.Item.detail).toBe(detail);
        expect(items[2].Put.Item.result).toBe('PERDIDA');
    });

    test('destapar la última casilla segura gana la partida', async () => {
        const revealed = Array.from({ length: engine.MINES_SAFE_CELLS - 1 }, (_, i) => i + 5);
        ddb.send.mockResolvedValueOnce({ Item: minesRound({ revealed }) }).mockResolvedValueOnce({});
        const res = await gameService.minesReveal(USER, { gameId: GAME_ID, x: 4, y: 4 });
        const payout = engine.minesPayout(100, engine.MINES_SAFE_CELLS);
        expect(res).toMatchObject({ result: 'safe', status: 'WON', payout, amountChange: payout - 100 });
        expect(res.nextMultiplier).toBeNull();
        expect(res.nextCashoutAmount).toBeNull();
        const items = sent(TransactWriteCommand)[0].input.TransactItems;
        expect(items).toHaveLength(4); // con pago > 0 también suma al ranking
        expect(items[2].Put.Item).toMatchObject({ result: 'GANADA', detail: 'Destapaste las 20 casillas seguras' });
    });

    test('cobrar sin casillas destapadas responde 400', async () => {
        ddb.send.mockResolvedValueOnce({ Item: minesRound() });
        await expect(gameService.minesCashout(USER, { gameId: GAME_ID })).rejects.toMatchObject({ status: 400 });
    });

    test('cobrar tras una casilla usa el singular en el detalle', async () => {
        ddb.send.mockResolvedValueOnce({ Item: minesRound({ revealed: [10] }) }).mockResolvedValueOnce({});
        await gameService.minesCashout(USER, { gameId: GAME_ID });
        const { detail } = sent(TransactWriteCommand)[0].input.TransactItems[2].Put.Item;
        expect(detail).toBe('Cobraste tras 1 casilla segura');
    });

    test('con una apuesta grande el multiplicador anunciado respeta el tope de pago', async () => {
        ddb.send.mockResolvedValueOnce({ Item: minesRound({ bet: engine.MINES_MAX_PAYOUT, revealed: [10, 11, 12] }) });
        const { round: view } = await gameService.minesActive({ ...USER, activeMinesId: GAME_ID, activeMinesExp: FUTURE });
        expect(view.multiplier).toBe(1);
        expect(view.atCap).toBe(true);
    });
});

test('las lecturas de la ronda son consistentes', async () => {
    ddb.send.mockResolvedValueOnce({ Item: hiloRound() });
    await gameService.hiloActive({ ...USER, activeHiloId: GAME_ID, activeHiloExp: FUTURE });
    expect(sent(GetCommand)[0].input).toMatchObject({ Key: { gameId: GAME_ID }, ConsistentRead: true });
});
