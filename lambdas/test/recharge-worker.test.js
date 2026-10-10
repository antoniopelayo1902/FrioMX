const { mockClient } = require('aws-sdk-client-mock');
const { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { run, handler, processRecharge } = require('../recharge-worker/index');
const { txCanceled, emfLines } = require('./helpers');

const ddbMock = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);
const NOW = new Date('2026-10-09T18:00:00Z');

const recharge = (id, userId = 'u1', chips = 500) => ({ rechargeId: id, userId, chips, packageId: 'p500', status: 'PENDING' });
const record = (messageId, body) => ({ messageId, body: typeof body === 'string' ? body : JSON.stringify(body) });

let logSpy;
let errSpy;
beforeEach(() => {
    ddbMock.reset();
    snsMock.reset();
    snsMock.on(PublishCommand).resolves({ MessageId: 'm' });
    process.env.TABLE_RECHARGES = 'friomx-recharges';
    process.env.TABLE_USERS = 'friomx-users';
    process.env.USER_TOPIC_ARN = 'arn:aws:sns:us-east-1:111111111111:friomx-user-notifications';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); errSpy.mockRestore(); });

const metricsOf = () => emfLines(logSpy).at(-1);

test('acredita la recarga, avisa por SNS con audience y emite RechargesCompleted', async () => {
    ddbMock.on(GetCommand).resolves({ Item: recharge('r1') });
    ddbMock.on(TransactWriteCommand).resolves({});

    const out = await run({ Records: [record('m1', { rechargeId: 'r1' })] }, NOW);

    expect(out).toEqual({ batchItemFailures: [] });
    const tx = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems;
    expect(tx[0].Update).toMatchObject({
        TableName: 'friomx-recharges', Key: { rechargeId: 'r1' },
        UpdateExpression: 'SET #status = :completed, #completedAt = :now', ConditionExpression: '#status = :pending',
        ExpressionAttributeValues: { ':completed': 'COMPLETED', ':pending': 'PENDING', ':now': NOW.toISOString() },
    });
    expect(tx[1].Update).toMatchObject({
        TableName: 'friomx-users', Key: { userId: 'u1' }, UpdateExpression: 'ADD #balance :chips',
        ConditionExpression: 'attribute_exists(#userId)', ExpressionAttributeValues: { ':chips': 500 },
    });
    const pub = snsMock.commandCalls(PublishCommand)[0].args[0].input;
    expect(pub.Message).toBe('Tu recarga de 500 fichas está lista');
    expect(pub.MessageAttributes.audience).toEqual({ DataType: 'String', StringValue: 'u1' });
    expect(metricsOf()).toMatchObject({ RechargesCompleted: 1, RechargeFailed: 0, NotificationFailed: 0 });
    expect(metricsOf()._aws.CloudWatchMetrics[0].Namespace).toBe('FrioMx');
});

test('recarga duplicada (ya COMPLETED): no abona dos veces ni manda correo', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...recharge('r1'), status: 'COMPLETED' } });
    ddbMock.on(TransactWriteCommand).rejects(txCanceled(['ConditionalCheckFailed', 'None']));

    const out = await run({ Records: [record('m1', { rechargeId: 'r1' })] }, NOW);

    expect(out.batchItemFailures).toEqual([]);
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    expect(metricsOf()).toMatchObject({ RechargesCompleted: 0, RechargeFailed: 0 });
});

test('mismo mensaje dos veces en el lote: solo un abono efectivo', async () => {
    ddbMock.on(GetCommand).resolves({ Item: recharge('r1') });
    ddbMock.on(TransactWriteCommand)
        .resolvesOnce({})
        .rejectsOnce(txCanceled(['ConditionalCheckFailed', 'None']));

    const out = await run({ Records: [record('m1', { rechargeId: 'r1' }), record('m2', { rechargeId: 'r1' })] }, NOW);

    expect(out.batchItemFailures).toEqual([]);
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(1);
    expect(metricsOf()).toMatchObject({ RechargesCompleted: 1 });
});

test('fallo parcial en el lote: solo se reporta el mensaje que falló', async () => {
    ddbMock.on(GetCommand, { Key: { rechargeId: 'r1' } }).resolves({ Item: recharge('r1') });
    ddbMock.on(GetCommand, { Key: { rechargeId: 'r2' } }).resolves({ Item: recharge('r2', 'u2', 1000) });
    ddbMock.on(GetCommand, { Key: { rechargeId: 'r3' } }).resolves({ Item: recharge('r3', 'u3', 2500) });
    ddbMock.on(TransactWriteCommand).callsFake((input) => {
        if (input.TransactItems[0].Update.Key.rechargeId === 'r2') throw new Error('ProvisionedThroughputExceeded');
        return {};
    });

    const out = await run({
        Records: [record('m1', { rechargeId: 'r1' }), record('m2', { rechargeId: 'r2' }), record('m3', { rechargeId: 'r3' })],
    }, NOW);

    expect(out).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(metricsOf()).toMatchObject({ RechargesCompleted: 2, RechargeFailed: 1 });
});

test('recarga inexistente, cuerpo inválido y usuario inexistente van a reintento', async () => {
    ddbMock.on(GetCommand, { Key: { rechargeId: 'nope' } }).resolves({});
    ddbMock.on(GetCommand, { Key: { rechargeId: 'r9' } }).resolves({ Item: recharge('r9', 'ghost') });
    ddbMock.on(TransactWriteCommand).rejects(txCanceled(['None', 'ConditionalCheckFailed']));

    const out = await run({
        Records: [
            record('a', { rechargeId: 'nope' }),
            record('b', 'no-es-json'),
            record('c', {}),
            record('d', { rechargeId: 'r9' }),
        ],
    }, NOW);

    expect(out.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(['a', 'b', 'c', 'd']);
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
    expect(metricsOf()).toMatchObject({ RechargesCompleted: 0, RechargeFailed: 4 });
});

test('si SNS falla, el mensaje se da por bueno y se cuenta NotificationFailed', async () => {
    ddbMock.on(GetCommand).resolves({ Item: recharge('r1') });
    ddbMock.on(TransactWriteCommand).resolves({});
    snsMock.on(PublishCommand).rejects(new Error('SNS caído'));

    const out = await run({ Records: [record('m1', { rechargeId: 'r1' })] }, NOW);

    expect(out.batchItemFailures).toEqual([]);
    expect(metricsOf()).toMatchObject({ RechargesCompleted: 1, NotificationFailed: 1, RechargeFailed: 0 });
});

test('sin USER_TOPIC_ARN acredita sin publicar', async () => {
    delete process.env.USER_TOPIC_ARN;
    ddbMock.on(GetCommand).resolves({ Item: recharge('r1') });
    ddbMock.on(TransactWriteCommand).resolves({});

    const out = await handler({ Records: [record('m1', { rechargeId: 'r1' })] });

    expect(out.batchItemFailures).toEqual([]);
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
});

test('lote vacío y processRecharge directo', async () => {
    expect(await run({}, NOW)).toEqual({ batchItemFailures: [] });
    await expect(processRecharge(undefined)).rejects.toThrow('rechargeId');
});
