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
// VIP tables:     fixed main bet per tier, flat blackjack + tie payouts.
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
  // VIP tiers — fixed bets, flat payouts
  1000: {
    minBet:          1000,
    maxBet:          1000,
    walletSize:      30000,
    minBank:         50000,
    tieBet:          500,
    tieBetPayout:    10000,
    blackjackPayout: 5000,
    label:           'vip',
  },
  5000: {
    minBet:          5000,
    maxBet:          5000,
    walletSize:      120000,
    minBank:         150000,
    tieBet:          1000,
    tieBetPayout:    30000,
    blackjackPayout: 15000,
    label:           'vip',
  },
  10000: {
    minBet:          10000,
    maxBet:          10000,
    walletSize:      240000,
    minBank:         300000,
    tieBet:          2000,
    tieBetPayout:    75000,
    blackjackPayout: 30000,
    label:           'vip',
  },
  20000: {
    minBet:          20000,
    maxBet:          20000,
    walletSize:      500000,
    minBank:         750000,
    tieBet:          3000,
    tieBetPayout:    125000,
    blackjackPayout: 70000,
    label:           'vip',
  },
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

  if (!roomId || !userId || !sessionId || !minBet) {
    ws.close(1008, 'Missing required query params');
    return;
  }

  try {
    const room = getOrCreateRoom(roomId, minBet);
    room.addClient(ws, userId, sessionId, token);
    console.log(`[BJ] User ${userId} joined room ${roomId}`);
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
