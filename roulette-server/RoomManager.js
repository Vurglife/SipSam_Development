'use strict';

// ─────────────────────────────────────────────────────────────
// VurgLife Roulette — RoomManager.js
// Room map keyed by roomId. Roulette now quick-joins one shared American room;
// access tier limits stay per player rather than per room.
// ─────────────────────────────────────────────────────────────

const RouletteRoom = require('./RouletteRoom');

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.counter = 0;
    this.publicRoomId = 'rlt_american_main';
  }

  createRoom(variant, tableMinBet, mode) {
    const v = 'american';
    const m = 'multiplayer';
    const roomId = this.publicRoomId;
    const existing = this.rooms.get(roomId);
    if (existing) return { roomId, room: existing };
    const room = new RouletteRoom({ roomId, variant: v, tableMinBet, mode: m });
    this.rooms.set(roomId, room);
    console.log(`[RouletteRoomManager] Created ${roomId} (${v}, $${tableMinBet}, ${m})`);
    return { roomId, room };
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  listRooms(variant, tableMinBet) {
    const out = [];
    for (const [roomId, room] of this.rooms) {
      if (variant && room.variant !== variant) continue;
      const playerCount = Object.keys(room.players).length;
      if (playerCount >= RouletteRoom.MAX_PLAYERS) continue;
      out.push({
        roomId,
        variant: room.variant,
        tableMinBet: Number(tableMinBet) || room.tableMinBet,
        playerCount,
        maxPlayers: RouletteRoom.MAX_PLAYERS,
        phase: room.phase,
        round: room.round,
      });
    }
    return out;
  }

  joinOrCreate(variant, tableMinBet) {
    const v = 'american';
    let room = this.rooms.get(this.publicRoomId);
    if (room) {
      return { roomId: this.publicRoomId, room, created: false };
    }
    const { roomId, room: createdRoom } = this.createRoom(v, tableMinBet, 'public');
    room = createdRoom;
    return { roomId, room, created: true };
  }

  cleanup() {
    for (const [roomId, room] of this.rooms) {
      if (roomId === this.publicRoomId) continue;
      const playerCount = Object.keys(room.players).length;
      const idleFor = Date.now() - (room.startedAt || 0);
      if (playerCount === 0 && idleFor > 60000) {
        if (room.loopTimer) clearTimeout(room.loopTimer);
        this.rooms.delete(roomId);
        console.log(`[RouletteRoomManager] Cleaned ${roomId}`);
      }
    }
  }
}

module.exports = { RoomManager };
