// ============================================
// VURGLIFE PLATFORM SERVER
// Express + SQLite + JWT Auth
// Port 3000 (HTTP) — SipSam WS on 3001
// ============================================
require('dotenv').config();
const express    = require('express');
const path       = require('path');
const cookieParser = require('cookie-parser');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── FORWARD /matchmake → the matching game server ─────────
// This lets game clients call /matchmake from the same origin (port 3000).
function matchmakeTarget(req) {
    const url = req.originalUrl || req.url || '';
    if (url.includes('/roulette_room')) return 'http://127.0.0.1:3005';
    if (url.includes('/rhum32_room')) return 'http://127.0.0.1:2998';
    return 'http://127.0.0.1:2999';
}

async function forwardMatchmake(req, res) {
    const target = matchmakeTarget(req);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
        const headers = { 'content-type': 'application/json' };
        const options = {
            method: req.method,
            headers,
            signal: controller.signal
        };
        if (!['GET', 'HEAD'].includes(req.method)) {
            options.body = JSON.stringify(req.body || {});
        }

        const upstream = await fetch(target + req.originalUrl, options);
        const text = await upstream.text();
        const contentType = upstream.headers.get('content-type') || 'application/json';
        res.status(upstream.status).type(contentType).send(text);
    } catch (err) {
        console.error('[matchmake proxy] failed:', err.message || err);
        res.status(502).json({ error: 'Game server unavailable' });
    } finally {
        clearTimeout(timer);
    }
}

app.all('/matchmake/*', forwardMatchmake);

// Serve static assets from client/public
app.use(express.static(path.join(__dirname, '../client/public')));

// ── API ROUTES ────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/game', require('./routes/game'));
app.use('/api/friends', require('./routes/friends'));

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

function mountGameClient(routePath, relativeClientPath) {
    const clientDir = path.join(__dirname, relativeClientPath);
    const indexFile = path.join(clientDir, 'index.html');

    if (!fs.existsSync(indexFile)) {
        console.warn(`[Platform] Skipping ${routePath}; missing ${indexFile}`);
        return;
    }

    app.use(routePath, express.static(clientDir));
    app.get(routePath, (req, res) => {
        res.sendFile(indexFile);
    });
    app.get(`${routePath}/`, (req, res) => {
        res.sendFile(indexFile);
    });
}

mountGameClient('/rhum32', '../../rhum32-client');
mountGameClient('/blackjack', '../../blackjack-client');
mountGameClient('/roulette', '../../roulette-client');

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
