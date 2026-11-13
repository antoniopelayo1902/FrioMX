// Conexiones SSE activas: userId -> Set de respuestas (una por pestaña o página abierta).
// Es un Set porque la app es multipágina: al navegar, la página nueva conecta antes de que la vieja cierre.
const clients = new Map();

const PING_MS = 30000;

function write(res, eventType, data) {
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function addClient(userId, req, res) {
    // Cabeceras de Server-Sent Events. Mismo origen detrás de nginx, así que no lleva CORS.
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    let conns = clients.get(userId);
    if (!conns) {
        conns = new Set();
        clients.set(userId, conns);
    }
    conns.add(res);

    write(res, 'connected', { status: 'ok' });

    // Ping para que nginx o el navegador no corten la conexión por inactividad.
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);

    req.on('close', () => {
        clearInterval(ping);
        // Solo se borra esta conexión; las otras pestañas del mismo usuario siguen recibiendo.
        conns.delete(res);
        if (conns.size === 0 && clients.get(userId) === conns) clients.delete(userId);
    });
}

// Evento para un usuario (saldo personal), en todas sus pestañas.
function sendToUser(userId, eventType, data) {
    const conns = clients.get(userId);
    if (!conns) return;
    for (const res of conns) write(res, eventType, data);
}

// Evento para todos los conectados (cambio de ranking).
function broadcast(eventType, data) {
    for (const conns of clients.values()) {
        for (const res of conns) write(res, eventType, data);
    }
}

module.exports = { addClient, sendToUser, broadcast };
