// ============================================
// VURGLIFE PLATFORM SERVER
// Express + SQLite + JWT Auth
// Port 3000 (HTTP) — SipSam WS on 3001
// ============================================
require('dotenv').config();
const express    = require('express');
const path       = require('path');
const cookieParser = require('cookie-parser');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── PROXY /matchmake → poker-server on port 2999 ─────────
// This lets game.js call /matchmake from the same origin (port 3000)
app.use('/matchmake', createProxyMiddleware({
    target: 'http://localhost:2999',
    changeOrigin: true,
    logLevel: 'silent'
}));

// Serve static assets from client/public
app.use(express.static(path.join(__dirname, '../client/public')));

// ── API ROUTES ────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/game', require('./routes/game'));

// ── PAGE ROUTES ───────────────────────────────
// Main platform landing / login / dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

// Email verification
app.get('/verify/:token', (req, res) => {
    res.redirect(`/api/auth/verify/${req.params.token}`);
});

// Password reset page
app.get('/reset-password/:token', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/public/index.html'));
});

// SipSam game — serve entire poker-client folder as static under /sipsam
app.use('/sipsam', express.static(path.join(__dirname, '../../poker-client')));

// Fallback: /sipsam with no file → serve index.html
app.get('/sipsam', (req, res) => {
    res.sendFile(path.join(__dirname, '../../poker-client/index.html'));
});

// ── HEALTH CHECK ──────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', platform: 'VurgLife', version: '1.0.0' }));

// ── START ─────────────────────────────────────
async function start() {
    // Initialise DB before accepting requests
    await require('./db/database').getDb();

    app.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════╗
║   VURGLIFE PLATFORM SERVER               ║
║   http://localhost:${PORT}                  ║
║   SipSam WebSocket: ws://localhost:3001  ║
╚══════════════════════════════════════════╝
        `);
    });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });

module.exports = app;
