'use strict';

// ─────────────────────────────────────────────────────────────
// VurgLife Blackjack — server/index.js
// WebSocket server on port 3002.
// Spawned by vurglife-platform/server/index.js via child_process.spawn
// Owner: Amit Ramoutar
// ─────────────────────────────────────────────────────────────

require('dotenv').config({ path: '../vurglife-platform/.env' });

const WebSocket    = require('ws');
const BlackjackRoom = require('./BlackjackRoom');

const PORT = process.env.BLACKJACK_WS_PORT || 3002;

// ── Table Configuration ──────────────────────────────────────
// Standard table: fixed $100 main bet. Blackjack pays 3:2, fixed $100 tie bet,
//                 fixed $2,000 tie bonus.
// Premium tables: fixed main bet per tier, flat blackjack + tie payouts.
const TABLE_CONFIGS = {
  // Standard
  100: {
    minBet:          100,
    maxBet:          100,
    walletSize:      2500,
    minBank:         2500,
    tieBet:          100,
    tieBetPayout:    2000,
    blackjackPayout: null,    // null → use standard 3:2 formula
    label:           'standard',
  },
  500: {
    minBet:          500,
    maxBet:          500,
    walletSize:      15000,
    minBank:         15000,
    tieBet:          250,
    tieBetPayout:    5000,
    blackjackPayout: null,
    label:           'standard',
  },
  1000: {
    minBet:          1000,
    maxBet:          1000,
    walletSize:      30000,
    minBank:         50000,
    tieBet:          500,
    tieBetPayout:    10000,
    blackjackPayout: null,
    label:           'standard',
  },
  // One VIP table — fixed bet, flat blackjack + tie payouts
  50000: {
    minBet:          50000,
    maxBet:          50000,
    walletSize:      1000000,
    minBank:         1500000,
    tieBet:          5000,
    tieBetPayout:    250000,
    blackjackPayout: 170000,
    label:           'vip',
  },
  100000: {
    minBet:          100000,
    maxBet:          100000,
    walletSize:      5000000,
    minBank:         7000000,
    tieBet:          10000,
    tieBetPayout:    500000,
    blackjackPayout: 350000,
    label:           'elite',
  },
  500000: {
    minBet:          500000,
    maxBet:          500000,
    walletSize:      7000000,
    minBank:         10000000,
    tieBet:          25000,
    tieBetPayout:    1000000,
    blackjackPayout: 1000000,
    label:           'celestial',
  },
};

// ── Active Rooms ──────────────────────────────────────────────
const rooms = new Map(); // roomId → BlackjackRoom

function getOrCreateRoom(roomId, minBet) {
  if (!rooms.has(roomId)) {
    const config = TABLE_CONFIGS[minBet];
    if (!config) throw new Error(`Unknown minBet: ${minBet}`);
    rooms.set(roomId, new BlackjackRoom(roomId, config));
    console.log(`[BJ] Room created: ${roomId} (${config.label})`);
  }
  return rooms.get(roomId);
}

// ── WebSocket Server ──────────────────────────────────────────
const wss = new WebSocket.Server({ port: PORT }, () => {
  console.log(`[BJ] Blackjack WebSocket server listening on port ${PORT}`);
});

wss.on('connection', (ws, req) => {
  // Expected URL: /blackjack?roomId=bj_100_...&userId=123&sessionId=abc&minBet=100
  const url       = new URL(req.url, `http://localhost:${PORT}`);
  const roomId    = url.searchParams.get('roomId');
  const userId    = url.searchParams.get('userId');
  const sessionId = url.searchParams.get('sessionId');
  const minBet    = parseInt(url.searchParams.get('minBet'), 10);
  const token     = url.searchParams.get('token') || null;
  const joinRole  = url.searchParams.get('joinRole') === 'guest' ? 'guest' : 'player';

  if (!roomId || !userId || !sessionId || !minBet) {
    ws.close(1008, 'Missing required query params');
    return;
  }

  try {
    const room = getOrCreateRoom(roomId, minBet);
    room.addClient(ws, userId, sessionId, token, { joinRole });
    console.log(`[BJ] User ${userId} joined room ${roomId} as ${joinRole}`);
  } catch (e) {
    console.error('[BJ] Connection error:', e.message);
    ws.close(1011, e.message);
  }
});

// ── Cleanup empty rooms every 5 minutes ──────────────────────
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.clients.size === 0 && room.phase === 'waiting') {
      rooms.delete(id);
      console.log(`[BJ] Room cleaned up: ${id}`);
    }
  }
}, 5 * 60 * 1000);

// ── Graceful Shutdown ─────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[BJ] Shutting down...');
  wss.close(() => process.exit(0));
});
