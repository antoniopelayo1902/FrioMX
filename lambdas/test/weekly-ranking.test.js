const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { run, handler, resolveWeekId, rankCandidates } = require('../weekly-ranking/index');
const { txCanceled, emfLines } = require('./helpers');

const ddbMock = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);
// Lunes 2026-10-12 07:10 UTC = 01:10 local -> semana en curso 2026-W42, a cerrar 2026-W41.
const MONDAY = new Date('2026-10-12T07:10:00Z');

const row = (userId, net, gamesPlayed = 1, name = `N-${userId}`) => ({ weekId: '2026-W41', userId, net, gamesPlayed, name });

let logSpy;
let errSpy;
beforeEach(() => {
    ddbMock.reset();
    snsMock.reset();
    snsMock.on(PublishCommand).resolves({ MessageId: 'm' });
    process.env.TABLE_USERS = 'friomx-users';
    process.env.TABLE_WEEKLY_STATS = 'friomx-weekly-stats';
    process.env.TABLE_LEADERBOARD = 'friomx-leaderboard';
    process.env.USER_TOPIC_ARN = 'arn:aws:sns:us-east-1:111111111111:friomx-user-notifications';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); errSpy.mockRestore(); });

const txItems = (i = 0) => ddbMock.commandCalls(TransactWriteCommand)[i].args[0].input.TransactItems;

describe('resolveWeekId', () => {
    test('sin weekId cierra la semana anterior a la local en curso, sin importar el día', () => {
        expect(resolveWeekId({}, MONDAY)).toBe('2026-W41');
        expect(resolveWeekId(undefined, new Date('2026-10-16T18:00:00Z'))).toBe('2026-W41');
        // Domingo 21:00 local (lunes 03:00 UTC): la semana en curso sigue siendo W41.
        expect(resolveWeekId({}, new Date('2026-10-12T03:00:00Z'))).toBe('2026-W40');
        expect(resolveWeekId({}, new Date('2027-01-04T07:10:00Z'))).toBe('2026-W53');
    });

    test('acepta un weekId pasado', () => {
        expect(resolveWeekId({ weekId: '2026-W30' }, MONDAY)).toBe('2026-W30');
        expect(resolveWeekId({ weekId: '2025-W52' }, MONDAY)).toBe('2025-W52');
    });

    test('rechaza la semana en curso, futuras y formatos inválidos', () => {
        expect(() => resolveWeekId({ weekId: '2026-W42' }, MONDAY)).toThrow('semanas pasadas');
        expect(() => resolveWeekId({ weekId: '2026-W50' }, MONDAY)).toThrow('semanas pasadas');
        expect(() => resolveWeekId({ weekId: '2027-W53' }, MONDAY)).toThrow('inválido');
        expect(() => resolveWeekId({ weekId: 'hola' }, MONDAY)).toThrow('inválido');
    });
});

test('rankCandidates: net desc, gamesPlayed desc, userId asc y solo net > 0', () => {
    const ranked = rankCandidates([row('c', 100, 2), row('b', 100, 5), row('a', 100, 5), row('z', 0), row('y', -50), row('x', 300)]);
    expect(ranked.map((r) => r.userId)).toEqual(['x', 'a', 'b', 'c']);
});

test('cierra la semana: top 3 con premios 1000/500/250, transacción y avisos', async () => {
    ddbMock.on(QueryCommand)
        .resolvesOnce({ Items: [row('u1', 300), row('u2', 1200)], LastEvaluatedKey: { weekId: '2026-W41', userId: 'u2' } })
        .resolvesOnce({ Items: [row('u3', 800), row('u4', 50), row('u5', -10)] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const out = await handler({});
    expect(out.status).toBe('CLOSED');

    const queries = ddbMock.commandCalls(QueryCommand);
    expect(queries).toHaveLength(2);
    expect(queries[0].args[0].input).toMatchObject({
        TableName: 'friomx-weekly-stats', KeyConditionExpression: '#weekId = :weekId',
        ExpressionAttributeNames: { '#weekId': 'weekId' },
    });
    expect(queries[1].args[0].input.ExclusiveStartKey).toEqual({ weekId: '2026-W41', userId: 'u2' });

    const items = txItems();
    expect(items).toHaveLength(4);
    expect(items[0].Put).toMatchObject({
        TableName: 'friomx-leaderboard', ConditionExpression: 'attribute_not_exists(#weekId)',
    });
    expect(items[0].Put.Item.top).toEqual([
        { rank: 1, userId: 'u2', name: 'N-u2', net: 1200, prize: 1000 },
        { rank: 2, userId: 'u3', name: 'N-u3', net: 800, prize: 500 },
        { rank: 3, userId: 'u1', name: 'N-u1', net: 300, prize: 250 },
    ]);
    expect(typeof items[0].Put.Item.closedAt).toBe('string');
    expect(items.slice(1).map((i) => [i.Update.Key.userId, i.Update.ExpressionAttributeValues[':prize']]))
        .toEqual([['u2', 1000], ['u3', 500], ['u1', 250]]);
    expect(items[1].Update).toMatchObject({
        TableName: 'friomx-users', UpdateExpression: 'ADD #balance :prize', ConditionExpression: 'attribute_exists(#userId)',
    });
    expect(snsMock.commandCalls(PublishCommand).map((c) => c.args[0].input.MessageAttributes.audience.StringValue))
        .toEqual(['u2', 'u3', 'u1']);
});

test('weekId en curso: termina con error sin leer ni escribir', async () => {
    await expect(run({ weekId: '2026-W42' }, MONDAY)).rejects.toThrow();
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
});

test('cierre de semana repetido: no paga ni avisa', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row('u1', 500)] });
    ddbMock.on(TransactWriteCommand).rejects(txCanceled(['ConditionalCheckFailed', 'None']));

    const out = await run({ weekId: '2026-W41' }, MONDAY);

    expect(out).toEqual({ weekId: '2026-W41', status: 'ALREADY_CLOSED' });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
});

test('semana sin ganadores: guarda top [] para dejarla cerrada', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row('u1', 0), row('u2', -300)] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const out = await run({}, MONDAY);

    expect(out.top).toEqual([]);
    const items = txItems();
    expect(items).toHaveLength(1);
    expect(items[0].Put.Item).toMatchObject({ weekId: '2026-W41', top: [] });
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
});

test('semana vacía (sin filas) también se cierra con top []', async () => {
    ddbMock.on(QueryCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});
    expect((await run({}, MONDAY)).top).toEqual([]);
});

test('ganador sin cuenta: se quita del top y se reintenta con el siguiente', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row('u1', 900), row('ghost', 700), row('u3', 500), row('u4', 100)] });
    ddbMock.on(TransactWriteCommand)
        .rejectsOnce(txCanceled(['None', 'None', 'ConditionalCheckFailed', 'None']))
        .resolves({});

    const out = await run({}, MONDAY);

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
    expect(out.top.map((w) => [w.userId, w.rank, w.prize])).toEqual([['u1', 1, 1000], ['u3', 2, 500], ['u4', 3, 250]]);
    expect(txItems(1).slice(1).map((i) => i.Update.Key.userId)).toEqual(['u1', 'u3', 'u4']);
    expect(snsMock.commandCalls(PublishCommand).map((c) => c.args[0].input.MessageAttributes.audience.StringValue))
        .not.toContain('ghost');
});

test('TransactionConflict se reintenta y luego cierra', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row('u1', 900)] });
    ddbMock.on(TransactWriteCommand)
        .rejectsOnce(txCanceled(['None', 'TransactionConflict']))
        .resolves({});
    expect((await run({}, MONDAY)).status).toBe('CLOSED');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
});

test('TransactionConflict persistente o error genérico: falla la invocación', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row('u1', 900)] });
    ddbMock.on(TransactWriteCommand).rejects(txCanceled(['None', 'TransactionConflict']));
    await expect(run({}, MONDAY)).rejects.toThrow();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(4);

    ddbMock.on(TransactWriteCommand).rejects(new Error('boom'));
    await expect(run({}, MONDAY)).rejects.toThrow('boom');
});

test('fallo de SNS no deshace el cierre y cuenta NotificationFailed', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [row('u1', 900), row('u2', 10)] });
    ddbMock.on(TransactWriteCommand).resolves({});
    snsMock.on(PublishCommand).rejects(new Error('SNS caído'));

    expect((await run({}, MONDAY)).status).toBe('CLOSED');
    expect(emfLines(logSpy).at(-1)).toMatchObject({ NotificationFailed: 2 });
});
