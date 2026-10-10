const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { run, handler } = require('../daily-bonus/index');
const { conditionalFailed, emfLines } = require('./helpers');

const ddbMock = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);
// 14:00 UTC = 08:00 en CDMX.
const NOW = new Date('2026-10-09T14:00:00Z');

let logSpy;
let errSpy;
beforeEach(() => {
    ddbMock.reset();
    snsMock.reset();
    snsMock.on(PublishCommand).resolves({ MessageId: 'm' });
    process.env.TABLE_USERS = 'friomx-users';
    process.env.USER_TOPIC_ARN = 'arn:aws:sns:us-east-1:111111111111:friomx-user-notifications';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); errSpy.mockRestore(); });

const metricsOf = () => emfLines(logSpy).at(-1);

test('Scan paginado con filtro de 7 días y bono a cada activo', async () => {
    ddbMock.on(ScanCommand)
        .resolvesOnce({ Items: [{ userId: 'u1' }, { userId: 'u2' }], LastEvaluatedKey: { userId: 'u2' } })
        .resolvesOnce({ Items: [{ userId: 'u3' }] });
    ddbMock.on(UpdateCommand).resolves({});

    const out = await run({}, NOW);

    expect(out).toEqual({ today: '2026-10-09', granted: 3, skipped: 0 });
    const scans = ddbMock.commandCalls(ScanCommand);
    expect(scans).toHaveLength(2);
    expect(scans[0].args[0].input).toMatchObject({
        TableName: 'friomx-users',
        FilterExpression: '#lastPlayedAt >= :since',
        ExpressionAttributeNames: { '#lastPlayedAt': 'lastPlayedAt' },
        ExpressionAttributeValues: { ':since': '2026-10-02T14:00:00.000Z' },
    });
    expect(scans[1].args[0].input.ExclusiveStartKey).toEqual({ userId: 'u2' });

    const upd = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.UpdateExpression).toBe('ADD #balance :bonus SET #lastBonusDate = :today');
    expect(upd.ConditionExpression).toContain('attribute_not_exists(#lastBonusDate) OR #lastBonusDate <> :today');
    expect(upd.ExpressionAttributeValues).toEqual({ ':bonus': 100, ':today': '2026-10-09' });

    const pubs = snsMock.commandCalls(PublishCommand);
    expect(pubs.map((c) => c.args[0].input.MessageAttributes.audience.StringValue)).toEqual(['u1', 'u2', 'u3']);
    expect(metricsOf()).toMatchObject({ BonusGranted: 3, BonusSkipped: 0 });
});

test('bono dos veces el mismo día: la segunda corrida no acredita ni avisa', async () => {
    const balances = { u1: 1000 };
    const bonusDate = {};
    ddbMock.on(ScanCommand).resolves({ Items: [{ userId: 'u1' }] });
    ddbMock.on(UpdateCommand).callsFake((input) => {
        const id = input.Key.userId;
        if (bonusDate[id] === input.ExpressionAttributeValues[':today']) throw conditionalFailed();
        bonusDate[id] = input.ExpressionAttributeValues[':today'];
        balances[id] += input.ExpressionAttributeValues[':bonus'];
        return {};
    });

    const first = await run({}, NOW);
    const second = await run({}, new Date(NOW.getTime() + 3600000));

    expect(first).toMatchObject({ granted: 1, skipped: 0 });
    expect(second).toMatchObject({ granted: 0, skipped: 1 });
    expect(balances.u1).toBe(1100);
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(1);
    expect(metricsOf()).toMatchObject({ BonusGranted: 0, BonusSkipped: 1 });
});

test('al día siguiente local sí vuelve a acreditar', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ userId: 'u1' }] });
    ddbMock.on(UpdateCommand).resolves({});
    const out = await run({}, new Date('2026-10-10T14:00:00Z'));
    expect(out.today).toBe('2026-10-10');
});

test('sin jugadores activos emite métricas en 0', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    expect(await handler({})).toMatchObject({ granted: 0, skipped: 0 });
    expect(metricsOf()).toMatchObject({ BonusGranted: 0, BonusSkipped: 0 });
});

test('fallo de SNS no deshace el bono', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ userId: 'u1' }] });
    ddbMock.on(UpdateCommand).resolves({});
    snsMock.on(PublishCommand).rejects(new Error('SNS caído'));
    expect(await run({}, NOW)).toMatchObject({ granted: 1 });
    expect(metricsOf()).toMatchObject({ BonusGranted: 1, NotificationFailed: 1 });
});

test('error inesperado en un jugador: sigue con los demás y la invocación falla', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [{ userId: 'u1' }, { userId: 'u2' }] });
    ddbMock.on(UpdateCommand, { Key: { userId: 'u1' } }).rejects(new Error('Throttling'));
    ddbMock.on(UpdateCommand, { Key: { userId: 'u2' } }).resolves({});

    await expect(run({}, NOW)).rejects.toThrow('1 jugador');
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(1);
    expect(metricsOf()).toMatchObject({ BonusGranted: 1 });
});
