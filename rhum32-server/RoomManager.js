// ============================================
// RHUM32 ROOM MANAGER v1.0
// Manages multiple table instances per tier
// Handles matchmaking, join, create, browse
// ============================================

const { Rhum32Room } = require("./Rhum32Room");

class RoomManager {
    constructor() {
        // roomId → Rhum32Room instance
        this.rooms = new Map();
        this.roomCounter = 0;
    }

    // Create a new room instance
    createRoom(tableMinBet, maxRounds, mode) {
        const roomId = "rhum32_" + tableMinBet + "_" + (++this.roomCounter) + "_" + Date.now();
        const room = new Rhum32Room();

        // Pre-configure the room
        const cfg = Rhum32Room.TABLE_CONFIG[tableMinBet] || Rhum32Room.TABLE_CONFIG[100];
        room.roomId           = roomId;
        room.gameState.tableMinBet = cfg.minBet;
        room.gameState.tableMaxBet = cfg.maxBet;
        room.gameState.tieBetMin   = cfg.tieBetMin;
        room.gameState.tieBetMax   = cfg.tieBetMax;
        room.gameState.frontInc    = cfg.frontInc;
        room.gameState.tieInc      = cfg.tieInc;
        room.gameState.maxRounds   = maxRounds || 10;
        room.gameState.mode        = mode || 'multiplayer'; // 'multiplayer' | 'single'
        room.tableMinBet           = cfg.minBet;

        this.rooms.set(roomId, room);
        console.log(`[RoomManager] Created room ${roomId} ($${tableMinBet}, ${maxRounds} rounds, ${mode})`);
        return { roomId, room };
    }

    // Get a room by ID
    getRoom(roomId) {
        return this.rooms.get(roomId) || null;
    }

    // List joinable rooms for a given table tier
    listRooms(tableMinBet, maxRounds) {
        const results = [];
        const wantedRounds = Number(maxRounds) || 0;
        for (const [roomId, room] of this.rooms) {
            if (room.tableMinBet !== tableMinBet) continue;
            if (room.gameState.mode === 'single') continue; // single-player rooms are private
            if (wantedRounds && Number(room.gameState.maxRounds) !== wantedRounds) continue;

            const playerCount = Object.values(room.gameState.players).length;
            const status      = room.gameState.status;

            // Only show rooms that have space and aren't over
            if (playerCount < 6 && status !== 'gameOver') {
                results.push({
                    roomId,
                    tableMinBet: room.tableMinBet,
                    playerCount,
                    maxPlayers: 6,
                    status,
                    round: room.gameState.round,
                    maxRounds: room.gameState.maxRounds,
                    mode: room.gameState.mode
                });
            }
        }
        return results;
    }

    // Find or create a room for public quick-join.
    // Match active rooms only when tier + selected round count are exact,
    // at least one future round remains, and a real seat is open. Unlike
    // SipSam, Rhum32 never replaces bots here; a late joiner waits for the
    // next round if the current hand is already past betting.
    joinOrCreate(tableMinBet, maxRounds) {
        const wantedRounds = Number(maxRounds) || 10;
        const candidates = [];

        for (const [roomId, room] of this.rooms) {
            const gs = room.gameState || {};
            if (room.tableMinBet !== tableMinBet) continue;
            if (gs.mode === 'single') continue;
            if (gs.status === 'waiting' || gs.status === 'gameOver') continue;
            if (Number(gs.maxRounds) !== wantedRounds) continue;
            if (Number(gs.round) >= wantedRounds) continue;

            const playerCount = Object.keys(gs.players || {}).length;
            if (playerCount >= 6) continue;

            candidates.push({
                roomId,
                room,
                score: (Number(gs.round) || 0) * 10 + playerCount
            });
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            const pick = candidates[0];
            console.log(`[RoomManager] Quick-join matched ${pick.roomId} ($${tableMinBet}, ${wantedRounds} rounds)`);
            return { roomId: pick.roomId, room: pick.room, created: false };
        }

        // Create new room
        const { roomId, room } = this.createRoom(tableMinBet, wantedRounds, 'multiplayer');
        return { roomId, room, created: true };
    }

    // Remove player from their room
    removePlayer(sessionId) {
        for (const [roomId, room] of this.rooms) {
            if (room.gameState.players[sessionId]) {
                const client = room.findClient(sessionId);
                if (client) {
                    room.clients = room.clients.filter(c => c.sessionId !== sessionId);
                    room.onLeave(client);
                }
                break;
            }
        }
    }

    // Find which room a session belongs to
    findRoomBySession(sessionId) {
        for (const [roomId, room] of this.rooms) {
            if (room.gameState.players[sessionId]) {
                return { roomId, room };
            }
        }
        return null;
    }

    // Clean up empty/finished rooms periodically
    cleanup() {
        for (const [roomId, room] of this.rooms) {
            const playerCount = Object.keys(room.gameState.players).length;
            if (playerCount === 0 && room.gameState.status !== 'waiting') {
                this.rooms.delete(roomId);
                console.log(`[RoomManager] Cleaned up empty room ${roomId}`);
            }
            if (room.gameState.status === 'gameOver') {
                // Keep for 30 seconds after game over
                setTimeout(() => {
                    if (this.rooms.has(roomId)) {
                        this.rooms.delete(roomId);
                        console.log(`[RoomManager] Cleaned up finished room ${roomId}`);
                    }
                }, 30000);
            }
        }
    }
}

module.exports = { RoomManager };
