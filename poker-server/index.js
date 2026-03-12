// ============================================
// SIPSAM SERVER v8.0
// Port 3000: Express serves client AND matchmake API
// Port 3001: Pure WebSocket game server (ws package)
// ============================================

const express   = require("express");
const path      = require("path");
const cors      = require("cors");
const WebSocket = require("ws");
const { SipSamRoom } = require("./PokerRoom");

// ---- WEB + API SERVER (port 3000) ----
const app = express();
app.use(cors());
app.use(express.json());
// Static files served by VurgLife platform at /sipsam

const pendingSessions = {};
let   sessionCounter  = 0;
const roomInstance    = new SipSamRoom();

// Matchmake endpoint — port 2999 (proxied from VurgLife platform on 3000)
app.post("/matchmake/joinOrCreate/sipsam_room", (req, res) => {
    const sessionId = "sess_" + (++sessionCounter) + "_" + Date.now();
    const roomId    = "sipsam_main";
    const username  = req.body?.username || "Player";
    pendingSessions[sessionId] = { username, roomId };
    console.log("Matchmake:", username, "→", sessionId);
    res.json({ name:"sipsam_room", sessionId, roomId, processId:"local" });
});

app.get("/health", (req, res) => res.send("OK"));

app.listen(2999, () => {
    console.log("  Game API:  http://localhost:2999");
});

// ---- WEBSOCKET GAME SERVER (port 3001) ----
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
    console.log(session.username, "WS connected, session:", sessionId);

    const client = {
        sessionId,
        send: (data) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(data);
        }
    };

    roomInstance.clients.push(client);
    roomInstance.onJoin(client, { username: session.username });

    socket.on("message", (rawData) => {
        try {
            const msg  = JSON.parse(rawData.toString());
            const type = msg.type;
            const data = Object.assign({}, msg);
            delete data.type;
            console.log("MSG [" + session.username + "]:", type, JSON.stringify(data));
            roomInstance._dispatchMessage(type, client, data);
        } catch(e) {
            console.error("Message error:", e.message);
        }
    });

    socket.on("close", (code) => {
        console.log(session.username, "disconnected:", code);
        roomInstance.clients = roomInstance.clients.filter(c => c.sessionId !== sessionId);
        roomInstance.onLeave(client, false);
    });

    socket.on("error", (err) => console.error("Socket error:", err.message));
});

wss.on("listening", () => {
    console.log("  Game WS:   ws://localhost:3001");
    console.log("==============================");
    console.log("  SIPSAM SERVER READY");
    console.log("  Platform:  http://localhost:3000");
    console.log("  Game API:  http://localhost:2999");
    console.log("==============================");
});
