const jwt = require('jsonwebtoken');
const { config } = require('../config/env');
const { AppError } = require('../lib/errors');
const { getUser } = require('../services/userService');

// El usuario se toma solo del token. Ninguna ruta acepta un id enviado por el cliente.
async function requireAuth(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) throw new AppError(401, 'UNAUTHORIZED', 'No autorizado');

        let payload;
        try {
            payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
        } catch {
            throw new AppError(401, 'UNAUTHORIZED', 'Sesión inválida o expirada');
        }

        if (typeof payload.sub !== 'string' || payload.sub.length > 64) {
            throw new AppError(401, 'UNAUTHORIZED', 'Sesión inválida o expirada');
        }
        const user = await getUser(payload.sub);
        if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Usuario no encontrado');
        if ((payload.tv || 0) !== (user.tokenVersion || 0)) {
            throw new AppError(401, 'UNAUTHORIZED', 'Tu contraseña cambió, inicia sesión de nuevo');
        }

        req.userId = user.userId;
        req.user = user;
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = { requireAuth };
