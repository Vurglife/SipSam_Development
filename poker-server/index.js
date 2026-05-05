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
// Given a tier (sipsam_<minBet>), find a 'waiting' room with open seats so
// the joiner lands in a proper lobby (round selection, invite friends).
// Rules:
//   1. Skip rooms marked completed (game over).
//   2. Skip private (invite-only) rooms.
//   3. Skip in-progress rooms — joiner deserves their own lobby; do not
//      drop strangers into a live game (was causing UX bugs where the
//      stranger's chips drained on auto-bets without replacing any bot).
//   4. Else prefer a 'waiting' room with open seats (most humans first).
//   5. Else create a new sipsam_<minBet>_<timestamp> room.
function quickJoinForTier(requestedRoomId) {
    const m = String(requestedRoomId || '').match(/^sipsam_(\d+)(?:_|$)/);
    if (!m) return requestedRoomId; // not a tier hint — pass through (invite flow)
    const minBet = Number(m[1]);
    const candidates = [];
    for (const [rid, room] of Object.entries(rooms)) {
        const gs = room.gameState;
        if (!gs || gs.completed) continue;
        if (Number(gs.tableMinBet) !== minBet) continue;
        if (gs.isPrivate) continue;
        if (gs.status !== 'waiting') continue; // never drop into in-progress
        const players  = Object.values(gs.players || {});
        const humans   = players.filter(p => !p.isBot && !p.isGhostBot).length;
        const openSeats = Math.max(0, 4 - players.length);
        if (openSeats <= 0) continue;
        candidates.push({ rid, humans, openSeats });
    }
    if (candidates.length) {
        candidates.sort((a,b) => (b.humans - a.humans) || (a.openSeats - b.openSeats));
        const pick = candidates[0];
        console.log(`[QUICK-JOIN] tier ${minBet}: matched waiting room ${pick.rid} (humans=${pick.humans} open=${pick.openSeats})`);
        return pick.rid;
    }
    const newId = `sipsam_${minBet}_${Date.now()}`;
    console.log(`[QUICK-JOIN] tier ${minBet}: no waiting room — creating ${newId}`);
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

    // Quick-join: caller passed a tier hint (sipsam_<minBet>) and wants the
    // server to find an existing room with a bot to replace, or create a new
    // tier room. Invite flow (specific roomId, isPrivate=true) bypasses this.
    if (quickJoin && !isPrivate) {
        roomId = quickJoinForTier(roomId);
    }

    pendingSessions[sessionId] = { username, token, roomId, avatar, isPrivate };
    console.log("Matchmake:", username, "→", sessionId, "room:", roomId, quickJoin ? '(quick-join)' : '');
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
    const { username, token, roomId, avatar, isPrivate } = session;
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
    room.onJoin(client, { username, token, avatar, isPrivate });

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
