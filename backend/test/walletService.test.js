const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const aws = require('../src/lib/aws');
const { ddb, cancellationCodes } = require('../src/lib/ddb');
const time = require('../src/lib/time');
const walletService = require('../src/services/walletService');
const { config } = require('../src/config/env');

// Mockear dependencias
jest.mock('../src/lib/aws', () => ({
    sqs: jest.fn()
}));
jest.mock('../src/lib/ddb', () => ({
    ddb: { send: jest.fn() },
    cancellationCodes: jest.fn()
}));
jest.mock('../src/lib/time', () => ({
    localDate: jest.fn()
}));
jest.mock('../src/lib/uuid', () => ({
    uuidv5: jest.fn((str) => 'mock-uuid-v5-' + str)
}));
jest.mock('../src/lib/validate', () => ({
    uuidV4: jest.fn((id) => id),
    uuidV5: jest.fn((id) => id)
}));

describe('walletService', () => {
    let sqsSendMock;

    beforeEach(() => {
        jest.clearAllMocks();
        // Configuración para permitir encolar
        config.rechargeQueueUrl = 'https://fake-queue.com';
        
        // Simular que el cliente SQS se crea correctamente
        sqsSendMock = jest.fn().mockResolvedValue({});
        aws.sqs.mockReturnValue({ send: sqsSendMock });

        time.localDate.mockReturnValue('2026-10-14');
        Date.now = jest.fn(() => 1600000000000); 
    });

    describe('listPackages', () => {
        it('debe devolver la lista de paquetes disponibles', () => {
            const packages = walletService.listPackages();
            expect(packages).toHaveLength(3);
            expect(packages[0]).toHaveProperty('packageId', 'p500');
        });
    });

    describe('createRecharge', () => {
        const fakeUser = { userId: 'u1' };
        
        it('debe lanzar error si el packageId no es válido', async () => {
            const body = { packageId: 'p1M' }; // Paquete inexistente
            await expect(walletService.createRecharge(fakeUser, body, 'key1')).rejects.toThrow('packageId inválido');
        });

        it('debe procesar una recarga correctamente para el primer intento del día', async () => {
            const body = { packageId: 'p500' };
            
            // Simular readRecharge inicial devolviendo null
            ddb.send.mockResolvedValueOnce({ Item: null });
            
            // Simular TransactWriteCommand exitoso (guarda en DB)
            ddb.send.mockResolvedValueOnce({});

            const result = await walletService.createRecharge(fakeUser, body, 'key2');

            expect(result.status).toBe('PENDING');
            expect(sqsSendMock).toHaveBeenCalled(); // Validar que se mandó el mensaje a SQS
            
            const txItems = ddb.send.mock.calls[1][0].input.TransactItems;
            expect(txItems).toHaveLength(2); // Valida que se ejecutó la transacción de 2 pasos
        });

        it('debe devolver la recarga existente si se detecta llave de idempotencia duplicada', async () => {
            const body = { packageId: 'p1000' };
            const existingRecharge = { rechargeId: 'mock-uuid', userId: 'u1', status: 'PENDING' };
            
            // Simular que ddb ya tiene la recarga
            ddb.send.mockResolvedValueOnce({ Item: existingRecharge });

            const result = await walletService.createRecharge(fakeUser, body, 'key-dup');

            expect(result.status).toBe('PENDING');
            // Como estaba pendiente, el sistema la re-encola para destrabarla
            expect(sqsSendMock).toHaveBeenCalled();
        });

        it('debe lanzar error de Límite Diario si la base de datos rechaza la transacción repetidamente', async () => {
            const body = { packageId: 'p1000' };
            
            ddb.send.mockResolvedValueOnce({ Item: null }); // readRecharge inicial
            
            // Simular rechazo en la base de datos por ConditionalCheckFailed en TODOS los reintentos
            ddb.send.mockRejectedValue(new Error('TxFailed'));
            cancellationCodes.mockReturnValue(['ConditionalCheckFailed']);

            await expect(walletService.createRecharge(fakeUser, body, 'key-limit')).rejects.toThrow('Solo puedes hacer 3 recargas por día');
        });

        it('debe lanzar error si el sistema de colas (SQS) no está configurado', async () => {
            const body = { packageId: 'p500' };
            config.rechargeQueueUrl = null; // Simulamos que falta la variable de entorno

            await expect(walletService.createRecharge(fakeUser, body, 'key-no-queue')).rejects.toThrow('No se pudo procesar la recarga');
        });

        it('debe lanzar error de conflicto si hay colisión de transacciones', async () => {
            const body = { packageId: 'p500' };
            config.rechargeQueueUrl = 'https://fake-queue.com'; // Restauramos la config
            
            ddb.send.mockResolvedValueOnce({ Item: null });
            
            // Simular un TransactionConflict (colisión de DB) que se repite demasiadas veces
            ddb.send.mockRejectedValue(new Error('TransactionConflict'));
            cancellationCodes.mockReturnValue(['TransactionConflict']);

            // El código intenta 3 veces y luego se rinde
            await expect(walletService.createRecharge(fakeUser, body, 'key-conflict')).rejects.toThrow('Otra acción llegó al mismo tiempo');
        });
    });

    describe('getRecharge', () => {
        it('debe devolver detalles de la recarga solicitada', async () => {
            const fakeUser = { userId: 'u1' };
            const fakeRecharge = { rechargeId: 'req1', userId: 'u1', chips: 1000, status: 'COMPLETED', createdAt: '2026-10-14T00:00:00Z', completedAt: '2026-10-14T00:01:00Z' };
            
            ddb.send.mockResolvedValueOnce({ Item: fakeRecharge });

            const result = await walletService.getRecharge(fakeUser, 'req1');

            expect(result.status).toBe('COMPLETED');
            expect(result.chips).toBe(1000);
        });

        it('debe lanzar error de 403 si la recarga es de otro jugador', async () => {
            const fakeUser = { userId: 'u1' };
            const enemyRecharge = { rechargeId: 'req2', userId: 'u2' }; // Es de otro usuario
            
            ddb.send.mockResolvedValueOnce({ Item: enemyRecharge });

            await expect(walletService.getRecharge(fakeUser, 'req2')).rejects.toThrow('La recarga es de otro jugador');
        });
    });
});