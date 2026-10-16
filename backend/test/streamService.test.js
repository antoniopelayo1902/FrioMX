const { EventEmitter } = require('events');

// Respuesta falsa de SSE que guarda todo lo que se escribe.
function fakeRes() {
    return { writeHead: jest.fn(), write: jest.fn() };
}

describe('streamService', () => {
    let stream;

    beforeEach(() => {
        jest.useFakeTimers();
        // Módulo nuevo en cada prueba: el mapa de clientes es estado global.
        jest.isolateModules(() => { stream = require('../src/services/streamService'); });
    });
    afterEach(() => jest.useRealTimers());

    test('addClient manda cabeceras SSE y el evento connected', () => {
        const req = new EventEmitter();
        const res = fakeRes();
        stream.addClient('u1', req, res);
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
        }));
        expect(res.write).toHaveBeenCalledWith('event: connected\n');
        expect(res.write).toHaveBeenCalledWith('data: {"status":"ok"}\n\n');
    });

    test('manda un ping cada 30 s mientras la conexión siga abierta', () => {
        const req = new EventEmitter();
        const res = fakeRes();
        stream.addClient('u1', req, res);
        res.write.mockClear();
        jest.advanceTimersByTime(30000);
        expect(res.write).toHaveBeenCalledWith(': ping\n\n');
        jest.advanceTimersByTime(30000);
        expect(res.write).toHaveBeenCalledTimes(2);
    });

    test('al cerrar la conexión deja de hacer ping y olvida al cliente', () => {
        const req = new EventEmitter();
        const res = fakeRes();
        stream.addClient('u1', req, res);
        req.emit('close');
        res.write.mockClear();
        jest.advanceTimersByTime(60000);
        stream.sendToUser('u1', 'balanceUpdate', { balance: 1 });
        stream.broadcast('leaderboardUpdate', {});
        expect(res.write).not.toHaveBeenCalled();
    });

    test('sendToUser solo escribe al usuario indicado', () => {
        const a = fakeRes();
        const b = fakeRes();
        stream.addClient('a', new EventEmitter(), a);
        stream.addClient('b', new EventEmitter(), b);
        a.write.mockClear();
        b.write.mockClear();
        stream.sendToUser('a', 'balanceUpdate', { balance: 900 });
        expect(a.write.mock.calls).toEqual([['event: balanceUpdate\n'], ['data: {"balance":900}\n\n']]);
        expect(b.write).not.toHaveBeenCalled();
    });

    test('sendToUser a un usuario sin conexión no hace nada', () => {
        expect(() => stream.sendToUser('nadie', 'balanceUpdate', {})).not.toThrow();
    });

    test('broadcast escribe a todos los conectados', () => {
        const a = fakeRes();
        const b = fakeRes();
        stream.addClient('a', new EventEmitter(), a);
        stream.addClient('b', new EventEmitter(), b);
        a.write.mockClear();
        b.write.mockClear();
        stream.broadcast('leaderboardUpdate', { message: 'x' });
        for (const res of [a, b]) {
            expect(res.write.mock.calls).toEqual([['event: leaderboardUpdate\n'], ['data: {"message":"x"}\n\n']]);
        }
    });

    test('una reconexión del mismo usuario reemplaza la conexión anterior', () => {
        const old = fakeRes();
        const fresh = fakeRes();
        stream.addClient('u1', new EventEmitter(), old);
        stream.addClient('u1', new EventEmitter(), fresh);
        old.write.mockClear();
        stream.sendToUser('u1', 'balanceUpdate', { balance: 5 });
        expect(old.write).not.toHaveBeenCalled();
        expect(fresh.write).toHaveBeenCalledWith('data: {"balance":5}\n\n');
    });
});
