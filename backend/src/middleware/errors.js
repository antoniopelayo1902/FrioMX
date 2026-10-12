const multer = require('multer');
const { AppError } = require('../lib/errors');

const MULTER_MESSAGES = {
    LIMIT_FILE_SIZE: 'La foto no puede pesar más de 5 MB',
    LIMIT_FILE_COUNT: 'Solo se puede subir una foto',
    LIMIT_UNEXPECTED_FILE: 'El archivo debe ir en el campo profileImage',
};

// Manejador central: todas las respuestas de error tienen la forma { error, code }.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    // Los errores de multer no traen status: son siempre culpa de la petición.
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: MULTER_MESSAGES[err.code] || 'Archivo inválido', code: 'VALIDATION_ERROR' });
    }
    if (err instanceof AppError) {
        return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
    }
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'JSON mal formado', code: 'VALIDATION_ERROR' });
    }
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Cuerpo demasiado grande', code: 'PAYLOAD_TOO_LARGE' });
    }
    if (err && Number.isInteger(err.status) && err.status < 500) {
        return res.status(err.status).json({ error: err.message || 'Petición inválida', code: 'VALIDATION_ERROR' });
    }
    if (err && (err.name === 'TransactionConflictException' || err.name === 'ConditionalCheckFailedException')) {
        console.warn('Conflicto de DynamoDB sin manejar:', err.name, err.message);
        return res.status(409).json({ error: 'Otra acción llegó al mismo tiempo, intenta de nuevo', code: 'CONFLICT' });
    }
    console.error('Error no controlado:', err);
    return res.status(500).json({ error: 'Error interno', code: 'INTERNAL' });
}

function notFoundHandler(req, res) {
    res.status(404).json({ error: 'Ruta no encontrada', code: 'NOT_FOUND' });
}

// Envuelve handlers async para que sus errores lleguen al manejador central.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { errorHandler, notFoundHandler, wrap };
