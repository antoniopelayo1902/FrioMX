module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/test'],
    collectCoverageFrom: ['*/index.js', 'shared/**/*.js', '!dist/**'],
    coveragePathIgnorePatterns: ['/node_modules/', '/dist/', '/coverage/'],
    // Arranca en 0 y sube por etapas (LLD §15).
    coverageThreshold: { global: { lines: 0, branches: 0, functions: 0, statements: 0 } },
};
