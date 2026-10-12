#!/usr/bin/env node
// Siembra jugadores ficticios y estadísticas de una semana para probar el ranking (LLD §6.3).
//
// Uso:
//   node scripts/seed.js --week <YYYY-Www> [--players <n>] [--include-email <correo> [--password <clave>]]
//
//   --week           obligatorio y de una semana pasada (rechaza la semana en curso y las futuras para no
//                    pisar estadísticas reales). Falla si la semana ya está cerrada en friomx-leaderboard.
//   --players        jugadores ficticios (1-50, por defecto 8). Sus ids salen del índice, así que repetir
//                    el seed reutiliza las mismas cuentas y solo reescribe sus filas de weekly-stats.
//   --include-email  cuenta real que queda en primer lugar. Si el correo no existe se crea con la
//                    contraseña de --password o, para no dejarla en el historial del shell, de SEED_PASSWORD.
//                    Si USER_TOPIC_ARN existe y la cuenta no tiene suscripción, se suscribe el correo a SNS
//                    con FilterPolicy {"audience":[userId,"all"]} (hay que confirmar el correo de AWS).
//
// Variables: AWS_REGION (us-east-1), DDB_ENDPOINT (solo DynamoDB Local, p. ej. http://localhost:8000),
//   TABLE_USERS, TABLE_USER_EMAILS, TABLE_WEEKLY_STATS, TABLE_LEADERBOARD (por defecto friomx-*), USER_TOPIC_ARN.
// Las dependencias se resuelven desde backend/node_modules (correr antes `npm ci` en backend/).
//
// Ejemplos:
//   DDB_ENDPOINT=http://localhost:8000 node scripts/seed.js --week 2026-W38
//   SEED_PASSWORD='...' node scripts/seed.js --week 2026-W38 --include-email yo@ejemplo.com
'use strict';

const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const requireBackend = createRequire(path.join(ROOT, 'backend', 'package.json'));
const requireLambdas = createRequire(path.join(ROOT, 'lambdas', 'package.json'));

function load(name) {
    try {
        return requireBackend(name);
    } catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND') throw err;
        return requireLambdas(name);
    }
}

const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const DAY_MS = 86400000;
const FAKE_NAMES = ['Ana', 'Beto', 'Carla', 'Dani', 'Eli', 'Fer', 'Gabo', 'Hugo', 'Iris', 'Jose', 'Karla', 'Luis'];
const WELCOME_CHIPS = 1000;

function fail(msg) {
    console.error(`Error: ${msg}`);
    process.exit(1);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        if (!key.startsWith('--')) fail(`argumento inesperado: ${key}`);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) fail(`falta el valor de ${key}`);
        args[key.slice(2)] = value;
        i += 1;
    }
    return args;
}

// Lunes de una semana ISO (YYYY-MM-DD) o null si no existe. Misma lógica que lambdas/shared/time.js.
function weekMonday(weekId) {
    const m = WEEK_RE.exec(weekId || '');
    if (!m) return null;
    const year = Number(m[1]);
    const week = Number(m[2]);
    if (week < 1 || week > 53) return null;
    const jan4 = Date.UTC(year, 0, 4);
    const jan4Day = new Date(jan4).getUTCDay() || 7;
    const monday = new Date(jan4 - (jan4Day - 1) * DAY_MS + (week - 1) * 7 * DAY_MS);
    // Si la semana 53 no existe, el lunes cae en la W01 del año siguiente.
    const thursday = new Date(monday.getTime() + 3 * DAY_MS);
    return thursday.getUTCFullYear() === year ? monday.toISOString().slice(0, 10) : null;
}

// UUID con forma v4 derivado de una semilla, para que repetir el seed reutilice las mismas cuentas.
function seededUuid(seed) {
    const b = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const weekId = args.week;
    if (!weekId) fail('--week <YYYY-Www> es obligatorio');
    const monday = weekMonday(weekId);
    if (!monday) fail(`semana inválida: ${weekId}`);
    // Solo semanas pasadas: sembrar la semana en curso pisaría las estadísticas reales de quien ya jugó.
    // El formato YYYY-Www ordena bien como texto. Zona: APP_TZ (por defecto America/Mexico_City).
    const { isoWeekId } = require(path.join(ROOT, 'lambdas', 'shared', 'time.js'));
    const currentWeek = isoWeekId(new Date());
    if (weekId >= currentWeek) {
        fail(`--week ${weekId} es la semana en curso o una futura (hoy es ${currentWeek}); usa una semana pasada, p. ej. la anterior`);
    }
    const players = args.players === undefined ? 8 : Number(args.players);
    if (!Number.isInteger(players) || players < 1 || players > 50) fail('--players debe ser un entero de 1 a 50');

    const bcrypt = load('bcryptjs');
    const { DynamoDBClient } = load('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, TransactWriteCommand } = load('@aws-sdk/lib-dynamodb');

    const region = process.env.AWS_REGION || 'us-east-1';
    const clientConfig = { region };
    if (process.env.DDB_ENDPOINT) {
        clientConfig.endpoint = process.env.DDB_ENDPOINT;
        clientConfig.credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
    }
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig), {
        marshallOptions: { removeUndefinedValues: true },
    });
    const T = {
        users: process.env.TABLE_USERS || 'friomx-users',
        userEmails: process.env.TABLE_USER_EMAILS || 'friomx-user-emails',
        weeklyStats: process.env.TABLE_WEEKLY_STATS || 'friomx-weekly-stats',
        leaderboard: process.env.TABLE_LEADERBOARD || 'friomx-leaderboard',
    };

    // 1. La semana no debe estar cerrada.
    try {
        const closed = await ddb.send(new GetCommand({ TableName: T.leaderboard, Key: { weekId } }));
        if (closed.Item) fail(`la semana ${weekId} ya está cerrada en ${T.leaderboard}; elige otra`);
    } catch (err) {
        if (err.name !== 'ResourceNotFoundException') throw err;
        console.warn(`Aviso: no existe la tabla ${T.leaderboard}; no se pudo revisar si la semana está cerrada.`);
    }

    // Jueves 12:00 local (18:00 UTC) de la semana: fecha de "última partida" de los ficticios.
    const playedAt = new Date(Date.parse(`${monday}T18:00:00Z`) + 3 * DAY_MS).toISOString();
    const nowIso = new Date().toISOString();

    // 2. Cuenta real opcional (antes de escribir nada más, para fallar temprano).
    let realUser = null;
    if (args['include-email']) {
        const email = String(args['include-email']).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail(`correo inválido: ${email}`);
        const idx = await ddb.send(new GetCommand({ TableName: T.userEmails, Key: { email } }));
        let user;
        if (idx.Item) {
            user = (await ddb.send(new GetCommand({ TableName: T.users, Key: { userId: idx.Item.userId }, ConsistentRead: true }))).Item;
            if (!user) fail(`el índice de correos apunta a ${idx.Item.userId}, que no existe en ${T.users}`);
            console.log(`Usando cuenta existente ${email}`);
        } else {
            const password = args.password || process.env.SEED_PASSWORD;
            if (!password) fail(`${email} no existe: pasa --password o define SEED_PASSWORD para crearla`);
            if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) fail('la contraseña debe tener al menos 8 caracteres y máximo 72 bytes');
            // Sin < ni > (validate.name los rechaza en la API) y nunca vacío.
            const name = email.split('@')[0].replace(/[<>]/g, '').slice(0, 40) || 'Jugador';
            user = {
                userId: crypto.randomUUID(), name, age: 21, email,
                passwordHash: await bcrypt.hash(password, 10), balance: WELCOME_CHIPS, createdAt: nowIso,
            };
            await ddb.send(new TransactWriteCommand({
                TransactItems: [
                    { Put: { TableName: T.userEmails, Item: { email, userId: user.userId }, ConditionExpression: 'attribute_not_exists(#email)', ExpressionAttributeNames: { '#email': 'email' } } },
                    { Put: { TableName: T.users, Item: user, ConditionExpression: 'attribute_not_exists(#userId)', ExpressionAttributeNames: { '#userId': 'userId' } } },
                ],
            }));
            console.log(`Creada cuenta ${email}`);
        }

        if (process.env.USER_TOPIC_ARN && !user.notifySubscriptionArn) {
            // Un error de SNS (p. ej. el correo ya tiene otra suscripción) no detiene el seed:
            // la cuenta se queda sin avisos y el backend lo reintenta en el siguiente login.
            try {
                const { SNSClient, SubscribeCommand } = load('@aws-sdk/client-sns');
                const sub = await new SNSClient({ region }).send(new SubscribeCommand({
                    TopicArn: process.env.USER_TOPIC_ARN, Protocol: 'email', Endpoint: email,
                    Attributes: { FilterPolicy: JSON.stringify({ audience: [user.userId, 'all'] }) },
                    ReturnSubscriptionArn: true,
                }));
                await ddb.send(new UpdateCommand({
                    TableName: T.users, Key: { userId: user.userId },
                    UpdateExpression: 'SET #arn = :arn', ConditionExpression: 'attribute_exists(#userId)',
                    ExpressionAttributeNames: { '#arn': 'notifySubscriptionArn', '#userId': 'userId' },
                    ExpressionAttributeValues: { ':arn': sub.SubscriptionArn },
                }));
                console.log(`Suscrito ${email} a SNS: revisa el correo de confirmación de AWS.`);
            } catch (err) {
                console.warn(`Aviso: no se pudo suscribir ${email} a SNS (${err.name}: ${err.message}); se sigue sin avisos.`);
            }
        }

        realUser = user;
    }

    // 3. Jugadores ficticios: cuentas (si no existen) y su fila de la semana.
    const rows = [];
    for (let i = 0; i < players; i += 1) {
        const userId = seededUuid(`friomx-seed-player-${i}`);
        const name = `${FAKE_NAMES[i % FAKE_NAMES.length]} Demo${i >= FAKE_NAMES.length ? ` ${i}` : ''}`;
        const email = `seed-player-${i}@friomx.test`;
        // Neto descendente con algunos negativos al final; empates de net se desempatan por gamesPlayed.
        const net = 3000 - i * 600;
        const gamesPlayed = 5 + ((i * 7) % 11);
        try {
            await ddb.send(new TransactWriteCommand({
                TransactItems: [
                    { Put: { TableName: T.userEmails, Item: { email, userId }, ConditionExpression: 'attribute_not_exists(#email)', ExpressionAttributeNames: { '#email': 'email' } } },
                    {
                        Put: {
                            TableName: T.users,
                            Item: {
                                userId, name, age: 18 + (i % 30), email,
                                // Contraseña aleatoria descartada: las cuentas ficticias no sirven para entrar.
                                passwordHash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10),
                                balance: WELCOME_CHIPS, createdAt: nowIso, lastPlayedAt: playedAt,
                            },
                            ConditionExpression: 'attribute_not_exists(#userId)',
                            ExpressionAttributeNames: { '#userId': 'userId' },
                        },
                    },
                ],
            }));
        } catch (err) {
            if (err.name !== 'TransactionCanceledException') throw err; // ya existía: se reutiliza
        }
        rows.push({ weekId, userId, name, net, gamesPlayed });
    }

    // La cuenta real queda en primer lugar.
    let real = null;
    if (realUser) {
        real = { weekId, userId: realUser.userId, name: realUser.name, net: rows[0].net + 1000, gamesPlayed: 12 };
        rows.unshift(real);
    }

    // 4. Filas de weekly-stats (se reescriben si ya existían).
    for (const row of rows) {
        await ddb.send(new PutCommand({ TableName: T.weeklyStats, Item: row }));
    }

    console.log(`Semana ${weekId}: ${rows.length} filas en ${T.weeklyStats}`);
    for (const r of [...rows].sort((a, b) => b.net - a.net)) {
        console.log(`  ${String(r.net).padStart(6)}  ${r.gamesPlayed} partidas  ${r.name}${r === real ? '  (cuenta real)' : ''}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
