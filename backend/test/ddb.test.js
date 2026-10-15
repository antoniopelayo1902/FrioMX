const { cancellationCodes } = require('../src/lib/ddb');

describe('cliente de DynamoDB', () => {
    afterEach(() => { delete process.env.DDB_ENDPOINT; });

    test('con DDB_ENDPOINT apunta a DynamoDB Local con credenciales fijas', async () => {
        process.env.DDB_ENDPOINT = 'http://localhost:8000';
        let ddb;
        jest.isolateModules(() => { ({ ddb } = require('../src/lib/ddb')); });
        const endpoint = await ddb.config.endpoint();
        expect(`${endpoint.protocol}//${endpoint.hostname}:${endpoint.port}`).toBe('http://localhost:8000');
        expect(await ddb.config.credentials()).toMatchObject({ accessKeyId: 'local', secretAccessKey: 'local' });
    });

    test('sin DDB_ENDPOINT usa el endpoint normal de la región', () => {
        let ddb;
        jest.isolateModules(() => { ({ ddb } = require('../src/lib/ddb')); });
        expect(ddb.config.endpoint).toBeUndefined();
    });
});

describe('cancellationCodes', () => {
    test('regresa el código de cada ítem y None si falta', () => {
        const err = { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}, null] };
        expect(cancellationCodes(err)).toEqual(['ConditionalCheckFailed', 'None', 'None']);
    });

    test.each([
        [null],
        [new Error('x')],
        [{ name: 'TransactionCanceledException' }],
    ])('regresa null si no es una transacción cancelada (%p)', (err) => {
        expect(cancellationCodes(err)).toBeNull();
    });
});
