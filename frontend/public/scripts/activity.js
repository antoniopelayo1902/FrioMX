const gameImageNames = {
    'Hi-Lo': 'hiloCar.jpg',
    'Ruleta': 'rouletteCar.jpg',
    'Mines': 'mine.jpg'
};

let nextCursor = null;

document.addEventListener('DOMContentLoaded', () => {
    loadActivity();
});

function getGameImageUrl(gameName) {
    const imageName = gameImageNames[gameName];
    return `assets/images/cleanImages/${imageName || 'default.png'}`;
}

function formatDate(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function column(html) {
    const div = document.createElement('div');
    div.classList.add('activity-container-content-column');
    div.innerHTML = html;
    return div;
}

function renderActivity(activity, container) {
    const row = document.createElement('div');
    row.classList.add('activity-container-content-row');

    const amount = Number(activity.balance);
    const sign = amount >= 0 ? 'positive' : 'negative';

    row.append(column(`<div class="game"><img src="${getGameImageUrl(activity.nameGame)}"><span>${activity.nameGame}</span></div>`));
    row.append(column(`<div class="game"><span>${formatDate(activity.dateGame)}</span></div>`));
    row.append(column(`<div class="game"><span class="amount ${sign}">${amount} fichas</span></div>`));
    container.append(row);
}

function moreButton(container) {
    let btn = document.getElementById('btnVerMas');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'btnVerMas';
        btn.className = 'btn mt-4';
        btn.textContent = 'Ver más';
        btn.addEventListener('click', loadActivity);
        container.after(btn);
    }
    btn.style.display = nextCursor ? 'block' : 'none';
}

async function loadActivity() {
    const container = document.querySelector('.activity-container-content');
    let url = getApiUrl(API_CONFIG.ENDPOINTS.ACTIVITY) + '?limit=20';
    if (nextCursor) url += `&cursor=${encodeURIComponent(nextCursor)}`;

    try {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'No se pudo cargar el historial');

        data.items.forEach((activity) => renderActivity(activity, container));
        nextCursor = data.nextCursor;
        moreButton(container);
    } catch (error) {
        console.error(error);
    }
}
