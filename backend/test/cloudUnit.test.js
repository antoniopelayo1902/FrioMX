// Pruebas unitarias de las piezas de nube sin DynamoDB Local: todo AWS se simula con aws-sdk-client-mock.
const path = require('path');
const { spawn } = require('child_process');

process.env.JWT_SECRET = 'secreto-de-prueba';
process.env.RECHARGE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/friomx-recharges';

const { mockClient } = require('aws-sdk-client-mock');
const http = require('http');
const { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const {
    SNSClient, SubscribeCommand, UnsubscribeCommand, ListSubscriptionsByTopicCommand,
    SetSubscriptionAttributesCommand, GetSubscriptionAttributesCommand,
} = require('@aws-sdk/client-sns');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { config, assertConfig } = require('../src/config/env');
const { loadJwtSecret } = require('../src/config/secrets');
const { uuidv5, isUuidVersion, NAMESPACE_FRIOMX } = require('../src/lib/uuid');
const v = require('../src/lib/validate');
const wallet = require('../src/services/walletService');
const metrics = require('../src/services/metrics');
const storage = require('../src/services/storageService');
const notifications = require('../src/services/notificationService');
const leaderboard = require('../src/services/leaderboardService');
const { isoWeekId } = require('../src/lib/time');

const { byRank } = leaderboard;

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);
const smMock = mockClient(SecretsManagerClient);
const cwMock = mockClient(CloudWatchClient);
const snsMock = mockClient(SNSClient);
const s3Mock = mockClient(S3Client);

const canceled = (...codes) => Object.assign(new Error('cancelada'), {
    name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })),
});

beforeEach(() => {
    [ddbMock, sqsMock, smMock, cwMock, snsMock, s3Mock].forEach((m) => m.reset());
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('uuid v5', () => {
    test('vector del RFC 4122 y versión correcta', () => {
        expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
        const id = uuidv5('u:k');
        expect(isUuidVersion(id, 5)).toBe(true);
        expect(isUuidVersion(NAMESPACE_FRIOMX, 4)).toBe(true);
        expect(isUuidVersion(id, 4)).toBe(false);
        expect(isUuidVersion(123, 5)).toBe(false);
        expect(() => uuidv5('x', 'no-es-uuid')).toThrow();
    });

    test('el rechargeId depende del usuario y de la clave, sin importar mayúsculas', () => {
        const key = '0f8fad5b-d9cb-469f-a165-70867728950e';
        expect(wallet.rechargeIdFor('a', key)).toBe(wallet.rechargeIdFor('a', key.toUpperCase()));
        expect(wallet.rechargeIdFor('a', key)).not.toBe(wallet.rechargeIdFor('b', key));
        expect(v.uuidV5(wallet.rechargeIdFor('a', key), 'rechargeId')).toBeTruthy();
        expect(() => v.uuidV5(key, 'rechargeId')).toThrow();
    });
});

describe('configuración y secreto JWT', () => {
    const saved = {};
    beforeEach(() => Object.assign(saved, { s: config.jwtSecret, a: config.jwtSecretArn }));
    afterEach(() => { config.jwtSecret = saved.s; config.jwtSecretArn = saved.a; });

    test('assertConfig exige JWT_SECRET o JWT_SECRET_ARN', () => {
        config.jwtSecret = undefined;
        config.jwtSecretArn = undefined;
        expect(() => assertConfig()).toThrow(/JWT_SECRET/);
        config.jwtSecretArn = 'arn:aws:secretsmanager:us-east-1:1:secret:friomx/jwt-secret';
        expect(() => assertConfig()).not.toThrow();
    });

    test('con JWT_SECRET no se llama a Secrets Manager', async () => {
        config.jwtSecret = 'local';
        config.jwtSecretArn = 'arn:x';
        expect(await loadJwtSecret()).toBe('local');
        expect(smMock.calls()).toHaveLength(0);
    });

    test('sin JWT_SECRET lee el secreto del ARN y lo deja en memoria', async () => {
        config.jwtSecret = undefined;
        config.jwtSecretArn = 'arn:aws:secretsmanager:us-east-1:1:secret:friomx/jwt-secret';
        smMock.on(GetSecretValueCommand).resolves({ SecretString: 'x'.repeat(64) });
        expect(await loadJwtSecret()).toBe('x'.repeat(64));
        expect(config.jwtSecret).toBe('x'.repeat(64));
        expect(smMock.commandCalls(GetSecretValueCommand)[0].args[0].input).toEqual({ SecretId: config.jwtSecretArn });
    });

    test('secreto vacío, error de AWS o sin ninguna variable fallan', async () => {
        config.jwtSecret = undefined;
        config.jwtSecretArn = 'arn:x';
        smMock.on(GetSecretValueCommand).resolves({ SecretString: 'corto' });
        await expect(loadJwtSecret()).rejects.toThrow(/corto/);
        smMock.on(GetSecretValueCommand).rejects(new Error('AccessDenied'));
        await expect(loadJwtSecret()).rejects.toThrow('AccessDenied');
        config.jwtSecretArn = undefined;
        await expect(loadJwtSecret()).rejects.toThrow(/JWT_SECRET/);
    });

    test('createApp no arranca si el secreto no está cargado', () => {
        const { createApp } = require('../src/app');
        config.jwtSecret = undefined;
        config.jwtSecretArn = 'arn:x';
        expect(() => createApp()).toThrow(/secreto JWT/);
    });

    // El proceso real debe salir con código 1 si no puede leer el secreto (systemd lo reintenta).
    const runServer = (env) => new Promise((resolve) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { PATH: process.env.PATH, PORT: '0', ...env },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => child.kill('SIGKILL'), 15000);
        child.on('exit', (code) => { clearTimeout(t); resolve({ code, err }); });
    });

    test('server.js sale con código 1 sin secreto', async () => {
        // JWT_SECRET vacío gana sobre el .env (dotenv no pisa variables que ya existen).
        const res = await runServer({ JWT_SECRET: '' });
        expect(res.code).toBe(1);
        expect(res.err).toMatch(/No se pudo arrancar/);
    });

    test('server.js sale con código 1 si Secrets Manager no responde', async () => {
        // Endpoint local cerrado: nunca sale a AWS real.
        const res = await runServer({
            JWT_SECRET: '', JWT_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:friomx/jwt-secret',
            AWS_ENDPOINT_URL_SECRETS_MANAGER: 'http://127.0.0.1:9', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_MAX_ATTEMPTS: '1',
        });
        expect(res.code).toBe(1);
        expect(res.err).toMatch(/No se pudo arrancar/);
    });
});

describe('walletService con DynamoDB simulado', () => {
    const user = { userId: 'u-1' };
    const key = '0f8fad5b-d9cb-469f-a165-70867728950e';

    test('reintenta ante TransactionConflict y luego encola', async () => {
        ddbMock.on(GetCommand).resolves({});
        ddbMock.on(TransactWriteCommand)
            .rejectsOnce(canceled('TransactionConflict', 'None'))
            .rejectsOnce(canceled('None', 'TransactionConflict'))
            .resolves({});
        sqsMock.on(SendMessageCommand).resolves({});
        const res = await wallet.createRecharge(user, { packageId: 'p2500' }, key);
        expect(res).toEqual({ rechargeId: wallet.rechargeIdFor('u-1', key), status: 'PENDING' });
        expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(3);
        const put = ddbMock.commandCalls(TransactWriteCommand)[2].args[0].input.TransactItems[1].Put;
        expect(put.Item).toMatchObject({ userId: 'u-1', packageId: 'p2500', chips: 2500, status: 'PENDING' });
    });

    test('conflicto persistente da 409 CONFLICT', async () => {
        ddbMock.on(GetCommand).resolves({});
        ddbMock.on(TransactWriteCommand).rejects(canceled('TransactionConflict', 'None'));
        await expect(wallet.createRecharge(user, { packageId: 'p500' }, key)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
        expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(4);
    });

    test('A falla, B falla, A otra vez falla: 429 DAILY_LIMIT', async () => {
        ddbMock.on(GetCommand).resolves({});
        ddbMock.on(TransactWriteCommand).rejects(canceled('ConditionalCheckFailed', 'None'));
        await expect(wallet.createRecharge(user, { packageId: 'p500' }, key)).rejects.toMatchObject({ status: 429, code: 'DAILY_LIMIT' });
        const exprs = ddbMock.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems[0].Update.UpdateExpression);
        expect(exprs).toEqual(['ADD rechargeCount :one', 'SET rechargeDate = :today, rechargeCount = :one', 'ADD rechargeCount :one']);
    });

    test('el ítem 2 se revisa antes que el 1: carrera con la misma clave responde la existente', async () => {
        const existing = { rechargeId: wallet.rechargeIdFor('u-1', key), userId: 'u-1', status: 'COMPLETED', createdAt: new Date().toISOString() };
        ddbMock.on(GetCommand).resolvesOnce({}).resolves({ Item: existing });
        ddbMock.on(TransactWriteCommand).rejects(canceled('ConditionalCheckFailed', 'ConditionalCheckFailed'));
        expect(await wallet.createRecharge(user, { packageId: 'p500' }, key)).toEqual({ rechargeId: existing.rechargeId, status: 'COMPLETED' });
        expect(sqsMock.calls()).toHaveLength(0); // una COMPLETED no se vuelve a encolar
    });

    test('un error que no es de transacción se propaga', async () => {
        ddbMock.on(GetCommand).resolves({});
        ddbMock.on(TransactWriteCommand).rejects(new Error('ddb caído'));
        await expect(wallet.createRecharge(user, { packageId: 'p500' }, key)).rejects.toThrow('ddb caído');
    });

    test('estado calculado: FAILED solo si sigue PENDING después de 5 minutos', () => {
        const now = Date.parse('2026-10-09T12:00:00Z');
        const at = (ms) => new Date(now - ms).toISOString();
        expect(wallet.statusOf({ status: 'PENDING', createdAt: at(4 * 60 * 1000) }, now)).toBe('PENDING');
        expect(wallet.statusOf({ status: 'PENDING', createdAt: at(5 * 60 * 1000 + 1) }, now)).toBe('FAILED');
        expect(wallet.statusOf({ status: 'COMPLETED', createdAt: at(60 * 60 * 1000) }, now)).toBe('COMPLETED');
    });
});

describe('métricas', () => {
    afterEach(() => { config.metricsEnabled = false; metrics.stop(); metrics.drain(); });

    test('apagadas no acumulan ni envían', async () => {
        config.metricsEnabled = false;
        metrics.countGame('Roulette');
        metrics.recordRequest(12, 500);
        expect(metrics.drain()).toEqual([]);
        expect(await metrics.flush()).toBe(0);
        metrics.start();
        expect(cwMock.calls()).toHaveLength(0);
    });

    test('latencia en múltiplos de 10 ms, partida en bloques de 150 valores y Api5xx', async () => {
        config.metricsEnabled = true;
        for (let i = 0; i < 400; i += 1) metrics.recordRequest(i * 10 + 3, i < 2 ? 503 : 200);
        metrics.recordRequest(7, 200); // se redondea a 10, junto con el de 13 ms
        metrics.countGame('Mines');
        metrics.countGame('Mines');
        const data = metrics.drain(new Date('2026-10-09T12:00:00Z'));
        const lat = data.filter((d) => d.MetricName === 'ApiLatency');
        expect(lat.map((d) => d.Values.length)).toEqual([150, 150, 100]);
        expect(lat.every((d) => d.Values.every((x) => x % 10 === 0) && d.Unit === 'Milliseconds')).toBe(true);
        expect(lat[0].Values.slice(0, 3)).toEqual([0, 10, 20]);
        expect(lat[0].Counts[1]).toBe(2);
        expect(lat.reduce((s, d) => s + d.Counts.reduce((a, b) => a + b, 0), 0)).toBe(401);
        expect(data.find((d) => d.MetricName === 'Api5xx').Value).toBe(2);
        expect(data.find((d) => d.MetricName === 'GamesPlayed')).toMatchObject({ Value: 2, Dimensions: [{ Name: 'Game', Value: 'Mines' }] });
        expect(metrics.drain()).toEqual([]); // el buffer queda vacío
    });

    test('flush manda en lotes y un error de CloudWatch no rompe nada', async () => {
        config.metricsEnabled = true;
        for (let g = 0; g < 25; g += 1) metrics.countGame(`G${g}`);
        cwMock.on(PutMetricDataCommand).resolvesOnce({}).rejects(new Error('throttled'));
        expect(await metrics.flush()).toBe(1);
        expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(2);
        expect(cwMock.commandCalls(PutMetricDataCommand)[0].args[0].input.MetricData).toHaveLength(20);
    });

    test('el timer usa unref y se puede detener', () => {
        config.metricsEnabled = true;
        const spy = jest.spyOn(global, 'setInterval');
        metrics.start();
        metrics.start(); // no crea dos timers
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.results[0].value.hasRef()).toBe(false);
    });
});

describe('fotos y avisos', () => {
    test('firma de archivo por tipo', () => {
        const pad = Buffer.alloc(16);
        expect(storage.matchesSignature(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), pad]), 'image/jpeg')).toBe(true);
        expect(storage.matchesSignature(Buffer.concat([Buffer.from('RIFF0000WEBP'), pad]), 'image/webp')).toBe(true);
        expect(storage.matchesSignature(Buffer.concat([Buffer.from('RIFF0000WAVE'), pad]), 'image/webp')).toBe(false);
        expect(storage.matchesSignature(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), pad]), 'image/png')).toBe(false);
        expect(storage.matchesSignature(Buffer.from('xx'), 'image/png')).toBe(false);
        expect(storage.matchesSignature(Buffer.concat([Buffer.from('GIF89a'), pad]), 'image/gif')).toBe(false);
    });

    test('sin bucket no hay URL y sin tema SNS no se suscribe', async () => {
        expect(storage.enabled()).toBe(false);
        expect(await storage.imageUrlOf({ profileImageKey: 'profile-images/u/x.png' })).toBeNull();
        expect(notifications.enabled()).toBe(false);
        expect(await notifications.subscribeUser('u', 'a@b.com')).toBeNull();
        expect(await notifications.resubscribe('u', 'a@b.com', 'arn:old')).toBeNull();
        expect(await notifications.unsubscribe('arn:old')).toBe(false);
        expect(snsMock.calls()).toHaveLength(0);
    });
});

describe('ranking', () => {
    test('orden: neto, partidas y userId', () => {
        const rows = [
            { userId: 'b', net: 10, gamesPlayed: 1 },
            { userId: 'a', net: 10, gamesPlayed: 1 },
            { userId: 'c', net: 10, gamesPlayed: 3 },
            { userId: 'd', net: 50 },
        ];
        expect(rows.sort(byRank).map((r) => r.userId)).toEqual(['d', 'c', 'a', 'b']);
    });
});

describe('avisos SNS: resuscripción y limpieza pendiente', () => {
    const TOPIC = 'arn:aws:sns:us-east-1:123456789012:friomx-user-notifications';
    const OLD = `${TOPIC}:old-1`;
    const NEW = `${TOPIC}:new-1`;
    const differentAttrs = () => Object.assign(new Error('Invalid parameter: Attributes Reason: Subscription already exists with different attributes'), {
        name: 'InvalidParameterException',
    });
    const updates = () => ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    const policy = (id) => ({ Attributes: { FilterPolicy: JSON.stringify({ audience: [id, 'all'] }) } });

    beforeEach(() => { config.userTopicArn = TOPIC; ddbMock.on(UpdateCommand).resolves({}); });
    afterEach(() => { config.userTopicArn = undefined; });

    test('si falla el Subscribe nuevo la vieja se retira igual y notifyEmail se queda con el correo viejo', async () => {
        snsMock.on(SubscribeCommand).rejects(new Error('sns caído'));
        snsMock.on(GetSubscriptionAttributesCommand).resolves(policy('u-1'));
        snsMock.on(UnsubscribeCommand).resolves({});
        expect(await notifications.resubscribe('u-1', 'nuevo@x.com', OLD, 'viejo@x.com')).toBeNull();
        expect(snsMock.commandCalls(UnsubscribeCommand)[0].args[0].input).toEqual({ SubscriptionArn: OLD });
        // Solo se guarda notifyEmail (para cuentas sin ese campo); el ARN no se toca.
        expect(updates()).toEqual([expect.objectContaining({
            UpdateExpression: 'SET notifyEmail = :e',
            ConditionExpression: 'notifySubscriptionArn = :a AND attribute_not_exists(notifyEmail)',
            ExpressionAttributeValues: { ':a': OLD, ':e': 'viejo@x.com' },
        })]);
        // Si la vieja ya es de otra cuenta no se borra; si no se sabe, queda pendiente.
        snsMock.on(GetSubscriptionAttributesCommand).resolves(policy('u-otro'));
        snsMock.resetHistory();
        await notifications.resubscribe('u-1', 'nuevo@x.com', OLD, 'viejo@x.com');
        expect(snsMock.commandCalls(UnsubscribeCommand)).toHaveLength(0);
        snsMock.on(GetSubscriptionAttributesCommand).rejects(new Error('throttled'));
        ddbMock.resetHistory();
        await notifications.resubscribe('u-1', 'nuevo@x.com', OLD, 'viejo@x.com');
        expect(updates()[0].ExpressionAttributeValues).toMatchObject({ ':arn': OLD });
    });

    test('el ARN y notifyEmail se guardan con condición sobre el correo y el ARN leído', async () => {
        snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: NEW });
        await notifications.subscribeUser('u-1', 'ana@x.com');
        expect(updates()[0]).toMatchObject({
            UpdateExpression: 'SET notifySubscriptionArn = :a, notifyEmail = :e',
            ConditionExpression: 'email = :e AND attribute_not_exists(notifySubscriptionArn)',
            ExpressionAttributeValues: { ':a': NEW, ':e': 'ana@x.com' },
        });
        ddbMock.resetHistory();
        await notifications.subscribeUser('u-1', 'ana@x.com', OLD);
        expect(updates()[0]).toMatchObject({
            ConditionExpression: 'email = :e AND notifySubscriptionArn = :old',
            ExpressionAttributeValues: { ':a': NEW, ':e': 'ana@x.com', ':old': OLD },
        });
    });

    test('escritura concurrente: si el ARN vigente es otro, la suscripción recién creada se retira', async () => {
        snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: NEW });
        snsMock.on(GetSubscriptionAttributesCommand).resolves(policy('u-1'));
        snsMock.on(UnsubscribeCommand).resolves({});
        ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
        ddbMock.on(GetCommand).resolves({ Item: { userId: 'u-1', email: 'otro@x.com', notifySubscriptionArn: `${TOPIC}:otro` } });
        expect(await notifications.subscribeUser('u-1', 'ana@x.com', OLD)).toBeNull();
        expect(snsMock.commandCalls(UnsubscribeCommand)[0].args[0].input).toEqual({ SubscriptionArn: NEW });
        // Si la otra escritura dejó el mismo ARN (mismo correo), no se toca.
        snsMock.resetHistory();
        ddbMock.on(GetCommand).resolves({ Item: { userId: 'u-1', email: 'ana@x.com', notifySubscriptionArn: NEW } });
        expect(await notifications.subscribeUser('u-1', 'ana@x.com', OLD)).toBe(NEW);
        expect(snsMock.commandCalls(UnsubscribeCommand)).toHaveLength(0);
    });

    test('con el Subscribe nuevo bien se borra la vieja y no queda nada pendiente', async () => {
        snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: NEW });
        snsMock.on(GetSubscriptionAttributesCommand).resolves(policy('u-1'));
        snsMock.on(UnsubscribeCommand).resolves({});
        expect(await notifications.resubscribe('u-1', 'nuevo@x.com', OLD)).toBe(NEW);
        expect(snsMock.commandCalls(UnsubscribeCommand)[0].args[0].input).toEqual({ SubscriptionArn: OLD });
        expect(updates().map((u) => u.UpdateExpression)).toEqual(['SET notifySubscriptionArn = :a, notifyEmail = :e']);
    });

    test('si falla el Unsubscribe el ARN viejo se guarda en pendingUnsubscribeArns sin duplicar', async () => {
        snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: NEW });
        snsMock.on(GetSubscriptionAttributesCommand).resolves(policy('u-1'));
        snsMock.on(UnsubscribeCommand).rejects(Object.assign(new Error('pendiente'), { name: 'InvalidParameterException' }));
        await notifications.resubscribe('u-1', 'nuevo@x.com', OLD);
        const pending = updates()[1];
        expect(pending.UpdateExpression).toMatch(/list_append\(if_not_exists\(pendingUnsubscribeArns/);
        expect(pending.ExpressionAttributeValues).toMatchObject({ ':one': [OLD], ':arn': OLD });
        expect(pending.ConditionExpression).toMatch(/NOT contains\(pendingUnsubscribeArns, :arn\)/);
        // Si ya estaba (ConditionalCheckFailed) no truena.
        ddbMock.reset();
        ddbMock.on(UpdateCommand, { UpdateExpression: 'SET notifySubscriptionArn = :a, notifyEmail = :e' }).resolves({});
        ddbMock.on(UpdateCommand, { ConditionExpression: pending.ConditionExpression }).rejects(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
        await expect(notifications.resubscribe('u-1', 'nuevo@x.com', OLD)).resolves.toBe(NEW);
        // Un ARN viejo que no es ARN real (PendingConfirmation) ni se intenta ni se guarda.
        ddbMock.reset();
        ddbMock.on(UpdateCommand).resolves({});
        snsMock.resetHistory();
        await notifications.resubscribe('u-1', 'nuevo@x.com', 'PendingConfirmation');
        expect(snsMock.commandCalls(UnsubscribeCommand)).toHaveLength(0);
        expect(updates()).toHaveLength(1);
    });

    test('correo con suscripción existente de otros atributos: se busca paginado, se le pone el filtro y se guarda', async () => {
        snsMock.on(SubscribeCommand).rejects(differentAttrs());
        snsMock.on(ListSubscriptionsByTopicCommand)
            .resolvesOnce({ Subscriptions: [{ Protocol: 'email', Endpoint: 'otro@x.com', SubscriptionArn: `${TOPIC}:z` }], NextToken: 't2' })
            .resolvesOnce({ Subscriptions: [{ Protocol: 'email', Endpoint: 'Ana@X.com', SubscriptionArn: OLD }] });
        snsMock.on(SetSubscriptionAttributesCommand).resolves({});
        expect(await notifications.subscribeUser('u-b', 'ana@x.com')).toBe(OLD);
        const lists = snsMock.commandCalls(ListSubscriptionsByTopicCommand).map((c) => c.args[0].input);
        expect(lists).toEqual([{ TopicArn: TOPIC, NextToken: undefined }, { TopicArn: TOPIC, NextToken: 't2' }]);
        expect(snsMock.commandCalls(SetSubscriptionAttributesCommand)[0].args[0].input).toEqual({
            SubscriptionArn: OLD, AttributeName: 'FilterPolicy', AttributeValue: JSON.stringify({ audience: ['u-b', 'all'] }),
        });
        expect(updates()[0]).toMatchObject({ Key: { userId: 'u-b' }, ExpressionAttributeValues: { ':a': OLD } });
    });

    test('si la existente está pendiente de confirmar (sin ARN) o no aparece, la cuenta queda sin suscripción', async () => {
        snsMock.on(SubscribeCommand).rejects(differentAttrs());
        snsMock.on(ListSubscriptionsByTopicCommand)
            .resolvesOnce({ Subscriptions: [{ Protocol: 'email', Endpoint: 'ana@x.com', SubscriptionArn: 'PendingConfirmation' }] })
            .resolvesOnce({ Subscriptions: [] });
        expect(await notifications.subscribeUser('u-b', 'ana@x.com')).toBeNull();
        expect(await notifications.subscribeUser('u-b', 'ana@x.com')).toBeNull();
        expect(snsMock.commandCalls(SetSubscriptionAttributesCommand)).toHaveLength(0);
        expect(updates()).toHaveLength(0);
    });

    test('otro error de Subscribe no intenta adoptar', async () => {
        snsMock.on(SubscribeCommand).rejects(Object.assign(new Error('Invalid parameter: Endpoint'), { name: 'InvalidParameterException' }));
        expect(await notifications.subscribeUser('u-b', 'mal')).toBeNull();
        expect(snsMock.commandCalls(ListSubscriptionsByTopicCommand)).toHaveLength(0);
    });

    test('cleanupPending: borra las suyas, suelta las adoptadas por otra cuenta o inexistentes y deja las que fallan', async () => {
        const A = `${TOPIC}:a`; const B = `${TOPIC}:b`; const C = `${TOPIC}:c`; const D = `${TOPIC}:d`; const E = `${TOPIC}:e`;
        snsMock.on(GetSubscriptionAttributesCommand, { SubscriptionArn: A }).resolves(policy('u-1'))
            .on(GetSubscriptionAttributesCommand, { SubscriptionArn: B }).resolves(policy('u-otro'))
            .on(GetSubscriptionAttributesCommand, { SubscriptionArn: C }).rejects(Object.assign(new Error('nf'), { name: 'NotFoundException' }))
            .on(GetSubscriptionAttributesCommand, { SubscriptionArn: D }).resolves(policy('u-1'))
            .on(GetSubscriptionAttributesCommand, { SubscriptionArn: E }).rejects(new Error('throttled'));
        snsMock.on(UnsubscribeCommand, { SubscriptionArn: A }).resolves({})
            .on(UnsubscribeCommand, { SubscriptionArn: D }).rejects(new Error('pendiente'));
        const left = await notifications.cleanupPending({ userId: 'u-1', pendingUnsubscribeArns: [A, B, C, D, E] });
        expect(left).toBe(2);
        expect(snsMock.commandCalls(UnsubscribeCommand).map((c) => c.args[0].input.SubscriptionArn).sort()).toEqual([A, D]);
        const u = updates()[0];
        expect(u.UpdateExpression).toBe('REMOVE pendingUnsubscribeArns[0], pendingUnsubscribeArns[1], pendingUnsubscribeArns[2]');
        expect(u.ConditionExpression).toBe('pendingUnsubscribeArns[0] = :a0 AND pendingUnsubscribeArns[1] = :a1 AND pendingUnsubscribeArns[2] = :a2');
        expect(u.ExpressionAttributeValues).toEqual({ ':a0': A, ':a1': B, ':a2': C });
    });

    test('resubscribe: la vieja solo se borra si sigue siendo suya; si no se sabe queda pendiente', async () => {
        snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: NEW });
        snsMock.on(UnsubscribeCommand).resolves({});
        // Otra cuenta la adoptó: no se borra ni se guarda.
        snsMock.on(GetSubscriptionAttributesCommand).resolves(policy('u-otro'));
        await notifications.resubscribe('u-1', 'nuevo@x.com', OLD);
        expect(snsMock.commandCalls(UnsubscribeCommand)).toHaveLength(0);
        expect(updates()).toHaveLength(1);
        // SNS no respondió: no se borra, queda pendiente para el siguiente login.
        snsMock.on(GetSubscriptionAttributesCommand).rejects(new Error('throttled'));
        ddbMock.resetHistory();
        await notifications.resubscribe('u-1', 'nuevo@x.com', OLD);
        expect(snsMock.commandCalls(UnsubscribeCommand)).toHaveLength(0);
        expect(updates()[1].ExpressionAttributeValues).toMatchObject({ ':arn': OLD });
    });

    test('subscribeUser saca de pendientes el ARN que SNS regresó; si la lista cambió no truena', async () => {
        snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: OLD });
        ddbMock.on(UpdateCommand, { UpdateExpression: 'SET notifySubscriptionArn = :a, notifyEmail = :e' })
            .resolves({ Attributes: { pendingUnsubscribeArns: [`${TOPIC}:x`, OLD] } });
        expect(await notifications.subscribeUser('u-1', 'ana@x.com')).toBe(OLD);
        expect(updates()[1]).toMatchObject({
            UpdateExpression: 'REMOVE pendingUnsubscribeArns[1]', ConditionExpression: 'pendingUnsubscribeArns[1] = :a',
            ExpressionAttributeValues: { ':a': OLD },
        });
        ddbMock.on(UpdateCommand, { UpdateExpression: 'REMOVE pendingUnsubscribeArns[1]' })
            .rejects(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
        expect(await notifications.subscribeUser('u-1', 'ana@x.com')).toBe(OLD);
    });

    test('cleanupPending suelta el ARN vigente sin consultarlo ni borrarlo', async () => {
        const left = await notifications.cleanupPending({ userId: 'u-1', notifySubscriptionArn: OLD, pendingUnsubscribeArns: [OLD] });
        expect(left).toBe(0);
        expect(snsMock.calls()).toHaveLength(0);
        expect(updates()[0]).toMatchObject({ UpdateExpression: 'REMOVE pendingUnsubscribeArns[0]', ExpressionAttributeValues: { ':a0': OLD } });
    });

    test('afterLogin corre en segundo plano: limpia, reintenta la suscripción y nunca lanza', async () => {
        snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: NEW });
        // Sin suscripción: se reintenta después de responder (nada se llama en el mismo tick).
        expect(notifications.afterLogin({ userId: 'u-1', email: 'ana@x.com' })).toBeUndefined();
        expect(snsMock.calls()).toHaveLength(0);
        await notifications.settle();
        expect(snsMock.commandCalls(SubscribeCommand)[0].args[0].input).toMatchObject({ Endpoint: 'ana@x.com' });
        // Con suscripción vigente al correo actual solo se consulta que exista; no se reintenta.
        snsMock.on(GetSubscriptionAttributesCommand).resolves(policy('u-1'));
        snsMock.resetHistory();
        notifications.afterLogin({ userId: 'u-1', email: 'ana@x.com', notifySubscriptionArn: NEW });
        await notifications.settle();
        expect(snsMock.calls().map((c) => c.args[0].constructor.name)).toEqual(['GetSubscriptionAttributesCommand']);
        // Si SNS no responde no se sabe: tampoco se reintenta.
        snsMock.on(GetSubscriptionAttributesCommand).rejects(new Error('throttled'));
        snsMock.resetHistory();
        notifications.afterLogin({ userId: 'u-1', email: 'ana@x.com', notifyEmail: 'ana@x.com', notifySubscriptionArn: NEW });
        await notifications.settle();
        expect(snsMock.commandCalls(SubscribeCommand)).toHaveLength(0);
        // Un error inesperado se registra y no queda como promesa rechazada.
        notifications.afterLogin({ userId: 'u-1', email: 'ana@x.com', get pendingUnsubscribeArns() { throw new Error('boom'); } });
        await expect(notifications.settle()).resolves.toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith('Falló una tarea de avisos en segundo plano', 'Error');
        // Sin tema SNS no hace nada.
        config.userTopicArn = undefined;
        snsMock.resetHistory();
        notifications.afterLogin({ userId: 'u-1', email: 'ana@x.com' });
        await notifications.settle();
        expect(snsMock.calls()).toHaveLength(0);
    });

    test('afterLogin resuscribe si notifyEmail no es el correo actual o si SNS ya borró la suscripción', async () => {
        snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: NEW });
        snsMock.on(UnsubscribeCommand).resolves({});
        snsMock.on(GetSubscriptionAttributesCommand).resolves(policy('u-1'));
        // notifyEmail viejo (falló la suscripción en el cambio de correo): se suscribe el actual y se retira la vieja.
        notifications.afterLogin({ userId: 'u-1', email: 'nuevo@x.com', notifyEmail: 'viejo@x.com', notifySubscriptionArn: OLD });
        await notifications.settle();
        expect(snsMock.commandCalls(SubscribeCommand)[0].args[0].input).toMatchObject({ Endpoint: 'nuevo@x.com' });
        expect(snsMock.commandCalls(UnsubscribeCommand)[0].args[0].input).toEqual({ SubscriptionArn: OLD });
        expect(updates()[0]).toMatchObject({
            ConditionExpression: 'email = :e AND notifySubscriptionArn = :old',
            ExpressionAttributeValues: { ':a': NEW, ':e': 'nuevo@x.com', ':old': OLD },
        });
        // Cuenta sin notifyEmail cuya suscripción ya no existe (nunca se confirmó): se resuscribe.
        snsMock.resetHistory();
        ddbMock.resetHistory();
        snsMock.on(GetSubscriptionAttributesCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFoundException' }));
        notifications.afterLogin({ userId: 'u-1', email: 'ana@x.com', notifySubscriptionArn: OLD });
        await notifications.settle();
        expect(snsMock.commandCalls(SubscribeCommand)[0].args[0].input).toMatchObject({ Endpoint: 'ana@x.com' });
        expect(snsMock.commandCalls(UnsubscribeCommand)).toHaveLength(0);
        expect(updates().map((u) => u.UpdateExpression)).toEqual(['SET notifySubscriptionArn = :a, notifyEmail = :e']);
    });

    test('el cliente SNS corta rápido: 2 intentos, 1 s de conexión y 2 s por petición', async () => {
        const client = require('../src/lib/aws').sns();
        expect(await client.config.maxAttempts()).toBe(2);
        const handler = await client.config.requestHandler.configProvider;
        expect(handler).toMatchObject({ connectionTimeout: 1000, requestTimeout: 2000 });
    });

    test('cleanupPending es tolerante: sin lista no llama a nada y un error de DynamoDB no truena', async () => {
        expect(await notifications.cleanupPending({ userId: 'u-1' })).toBe(0);
        expect(snsMock.calls()).toHaveLength(0);
        snsMock.on(GetSubscriptionAttributesCommand).resolves({ Attributes: { FilterPolicy: JSON.stringify({ audience: ['u-1', 'all'] }) } });
        snsMock.on(UnsubscribeCommand).resolves({});
        ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('cambió'), { name: 'ConditionalCheckFailedException' }));
        expect(await notifications.cleanupPending({ userId: 'u-1', pendingUnsubscribeArns: [OLD] })).toBe(1);
        config.userTopicArn = undefined;
        expect(await notifications.cleanupPending({ userId: 'u-1', pendingUnsubscribeArns: [OLD] })).toBe(1);
    });
});

describe('fotos: limpieza si falla DynamoDB', () => {
    afterEach(() => { config.uploadsBucket = undefined; });

    test('si el Update falla tras el PutObject se borra el objeto subido y se propaga el error', async () => {
        config.uploadsBucket = 'friomx-uploads-123456789012';
        s3Mock.on(PutObjectCommand).resolves({});
        s3Mock.on(DeleteObjectCommand).resolves({});
        ddbMock.on(UpdateCommand).rejects(new Error('ddb caído'));
        const file = { mimetype: 'image/png', buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]) };
        await expect(storage.saveProfileImage({ userId: 'u-1' }, file)).rejects.toThrow('ddb caído');
        const key = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Key;
        expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toEqual({ Bucket: config.uploadsBucket, Key: key });
        // Aunque el borrado también falle, el error que sale es el de DynamoDB.
        s3Mock.on(DeleteObjectCommand).rejects(new Error('s3 caído'));
        await expect(storage.saveProfileImage({ userId: 'u-1' }, file)).rejects.toThrow('ddb caído');
    });

    test('GET imagen informa available según UPLOADS_BUCKET', async () => {
        expect(await storage.getProfileImage({ userId: 'u-1' })).toEqual({ success: true, available: false, profileImage: null });
        config.uploadsBucket = 'friomx-uploads-123456789012';
        expect(await storage.getProfileImage({ userId: 'u-1' })).toEqual({ success: true, available: true, profileImage: null });
    });
});

describe('ranking: última semana sin weekId', () => {
    const now = new Date('2026-10-12T12:00:00Z'); // lunes 06:00 local
    const thisWeek = isoWeekId(now);
    const prev = isoWeekId(new Date(now.getTime() - 7 * 24 * 3600 * 1000));

    test('si la anterior no está cerrada regresa la más reciente cerrada (ignorando la en curso)', async () => {
        ddbMock.on(GetCommand, { Key: { weekId: prev } }).resolves({});
        ddbMock.on(GetCommand, { Key: { weekId: '2026-W39' } }).resolves({ Item: { weekId: '2026-W39', top: [{ rank: 1, userId: 'x', name: 'Ana', net: 5, prize: 1000 }] } });
        ddbMock.on(ScanCommand).resolvesOnce({ Items: [{ weekId: '2026-W38' }], LastEvaluatedKey: { weekId: '2026-W38' } })
            .resolvesOnce({ Items: [{ weekId: '2026-W39' }, { weekId: thisWeek }] });
        expect(await leaderboard.last({}, now)).toEqual({ weekId: '2026-W39', top: [{ rank: 1, name: 'Ana', net: 5, prize: 1000 }] });
    });

    test('si la anterior está cerrada no escanea', async () => {
        ddbMock.on(GetCommand, { Key: { weekId: prev } }).resolves({ Item: { weekId: prev, top: [] } });
        expect(await leaderboard.last({}, now)).toEqual({ weekId: prev, top: [] });
        expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    });

    test('sin ninguna cerrada da 404', async () => {
        ddbMock.on(GetCommand).resolves({});
        ddbMock.on(ScanCommand).resolves({ Items: [] });
        await expect(leaderboard.last({}, now)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
});

// ---------- Procesos reales: seed.js y apagado de server.js ----------

const ROOT = path.join(__dirname, '..', '..');
const run = (args, env, opts = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
        cwd: opts.cwd || ROOT, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; if (opts.onOut) opts.onOut(out, child); });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal, out, err }); });
});

describe('seed.js', () => {
    // DynamoDB apuntando a un puerto cerrado: si el script intentara escribir, fallaría distinto.
    const env = { DDB_ENDPOINT: 'http://127.0.0.1:9', APP_TZ: 'America/Mexico_City' };

    test('rechaza la semana en curso con un mensaje claro', async () => {
        const week = isoWeekId(new Date());
        const res = await run(['scripts/seed.js', '--week', week], env);
        expect(res.code).toBe(1);
        expect(res.err).toMatch(new RegExp(`--week ${week} es la semana en curso o una futura`));
    });

    test('rechaza una semana futura', async () => {
        const res = await run(['scripts/seed.js', '--week', '2099-W01'], env);
        expect(res.code).toBe(1);
        expect(res.err).toMatch(/semana en curso o una futura/);
    });
});

describe('server.js manda las métricas al apagar', () => {
    // CloudWatch falso en loopback: nunca sale a AWS real.
    async function fakeCloudWatch(respond) {
        const hits = [];
        const srv = http.createServer((req, res) => {
            let body = '';
            req.on('data', (d) => { body += d; });
            req.on('end', () => { hits.push(`${req.url} ${body}`); if (respond) res.end(); });
        });
        await new Promise((r) => srv.listen(0, '127.0.0.1', r));
        return { srv, hits, url: `http://127.0.0.1:${srv.address().port}` };
    }

    const start = (cw, signal) => {
        let sentAt = 0;
        const done = run(['server.js'], {
            PORT: '0', HOST: '127.0.0.1', JWT_SECRET: 'secreto-de-prueba', METRICS_ENABLED: 'true', AWS_REGION: 'us-east-1',
            AWS_ENDPOINT_URL_CLOUDWATCH: cw.url, AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_MAX_ATTEMPTS: '1',
        }, {
            cwd: path.join(__dirname, '..'),
            onOut: (out, child) => {
                const m = /puerto (\d+)/.exec(out);
                if (!m || sentAt) return;
                sentAt = -1;
                // Una petición para que haya algo que mandar, y luego la señal.
                http.get(`http://127.0.0.1:${m[1]}/api/no-existe`, (r) => {
                    r.resume();
                    r.on('end', () => { sentAt = Date.now(); child.kill(signal); });
                });
            },
        });
        return done.then((res) => ({ ...res, elapsed: Date.now() - sentAt }));
    };

    test('SIGTERM: hace PutMetricData antes de salir con código 0', async () => {
        const cw = await fakeCloudWatch(true);
        const res = await start(cw, 'SIGTERM');
        cw.srv.close();
        expect(res.code).toBe(0);
        expect(res.out).toMatch(/SIGTERM recibido/);
        expect(cw.hits.join('\n')).toMatch(/"Namespace":"FrioMx".*"ApiLatency"/);
    });

    test('SIGTERM: una petición en vuelo termina antes de salir', async () => {
        const cw = await fakeCloudWatch(true);
        let reply = null;
        let finish = null;
        const res = await run(['server.js'], {
            PORT: '0', HOST: '127.0.0.1', JWT_SECRET: 'secreto-de-prueba', METRICS_ENABLED: 'true', AWS_REGION: 'us-east-1',
            AWS_ENDPOINT_URL_CLOUDWATCH: cw.url, AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_MAX_ATTEMPTS: '1',
        }, {
            cwd: path.join(__dirname, '..'),
            onOut: (out, child) => {
                const m = /puerto (\d+)/.exec(out);
                if (m && !reply) {
                    // Cuerpo a medias: la petición sigue en vuelo cuando llega la señal.
                    // password numérico: login responde 401 sin consultar DynamoDB (no depende de .env).
                    const body = JSON.stringify({ email: 'nadie@x.com', password: 12345678 });
                    reply = new Promise((resolve) => {
                        const req = http.request({
                            host: '127.0.0.1', port: m[1], path: '/api/auth/login', method: 'POST', agent: false,
                            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                        }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
                        req.on('error', (e) => resolve(e.code));
                        req.write(body.slice(0, 5));
                        req.flushHeaders();
                        setTimeout(() => child.kill('SIGTERM'), 300);
                        finish = () => req.end(body.slice(5));
                    });
                }
                if (/SIGTERM recibido/.test(out) && finish) { const f = finish; finish = null; setTimeout(f, 200); }
            },
        });
        cw.srv.close();
        expect(res.code).toBe(0);
        expect(await reply).toBe(401);
    });

    test('SIGINT con CloudWatch colgado: sale a los ~3 s, no se queda esperando', async () => {
        const cw = await fakeCloudWatch(false);
        const res = await start(cw, 'SIGINT');
        cw.srv.closeAllConnections();
        cw.srv.close();
        expect(res.code).toBe(0);
        expect(cw.hits.join('\n')).toMatch(/"Namespace":"FrioMx".*"ApiLatency"/);
        expect(res.elapsed).toBeGreaterThanOrEqual(2900);
        expect(res.elapsed).toBeLessThan(6000);
    });
});
