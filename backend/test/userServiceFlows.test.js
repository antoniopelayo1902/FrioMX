// Caminos de error de userService con validaciones y cancellationCodes reales.
process.env.JWT_SECRET = 'secreto-de-prueba';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { GetCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../src/lib/ddb');
const notifications = require('../src/services/notificationService');
const storage = require('../src/services/storageService');
const userService = require('../src/services/userService');

jest.mock('../src/lib/ddb', () => ({
    ...jest.requireActual('../src/lib/ddb'),
    ddb: { send: jest.fn() },
}));
jest.mock('../src/services/notificationService');
jest.mock('../src/services/storageService', () => ({ imageUrlOf: jest.fn().mockResolvedValue(null) }));

const canceled = (...codes) => Object.assign(new Error('cancelada'), {
    name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })),
});
const named = (name) => Object.assign(new Error(name), { name });

let HASH;
const user = (over = {}) => ({
    userId: 'u-1', name: 'Ana', age: 22, email: 'ana@iteso.mx', balance: 900, passwordHash: HASH, ...over,
});

beforeAll(async () => { HASH = await bcrypt.hash('clave-actual-1', 4); });
beforeEach(() => {
    ddb.send.mockReset();
    jest.clearAllMocks();
});

const BODY = { name: 'Ana', age: 22, email: 'Ana@Iteso.mx', password: 'clave-segura-1' };

describe('register', () => {
    test('correo repetido responde EMAIL_IN_USE', async () => {
        ddb.send.mockRejectedValue(canceled('ConditionalCheckFailed', 'None'));
        await expect(userService.register(BODY)).rejects.toMatchObject({ status: 409, code: 'EMAIL_IN_USE' });
        expect(notifications.subscribeUser).not.toHaveBeenCalled();
    });

    test('otro error de DynamoDB se propaga', async () => {
        ddb.send.mockRejectedValue(new Error('ddb caído'));
        await expect(userService.register(BODY)).rejects.toThrow('ddb caído');
    });

    test('el token es un JWT HS256 válido por 7 días con versión 0', async () => {
        ddb.send.mockResolvedValue({});
        const { token, user: pub } = await userService.register(BODY);
        const payload = jwt.verify(token, 'secreto-de-prueba', { algorithms: ['HS256'] });
        expect(payload).toMatchObject({ sub: pub.id, tv: 0 });
        expect(payload.exp - payload.iat).toBe(7 * 24 * 3600);
        expect(pub).not.toHaveProperty('passwordHash');
    });
});

describe('login', () => {
    test.each([
        [{}],
        [{ email: 'a@b.com', password: 12345678 }],
        [{ email: ['a@b.com'], password: 'x' }],
    ])('cuerpo %j responde INVALID_CREDENTIALS sin consultar DynamoDB', async (body) => {
        await expect(userService.login(body)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
        expect(ddb.send).not.toHaveBeenCalled();
    });

    test('sin argumentos responde INVALID_CREDENTIALS', async () => {
        await expect(userService.login()).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });

    test('correo inexistente responde lo mismo que contraseña incorrecta', async () => {
        ddb.send.mockResolvedValueOnce({});
        await expect(userService.login({ email: 'nadie@x.com', password: 'lo-que-sea' }))
            .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
        expect(ddb.send).toHaveBeenCalledTimes(1);
    });

    test('normaliza el correo y firma con la versión de sesión', async () => {
        ddb.send.mockResolvedValueOnce({ Item: { userId: 'u-1' } }).mockResolvedValueOnce({ Item: user({ tokenVersion: 3 }) });
        const { token } = await userService.login({ email: '  ANA@Iteso.MX ', password: 'clave-actual-1' });
        expect(ddb.send.mock.calls[0][0].input.Key).toEqual({ email: 'ana@iteso.mx' });
        expect(jwt.decode(token).tv).toBe(3);
        expect(notifications.afterLogin).toHaveBeenCalled();
    });
});

test('getUser regresa null si no existe', async () => {
    ddb.send.mockResolvedValueOnce({});
    expect(await userService.getUser('u-x')).toBeNull();
    expect(ddb.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
});

test('profileOf no expone el hash e incluye la URL de la foto', async () => {
    storage.imageUrlOf.mockResolvedValueOnce('https://foto');
    expect(await userService.profileOf(user())).toEqual({
        id: 'u-1', name: 'Ana', age: 22, email: 'ana@iteso.mx', balance: 900, profileImageUrl: 'https://foto',
    });
});

describe('updateProfile', () => {
    test('sin cuerpo responde Campo inválido', async () => {
        await expect(userService.updateProfile(user())).rejects.toMatchObject({ status: 400 });
    });

    describe('contraseña', () => {
        test('sin contraseña actual responde WRONG_PASSWORD', async () => {
            await expect(userService.updateProfile(user(), { field: 'password', newValue: 'nueva-clave-1' }))
                .rejects.toMatchObject({ status: 403, code: 'WRONG_PASSWORD' });
        });

        test('cambio simultáneo en otra sesión responde CONFLICT', async () => {
            ddb.send.mockRejectedValueOnce(named('ConditionalCheckFailedException'));
            await expect(userService.updateProfile(user({ tokenVersion: 2 }), {
                field: 'password', newValue: 'nueva-clave-1', currentPassword: 'clave-actual-1',
            })).rejects.toMatchObject({ code: 'CONFLICT' });
            expect(ddb.send.mock.calls[0][0].input.ExpressionAttributeValues).toMatchObject({ ':next': 3, ':cur': 2 });
        });

        test('otro error de DynamoDB se propaga', async () => {
            ddb.send.mockRejectedValueOnce(new Error('ddb caído'));
            await expect(userService.updateProfile(user(), {
                field: 'password', newValue: 'nueva-clave-1', currentPassword: 'clave-actual-1',
            })).rejects.toThrow('ddb caído');
        });
    });

    describe('correo', () => {
        const change = { field: 'email', newValue: 'nueva@iteso.mx', currentPassword: 'clave-actual-1' };

        test('el mismo correo no pide contraseña ni escribe nada', async () => {
            ddb.send.mockResolvedValueOnce({ Item: user() });
            const res = await userService.updateProfile(user(), { field: 'email', newValue: 'ANA@iteso.mx' });
            expect(res.email).toBe('ana@iteso.mx');
            expect(ddb.send).toHaveBeenCalledTimes(1);
            expect(notifications.resubscribe).not.toHaveBeenCalled();
        });

        test('cambio exitoso mueve el índice y resuscribe los avisos', async () => {
            const me = user({ notifySubscriptionArn: 'arn:sub', notifyEmail: 'avisos@iteso.mx' });
            ddb.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: user({ email: 'nueva@iteso.mx' }) });
            const res = await userService.updateProfile(me, change);
            expect(res.email).toBe('nueva@iteso.mx');
            const items = ddb.send.mock.calls[0][0].input.TransactItems;
            expect(ddb.send.mock.calls[0][0]).toBeInstanceOf(TransactWriteCommand);
            expect(items[0].Delete.Key).toEqual({ email: 'ana@iteso.mx' });
            expect(items[1].Put.Item).toEqual({ email: 'nueva@iteso.mx', userId: 'u-1' });
            expect(notifications.cleanupPending).toHaveBeenCalledWith(me);
            expect(notifications.resubscribe).toHaveBeenCalledWith('u-1', 'nueva@iteso.mx', 'arn:sub', 'avisos@iteso.mx');
        });

        test('sin notifyEmail resuscribe desde el correo actual', async () => {
            ddb.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: user() });
            await userService.updateProfile(user(), change);
            expect(notifications.resubscribe).toHaveBeenCalledWith('u-1', 'nueva@iteso.mx', undefined, 'ana@iteso.mx');
        });

        test('doble clic: si el correo ya quedó cambiado responde el perfil', async () => {
            ddb.send
                .mockRejectedValueOnce(canceled('ConditionalCheckFailed', 'None', 'None'))
                .mockResolvedValueOnce({ Item: user({ email: 'nueva@iteso.mx' }) });
            const res = await userService.updateProfile(user(), change);
            expect(res.email).toBe('nueva@iteso.mx');
            expect(notifications.resubscribe).not.toHaveBeenCalled();
        });

        test('correo de otra cuenta responde EMAIL_IN_USE', async () => {
            ddb.send
                .mockRejectedValueOnce(canceled('None', 'ConditionalCheckFailed', 'None'))
                .mockResolvedValueOnce({ Item: user() });
            await expect(userService.updateProfile(user(), change)).rejects.toMatchObject({ code: 'EMAIL_IN_USE' });
        });

        test('si el correo cambió en otra petición responde CONFLICT', async () => {
            ddb.send
                .mockRejectedValueOnce(canceled('ConditionalCheckFailed', 'None', 'None'))
                .mockResolvedValueOnce({ Item: user({ email: 'otra@iteso.mx' }) });
            await expect(userService.updateProfile(user(), change)).rejects.toMatchObject({ code: 'CONFLICT' });
        });

        test('otro error de DynamoDB se propaga sin releer al usuario', async () => {
            ddb.send.mockRejectedValueOnce(new Error('ddb caído'));
            await expect(userService.updateProfile(user(), change)).rejects.toThrow('ddb caído');
            expect(ddb.send).toHaveBeenCalledTimes(1);
        });
    });
});
