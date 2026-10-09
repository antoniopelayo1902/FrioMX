const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const publicPath = path.join(__dirname, 'public');

app.disable('x-powered-by');

// Cabeceras básicas de seguridad. La CSP solo permite recursos del mismo origen
// (no hay CDN): un nombre de usuario con HTML no podría cargar scripts de fuera.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; '),
  });
  next();
});

// Solo en desarrollo: reenvía /api al backend local. En la nube nginx hace este trabajo.
if (process.env.API_PROXY_TARGET) {
  const { createProxyMiddleware } = require('http-proxy-middleware');
  // xfwd: el backend ve la IP real del cliente y no la que el cliente diga en X-Forwarded-For.
  app.use(createProxyMiddleware({ target: process.env.API_PROXY_TARGET, pathFilter: '/api', changeOrigin: true, xfwd: true }));
}

// /profile/ -> /profile: con la barra final las rutas relativas y la guardia de sesión fallaban.
app.use((req, res, next) => {
  if (req.path.length > 1 && req.path.endsWith('/') && (req.method === 'GET' || req.method === 'HEAD')) {
    // Se colapsan las barras iniciales: "//otro.com/" nunca se vuelve una redirección a otro sitio.
    const clean = '/' + req.path.replace(/^\/+/, '').replace(/\/+$/, '');
    const query = req.originalUrl.slice(req.path.length);
    return res.redirect(301, clean + query);
  }
  next();
});

app.use(express.static(publicPath, { index: false }));

const pages = {
  '/': 'index_logInPending.html',
  '/home': 'index_logInPending.html',
  '/index_logIn': 'index_logIn.html',
  '/lobby': 'index_logIn.html',
  '/logIn': 'logIn.html',
  '/login': 'logIn.html',
  '/register': 'register.html',
  '/profile': 'profile.html',
  '/info': 'info.html',
  '/rules': 'rules.html',
  '/balance': 'balance.html',
  '/activity': 'activity.html',
  '/roulette': 'roulette.html',
  '/hi-lo': 'hi-lo.html',
  '/mines': 'mineBet.html',
};

for (const [route, file] of Object.entries(pages)) {
  app.get(route, (req, res) => res.sendFile(path.join(publicPath, file)));
}

app.use((req, res) => {
  res.status(404).sendFile(path.join(publicPath, '404.html'));
});

// En la nube nginx (mismo host) es la entrada; HOST=0.0.0.0 permite probar desde otro equipo de la red.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
