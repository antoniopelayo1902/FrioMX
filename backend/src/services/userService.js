const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { GetCommand, UpdateCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, cancellationCodes } = require('../lib/ddb');
const { config } = require('../config/env');
const { AppError } = require('../lib/errors');
const v = require('../lib/validate');

const T = config.tables;
const WELCOME_CHIPS = 1000;

// `tv` es la versión de sesión del usuario: al cambiar la contraseña sube y los tokens anteriores dejan de valer.
function signToken(userId, tokenVersion = 0) {
    return jwt.sign({ sub: userId, tv: tokenVersion }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '7d' });
}

// Hash fijo para comparar cuando el correo no existe: el login tarda lo mismo y no revela qué correos hay.
const DUMMY_HASH = bcrypt.hashSync('friomx-dummy-password', 10);

function publicUser(user) {
    return { id: user.userId, name: user.name, email: user.email, balance: user.balance };
}

async function getUser(userId) {
    const res = await ddb.send(new GetCommand({ TableName: T.users, Key: { userId }, ConsistentRead: true }));
    return res.Item || null;
}

async function register(body = {}) {
    if (!body.name || body.age === undefined || !body.email || !body.password) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Todos los campos son requeridos');
    }
    const name = v.name(body.name);
    const age = v.age(body.age);
    const email = v.email(body.email);
    const password = v.password(body.password);

    const userId = crypto.randomUUID();
    const user = {
        userId, name, age, email,
        passwordHash: await bcrypt.hash(password, 10),
        balance: WELCOME_CHIPS,
        createdAt: new Date().toISOString(),
    };

    try {
        await ddb.send(new TransactWriteCommand({
            TransactItems: [
                { Put: { TableName: T.userEmails, Item: { email, userId }, ConditionExpression: 'attribute_not_exists(email)' } },
                { Put: { TableName: T.users, Item: user, ConditionExpression: 'attribute_not_exists(userId)' } },
            ],
        }));
    } catch (err) {
        const codes = cancellationCodes(err);
        if (codes && codes[0] === 'ConditionalCheckFailed') {
            throw new AppError(409, 'EMAIL_IN_USE', 'Ya existe una cuenta con ese correo');
        }
        throw err;
    }

    return { token: signToken(userId), user: publicUser(user) };
}

async function login(body = {}) {
    const invalid = new AppError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos');
    if (typeof body.email !== 'string' || typeof body.password !== 'string') throw invalid;
    const email = body.email.trim().toLowerCase();

    const idx = await ddb.send(new GetCommand({ TableName: T.userEmails, Key: { email } }));
    const user = idx.Item ? await getUser(idx.Item.userId) : null;
    const ok = await bcrypt.compare(body.password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) throw invalid;

    return { token: signToken(user.userId, user.tokenVersion || 0), user: publicUser(user) };
}

function profileOf(user) {
    return {
        id: user.userId, name: user.name, age: user.age, email: user.email,
        balance: user.balance, profileImageUrl: null,
    };
}

async function checkCurrentPassword(user, currentPassword) {
    if (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
        throw new AppError(403, 'WRONG_PASSWORD', 'La contraseña actual no es correcta');
    }
}

async function updateProfile(user, body = {}) {
    const { field, newValue, currentPassword } = body;
    let token;

    if (field === 'username') {
        const name = v.name(newValue);
        await ddb.send(new UpdateCommand({
            TableName: T.users, Key: { userId: user.userId },
            UpdateExpression: 'SET #name = :name', ExpressionAttributeNames: { '#name': 'name' },
            ExpressionAttributeValues: { ':name': name },
        }));
    } else if (field === 'password') {
        const password = v.password(newValue);
        await checkCurrentPassword(user, currentPassword);
        // Sube la versión de sesión: todos los tokens anteriores dejan de valer y esta sesión recibe uno nuevo.
        // La condición sobre la versión leída evita que dos cambios simultáneos respondan los dos con éxito.
        const current = user.tokenVersion || 0;
        try {
            const res = await ddb.send(new UpdateCommand({
                TableName: T.users, Key: { userId: user.userId },
                UpdateExpression: 'SET passwordHash = :h, tokenVersion = :next',
                ConditionExpression: 'attribute_not_exists(tokenVersion) OR tokenVersion = :cur',
                ExpressionAttributeValues: { ':h': await bcrypt.hash(password, 10), ':next': current + 1, ':cur': current },
                ReturnValues: 'ALL_NEW',
            }));
            token = signToken(user.userId, res.Attributes.tokenVersion);
        } catch (err) {
            if (err.name === 'ConditionalCheckFailedException') {
                throw new AppError(409, 'CONFLICT', 'Tu contraseña cambió en otra sesión, inicia sesión de nuevo');
            }
            throw err;
        }
    } else if (field === 'email') {
        const email = v.email(newValue);
        if (email !== user.email) {
            await checkCurrentPassword(user, currentPassword);
            try {
                await ddb.send(new TransactWriteCommand({
                    TransactItems: [
                        {
                            Delete: {
                                TableName: T.userEmails, Key: { email: user.email },
                                ConditionExpression: 'userId = :me', ExpressionAttributeValues: { ':me': user.userId },
                            },
                        },
                        { Put: { TableName: T.userEmails, Item: { email, userId: user.userId }, ConditionExpression: 'attribute_not_exists(email)' } },
                        {
                            Update: {
                                TableName: T.users, Key: { userId: user.userId },
                                UpdateExpression: 'SET email = :e', ExpressionAttributeValues: { ':e': email },
                            },
                        },
                    ],
                }));
            } catch (err) {
                const codes = cancellationCodes(err);
                // Doble clic: la otra petición ya hizo este mismo cambio, así que no es un error.
                const fresh = codes ? await getUser(user.userId) : null;
                if (fresh && fresh.email === email) return profileOf(fresh);
                if (codes && codes[1] === 'ConditionalCheckFailed') {
                    throw new AppError(409, 'EMAIL_IN_USE', 'El correo ya está en uso');
                }
                if (codes) throw new AppError(409, 'CONFLICT', 'Tu correo cambió en otra petición, recarga la página');
                throw err;
            }
        }
    } else {
        throw new AppError(400, 'VALIDATION_ERROR', 'Campo inválido');
    }

    const profile = profileOf(await getUser(user.userId));
    return token ? { ...profile, token } : profile;
}

module.exports = { register, login, getUser, profileOf, updateProfile, signToken, WELCOME_CHIPS };
