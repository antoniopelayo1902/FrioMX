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

function signToken(userId) {
    return jwt.sign({ sub: userId }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '7d' });
}

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
    if (!idx.Item) throw invalid;
    const user = await getUser(idx.Item.userId);
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) throw invalid;

    return { token: signToken(user.userId), user: publicUser(user) };
}

function profileOf(user) {
    return {
        id: user.userId, name: user.name, age: user.age, email: user.email,
        balance: user.balance, profileImageUrl: null,
    };
}

async function updateProfile(user, body = {}) {
    const { field, newValue } = body;

    if (field === 'username') {
        const name = v.name(newValue);
        await ddb.send(new UpdateCommand({
            TableName: T.users, Key: { userId: user.userId },
            UpdateExpression: 'SET #name = :name', ExpressionAttributeNames: { '#name': 'name' },
            ExpressionAttributeValues: { ':name': name },
        }));
    } else if (field === 'password') {
        const password = v.password(newValue);
        await ddb.send(new UpdateCommand({
            TableName: T.users, Key: { userId: user.userId },
            UpdateExpression: 'SET passwordHash = :h',
            ExpressionAttributeValues: { ':h': await bcrypt.hash(password, 10) },
        }));
    } else if (field === 'email') {
        const email = v.email(newValue);
        if (email !== user.email) {
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
                if (codes && codes[1] === 'ConditionalCheckFailed') {
                    throw new AppError(409, 'EMAIL_IN_USE', 'El correo ya está en uso');
                }
                throw err;
            }
        }
    } else {
        throw new AppError(400, 'VALIDATION_ERROR', 'Campo inválido');
    }

    return profileOf(await getUser(user.userId));
}

module.exports = { register, login, getUser, profileOf, updateProfile, signToken, WELCOME_CHIPS };
