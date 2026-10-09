// Crea las tablas de FrioMx en DynamoDB Local para desarrollo.
// Uso: DDB_ENDPOINT=http://localhost:8000 node scripts/create-local-tables.js
require('dotenv').config();
const { DynamoDBClient, CreateTableCommand, ListTablesCommand, UpdateTimeToLiveCommand } = require('@aws-sdk/client-dynamodb');
const { config } = require('../src/config/env');

if (!config.ddbEndpoint) {
    console.error('Este script es solo para DynamoDB Local. Define DDB_ENDPOINT.');
    process.exit(1);
}

const client = new DynamoDBClient({
    region: config.region,
    endpoint: config.ddbEndpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

const S = (name) => ({ AttributeName: name, AttributeType: 'S' });
const T = config.tables;

const tables = [
    { TableName: T.users, KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }], AttributeDefinitions: [S('userId')] },
    { TableName: T.userEmails, KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }], AttributeDefinitions: [S('email')] },
    {
        TableName: T.activity,
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
        AttributeDefinitions: [S('userId'), S('sk')],
    },
    {
        TableName: T.weeklyStats,
        KeySchema: [{ AttributeName: 'weekId', KeyType: 'HASH' }, { AttributeName: 'userId', KeyType: 'RANGE' }],
        AttributeDefinitions: [S('weekId'), S('userId')],
    },
    { TableName: T.gameRounds, KeySchema: [{ AttributeName: 'gameId', KeyType: 'HASH' }], AttributeDefinitions: [S('gameId')] },
];

(async () => {
    const existing = new Set((await client.send(new ListTablesCommand({}))).TableNames);
    for (const table of tables) {
        if (existing.has(table.TableName)) {
            console.log(`ya existe ${table.TableName}`);
            continue;
        }
        await client.send(new CreateTableCommand({ ...table, BillingMode: 'PAY_PER_REQUEST' }));
        if (table.TableName === T.gameRounds) {
            // Igual que en la nube (LLD §4.1): las rondas se borran solas al vencer.
            await client.send(new UpdateTimeToLiveCommand({
                TableName: T.gameRounds, TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
            }));
        }
        console.log(`creada ${table.TableName}`);
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
