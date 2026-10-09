const text = document.getElementById('textProf')
const loader = document.getElementById('preloader')

window.addEventListener('load', () => {
    if (loader) {
        setTimeout(() => {
            loader.style.opacity = '0';
            setTimeout(() => {
                loader.style.display = 'none';
            }, 1500);
        }, 1000);
    }
})

document.addEventListener('DOMContentLoaded', () => {
    loadName()
});

function loadName() {
    const token = localStorage.getItem('token');
    const userId = localStorage.getItem('userId');

    if (!token || !userId) {
        return;
    }

    fetch(getApiUrl(API_CONFIG.ENDPOINTS.GET_USER_NAME), {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    }).then(response => {
        if (!response.ok) {
            throw new Error('Error al obtener el nombre desde el servidor');
        }
        return response.json();
    }).then(data => {
        const textProf = document.getElementById('textProf');
        if (textProf) {
            textProf.innerText = data.name;
        }
    }).catch(error => console.error(error));
}

let defaultTransform = 0;

function getBaseURL() {
    return window.location.origin; // http://localhost:8080
}

function navigateToPath(path) {
    const baseURL = getBaseURL();
    if (!path.startsWith('/')) {
        path = '/' + path;
    }
    window.location.href = baseURL + path;
}

function goToIndex() {
    navigateToPath('/index_logIn');
}

function goToIndexPending() {
    navigateToPath('/home');
}

function goToInfo() {
    navigateToPath('/info');
}

function goToRules() {
    navigateToPath('/rules');
}

function goToProfile() {
    navigateToPath('/profile');
}

function goToExit() {
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    sessionStorage.removeItem('token');
    document.cookie = 'token=; Expires=0;';
    navigateToPath('/home');
}

function goToBalance() {
    navigateToPath('/balance');
}

function goToActivity() {
    navigateToPath('/activity');
}

function goToInit() {
    navigateToPath('/logIn');
}

function goToReg() {
    navigateToPath('/register');
}

function redirectToGame(gamePath) {
    navigateToPath(gamePath);
}