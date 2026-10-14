const { QueryCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../src/lib/ddb');
const time = require('../src/lib/time');
const leaderboardService = require('../src/services/leaderboardService');

jest.mock('../src/lib/ddb', () => ({
    ddb: { send: jest.fn() }
}));

jest.mock('../src/lib/time', () => ({
    isoWeekId: jest.fn()
}));

describe('leaderboardService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Fijamos la semana actual
        time.isoWeekId.mockReturnValue('2026-W42');
    });

    describe('byRank', () => {
        it('debe ordenar correctamente por ganancia neta, luego partidas, y desempatar por ID', () => {
            const players = [
                { userId: 'c', net: 100, gamesPlayed: 5 },
                { userId: 'b', net: 200, gamesPlayed: 2 },
                { userId: 'a', net: 100, gamesPlayed: 10 },
                { userId: 'e', net: 100, gamesPlayed: 5 },
                { userId: 'd', net: 100, gamesPlayed: 5 }
            ];
            
            const sorted = players.sort(leaderboardService.byRank);
            
            expect(sorted[0].userId).toBe('b'); // Mayor net (200)
            expect(sorted[1].userId).toBe('a'); // Empate en net (100), mayor gamesPlayed (10)
            expect(sorted[2].userId).toBe('c'); // Empate en ambos, desempata userId alfabético
            expect(sorted[3].userId).toBe('d');
            expect(sorted[4].userId).toBe('e');
        });
    });

    describe('current', () => {
        it('debe devolver el top 10 y la posición actual del usuario', async () => {
            const fakeUser = { userId: 'u5' };
            
            // Simular respuesta paginada de QueryCommand (2 páginas)
            ddb.send
                .mockResolvedValueOnce({
                    Items: [{ userId: 'u1', name: 'User 1', net: 500, gamesPlayed: 10 }],
                    LastEvaluatedKey: { sk: 'page2' }
                })
                .mockResolvedValueOnce({
                    Items: [{ userId: 'u5', name: 'Me', net: -100, gamesPlayed: 5 }],
                    LastEvaluatedKey: undefined
                });

            const result = await leaderboardService.current(fakeUser, new Date());

            expect(result.weekId).toBe('2026-W42');
            expect(result.top).toHaveLength(2);
            expect(result.top[0].name).toBe('User 1');
            expect(result.me.rank).toBe(2);
            expect(result.me.net).toBe(-100);
        });

        it('debe manejar a un usuario que no ha jugado (no está en la tabla)', async () => {
            ddb.send.mockResolvedValueOnce({ Items: [{ userId: 'u1', name: 'User 1', net: 500 }] });
            
            const result = await leaderboardService.current({ userId: 'ghost' }, new Date());
            expect(result.me.rank).toBeNull();
            expect(result.me.net).toBe(0);
        });
    });

    describe('weeks', () => {
        it('debe escanear la tabla y devolver semanas cerradas en orden descendente', async () => {
            ddb.send.mockResolvedValueOnce({
                Items: [{ weekId: '2026-W40' }, { weekId: '2026-W41' }]
            });

            const result = await leaderboardService.weeks();
            expect(result).toEqual(['2026-W41', '2026-W40']);
        });
    });

    describe('last', () => {
        it('debe lanzar error de validación para weekId inválido o futuro', async () => {
            await expect(leaderboardService.last({ weekId: '2026-Malo' }, new Date())).rejects.toThrow('formato');
            // Como la semana "actual" es W42, pedir W42 debe fallar
            await expect(leaderboardService.last({ weekId: '2026-W42' }, new Date())).rejects.toThrow('Solo se pueden consultar semanas pasadas');        });

        it('debe devolver el ranking de una semana cerrada solicitada explícitamente', async () => {
            ddb.send.mockResolvedValueOnce({
                Item: { top: [{ rank: 1, name: 'Winner', net: 1000, prize: 50 }] }
            });

            const result = await leaderboardService.last({ weekId: '2026-W40' }, new Date());
            expect(result.top[0].name).toBe('Winner');
        });

        it('sin weekId en query, si la semana anterior no existe, busca la más reciente', async () => {
            // weekId por defecto sería '2026-W41', simulamos que no existe.
            time.isoWeekId.mockReturnValueOnce('2026-W41'); // Primera llamada dentro de last para default
            ddb.send.mockResolvedValueOnce({ Item: null }); // GetCommand para W41

            // Luego llama a weeks()
            ddb.send.mockResolvedValueOnce({ Items: [{ weekId: '2026-W39' }] }); // Scan de weeks
            
            // Último GetCommand para la semana encontrada (W39)
            ddb.send.mockResolvedValueOnce({
                Item: { top: [{ rank: 1, name: 'Old Winner', net: 500, prize: 0 }] }
            });

            const result = await leaderboardService.last({}, new Date());
            expect(result.weekId).toBe('2026-W39');
            expect(result.top[0].name).toBe('Old Winner');
        });

        it('debe lanzar error 404 si la semana no tiene ranking', async () => {
            ddb.send.mockResolvedValueOnce({ Item: null });
            await expect(leaderboardService.last({ weekId: '2026-W41' }, new Date())).rejects.toThrow('no tiene ranking cerrado');
        });
    });
});