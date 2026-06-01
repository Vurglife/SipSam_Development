// ============================================
// RHUM32 SERVER v2.0 — Multi-Table
// Port 2998: Express matchmake + table browse API
// Port 3002: Pure WebSocket game server (ws)
//
// Supports:
//   - Multiple room instances per table tier
//   - Multiplayer (join/create/browse) + Single player
//   - Quick-join (strangers join open tables)
//   - Direct room join (via invite)
// ============================================

const express   = require("express");
const cors      = require("cors");
const WebSocket = require("ws");
const { RoomManager } = require("./RoomManager");

// ---- WEB + API SERVER (port 2998) ----
const app = express();
app.use(cors());
app.use(express.json());

const pendingSessions = {};
let   sessionCounter  = 0;
const manager         = new RoomManager();

// Cleanup empty rooms every 60s
setInterval(() => manager.cleanup(), 60000);

// ── MATCHMAKE: Join or Create (quick-join for strangers) ────────
app.post("/matchmake/joinOrCreate/rhum32_room", (req, res) => {
    const sessionId    = "r32_" + (++sessionCounter) + "_" + Date.now();
    const username     = req.body?.username     || "Player";
    const wallet       = req.body?.wallet       || 5000;
    const token        = req.body?.token        || null; // platform JWT — for server-authoritative wallet ops
    const tableMinBet  = req.body?.tableMinBet  || 100;
    const maxRounds    = req.body?.maxRounds     || 10;
    const mode         = req.body?.mode          || "multiplayer"; // 'multiplayer' | 'single'
    const targetRoomId = req.body?.roomId        || null;          // direct join via invite
    const isHost       = req.body?.isHost === true;                // host eager-creates a private room

    let roomId, room, created;

    if (targetRoomId) {
        // Direct join to specific room (invite flow / late-join)
        room = manager.getRoom(targetRoomId);
        if (!room) {
            return res.status(404).json({ error: "Room not found or expired" });
        }
        const playerCount = Object.keys(room.gameState.players).length;
        if (playerCount >= 6) {
            return res.status(409).json({ error: "Room is full" });
        }
        roomId = targetRoomId;
        created = false;
    } else if (mode === "single") {
        // Single player: always create new private room
        ({ roomId, room } = manager.createRoom(tableMinBet, maxRounds, "single"));
        created = true;
    } else if (isHost) {
        // Multiplayer host: always create a NEW room so invitees can join
        // THIS host's table. Quick-join (joinOrCreate) is for strangers, not
        // for a host setting up a private game.
        ({ roomId, room } = manager.createRoom(tableMinBet, maxRounds, "multiplayer"));
        created = true;
    } else {
        // Multiplayer quick-join (strangers): find existing or create
        ({ roomId, room, created } = manager.joinOrCreate(tableMinBet, maxRounds));
    }

    const becomesHost = isHost || (created && mode === "multiplayer" && !targetRoomId);
    pendingSessions[sessionId] = { username, roomId, wallet, token, isHost: becomesHost };
    console.log(`Matchmake: ${username} → ${sessionId} (room: ${roomId}, ${created ? "NEW" : "EXISTING"}${becomesHost ? ", HOST" : ""})`);
    res.json({ name: "rhum32_room", sessionId, roomId, processId: "local", created });
});

// ── BROWSE: List available tables for a tier ────────────────────
app.get("/tables/browse", (req, res) => {
    const tableMinBet = parseInt(req.query.tableMinBet) || 100;
    const rooms = manager.listRooms(tableMinBet);
    res.json({ ok: true, rooms });
});

// ── CREATE: Host a new table ────────────────────────────────────
app.post("/tables/create", (req, res) => {
    const tableMinBet = req.body?.tableMinBet || 100;
    const maxRounds   = req.body?.maxRounds   || 10;
    const mode        = req.body?.mode        || "multiplayer";
    const { roomId }  = manager.createRoom(tableMinBet, maxRounds, mode);
    res.json({ ok: true, roomId });
});

app.get("/health", (req, res) => res.send("OK"));

app.listen(2998, () => {
    console.log("  Rhum32 API:  http://localhost:2998");
});

// ---- WEBSOCKET GAME SERVER (port 3003) ----
const wss = new WebSocket.Server({ port: 3003 });

wss.on("connection", (socket, req) => {
    const url       = new URL("ws://localhost:3003" + req.url);
    const sessionId = url.searchParams.get("sessionId");
    const session   = pendingSessions[sessionId];

    if (!session) {
        console.log("Unknown Rhum32 session:", sessionId, "— rejecting");
        socket.close(4001, "Unknown session");
        return;
    }

    delete pendingSessions[sessionId];

    const room = manager.getRoom(session.roomId);
    if (!room) {
        console.log("Room not found:", session.roomId, "— rejecting");
        socket.close(4002, "Room not found");
        return;
    }

    console.log(`${session.username} WS connected → room ${session.roomId}`);

    const client = {
        sessionId,
        send: (data) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(data);
        }
    };

    room.clients.push(client);
    room.onJoin(client, { username: session.username, wallet: session.wallet, token: session.token, isHost: session.isHost === true });

    socket.on("message", (rawData) => {
        try {
            const msg  = JSON.parse(rawData.toString());
            const type = msg.type;
            const data = Object.assign({}, msg);
            delete data.type;
            console.log("MSG [" + session.username + "]:", type, JSON.stringify(data));
            room._dispatchMessage(type, client, data);
        } catch (e) {
            console.error("Message error:", e.message);
        }
    });

    socket.on("close", (code) => {
        console.log(`${session.username} disconnected from room ${session.roomId}:`, code);
        room.clients = room.clients.filter(c => c.sessionId !== sessionId);
        room.onLeave(client);
    });

    socket.on("error", (err) => console.error("Rhum32 socket error:", err.message));
});

wss.on("listening", () => {
    console.log("  Rhum32 WS:   ws://localhost:3003");
    console.log("==============================");
    console.log("  RHUM32 SERVER v2.0 READY");
    console.log("  Multi-table room manager active");
    console.log("==============================");
});
