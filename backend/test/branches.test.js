// Ramas sueltas: token por query (SSE), versión de sesión, valores por defecto y mapeo del historial.
process.env.JWT_SECRET = 'secreto-de-prueba';

const jwt = require('jsonwebtoken');
const { requireAuth } = require('../src/middleware/auth');
const { getUser } = require('../src/services/userService');
const { ddb } = require('../src/lib/ddb');
const { listActivity } = require('../src/services/activityService');
const { buildRouter } = require('../src/routes');
const { localDate, isoWeekId } = require('../src/lib/time');

jest.mock('../src/services/userService', () => ({ getUser: jest.fn() }));
jest.mock('../src/lib/ddb', () => ({ ddb: { send: jest.fn() } }));

const sign = (payload) => jwt.sign(payload, 'secreto-de-prueba', { algorithm: 'HS256' });

describe('requireAuth', () => {
    beforeEach(() => jest.clearAllMocks());

    // Corre el middleware y regresa el error que pasó a next (o undefined).
    async function run(req) {
        const next = jest.fn();
        await requireAuth({ headers: {}, query: {}, ...req }, {}, next);
        return { err: next.mock.calls[0][0], next };
    }

    test('sin cabecera ni query responde No autorizado', async () => {
        const { err } = await run({});
        expect(err).toMatchObject({ status: 401, message: 'No autorizado' });
    });

    test('acepta el token en la query (EventSource no manda cabeceras)', async () => {
        getUser.mockResolvedValue({ userId: 'u-1' });
        const req = { headers: {}, query: { token: sign({ sub: 'u-1' }) } };
        const next = jest.fn();
        await requireAuth(req, {}, next);
        expect(next).toHaveBeenCalledWith();
        expect(req.userId).toBe('u-1');
    });

    test('un token sin tv vale para un usuario sin tokenVersion', async () => {
        getUser.mockResolvedValue({ userId: 'u-1' });
        const { err } = await run({ headers: { authorization: `Bearer ${sign({ sub: 'u-1' })}` } });
        expect(err).toBeUndefined();
    });

    test('un token viejo tras cambiar la contraseña se rechaza', async () => {
        getUser.mockResolvedValue({ userId: 'u-1', tokenVersion: 1 });
        const { err } = await run({ headers: { authorization: `Bearer ${sign({ sub: 'u-1' })}` } });
        expect(err).toMatchObject({ status: 401, message: 'Tu contraseña cambió, inicia sesión de nuevo' });
    });

    test('un token firmado con otro algoritmo se rechaza', async () => {
        const token = jwt.sign({ sub: 'u-1' }, 'secreto-de-prueba', { algorithm: 'HS512' });
        const { err } = await run({ headers: { authorization: `Bearer ${token}` } });
        expect(err).toMatchObject({ message: 'Sesión inválida o expirada' });
        expect(getUser).not.toHaveBeenCalled();
    });
});

describe('listActivity', () => {
    beforeEach(() => jest.clearAllMocks());

    test('sin query usa 20 filas y deduce el resultado de BetStatus en filas viejas', async () => {
        ddb.send.mockResolvedValue({
            Items: [
                { nameGame: 'Ruleta', BetStatus: true, balance: 10, dateGame: '2026-01-01T00:00:00.000Z', bet: 10 },
                { nameGame: 'Ruleta', BetStatus: false, balance: -10, dateGame: '2026-01-01T00:00:00.000Z', bet: 10 },
            ],
        });
        const res = await listActivity('u-1');
        expect(ddb.send.mock.calls[0][0].input.Limit).toBe(21);
        expect(res.items.map((i) => i.result)).toEqual(['GANADA', 'PERDIDA']);
        expect(res.items[0].detail).toBeNull();
        expect(res.nextCursor).toBeNull();
    });

    test('sin Items regresa una página vacía', async () => {
        ddb.send.mockResolvedValue({});
        expect(await listActivity('u-1', { limit: '5' })).toEqual({ items: [], nextCursor: null });
    });

    test('una ronda EN_CURSO reciente sigue EN_CURSO', async () => {
        ddb.send.mockResolvedValue({ Items: [{ result: 'EN_CURSO', dateGame: new Date().toISOString() }] });
        const res = await listActivity('u-1');
        expect(res.items[0].result).toBe('EN_CURSO');
    });
});

test('buildRouter funciona sin opciones', () => {
    expect(typeof buildRouter()).toBe('function');
});

test('las fechas usan "ahora" por defecto', () => {
    expect(localDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isoWeekId()).toMatch(/^\d{4}-W\d{2}$/);
    expect(localDate(new Date('2026-10-09T03:00:00Z'), 'UTC')).toBe('2026-10-09');
});
