// Lógica pura de los juegos. No toca AWS para poder probarla con pruebas unitarias.
// El generador aleatorio se inyecta; por defecto es crypto.randomInt (máximo exclusivo).
const crypto = require('crypto');
const { badRequest } = require('../lib/errors');

const defaultRng = (min, max) => crypto.randomInt(min, max);

// ---------- Hi-lo ----------
// Cartas del 2 al 12 (11 valores). El empate pierde.
// Pago inversamente proporcional a la probabilidad de ganar (k/11), con 5% de ventaja de la casa.

function hiloDraw(rng = defaultRng) {
    return rng(2, 13);
}

function hiloWinningValues(oldCard, prediction) {
    if (prediction === 'higher') return 12 - oldCard;
    if (prediction === 'lower') return oldCard - 2;
    throw badRequest('prediction debe ser "higher" o "lower"');
}

function hiloResolve(oldCard, newCard, prediction, bet) {
    const k = hiloWinningValues(oldCard, prediction);
    if (k === 0) throw badRequest('Esa predicción no puede ganar con esta carta');
    const won = prediction === 'higher' ? newCard > oldCard : newCard < oldCard;
    // floor(bet * 0.95 * 11 / k) con aritmética entera exacta
    const payout = won ? Math.floor((bet * 1045) / (100 * k)) : 0;
    return { won, payout, net: payout - bet };
}

// ---------- Ruleta ----------
const ROULETTE_WHEEL = [
    { label: '0', color: 'Verde' },
    { label: '32', color: 'Rojo', parity: 'par', dozen: '3' },
    { label: '15', color: 'Negro', parity: 'impar', dozen: '2' },
    { label: '19', color: 'Rojo', parity: 'impar', dozen: '2' },
    { label: '4', color: 'Negro', parity: 'par', dozen: '1' },
    { label: '21', color: 'Rojo', parity: 'impar', dozen: '2' },
    { label: '2', color: 'Negro', parity: 'par', dozen: '1' },
    { label: '25', color: 'Rojo', parity: 'impar', dozen: '3' },
    { label: '17', color: 'Negro', parity: 'impar', dozen: '2' },
    { label: '34', color: 'Rojo', parity: 'par', dozen: '3' },
    { label: '6', color: 'Negro', parity: 'par', dozen: '1' },
    { label: '27', color: 'Rojo', parity: 'impar', dozen: '3' },
    { label: '13', color: 'Negro', parity: 'impar', dozen: '2' },
    { label: '36', color: 'Rojo', parity: 'par', dozen: '3' },
    { label: '11', color: 'Negro', parity: 'impar', dozen: '1' },
    { label: '30', color: 'Rojo', parity: 'par', dozen: '3' },
    { label: '8', color: 'Negro', parity: 'par', dozen: '1' },
    { label: '23', color: 'Rojo', parity: 'impar', dozen: '2' },
    { label: '10', color: 'Negro', parity: 'par', dozen: '1' },
    { label: '5', color: 'Rojo', parity: 'impar', dozen: '1' },
    { label: '24', color: 'Negro', parity: 'par', dozen: '2' },
    { label: '16', color: 'Rojo', parity: 'par', dozen: '2' },
    { label: '33', color: 'Negro', parity: 'impar', dozen: '3' },
    { label: '1', color: 'Rojo', parity: 'impar', dozen: '1' },
    { label: '20', color: 'Negro', parity: 'par', dozen: '2' },
    { label: '14', color: 'Rojo', parity: 'par', dozen: '2' },
    { label: '31', color: 'Negro', parity: 'impar', dozen: '3' },
    { label: '9', color: 'Rojo', parity: 'impar', dozen: '1' },
    { label: '22', color: 'Negro', parity: 'par', dozen: '2' },
    { label: '18', color: 'Rojo', parity: 'par', dozen: '2' },
    { label: '29', color: 'Negro', parity: 'impar', dozen: '3' },
    { label: '7', color: 'Rojo', parity: 'impar', dozen: '1' },
    { label: '28', color: 'Negro', parity: 'par', dozen: '3' },
    { label: '12', color: 'Rojo', parity: 'par', dozen: '1' },
    { label: '35', color: 'Negro', parity: 'impar', dozen: '3' },
    { label: '3', color: 'Rojo', parity: 'impar', dozen: '1' },
    { label: '26', color: 'Negro', parity: 'par', dozen: '3' },
];

const ROULETTE_VALUES = {
    color: ['Rojo', 'Negro', 'Verde'],
    parity: ['par', 'impar'],
    dozen: ['1', '2', '3'],
};

function validateRouletteBets(bets) {
    if (!Array.isArray(bets) || bets.length === 0 || bets.length > 20) {
        throw badRequest('bets debe tener de 1 a 20 apuestas');
    }
    let total = 0;
    for (const bet of bets) {
        if (!bet || !ROULETTE_VALUES[bet.type] || !ROULETTE_VALUES[bet.type].includes(bet.value)) {
            throw badRequest('Apuesta de ruleta inválida');
        }
        if (!Number.isInteger(bet.amount) || bet.amount < 1) {
            throw badRequest('Cada apuesta debe ser un entero mayor a 0');
        }
        total += bet.amount;
    }
    if (total > 10000) throw badRequest('La suma de las apuestas no puede pasar de 10000');
    return total;
}

function rouletteSpin(bets, rng = defaultRng) {
    const total = validateRouletteBets(bets);
    const winningIndex = rng(0, ROULETTE_WHEEL.length);
    const winningSlot = ROULETTE_WHEEL[winningIndex];
    let net = 0;
    const results = bets.map((bet) => {
        const won = winningSlot[bet.type] === bet.value;
        net += won ? bet.amount : -bet.amount;
        return { type: bet.type, value: bet.value, amount: bet.amount, won };
    });
    return { winningIndex, winningSlot, results, net, total };
}

// ---------- Minas ----------
const MINES_BOARD_SIZE = 5;
const MINES_COUNT = 5;
const MINES_SAFE_CELLS = MINES_BOARD_SIZE * MINES_BOARD_SIZE - MINES_COUNT;

function minesPlace(rng = defaultRng) {
    const mines = new Set();
    while (mines.size < MINES_COUNT) {
        mines.add(rng(0, MINES_BOARD_SIZE * MINES_BOARD_SIZE));
    }
    return [...mines].sort((a, b) => a - b);
}

function minesIndex(x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= MINES_BOARD_SIZE || y >= MINES_BOARD_SIZE) {
        throw badRequest('Casilla inválida');
    }
    return x * MINES_BOARD_SIZE + y;
}

function minesToCells(indexes) {
    return indexes.map((i) => ({ x: Math.floor(i / MINES_BOARD_SIZE), y: i % MINES_BOARD_SIZE }));
}

module.exports = {
    hiloDraw, hiloWinningValues, hiloResolve,
    ROULETTE_WHEEL, rouletteSpin, validateRouletteBets,
    minesPlace, minesIndex, minesToCells, MINES_BOARD_SIZE, MINES_COUNT, MINES_SAFE_CELLS,
};
