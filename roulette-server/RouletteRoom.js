'use strict';

// ─────────────────────────────────────────────────────────────
// VurgLife Roulette — RouletteRoom.js
// One room = one wheel running a continuous bet → spin → resolve loop.
// Current product release exposes American roulette. European engine support is
// retained for a later table build.
// ─────────────────────────────────────────────────────────────

const engine = require('./engine');
const http = require('http');

function callPlatformAPI(path, token, body) {
  return new Promise((resolve) => {
    if (!token) return resolve({ ok: false, error: 'no token' });
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Bearer ' + token,
        'X-Game-Server': 'roulette',
        'X-Game-Server-Secret': process.env.GAME_SERVER_SECRET || 'vurglife_local_game_server_secret',
      },
    };

    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw || '{}')); }
        catch { resolve({ ok: false, error: raw || ('HTTP ' + res.statusCode) }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.write(payload);
    req.end();
  });
}

// Tier config. Keyed by minBet. walletSize = default wallet draw on enter.
// maxBet is the per-bet cap, not the total-stake cap (that's walletSize).
const TABLE_CONFIG = {
  100: {
    minBet:     100,
    maxBet:     500,
    walletSize: 2500,
    minBank:    2500,
    label:      'standard',
  },
  1000: {
    minBet:     1000,
    maxBet:     5000,
    walletSize: 25000,
    minBank:    25000,
    label:      'vip',
  },
  5000: {
    minBet:     5000,
    maxBet:     25000,
    walletSize: 120000,
    minBank:    120000,
    label:      'vip',
  },
  10000: {
    minBet:     10000,
    maxBet:     50000,
    walletSize: 250000,
    minBank:    250000,
    label:      'vip',
  },
  50000: {
    minBet:     50000,
    maxBet:     250000,
    walletSize: 1000000,
    minBank:    1000000,
    label:      'vip',
  },
};

// Timing (seconds). The betting window gives players time to use table or wheel bets.
const BETTING_SECONDS   = 40;
const SPINNING_SECONDS  = 8;
const RESOLVING_SECONDS = 5;

const MAX_PLAYERS = 6;

class RouletteRoom {
  constructor({ roomId, variant, tableMinBet, mode }) {
    this.roomId   = roomId;
    this.variant  = 'american';
    this.mode     = mode === 'single' ? 'single' : 'multiplayer';
    this.cfg      = TABLE_CONFIG[tableMinBet] || TABLE_CONFIG[100];
    this.tableMinBet = this.cfg.minBet;

    this.clients = [];             // [{ sessionId, userId, username, send }]
    this.players = {};             // sessionId → { sessionId, username, wallet, bets, lastPayout }
    this.history = [];             // last N winning numbers (for display)
    this.historyMax = 20;

    this.phase     = 'waiting';    // 'waiting' | 'betting' | 'spinning' | 'resolving'
    this.phaseEnd  = 0;            // epoch ms when current phase ends
    this.winning   = null;         // last winning pocket
    this.round     = 0;
    this.loopTimer = null;
    this.startedAt = Date.now();
  }

  // ── LIFECYCLE ──────────────────────────────────────────────

  onJoin(client, { username, wallet, userId, token }) {
    this.players[client.sessionId] = {
      sessionId:  client.sessionId,
      userId,
      username:   username || 'Player',
      wallet:     Number(wallet) || this.cfg.walletSize,
      token:      token || null,
      bankSettled:false,
      bets:       [],
      lastPayout: null,
      lastNet:    0,
    };
    this.broadcastState(`${username} joined`);

    // Kick off the loop on first join.
    if (this.phase === 'waiting') {
      this.startRound();
    }
  }

  onLeave(client) {
    const p = this.players[client.sessionId];
    if (!p) return;
    this._settlePlayerBank(p, 'disconnect');
    delete this.players[client.sessionId];
    this.broadcastState(`${p.username} left`);

    // If the room has emptied, pause the loop. RoomManager cleanup will reap.
    if (Object.keys(this.players).length === 0) {
      this.phase = 'waiting';
      if (this.loopTimer) {
        clearTimeout(this.loopTimer);
        this.loopTimer = null;
      }
    }
  }

  findClient(sessionId) {
    return this.clients.find((c) => c.sessionId === sessionId) || null;
  }

  // ── PHASE LOOP ─────────────────────────────────────────────
  // betting → spinning → resolving → betting …

  startRound() {
    this.round += 1;
    this.phase  = 'betting';
    this.phaseEnd = Date.now() + BETTING_SECONDS * 1000;
    this.winning = null;
    // Clear prior-round bets from any players still at the table.
    for (const p of Object.values(this.players)) {
      p.bets = [];
      p.lastPayout = null;
      p.lastNet    = 0;
    }
    this.broadcastState(`Place your bets — Round ${this.round}`);
    this.loopTimer = setTimeout(() => this.spin(), BETTING_SECONDS * 1000);
  }

  spin() {
    if (Object.keys(this.players).length === 0) {
      this.phase = 'waiting';
      return;
    }
    this.phase    = 'spinning';
    const previousPocket = this.history[0]?.pocket;
    this.winning  = engine.spin(this.variant, previousPocket);
    this.phaseEnd = Date.now() + SPINNING_SECONDS * 1000;
    // Show animation client-side. Winning number is already chosen.
    this.broadcast({
      type: 'spin',
      winning: this.winning,
      color:   engine.colorOf(this.winning),
      phaseEnd: this.phaseEnd,
      round:   this.round,
    });
    this.loopTimer = setTimeout(() => this.resolve(), SPINNING_SECONDS * 1000);
  }

  resolve() {
    this.phase    = 'resolving';
    this.phaseEnd = Date.now() + RESOLVING_SECONDS * 1000;

    const results = {};
    let tableTopPayoutMultiple = 0;
    let tableTopPlayer = null;

    for (const p of Object.values(this.players)) {
      const r = engine.resolveBets(p.bets, this.winning, this.variant);
      const totalPayout = r.reduce((s, x) => s + x.payout, 0);
      const totalStake  = r.reduce((s, x) => s + x.amount, 0);
      p.wallet     += totalPayout; // payout already includes original on win
      p.wallet     -= totalStake;  // subtract everything that was wagered
      p.lastPayout = totalPayout;
      p.lastNet    = totalPayout - totalStake;
      results[p.sessionId] = {
        bets: r,
        totalPayout,
        totalStake,
        net: p.lastNet,
        wallet: p.wallet,
      };
      // Any single-bet multiplier ≥ 35× (straight hit) or net ≥ 50× minBet? Announce.
      if (p.lastNet > 0) {
        const mult = Math.floor(p.lastNet / this.cfg.minBet);
        if (mult > tableTopPayoutMultiple) {
          tableTopPayoutMultiple = mult;
          tableTopPlayer = p;
        }
      }
    }

    this.history.unshift({ pocket: this.winning, color: engine.colorOf(this.winning) });
    if (this.history.length > this.historyMax) this.history.length = this.historyMax;

    this.broadcast({
      type: 'resolve',
      winning: this.winning,
      color:   engine.colorOf(this.winning),
      results,
      history: this.history,
      phaseEnd: this.phaseEnd,
    });

    // Big announcement for a standout table win.
    if (tableTopPayoutMultiple >= 35 && tableTopPlayer) {
      const msg = `${tableTopPlayer.username} hit ${this.winning} — +$${tableTopPlayer.lastNet.toLocaleString()}!`;
      this.broadcast({ type: 'bigAnnouncement', text: msg, duration: 4000 });
    }

    this.loopTimer = setTimeout(() => {
      // If everyone's broke, pause.
      const anyCanBet = Object.values(this.players).some((p) => p.wallet >= this.cfg.minBet);
      if (!anyCanBet && Object.keys(this.players).length > 0) {
        this.phase = 'waiting';
        this.broadcastState('Waiting — replenish wallet to continue');
        return;
      }
      if (Object.keys(this.players).length === 0) {
        this.phase = 'waiting';
        return;
      }
      this.startRound();
    }, RESOLVING_SECONDS * 1000);
  }

  // ── MESSAGE HANDLERS ───────────────────────────────────────

  _dispatchMessage(type, client, data) {
    const fn = this.handlers[type];
    if (fn) fn.call(this, client, data);
  }

  get handlers() {
    return {
      placeBet:   this.onPlaceBet,
      clearBets:  this.onClearBets,
      undoBet:    this.onUndoBet,
      replenish:  this.onReplenishWallet,
      replenishWallet: this.onReplenishWallet,
      chat:       this.onChat,
      ping:       (client) => client.send(JSON.stringify({ type: 'pong' })),
    };
  }

  onPlaceBet(client, data) {
    const p = this.players[client.sessionId];
    if (!p) return;
    if (this.phase !== 'betting') {
      return this._err(client, 'Betting is closed');
    }
    let norm;
    try {
      if (!data || !data.bet) throw new Error('Invalid bet');
      norm = engine.normalizeBet(data.bet, this.variant);
    } catch (e) {
      return this._err(client, e.message);
    }
    const amount = Number(data.bet.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return this._err(client, 'Invalid bet amount');
    }
    if (amount < this.cfg.minBet) {
      return this._err(client, `Minimum bet is $${this.cfg.minBet}`);
    }
    if (amount > this.cfg.maxBet) {
      return this._err(client, `Maximum bet is $${this.cfg.maxBet}`);
    }
    const staked = p.bets.reduce((s, b) => s + b.amount, 0);
    if (staked + amount > p.wallet) {
      return this._err(client, 'Insufficient wallet');
    }
    p.bets.push({ ...norm, amount });
    this.broadcastState();
  }

  onUndoBet(client) {
    const p = this.players[client.sessionId];
    if (!p) return;
    if (this.phase !== 'betting') return;
    p.bets.pop();
    this.broadcastState();
  }

  onClearBets(client) {
    const p = this.players[client.sessionId];
    if (!p) return;
    if (this.phase !== 'betting') return;
    p.bets = [];
    this.broadcastState();
  }

  async onReplenishWallet(client, data) {
    const p = this.players[client.sessionId];
    if (!p) return;
    if (!p.token) {
      return client.send(JSON.stringify({ type: 'replenishResult', ok: false, error: 'Not authorised' }));
    }

    const amount = Math.max(0, Math.floor(Number(data?.amount) || 0));
    const res = await callPlatformAPI('/api/game/replenish', p.token, {
      game: 'roulette',
      amount,
      currentWallet: p.wallet,
      tableMinBet: this.tableMinBet,
    });

    if (!res || !res.ok) {
      return client.send(JSON.stringify({
        type: 'replenishResult',
        ok: false,
        error: (res && res.error) || 'Replenish failed',
      }));
    }

    const added = Math.max(0, Math.floor(Number(res.topUp) || 0));
    p.wallet += added;
    client.send(JSON.stringify({
      type: 'replenishResult',
      ok: true,
      added,
      newWallet: p.wallet,
      newBankBalance: res.newBankBalance,
    }));
    this.broadcastState();

    if (this.phase === 'waiting' && Object.keys(this.players).length > 0) {
      this.startRound();
    }
  }

  onChat(client, data) {
    const p = this.players[client.sessionId];
    if (!p) return;
    const text = String(data?.text || '').slice(0, 200);
    if (!text) return;
    this.broadcast({
      type: 'chat',
      from: p.username,
      text,
      t: Date.now(),
    });
  }

  // ── BROADCAST HELPERS ──────────────────────────────────────

  broadcast(obj) {
    const json = JSON.stringify(obj);
    for (const c of this.clients) c.send(json);
  }

  broadcastState(message) {
    const payload = {
      type:        'state',
      roomId:      this.roomId,
      variant:     this.variant,
      mode:        this.mode,
      cfg:         this.cfg,
      phase:       this.phase,
      phaseEnd:    this.phaseEnd,
      round:       this.round,
      winning:     this.winning,
      history:     this.history,
      players:     this._publicPlayers(),
      message:     message || '',
      now:         Date.now(),
    };
    this.broadcast(payload);
  }

  _publicPlayers() {
    const out = {};
    for (const [sid, p] of Object.entries(this.players)) {
      out[sid] = {
        sessionId:  sid,
        username:   p.username,
        wallet:     p.wallet,
        bets:       p.bets,
        lastPayout: p.lastPayout,
        lastNet:    p.lastNet,
      };
    }
    return out;
  }

  _err(client, msg) {
    client.send(JSON.stringify({ type: 'error', message: msg }));
  }

  async _settlePlayerBank(player, reason) {
    if (!player || player.bankSettled || !player.token) return;
    player.bankSettled = true;
    const lockedStake = this.phase === 'spinning'
      ? player.bets.reduce((sum, bet) => sum + (Number(bet.amount) || 0), 0)
      : 0;
    const res = await callPlatformAPI('/api/game/roulette/exit', player.token, {
      remainingWallet: Math.max(0, Math.floor((Number(player.wallet) || 0) - lockedStake)),
      tableMinBet: this.tableMinBet,
      reason,
    });
    if (!res || !res.ok) {
      console.error(`[Roulette] wallet settlement failed for ${player.username}:`, res && res.error);
    }
  }
}

RouletteRoom.TABLE_CONFIG = TABLE_CONFIG;
RouletteRoom.MAX_PLAYERS  = MAX_PLAYERS;

module.exports = RouletteRoom;
module.exports.TABLE_CONFIG = TABLE_CONFIG;
module.exports.MAX_PLAYERS  = MAX_PLAYERS;
module.exports.BETTING_SECONDS   = BETTING_SECONDS;
module.exports.SPINNING_SECONDS  = SPINNING_SECONDS;
module.exports.RESOLVING_SECONDS = RESOLVING_SECONDS;
