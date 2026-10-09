// La API se sirve en el mismo origen bajo /api (nginx en la nube, proxy de desarrollo en local).
const API_CONFIG = {
    BASE_URL: '/api',
    ENDPOINTS: {
        LOGIN: '/auth/login',
        REGISTER: '/auth/register',
        GET_USER_NAME: '/auth/user-name',

        PROFILE: '/user/profile',
        BALANCE: '/user/balance',
        ACTIVITY: '/user/activity',

        PROFILE_UPLOAD: '/profile/upload',
        PROFILE_DELETE: '/profile/delete',
        PROFILE_IMAGE: '/profile/image',

        HILO_DEAL: '/games/hi-lo/deal',
        PLAY_HILO: '/games/hi-lo',
        PLAY_ROULETTE: '/games/roulette',
        MINES_START: '/games/mines/start',
        MINES_REVEAL: '/games/mines/reveal',

        WALLET_PACKAGES: '/wallet/packages',
        WALLET_RECHARGES: '/wallet/recharges',
        LEADERBOARD_CURRENT: '/leaderboard/current',
        LEADERBOARD_LAST: '/leaderboard/last',
        LEADERBOARD_WEEKS: '/leaderboard/weeks'
    }
};

function getApiUrl(endpoint) {
    return API_CONFIG.BASE_URL + endpoint;
}

// Ante 401 en una ruta con sesión, se limpia la sesión y se manda al login.
// Login y registro quedan fuera para que muestren su propio mensaje.
(function () {
    const PUBLIC_PATHS = [API_CONFIG.ENDPOINTS.LOGIN, API_CONFIG.ENDPOINTS.REGISTER];

    function isProtectedApi(url) {
        const path = new URL(url, window.location.origin).pathname;
        return path.startsWith(API_CONFIG.BASE_URL + '/')
            && !PUBLIC_PATHS.some((p) => path === API_CONFIG.BASE_URL + p);
    }

    function onUnauthorized() {
        localStorage.removeItem('token');
        localStorage.removeItem('userId');
        if (!/\/login$/i.test(window.location.pathname)) {
            window.location.href = '/logIn';
        }
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const response = await originalFetch(input, init);
        const url = typeof input === 'string' ? input : input.url;
        if (response.status === 401 && isProtectedApi(url)) onUnauthorized();
        return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.addEventListener('load', () => {
            if (this.status === 401 && isProtectedApi(url)) onUnauthorized();
        });
        return originalOpen.apply(this, arguments);
    };
})();

// Valida que una apuesta sea un entero entre 1 y 10000.
function parseBet(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : null;
}
