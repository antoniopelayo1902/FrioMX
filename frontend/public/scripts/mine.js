// Minas: el servidor guarda el tablero y decide cada casilla. El navegador solo pinta.
const btnPlay = document.getElementById('btnPlay');
const cantidadMine = document.getElementById('cantidadMine');
const boardElement = document.querySelector('.board');
const minesLCount = document.querySelector('[data-mine-count]');
const tagBalance = document.querySelector('#tagBalance');

const BOARD_SIZE = 5;
const NUMBER_MINES = 5;
const STATUS = { HIDDEN: 'hidden', MINE: 'mine', NUMBER: 'number', MARKED: 'marked' };

let gameId = null;
let busy = false;

document.addEventListener('DOMContentLoaded', () => {
    loadBalance();
    loadName();
});

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token')}`
    };
}

async function loadBalance() {
    const response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.BALANCE), { headers: authHeaders() });
    if (response.ok) {
        const data = await response.json();
        tagBalance.innerHTML = data.balance;
    }
}

function showBanner(id) {
    document.getElementById(id).style.display = 'flex';
    setTimeout(() => { document.getElementById(id).style.display = 'none'; }, 2000);
}

function showError(text) {
    Swal.fire({ icon: 'error', title: 'Salió algo mal', text });
}

// El tablero y sus listeners se crean una sola vez.
const board = [];
for (let x = 0; x < BOARD_SIZE; x++) {
    const row = [];
    for (let y = 0; y < BOARD_SIZE; y++) {
        const element = document.createElement('div');
        element.dataset.status = STATUS.HIDDEN;
        const tile = {
            element, x, y,
            get status() { return element.dataset.status; },
            set status(val) { element.dataset.status = val; }
        };
        element.addEventListener('click', () => revealTile(tile));
        element.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            markTile(tile);
        });
        row.push(tile);
    }
    board.push(row);
}

function resetBoard() {
    document.getElementById('hasWon').style.display = 'none';
    document.getElementById('hasLost').style.display = 'none';
    boardElement.innerHTML = '';
    board.forEach((row) => row.forEach((tile) => {
        tile.status = STATUS.HIDDEN;
        tile.element.textContent = '';
        boardElement.append(tile.element);
    }));
    minesLCount.textContent = NUMBER_MINES;
}

function markTile(tile) {
    if (!gameId) return;
    if (tile.status === STATUS.MARKED) tile.status = STATUS.HIDDEN;
    else if (tile.status === STATUS.HIDDEN) tile.status = STATUS.MARKED;
    const marked = board.flat().filter((t) => t.status === STATUS.MARKED).length;
    minesLCount.textContent = NUMBER_MINES - marked;
}

function showMines(mines) {
    mines.forEach(({ x, y }) => { board[x][y].status = STATUS.MINE; });
}

function endGame() {
    gameId = null;
    btnPlay.disabled = false;
    cantidadMine.disabled = false;
}

btnPlay.addEventListener('click', async () => {
    const bet = parseBet(cantidadMine.value);
    if (bet === null) {
        showError('Ingresa una apuesta entera entre 1 y 10000');
        return;
    }

    btnPlay.disabled = true;
    try {
        const response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.MINES_START), {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ betAmount: bet })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'No se pudo iniciar la partida');

        gameId = data.gameId;
        tagBalance.innerHTML = data.newBalance;
        cantidadMine.value = '';
        cantidadMine.disabled = true;
        resetBoard();
    } catch (error) {
        btnPlay.disabled = false;
        showError(error.message);
    }
});

async function revealTile(tile) {
    if (!gameId || busy || tile.status !== STATUS.HIDDEN) return;
    busy = true;

    try {
        let response;
        let result;
        // Ante un conflicto (dos clics a la vez) se repite el mismo destape; es seguro.
        for (let attempt = 0; attempt < 3; attempt++) {
            response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.MINES_REVEAL), {
                method: 'POST', headers: authHeaders(), body: JSON.stringify({ gameId, x: tile.x, y: tile.y })
            });
            result = await response.json();
            if (!(response.status === 409 && result.code === 'CONFLICT')) break;
        }

        if (!response.ok) {
            if (response.status === 404 || result.code === 'GAME_FINISHED') endGame();
            throw new Error(result.error || 'Error en el juego');
        }

        if (result.result === 'mine') {
            showMines(result.mines);
            tagBalance.innerHTML = result.newBalance;
            showBanner('hasLost');
            endGame();
            return;
        }

        tile.status = STATUS.NUMBER;
        if (result.status === 'WON') {
            showMines(result.mines);
            tagBalance.innerHTML = result.newBalance;
            showBanner('hasWon');
            endGame();
        }
    } catch (error) {
        showError(error.message);
    } finally {
        busy = false;
    }
}

boardElement.style.setProperty('--size', BOARD_SIZE);
resetBoard();
