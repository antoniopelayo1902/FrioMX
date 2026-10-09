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
const { ScanCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
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
        app = createApp({ rng, authLimit: 1000, profileLimit: 1000 });
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
        const noPwd = await request(app).put('/api/user/profile').set(auth(p.token)).send({ field: 'email', newValue: `x${p.email}` });
        expect(noPwd.status).toBe(403);
        expect(noPwd.body.code).toBe('WRONG_PASSWORD');
        const changed = await request(app).put('/api/user/profile').set(auth(p.token))
            .send({ field: 'email', newValue: `x${p.email}`, currentPassword: 'contrasena1' });
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

    test('ruleta paga verde 35 a 1 y no deja apostar más que el saldo', async () => {
        const p = await newPlayer();
        queue = [0]; // sale el 0
        const res = await request(app).post('/api/games/roulette').set(auth(p.token)).send({
            bets: [{ type: 'color', value: 'Verde', amount: 100 }, { type: 'parity', value: 'par', amount: 50 }],
        });
        expect(res.status).toBe(200);
        expect(res.body.totalAmountChange).toBe(3500 - 50); // verde paga 35 a 1
        expect(res.body.newBalance).toBe(4450);
        expect(res.body.results.map((r) => r.change)).toEqual([3500, -50]);
        const tooMuch = await request(app).post('/api/games/roulette').set(auth(p.token))
            .send({ bets: [{ type: 'color', value: 'Rojo', amount: 5000 }] });
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
        // 20 de 20 paga 0.95 * C(25,20)/C(20,20) = 50473.5x, con tope de 1 000 000
        expect(last.body).toMatchObject({ result: 'safe', status: 'WON', newBalance: 800 + 1000000 });
    });

    test('minas: cobrar a mitad de partida paga el multiplicador y cierra la ronda', async () => {
        const p = await newPlayer();
        queue = [0, 1, 2, 3, 4];
        const g = await request(app).post('/api/games/mines/start').set(auth(p.token)).send({ betAmount: 100 });
        expect(g.body).toMatchObject({ multiplier: 1, nextMultiplier: 1.18, safeCount: 0 });
        const early = await request(app).post('/api/games/mines/cashout').set(auth(p.token)).send({ gameId: g.body.gameId });
        expect(early.status).toBe(400);
        const r1 = await request(app).post('/api/games/mines/reveal').set(auth(p.token)).send({ gameId: g.body.gameId, x: 3, y: 3 });
        expect(r1.body).toMatchObject({ status: 'ACTIVE', safeCount: 1, multiplier: 1.18 });
        await request(app).post('/api/games/mines/reveal').set(auth(p.token)).send({ gameId: g.body.gameId, x: 4, y: 4 });
        const before = await request(app).get('/api/games/mines/active').set(auth(p.token));
        expect(before.body.round).toMatchObject({ cashoutAmount: 150, nextCashoutAmount: 191 }); // 100 * 0.95 * 2300/1140
        const cash = await request(app).post('/api/games/mines/cashout').set(auth(p.token)).send({ gameId: g.body.gameId });
        expect(cash.status).toBe(200);
        expect(cash.body).toMatchObject({ status: 'CASHED', payout: 150, amountChange: 50, newBalance: 1050 });
        expect(cash.body.mines).toHaveLength(5);
        const again = await request(app).post('/api/games/mines/cashout').set(auth(p.token)).send({ gameId: g.body.gameId });
        expect(again.status).toBe(409);
        const hist = await request(app).get('/api/user/activity').set(auth(p.token));
        expect(hist.body.items[0]).toMatchObject({
            nameGame: 'Minas', bet: 100, balance: 50, result: 'GANADA', BetStatus: true, detail: 'Cobraste tras 2 casillas seguras',
        });
    });

    test('rondas activas: se retoman, no se abren dos y la abandonada queda en el historial', async () => {
        const p = await newPlayer();
        expect((await request(app).get('/api/games/hi-lo/active').set(auth(p.token))).body).toEqual({ round: null });
        queue = [7];
        const deal = await request(app).post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 30 });
        expect(deal.body.options.higher).toMatchObject({ multiplier: 2.09, payout: 62 }); // floor(30 * 0.95 * 11 / 5)
        const active = await request(app).get('/api/games/hi-lo/active').set(auth(p.token));
        expect(active.body.round).toMatchObject({ roundId: deal.body.roundId, oldCard: 7, bet: 30 });
        const second = await request(app).post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 30 });
        expect(second.status).toBe(409);
        expect(second.body).toMatchObject({ code: 'ROUND_ACTIVE', gameId: deal.body.roundId });
        expect(await balance(p.token)).toBe(970);
        const hist = await request(app).get('/api/user/activity').set(auth(p.token));
        expect(hist.body.items[0]).toMatchObject({ nameGame: 'Hi-Lo', bet: 30, balance: -30, result: 'EN_CURSO' });

        queue = [3, 1, 2, 3, 4];
        const mines = await request(app).post('/api/games/mines/start').set(auth(p.token)).send({ betAmount: 10 });
        await request(app).post('/api/games/mines/reveal').set(auth(p.token)).send({ gameId: mines.body.gameId, x: 4, y: 4 });
        const ma = await request(app).get('/api/games/mines/active').set(auth(p.token));
        expect(ma.body.round).toMatchObject({ gameId: mines.body.gameId, safeCount: 1, revealed: [{ x: 4, y: 4 }] });
        expect(ma.body.round.mines).toBeUndefined();

        queue = [7];
        const play = await request(app).post('/api/games/hi-lo').set(auth(p.token)).send({ roundId: deal.body.roundId, prediction: 'lower' });
        expect(play.body).toMatchObject({ won: false, tie: true });
        expect((await request(app).get('/api/games/hi-lo/active').set(auth(p.token))).body.round).toBeNull();
        const after = await request(app).get('/api/user/activity').set(auth(p.token));
        const hilo = after.body.items.filter((i) => i.nameGame === 'Hi-Lo');
        expect(hilo).toHaveLength(1);
        expect(hilo[0]).toMatchObject({ result: 'PERDIDA', balance: -30 });
    });

    test('concurrencia: 10 repartos simultáneos abren una sola ronda y cobran una sola vez', async () => {
        const p = await newPlayer();
        const res = await Promise.all(Array.from({ length: 10 }, () => request(app)
            .post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 100 })));
        expect(res.filter((r) => r.status === 201)).toHaveLength(1);
        expect(res.every((r) => r.status === 201 || r.status === 409)).toBe(true);
        expect(await balance(p.token)).toBe(900);
        const id = res.find((r) => r.status === 201).body.roundId;
        const plays = await Promise.all(Array.from({ length: 5 }, () => request(app)
            .post('/api/games/hi-lo').set(auth(p.token)).send({ roundId: id, prediction: 'higher' })));
        expect(plays.filter((r) => r.status === 200)).toHaveLength(1);
        expect(plays.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    });

    test('concurrencia: ruletas simultáneas nunca dejan saldo negativo', async () => {
        const p = await newPlayer();
        const res = await Promise.all(Array.from({ length: 15 }, () => request(app)
            .post('/api/games/roulette').set(auth(p.token)).send({ bets: [{ type: 'color', value: 'Negro', amount: 400 }] })));
        expect(res.every((r) => r.status === 200 || r.status === 409)).toBe(true);
        const b = await balance(p.token);
        expect(b).toBeGreaterThanOrEqual(0);
        const hist = await request(app).get('/api/user/activity?limit=50').set(auth(p.token));
        expect(hist.body.items.reduce((s, i) => s + i.balance, 0)).toBe(b - 1000);
    });

    test('concurrencia: cambios de correo simultáneos nunca dan 500', async () => {
        const p = await newPlayer();
        const res = await Promise.all(Array.from({ length: 5 }, (_, i) => request(app).put('/api/user/profile').set(auth(p.token))
            .send({ field: 'email', newValue: `alt${i}${p.email}`, currentPassword: 'contrasena1' })));
        expect(res.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
        expect(res.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    });

    test('cambiar contraseña pide la actual, entrega token nuevo e invalida el anterior', async () => {
        const p = await newPlayer();
        const wrong = await request(app).put('/api/user/profile').set(auth(p.token))
            .send({ field: 'password', newValue: 'nueva-clave-1', currentPassword: 'mala' });
        expect(wrong.status).toBe(403);
        const ok = await request(app).put('/api/user/profile').set(auth(p.token))
            .send({ field: 'password', newValue: 'nueva-clave-1', currentPassword: 'contrasena1' });
        expect(ok.status).toBe(200);
        expect(ok.body.token).toBeTruthy();
        expect((await request(app).get('/api/user/balance').set(auth(p.token))).status).toBe(401);
        expect((await request(app).get('/api/user/balance').set(auth(ok.body.token))).status).toBe(200);
        const login = await request(app).post('/api/auth/login').send({ email: p.email, password: 'nueva-clave-1' });
        expect(login.status).toBe(200);
    });

    test('validaciones: nombre con HTML, edad laxa y tipo de ruleta del prototipo', async () => {
        const p = await newPlayer();
        const xss = await request(app).put('/api/user/profile').set(auth(p.token))
            .send({ field: 'username', newValue: '<img src=x onerror=alert(1)>' });
        expect(xss.status).toBe(400);
        for (const age of ['0x19', [25], '25.0', true]) {
            const r = await request(app).post('/api/auth/register')
                .send({ name: 'Edad', age, email: `edad${crypto.randomBytes(3).toString('hex')}@test.com`, password: 'contrasena1' });
            expect(r.status).toBe(400);
        }
        const proto = await request(app).post('/api/games/roulette').set(auth(p.token))
            .send({ bets: [{ type: '__proto__', value: 'x', amount: 1 }] });
        expect(proto.status).toBe(400);
    });

    test('historial sin página vacía cuando el total es múltiplo del límite', async () => {
        const p = await newPlayer();
        for (let i = 0; i < 4; i += 1) {
            queue = [1];
            await request(app).post('/api/games/roulette').set(auth(p.token)).send({ bets: [{ type: 'color', value: 'Rojo', amount: 1 }] });
        }
        const p1 = await request(app).get('/api/user/activity?limit=2').set(auth(p.token));
        const p2 = await request(app).get(`/api/user/activity?limit=2&cursor=${p1.body.nextCursor}`).set(auth(p.token));
        expect(p2.body.items).toHaveLength(2);
        expect(p2.body.nextCursor).toBeNull();
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
    test('doble cambio de correo simultáneo nunca responde EMAIL_IN_USE con el correo propio', async () => {
        for (let i = 0; i < 4; i += 1) {
            const p = await newPlayer();
            const body = { field: 'email', newValue: `n${i}${p.email}`, currentPassword: 'contrasena1' };
            const rs = await Promise.all([1, 2, 3].map(() => request(app).put('/api/user/profile').set(auth(p.token)).send(body)));
            expect(rs.map((r) => r.body.code)).not.toContain('EMAIL_IN_USE');
            expect(rs.every((r) => r.status === 200 || r.body.code === 'CONFLICT')).toBe(true);
        }
    });

    test('repartir mientras se cierra la ronda nunca dice INSUFFICIENT_FUNDS con saldo de sobra', async () => {
        const p = await newPlayer();
        for (let i = 0; i < 10; i += 1) {
            const d = await request(app).post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 1 });
            const pred = d.body.options.higher ? 'higher' : 'lower';
            const rs = await Promise.all([
                request(app).post('/api/games/hi-lo').set(auth(p.token)).send({ roundId: d.body.roundId, prediction: pred }),
                ...Array.from({ length: 4 }, () => request(app).post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 1 })),
            ]);
            expect(rs.map((r) => r.body.code)).not.toContain('INSUFFICIENT_FUNDS');
            expect(rs.every((r) => r.status < 500)).toBe(true);
            const a = await request(app).get('/api/games/hi-lo/active').set(auth(p.token));
            if (a.body.round) {
                await request(app).post('/api/games/hi-lo').set(auth(p.token))
                    .send({ roundId: a.body.round.roundId, prediction: a.body.round.options.higher ? 'higher' : 'lower' });
            }
        }
    });

    test('ronda vencida: aparece como ABANDONADA y el puntero viejo no bloquea una nueva', async () => {
        const p = await newPlayer();
        const d = await request(app).post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 3 });
        const past = Math.floor(Date.now() / 1000) - 10;
        await ddb.send(new UpdateCommand({ TableName: T.gameRounds, Key: { gameId: d.body.roundId }, UpdateExpression: 'SET expiresAt = :e', ExpressionAttributeValues: { ':e': past } }));
        const sk = (await ddb.send(new GetCommand({ TableName: T.gameRounds, Key: { gameId: d.body.roundId } }))).Item.activitySk;
        const oldIso = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        await ddb.send(new UpdateCommand({ TableName: T.activity, Key: { userId: p.id, sk }, UpdateExpression: 'SET dateGame = :d', ExpressionAttributeValues: { ':d': oldIso } }));
        // Puntero aún "vivo" pero apuntando a una ronda vencida (datos desfasados): no debe dar ROUND_ACTIVE.
        expect((await request(app).get('/api/games/hi-lo/active').set(auth(p.token))).body.round).toBeNull();
        expect((await request(app).post('/api/games/hi-lo').set(auth(p.token)).send({ roundId: d.body.roundId, prediction: 'higher' })).status).toBe(404);
        const again = await request(app).post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 3 });
        expect(again.status).toBe(201);
        const h = await request(app).get('/api/user/activity').set(auth(p.token));
        expect(h.body.items.map((i) => i.result)).toEqual(['EN_CURSO', 'ABANDONADA']);
    });

    test('cerrar una ronda no borra el puntero de otra más nueva', async () => {
        const p = await newPlayer();
        queue = [7];
        const a = await request(app).post('/api/games/hi-lo/deal').set(auth(p.token)).send({ betAmount: 2 });
        // Se fuerza a que el puntero apunte a otra ronda (como si A se hubiera reemplazado).
        const fake = crypto.randomUUID();
        await ddb.send(new UpdateCommand({ TableName: T.users, Key: { userId: p.id }, UpdateExpression: 'SET activeHiloId = :f', ExpressionAttributeValues: { ':f': fake } }));
        await request(app).post('/api/games/hi-lo').set(auth(p.token)).send({ roundId: a.body.roundId, prediction: 'higher' });
        const user = (await ddb.send(new GetCommand({ TableName: T.users, Key: { userId: p.id } }))).Item;
        expect(user.activeHiloId).toBe(fake);
    });

    test('ronda de otro juego da 404, no "es de otro jugador"', async () => {
        const p = await newPlayer();
        const m = await request(app).post('/api/games/mines/start').set(auth(p.token)).send({ betAmount: 1 });
        const r = await request(app).post('/api/games/hi-lo').set(auth(p.token)).send({ roundId: m.body.gameId, prediction: 'higher' });
        expect(r.status).toBe(404);
    });

    test('minas: el multiplicador anunciado respeta el tope de pago', async () => {
        const p = await newPlayer();
        await ddb.send(new UpdateCommand({ TableName: T.users, Key: { userId: p.id }, UpdateExpression: 'SET balance = :b', ExpressionAttributeValues: { ':b': 20000 } }));
        queue = [0, 1, 2, 3, 4];
        const g = await request(app).post('/api/games/mines/start').set(auth(p.token)).send({ betAmount: 10000 });
        let last;
        for (let y = 0; y < 5; y += 1) for (const x of [1, 2, 3]) {
            last = await request(app).post('/api/games/mines/reveal').set(auth(p.token)).send({ gameId: g.body.gameId, x, y });
        }
        expect(last.body.safeCount).toBe(15);
        expect(last.body.multiplier).toBeLessThanOrEqual(100);
        expect(last.body.atCap).toBe(true);
        const cash = await request(app).post('/api/games/mines/cashout').set(auth(p.token)).send({ gameId: g.body.gameId });
        expect(cash.body.payout).toBe(1000000);
    });

    test('token con versión vieja, sin sub o con sub raro da 401', async () => {
        const jwt = require('jsonwebtoken');
        const p = await newPlayer();
        const bad = [
            jwt.sign({ sub: 123 }, 'secreto-de-prueba'),
            jwt.sign({ foo: 1 }, 'secreto-de-prueba'),
            jwt.sign({ sub: p.id, tv: 5 }, 'secreto-de-prueba'),
        ];
        for (const t of bad) expect((await request(app).get('/api/user/balance').set(auth(t))).status).toBe(401);
        const ok = jwt.sign({ sub: p.id, tv: 0 }, 'secreto-de-prueba');
        expect((await request(app).get('/api/user/balance').set(auth(ok))).status).toBe(200);
    });

    test('adivinar la contraseña actual se limita a 5 intentos por minuto por usuario', async () => {
        const fresh = createApp({ rng, authLimit: 1000 });
        const reg = await request(fresh).post('/api/auth/register')
            .send({ name: 'Lim', age: 30, email: `lim${crypto.randomBytes(3).toString('hex')}@test.com`, password: 'contrasena1' });
        const codes = [];
        for (let i = 0; i < 7; i += 1) {
            const r = await request(fresh).put('/api/user/profile').set(auth(reg.body.token))
                .send({ field: 'password', newValue: 'otra-clave-1', currentPassword: `mala${i}` });
            codes.push(r.status);
        }
        expect(codes.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
        expect(codes[6]).toBe(429);
        const cache = await request(fresh).get('/api/user/balance').set(auth(reg.body.token));
        expect(cache.headers['cache-control']).toBe('no-store');
    });

    test('validaciones nuevas: correo con etiqueta vacía y nombre invisible', async () => {
        const emoji = await request(app).post('/api/auth/register')
            .send({ name: 'Ana 👨‍👩‍👧', age: 25, email: `emo${crypto.randomBytes(3).toString('hex')}@test.com`, password: 'contrasena1' });
        expect(emoji.status).toBe(201);
        for (const [name, email] of [['Ok', 'a@b..'], ['\u200B\u200B', 'z1@test.com'], ['Ana\nBeta', 'z2@test.com'], ['Ana\u202Eevil', 'z3@test.com']]) {
            const r = await request(app).post('/api/auth/register').send({ name, age: 25, email, password: 'contrasena1' });
            expect(r.status).toBe(400);
        }
    });
});
