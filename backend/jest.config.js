module.exports = {
    testEnvironment: 'node',
    collectCoverageFrom: ['src/**/*.js'],
    // Arranca en 0 y sube por etapas (plan de migración, tareas 3.7 y 5.4).
    coverageThreshold: { global: { lines: 0, branches: 0, functions: 0, statements: 0 } },
    testTimeout: 20000,
};
