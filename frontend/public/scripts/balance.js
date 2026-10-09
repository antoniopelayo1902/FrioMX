// Saldo de fichas. Las recargas (flujo 2) se conectan cuando exista la cola de recargas.
document.addEventListener('DOMContentLoaded', () => {
    loadBalance();
});

async function loadBalance() {
    const token = localStorage.getItem('token');
    if (!token) {
        window.location.href = '/logIn';
        return;
    }

    const response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.BALANCE), {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (response.ok) {
        const data = await response.json();
        document.querySelector('#balanceField').innerHTML = `${data.balance} fichas`;
    }
}
