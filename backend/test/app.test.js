// Pruebas de app.js y de todas las rutas con los servicios simulados (sin DynamoDB).
process.env.JWT_SECRET = 'secreto-de-prueba';

const request = require('supertest');
const { createApp } = require('../src/app');
const { config } = require('../src/config/env');
const { AppError } = require('../src/lib/errors');
const users = require('../src/services/userService');
const activity = require('../src/services/activityService');
const games = require('../src/services/gameService');
const wallet = require('../src/services/walletService');
const leaderboard = require('../src/services/leaderboardService');
const storage = require('../src/services/storageService');
const stream = require('../src/services/streamService');

const USER = { userId: 'u-1', name: 'Ana', balance: 750 };

// Sesión falsa: con cabecera Authorization pasa, sin ella responde 401 como el middleware real.
jest.mock('../src/middleware/auth', () => {
    const { AppError: Err } = jest.requireActual('../src/lib/errors');
    return {
        requireAuth: (req, res, next) => {
            if (!req.headers.authorization) return next(new Err(401, 'UNAUTHORIZED', 'No autorizado'));
            req.user = { userId: 'u-1', name: 'Ana', balance: 750 };
            req.userId = 'u-1';
            return next();
        },
    };
});
jest.mock('../src/services/userService');
jest.mock('../src/services/activityService');
jest.mock('../src/services/gameService');
jest.mock('../src/services/walletService');
jest.mock('../src/services/leaderboardService');
jest.mock('../src/services/streamService');
jest.mock('../src/services/storageService', () => ({
    enabled: jest.fn(),
    upload: jest.fn((req, res, next) => { req.file = { mimetype: 'image/png' }; next(); }),
    getProfileImage: jest.fn(),
    saveProfileImage: jest.fn(),
    deleteProfileImage: jest.fn(),
}));

const AUTH = { Authorization: 'Bearer token' };
const rng = () => 0;

describe('createApp', () => {
    test('falla si no está cargado el secreto JWT', () => {
        const saved = config.jwtSecret;
        config.jwtSecret = undefined;
        config.jwtSecretArn = 'arn:aws:secretsmanager:us-east-1:1:secret:jwt';
        try {
            expect(() => createApp()).toThrow('El secreto JWT no está cargado');
        } finally {
            config.jwtSecret = saved;
            config.jwtSecretArn = undefined;
        }
    });

    test('health, cabeceras de seguridad y no-store', async () => {
        const res = await request(createApp()).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok' });
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-powered-by']).toBeUndefined();
        expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    test('ruta desconocida responde 404 con el formato común', async () => {
        const res = await request(createApp()).get('/no-existe');
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Ruta no encontrada', code: 'NOT_FOUND' });
    });

    test('JSON mal formado responde 400', async () => {
        const res = await request(createApp()).post('/api/auth/login')
            .set('Content-Type', 'application/json').send('{"email":');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    test('cuerpo de más de 10 kB responde 413', async () => {
        const res = await request(createApp()).post('/api/auth/login').send({ email: 'x'.repeat(11 * 1024) });
        expect(res.status).toBe(413);
        expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });
});

describe('rutas', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createApp({ rng, authLimit: 1000, profileLimit: 1000 });
    });

    describe('cuentas', () => {
        test('POST /auth/register responde 201 con mensaje', async () => {
            users.register.mockResolvedValue({ token: 't', user: { id: 'u-1' } });
            const res = await request(app).post('/api/auth/register').send({ name: 'Ana' });
            expect(res.status).toBe(201);
            expect(res.body).toEqual({ message: 'Usuario registrado con éxito.', token: 't', user: { id: 'u-1' } });
            expect(users.register).toHaveBeenCalledWith({ name: 'Ana' });
        });

        test('POST /auth/login responde lo del servicio', async () => {
            users.login.mockResolvedValue({ token: 't' });
            const res = await request(app).post('/api/auth/login').send({ email: 'a@b.com', password: 'x' });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ token: 't' });
        });

        test('los errores del servicio llegan al manejador central', async () => {
            users.login.mockRejectedValue(new AppError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos'));
            const res = await request(app).post('/api/auth/login').send({});
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ error: 'Correo o contraseña incorrectos', code: 'INVALID_CREDENTIALS' });
        });

        test('GET /auth/user-name sin sesión responde 401', async () => {
            const res = await request(app).get('/api/auth/user-name');
            expect(res.status).toBe(401);
        });

        test('GET /auth/user-name regresa el nombre', async () => {
            const res = await request(app).get('/api/auth/user-name').set(AUTH);
            expect(res.body).toEqual({ name: 'Ana' });
        });

        test('GET /user/profile', async () => {
            users.profileOf.mockResolvedValue({ id: 'u-1', name: 'Ana' });
            const res = await request(app).get('/api/user/profile').set(AUTH);
            expect(res.body).toEqual({ id: 'u-1', name: 'Ana' });
            expect(users.profileOf).toHaveBeenCalledWith(USER);
        });

        test('PUT /user/profile', async () => {
            users.updateProfile.mockResolvedValue({ id: 'u-1', name: 'Bea' });
            const body = { field: 'username', newValue: 'Bea' };
            const res = await request(app).put('/api/user/profile').set(AUTH).send(body);
            expect(res.body.name).toBe('Bea');
            expect(users.updateProfile).toHaveBeenCalledWith(USER, body);
        });

        test('GET /user/balance', async () => {
            const res = await request(app).get('/api/user/balance').set(AUTH);
            expect(res.body).toEqual({ balance: 750 });
        });

        test('GET /user/activity pasa la query', async () => {
            activity.listActivity.mockResolvedValue({ items: [], nextCursor: null });
            const res = await request(app).get('/api/user/activity?limit=5').set(AUTH);
            expect(res.status).toBe(200);
            expect(activity.listActivity).toHaveBeenCalledWith('u-1', { limit: '5' });
        });
    });

    describe('límites de intentos', () => {
        test('login: tras agotar los intentos fallidos responde 429', async () => {
            const limited = createApp({ rng, authLimit: 2, profileLimit: 1000 });
            users.login.mockRejectedValue(new AppError(401, 'INVALID_CREDENTIALS', 'x'));
            await request(limited).post('/api/auth/login').send({});
            await request(limited).post('/api/auth/login').send({});
            const res = await request(limited).post('/api/auth/login').send({});
            expect(res.status).toBe(429);
            expect(res.body).toEqual({ error: 'Demasiados intentos, espera un minuto', code: 'RATE_LIMITED' });
        });

        test('perfil: solo cuentan los 403 de contraseña incorrecta', async () => {
            const limited = createApp({ rng, authLimit: 1000, profileLimit: 1 });
            users.updateProfile.mockRejectedValueOnce(new AppError(400, 'VALIDATION_ERROR', 'nombre inválido'));
            expect((await request(limited).put('/api/user/profile').set(AUTH).send({})).status).toBe(400);
            users.updateProfile.mockRejectedValueOnce(new AppError(403, 'WRONG_PASSWORD', 'mal'));
            expect((await request(limited).put('/api/user/profile').set(AUTH).send({})).status).toBe(403);
            const res = await request(limited).put('/api/user/profile').set(AUTH).send({});
            expect(res.status).toBe(429);
        });
    });

    describe('foto de perfil', () => {
        test('GET /profile/image', async () => {
            storage.getProfileImage.mockResolvedValue({ success: true, available: false, profileImage: null });
            const res = await request(app).get('/api/profile/image').set(AUTH);
            expect(res.body.available).toBe(false);
        });

        test('sin bucket, subir y borrar responden 503', async () => {
            storage.enabled.mockReturnValue(false);
            for (const res of [
                await request(app).post('/api/profile/upload').set(AUTH),
                await request(app).delete('/api/profile/delete').set(AUTH),
            ]) {
                expect(res.status).toBe(503);
                expect(res.body.code).toBe('NOT_AVAILABLE');
            }
            expect(storage.saveProfileImage).not.toHaveBeenCalled();
            expect(storage.deleteProfileImage).not.toHaveBeenCalled();
        });

        test('con bucket, POST /profile/upload guarda el archivo', async () => {
            storage.enabled.mockReturnValue(true);
            storage.saveProfileImage.mockResolvedValue({ success: true, profileImage: 'https://x' });
            const res = await request(app).post('/api/profile/upload').set(AUTH);
            expect(res.body).toEqual({ success: true, profileImage: 'https://x' });
            expect(storage.saveProfileImage).toHaveBeenCalledWith(USER, { mimetype: 'image/png' });
        });

        test('con bucket, DELETE /profile/delete', async () => {
            storage.enabled.mockReturnValue(true);
            storage.deleteProfileImage.mockResolvedValue({ success: true });
            const res = await request(app).delete('/api/profile/delete').set(AUTH);
            expect(res.body).toEqual({ success: true });
        });
    });

    describe('recargas', () => {
        test('GET /wallet/packages', async () => {
            wallet.listPackages.mockReturnValue([{ id: 'p1' }]);
            const res = await request(app).get('/api/wallet/packages').set(AUTH);
            expect(res.body).toEqual([{ id: 'p1' }]);
        });

        test('POST /wallet/recharges responde 202 y pasa la Idempotency-Key', async () => {
            wallet.createRecharge.mockResolvedValue({ rechargeId: 'r1', status: 'PENDING' });
            const res = await request(app).post('/api/wallet/recharges').set(AUTH)
                .set('Idempotency-Key', 'k-1').send({ packageId: 'p1' });
            expect(res.status).toBe(202);
            expect(wallet.createRecharge).toHaveBeenCalledWith(USER, { packageId: 'p1' }, 'k-1');
        });

        test('GET /wallet/recharges/:id', async () => {
            wallet.getRecharge.mockResolvedValue({ rechargeId: 'r1' });
            await request(app).get('/api/wallet/recharges/r1').set(AUTH);
            expect(wallet.getRecharge).toHaveBeenCalledWith(USER, 'r1');
        });
    });

    describe('ranking', () => {
        test('current, last y weeks', async () => {
            leaderboard.current.mockResolvedValue({ weekId: '2026-W42' });
            leaderboard.last.mockResolvedValue({ weekId: '2026-W41' });
            leaderboard.weeks.mockResolvedValue({ weeks: [] });
            expect((await request(app).get('/api/leaderboard/current').set(AUTH)).body).toEqual({ weekId: '2026-W42' });
            expect((await request(app).get('/api/leaderboard/last?weekId=2026-W41').set(AUTH)).body).toEqual({ weekId: '2026-W41' });
            expect((await request(app).get('/api/leaderboard/weeks').set(AUTH)).body).toEqual({ weeks: [] });
            expect(leaderboard.current).toHaveBeenCalledWith(USER);
            expect(leaderboard.last).toHaveBeenCalledWith({ weekId: '2026-W41' });
        });
    });

    describe('juegos', () => {
        test('partidas activas', async () => {
            games.hiloActive.mockResolvedValue({ round: null });
            games.minesActive.mockResolvedValue({ round: null });
            expect((await request(app).get('/api/games/hi-lo/active').set(AUTH)).body).toEqual({ round: null });
            expect((await request(app).get('/api/games/mines/active').set(AUTH)).body).toEqual({ round: null });
        });

        test.each([
            ['post', '/api/games/hi-lo/deal', 'hiloDeal', 201],
            ['post', '/api/games/hi-lo', 'hiloPlay', 200],
            ['post', '/api/games/roulette', 'roulettePlay', 200],
            ['post', '/api/games/mines/start', 'minesStart', 201],
            ['post', '/api/games/mines/reveal', 'minesReveal', 200],
            ['post', '/api/games/mines/cashout', 'minesCashout', 200],
        ])('%s %s avisa el saldo nuevo y el cambio de ranking', async (method, path, fn, status) => {
            games[fn].mockResolvedValue({ newBalance: 640 });
            const body = { betAmount: 10 };
            const res = await request(app)[method](path).set(AUTH).send(body);
            expect(res.status).toBe(status);
            expect(res.body).toEqual({ newBalance: 640 });
            expect(games[fn]).toHaveBeenCalledWith(USER, body, rng);
            expect(stream.sendToUser).toHaveBeenCalledWith('u-1', 'balanceUpdate', { balance: 640 });
            expect(stream.broadcast).toHaveBeenCalledWith('leaderboardUpdate', expect.any(Object));
        });

        test('si la jugada falla no se manda ningún evento', async () => {
            games.roulettePlay.mockRejectedValue(new AppError(409, 'INSUFFICIENT_FUNDS', 'Sin fichas'));
            const res = await request(app).post('/api/games/roulette').set(AUTH).send({});
            expect(res.status).toBe(409);
            expect(stream.sendToUser).not.toHaveBeenCalled();
            expect(stream.broadcast).not.toHaveBeenCalled();
        });
    });

    test('GET /stream registra al cliente', async () => {
        stream.addClient.mockImplementation((userId, req, res) => res.end());
        await request(app).get('/api/stream').set(AUTH);
        expect(stream.addClient).toHaveBeenCalledWith('u-1', expect.anything(), expect.anything());
    });
});
