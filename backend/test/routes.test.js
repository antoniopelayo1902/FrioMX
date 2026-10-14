const express = require('express');
const request = require('supertest');
const { buildRouter } = require('../src/routes/index');

// Mockear dependencias internas que las rutas utilizan
jest.mock('../src/middleware/auth', () => ({
    requireAuth: (req, res, next) => next()
}));
jest.mock('../src/middleware/errors', () => ({
    wrap: (fn) => (req, res, next) => fn(req, res, next).catch(next)
}));
jest.mock('../src/services/userService', () => ({
    register: jest.fn().mockResolvedValue({ token: '123' })
}));
jest.mock('../src/services/gameService', () => ({
    hiloActive: jest.fn().mockResolvedValue({})
}));

describe('Routes Configuration', () => {
    let app;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        
        // Llamar a buildRouter() para obtener el enrutador real y evitar limitadores lentos
        const router = buildRouter({ authLimit: 1000, profileLimit: 1000 });
        app.use('/api', router);
    });

    it('debe tener configurada la ruta POST /api/auth/register', async () => {
        const response = await request(app).post('/api/auth/register').send({ name: 'test' });
        // Comprobamos que responda con 201 (Creado) según la lógica de la ruta
        expect(response.status).toBe(201);
    });

    it('debe tener configurada la ruta GET /api/games/hi-lo/active', async () => {
        const response = await request(app).get('/api/games/hi-lo/active');
        expect(response.status).toBe(200);
    });

    it('debe devolver 404 para una ruta de API inexistente', async () => {
        const response = await request(app).get('/api/ruta-que-no-existe');
        expect(response.status).toBe(404);
    });
});