const {
    SubscribeCommand, UnsubscribeCommand, ListSubscriptionsByTopicCommand,
    SetSubscriptionAttributesCommand, GetSubscriptionAttributesCommand,
} = require('@aws-sdk/client-sns');
const { GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('../lib/ddb');
const aws = require('../lib/aws');
const { config } = require('../config/env');

function enabled() {
    return Boolean(config.userTopicArn);
}

const isArn = (arn) => typeof arn === 'string' && arn.startsWith('arn:');
const policyFor = (userId) => JSON.stringify({ audience: [userId, 'all'] });

// SNS rechaza Subscribe si el correo ya tiene una suscripción en el tema con otra FilterPolicy.
function isDifferentAttributes(err) {
    return Boolean(err) && err.name === 'InvalidParameterException' && /different attributes|already exists/i.test(err.message || '');
}

// Busca la suscripción email de ese correo en el tema (paginado). Las pendientes no traen ARN real.
async function findSubscriptionArn(email) {
    const target = email.toLowerCase();
    let token;
    do {
        const res = await aws.sns().send(new ListSubscriptionsByTopicCommand({ TopicArn: config.userTopicArn, NextToken: token }));
        const hit = (res.Subscriptions || []).find((s) => s.Protocol === 'email'
            && typeof s.Endpoint === 'string' && s.Endpoint.toLowerCase() === target);
        if (hit) return isArn(hit.SubscriptionArn) ? hit.SubscriptionArn : null;
        token = res.NextToken;
    } while (token);
    return null;
}

// La suscripción ya existe (p. ej. quedó de otra cuenta): se le pone el filtro de este jugador.
async function adoptSubscription(userId, email) {
    const arn = await findSubscriptionArn(email);
    if (!arn) return null;
    await aws.sns().send(new SetSubscriptionAttributesCommand({
        SubscriptionArn: arn, AttributeName: 'FilterPolicy', AttributeValue: policyFor(userId),
    }));
    return arn;
}

// Si SNS devolvió un ARN que estaba pendiente de borrar (el jugador regresó a ese correo),
// se saca de la lista para que cleanupPending no borre la suscripción vigente.
async function dropPending(userId, list, arn) {
    const i = list.indexOf(arn);
    if (i < 0) return;
    try {
        await ddb.send(new UpdateCommand({
            TableName: config.tables.users, Key: { userId },
            UpdateExpression: `REMOVE pendingUnsubscribeArns[${i}]`,
            ConditionExpression: `pendingUnsubscribeArns[${i}] = :a`,
            ExpressionAttributeValues: { ':a': arn },
        }));
    } catch (err) {
        // Si la lista cambió, cleanupPending lo trata como resuelto al ver que es el ARN vigente.
        if (err.name !== 'ConditionalCheckFailedException') console.warn('No se pudo quitar el ARN de pendientes', userId, err.name);
    }
}

// Suscribe el correo al tema de avisos con filtro por jugador (LLD §7) y guarda el ARN junto con
// `notifyEmail` (el correo al que apunta). Solo escribe si el correo del usuario sigue siendo `email`
// y el ARN guardado sigue siendo `oldArn` (el que se leyó): no pisa escrituras concurrentes.
// Nunca hace fallar la petición: si SNS falla la cuenta queda como estaba y se registra.
async function subscribeUser(userId, email, oldArn) {
    if (!enabled()) return null;
    let arn = null;
    try {
        try {
            const res = await aws.sns().send(new SubscribeCommand({
                TopicArn: config.userTopicArn,
                Protocol: 'email',
                Endpoint: email,
                Attributes: { FilterPolicy: policyFor(userId) },
                ReturnSubscriptionArn: true,
            }));
            arn = res.SubscriptionArn || null;
        } catch (err) {
            if (!isDifferentAttributes(err)) throw err;
            arn = await adoptSubscription(userId, email);
        }
        if (!arn) return null;
        const values = { ':a': arn, ':e': email };
        if (oldArn) values[':old'] = oldArn;
        const res = await ddb.send(new UpdateCommand({
            TableName: config.tables.users, Key: { userId },
            UpdateExpression: 'SET notifySubscriptionArn = :a, notifyEmail = :e',
            ConditionExpression: `email = :e AND ${oldArn ? 'notifySubscriptionArn = :old' : 'attribute_not_exists(notifySubscriptionArn)'}`,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
        }));
        await dropPending(userId, (res && res.Attributes && res.Attributes.pendingUnsubscribeArns) || [], arn);
        return arn;
    } catch (err) {
        if (err.name === 'ConditionalCheckFailedException' && arn) return lostRace(userId, arn);
        console.error('No se pudo crear la suscripción SNS', userId, err.name, err.message);
        return null;
    }
}

// Otra escritura cambió el correo o el ARN mientras se suscribía. Si el ARN vigente no es el que
// se acaba de crear, ese queda huérfano y se retira para que no reciba avisos de este jugador.
async function lostRace(userId, arn) {
    try {
        const res = await ddb.send(new GetCommand({ TableName: config.tables.users, Key: { userId }, ConsistentRead: true }));
        const current = res.Item && res.Item.notifySubscriptionArn;
        if (current === arn) return arn;
        await retire(userId, arn);
    } catch (err) {
        console.warn('No se pudo revisar la suscripción tras una escritura concurrente', userId, err.name);
    }
    return null;
}

// Quita una suscripción. Una pendiente de confirmar no se puede borrar (SNS la limpia sola).
// NotFound cuenta como borrada.
async function unsubscribe(arn) {
    if (!enabled() || !isArn(arn)) return false;
    try {
        await aws.sns().send(new UnsubscribeCommand({ SubscriptionArn: arn }));
        return true;
    } catch (err) {
        if (err.name === 'NotFoundException') return true;
        console.warn('No se pudo quitar la suscripción SNS anterior', err.name, err.message);
        return false;
    }
}

// Guarda un ARN que no se pudo borrar para reintentarlo después (sin duplicados).
async function addPendingUnsubscribe(userId, arn) {
    try {
        await ddb.send(new UpdateCommand({
            TableName: config.tables.users, Key: { userId },
            UpdateExpression: 'SET pendingUnsubscribeArns = list_append(if_not_exists(pendingUnsubscribeArns, :empty), :one)',
            ConditionExpression: 'attribute_exists(userId) AND (attribute_not_exists(pendingUnsubscribeArns) OR NOT contains(pendingUnsubscribeArns, :arn))',
            ExpressionAttributeValues: { ':empty': [], ':one': [arn], ':arn': arn },
        }));
    } catch (err) {
        if (err.name !== 'ConditionalCheckFailedException') console.warn('No se pudo guardar la suscripción pendiente', userId, err.name);
    }
}

// ¿La suscripción sigue siendo de este jugador? Si otra cuenta la adoptó, no se toca.
// Regresa true (es suya), false (ya no es suya o ya no existe) o null (no se supo).
async function stillOwnedBy(arn, userId) {
    try {
        const res = await aws.sns().send(new GetSubscriptionAttributesCommand({ SubscriptionArn: arn }));
        const policy = JSON.parse((res.Attributes && res.Attributes.FilterPolicy) || '{}');
        return Array.isArray(policy.audience) && policy.audience.includes(userId);
    } catch (err) {
        if (err.name === 'NotFoundException') return false;
        return null;
    }
}

// Reintenta borrar las suscripciones pendientes del usuario. Tolerante: nunca lanza.
// Regresa cuántas quedan pendientes.
async function cleanupPending(user) {
    const list = user && Array.isArray(user.pendingUnsubscribeArns) ? user.pendingUnsubscribeArns : [];
    if (!enabled() || !list.length) return list.length;
    try {
        const done = [];
        for (let i = 0; i < list.length; i += 1) {
            const arn = list[i];
            // El ARN vigente nunca se borra: SNS lo regresó otra vez porque el jugador volvió a ese correo.
            if (arn === user.notifySubscriptionArn) { done.push(i); continue; }
            const owned = isArn(arn) ? await stillOwnedBy(arn, user.userId) : false;
            if (owned === false || (owned && (await unsubscribe(arn)))) done.push(i);
        }
        if (!done.length) return list.length;
        // Se quitan por posición y solo si cada posición sigue teniendo el mismo ARN
        // (lo nuevo se agrega al final); si algo cambió, se reintenta la próxima vez.
        const values = {};
        const checks = done.map((i) => { values[`:a${i}`] = list[i]; return `pendingUnsubscribeArns[${i}] = :a${i}`; });
        await ddb.send(new UpdateCommand({
            TableName: config.tables.users, Key: { userId: user.userId },
            UpdateExpression: `REMOVE ${done.map((i) => `pendingUnsubscribeArns[${i}]`).join(', ')}`,
            ConditionExpression: checks.join(' AND '),
            ExpressionAttributeValues: values,
        }));
        return list.length - done.length;
    } catch (err) {
        console.warn('No se pudieron limpiar las suscripciones pendientes', user.userId, err.name);
        return list.length;
    }
}

// Retira una suscripción: se borra solo si sigue siendo de este jugador (otra cuenta pudo
// adoptarla); si no se sabe o no se pudo borrar, queda pendiente para el siguiente login.
async function retire(userId, arn) {
    if (!isArn(arn)) return;
    const owned = await stillOwnedBy(arn, userId);
    if (owned === null || (owned && !(await unsubscribe(arn)))) await addPendingUnsubscribe(userId, arn);
}

// Suscribe `email` y retira la suscripción `oldArn`, aunque la nueva falle: así el correo viejo
// (que quizá ya es de otra persona) deja de recibir avisos de este jugador. Si la nueva falla,
// `notifyEmail` se queda con el correo viejo y el siguiente login lo reintenta.
// `oldEmail` es el correo al que apunta `oldArn`; en cuentas sin `notifyEmail` se guarda para
// que el reintento no dependa de ese campo.
async function resubscribe(userId, email, oldArn, oldEmail) {
    if (!enabled()) return null;
    const arn = await subscribeUser(userId, email, oldArn);
    if (oldArn && oldArn !== arn) await retire(userId, oldArn);
    if (!arn && oldArn && oldEmail && oldEmail !== email) await keepNotifyEmail(userId, oldArn, oldEmail);
    return arn;
}

async function keepNotifyEmail(userId, arn, email) {
    try {
        await ddb.send(new UpdateCommand({
            TableName: config.tables.users, Key: { userId },
            UpdateExpression: 'SET notifyEmail = :e',
            ConditionExpression: 'notifySubscriptionArn = :a AND attribute_not_exists(notifyEmail)',
            ExpressionAttributeValues: { ':a': arn, ':e': email },
        }));
    } catch (err) {
        if (err.name !== 'ConditionalCheckFailedException') console.warn('No se pudo guardar notifyEmail', userId, err.name);
    }
}

// ¿La suscripción guardada ya no sirve? Sin ARN, apunta a otro correo, o SNS ya la borró
// (p. ej. nunca se confirmó). Cuentas sin `notifyEmail` cuentan como apuntando al correo actual.
async function needsResubscribe(user) {
    const arn = user.notifySubscriptionArn;
    if (!arn) return true;
    if ((user.notifyEmail || user.email) !== user.email) return true;
    return isArn(arn) && (await stillOwnedBy(arn, user.userId)) === false;
}

// Tareas de SNS que no deben retrasar la respuesta. Nunca lanzan; settle() deja esperarlas (pruebas).
const running = new Set();
function background(task) {
    const p = Promise.resolve().then(task)
        .catch((err) => console.warn('Falló una tarea de avisos en segundo plano', err && err.name))
        .finally(() => running.delete(p));
    running.add(p);
}
async function settle() {
    while (running.size) await Promise.all([...running]);
}

// Al iniciar sesión: limpia pendientes y, si la suscripción guardada ya no sirve, resuscribe al
// correo actual (la vieja se retira con las mismas reglas que en el cambio de correo).
function afterLogin(user) {
    if (!enabled() || !user) return;
    background(async () => {
        await cleanupPending(user);
        if (await needsResubscribe(user)) {
            await resubscribe(user.userId, user.email, user.notifySubscriptionArn, user.notifyEmail || user.email);
        }
    });
}

module.exports = {
    enabled, subscribeUser, unsubscribe, resubscribe, cleanupPending, addPendingUnsubscribe, afterLogin, settle,
};
