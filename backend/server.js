require('dotenv').config();
const { createApp } = require('./src/app');
const { config } = require('./src/config/env');

const app = createApp();

// Solo escucha en loopback: en la nube nginx (mismo host) es la única entrada.
app.listen(config.port, config.host, () => {
    console.log(`API de FrioMx escuchando en el puerto ${config.port}`);
});
