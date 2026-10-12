const crypto = require('crypto');
const multer = require('multer');
const { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../lib/ddb');
const aws = require('../lib/aws');
const { config } = require('../config/env');
const { badRequest } = require('../lib/errors');

const MAX_BYTES = 5 * 1024 * 1024;
const URL_TTL_SECONDS = 15 * 60;
const TYPES = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]);

function enabled() {
    return Boolean(config.uploadsBucket);
}

// Multer en memoria: el archivo llega como Buffer y se sube directo a S3, nunca toca el disco.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1, fields: 5 },
    fileFilter: (req, file, cb) => {
        if (TYPES.has(file.mimetype)) return cb(null, true);
        const err = new Error('La foto debe ser JPG, PNG o WebP');
        err.status = 400;
        return cb(err);
    },
}).single('profileImage');

// El mimetype lo declara el navegador: se confirma con los primeros bytes del archivo.
function matchesSignature(buffer, mimetype) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
    if (mimetype === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (mimetype === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (mimetype === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    return false;
}

function signedUrl(key) {
    return getSignedUrl(aws.s3(), new GetObjectCommand({ Bucket: config.uploadsBucket, Key: key }), { expiresIn: URL_TTL_SECONDS });
}

async function imageUrlOf(user) {
    if (!enabled() || !user || !user.profileImageKey) return null;
    return signedUrl(user.profileImageKey);
}

// Borrar la foto vieja es limpieza: si falla se registra y la petición sigue bien.
async function deleteObjectQuietly(key) {
    try {
        await aws.s3().send(new DeleteObjectCommand({ Bucket: config.uploadsBucket, Key: key }));
    } catch (err) {
        console.warn('No se pudo borrar la foto de S3', key, err.name);
    }
}

async function saveProfileImage(user, file) {
    if (!file) throw badRequest('Falta el archivo profileImage');
    if (!matchesSignature(file.buffer, file.mimetype)) throw badRequest('El archivo no es una imagen válida');
    const key = `profile-images/${user.userId}/${Date.now()}-${crypto.randomUUID()}.${TYPES.get(file.mimetype)}`;
    await aws.s3().send(new PutObjectCommand({
        Bucket: config.uploadsBucket, Key: key, Body: file.buffer, ContentType: file.mimetype,
    }));
    let res;
    try {
        res = await ddb.send(new UpdateCommand({
            TableName: config.tables.users, Key: { userId: user.userId },
            UpdateExpression: 'SET profileImageKey = :k',
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':k': key },
            ReturnValues: 'UPDATED_OLD',
        }));
    } catch (err) {
        // Sin registro en DynamoDB la foto recién subida quedaría huérfana en S3.
        await deleteObjectQuietly(key);
        throw err;
    }
    const old = res.Attributes && res.Attributes.profileImageKey;
    if (old && old !== key) await deleteObjectQuietly(old);
    return { success: true, profileImage: await signedUrl(key) };
}

async function deleteProfileImage(user) {
    const res = await ddb.send(new UpdateCommand({
        TableName: config.tables.users, Key: { userId: user.userId },
        UpdateExpression: 'REMOVE profileImageKey',
        ConditionExpression: 'attribute_exists(userId)',
        ReturnValues: 'UPDATED_OLD',
    }));
    const old = res.Attributes && res.Attributes.profileImageKey;
    if (old) await deleteObjectQuietly(old);
    return { success: true };
}

async function getProfileImage(user) {
    // available: si hay bucket, para que el frontend sepa si mostrar subir/borrar sin sondear.
    return { success: true, available: enabled(), profileImage: await imageUrlOf(user) };
}

module.exports = {
    enabled, upload, matchesSignature, imageUrlOf, saveProfileImage, deleteProfileImage, getProfileImage, MAX_BYTES, URL_TTL_SECONDS,
};
