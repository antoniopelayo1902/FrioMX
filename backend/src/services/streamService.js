// Mapa para guardar las conexiones activas: userId -> objeto de respuesta (res)
const clients = new Map();

function addClient(userId, req, res) {
    // Configuramos las cabeceras HTTP requeridas para Server-Sent Events (SSE)
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*' // Previene bloqueos de CORS en desarrollo
    });

    // Guardamos la conexión activa del usuario
    clients.set(userId, res);

    // Mandamos un evento inicial silencioso para confirmar la conexión
    res.write('event: connected\n');
    res.write(`data: ${JSON.stringify({ status: 'ok' })}\n\n`);

    // "Latido" (ping) cada 30 segundos para evitar que el navegador o el balanceador de AWS cierren la conexión por inactividad
    const ping = setInterval(() => {
        res.write(': ping\n\n');
    }, 30000);

    // Cuando el usuario cierra la pestaña o pierde internet, limpiamos la memoria
    req.on('close', () => {
        clearInterval(ping);
        clients.delete(userId);
    });
}

// Enviar un evento a un usuario específico (ideal para actualizaciones de saldo personal)
function sendToUser(userId, eventType, data) {
    const res = clients.get(userId);
    if (res) {
        res.write(`event: ${eventType}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// Enviar evento a TODOS los usuarios conectados (ideal para cuando el ranking semanal cambia)
function broadcast(eventType, data) {
    for (const res of clients.values()) {
        res.write(`event: ${eventType}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

module.exports = { addClient, sendToUser, broadcast };
