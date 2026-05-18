// ============================================
// SIPSAM SERVER
// Port 2999: HTTP matchmake API
// Port 3001: WebSocket game server
// Supports multiple simultaneous rooms
// ============================================

const express   = require("express");
const cors      = require("cors");
const WebSocket = require("ws");
const { SipSamRoom } = require("./PokerRoom");

const app = express();
app.use(cors());
app.use(express.json());

const pendingSessions = {};
let   sessionCounter  = 0;

// ── ROOM REGISTRY ─────────────────────────────────────────────
// Multiple rooms keyed by roomId — one per active game session
// roomId comes from the client (either 'sipsam_main' or a specific invite roomId)
const rooms = {};

function getOrCreateRoom(roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = new SipSamRoom();
        console.log("[ROOMS] Created room:", roomId, "| Total rooms:", Object.keys(rooms).length);
    }
    return rooms[roomId];
}

function cleanupRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const hasClients = room.clients.length > 0;
    if (!hasClients) {
        delete rooms[roomId];
        console.log("[ROOMS] Deleted empty room:", roomId, "| Remaining:", Object.keys(rooms).length);
    }
}

// ── QUICK-JOIN MATCHMAKING ────────────────────────────────────
// Match on tier (minBet) AND round-count chosen on the dashboard.
// Rules:
//   1. Skip completed rooms.
//   2. Waiting rooms: must be public, have open seats, AND match rounds (or
//      have no rounds set yet — fresh shell room).
//   3. In-progress rooms: must match rounds, have at least one replaceable
//      non-banker bot, AND not be on the final round. isPrivate is ignored
//      once a game has started — strangers fill bot seats Zynga-style.
//   4. Prefer waiting matches first (humans want a lobby with friends), then
//      in-progress with replaceable bots.
//   5. Else create new sipsam_<minBet>_<timestamp>.
function quickJoinForTier(requestedRoomId, wantedRounds) {
    const m = String(requestedRoomId || '').match(/^sipsam_(\d+)(?:_|$)/);
    if (!m) return requestedRoomId; // not a tier hint — pass through (invite flow)
    const minBet = Number(m[1]);
    const rounds = Number(wantedRounds) || 0;
    const candidates = [];

    // Public quick-join is intentionally strict: players only enter an
    // already-started table when tier and selected round count match exactly,
    // and a bot seat can be replaced. Waiting lobbies remain invite/private
    // flow territory; otherwise create a new public room for this selection.
    for (const [rid, room] of Object.entries(rooms)) {
        const gs = room.gameState;
        if (!gs || gs.completed) continue;
        if (gs.status === 'waiting' || gs.status === 'gameOver') continue;
        if (Number(gs.tableKey || gs.tableMinBet) !== minBet) continue;
        if (!rounds || Number(gs.maxRounds) !== rounds) continue;

        // Don't allow joining on the final round; the game is effectively over.
        if (Number(gs.round) >= rounds) continue;

        const players = Object.values(gs.players || {});
        const humans = players.filter(p => !p.isBot && !p.isGhostBot).length;
        const replaceableBot = players.some(p => p.isBot && !p.isGhostBot && !p.isBanker);
        if (!replaceableBot) continue;

        candidates.push({ rid, score: (humans * 10) + (Number(gs.round) || 0), kind: 'in-progress' });
    }
    if (candidates.length) {
        candidates.sort((a,b) => b.score - a.score);
        const pick = candidates[0];
        console.log(`[QUICK-JOIN] tier ${minBet} rounds ${rounds}: matched ${pick.kind} room ${pick.rid}`);
        return pick.rid;
    }
    const newId = `sipsam_${minBet}_${Date.now()}`;
    console.log(`[QUICK-JOIN] tier ${minBet} rounds ${rounds}: no match — creating ${newId}`);
    return newId;
}

// ── MATCHMAKE ─────────────────────────────────────────────────
// Accepts optional roomId — if provided, joins that specific room (invite flow)
// If not provided, uses 'sipsam_main' (default public room)
app.post("/matchmake/joinOrCreate/sipsam_room", (req, res) => {
    const sessionId = "sess_" + (++sessionCounter) + "_" + Date.now();
    const username  = req.body?.username  || "Player";
    const token     = req.body?.token     || null;
    let   roomId    = req.body?.roomId    || "sipsam_main";
    const avatar    = req.body?.avatar    || '';
    const isPrivate = req.body?.isPrivate || false;
    const quickJoin = req.body?.quickJoin === true;
    const maxRounds = Number(req.body?.maxRounds) || 0;
    const blitz     = req.body?.blitz === true;

    // Quick-join: tier+rounds hint. Invite flow (specific roomId, isPrivate)
    // bypasses this and goes straight to the named room.
    if (quickJoin && !isPrivate) {
        roomId = quickJoinForTier(roomId, maxRounds);
    }

    pendingSessions[sessionId] = { username, token, roomId, avatar, isPrivate, maxRounds, blitz };
    console.log("Matchmake:", username, "→", sessionId, "room:", roomId,
        quickJoin ? `(quick-join rounds=${maxRounds})` : '');
    res.json({ name:"sipsam_room", sessionId, roomId, processId:"local" });
});

// ── ROOM STATUS ───────────────────────────────────────────────
app.get("/room/:roomId/status", (req, res) => {
    const room = rooms[req.params.roomId];
    if (!room) return res.json({ exists: false });
    res.json({
        exists:    true,
        status:    room.gameState.status,
        players:   Object.keys(room.gameState.players).length,
        maxRounds: room.gameState.maxRounds
    });
});

// ── ACTIVE ROOMS LIST ─────────────────────────────────────────
// Returns all rooms currently in 'waiting' status with seats available
app.get("/rooms/active", (req, res) => {
    // Extract requesting username from auth token if provided
    let requestingUsername = null;
    try {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const jwt     = require('jsonwebtoken');
            const secret  = process.env.JWT_SECRET || 'vurglife_jwt_secret_change_in_prod';
            const decoded = jwt.verify(authHeader.slice(7), secret);
            requestingUsername = decoded.username || null;
        }
    } catch(e) {}

    const active = [];
    for (const [roomId, room] of Object.entries(rooms)) {
        if (room.gameState.status !== 'waiting') continue;
        // Private rooms: only show if requester is already in the room
        if (room.gameState.isPrivate) {
            const inRoom = requestingUsername && Object.values(room.gameState.players)
                .some(p => p.username === requestingUsername);
            if (!inRoom) continue;
        }
        const players    = Object.values(room.gameState.players);
        const realCount  = players.filter(p => !p.isBot && !p.isGhostBot).length;
        const botCount   = players.filter(p => p.isBot).length;
        const totalSeats = 4;
        const openSeats  = totalSeats - realCount;
        if (openSeats <= 0) continue; // full
        active.push({
            roomId,
            tableMinBet:   room.gameState.tableMinBet  || 0,
            tableMaxBet:   room.gameState.tableMaxBet  || 0,
            maxRounds:     room.gameState.maxRounds    || 10,
            blitz:         room.gameState.blitz        || false,
            realPlayers:   realCount,
            openSeats,
            lobbyCountdown: room.gameState.lobbyCountdown || 0,
            playerNames:   players.filter(p => !p.isBot).map(p => p.username)
        });
    }
    res.json({ ok: true, rooms: active });
});

// POST /room/:roomId/make-private — called when host sends first invite
app.post("/room/:roomId/make-private", (req, res) => {
    const room = rooms[req.params.roomId];
    if (!room) return res.json({ ok: false, error: 'Room not found' });
    room.gameState.isPrivate = true;
    console.log(`[ROOM] ${req.params.roomId} → private`);
    res.json({ ok: true });
});

app.get("/health", (req, res) => res.send("OK"));

app.listen(2999, () => {
    console.log("  Game API:  http://localhost:2999");
});

// ── WEBSOCKET SERVER ──────────────────────────────────────────
const wss = new WebSocket.Server({ port: 3001 });

wss.on("connection", (socket, req) => {
    const url       = new URL("ws://localhost:3001" + req.url);
    const sessionId = url.searchParams.get("sessionId");
    const session   = pendingSessions[sessionId];

    if (!session) {
        console.log("Unknown session:", sessionId, "— rejecting");
        socket.close(4001, "Unknown session");
        return;
    }

    delete pendingSessions[sessionId];
    const { username, token, roomId, avatar, isPrivate, maxRounds, blitz } = session;
    console.log(username, "WS connected, session:", sessionId, "room:", roomId);

    const room   = getOrCreateRoom(roomId);
    const client = {
        sessionId,
        roomId,
        send: (data) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(data);
        }
    };

    room._roomId = roomId; // store for invite expiry notifications
    client.roomId = roomId;
    room.clients.push(client);
    room.onJoin(client, { username, token, avatar, isPrivate, maxRounds, blitz });

    socket.on("message", (rawData) => {
        try {
            const msg  = JSON.parse(rawData.toString());
            const type = msg.type;
            const data = Object.assign({}, msg);
            delete data.type;
            console.log("MSG [" + username + "] room:" + roomId + ":", type);
            room._dispatchMessage(type, client, data);
        } catch(e) {
            console.error("Message error:", e.message);
        }
    });

    socket.on("close", (code) => {
        console.log(username, "disconnected from room:", roomId, "code:", code);
        room.clients = room.clients.filter(c => c.sessionId !== sessionId);
        room.onLeave(client, false);
        // Clean up empty rooms after a short delay
        setTimeout(() => cleanupRoom(roomId), 5000);
    });

    socket.on("error", (err) => console.error("Socket error:", err.message));
});

wss.on("listening", () => {
    console.log("  Game WS:   ws://localhost:3001");
    console.log("  Multi-room: ENABLED");
});
