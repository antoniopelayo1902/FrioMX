const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ddb } = require('../src/lib/ddb');
const v = require('../src/lib/validate');
const notifications = require('../src/services/notificationService');
const userService = require('../src/services/userService');
const storage = require('../src/services/storageService');

// Mockear dependencias
jest.mock('bcryptjs');
jest.mock('jsonwebtoken');
jest.mock('../src/lib/ddb', () => ({
    ddb: { send: jest.fn() },
    cancellationCodes: jest.fn()
}));
jest.mock('../src/lib/validate', () => ({
    name: jest.fn((n) => n),
    age: jest.fn((a) => a),
    email: jest.fn((e) => e),
    password: jest.fn((p) => p),
}));
jest.mock('../src/services/notificationService');

jest.mock('../src/services/storageService', () => ({
    imageUrlOf: jest.fn()
}));

describe('userService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Configurar respuestas exitosas por defecto
        bcrypt.hash.mockResolvedValue('hashed_password');
        bcrypt.compare.mockResolvedValue(true);
        jwt.sign.mockReturnValue('fake_jwt_token');
        ddb.send.mockResolvedValue({});
    });

    describe('register', () => {
        it('debe registrar un usuario nuevo y devolver un token', async () => {
            const body = { name: 'Emilio', age: 22, email: 'test@iteso.mx', password: 'password123' };

            const result = await userService.register(body);

            expect(result.token).toBe('fake_jwt_token');
            expect(result.user.name).toBe('Emilio');
            expect(result.user.email).toBe('test@iteso.mx');
            expect(result.user.balance).toBe(userService.WELCOME_CHIPS);
            
            // Verifica que se suscribió a las notificaciones
            expect(notifications.subscribeUser).toHaveBeenCalled();
            // Verifica que guardó en DDB (las dos tablas a la vez)
            const ddbArgs = ddb.send.mock.calls[0][0].input.TransactItems;
            expect(ddbArgs).toHaveLength(2); 
        });

        it('debe lanzar error si faltan campos', async () => {
            const body = { name: 'Emilio' }; // Falta edad, email, password
            
            await expect(userService.register(body)).rejects.toThrow('Todos los campos son requeridos');
        });
    });

    describe('login', () => {
        it('debe loguear un usuario existente con contraseña correcta', async () => {
            const body = { email: 'test@iteso.mx', password: 'password123' };
            const fakeUser = { userId: 'u1', name: 'Emilio', email: 'test@iteso.mx', balance: 1000, passwordHash: 'hashed_password' };
            
            // La primera llamada busca el email, la segunda busca al usuario
            ddb.send.mockResolvedValueOnce({ Item: { userId: 'u1' } });
            ddb.send.mockResolvedValueOnce({ Item: fakeUser });

            const result = await userService.login(body);

            expect(result.token).toBe('fake_jwt_token');
            expect(result.user.name).toBe('Emilio');
            expect(notifications.afterLogin).toHaveBeenCalledWith(fakeUser);
        });

        it('debe lanzar error de credenciales si la contraseña es incorrecta', async () => {
            const body = { email: 'test@iteso.mx', password: 'wrongpassword' };
            const fakeUser = { userId: 'u1', name: 'Emilio', email: 'test@iteso.mx', passwordHash: 'hashed_password' };
            
            ddb.send.mockResolvedValueOnce({ Item: { userId: 'u1' } });
            ddb.send.mockResolvedValueOnce({ Item: fakeUser });
            bcrypt.compare.mockResolvedValue(false); // Simulamos que la contraseña no coincide

            await expect(userService.login(body)).rejects.toThrow('Correo o contraseña incorrectos');
        });
    });

    describe('updateProfile', () => {
        const fakeUser = { userId: 'u1', name: 'Emilio', email: 'test@iteso.mx', passwordHash: 'hashed_password' };

        beforeEach(() => {
            // Cada vez que el código intente verificar la contraseña actual, le diremos que es correcta
            bcrypt.compare.mockResolvedValue(true);
        });

        it('debe cambiar el nombre de usuario', async () => {
            const body = { field: 'username', newValue: 'Emilio Nuevo' };
            // ddb.send se llama dos veces: una para el Update, y otra dentro de getUser al final
            ddb.send
               .mockResolvedValueOnce({}) // Éxito en el UpdateCommand
               .mockResolvedValueOnce({ Item: fakeUser }); // Éxito en el GetCommand (getUser)
            
            // Simular foto de perfil nula
            storage.imageUrlOf.mockResolvedValue(null);

            const result = await userService.updateProfile(fakeUser, body);

            const updateParams = ddb.send.mock.calls[0][0].input;
            expect(updateParams.UpdateExpression).toContain('SET #name = :name');
            expect(updateParams.ExpressionAttributeValues[':name']).toBe('Emilio Nuevo');
        });

        it('debe cambiar la contraseña y generar un nuevo token', async () => {
            const body = { field: 'password', newValue: 'nuevaPass123', currentPassword: 'password123' };
            
            ddb.send
               .mockResolvedValueOnce({ Attributes: { tokenVersion: 1 } }) // Éxito UpdateCommand
               .mockResolvedValueOnce({ Item: fakeUser }); // Éxito GetCommand
            
            storage.imageUrlOf.mockResolvedValue(null);

            const result = await userService.updateProfile(fakeUser, body);

            expect(result.token).toBe('fake_jwt_token');
            expect(bcrypt.hash).toHaveBeenCalledWith('nuevaPass123', 10);
        });
        it('debe lanzar error de contraseña incorrecta al intentar cambiar el correo', async () => {
            const body = { field: 'email', newValue: 'nuevo@iteso.mx', currentPassword: 'wrong' };
            // Forzamos a que la comparación de contraseña falle para este test en específico
            bcrypt.compare.mockResolvedValueOnce(false);

            await expect(userService.updateProfile(fakeUser, body)).rejects.toThrow('La contraseña actual no es correcta');
        });

        it('debe lanzar error ante un campo inválido', async () => {
            const body = { field: 'edad', newValue: 30 }; // 'edad' no es un campo válido en el IF

            await expect(userService.updateProfile(fakeUser, body)).rejects.toThrow('Campo inválido');
        });
    });
});
