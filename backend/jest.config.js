module.exports = {
    testEnvironment: 'node',
    collectCoverageFrom: ['src/**/*.js'],
    // RNF-09: mínimo 70% en las cuatro medidas; el CI falla si baja.
    coverageThreshold: { global: { lines: 70, branches: 70, functions: 70, statements: 70 } },
    testTimeout: 20000,
};
