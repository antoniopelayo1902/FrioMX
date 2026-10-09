const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { wrap } = require('../middleware/errors');
const users = require('../services/userService');
const activity = require('../services/activityService');
const games = require('../services/gameService');

const tooMany = (req, res) => res.status(429).json({ error: 'Demasiados intentos, espera un minuto', code: 'RATE_LIMITED' });

function buildRouter({ rng, authLimit = 10, profileLimit = 5 } = {}) {
    const router = express.Router();

    router.get('/health', (req, res) => res.json({ status: 'ok' }));

    // ----- Cuentas -----
    const loginLimiter = rateLimit({ windowMs: 60 * 1000, limit: authLimit, skipSuccessfulRequests: true, handler: tooMany });
    const registerLimiter = rateLimit({ windowMs: 60 * 1000, limit: authLimit, handler: tooMany });

    router.post('/auth/register', registerLimiter, wrap(async (req, res) => {
        res.status(201).json({ message: 'Usuario registrado con éxito.', ...(await users.register(req.body)) });
    }));
    router.post('/auth/login', loginLimiter, wrap(async (req, res) => {
        res.json(await users.login(req.body));
    }));
    router.get('/auth/user-name', requireAuth, (req, res) => res.json({ name: req.user.name }));

    router.get('/user/profile', requireAuth, (req, res) => res.json(users.profileOf(req.user)));
    // Con una sesión robada no se puede adivinar la contraseña actual: 5 intentos fallidos por minuto por usuario.
    const profileLimiter = rateLimit({
        windowMs: 60 * 1000, limit: profileLimit, handler: tooMany,
        // Solo cuentan los intentos con contraseña actual incorrecta, no un nombre inválido.
        skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => res.statusCode !== 403,
        keyGenerator: (req) => `user:${req.userId}`,
    });
    router.put('/user/profile', requireAuth, profileLimiter, wrap(async (req, res) => {
        res.json(await users.updateProfile(req.user, req.body));
    }));
    router.get('/user/balance', requireAuth, (req, res) => res.json({ balance: req.user.balance }));
    router.get('/user/activity', requireAuth, wrap(async (req, res) => {
        res.json(await activity.listActivity(req.userId, req.query));
    }));

    // ----- Foto de perfil: se activa cuando exista el bucket de S3 -----
    router.get('/profile/image', requireAuth, (req, res) => res.json({ success: true, profileImage: null }));
    const notYet = (req, res) => res.status(503).json({ error: 'La foto de perfil estará disponible pronto', code: 'NOT_AVAILABLE' });
    router.post('/profile/upload', requireAuth, notYet);
    router.delete('/profile/delete', requireAuth, notYet);

    // ----- Juegos (flujo 1) -----
    router.get('/games/hi-lo/active', requireAuth, wrap(async (req, res) => {
        res.json(await games.hiloActive(req.user));
    }));
    router.get('/games/mines/active', requireAuth, wrap(async (req, res) => {
        res.json(await games.minesActive(req.user));
    }));
    router.post('/games/mines/cashout', requireAuth, wrap(async (req, res) => {
        res.json(await games.minesCashout(req.user, req.body, rng));
    }));
    router.post('/games/hi-lo/deal', requireAuth, wrap(async (req, res) => {
        res.status(201).json(await games.hiloDeal(req.user, req.body, rng));
    }));
    router.post('/games/hi-lo', requireAuth, wrap(async (req, res) => {
        res.json(await games.hiloPlay(req.user, req.body, rng));
    }));
    router.post('/games/roulette', requireAuth, wrap(async (req, res) => {
        res.json(await games.roulettePlay(req.user, req.body, rng));
    }));
    router.post('/games/mines/start', requireAuth, wrap(async (req, res) => {
        res.status(201).json(await games.minesStart(req.user, req.body, rng));
    }));
    router.post('/games/mines/reveal', requireAuth, wrap(async (req, res) => {
        res.json(await games.minesReveal(req.user, req.body, rng));
    }));

    return router;
}

module.exports = { buildRouter };
