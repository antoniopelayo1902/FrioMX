// Hi-lo: el servidor reparte la carta visible y cobra la apuesta; luego el jugador elige mayor o menor.
// Estados: sin ronda (apuesta + "Repartir") y con ronda (mayor / menor).

const computerCardSlot = document.querySelector('.computer-card-slot');
const cantidadHiLo = document.getElementById('cantidadHiLo');
const tagBalance = document.getElementById('tagBalance');
const btnRepartir = document.getElementById('btnRepartir');
const btnMayor = document.getElementById('btnMayor');
const btnMenor = document.getElementById('btnMenor');

let roundId = null;
let currentCard = null;

document.addEventListener('DOMContentLoaded', () => {
    loadBalance();
    showCardBack();
    setState(false);
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

function setState(withRound) {
    cantidadHiLo.disabled = withRound;
    btnRepartir.disabled = withRound;
    // Con un 12 no se puede elegir mayor y con un 2 no se puede elegir menor: nunca ganarían.
    btnMayor.disabled = !withRound || currentCard === 12;
    btnMenor.disabled = !withRound || currentCard === 2;
}

function endRound() {
    roundId = null;
    currentCard = null;
    setState(false);
}

function showError(text) {
    Swal.fire({ icon: 'error', title: 'Salió algo mal', text });
}

function showBanner(id) {
    document.getElementById(id).style.display = 'flex';
    setTimeout(() => { document.getElementById(id).style.display = 'none'; }, 2000);
}

btnRepartir.addEventListener('click', async () => {
    const bet = parseBet(cantidadHiLo.value);
    if (bet === null) {
        showError('Ingresa una apuesta entera entre 1 y 10000');
        return;
    }
    if (bet > Number(tagBalance.innerHTML)) {
        showError('Fondos insuficientes!');
        return;
    }

    btnRepartir.disabled = true;
    try {
        const response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.HILO_DEAL), {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ betAmount: bet })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'No se pudo repartir');

        roundId = data.roundId;
        currentCard = data.oldCard;
        showCard(data.oldCard);
        tagBalance.innerHTML = data.newBalance;
        setState(true);
    } catch (error) {
        btnRepartir.disabled = false;
        showError(error.message);
    }
});

btnMayor.addEventListener('click', () => playHiLo('higher'));
btnMenor.addEventListener('click', () => playHiLo('lower'));

async function playHiLo(prediction) {
    if (!roundId) return;
    btnMayor.disabled = true;
    btnMenor.disabled = true;

    try {
        const response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.PLAY_HILO), {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ roundId, prediction })
        });
        const result = await response.json();

        if (!response.ok) {
            if (response.status === 404 || result.code === 'GAME_FINISHED') endRound();
            else setState(true);
            throw new Error(result.error || 'Error en el juego');
        }

        showCard(result.newCard);
        tagBalance.innerHTML = result.newBalance;
        showBanner(result.won ? 'hasWon' : 'hasLost');
        cantidadHiLo.value = '';
        endRound();
    } catch (error) {
        showError(error.message);
    }
}

function displayValue(value) {
    if (value === 11) return 'J';
    if (value === 12) return 'Q';
    return String(value);
}

function showCard(value) {
    const suits = ['♠', '♣', '♥', '♦'];
    const suit = suits[Math.floor(Math.random() * suits.length)];
    const cardDiv = document.createElement('div');
    cardDiv.innerText = suit;
    cardDiv.classList.add('card', suit === '♣' || suit === '♠' ? 'black' : 'red');
    cardDiv.dataset.value = `${displayValue(value)} ${suit}`;
    computerCardSlot.replaceChildren(cardDiv);
}

function showCardBack() {
    const cardDiv = document.createElement('div');
    cardDiv.innerText = '?';
    cardDiv.classList.add('card', 'black');
    cardDiv.dataset.value = '';
    computerCardSlot.replaceChildren(cardDiv);
}
