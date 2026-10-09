require('dotenv').config();
const { createApp } = require('./src/app');
const { config } = require('./src/config/env');

const app = createApp();

app.listen(config.port, () => {
    console.log(`API de FrioMx escuchando en el puerto ${config.port}`);
});
