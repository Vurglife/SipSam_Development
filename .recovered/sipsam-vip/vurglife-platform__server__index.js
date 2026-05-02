// ============================================
// VURGLIFE PLATFORM SERVER
// Express + SQLite + JWT Auth
// Port 3000 (HTTP) — Run with: npm start
// ============================================
require('dotenv').config();
const express      = require('express');
const path         = require('path');
const cookieParser = require('cookie-parser');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { spawn }    = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── AUTO-START GAME SERVERS ──────────────────────────────────────
// Each game server is launched as a child process so only ONE
// terminal is needed: "npm start" inside vurglife-platform/

function createGameServer(label, scriptPath, env = {}) {
    let proc = null;
    let restarting = false;

    function start() {
        proc = spawn('node', [scriptPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...env }
        });

        proc.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`));
        proc.stderr.on('data', d => process.stderr.write(`[${label} ERR] ${d}`));

        proc.on('close', (code, signal) => {
            if (signal === 'SIGTERM' || signal === 'SIGINT') return;
            if (!restarting) {
                restarting = true;
                console.log(`[${label}] Server stopped (code=${code}) — restarting in 3s...`);
                setTimeout(() => { restarting = false; start(); }, 3000);
            }
        });

        proc.on('error', err => {
            console.error(`[${label}] Failed to start:`, err.message);
        });
    }

    return {
        start,
        kill: () => { if (proc) proc.kill('SIGTERM'); }
    };
}

const pokerServer = createGameServer('SipSam',
    path.join(__dirname, '../../poker-server/index.js'));

const blackjackServer = createGameServer('BJ',
    path.join(__dirname, '../../blackjack-server/index.js'),
    { BLACKJACK_WS_PORT: '3002' });

const holdemServer = createGameServer('HoldEm',
    path.join(__dirname, '../../holdem-server/index.js'),
    { HOLDEM_WS_PORT: '3004' });

const rhum32Server = createGameServer('Rhum32',
    path.join(__dirname, '../../rhum32-server/index.js'));

const rouletteServer = createGameServer('Roulette',
    path.join(__dirname, '../../roulette-server/index.js'),
    { ROULETTE_API_PORT: '3005', ROULETTE_WS_PORT: '3006' });

// Graceful shutdown
function shutdownAll() {
    pokerServer.kill();
    blackjackServer.kill();
    holdemServer.kill();
    rhum32Server.kill();
    rouletteServer.kill();
    process.exit(0);
}
process.on('SIGTERM', shutdownAll);
process.on('SIGINT',  shutdownAll);

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── RHUM32 MATCHMAKE: manual forward → port 2998 ───────────────
// (http-proxy-middleware v3 hangs on this route, so we forward manually)
const http = require('http');
app.post('/matchmake/joinOrCreate/rhum32_room', (req, res) => {
    const postData = JSON.stringify(req.body);
    const proxyReq = http.request({
        hostname: 'localhost', port: 2998,
        path: '/matchmake/joinOrCreate/rhum32_room',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
            res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
        });
    });
    proxyReq.on('error', (e) => {
        console.error('[Rhum32 proxy] Error:', e.message);
        res.status(502).json({ error: 'Rhum32 server unreachable' });
    });
    proxyReq.write(postData);
    proxyReq.end();
});

// ── RHUM32 API: manual forward → port 2998 ─────────────────────
app.use('/rhum32-api', (req, res) => {
    const targetPath = req.originalUrl.replace(/^\/rhum32-api/, '') || '/';
    const proxyReq = http.request({
        hostname: 'localhost', port: 2998,
        path: targetPath,
        method: req.method,
        headers: { 'Content-Type': 'application/json' }
    }, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
            res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
        });
    });
    proxyReq.on('error', (e) => {
        res.status(502).json({ error: 'Rhum32 server unreachable' });
    });
    if (req.body && req.method === 'POST') proxyReq.write(JSON.stringify(req.body));
    proxyReq.end();
});

// ── ROULETTE MATCHMAKE: manual forward → port 3005 ─────────────
app.post('/matchmake/joinOrCreate/roulette_room', (req, res) => {
    const postData = JSON.stringify(req.body);
    const proxyReq = http.request({
        hostname: 'localhost', port: 3005,
        path: '/matchmake/joinOrCreate/roulette_room',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
            res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
        });
    });
    proxyReq.on('error', (e) => {
        console.error('[Roulette proxy] Error:', e.message);
        res.status(502).json({ error: 'Roulette server unreachable' });
    });
    proxyReq.write(postData);
    proxyReq.end();
});

// ── ROULETTE API: manual forward → port 3005 ───────────────────
app.use('/roulette-api', (req, res) => {
    const targetPath = req.originalUrl.replace(/^\/roulette-api/, '') || '/';
    const proxyReq = http.request({
        hostname: 'localhost', port: 3005,
        path: targetPath,
        method: req.method,
        headers: { 'Content-Type': 'application/json' }
    }, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
            res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
        });
    });
    proxyReq.on('error', (e) => {
        res.status(502).json({ error: 'Roulette server unreachable' });
    });
    if (req.body && req.method === 'POST') proxyReq.write(JSON.stringify(req.body));
    proxyReq.end();
});

// ── PROXY: SipSam matchmake → port 2999 ─────────────────────────
const gameServerProxy = createProxyMiddleware({
    target: 'http://localhost:2999',
    changeOrigin: true,
    logLevel: 'silent'
});
app.use('/matchmake', gameServerProxy);
app.use('/rooms',     gameServerProxy);
app.use('/room',      gameServerProxy);

// ── STATIC FILES (no-cache for HTML to prevent stale game clients) ──
const noCacheStatic = (dir) => express.static(dir, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
});
app.use(express.static(path.join(__dirname, '../client/public')));
app.use('/sipsam',    noCacheStatic(path.join(__dirname, '../../poker-client')));
app.use('/blackjack', noCacheStatic(path.join(__dirname, '../../blackjack-client')));
app.use('/holdem',    noCacheStatic(path.join(__dirname, '../../holdem-client')));
app.use('/rhum32',    noCacheStatic(path.join(__dirname, '../../rhum32-client')));

// ── API ROUTES ────────────────────────────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/game',    require('./routes/game'));
app.use('/api/friends', require('./routes/friends'));

// ── PAGE ROUTES ───────────────────────────────────────────────────
app.get('/', (req, res) =>
    res.sendFile(path.join(__dirname, '../client/public/index.html')));

app.get('/sipsam', (req, res) =>
    res.sendFile(path.join(__dirname, '../../poker-client/index.html')));

app.get('/blackjack', (req, res) =>
    res.sendFile(path.join(__dirname, '../../blackjack-client/index.html')));

app.get('/holdem', (req, res) =>
    res.sendFile(path.join(__dirname, '../../holdem-client/index.html')));

app.get('/rhum32', (req, res) =>
    res.sendFile(path.join(__dirname, '../../rhum32-client/index.html')));
app.get('/rhum32/', (req, res) =>
    res.sendFile(path.join(__dirname, '../../rhum32-client/index.html')));

app.get('/roulette', (req, res) =>
    res.sendFile(path.join(__dirname, '../../roulette-client/index.html')));
app.get('/roulette/', (req, res) =>
    res.sendFile(path.join(__dirname, '../../roulette-client/index.html')));

// ── BLACKJACK MATCHMAKE ──────────────────────────────────────────
const { requireAuth } = require('./middleware/auth');
const { UserDB }      = require('./db/database');

app.post('/blackjack-matchmake', requireAuth, async (req, res) => {
    const { minBet } = req.body;
    const BJ_TABLES = {
        // Standard
        100:   { minBet: 100,   maxBet: 500,   walletSize: 2500,    minBank: 2500,    label: 'standard' },
        // VIP tiers — fixed bets
        1000:  { minBet: 1000,  maxBet: 1000,  walletSize: 30000,   minBank: 50000,   label: 'vip' },
        5000:  { minBet: 5000,  maxBet: 5000,  walletSize: 120000,  minBank: 150000,  label: 'vip' },
        10000: { minBet: 10000, maxBet: 10000, walletSize: 240000,  minBank: 300000,  label: 'vip' },
        20000: { minBet: 20000, maxBet: 20000, walletSize: 500000,  minBank: 750000,  label: 'vip' },
        50000: { minBet: 50000, maxBet: 50000, walletSize: 1000000, minBank: 1500000, label: 'vip' },
    };
    const config = BJ_TABLES[Number(minBet)];
    if (!config) return res.json({ ok: false, error: 'Invalid table' });

    try {
        const user = await UserDB.findById(req.userId);
        if (!user) return res.json({ ok: false, error: 'User not found' });

        if ((user.bank_balance || 0) < config.minBank) {
            return res.json({
                ok: false,
                error: `You need $${config.minBank.toLocaleString()} in your bank to enter this table`
            });
        }
    } catch(e) {
        console.error('[BJ matchmake] DB error:', e.message);
        return res.json({ ok: false, error: 'Server error' });
    }

    const roomId = `bj_${minBet}_${Date.now()}`;
    res.json({ ok: true, roomId, minBet: Number(minBet), wsPort: 3002, config });
});

// ── OTHER PAGE ROUTES ────────────────────────────────────────────
app.get('/verify/:token', (req, res) =>
    res.redirect(`/api/auth/verify/${req.params.token}`));

app.get('/reset-password/:token', (req, res) =>
    res.sendFile(path.join(__dirname, '../client/public/index.html')));

// ── HEALTH CHECK ──────────────────────────────────────────────────
app.get('/health', (req, res) =>
    res.json({ status: 'ok', platform: 'VurgLife', version: '1.0.0' }));

// ── START ─────────────────────────────────────────────────────────
async function start() {
    await require('./db/database').getDb();

    // Start game servers, give them 1s to bind ports, then start platform
    pokerServer.start();
    blackjackServer.start();
    holdemServer.start();
    rhum32Server.start();
    rouletteServer.start();
    await new Promise(resolve => setTimeout(resolve, 1000));

    app.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════════╗
║   VURGLIFE PLATFORM — READY                  ║
║   Dashboard:  http://localhost:${PORT}           ║
║   SipSam:     http://localhost:${PORT}/sipsam    ║
║   Blackjack:  http://localhost:${PORT}/blackjack ║
║   Hold'em:    http://localhost:${PORT}/holdem    ║
║   Rhum32:     http://localhost:${PORT}/rhum32    ║
║   Roulette:   http://localhost:${PORT}/roulette  ║
║   Game API:   http://localhost:2999          ║
║   SipSam WS:  ws://localhost:3001            ║
║   BJ WS:      ws://localhost:3002            ║
║   Rhum32 WS:  ws://localhost:3003            ║
║   HoldEm WS:  ws://localhost:3004            ║
║   Roulette:   ws://localhost:3006            ║
╚══════════════════════════════════════════════╝
        `);
    });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });

module.exports = app;
