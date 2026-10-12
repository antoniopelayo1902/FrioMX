const crypto = require('crypto');

// Espacio de nombres fijo de FrioMx para derivar ids v5. No cambiarlo: cambiaría todos los rechargeId.
const NAMESPACE_FRIOMX = 'b3c1f0a2-6d4e-4f8a-9c21-7e5d3a9b1c40';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// UUID v5 (RFC 4122 §4.3): SHA-1 del espacio de nombres más el nombre, con versión 5 y variante RFC.
function uuidv5(name, namespace = NAMESPACE_FRIOMX) {
    if (!UUID.test(namespace)) throw new Error('Espacio de nombres inválido');
    const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const bytes = crypto.createHash('sha1').update(ns).update(Buffer.from(String(name), 'utf8')).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Igual que uuid.validate(x) && uuid.version(x) === n (solo variante RFC).
function isUuidVersion(value, version) {
    return typeof value === 'string' && UUID.test(value)
        && value[14] === String(version) && /[89ab]/i.test(value[19]);
}

module.exports = { uuidv5, isUuidVersion, NAMESPACE_FRIOMX };
