// ============================================
// SIPSAM ROOM MANAGER v1.0
// Manages multiple SipSam table instances per tier
// Handles matchmaking, join, create, browse
// Mirrors the Rhum32 RoomManager pattern exactly.
// ============================================

const { SipSamRoom } = require("./PokerRoom");

// Authoritative per-tier table config (same values as PokerRoom.js _onStartGame)
const TABLE_CONFIG = {
    100:   { minBet: 100,   increment: 50,    maxBet: 150,   walletSize: 3000,    minBank: 5000    },
    250:   { minBet: 250,   increment: 50,    maxBet: 500,   walletSize: 10000,   minBank: 15000   },
    500:   { minBet: 500,   increment: 100,   maxBet: 1000,  walletSize: 20000,   minBank: 30000   },
    1000:  { minBet: 1000,  increment: 500,   maxBet: 2000,  walletSize: 40000,   minBank: 60000   },
    10000: { minBet: 10000, increment: 10000, maxBet: 50000, walletSize: 1000000, minBank: 2000000 }
};

const MAX_SEATS = 4;

class SipSamRoomManager {
    constructor() {
        // roomId → SipSamRoom instance
        this.rooms = new Map();
        this.roomCounter = 0;
    }

    // Create a new room instance for a specific tier
    createRoom(tableMinBet, maxRounds, mode, opts = {}) {
        const bet = [100, 250, 500, 1000, 10000].includes(tableMinBet) ? tableMinBet : 100;
        const rounds = [5, 10, 20, 30].includes(maxRounds) ? maxRounds : 10;
        const roomMode = mode === 'single' ? 'single' : 'multiplayer';

        const roomId =
            opts.fixedRoomId ||
            ("sipsam_" + bet + "_" + (++this.roomCounter) + "_" + Date.now());

        const room = new SipSamRoom();
        const cfg  = TABLE_CONFIG[bet];

        // Pre-configure so table info is visible BEFORE startGame is called
        room._roomId                   = roomId;
        room.gameState.tableMinBet     = cfg.minBet;
        room.gameState.tableMaxBet     = cfg.maxBet;
        room.gameState.tableIncrement  = cfg.increment;
        room.gameState.tableWalletSize = cfg.walletSize;
        room.gameState.maxRounds       = rounds;
        room.gameState.mode            = roomMode;
        room.tableMinBet               = bet;
        room.maxRoundsPreset           = rounds;

        this.rooms.set(roomId, room);
        console.log(`[RoomManager] Created room ${roomId} ($${bet}, ${rounds} rounds, ${roomMode})`);
        return { roomId, room };
    }

    // Get a room by ID
    getRoom(roomId) {
        return this.rooms.get(roomId) || null;
    }

    // List joinable rooms for a given table tier (for the browse UI)
    listRooms(tableMinBet) {
        const results = [];
        for (const [roomId, room] of this.rooms) {
            if (room.tableMinBet !== tableMinBet) continue;
            if (room.gameState.mode === 'single') continue; // single-player rooms are private
            if (room.gameState.isPrivate) continue;         // private friends rooms hidden

            const players    = Object.values(room.gameState.players);
            const realCount  = players.filter(p => !p.isBot && !p.isGhostBot).length;
            const status     = room.gameState.status;

            // Only show rooms that have seat space for a human and aren't over
            if (realCount < MAX_SEATS && status !== 'gameOver') {
                results.push({
                    roomId,
                    tableMinBet:    room.tableMinBet,
                    tableMaxBet:    room.gameState.tableMaxBet,
                    realPlayers:    realCount,
                    openSeats:      MAX_SEATS - realCount,
                    maxPlayers:     MAX_SEATS,
                    status,
                    round:          room.gameState.round,
                    maxRounds:      room.gameState.maxRounds,
                    lobbyCountdown: room.gameState.lobbyCountdown || 0,
                    playerNames:    players.filter(p => !p.isBot && !p.isGhostBot).map(p => p.username)
                });
            }
        }
        return results;
    }

    // Find or create a Global Multiplayer SipSam room.
    // Rules:
    //  - Match by tableMinBet AND maxRounds (exact)
    //  - Public only (skip private/friends rooms)
    //  - Joinable if: status==='waiting' with seat free, OR has at least 1 bot to evict
    //  - If no candidate found, create a fresh room (will be bot-filled on startGame)
    // This guarantees a $250 player NEVER lands in a $500 room.
    joinOrCreate(tableMinBet, maxRounds) {
        const candidates = [];
        for (const [roomId, room] of this.rooms) {
            if (room.tableMinBet !== tableMinBet) continue;
            if (room.gameState.mode !== 'multiplayer') continue;
            if (room.gameState.isPrivate) continue;
            if (room.gameState.maxRounds !== maxRounds) continue;
            if (room.gameState.status === 'gameOver') continue;

            const players    = Object.values(room.gameState.players);
            const hasBot     = players.some(p => p.isBot && !p.isBanker);
            const realCount  = players.filter(p => !p.isBot && !p.isGhostBot).length;
            const waitingSeat = room.gameState.status === 'waiting' && players.length < MAX_SEATS;

            // Joinable if waiting+open OR there's a bot (we can evict to make room)
            if (waitingSeat || hasBot) {
                candidates.push({
                    roomId, room, hasBot, realCount,
                    waiting: room.gameState.status === 'waiting'
                });
            }
        }

        if (candidates.length > 0) {
            // Prefer waiting rooms, then rooms with most real players
            candidates.sort((a, b) => {
                if (a.waiting && !b.waiting) return -1;
                if (!a.waiting && b.waiting) return 1;
                return b.realCount - a.realCount;
            });
            return { roomId: candidates[0].roomId, room: candidates[0].room, created: false };
        }

        // No matching room — create a new one at the requested tier
        const { roomId, room } = this.createRoom(tableMinBet, maxRounds, 'multiplayer');
        return { roomId, room, created: true };
    }

    // Delete room
    deleteRoom(roomId) {
        if (this.rooms.has(roomId)) {
            this.rooms.delete(roomId);
            console.log(`[RoomManager] Deleted room ${roomId}`);
        }
    }

    // Clean up empty/finished rooms
    cleanup() {
        for (const [roomId, room] of this.rooms) {
            const playerCount = Object.keys(room.gameState.players).length;
            const hasClients  = room.clients && room.clients.length > 0;
            // Remove truly empty rooms (no players AND no websocket clients)
            if (playerCount === 0 && !hasClients) {
                this.rooms.delete(roomId);
                console.log(`[RoomManager] Cleaned up empty room ${roomId}`);
                continue;
            }
            if (room.gameState.status === 'gameOver') {
                setTimeout(() => {
                    const still = this.rooms.get(roomId);
                    if (still && still.clients.length === 0) {
                        this.rooms.delete(roomId);
                        console.log(`[RoomManager] Cleaned up finished room ${roomId}`);
                    }
                }, 30000);
            }
        }
    }
}

module.exports = { SipSamRoomManager, TABLE_CONFIG, MAX_SEATS };
