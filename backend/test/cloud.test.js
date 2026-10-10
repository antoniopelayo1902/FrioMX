// Pruebas de las funciones de nube (recargas, ranking, fotos, avisos y métricas) contra DynamoDB Local.
// SQS, S3, SNS y CloudWatch se simulan con aws-sdk-client-mock: ninguna prueba toca AWS real.
// Se ejecutan solo si DDB_ENDPOINT está definido (por ejemplo http://localhost:8000).
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const ENDPOINT = process.env.DDB_ENDPOINT;
const suffix = crypto.randomBytes(4).toString('hex');
process.env.JWT_SECRET = 'secreto-de-prueba';
process.env.RECHARGE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/friomx-recharges';
process.env.UPLOADS_BUCKET = 'friomx-uploads-123456789012';
process.env.USER_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:friomx-user-notifications';
// Credenciales falsas solo para poder firmar URLs de S3 sin buscar credenciales reales.
process.env.AWS_ACCESS_KEY_ID = 'AKIAPRUEBA';
process.env.AWS_SECRET_ACCESS_KEY = 'secreto-falso';
delete process.env.AWS_PROFILE;
delete process.env.AWS_SESSION_TOKEN;
for (const [env, base] of Object.entries({
    TABLE_USERS: 'users', TABLE_USER_EMAILS: 'user-emails', TABLE_ACTIVITY: 'activity', TABLE_WEEKLY_STATS: 'weekly-stats',
    TABLE_RECHARGES: 'recharges', TABLE_GAME_ROUNDS: 'game-rounds', TABLE_LEADERBOARD: 'leaderboard',
})) {
    process.env[env] = `test-${suffix}-${base}`;
}

const request = require('supertest');
const { mockClient } = require('aws-sdk-client-mock');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const {
    SNSClient, SubscribeCommand, UnsubscribeCommand, GetSubscriptionAttributesCommand,
    ListSubscriptionsByTopicCommand, SetSubscriptionAttributesCommand,
} = require('@aws-sdk/client-sns');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { DynamoDBClient, CreateTableCommand, DeleteTableCommand } = require('@aws-sdk/client-dynamodb');
const { GetCommand, PutCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../src/lib/ddb');
const { config } = require('../src/config/env');
const { isoWeekId } = require('../src/lib/time');
const { isUuidVersion } = require('../src/lib/uuid');
const metrics = require('../src/services/metrics');
const notifications = require('../src/services/notificationService');
const { createApp } = require('../src/app');

const maybe = ENDPOINT ? describe : describe.skip;
const T = config.tables;
const S = (name) => ({ AttributeName: name, AttributeType: 'S' });
const hash = (name) => ({ KeySchema: [{ AttributeName: name, KeyType: 'HASH' }], AttributeDefinitions: [S(name)] });
const TABLES = [
    { TableName: T.users, ...hash('userId') },
    { TableName: T.userEmails, ...hash('email') },
    {
        TableName: T.activity, AttributeDefinitions: [S('userId'), S('sk')],
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    },
    {
        TableName: T.weeklyStats, AttributeDefinitions: [S('weekId'), S('userId')],
        KeySchema: [{ AttributeName: 'weekId', KeyType: 'HASH' }, { AttributeName: 'userId', KeyType: 'RANGE' }],
    },
    { TableName: T.recharges, ...hash('rechargeId') },
    { TableName: T.gameRounds, ...hash('gameId') },
    { TableName: T.leaderboard, ...hash('weekId') },
];

const sqsMock = mockClient(SQSClient);
const s3Mock = mockClient(S3Client);
const snsMock = mockClient(SNSClient);
const cwMock = mockClient(CloudWatchClient);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

maybe('Funciones de nube con DynamoDB Local', () => {
    let app;
    const admin = ENDPOINT && new DynamoDBClient({
        region: 'us-east-1', endpoint: ENDPOINT, credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    const saved = {};

    beforeAll(async () => {
        for (const t of TABLES) await admin.send(new CreateTableCommand({ ...t, BillingMode: 'PAY_PER_REQUEST' }));
        app = createApp({ authLimit: 1000, profileLimit: 1000 });
        Object.assign(saved, { q: config.rechargeQueueUrl, b: config.uploadsBucket, t: config.userTopicArn });
    });

    afterAll(async () => {
        for (const t of TABLES) await admin.send(new DeleteTableCommand({ TableName: t.TableName }));
    });

    beforeEach(() => {
        [sqsMock, s3Mock, snsMock, cwMock].forEach((m) => m.reset());
        sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm-1' });
        s3Mock.on(PutObjectCommand).resolves({});
        s3Mock.on(DeleteObjectCommand).resolves({});
        snsMock.on(SubscribeCommand).callsFake((input) => ({ SubscriptionArn: `${input.TopicArn}:${crypto.randomUUID()}` }));
        snsMock.on(UnsubscribeCommand).resolves({});
        config.rechargeQueueUrl = saved.q;
        config.uploadsBucket = saved.b;
        config.userTopicArn = saved.t;
        config.metricsEnabled = false;
    });

    // Las tareas de avisos del login corren en segundo plano: se esperan para no cruzarse entre pruebas.
    afterEach(() => notifications.settle());

    async function newPlayer(name = 'Jugador') {
        const email = `p${crypto.randomBytes(4).toString('hex')}@test.com`;
        const res = await request(app).post('/api/auth/register').send({ name, age: 21, email, password: 'contrasena1' });
        expect(res.status).toBe(201);
        return { token: res.body.token, id: res.body.user.id, email };
    }
    const auth = (token) => ({ Authorization: `Bearer ${token}` });
    const userRow = async (id) => (await ddb.send(new GetCommand({ TableName: T.users, Key: { userId: id } }))).Item;
    const recharge = (p, key = crypto.randomUUID(), packageId = 'p500') => request(app).post('/api/wallet/recharges')
        .set(auth(p.token)).set('Idempotency-Key', key).send({ packageId });

    // ---------- Recargas ----------

    describe('recargas', () => {
        test('paquetes fijos', async () => {
            const p = await newPlayer();
            const res = await request(app).get('/api/wallet/packages').set(auth(p.token));
            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ packageId: 'p500', chips: 500 }, { packageId: 'p1000', chips: 1000 }, { packageId: 'p2500', chips: 2500 }]);
            expect((await request(app).get('/api/wallet/packages')).status).toBe(401);
        });

        test('paquete inválido o clave de idempotencia inválida dan 400', async () => {
            const p = await newPlayer();
            expect((await recharge(p, crypto.randomUUID(), 'p999')).status).toBe(400);
            expect((await recharge(p, crypto.randomUUID(), '__proto__')).status).toBe(400);
            expect((await recharge(p, 'no-es-uuid')).status).toBe(400);
            const noKey = await request(app).post('/api/wallet/recharges').set(auth(p.token)).send({ packageId: 'p500' });
            expect(noKey.status).toBe(400);
            expect(noKey.body.code).toBe('VALIDATION_ERROR');
            expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
        });

        test('crea la recarga, la encola y se puede consultar por su id v5', async () => {
            const p = await newPlayer();
            const res = await recharge(p, crypto.randomUUID(), 'p1000');
            expect(res.status).toBe(202);
            expect(res.body.status).toBe('PENDING');
            expect(isUuidVersion(res.body.rechargeId, 5)).toBe(true);
            const calls = sqsMock.commandCalls(SendMessageCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({ QueueUrl: config.rechargeQueueUrl, MessageBody: JSON.stringify({ rechargeId: res.body.rechargeId }) });
            const got = await request(app).get(`/api/wallet/recharges/${res.body.rechargeId}`).set(auth(p.token));
            expect(got.status).toBe(200);
            expect(got.body).toMatchObject({ rechargeId: res.body.rechargeId, status: 'PENDING', chips: 1000, completedAt: null });
            expect(typeof got.body.createdAt).toBe('string');
            expect(await userRow(p.id)).toMatchObject({ rechargeCount: 1, balance: 1000 });
        });

        test('idempotencia: la misma clave regresa la misma recarga y no gasta otro cupo', async () => {
            const p = await newPlayer();
            const key = crypto.randomUUID();
            const a = await recharge(p, key);
            const b = await recharge(p, key);
            expect(b.status).toBe(202);
            expect(b.body.rechargeId).toBe(a.body.rechargeId);
            expect((await userRow(p.id)).rechargeCount).toBe(1);
            // Una PENDING se vuelve a encolar; el consumidor es idempotente.
            expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(2);
        });

        test('máximo 3 por día; el reintento de una ya creada con el cupo agotado da 202, no 429', async () => {
            const p = await newPlayer();
            const keys = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
            for (const k of keys) expect((await recharge(p, k)).status).toBe(202);
            const fourth = await recharge(p);
            expect(fourth.status).toBe(429);
            expect(fourth.body.code).toBe('DAILY_LIMIT');
            const retry = await recharge(p, keys[1]);
            expect(retry.status).toBe(202);
            expect((await userRow(p.id)).rechargeCount).toBe(3);
        });

        test('variante B: un día nuevo reinicia el contador', async () => {
            const p = await newPlayer();
            await ddb.send(new UpdateCommand({
                TableName: T.users, Key: { userId: p.id },
                UpdateExpression: 'SET rechargeDate = :d, rechargeCount = :c', ExpressionAttributeValues: { ':d': '2020-01-01', ':c': 3 },
            }));
            expect((await recharge(p)).status).toBe(202);
            expect(await userRow(p.id)).toMatchObject({ rechargeCount: 1 });
            expect((await userRow(p.id)).rechargeDate).not.toBe('2020-01-01');
        });

        test('dos recargas simultáneas en el primer uso del día pasan las dos', async () => {
            for (let i = 0; i < 3; i += 1) {
                const p = await newPlayer();
                const rs = await Promise.all([recharge(p), recharge(p)]);
                expect(rs.map((r) => r.status)).toEqual([202, 202]);
                expect((await userRow(p.id)).rechargeCount).toBe(2);
            }
        });

        test('la misma clave enviada a la vez crea una sola recarga', async () => {
            const p = await newPlayer();
            const key = crypto.randomUUID();
            const rs = await Promise.all([recharge(p, key), recharge(p, key), recharge(p, key)]);
            expect(rs.every((r) => r.status === 202)).toBe(true);
            expect(new Set(rs.map((r) => r.body.rechargeId)).size).toBe(1);
            expect((await userRow(p.id)).rechargeCount).toBe(1);
        });

        test('si SQS falla responde 503 y el reintento con la misma clave no cobra otro cupo', async () => {
            const p = await newPlayer();
            const key = crypto.randomUUID();
            sqsMock.on(SendMessageCommand).rejects(new Error('sqs caído'));
            const fail = await recharge(p, key);
            expect(fail.status).toBe(503);
            expect(fail.body.code).toBe('QUEUE_UNAVAILABLE');
            sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm-2' });
            const ok = await recharge(p, key);
            expect(ok.status).toBe(202);
            expect(ok.body.status).toBe('PENDING');
            expect((await userRow(p.id)).rechargeCount).toBe(1);
        });

        test('sin RECHARGE_QUEUE_URL responde 503 sin crear nada ni gastar cupo', async () => {
            const p = await newPlayer();
            config.rechargeQueueUrl = undefined;
            const res = await recharge(p);
            expect(res.status).toBe(503);
            expect(res.body).toEqual({ error: expect.any(String), code: 'QUEUE_UNAVAILABLE' });
            expect((await userRow(p.id)).rechargeCount).toBeUndefined();
            expect((await request(app).get('/api/wallet/packages').set(auth(p.token))).status).toBe(200);
        });

        test('estado FAILED a los 5 minutos y COMPLETED cuando el worker la acredita', async () => {
            const p = await newPlayer();
            const r = (await recharge(p)).body.rechargeId;
            const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
            await ddb.send(new UpdateCommand({ TableName: T.recharges, Key: { rechargeId: r }, UpdateExpression: 'SET createdAt = :c', ExpressionAttributeValues: { ':c': old } }));
            expect((await request(app).get(`/api/wallet/recharges/${r}`).set(auth(p.token))).body.status).toBe('FAILED');
            const done = new Date().toISOString();
            await ddb.send(new UpdateCommand({
                TableName: T.recharges, Key: { rechargeId: r },
                UpdateExpression: 'SET #s = :s, completedAt = :d', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'COMPLETED', ':d': done },
            }));
            const got = await request(app).get(`/api/wallet/recharges/${r}`).set(auth(p.token));
            expect(got.body).toMatchObject({ status: 'COMPLETED', completedAt: done });
        });

        test('recarga ajena 403, id que no es v5 400 e inexistente 404', async () => {
            const a = await newPlayer();
            const b = await newPlayer();
            const r = (await recharge(a)).body.rechargeId;
            expect((await request(app).get(`/api/wallet/recharges/${r}`).set(auth(b.token))).status).toBe(403);
            expect((await request(app).get(`/api/wallet/recharges/${crypto.randomUUID()}`).set(auth(a.token))).status).toBe(400);
            const ghost = r.slice(0, -4) + (r.endsWith('0000') ? '1111' : '0000');
            expect((await request(app).get(`/api/wallet/recharges/${ghost}`).set(auth(a.token))).status).toBe(404);
        });

        test('una recarga ajena con el mismo id da 403 al reintentar', async () => {
            const a = await newPlayer();
            const b = await newPlayer();
            const key = crypto.randomUUID();
            const r = (await recharge(a, key)).body.rechargeId;
            // Se fuerza el choque cambiando el dueño (no puede pasar con ids derivados del userId).
            await ddb.send(new UpdateCommand({ TableName: T.recharges, Key: { rechargeId: r }, UpdateExpression: 'SET userId = :u', ExpressionAttributeValues: { ':u': b.id } }));
            expect((await recharge(a, key)).status).toBe(403);
        });
    });

    // ---------- Ranking ----------

    describe('ranking', () => {
        const week = isoWeekId(new Date());
        const lastWeek = isoWeekId(new Date(Date.now() - 7 * 24 * 3600 * 1000));

        test('semana en curso: top 10 ordenado y mi posición', async () => {
            const me = await newPlayer('Yo');
            const rows = Array.from({ length: 12 }, (_, i) => ({ weekId: week, userId: `u-${String(i).padStart(2, '0')}`, name: `J${i}`, net: i * 10, gamesPlayed: 1 }));
            rows.push({ weekId: week, userId: 'u-empate', name: 'Empate', net: 110, gamesPlayed: 5 });
            rows.push({ weekId: week, userId: me.id, name: 'Yo', net: -5, gamesPlayed: 2 });
            for (const r of rows) await ddb.send(new PutCommand({ TableName: T.weeklyStats, Item: r }));
            const res = await request(app).get('/api/leaderboard/current').set(auth(me.token));
            expect(res.status).toBe(200);
            expect(res.body.weekId).toBe(week);
            expect(res.body.top).toHaveLength(10);
            expect(res.body.top[0]).toEqual({ rank: 1, name: 'Empate', net: 110 }); // empate en neto: más partidas primero
            expect(res.body.top[1]).toEqual({ rank: 2, name: 'J11', net: 110 });
            expect(res.body.top[0].userId).toBeUndefined();
            expect(res.body.me).toEqual({ rank: 14, net: -5, gamesPlayed: 2 });

            const nobody = await newPlayer();
            expect((await request(app).get('/api/leaderboard/current').set(auth(nobody.token))).body.me).toEqual({ rank: null, net: 0, gamesPlayed: 0 });
        });

        test('una jugada real aparece en el ranking en curso', async () => {
            const p = await newPlayer('Jugadora');
            await request(app).post('/api/games/roulette').set(auth(p.token)).send({ bets: [{ type: 'color', value: 'Rojo', amount: 10 }] });
            const res = await request(app).get('/api/leaderboard/current').set(auth(p.token));
            expect(res.body.me.gamesPlayed).toBe(1);
            expect(res.body.me.rank).not.toBeNull();
        });

        test('semana cerrada, validaciones y lista de semanas', async () => {
            const p = await newPlayer();
            expect((await request(app).get('/api/leaderboard/last').set(auth(p.token))).status).toBe(404);
            await ddb.send(new PutCommand({
                TableName: T.leaderboard,
                Item: { weekId: lastWeek, closedAt: new Date().toISOString(), top: [{ rank: 1, userId: 'u-1', name: 'Ana', net: 900, prize: 1000 }] },
            }));
            await ddb.send(new PutCommand({ TableName: T.leaderboard, Item: { weekId: '2025-W02', top: [] } }));
            const last = await request(app).get('/api/leaderboard/last').set(auth(p.token));
            expect(last.status).toBe(200);
            expect(last.body).toEqual({ weekId: lastWeek, top: [{ rank: 1, name: 'Ana', net: 900, prize: 1000 }] });
            // Sin la semana anterior cerrada, regresa la más reciente cerrada.
            await ddb.send(new DeleteCommand({ TableName: T.leaderboard, Key: { weekId: lastWeek } }));
            expect((await request(app).get('/api/leaderboard/last').set(auth(p.token))).body).toEqual({ weekId: '2025-W02', top: [] });
            await ddb.send(new PutCommand({
                TableName: T.leaderboard,
                Item: { weekId: lastWeek, closedAt: new Date().toISOString(), top: [{ rank: 1, userId: 'u-1', name: 'Ana', net: 900, prize: 1000 }] },
            }));
            expect((await request(app).get('/api/leaderboard/last?weekId=2025-W02').set(auth(p.token))).body).toEqual({ weekId: '2025-W02', top: [] });
            expect((await request(app).get('/api/leaderboard/last?weekId=2025-W03').set(auth(p.token))).status).toBe(404);
            expect((await request(app).get(`/api/leaderboard/last?weekId=${week}`).set(auth(p.token))).status).toBe(400);
            expect((await request(app).get('/api/leaderboard/last?weekId=2025-W99').set(auth(p.token))).status).toBe(400);
            expect((await request(app).get('/api/leaderboard/last?weekId=a&weekId=b').set(auth(p.token))).status).toBe(400);
            const weeks = await request(app).get('/api/leaderboard/weeks').set(auth(p.token));
            expect(weeks.body).toEqual([lastWeek, '2025-W02']);
        });
    });

    // ---------- Fotos de perfil ----------

    describe('fotos', () => {
        const upload = (p, buf, name = 'foto.png', type = 'image/png', field = 'profileImage') => request(app)
            .post('/api/profile/upload').set(auth(p.token)).attach(field, buf, { filename: name, contentType: type });

        test('sube, firma 15 min, reemplaza borrando la anterior y elimina', async () => {
            const p = await newPlayer();
            const first = await upload(p, PNG);
            expect(first.status).toBe(200);
            expect(first.body.success).toBe(true);
            expect(first.body.profileImage).toContain('X-Amz-Expires=900');
            expect(first.body.profileImage).toContain(config.uploadsBucket);
            const put1 = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
            expect(put1.Key).toMatch(new RegExp(`^profile-images/${p.id}/\\d+-[0-9a-f-]{36}\\.png$`));
            expect(put1).toMatchObject({ Bucket: config.uploadsBucket, ContentType: 'image/png' });

            const prof = await request(app).get('/api/user/profile').set(auth(p.token));
            expect(prof.body.profileImageUrl).toContain(encodeURIComponent(put1.Key).replace(/%2F/g, '/'));

            const second = await upload(p, JPG, 'otra.jpg', 'image/jpeg');
            expect(second.status).toBe(200);
            expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toEqual({ Bucket: config.uploadsBucket, Key: put1.Key });
            const put2 = s3Mock.commandCalls(PutObjectCommand)[1].args[0].input;
            expect(put2.Key).toMatch(/\.jpg$/);
            expect((await userRow(p.id)).profileImageKey).toBe(put2.Key);

            const img = await request(app).get('/api/profile/image').set(auth(p.token));
            expect(img.body).toMatchObject({ success: true, available: true });
            expect(img.body.profileImage).toContain('X-Amz-Signature=');

            const del = await request(app).delete('/api/profile/delete').set(auth(p.token));
            expect(del.body).toEqual({ success: true });
            expect(s3Mock.commandCalls(DeleteObjectCommand)[1].args[0].input.Key).toBe(put2.Key);
            expect((await request(app).get('/api/user/profile').set(auth(p.token))).body.profileImageUrl).toBeNull();
            expect((await request(app).get('/api/profile/image').set(auth(p.token))).body).toEqual({ success: true, available: true, profileImage: null });
        });

        test('si no se puede borrar la foto anterior la subida sigue bien', async () => {
            const p = await newPlayer();
            await upload(p, PNG);
            s3Mock.on(DeleteObjectCommand).rejects(new Error('s3 caído'));
            expect((await upload(p, PNG)).status).toBe(200);
        });

        test('más de 5 MB, tipo no permitido, bytes que no son imagen, sin archivo o campo equivocado dan 400', async () => {
            const p = await newPlayer();
            const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
            const cases = [
                await upload(p, big),
                await upload(p, Buffer.from('hola'), 'nota.txt', 'text/plain'),
                await upload(p, Buffer.from('<html><script>alert(1)</script></html>'), 'falsa.png', 'image/png'),
                await upload(p, PNG, 'foto.png', 'image/png', 'otraCosa'),
                await request(app).post('/api/profile/upload').set(auth(p.token)).field('x', '1'),
            ];
            for (const r of cases) {
                expect(r.status).toBe(400);
                expect(r.body.code).toBe('VALIDATION_ERROR');
            }
            expect(cases[0].body.error).toMatch(/5 MB/);
            expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
        });

        test('sin UPLOADS_BUCKET: subir y borrar dan 503 NOT_AVAILABLE y la imagen es null', async () => {
            const p = await newPlayer();
            config.uploadsBucket = undefined;
            const up = await upload(p, PNG);
            expect(up.status).toBe(503);
            expect(up.body.code).toBe('NOT_AVAILABLE');
            expect((await request(app).delete('/api/profile/delete').set(auth(p.token))).status).toBe(503);
            expect((await request(app).get('/api/profile/image').set(auth(p.token))).body).toEqual({ success: true, available: false, profileImage: null });
            expect((await request(app).get('/api/user/profile').set(auth(p.token))).body.profileImageUrl).toBeNull();
            expect(s3Mock.calls()).toHaveLength(0);
        });
    });

    // ---------- Avisos SNS ----------

    describe('avisos SNS', () => {
        test('el registro suscribe el correo con filtro por jugador y guarda el ARN', async () => {
            const p = await newPlayer();
            const call = snsMock.commandCalls(SubscribeCommand)[0].args[0].input;
            expect(call).toMatchObject({ TopicArn: config.userTopicArn, Protocol: 'email', Endpoint: p.email, ReturnSubscriptionArn: true });
            expect(JSON.parse(call.Attributes.FilterPolicy)).toEqual({ audience: [p.id, 'all'] });
            expect((await userRow(p.id)).notifySubscriptionArn).toMatch(/^arn:aws:sns:/);
        });

        test('cambiar el correo suscribe el nuevo y quita el viejo, aunque Unsubscribe falle', async () => {
            const p = await newPlayer();
            const oldArn = (await userRow(p.id)).notifySubscriptionArn;
            snsMock.on(GetSubscriptionAttributesCommand).resolves({ Attributes: { FilterPolicy: JSON.stringify({ audience: [p.id, 'all'] }) } });
            snsMock.on(UnsubscribeCommand).rejects(new Error('pendiente de confirmar'));
            const res = await request(app).put('/api/user/profile').set(auth(p.token))
                .send({ field: 'email', newValue: `n${p.email}`, currentPassword: 'contrasena1' });
            expect(res.status).toBe(200);
            const subs = snsMock.commandCalls(SubscribeCommand);
            expect(subs[subs.length - 1].args[0].input.Endpoint).toBe(`n${p.email}`);
            expect(snsMock.commandCalls(UnsubscribeCommand)[0].args[0].input).toEqual({ SubscriptionArn: oldArn });
            const row = await userRow(p.id);
            expect(row.notifySubscriptionArn).not.toBe(oldArn);
            expect(row.pendingUnsubscribeArns).toEqual([oldArn]);

            // Siguiente login: si la vieja sigue siendo suya y ahora sí se puede borrar, se limpia.
            snsMock.on(GetSubscriptionAttributesCommand).resolves({ Attributes: { FilterPolicy: JSON.stringify({ audience: [p.id, 'all'] }) } });
            snsMock.on(UnsubscribeCommand).resolves({});
            const login = await request(app).post('/api/auth/login').send({ email: `n${p.email}`, password: 'contrasena1' });
            expect(login.status).toBe(200);
            await notifications.settle();
            expect(snsMock.commandCalls(UnsubscribeCommand).filter((c) => c.args[0].input.SubscriptionArn === oldArn)).toHaveLength(2);
            expect((await userRow(p.id)).pendingUnsubscribeArns).toEqual([]);
        });

        test('el login no falla si la limpieza pendiente sigue fallando, y la lista se conserva', async () => {
            const p = await newPlayer();
            const oldArn = (await userRow(p.id)).notifySubscriptionArn;
            snsMock.on(UnsubscribeCommand).rejects(new Error('pendiente'));
            snsMock.on(GetSubscriptionAttributesCommand).resolves({ Attributes: { FilterPolicy: JSON.stringify({ audience: [p.id, 'all'] }) } });
            await request(app).put('/api/user/profile').set(auth(p.token))
                .send({ field: 'email', newValue: `n${p.email}`, currentPassword: 'contrasena1' });
            const login = await request(app).post('/api/auth/login').send({ email: `n${p.email}`, password: 'contrasena1' });
            expect(login.status).toBe(200);
            await notifications.settle();
            expect((await userRow(p.id)).pendingUnsubscribeArns).toEqual([oldArn]);
        });

        test('volver al correo anterior: el ARN vigente sale de pendientes y el login no lo borra', async () => {
            const p = await newPlayer();
            const sx = (await userRow(p.id)).notifySubscriptionArn;
            snsMock.on(GetSubscriptionAttributesCommand).resolves({ Attributes: { FilterPolicy: JSON.stringify({ audience: [p.id, 'all'] }) } });
            snsMock.on(UnsubscribeCommand).rejects(new Error('pendiente de confirmar'));
            await request(app).put('/api/user/profile').set(auth(p.token))
                .send({ field: 'email', newValue: `n${p.email}`, currentPassword: 'contrasena1' });
            expect((await userRow(p.id)).pendingUnsubscribeArns).toEqual([sx]);
            // De regreso a X: SNS devuelve el mismo ARN porque los atributos son iguales.
            snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: sx });
            await request(app).put('/api/user/profile').set(auth(p.token))
                .send({ field: 'email', newValue: p.email, currentPassword: 'contrasena1' });
            let row = await userRow(p.id);
            expect(row.notifySubscriptionArn).toBe(sx);
            expect(row.pendingUnsubscribeArns).not.toContain(sx);
            snsMock.on(UnsubscribeCommand).resolves({});
            snsMock.resetHistory();
            await request(app).post('/api/auth/login').send({ email: p.email, password: 'contrasena1' });
            await notifications.settle();
            expect(snsMock.commandCalls(UnsubscribeCommand).filter((c) => c.args[0].input.SubscriptionArn === sx)).toHaveLength(0);
            row = await userRow(p.id);
            expect(row.notifySubscriptionArn).toBe(sx);
        });

        test('cuenta sin suscripción: el login la reintenta en segundo plano y no espera a SNS', async () => {
            snsMock.on(SubscribeCommand).rejects(new Error('sns caído'));
            const p = await newPlayer();
            expect((await userRow(p.id)).notifySubscriptionArn).toBeUndefined();
            const arn = `${config.userTopicArn}:${crypto.randomUUID()}`;
            // SNS lento: la respuesta del login no lo espera.
            snsMock.on(SubscribeCommand).callsFake(() => new Promise((r) => setTimeout(() => r({ SubscriptionArn: arn }), 1500)));
            const t0 = Date.now();
            const login = await request(app).post('/api/auth/login').send({ email: p.email, password: 'contrasena1' });
            expect(login.status).toBe(200);
            expect(Date.now() - t0).toBeLessThan(1200);
            await notifications.settle();
            expect(snsMock.commandCalls(SubscribeCommand).at(-1).args[0].input.Endpoint).toBe(p.email);
            expect((await userRow(p.id)).notifySubscriptionArn).toBe(arn);
        });

        test('cambio de correo: si otra cuenta adoptó la suscripción vieja no se borra', async () => {
            const p = await newPlayer();
            const oldArn = (await userRow(p.id)).notifySubscriptionArn;
            snsMock.on(GetSubscriptionAttributesCommand).resolves({ Attributes: { FilterPolicy: JSON.stringify({ audience: ['otra-cuenta', 'all'] }) } });
            const res = await request(app).put('/api/user/profile').set(auth(p.token))
                .send({ field: 'email', newValue: `n${p.email}`, currentPassword: 'contrasena1' });
            expect(res.status).toBe(200);
            expect(snsMock.commandCalls(UnsubscribeCommand)).toHaveLength(0);
            const row = await userRow(p.id);
            expect(row.notifySubscriptionArn).not.toBe(oldArn);
            expect(row.pendingUnsubscribeArns).toBeUndefined();
        });

        test('si el Subscribe del correo nuevo falla, la vieja se retira y el siguiente login suscribe el nuevo', async () => {
            const p = await newPlayer();
            const oldArn = (await userRow(p.id)).notifySubscriptionArn;
            expect((await userRow(p.id)).notifyEmail).toBe(p.email);
            snsMock.on(GetSubscriptionAttributesCommand).resolves({ Attributes: { FilterPolicy: JSON.stringify({ audience: [p.id, 'all'] }) } });
            snsMock.on(SubscribeCommand).rejects(new Error('sns caído'));
            const res = await request(app).put('/api/user/profile').set(auth(p.token))
                .send({ field: 'email', newValue: `n${p.email}`, currentPassword: 'contrasena1' });
            expect(res.status).toBe(200);
            expect(snsMock.commandCalls(UnsubscribeCommand)[0].args[0].input).toEqual({ SubscriptionArn: oldArn });
            let row = await userRow(p.id);
            expect(row.notifySubscriptionArn).toBe(oldArn);
            expect(row.notifyEmail).toBe(p.email);

            const arn = `${config.userTopicArn}:${crypto.randomUUID()}`;
            snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: arn });
            const login = await request(app).post('/api/auth/login').send({ email: `n${p.email}`, password: 'contrasena1' });
            expect(login.status).toBe(200);
            await notifications.settle();
            row = await userRow(p.id);
            expect(row.notifySubscriptionArn).toBe(arn);
            expect(row.notifyEmail).toBe(`n${p.email}`);
        });

        test('cuenta antigua sin notifyEmail: si falla el cambio de correo, el login lo reintenta', async () => {
            const p = await newPlayer();
            const oldArn = (await userRow(p.id)).notifySubscriptionArn;
            await ddb.send(new UpdateCommand({ TableName: T.users, Key: { userId: p.id }, UpdateExpression: 'REMOVE notifyEmail' }));
            snsMock.on(GetSubscriptionAttributesCommand).resolves({ Attributes: { FilterPolicy: JSON.stringify({ audience: [p.id, 'all'] }) } });
            snsMock.on(SubscribeCommand).rejects(new Error('sns caído'));
            await request(app).put('/api/user/profile').set(auth(p.token))
                .send({ field: 'email', newValue: `n${p.email}`, currentPassword: 'contrasena1' });
            expect((await userRow(p.id)).notifyEmail).toBe(p.email);
            snsMock.on(SubscribeCommand).callsFake((input) => ({ SubscriptionArn: `${input.TopicArn}:${crypto.randomUUID()}` }));
            await request(app).post('/api/auth/login').send({ email: `n${p.email}`, password: 'contrasena1' });
            await notifications.settle();
            const row = await userRow(p.id);
            expect(row.notifySubscriptionArn).not.toBe(oldArn);
            expect(row.notifyEmail).toBe(`n${p.email}`);
        });

        test('login: una suscripción que SNS ya borró (sin confirmar) se vuelve a crear', async () => {
            const p = await newPlayer();
            const oldArn = (await userRow(p.id)).notifySubscriptionArn;
            snsMock.on(GetSubscriptionAttributesCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFoundException' }));
            snsMock.resetHistory();
            await request(app).post('/api/auth/login').send({ email: p.email, password: 'contrasena1' });
            await notifications.settle();
            expect(snsMock.commandCalls(SubscribeCommand).at(-1).args[0].input.Endpoint).toBe(p.email);
            const row = await userRow(p.id);
            expect(row.notifySubscriptionArn).not.toBe(oldArn);
            expect(row.pendingUnsubscribeArns).toBeUndefined();
        });

        test('correo cuya suscripción quedó de otra cuenta: se adopta con el filtro nuevo', async () => {
            const leftover = `${config.userTopicArn}:${crypto.randomUUID()}`;
            const email = `p${crypto.randomBytes(4).toString('hex')}@test.com`;
            snsMock.on(SubscribeCommand).rejects(Object.assign(new Error('Invalid parameter: Attributes Reason: Subscription already exists with different attributes'), { name: 'InvalidParameterException' }));
            snsMock.on(ListSubscriptionsByTopicCommand).resolves({ Subscriptions: [{ Protocol: 'email', Endpoint: email, SubscriptionArn: leftover }] });
            snsMock.on(SetSubscriptionAttributesCommand).resolves({});
            const res = await request(app).post('/api/auth/register').send({ name: 'B', age: 21, email, password: 'contrasena1' });
            expect(res.status).toBe(201);
            const set = snsMock.commandCalls(SetSubscriptionAttributesCommand)[0].args[0].input;
            expect(JSON.parse(set.AttributeValue)).toEqual({ audience: [res.body.user.id, 'all'] });
            expect((await userRow(res.body.user.id)).notifySubscriptionArn).toBe(leftover);
        });

        test('seed.js: si Subscribe falla avisa y sigue, y quita < > del nombre', async () => {
            const email = `<s${crypto.randomBytes(3).toString('hex')}>@test.com`;
            const env = {
                PATH: process.env.PATH, DDB_ENDPOINT: ENDPOINT, APP_TZ: 'America/Mexico_City', SEED_PASSWORD: 'contrasena1',
                TABLE_USERS: T.users, TABLE_USER_EMAILS: T.userEmails, TABLE_WEEKLY_STATS: T.weeklyStats, TABLE_LEADERBOARD: T.leaderboard,
                // SNS en un puerto cerrado de loopback: el Subscribe falla sin salir a AWS.
                USER_TOPIC_ARN: config.userTopicArn, AWS_ENDPOINT_URL_SNS: 'http://127.0.0.1:9',
                AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', AWS_MAX_ATTEMPTS: '1',
            };
            const res = await new Promise((resolve) => {
                const child = spawn(process.execPath, ['scripts/seed.js', '--week', '2020-W10', '--players', '1', '--include-email', email], {
                    cwd: path.join(__dirname, '..', '..'), env, stdio: ['ignore', 'pipe', 'pipe'],
                });
                let out = ''; let err = '';
                child.stdout.on('data', (d) => { out += d; });
                child.stderr.on('data', (d) => { err += d; });
                const t = setTimeout(() => child.kill('SIGKILL'), 15000);
                child.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
            });
            expect(res.code).toBe(0);
            expect(res.err).toMatch(/no se pudo suscribir/);
            const idx = (await ddb.send(new GetCommand({ TableName: T.userEmails, Key: { email } }))).Item;
            const row = await userRow(idx.userId);
            expect(row.name).toBe(email.split('@')[0].slice(1, -1));
            expect(row.notifySubscriptionArn).toBeUndefined();
            const stats = await ddb.send(new GetCommand({ TableName: T.weeklyStats, Key: { weekId: '2020-W10', userId: idx.userId } }));
            expect(stats.Item).toBeTruthy();
        });

        test('si SNS falla la cuenta se crea sin suscripción; sin USER_TOPIC_ARN no se llama a SNS', async () => {
            snsMock.on(SubscribeCommand).rejects(new Error('sns caído'));
            const p = await newPlayer();
            expect((await userRow(p.id)).notifySubscriptionArn).toBeUndefined();
            snsMock.reset();
            config.userTopicArn = undefined;
            const q = await newPlayer();
            await request(app).put('/api/user/profile').set(auth(q.token))
                .send({ field: 'email', newValue: `z${q.email}`, currentPassword: 'contrasena1' });
            expect(snsMock.calls()).toHaveLength(0);
        });
    });

    // ---------- Métricas ----------

    describe('métricas', () => {
        test('con METRICS_ENABLED cuenta partidas por juego, latencia y las manda a CloudWatch', async () => {
            const p = await newPlayer();
            metrics.drain();
            config.metricsEnabled = true;
            cwMock.on(PutMetricDataCommand).resolves({});
            await request(app).post('/api/games/roulette').set(auth(p.token)).send({ bets: [{ type: 'color', value: 'Rojo', amount: 1 }] });
            const deal = await request(app).post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 1 });
            const pred = deal.body.options.higher ? 'higher' : 'lower';
            await request(app).post('/api/games/hi-lo').set(auth(p.token)).send({ roundId: deal.body.roundId, prediction: pred });
            expect(await metrics.flush()).toBe(1);
            const input = cwMock.commandCalls(PutMetricDataCommand)[0].args[0].input;
            expect(input.Namespace).toBe('FrioMx');
            const byName = (n) => input.MetricData.filter((d) => d.MetricName === n);
            expect(byName('GamesPlayed').map((d) => [d.Dimensions[0].Value, d.Value]).sort()).toEqual([['HiLo', 1], ['Roulette', 1]]);
            const lat = byName('ApiLatency')[0];
            expect(lat.Counts.reduce((a, b) => a + b, 0)).toBe(3);
            expect(lat.Values.every((x) => x % 10 === 0)).toBe(true);
            expect(byName('Api5xx')[0].Value).toBe(0);
        });

        test('sin METRICS_ENABLED no se llama a CloudWatch', async () => {
            const p = await newPlayer();
            await request(app).post('/api/games/roulette').set(auth(p.token)).send({ bets: [{ type: 'color', value: 'Rojo', amount: 1 }] });
            expect(await metrics.flush()).toBe(0);
            expect(cwMock.calls()).toHaveLength(0);
        });
    });
});
