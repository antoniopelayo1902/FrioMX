const multer = require('multer');
const { errorHandler, notFoundHandler, wrap } = require('../src/middleware/errors');
const { requestMetrics } = require('../src/middleware/metrics');
const { AppError } = require('../src/lib/errors');
const metrics = require('../src/services/metrics');

jest.mock('../src/services/metrics', () => ({
    enabled: jest.fn(),
    recordRequest: jest.fn(),
}));

// Respuesta falsa de Express que guarda el status y el cuerpo.
function fakeRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
}

describe('errorHandler', () => {
    let res;

    beforeEach(() => {
        res = fakeRes();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    test.each([
        ['LIMIT_FILE_SIZE', 'La foto no puede pesar más de 5 MB'],
        ['LIMIT_FILE_COUNT', 'Solo se puede subir una foto'],
        ['LIMIT_UNEXPECTED_FILE', 'El archivo debe ir en el campo profileImage'],
        ['LIMIT_FIELD_COUNT', 'Archivo inválido'],
    ])('error de multer %s responde 400', (code, message) => {
        errorHandler(new multer.MulterError(code), {}, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: message, code: 'VALIDATION_ERROR' });
    });

    test('AppError usa su status, código y campos extra', () => {
        const err = new AppError(409, 'ROUND_ACTIVE', 'Ya tienes una partida');
        err.extra = { gameId: 'g-1' };
        errorHandler(err, {}, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith({ error: 'Ya tienes una partida', code: 'ROUND_ACTIVE', gameId: 'g-1' });
    });

    test('AppError sin extra', () => {
        errorHandler(new AppError(404, 'NOT_FOUND', 'No está'), {}, res, jest.fn());
        expect(res.json).toHaveBeenCalledWith({ error: 'No está', code: 'NOT_FOUND' });
    });

    test('JSON mal formado responde 400', () => {
        errorHandler({ type: 'entity.parse.failed' }, {}, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'JSON mal formado', code: 'VALIDATION_ERROR' });
    });

    test('cuerpo demasiado grande responde 413', () => {
        errorHandler({ type: 'entity.too.large' }, {}, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(413);
        expect(res.json).toHaveBeenCalledWith({ error: 'Cuerpo demasiado grande', code: 'PAYLOAD_TOO_LARGE' });
    });

    test('error 4xx genérico conserva su mensaje', () => {
        errorHandler({ status: 400, message: 'La foto debe ser JPG, PNG o WebP' }, {}, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'La foto debe ser JPG, PNG o WebP', code: 'VALIDATION_ERROR' });
    });

    test('error 4xx sin mensaje usa uno genérico', () => {
        errorHandler({ status: 422 }, {}, res, jest.fn());
        expect(res.json).toHaveBeenCalledWith({ error: 'Petición inválida', code: 'VALIDATION_ERROR' });
    });

    test.each(['TransactionConflictException', 'ConditionalCheckFailedException'])('%s responde 409 CONFLICT', (name) => {
        errorHandler(Object.assign(new Error('x'), { name }), {}, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json.mock.calls[0][0].code).toBe('CONFLICT');
        expect(console.warn).toHaveBeenCalled();
    });

    test('error desconocido responde 500 sin filtrar detalles', () => {
        errorHandler(new Error('secreto interno'), {}, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Error interno', code: 'INTERNAL' });
        expect(console.error).toHaveBeenCalled();
    });

    test('error 5xx con status no se trata como culpa del cliente', () => {
        errorHandler({ status: 503, message: 'caído' }, {}, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(500);
    });

    test('error nulo responde 500', () => {
        errorHandler(null, {}, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(500);
    });
});

describe('notFoundHandler', () => {
    test('responde 404 NOT_FOUND', () => {
        const res = fakeRes();
        notFoundHandler({}, res);
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: 'Ruta no encontrada', code: 'NOT_FOUND' });
    });
});

describe('wrap', () => {
    test('pasa a next el error de un handler async', async () => {
        const err = new Error('falló');
        const next = jest.fn();
        await wrap(async () => { throw err; })({}, {}, next);
        expect(next).toHaveBeenCalledWith(err);
    });

    test('también atrapa handlers síncronos que regresan valor', async () => {
        const next = jest.fn();
        await wrap(() => 'ok')({}, {}, next);
        expect(next).not.toHaveBeenCalled();
    });
});

describe('requestMetrics', () => {
    beforeEach(() => jest.clearAllMocks());

    test('con métricas apagadas solo llama next', () => {
        metrics.enabled.mockReturnValue(false);
        const res = { on: jest.fn() };
        const next = jest.fn();
        requestMetrics({}, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.on).not.toHaveBeenCalled();
    });

    test('con métricas encendidas registra latencia y status al terminar', () => {
        metrics.enabled.mockReturnValue(true);
        let onFinish;
        const res = { statusCode: 201, on: jest.fn((event, cb) => { onFinish = cb; }) };
        const next = jest.fn();
        requestMetrics({}, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
        onFinish();
        expect(metrics.recordRequest).toHaveBeenCalledWith(expect.any(Number), 201);
        expect(metrics.recordRequest.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
    });
});
