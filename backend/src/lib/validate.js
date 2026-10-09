const { badRequest } = require('./errors');

const MIN_BET = 1;
const MAX_BET = 10000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function betAmount(value, field = 'betAmount') {
    if (!Number.isInteger(value) || value < MIN_BET || value > MAX_BET) {
        throw badRequest(`${field} debe ser un entero entre ${MIN_BET} y ${MAX_BET}`);
    }
    return value;
}

function uuidV4(value, field) {
    if (typeof value !== 'string' || !UUID_V4.test(value)) {
        throw badRequest(`${field} inválido`);
    }
    return value;
}

function email(value) {
    if (typeof value !== 'string') throw badRequest('Correo inválido');
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 254 || !EMAIL.test(normalized)) throw badRequest('Correo inválido');
    return normalized;
}

function name(value) {
    if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 40) {
        throw badRequest('El nombre debe tener de 1 a 40 caracteres');
    }
    if (/[<>]/.test(value)) throw badRequest('El nombre no puede llevar los caracteres < o >');
    // Sin caracteres de control ni invisibles (saltos de línea, espacios de ancho cero, cambios de dirección).
    // Se permiten los unidores de emoji (U+200D, U+FE0F) para nombres como "Ana 👨‍👩‍👧".
    if (/[\p{Cc}\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/u.test(value)) {
        throw badRequest('El nombre tiene caracteres no permitidos');
    }
    if (!/[\p{L}\p{N}\p{S}]/u.test(value)) throw badRequest('El nombre debe tener al menos una letra o número');
    return value.trim();
}

function password(value) {
    if (typeof value !== 'string' || value.length < 8 || Buffer.byteLength(value, 'utf8') > 72) {
        throw badRequest('La contraseña debe tener al menos 8 caracteres y máximo 72 bytes');
    }
    return value;
}

function age(value) {
    const ok = (typeof value === 'number') || (typeof value === 'string' && /^[1-9]\d{0,2}$/.test(value.trim()));
    const n = ok ? Number(value) : NaN;
    if (!Number.isInteger(n) || n < 18 || n > 99) {
        throw badRequest('La edad debe ser un entero entre 18 y 99');
    }
    return n;
}

module.exports = { betAmount, uuidV4, email, name, password, age, MAX_BET };
