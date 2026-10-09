// Lógica pura de los juegos. No toca AWS para poder probarla con pruebas unitarias.
// El generador aleatorio se inyecta; por defecto es crypto.randomInt (máximo exclusivo).
const crypto = require('crypto');
const { badRequest } = require('../lib/errors');

const defaultRng = (min, max) => crypto.randomInt(min, max);

// Las fichas son enteras: el pago es num/den redondeado hacia abajo. Es determinista, así el número
// que se muestra antes de jugar es exactamente el que se paga (la casa nunca paga de más; con apuestas
// muy chicas el redondeo puede comerse la ganancia y la interfaz lo avisa).
function roundPayout(num, den) {
    return Math.floor(num / den);
}

const HOUSE_NUM = 95; // el jugador recibe 95% del pago justo
const HOUSE_DEN = 100;

// ---------- Hi-lo ----------
// Cartas del 2 al 12 (11 valores). El empate pierde.
// Pago = apuesta * 0.95 * 11 / k, donde k es el número de cartas que ganan.

const HILO_MIN = 2;
const HILO_MAX = 12;
const HILO_VALUES = HILO_MAX - HILO_MIN + 1;

function hiloDraw(rng = defaultRng) {
    return rng(HILO_MIN, HILO_MAX + 1);
}

// La carta visible nunca es 2 ni Q: con ellas solo hay una opción y casi no paga, y el jugador
// ya apostó sin poder elegir. Del 3 al J siempre hay Mayor y Menor.
function hiloDrawVisible(rng = defaultRng) {
    return rng(HILO_MIN + 1, HILO_MAX);
}

function hiloWinningValues(oldCard, prediction) {
    if (prediction === 'higher') return HILO_MAX - oldCard;
    if (prediction === 'lower') return oldCard - HILO_MIN;
    throw badRequest('prediction debe ser "higher" o "lower"');
}

// Multiplicador (2 decimales, para mostrar) de cada predicción con la carta visible; null si no puede ganar.
function hiloPayout(bet, k) {
    return roundPayout(bet * HOUSE_NUM * HILO_VALUES, HOUSE_DEN * k);
}

// Por cada predicción: multiplicador (2 decimales), probabilidad y pago exacto con esta apuesta; null si no puede ganar.
function hiloMultipliers(oldCard, bet) {
    const out = {};
    for (const prediction of ['higher', 'lower']) {
        const k = hiloWinningValues(oldCard, prediction);
        out[prediction] = k === 0 ? null : {
            multiplier: Math.floor((HOUSE_NUM * HILO_VALUES * 100) / (HOUSE_DEN * k)) / 100,
            chance: k / HILO_VALUES,
            ...(bet ? { payout: hiloPayout(bet, k) } : {}),
        };
    }
    return out;
}

function hiloResolve(oldCard, newCard, prediction, bet) {
    const k = hiloWinningValues(oldCard, prediction);
    if (k === 0) throw badRequest('Esa predicción no puede ganar con esta carta');
    const won = prediction === 'higher' ? newCard > oldCard : newCard < oldCard;
    const payout = won ? hiloPayout(bet, k) : 0;
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

const ROULETTE_VALUES = new Map([
    ['color', ['Rojo', 'Negro', 'Verde']],
    ['parity', ['par', 'impar']],
    ['dozen', ['1', '2', '3']],
]);

// Pago neto por ficha apostada (pagos estándar de ruleta europea).
function roulettePayout(bet) {
    if (bet.type === 'color' && bet.value === 'Verde') return 35;
    if (bet.type === 'dozen') return 2;
    return 1;
}

function validateRouletteBets(bets) {
    if (!Array.isArray(bets) || bets.length === 0 || bets.length > 20) {
        throw badRequest('Elige al menos una apuesta (máximo 20)');
    }
    let total = 0;
    for (const bet of bets) {
        const allowed = bet && typeof bet.type === 'string' ? ROULETTE_VALUES.get(bet.type) : undefined;
        if (!allowed || !allowed.includes(bet.value)) {
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
        const change = won ? bet.amount * roulettePayout(bet) : -bet.amount;
        net += change;
        return { type: bet.type, value: bet.value, amount: bet.amount, won, change };
    });
    return { winningIndex, winningSlot, results, net, total };
}

// ---------- Minas ----------
const MINES_BOARD_SIZE = 5;
const MINES_COUNT = 5;
const MINES_CELLS = MINES_BOARD_SIZE * MINES_BOARD_SIZE;
const MINES_SAFE_CELLS = MINES_CELLS - MINES_COUNT;
const MINES_MAX_PAYOUT = 1000000;

function choose(n, k) {
    let r = 1;
    for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
    return Math.round(r);
}

// Tras destapar `safe` casillas seguras, el pago justo es 1 / P(sobrevivir) = C(25,safe)/C(20,safe).
function minesFraction(safe) {
    return { num: HOUSE_NUM * choose(MINES_CELLS, safe), den: HOUSE_DEN * choose(MINES_SAFE_CELLS, safe) };
}

function minesMultiplier(safe) {
    if (safe <= 0) return 1;
    const { num, den } = minesFraction(safe);
    return Math.floor((num * 100) / den) / 100;
}

function minesPayout(bet, safe) {
    if (safe <= 0) return bet;
    const { num, den } = minesFraction(safe);
    return Math.min(MINES_MAX_PAYOUT, roundPayout(bet * num, den));
}

function minesPlace(rng = defaultRng) {
    const mines = new Set();
    while (mines.size < MINES_COUNT) {
        mines.add(rng(0, MINES_CELLS));
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
    roundPayout,
    hiloDraw, hiloDrawVisible, hiloWinningValues, hiloMultipliers, hiloResolve,
    ROULETTE_WHEEL, rouletteSpin, validateRouletteBets, roulettePayout,
    minesPlace, minesIndex, minesToCells, minesMultiplier, minesPayout,
    MINES_BOARD_SIZE, MINES_COUNT, MINES_SAFE_CELLS, MINES_MAX_PAYOUT,
};
