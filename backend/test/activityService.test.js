const { ddb } = require('../src/lib/ddb');
const { listActivity, encodeCursor, decodeCursor } = require('../src/services/activityService');

// Mockear la base de datos
jest.mock('../src/lib/ddb', () => ({
    ddb: { send: jest.fn() }
}));

describe('activityService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Congelar el tiempo para probar la lógica de "Abandono" (1 hr)
        Date.now = jest.fn(() => new Date('2026-10-14T00:00:00Z').getTime());
    });

    describe('Cursores (encode/decode)', () => {
        const validKey = { userId: 'u1', sk: '2026-10-10T12:00:00Z#123e4567-e89b-12d3-a456-426614174000' };
        
        it('debe codificar y decodificar correctamente', () => {
            const cursor = encodeCursor(validKey);
            const decoded = decodeCursor(cursor, 'u1');
            expect(decoded).toEqual(validKey);
        });

        it('debe lanzar error con cursor mal formado o de otro usuario', () => {
            const badCursor = Buffer.from('not-json').toString('base64url');
            expect(() => decodeCursor(badCursor, 'u1')).toThrow('Cursor inválido');
            
            // Falla porque el usuario es distinto
            const otherUserCursor = encodeCursor({ userId: 'u2', sk: validKey.sk });
            expect(() => decodeCursor(otherUserCursor, 'u1')).toThrow('Cursor inválido');

            // Falla porque el formato del SK no cumple la expresión regular
            const badSkCursor = encodeCursor({ userId: 'u1', sk: 'formato-invalido' });
            expect(() => decodeCursor(badSkCursor, 'u1')).toThrow('Cursor inválido');
        });
    });

    describe('listActivity', () => {
        it('debe validar el parámetro limit', async () => {
            await expect(listActivity('u1', { limit: 100 })).rejects.toThrow('limit debe ser un entero');
            await expect(listActivity('u1', { limit: 0 })).rejects.toThrow('limit debe ser un entero');
            await expect(listActivity('u1', { limit: 'abc' })).rejects.toThrow('limit debe ser un entero');
        });

        it('debe mapear el historial correctamente (con lógicas de BetStatus y Expiración)', async () => {
            ddb.send.mockResolvedValueOnce({
                Items: [
                    { userId: 'u1', sk: 'sk1', result: 'GANADA', balance: 100, dateGame: '2026-10-13T23:50:00Z' },
                    // Partida recién creada, sigue en curso
                    { userId: 'u1', sk: 'sk2', result: 'EN_CURSO', balance: -50, dateGame: '2026-10-13T23:59:00Z' },
                    // Partida vieja (>1h) en curso, debe marcarse como ABANDONADA
                    { userId: 'u1', sk: 'sk3', result: 'EN_CURSO', balance: -50, dateGame: '2026-10-13T22:00:00Z' },
                ]
            });

            const result = await listActivity('u1', { limit: 3 });
            expect(result.items).toHaveLength(3);
            expect(result.items[0].result).toBe('GANADA');
            expect(result.items[1].result).toBe('EN_CURSO');
            expect(result.items[2].result).toBe('ABANDONADA');
            expect(result.nextCursor).toBeNull();
        });

        it('debe manejar la paginación correctamente usando el nextCursor', async () => {
            const validSk = '2026-10-10T12:00:00Z#123e4567-e89b-12d3-a456-426614174000';
            ddb.send.mockResolvedValueOnce({
                Items: [
                    { userId: 'u1', sk: validSk, BetStatus: true, dateGame: '2026-10-10T12:00:00Z' }, // Item actual
                    { userId: 'u1', sk: 'sk-extra', BetStatus: false, dateGame: '2026-10-10T11:00:00Z' } // Item extra para simular "página siguiente"
                ]
            });

            // Usamos limit: 1 para forzar que sobre el ítem extra y genere un nextCursor
            const cursor = encodeCursor({ userId: 'u1', sk: validSk });
            const result = await listActivity('u1', { limit: 1, cursor });

            expect(result.items).toHaveLength(1);
            expect(result.items[0].result).toBe('GANADA'); // Detectó la victoria por BetStatus
            expect(result.nextCursor).not.toBeNull();
        });
    });
});