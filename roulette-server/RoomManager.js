'use strict';

// ─────────────────────────────────────────────────────────────
// VurgLife Roulette — RoomManager.js
// Room map keyed by roomId. Current product release quick-joins American rooms.
// Single-player rooms are always private (never surfaced to joinOrCreate).
// ─────────────────────────────────────────────────────────────

const RouletteRoom = require('./RouletteRoom');

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.counter = 0;
  }

  createRoom(variant, tableMinBet, mode) {
    const v = 'american';
    const m = mode === 'single' ? 'single' : 'multiplayer';
    const roomId = `rlt_${v}_${tableMinBet}_${++this.counter}_${Date.now()}`;
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
      if (tableMinBet && room.tableMinBet !== tableMinBet) continue;
      if (room.mode === 'single') continue;
      const playerCount = Object.keys(room.players).length;
      if (playerCount >= RouletteRoom.MAX_PLAYERS) continue;
      out.push({
        roomId,
        variant: room.variant,
        tableMinBet: room.tableMinBet,
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
    const available = this.listRooms(v, tableMinBet);
    if (available.length > 0) {
      // Prefer rooms that aren't already spinning.
      const betting = available.find((r) => r.phase === 'betting' || r.phase === 'waiting');
      const pick = betting || available[0];
      return { roomId: pick.roomId, room: this.rooms.get(pick.roomId), created: false };
    }
    const { roomId, room } = this.createRoom(v, tableMinBet, 'multiplayer');
    return { roomId, room, created: true };
  }

  cleanup() {
    for (const [roomId, room] of this.rooms) {
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
