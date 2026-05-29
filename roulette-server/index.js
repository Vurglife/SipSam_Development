'use strict';

// ─────────────────────────────────────────────────────────────
// VurgLife Roulette — server/index.js
// Port 3005: Express matchmake + table browse API
// Port 3006: WebSocket game server (ws)
// Current release exposes American roulette. European logic stays in engine.js
// for the later European table build.
// Mirrors the Rhum32 two-port pattern so the platform proxy stays consistent.
// Spawned by vurglife-platform/server/index.js — see PLATFORM_INTEGRATION.md.
// ─────────────────────────────────────────────────────────────

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const WebSocket = require('ws');
const { RoomManager } = require('./RoomManager');
const RouletteRoom    = require('./RouletteRoom');

const API_PORT = Number(process.env.ROULETTE_API_PORT) || 3005;
const WS_PORT  = Number(process.env.ROULETTE_WS_PORT)  || 3006;

const app = express();
app.use(cors());
app.use(express.json());

// Serve the client statically when running standalone. The platform proxies
// to this server in production, so the client is also served via the platform.
app.use('/', express.static(path.join(__dirname, '..', 'roulette-client')));

const pendingSessions = {};
let   sessionCounter  = 0;
const manager         = new RoomManager();

setInterval(() => manager.cleanup(), 60000);

// ── CONFIG BROWSE ──────────────────────────────────────────
app.get('/tables/config', (_req, res) => {
  res.json({ ok: true, tiers: RouletteRoom.TABLE_CONFIG });
});

// ── MATCHMAKE: Join or Create ──────────────────────────────
app.post('/matchmake/joinOrCreate/roulette_room', (req, res) => {
  const sessionId    = 'rlt_' + (++sessionCounter) + '_' + Date.now();
  const username     = req.body?.username    || 'Player';
  const userId       = req.body?.userId      || null;
  const token        = req.body?.token       || null;
  const wallet       = Number(req.body?.wallet) || 0;
  const tableMinBet  = Number(req.body?.tableMinBet) || 100;
  const variant      = 'american';
  const mode         = req.body?.mode        || 'multiplayer';
  const targetRoomId = req.body?.roomId      || null;

  let roomId, room, created;

  if (targetRoomId) {
    room = manager.getRoom(targetRoomId);
    if (!room) return res.status(404).json({ error: 'Room not found or expired' });
    const count = Object.keys(room.players).length;
    if (count >= RouletteRoom.MAX_PLAYERS) {
      return res.status(409).json({ error: 'Room is full' });
    }
    roomId = targetRoomId;
    created = false;
  } else {
    ({ roomId, room, created } = manager.joinOrCreate(variant, tableMinBet));
  }

  pendingSessions[sessionId] = { username, userId, roomId, wallet, token, tableMinBet };
  console.log(`[RouletteMatchmake] ${username} → ${sessionId} (${roomId}, ${created ? 'NEW' : 'EXISTING'})`);
  res.json({
    ok:        true,
    name:      'roulette_room',
    sessionId,
    roomId,
    variant:   room.variant,
    tableMinBet: room.tableMinBet,
    created,
  });
});

// ── BROWSE ─────────────────────────────────────────────────
app.get('/tables/browse', (req, res) => {
  const variant = req.query.variant || null;
  const tableMinBet = req.query.tableMinBet ? Number(req.query.tableMinBet) : null;
  res.json({ ok: true, rooms: manager.listRooms(variant, tableMinBet) });
});

// ── CREATE a host room ─────────────────────────────────────
app.post('/tables/create', (req, res) => {
  const tableMinBet = Number(req.body?.tableMinBet) || 100;
  const variant = 'american';
  const mode = req.body?.mode || 'multiplayer';
  const { roomId } = manager.createRoom(variant, tableMinBet, mode);
  res.json({ ok: true, roomId });
});

app.get('/health', (_req, res) => res.send('OK'));

app.listen(API_PORT, () => {
  console.log('  Roulette API: http://localhost:' + API_PORT);
});

// ── WEBSOCKET GAME SERVER ──────────────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (socket, req) => {
  const url = new URL('ws://localhost:' + WS_PORT + req.url);
  const sessionId = url.searchParams.get('sessionId');
  const session   = pendingSessions[sessionId];

  if (!session) {
    console.log('[Roulette] Unknown session:', sessionId, '— rejecting');
    socket.close(4001, 'Unknown session');
    return;
  }
  delete pendingSessions[sessionId];

  const room = manager.getRoom(session.roomId);
  if (!room) {
    console.log('[Roulette] Room not found:', session.roomId);
    socket.close(4002, 'Room not found');
    return;
  }

  console.log(`[Roulette] ${session.username} WS → room ${session.roomId}`);

  const client = {
    sessionId,
    userId: session.userId,
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
  };
  room.clients.push(client);
  room.onJoin(client, {
    username: session.username,
    wallet:   session.wallet,
    userId:   session.userId,
    token:    session.token,
    tableMinBet: session.tableMinBet,
  });

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { type, ...data } = msg;
      room._dispatchMessage(type, client, data);
    } catch (e) {
      console.error('[Roulette] bad message:', e.message);
    }
  });

  socket.on('close', (code) => {
    console.log(`[Roulette] ${session.username} disconnect (${code})`);
    room.clients = room.clients.filter((c) => c.sessionId !== sessionId);
    room.onLeave(client);
  });

  socket.on('error', (err) => console.error('[Roulette] socket error:', err.message));
});

wss.on('listening', () => {
  console.log('  Roulette WS:  ws://localhost:' + WS_PORT);
  console.log('==============================');
  console.log('  ROULETTE SERVER READY');
  console.log('  Variant: american');
  console.log('==============================');
});

process.on('SIGTERM', () => {
  console.log('[Roulette] Shutting down...');
  wss.close();
  process.exit(0);
});
