const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

const publicPath = path.join(__dirname, 'public');

// Solo en desarrollo: reenvía /api al backend local. En la nube nginx hace este trabajo.
if (process.env.API_PROXY_TARGET) {
  const { createProxyMiddleware } = require('http-proxy-middleware');
  app.use(createProxyMiddleware({ target: process.env.API_PROXY_TARGET, pathFilter: '/api', changeOrigin: true }));
}

app.use(express.static(publicPath));

function sendHtml(res, fileName) {
  res.sendFile(path.join(publicPath, fileName));
}

app.get('/', (req, res) => {
  sendHtml(res, 'index.html');
});

app.get('/home', (req, res) => {
  sendHtml(res, 'index_logInPending.html');
});

app.get('/index_logIn', (req, res) => {
  sendHtml(res, 'index_logIn.html');
});

app.get('/logIn', (req, res) => {
  sendHtml(res, 'logIn.html');
});

app.get('/login', (req, res) => {
  sendHtml(res, 'logIn.html');
});

app.get('/register', (req, res) => {
  sendHtml(res, 'register.html');
});

app.get('/profile', (req, res) => {
  sendHtml(res, 'profile.html');
});

app.get('/info', (req, res) => {
  sendHtml(res, 'info.html');
});

app.get('/rules', (req, res) => {
  sendHtml(res, 'rules.html');
});

app.get('/balance', (req, res) => {
  sendHtml(res, 'balance.html');
});

app.get('/activity', (req, res) => {
  sendHtml(res, 'activity.html');
});

app.get('/roulette', (req, res) => {
  sendHtml(res, 'roulette.html');
});

app.get('/hi-lo', (req, res) => {
  sendHtml(res, 'hi-lo.html');
});

app.get('/mines', (req, res) => {
  sendHtml(res, 'mineBet.html');
});

app.get('/templateGames', (req, res) => {
  sendHtml(res, 'templateGames.html');
});


app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});