const crypto = require('crypto');
const { ddb } = require('../src/lib/ddb');
const engine = require('../src/services/gameEngine');
const userService = require('../src/services/userService');
const metrics = require('../src/services/metrics');
const gameService = require('../src/services/gameService');

// Mockear dependencias
jest.mock('crypto');
jest.mock('../src/lib/ddb', () => ({
    ddb: { send: jest.fn() },
    cancellationCodes: jest.fn()
}));
jest.mock('../src/services/gameEngine');
jest.mock('../src/services/userService');
jest.mock('../src/services/metrics');
jest.mock('../src/lib/validate', () => ({
    uuidV4: jest.fn(), // Ignoramos la validación del formato UUID
    betAmount: jest.fn((amount) => amount) // Dejamos pasar el monto de la apuesta tal cual
}));

describe('gameService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Definir respuestas por defecto para funciones impredecibles
        crypto.randomUUID.mockReturnValue('mock-uuid-1234');
        Date.now = jest.fn(() => 1600000000000); // Fija la fecha
    });

    describe('roulettePlay', () => {
        it('debe ejecutar una partida de ruleta ganadora y registrar la transacción', async () => {
            // 1. Preparar: Configuramos el usuario falso y lo que devolverá el motor
            const fakeUser = { userId: 'u1', balance: 500 };
            const fakeSpinResult = {
                net: 100,
                total: 50,
                winningSlot: { label: '10', color: 'Negro', parity: 'par' },
                winningIndex: 10,
                results: [{ type: 'parity', value: 'par', amount: 50 }]
            };

            userService.getUser.mockResolvedValue(fakeUser);
            engine.rouletteSpin.mockReturnValue(fakeSpinResult);
            ddb.send.mockResolvedValue({}); // Simular que DynamoDB guardó correctamente

            // 2. Actuar: Llamamos a la función real
            const result = await gameService.roulettePlay(fakeUser, { bets: [] }, null);

            // 3. Afirmar: Comprobamos que el resultado sea el esperado
            expect(result.totalBet).toBe(50);
            expect(result.totalAmountChange).toBe(100);
            expect(result.newBalance).toBe(500); // 500 porque mockeamos getUser
            expect(metrics.countGame).toHaveBeenCalledWith('Roulette');
            
            // Validamos que se intentó guardar en DynamoDB con los datos correctos
            const ddbArgs = ddb.send.mock.calls[0][0].input.TransactItems;
            expect(ddbArgs).toHaveLength(3); // Update User, Put Activity, Update Weekly
            expect(ddbArgs[1].Put.Item.result).toBe('GANADA');
        });
    });

    describe('Hi-Lo y Minas - Inicio de Partida', () => {
        it('debe iniciar una ronda de Hi-Lo y cobrar la apuesta', async () => {
            const fakeUser = { userId: 'u1', balance: 500 };
            userService.getUser.mockResolvedValue(fakeUser);
            // Simular que el engine devuelve la carta 7 (por ejemplo)
            engine.hiloDrawVisible.mockReturnValue(7);
            ddb.send.mockResolvedValue({});

            // Simular un rng (generador de números aleatorios) vacío
            const result = await gameService.hiloDeal(fakeUser, { betAmount: 50 }, null);

            expect(result.bet).toBe(50);
            expect(result.oldCard).toBe(7);
            expect(result.newBalance).toBe(500); // getUser devuelve 500
            
            // Validar que se generaron las opciones del multiplicador
            expect(engine.hiloMultipliers).toHaveBeenCalledWith(7, 50);
        });

        it('debe iniciar una ronda de Minas y cobrar la apuesta', async () => {
            const fakeUser = { userId: 'u2', balance: 1000 };
            userService.getUser.mockResolvedValue(fakeUser);
            // Simular que el engine acomoda las minas en los índices 1, 5, 10
            engine.minesPlace.mockReturnValue([1, 5, 10]);
            ddb.send.mockResolvedValue({});

            const result = await gameService.minesStart(fakeUser, { betAmount: 100 }, null);

            expect(result.bet).toBe(100);
            expect(result.boardSize).toBe(engine.MINES_BOARD_SIZE);
            expect(result.safeCount).toBe(0);
        });
    });

    describe('Hi-Lo - Jugabilidad (hiloPlay)', () => {
        it('debe procesar una predicción correcta y ganar la partida', async () => {
            const fakeUser = { userId: 'u1', balance: 500 };
            const validGameId = '123e4567-e89b-12d3-a456-426614174000'; // UUID válido
            
            // Simular que ddb.send devuelve una partida ACTIVA en la primera llamada (readRound)
            ddb.send.mockResolvedValueOnce({
                Item: { gameId: validGameId, userId: 'u1', game: 'hilo', status: 'ACTIVE', expiresAt: 9999999999, bet: 50, oldCard: 7, version: 0 }
            });
            // Las siguientes llamadas a DDB (como guardar la victoria) no devuelven nada especial
            ddb.send.mockResolvedValue({});
            
            // Simulamos que saca un 10 y que el motor decide que ganó
            engine.hiloDraw.mockReturnValue(10);
            engine.hiloResolve.mockReturnValue({ won: true, payout: 100 });
            userService.getUser.mockResolvedValue(fakeUser);

            const result = await gameService.hiloPlay(fakeUser, { roundId: validGameId, prediction: 'higher' }, null);

            expect(result.won).toBe(true);
            expect(result.newCard).toBe(10);
            expect(result.payout).toBe(100);
            expect(result.amountChange).toBe(50); // Ganancia neta: pago(100) - apuesta(50)
        });
    });

    describe('Minas - Jugabilidad (minesReveal)', () => {
        it('debe revelar una mina, perder la partida y el saldo de la apuesta', async () => {
            const fakeUser = { userId: 'u2', balance: 1000 };
            const validGameId = '987f6543-e21b-34c5-b678-426614174001'; // UUID válido
            
            // Simular una ronda activa donde las minas están en las posiciones 5, 10 y 15
            ddb.send.mockResolvedValueOnce({
                Item: { gameId: validGameId, userId: 'u2', game: 'mines', status: 'ACTIVE', expiresAt: 9999999999, bet: 100, version: 0, mines: [5, 10, 15], revealed: [] }
            });
            ddb.send.mockResolvedValue({});

            // Simular que el usuario hizo clic en la celda que corresponde al índice 5 (¡Mina!)
            engine.minesIndex.mockReturnValue(5); 
            userService.getUser.mockResolvedValue(fakeUser);

            const result = await gameService.minesReveal(fakeUser, { gameId: validGameId, x: 1, y: 1 }, null);

            expect(result.result).toBe('mine');
            expect(result.status).toBe('LOST');
            expect(result.amountChange).toBe(-100); // Perdió la apuesta
        });
    });

    describe('Reconexión y Cobro', () => {
        it('debe devolver la partida activa de Hi-Lo si existe', async () => {
            const fakeUser = { userId: 'u1', activeHiloId: '123e4567-e89b-12d3-a456-426614174000', activeHiloExp: 9999999999 };
            
            ddb.send.mockResolvedValueOnce({
                Item: { gameId: '123e4567-e89b-12d3-a456-426614174000', userId: 'u1', status: 'ACTIVE', expiresAt: 9999999999, bet: 50, oldCard: 7 }
            });
            
            const result = await gameService.hiloActive(fakeUser);
            expect(result.round.oldCard).toBe(7);
            expect(result.round.bet).toBe(50);
        });

        it('debe procesar el cobro (cashout) en Minas correctamente', async () => {
            const fakeUser = { userId: 'u2', balance: 1000 };
            const validGameId = '987f6543-e21b-34c5-b678-426614174001';
            
            // Simular ronda con 2 casillas seguras destapadas
            ddb.send.mockResolvedValueOnce({
                Item: { gameId: validGameId, userId: 'u2', game: 'mines', status: 'ACTIVE', expiresAt: 9999999999, bet: 100, version: 0, mines: [5, 10, 15], revealed: [1, 2] }
            });
            ddb.send.mockResolvedValue({}); // Para la transacción final
            
            userService.getUser.mockResolvedValue(fakeUser);
            
            // Simulamos que el motor dice que el pago por 2 casillas es de 150
            engine.minesPayout.mockReturnValue(150);

            const result = await gameService.minesCashout(fakeUser, { gameId: validGameId }, null);

            expect(result.status).toBe('CASHED');
            expect(result.payout).toBe(150);
            expect(result.amountChange).toBe(50); // Ganancia neta: 150 - 100
        });
    });

    describe('Reconexión y Cobro', () => {
        it('debe devolver la partida activa de Hi-Lo si existe', async () => {
            const fakeUser = { userId: 'u1', activeHiloId: '123e4567-e89b-12d3-a456-426614174000', activeHiloExp: 9999999999 };
            
            ddb.send.mockResolvedValueOnce({
                Item: { gameId: '123e4567-e89b-12d3-a456-426614174000', userId: 'u1', status: 'ACTIVE', expiresAt: 9999999999, bet: 50, oldCard: 7 }
            });
            
            const result = await gameService.hiloActive(fakeUser);
            expect(result.round.oldCard).toBe(7);
            expect(result.round.bet).toBe(50);
        });

        it('debe procesar el cobro (cashout) en Minas correctamente', async () => {
            const fakeUser = { userId: 'u2', balance: 1000 };
            const validGameId = '987f6543-e21b-34c5-b678-426614174001';
            
            // Simular ronda con 2 casillas seguras destapadas
            ddb.send.mockResolvedValueOnce({
                Item: { gameId: validGameId, userId: 'u2', game: 'mines', status: 'ACTIVE', expiresAt: 9999999999, bet: 100, version: 0, mines: [5, 10, 15], revealed: [1, 2] }
            });
            ddb.send.mockResolvedValue({}); // Para la transacción final
            
            userService.getUser.mockResolvedValue(fakeUser);
            
            // Simulamos que el motor dice que el pago por 2 casillas es de 150
            engine.minesPayout.mockReturnValue(150);

            const result = await gameService.minesCashout(fakeUser, { gameId: validGameId }, null);

            expect(result.status).toBe('CASHED');
            expect(result.payout).toBe(150);
            expect(result.amountChange).toBe(50); // Ganancia neta: 150 - 100
        });
    });
});