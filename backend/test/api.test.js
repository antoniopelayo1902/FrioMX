// Pruebas de la API completa contra DynamoDB Local.
// Se ejecutan solo si DDB_ENDPOINT está definido (por ejemplo http://localhost:8000).
const crypto = require('crypto');

const ENDPOINT = process.env.DDB_ENDPOINT;
const suffix = crypto.randomBytes(4).toString('hex');
process.env.JWT_SECRET = 'secreto-de-prueba';
for (const [env, base] of Object.entries({
    TABLE_USERS: 'users', TABLE_USER_EMAILS: 'user-emails', TABLE_ACTIVITY: 'activity',
    TABLE_WEEKLY_STATS: 'weekly-stats', TABLE_GAME_ROUNDS: 'game-rounds',
})) {
    process.env[env] = `test-${suffix}-${base}`;
}

const request = require('supertest');
const { DynamoDBClient, CreateTableCommand, DeleteTableCommand } = require('@aws-sdk/client-dynamodb');
const { ScanCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../src/lib/ddb');
const { config } = require('../src/config/env');
const { createApp } = require('../src/app');

const maybe = ENDPOINT ? describe : describe.skip;
const T = config.tables;

const S = (name) => ({ AttributeName: name, AttributeType: 'S' });
const TABLES = [
    { TableName: T.users, KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }], AttributeDefinitions: [S('userId')] },
    { TableName: T.userEmails, KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }], AttributeDefinitions: [S('email')] },
    {
        TableName: T.activity, AttributeDefinitions: [S('userId'), S('sk')],
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    },
    {
        TableName: T.weeklyStats, AttributeDefinitions: [S('weekId'), S('userId')],
        KeySchema: [{ AttributeName: 'weekId', KeyType: 'HASH' }, { AttributeName: 'userId', KeyType: 'RANGE' }],
    },
    { TableName: T.gameRounds, KeySchema: [{ AttributeName: 'gameId', KeyType: 'HASH' }], AttributeDefinitions: [S('gameId')] },
];

// Generador controlable: cada llamada toma el siguiente valor; si no hay, usa uno aleatorio.
let queue = [];
const rng = (min, max) => (queue.length ? queue.shift() : crypto.randomInt(min, max));

maybe('API FrioMx con DynamoDB Local', () => {
    let app;
    const admin = ENDPOINT && new DynamoDBClient({
        region: 'us-east-1', endpoint: ENDPOINT, credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });

    beforeAll(async () => {
        for (const t of TABLES) await admin.send(new CreateTableCommand({ ...t, BillingMode: 'PAY_PER_REQUEST' }));
        app = createApp({ rng, authLimit: 1000 });
    });

    afterAll(async () => {
        for (const t of TABLES) await admin.send(new DeleteTableCommand({ TableName: t.TableName }));
    });

    beforeEach(() => { queue = []; });

    async function newPlayer(email = `p${crypto.randomBytes(3).toString('hex')}@test.com`) {
        const res = await request(app).post('/api/auth/register')
            .send({ name: 'Jugador', age: '21', email, password: 'contrasena1' });
        expect(res.status).toBe(201);
        return { token: res.body.token, id: res.body.user.id, email };
    }
    const auth = (token) => ({ Authorization: `Bearer ${token}` });
    const balance = async (token) => (await request(app).get('/api/user/balance').set(auth(token))).body.balance;

    test('health', async () => {
        const res = await request(app).get('/api/health');
        expect(res.body).toEqual({ status: 'ok' });
    });

    test('registro da 1000 fichas y no permite correo duplicado', async () => {
        const p = await newPlayer('dup@test.com');
        expect(await balance(p.token)).toBe(1000);
        const again = await request(app).post('/api/auth/register')
            .send({ name: 'Otro', age: 30, email: 'DUP@test.com', password: 'contrasena1' });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('EMAIL_IN_USE');
    });

    test('login correcto e incorrecto', async () => {
        const p = await newPlayer();
        const ok = await request(app).post('/api/auth/login').send({ email: p.email, password: 'contrasena1' });
        expect(ok.status).toBe(200);
        expect(ok.body.user.id).toBe(p.id);
        const bad = await request(app).post('/api/auth/login').send({ email: p.email, password: 'otra-cosa' });
        expect(bad.status).toBe(401);
        expect(bad.body.code).toBe('INVALID_CREDENTIALS');
    });

    test('rutas protegidas sin token dan 401 y las rutas inseguras ya no existen', async () => {
        expect((await request(app).get('/api/user/balance')).status).toBe(401);
        const p = await newPlayer();
        expect((await request(app).put('/api/user/balance').set(auth(p.token)).send({ id: p.id, amount: 999 })).status).toBe(404);
        expect((await request(app).post('/api/user/activity').set(auth(p.token)).send({})).status).toBe(404);
        expect((await request(app).post('/api/games/mines').set(auth(p.token)).send({ betAmount: 1, won: true })).status).toBe(404);
    });

    test('el id del cliente se ignora: siempre responde el saldo del token', async () => {
        const a = await newPlayer();
        const b = await newPlayer();
        const res = await request(app).get(`/api/user/balance?id=${b.id}`).set(auth(a.token));
        expect(res.status).toBe(200);
        expect(res.body.balance).toBe(1000);
    });

    test('perfil no regresa contraseña y permite cambiar nombre y correo', async () => {
        const p = await newPlayer();
        const prof = await request(app).get('/api/user/profile').set(auth(p.token));
        expect(prof.body.passwordHash).toBeUndefined();
        expect(prof.body.password).toBeUndefined();
        const renamed = await request(app).put('/api/user/profile').set(auth(p.token)).send({ field: 'username', newValue: 'Nuevo' });
        expect(renamed.body.name).toBe('Nuevo');
        const same = await request(app).put('/api/user/profile').set(auth(p.token)).send({ field: 'email', newValue: p.email });
        expect(same.status).toBe(200);
        const changed = await request(app).put('/api/user/profile').set(auth(p.token)).send({ field: 'email', newValue: `x${p.email}` });
        expect(changed.body.email).toBe(`x${p.email}`);
        const login = await request(app).post('/api/auth/login').send({ email: `x${p.email}`, password: 'contrasena1' });
        expect(login.status).toBe(200);
    });

    test('hi-lo: el reparto cobra, la jugada paga y la ronda no se juega dos veces', async () => {
        const p = await newPlayer();
        queue = [7]; // carta visible
        const deal = await request(app).post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 100 });
        expect(deal.status).toBe(201);
        expect(deal.body.oldCard).toBe(7);
        expect(deal.body.newBalance).toBe(900);

        queue = [9]; // gana mayor: k=5 -> paga 209
        const play = await request(app).post('/api/games/hi-lo').set(auth(p.token))
            .send({ roundId: deal.body.roundId, prediction: 'higher' });
        expect(play.status).toBe(200);
        expect(play.body).toMatchObject({ won: true, oldCard: 7, newCard: 9, amountChange: 109, newBalance: 1109 });

        const again = await request(app).post('/api/games/hi-lo').set(auth(p.token))
            .send({ roundId: deal.body.roundId, prediction: 'higher' });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('GAME_FINISHED');
    });

    test('hi-lo: perder, ronda ajena, fondos insuficientes y k = 0', async () => {
        const a = await newPlayer();
        const b = await newPlayer();
        queue = [7];
        const deal = await request(app).post('/api/games/hi-lo/deal').set(auth(a.token)).send({ betAmount: 50 });
        expect((await request(app).post('/api/games/hi-lo').set(auth(b.token))
            .send({ roundId: deal.body.roundId, prediction: 'higher' })).status).toBe(403);
        queue = [7];
        const lost = await request(app).post('/api/games/hi-lo').set(auth(a.token))
            .send({ roundId: deal.body.roundId, prediction: 'higher' });
        expect(lost.body).toMatchObject({ won: false, amountChange: -50, newBalance: 950 });

        const broke = await request(app).post('/api/games/hi-lo/deal').set(auth(a.token)).send({ betAmount: 5000 });
        expect(broke.status).toBe(409);
        expect(broke.body.code).toBe('INSUFFICIENT_FUNDS');

        queue = [12];
        const d12 = await request(app).post('/api/games/hi-lo/deal').set(auth(a.token)).send({ betAmount: 10 });
        const k0 = await request(app).post('/api/games/hi-lo').set(auth(a.token))
            .send({ roundId: d12.body.roundId, prediction: 'higher' });
        expect(k0.status).toBe(400);
    });

    test('ruleta paga 1 a 1 y no deja apostar más que el saldo', async () => {
        const p = await newPlayer();
        queue = [0]; // sale el 0
        const res = await request(app).post('/api/games/roulette').set(auth(p.token)).send({
            bets: [{ type: 'color', value: 'Verde', amount: 100 }, { type: 'parity', value: 'par', amount: 50 }],
        });
        expect(res.status).toBe(200);
        expect(res.body.totalAmountChange).toBe(50);
        expect(res.body.newBalance).toBe(1050);
        const tooMuch = await request(app).post('/api/games/roulette').set(auth(p.token))
            .send({ bets: [{ type: 'color', value: 'Rojo', amount: 2000 }] });
        expect(tooMuch.status).toBe(409);
        const decimal = await request(app).post('/api/games/roulette').set(auth(p.token))
            .send({ bets: [{ type: 'color', value: 'Rojo', amount: 1.5 }] });
        expect(decimal.status).toBe(400);
    });

    test('minas: perder con una mina y ganar destapando las 20 seguras', async () => {
        const p = await newPlayer();
        queue = [0, 1, 2, 3, 4]; // minas en la primera fila (x = 0)
        const start = await request(app).post('/api/games/mines/start').set(auth(p.token)).send({ betAmount: 100 });
        expect(start.status).toBe(201);
        expect(start.body.newBalance).toBe(900);
        const boom = await request(app).post('/api/games/mines/reveal').set(auth(p.token))
            .send({ gameId: start.body.gameId, x: 0, y: 2 });
        expect(boom.body).toMatchObject({ result: 'mine', status: 'LOST', newBalance: 900 });
        expect(boom.body.mines).toHaveLength(5);
        const after = await request(app).post('/api/games/mines/reveal').set(auth(p.token))
            .send({ gameId: start.body.gameId, x: 1, y: 1 });
        expect(after.status).toBe(409);

        queue = [0, 1, 2, 3, 4];
        const g = await request(app).post('/api/games/mines/start').set(auth(p.token)).send({ betAmount: 100 });
        let last;
        for (let x = 1; x < 5; x += 1) {
            for (let y = 0; y < 5; y += 1) {
                last = await request(app).post('/api/games/mines/reveal').set(auth(p.token))
                    .send({ gameId: g.body.gameId, x, y });
                expect(last.status).toBe(200);
            }
        }
        expect(last.body).toMatchObject({ result: 'safe', status: 'WON', newBalance: 1100 });
    });

    test('historial paginado con cursor y cursor ajeno rechazado', async () => {
        const p = await newPlayer();
        for (let i = 0; i < 3; i += 1) {
            queue = [1];
            await request(app).post('/api/games/roulette').set(auth(p.token))
                .send({ bets: [{ type: 'color', value: 'Rojo', amount: 1 }] });
        }
        const page1 = await request(app).get('/api/user/activity?limit=2').set(auth(p.token));
        expect(page1.body.items).toHaveLength(2);
        expect(page1.body.items[0]).toMatchObject({ nameGame: 'Ruleta', balance: 1, BetStatus: true });
        expect(page1.body.nextCursor).toBeTruthy();
        const page2 = await request(app)
            .get(`/api/user/activity?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`).set(auth(p.token));
        expect(page2.body.items).toHaveLength(1);

        const other = await newPlayer();
        const stolen = await request(app)
            .get(`/api/user/activity?cursor=${encodeURIComponent(page1.body.nextCursor)}`).set(auth(other.token));
        expect(stolen.status).toBe(400);
    });

    test('estadística semanal suma el neto de todos los juegos', async () => {
        const p = await newPlayer();
        queue = [1];
        await request(app).post('/api/games/roulette').set(auth(p.token))
            .send({ bets: [{ type: 'color', value: 'Rojo', amount: 10 }] }); // +10
        queue = [7];
        const deal = await request(app).post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 20 });
        queue = [7];
        await request(app).post('/api/games/hi-lo').set(auth(p.token))
            .send({ roundId: deal.body.roundId, prediction: 'lower' }); // -20
        const rows = (await ddb.send(new ScanCommand({ TableName: T.weeklyStats }))).Items
            .filter((r) => r.userId === p.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ net: -10, gamesPlayed: 2, name: 'Jugador' });
        const user = (await ddb.send(new GetCommand({ TableName: T.users, Key: { userId: p.id } }))).Item;
        expect(user.balance).toBe(990);
    });

    test('errores de cliente con formato JSON', async () => {
        const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{no json');
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('VALIDATION_ERROR');
        const big = await request(app).post('/api/auth/login').send({ email: 'x'.repeat(20000), password: 'y' });
        expect(big.status).toBe(413);
        expect(big.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    test('el login fallido 11 en un minuto da 429 en JSON', async () => {
        const fresh = createApp({ rng });
        let res;
        for (let i = 0; i < 11; i += 1) {
            res = await request(fresh).post('/api/auth/login').send({ email: 'nadie@test.com', password: 'mala-clave' });
        }
        expect(res.status).toBe(429);
        expect(res.body.code).toBe('RATE_LIMITED');
    });
});
