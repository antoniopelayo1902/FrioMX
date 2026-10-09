const express = require('express');
const helmet = require('helmet');
const { assertConfig } = require('./config/env');
const { buildRouter } = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errors');

// Arma la app de Express sin hacer listen, para poder probarla con supertest.
function createApp(options = {}) {
    assertConfig();
    const app = express();
    app.set('trust proxy', 1);
    app.disable('x-powered-by');
    app.use(helmet());
    app.use(express.json({ limit: '10kb' }));
    // Respuestas con datos del usuario: nunca en caché del navegador ni de intermediarios.
    app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    app.use('/api', buildRouter(options));
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
}

module.exports = { createApp };
