const jwt = require('jsonwebtoken');
const { requireAuth } = require('../src/middleware/auth');
const { getUser } = require('../src/services/userService');
const { AppError } = require('../src/lib/errors');

// Mockear dependencias
jest.mock('jsonwebtoken');
jest.mock('../src/services/userService', () => ({
    getUser: jest.fn()
}));

describe('auth middleware', () => {
    let req, res, next;

    beforeEach(() => {
        req = { headers: {}, query: {} }; 
        res = {};
        next = jest.fn(); 
        jest.clearAllMocks();
    });

    describe('requireAuth', () => {
        it('debe lanzar error 401 si no hay token (falta Bearer)', async () => {
            req.headers.authorization = 'Basic token';
            await requireAuth(req, res, next);
            
            expect(next).toHaveBeenCalledWith(expect.any(AppError));
            expect(next.mock.calls[0][0].message).toBe('No autorizado');
        });

        it('debe lanzar error si jwt.verify falla o expira', async () => {
            req.headers.authorization = 'Bearer token-invalido';
            jwt.verify.mockImplementation(() => { throw new Error('jwt expired'); });
            
            await requireAuth(req, res, next);
            expect(next.mock.calls[0][0].message).toBe('Sesión inválida o expirada');
        });

        it('debe lanzar error si el sub (userId) del payload no es string o es muy largo', async () => {
            req.headers.authorization = 'Bearer token';
            jwt.verify.mockReturnValue({ sub: 123 }); // sub numérico
            
            await requireAuth(req, res, next);
            expect(next.mock.calls[0][0].message).toBe('Sesión inválida o expirada');
        });

        it('debe lanzar error si el usuario no existe en la base de datos', async () => {
            req.headers.authorization = 'Bearer token';
            jwt.verify.mockReturnValue({ sub: 'user-123' });
            getUser.mockResolvedValue(null); // Simulamos usuario borrado
            
            await requireAuth(req, res, next);
            expect(next.mock.calls[0][0].message).toBe('Usuario no encontrado');
        });

        it('debe lanzar error si la versión del token (tv) no coincide con la del usuario', async () => {
            req.headers.authorization = 'Bearer token';
            // El token dice versión 0, pero la BD dice versión 1 (contraseña cambiada)
            jwt.verify.mockReturnValue({ sub: 'u1', tv: 0 });
            getUser.mockResolvedValue({ userId: 'u1', tokenVersion: 1 });
            
            await requireAuth(req, res, next);
            expect(next.mock.calls[0][0].message).toBe('Tu contraseña cambió, inicia sesión de nuevo');
        });

        it('debe pasar al siguiente middleware y asignar req.user si todo es correcto', async () => {
            req.headers.authorization = 'Bearer token-valido';
            const fakeUser = { userId: 'u1', tokenVersion: 2 };
            
            jwt.verify.mockReturnValue({ sub: 'u1', tv: 2 });
            getUser.mockResolvedValue(fakeUser);

            await requireAuth(req, res, next);

            // Validamos que se inyectó la información en el request
            expect(req.userId).toBe('u1');
            expect(req.user).toBe(fakeUser);
            // Validamos que se llamó a next() sin argumentos (éxito)
            expect(next).toHaveBeenCalledWith();
        });
    });
});