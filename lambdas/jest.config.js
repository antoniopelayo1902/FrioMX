module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/test'],
    collectCoverageFrom: ['*/index.js', 'shared/**/*.js', '!dist/**'],
    coveragePathIgnorePatterns: ['/node_modules/', '/dist/', '/coverage/'],
    // RNF-09: mínimo 70% en las cuatro medidas; el CI falla si baja.
    coverageThreshold: { global: { lines: 70, branches: 70, functions: 70, statements: 70 } },
};
