const engine = require('../src/services/gameEngine');

const fixed = (...values) => {
    const queue = [...values];
    return () => queue.shift();
};

describe('hi-lo', () => {
    test('el empate pierde', () => {
        expect(engine.hiloResolve(7, 7, 'higher', 100)).toEqual({ won: false, payout: 0, net: -100 });
        expect(engine.hiloResolve(7, 7, 'lower', 100)).toEqual({ won: false, payout: 0, net: -100 });
    });

    test('gana con mayor estricto y paga según k', () => {
        // old 7, higher: k = 5, payout = floor(100 * 10.45 / 5) = 209
        expect(engine.hiloResolve(7, 9, 'higher', 100)).toEqual({ won: true, payout: 209, net: 109 });
    });

    test('rechaza la predicción que nunca puede ganar (k = 0)', () => {
        expect(() => engine.hiloResolve(12, 5, 'higher', 10)).toThrow(/no puede ganar/);
        expect(() => engine.hiloResolve(2, 5, 'lower', 10)).toThrow(/no puede ganar/);
    });

    test('valor esperado <= 0.95 para todo k y apuesta, y net nunca negativo al ganar', () => {
        for (let old = 2; old <= 12; old += 1) {
            for (const prediction of ['higher', 'lower']) {
                const k = engine.hiloWinningValues(old, prediction);
                if (k === 0) continue;
                for (const bet of [1, 7, 22, 333, 10000]) {
                    let total = 0;
                    for (let card = 2; card <= 12; card += 1) {
                        const r = engine.hiloResolve(old, card, prediction, bet);
                        if (r.won) expect(r.net).toBeGreaterThanOrEqual(0);
                        total += r.payout;
                    }
                    const ev = total / 11 / bet;
                    expect(ev).toBeLessThanOrEqual(0.95 + 1e-9);
                    if (bet === 10000) expect(ev).toBeGreaterThan(0.94);
                }
            }
        }
    });

    test('las cartas salen del 2 al 12', () => {
        const seen = new Set();
        for (let i = 0; i < 2000; i += 1) seen.add(engine.hiloDraw());
        expect([...seen].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });
});

describe('ruleta', () => {
    test('rueda europea de 37 casillas, el 0 es verde sin paridad ni docena', () => {
        expect(engine.ROULETTE_WHEEL).toHaveLength(37);
        expect(engine.ROULETTE_WHEEL[0]).toEqual({ label: '0', color: 'Verde' });
        const labels = engine.ROULETTE_WHEEL.map((s) => Number(s.label)).sort((a, b) => a - b);
        expect(labels).toEqual([...Array(37).keys()]);
    });

    test('con el 0 gana solo Verde', () => {
        const bets = [
            { type: 'color', value: 'Verde', amount: 10 },
            { type: 'parity', value: 'par', amount: 20 },
            { type: 'dozen', value: '1', amount: 30 },
        ];
        const spin = engine.rouletteSpin(bets, fixed(0));
        expect(spin.results.map((r) => r.won)).toEqual([true, false, false]);
        expect(spin.net).toBe(10 - 20 - 30);
        expect(spin.total).toBe(60);
    });

    test('paga 1 a 1 por color, paridad y docena', () => {
        // índice 1 = 32 Rojo par docena 3
        const spin = engine.rouletteSpin([
            { type: 'color', value: 'Rojo', amount: 5 },
            { type: 'parity', value: 'par', amount: 5 },
            { type: 'dozen', value: '3', amount: 5 },
        ], fixed(1));
        expect(spin.net).toBe(15);
    });

    test('valida apuestas', () => {
        expect(() => engine.rouletteSpin([], fixed(0))).toThrow();
        expect(() => engine.rouletteSpin([{ type: 'color', value: 'Azul', amount: 5 }], fixed(0))).toThrow();
        expect(() => engine.rouletteSpin([{ type: 'color', value: 'Rojo', amount: 1.5 }], fixed(0))).toThrow();
        expect(() => engine.rouletteSpin([{ type: 'color', value: 'Rojo', amount: 10001 }], fixed(0))).toThrow();
    });
});

describe('minas', () => {
    test('coloca 5 minas distintas dentro del tablero', () => {
        for (let i = 0; i < 200; i += 1) {
            const mines = engine.minesPlace();
            expect(new Set(mines).size).toBe(5);
            mines.forEach((m) => {
                expect(m).toBeGreaterThanOrEqual(0);
                expect(m).toBeLessThan(25);
            });
        }
    });

    test('convierte coordenadas e índices', () => {
        expect(engine.minesIndex(2, 3)).toBe(13);
        expect(engine.minesToCells([13])).toEqual([{ x: 2, y: 3 }]);
        expect(() => engine.minesIndex(5, 0)).toThrow();
        expect(() => engine.minesIndex(1.5, 0)).toThrow();
    });
});
