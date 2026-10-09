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
        // old 7, higher: k = 5, pago exacto 100 * 10.45 / 5 = 209
        expect(engine.hiloResolve(7, 9, 'higher', 100)).toEqual({ won: true, payout: 209, net: 109 });
    });

    test('multiplicadores visibles antes de elegir', () => {
        expect(engine.hiloMultipliers(7)).toEqual({
            higher: { multiplier: 2.09, chance: 5 / 11 },
            lower: { multiplier: 2.09, chance: 5 / 11 },
        });
        expect(engine.hiloMultipliers(2).lower).toBeNull();
        expect(engine.hiloMultipliers(12).higher).toBeNull();
    });

    test('rechaza la predicción que nunca puede ganar (k = 0)', () => {
        expect(() => engine.hiloResolve(12, 5, 'higher', 10)).toThrow(/no puede ganar/);
        expect(() => engine.hiloResolve(2, 5, 'lower', 10)).toThrow(/no puede ganar/);
    });

    test('pago determinista: floor del pago justo, valor esperado <= 0.95 y cercano con apuestas grandes', () => {
        for (let old = 2; old <= 12; old += 1) {
            for (const prediction of ['higher', 'lower']) {
                const k = engine.hiloWinningValues(old, prediction);
                if (k === 0) continue;
                for (const bet of [1, 2, 7, 22, 333, 10000]) {
                    const exact = (bet * 95 * 11) / (100 * k);
                    const win = engine.hiloResolve(old, prediction === 'higher' ? 12 : 2, prediction, bet);
                    expect(win.payout).toBe(Math.floor(exact));
                    expect(engine.hiloMultipliers(old, bet)[prediction].payout).toBe(win.payout);
                    const ev = ((k / 11) * win.payout) / bet;
                    expect(ev).toBeLessThanOrEqual(0.95 + 1e-9);
                    if (bet === 10000) expect(ev).toBeGreaterThan(0.949);
                }
            }
        }
    });

    test('la carta visible sale del 3 al 11: siempre hay Mayor y Menor', () => {
        const seen = new Set();
        for (let i = 0; i < 2000; i += 1) seen.add(engine.hiloDrawVisible());
        expect([...seen].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
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

    test('con el 0 gana solo Verde y paga 35 a 1', () => {
        const bets = [
            { type: 'color', value: 'Verde', amount: 10 },
            { type: 'parity', value: 'par', amount: 20 },
            { type: 'dozen', value: '1', amount: 30 },
        ];
        const spin = engine.rouletteSpin(bets, fixed(0));
        expect(spin.results.map((r) => r.won)).toEqual([true, false, false]);
        expect(spin.results.map((r) => r.change)).toEqual([350, -20, -30]);
        expect(spin.net).toBe(350 - 20 - 30);
        expect(spin.total).toBe(60);
    });

    test('color y paridad pagan 1 a 1, docena 2 a 1', () => {
        // índice 1 = 32 Rojo par docena 3
        const spin = engine.rouletteSpin([
            { type: 'color', value: 'Rojo', amount: 5 },
            { type: 'parity', value: 'par', amount: 5 },
            { type: 'dozen', value: '3', amount: 5 },
        ], fixed(1));
        expect(spin.net).toBe(5 + 5 + 10);
    });

    test('el retorno al jugador de cada apuesta es 36/37', () => {
        for (const bet of [
            { type: 'color', value: 'Rojo' }, { type: 'color', value: 'Verde' },
            { type: 'parity', value: 'par' }, { type: 'dozen', value: '2' },
        ]) {
            let back = 0;
            engine.ROULETTE_WHEEL.forEach((slot) => {
                if (slot[bet.type] === bet.value) back += 1 + engine.roulettePayout(bet);
            });
            expect(back / 37).toBeCloseTo(36 / 37, 9);
        }
    });

    test('tipos que existen en el prototipo de Object se rechazan con 400, no 500', () => {
        for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
            expect(() => engine.rouletteSpin([{ type, value: 'x', amount: 1 }], fixed(0))).toThrow(/inválida/);
        }
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

    test('multiplicador progresivo con 5% para la casa', () => {
        expect(engine.minesMultiplier(0)).toBe(1);
        expect(engine.minesMultiplier(1)).toBe(1.18); // 0.95 * 25/20 = 1.1875
        expect(engine.minesMultiplier(2)).toBe(1.5); // 0.95 * 300/190
        for (let k = 1; k < 20; k += 1) expect(engine.minesMultiplier(k + 1)).toBeGreaterThan(engine.minesMultiplier(k));
        // Probabilidad de sobrevivir k casillas * pago justo = 0.95 exacto
        for (let k = 1; k <= 20; k += 1) {
            const pago = engine.minesPayout(10000, k);
            expect(pago).toBeLessThanOrEqual(engine.MINES_MAX_PAYOUT);
        }
        expect(engine.minesPayout(100, 1)).toBe(118);
        expect(engine.minesPayout(100, 2)).toBe(150);
    });

    test('convierte coordenadas e índices', () => {
        expect(engine.minesIndex(2, 3)).toBe(13);
        expect(engine.minesToCells([13])).toEqual([{ x: 2, y: 3 }]);
        expect(() => engine.minesIndex(5, 0)).toThrow();
        expect(() => engine.minesIndex(1.5, 0)).toThrow();
    });
});
