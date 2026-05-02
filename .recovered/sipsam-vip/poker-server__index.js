// ============================================
// SIPSAM SERVER v2.0 — Multi-Table per Tier
// Port 2999: HTTP matchmake API
// Port 3001: WebSocket game server
//
// Supports:
//   - Multiple room instances per table tier
//   - Tier-isolated matchmaking ($100 never joins $500)
//   - Human priority (bot eviction on join)
//   - Quick-join (strangers) + invite (direct room)
// ============================================

const express   = require("express");
const cors      = require("cors");
const WebSocket = require("ws");
const { SipSamRoomManager, TABLE_CONFIG, MAX_SEATS } = require("./RoomManager");

const app = express();
app.use(cors());
app.use(express.json());

const pendingSessions = {};
let   sessionCounter  = 0;
const manager         = new SipSamRoomManager();

// Cleanup empty rooms every 60s
setInterval(() => manager.cleanup(), 60000);

// ── MATCHMAKE: Join or Create (tier-isolated) ────────────────
app.post("/matchmake/joinOrCreate/sipsam_room", (req, res) => {
    const sessionId    = "sess_" + (++sessionCounter) + "_" + Date.now();
    const username     = req.body?.username     || "Player";
    const token        = req.body?.token        || null;
    const avatar       = req.body?.avatar       || '';
    const isPrivate    = req.body?.isPrivate    || false;
    const tableMinBet  = parseInt(req.body?.tableMinBet) || 100;
    const maxRounds    = parseInt(req.body?.maxRounds)    || 10;
    const targetRoomId = req.body?.roomId        || null;

    let roomId, room, created;

    if (targetRoomId && targetRoomId !== 'sipsam_main') {
        // Direct join to specific room (invite flow)
        room = manager.getRoom(targetRoomId);
        if (!room) {
            return res.status(404).json({ error: "Room not found or expired" });
        }
        // Room is only "full" if there is NO bot to evict.
        const players    = Object.values(room.gameState.players);
        const humanCount = players.filter(p => !p.isBot && !p.isGhostBot).length;
        const botCount   = players.filter(p => p.isBot).length;
        if (humanCount >= MAX_SEATS) {
            return res.status(409).json({ error: "Room is full — all seats are human players." });
        }
        if (players.length >= MAX_SEATS && botCount === 0) {
            return res.status(409).json({ error: "Room is full." });
        }
        roomId  = targetRoomId;
        created = false;
    } else {
        // Public quick-join: find existing room at this tier or create new
        ({ roomId, room, created } = manager.joinOrCreate(tableMinBet, maxRounds));
    }

    pendingSessions[sessionId] = { username, token, roomId, avatar, isPrivate };
    console.log(`Matchmake: ${username} → ${sessionId} (room: ${roomId}, tier: $${tableMinBet}, ${created ? "NEW" : "EXISTING"})`);
    res.json({ name: "sipsam_room", sessionId, roomId, processId: "local", created });
});

// ── ROOM STATUS ───────────────────────────────────────────────
app.get("/room/:roomId/status", (req, res) => {
    const room = manager.getRoom(req.params.roomId);
    if (!room) return res.json({ exists: false });
    res.json({
        exists:    true,
        status:    room.gameState.status,
        players:   Object.keys(room.gameState.players).length,
        maxRounds: room.gameState.maxRounds
    });
});

// ── ACTIVE ROOMS LIST (per tier or all) ───────────────────────
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

    // Optional tier filter
    const filterTier = req.query.tableMinBet ? parseInt(req.query.tableMinBet) : null;

    const active = [];
    for (const [roomId, room] of manager.rooms) {
        if (room.gameState.status === 'gameOver') continue;
        if (filterTier && room.tableMinBet !== filterTier) continue;

        // Private rooms: only show if requester is already in the room
        if (room.gameState.isPrivate) {
            const inRoom = requestingUsername && Object.values(room.gameState.players)
                .some(p => p.username === requestingUsername);
            if (!inRoom) continue;
        }
        const players    = Object.values(room.gameState.players);
        const realCount  = players.filter(p => !p.isBot && !p.isGhostBot).length;
        const totalSeats = MAX_SEATS;
        const openSeats  = totalSeats - realCount;
        if (openSeats <= 0) continue; // full of humans

        active.push({
            roomId,
            tableMinBet:    room.tableMinBet || room.gameState.tableMinBet || 0,
            tableMaxBet:    room.gameState.tableMaxBet  || 0,
            maxRounds:      room.gameState.maxRounds     || 10,
            blitz:          room.gameState.blitz          || false,
            realPlayers:    realCount,
            openSeats,
            lobbyCountdown: room.gameState.lobbyCountdown || 0,
            playerNames:    players.filter(p => !p.isBot && !p.isGhostBot).map(p => p.username)
        });
    }
    res.json({ ok: true, rooms: active });
});

// ── BROWSE: List available tables for a tier ──────────────────
app.get("/tables/browse", (req, res) => {
    const tableMinBet = parseInt(req.query.tableMinBet) || 100;
    const rooms = manager.listRooms(tableMinBet);
    res.json({ ok: true, rooms });
});

// POST /room/:roomId/make-private — called when host sends first invite
app.post("/room/:roomId/make-private", (req, res) => {
    const room = manager.getRoom(req.params.roomId);
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

    const room = manager.getRoom(roomId);
    if (!room) {
        console.log("Room not found:", roomId, "— rejecting");
        socket.close(4002, "Room not found");
        return;
    }

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
        setTimeout(() => {
            const r = manager.getRoom(roomId);
            if (r && r.clients.length === 0) {
                manager.deleteRoom(roomId);
            }
        }, 5000);
    });

    socket.on("error", (err) => console.error("Socket error:", err.message));
});

wss.on("listening", () => {
    console.log("  Game WS:   ws://localhost:3001");
    console.log("==============================");
    console.log("  SIPSAM SERVER v2.0 READY");
    console.log("  Multi-table room manager active");
    console.log("==============================");
});
