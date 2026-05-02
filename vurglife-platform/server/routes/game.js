// ============================================
// VURGLIFE — GAME & REWARDS API ROUTES
// ============================================
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { UserDB, TxnDB, NotifDB, FriendDB } = require('../db/database');
const { requireAuth }            = require('../middleware/auth');
const { safeUser }               = require('./auth');
const JWT_SECRET = process.env.JWT_SECRET || 'vurglife_dev_secret_change_in_prod';

// ── SIPSAM TABLE CONFIG ──────────────────────────────────────────────────
const TABLE_CONFIG = {
    100:   { minBet:100,   increment:50,    maxBet:150,   minBank:5000,    walletSize:3000    },
    250:   { minBet:250,   increment:50,    maxBet:500,   minBank:15000,   walletSize:10000   },
    500:   { minBet:500,   increment:100,   maxBet:1000,  minBank:30000,   walletSize:20000   },
    1000:  { minBet:1000,  increment:500,   maxBet:2000,  minBank:60000,   walletSize:40000   },
    10000: { minBet:10000, increment:10000, maxBet:50000, minBank:2000000, walletSize:1000000 }
};

// ── BLACKJACK TABLE CONFIG ──────────────────────────────────────────────
// Standard table: flexible bets. VIP tiers: fixed bets with flat payouts.
const BJ_TABLE_CONFIG = {
    100:   { minBet:100,   maxBet:500,   walletSize:2500,    minBank:2500,    tieBet:100,  tieBetPayout:2000,   blackjackPayout:null,   label:'standard' },
    1000:  { minBet:1000,  maxBet:1000,  walletSize:30000,   minBank:50000,   tieBet:500,  tieBetPayout:10000,  blackjackPayout:5000,   label:'vip' },
    5000:  { minBet:5000,  maxBet:5000,  walletSize:120000,  minBank:150000,  tieBet:1000, tieBetPayout:30000,  blackjackPayout:15000,  label:'vip' },
    10000: { minBet:10000, maxBet:10000, walletSize:240000,  minBank:300000,  tieBet:2000, tieBetPayout:75000,  blackjackPayout:30000,  label:'vip' },
    20000: { minBet:20000, maxBet:20000, walletSize:500000,  minBank:750000,  tieBet:3000, tieBetPayout:125000, blackjackPayout:70000,  label:'vip' },
    50000: { minBet:50000, maxBet:50000, walletSize:1000000, minBank:1500000, tieBet:5000, tieBetPayout:250000, blackjackPayout:170000, label:'vip' },
};

// ── RHUM32 TABLE CONFIG ─────────────────────────────────────────────────
const RHUM32_TABLE_CONFIG = {
    100:   { minBet:100,   maxBet:500,    tieBetMin:50,   tieBetMax:100,   minBank:3000,    walletSize:3000   },
    500:   { minBet:500,   maxBet:3000,   tieBetMin:100,  tieBetMax:500,   minBank:15000,   walletSize:15000  },
    1000:  { minBet:1000,  maxBet:5000,   tieBetMin:500,  tieBetMax:1000,  minBank:25000,   walletSize:25000  },
    5000:  { minBet:5000,  maxBet:10000,  tieBetMin:1000, tieBetMax:5000,  minBank:100000,  walletSize:100000 },
    10000: { minBet:10000, maxBet:100000, tieBetMin:0,    tieBetMax:999999,minBank:1000000, walletSize:500000 }
};

// ── ROULETTE TABLE CONFIG ──────────────────────────────────────────────
// Matches the engine tier ladder in roulette-server/RouletteRoom.js
const ROULETTE_TABLE_CONFIG = {
    100:   { minBet:100,   maxBet:500,     minBank:2500,    walletSize:2500    },
    1000:  { minBet:1000,  maxBet:5000,    minBank:25000,   walletSize:25000   },
    5000:  { minBet:5000,  maxBet:25000,   minBank:120000,  walletSize:120000  },
    10000: { minBet:10000, maxBet:50000,   minBank:250000,  walletSize:250000  },
    50000: { minBet:50000, maxBet:250000,  minBank:1000000, walletSize:1000000 }
};

// ── CHIP PACKAGES ─────────────────────────────────────────────────
const CHIP_PACKAGES = [
    { id:'p1', chips:20000,   usd:1.99  },
    { id:'p2', chips:50000,   usd:3.99  },
    { id:'p3', chips:100000,  usd:5.50  },
    { id:'p4', chips:500000,  usd:9.99  },
    { id:'p5', chips:1000000, usd:15.99 }
];

// ── MILESTONE CONFIG ──────────────────────────────────────────────
const MILESTONES = {
    m50:     { wins:50,  reward:1500,  field:'milestone_50_claimed'  },
    m100:    { wins:100, reward:5000,  field:'milestone_100_claimed' },
    century: { wins:100, reward:2000,  field:'milestone_century_last', repeating:true }
};

// GET /api/game/tables — SipSam tables
router.get('/tables', requireAuth, async (req, res) => {
    const user   = await UserDB.findById(req.userId);
    const tables = Object.entries(TABLE_CONFIG).map(([key, cfg]) => ({
        ...cfg,
        key,
        eligible: user.bank_balance >= cfg.minBank
    }));
    res.json({ ok:true, tables });
});

// GET /api/game/rhum32/tables — Rhum32 tables
router.get('/rhum32/tables', requireAuth, async (req, res) => {
    const user   = await UserDB.findById(req.userId);
    const tables = Object.entries(RHUM32_TABLE_CONFIG).map(([key, cfg]) => ({
        ...cfg,
        key,
        eligible: user.bank_balance >= cfg.minBank
    }));
    res.json({ ok:true, tables });
});

// POST /api/game/rhum32/enter — draw wallet from bank for Rhum32 table
router.post('/rhum32/enter', requireAuth, async (req, res) => {
    const { tableMinBet } = req.body;
    const cfg  = RHUM32_TABLE_CONFIG[tableMinBet];
    if (!cfg)  return res.status(400).json({ error: 'Invalid Rhum32 table' });

    const user = await UserDB.findById(req.userId);
    if (user.bank_balance < cfg.minBank)
        return res.status(403).json({ error: `Need at least $${cfg.minBank.toLocaleString()} in your bank for this table` });
    if (user.bank_balance < cfg.walletSize)
        return res.status(403).json({ error: `Need at least $${cfg.walletSize.toLocaleString()} in your bank to fund wallet` });

    await UserDB.adjustBank(req.userId, -cfg.walletSize);
    await TxnDB.record(req.userId, 'wallet_draw', -cfg.walletSize, null, `Entered Rhum32 $${tableMinBet} table`);

    res.json({
        ok: true,
        walletSize: cfg.walletSize,
        tableConfig: cfg,
        newBankBalance: user.bank_balance - cfg.walletSize
    });
});

// ── BJ wallet session guard ─────────────────────────────────────────────
// In-memory map of active Blackjack wallet sessions: userId → { walletSize, tableMinBet, at }.
// Enter inserts a session (and deducts bank). Exit ONLY credits back if a session
// exists, preventing the "exit credits without a matching enter" bug.
const bjActiveSessions = new Map();
function _bjGetSession(userId)   { return bjActiveSessions.get(userId); }
function _bjSetSession(userId, walletSize, tableMinBet) {
    bjActiveSessions.set(userId, { walletSize, tableMinBet, at: Date.now() });
}
function _bjClearSession(userId) { bjActiveSessions.delete(userId); }

// GET /api/game/bj/tables — Blackjack tables (standard + VIP)
router.get('/bj/tables', requireAuth, async (req, res) => {
    const user   = await UserDB.findById(req.userId);
    const tables = Object.entries(BJ_TABLE_CONFIG).map(([key, cfg]) => ({
        ...cfg,
        key,
        eligible: user.bank_balance >= cfg.minBank
    }));
    res.json({ ok:true, tables });
});

// POST /api/game/bj/enter — draw wallet from bank for Blackjack table
router.post('/bj/enter', requireAuth, async (req, res) => {
    const { tableMinBet } = req.body;
    const cfg  = BJ_TABLE_CONFIG[tableMinBet];
    if (!cfg)  return res.status(400).json({ error: 'Invalid Blackjack table' });

    // Idempotent: if the user already has an active session for the same table,
    // skip the deduction (protects against double-deduct on reconnect/invite flows).
    const existing = _bjGetSession(req.userId);
    if (existing && existing.tableMinBet === Number(tableMinBet)) {
        const user = await UserDB.findById(req.userId);
        return res.json({ ok:true, walletSize: existing.walletSize, tableConfig: cfg,
            newBankBalance: user.bank_balance, reused: true });
    }

    const user = await UserDB.findById(req.userId);
    if (user.bank_balance < cfg.minBank)
        return res.status(403).json({ error: `Need at least $${cfg.minBank.toLocaleString()} in your bank for this table` });
    if (user.bank_balance < cfg.walletSize)
        return res.status(403).json({ error: `Need at least $${cfg.walletSize.toLocaleString()} in your bank to fund wallet` });

    await UserDB.adjustBank(req.userId, -cfg.walletSize);
    await TxnDB.record(req.userId, 'wallet_draw', -cfg.walletSize, null, `Entered Blackjack $${tableMinBet} table`);
    _bjSetSession(req.userId, cfg.walletSize, Number(tableMinBet));

    res.json({
        ok: true,
        walletSize: cfg.walletSize,
        tableConfig: cfg,
        newBankBalance: user.bank_balance - cfg.walletSize
    });
});

// POST /api/game/bj/exit — return remaining Blackjack wallet to bank
router.post('/bj/exit', requireAuth, async (req, res) => {
    const { remainingWallet, tableMinBet } = req.body;
    if (typeof remainingWallet !== 'number' || remainingWallet < 0)
        return res.status(400).json({ error: 'Invalid wallet amount' });

    const session = _bjGetSession(req.userId);
    if (!session) {
        // No active session — refuse to credit. Prevents double-credit if /bj/enter
        // never fired or a duplicate exit is dispatched.
        const user = await UserDB.findById(req.userId);
        return res.json({ ok:true, newBankBalance: user.bank_balance, skipped:'no-session' });
    }

    await UserDB.adjustBank(req.userId, remainingWallet);
    await TxnDB.record(req.userId, 'wallet_return', remainingWallet, null, `Exited Blackjack $${tableMinBet} table`);
    _bjClearSession(req.userId);

    const user = await UserDB.findById(req.userId);
    res.json({ ok:true, newBankBalance: user.bank_balance });
});

// POST /api/game/bj/exit-beacon — navigator.sendBeacon variant for BJ (token in query)
router.post('/bj/exit-beacon', async (req, res) => {
    try {
        const token = req.query?.token;
        if (!token) return res.status(401).end();
        let userId;
        try { userId = jwt.verify(token, JWT_SECRET).userId; }
        catch { return res.status(401).end(); }

        const { remainingWallet, tableMinBet } = req.body || {};
        if (typeof remainingWallet !== 'number' || remainingWallet < 0)
            return res.status(400).end();

        const session = _bjGetSession(userId);
        if (!session) { return res.status(204).end(); }

        await UserDB.adjustBank(userId, remainingWallet);
        await TxnDB.record(userId, 'wallet_return', remainingWallet, null,
            `Exited Blackjack $${tableMinBet} table (beacon)`);
        _bjClearSession(userId);
        res.status(204).end();
    } catch (e) {
        console.error('[bj/exit-beacon] error:', e);
        res.status(500).end();
    }
});

// ── HOLD'EM TABLE CONFIG ─────────────────────────────────────────────────
// Must stay in sync with holdem-server/index.js TABLE_CONFIGS
// and vurglife-platform/client/public/index.html HOLDEM_TABLES.
const HOLDEM_TABLE_CONFIG = {
    10:   { minBet:10,   maxBet:100,   increment:5,   minBank:2000,    walletSize:1000,   maxSeats:6, label:'Micro'         },
    50:   { minBet:50,   maxBet:500,   increment:25,  minBank:8000,    walletSize:5000,   maxSeats:6, label:'Starter'       },
    100:  { minBet:100,  maxBet:1000,  increment:50,  minBank:20000,   walletSize:10000,  maxSeats:9, label:'Standard'      },
    500:  { minBet:500,  maxBet:5000,  increment:250, minBank:75000,   walletSize:50000,  maxSeats:9, label:'High Roller'   },
    1000: { minBet:1000, maxBet:10000, increment:500, minBank:150000,  walletSize:100000, maxSeats:9, label:'VIP Nosebleed' }
};

// Hold'em wallet session guard — same pattern as BJ.
const holdemActiveSessions = new Map();
function _holdemGetSession(userId)   { return holdemActiveSessions.get(userId); }
function _holdemSetSession(userId, walletSize, tableMinBet) {
    holdemActiveSessions.set(userId, { walletSize, tableMinBet, at: Date.now() });
}
function _holdemClearSession(userId) { holdemActiveSessions.delete(userId); }

// GET /api/game/holdem/tables — Hold'em tables with eligibility flag
router.get('/holdem/tables', requireAuth, async (req, res) => {
    const user   = await UserDB.findById(req.userId);
    const tables = Object.entries(HOLDEM_TABLE_CONFIG).map(([key, cfg]) => ({
        ...cfg,
        key,
        eligible: user.bank_balance >= cfg.minBank
    }));
    res.json({ ok:true, tables });
});

// POST /api/game/holdem/enter — draw wallet from bank for Hold'em table
router.post('/holdem/enter', requireAuth, async (req, res) => {
    const { tableMinBet } = req.body;
    const cfg  = HOLDEM_TABLE_CONFIG[tableMinBet];
    if (!cfg)  return res.status(400).json({ error: 'Invalid Hold\'em table' });

    // Idempotent: if the user already has an active session for the same table,
    // skip the deduction (protects against double-deduct on reconnect/invite flows).
    const existing = _holdemGetSession(req.userId);
    if (existing && existing.tableMinBet === Number(tableMinBet)) {
        const user = await UserDB.findById(req.userId);
        return res.json({ ok:true, walletSize: existing.walletSize, tableConfig: cfg,
            newBankBalance: user.bank_balance, reused: true });
    }

    const user = await UserDB.findById(req.userId);
    if (user.bank_balance < cfg.minBank)
        return res.status(403).json({ error: `Need at least $${cfg.minBank.toLocaleString()} in your bank for this table` });
    if (user.bank_balance < cfg.walletSize)
        return res.status(403).json({ error: `Need at least $${cfg.walletSize.toLocaleString()} in your bank to fund wallet` });

    await UserDB.adjustBank(req.userId, -cfg.walletSize);
    await TxnDB.record(req.userId, 'wallet_draw', -cfg.walletSize, null, `Entered Hold'em $${tableMinBet} table`);
    _holdemSetSession(req.userId, cfg.walletSize, Number(tableMinBet));

    res.json({
        ok: true,
        walletSize: cfg.walletSize,
        tableConfig: cfg,
        newBankBalance: user.bank_balance - cfg.walletSize
    });
});

// POST /api/game/holdem/exit — return remaining Hold'em wallet to bank
router.post('/holdem/exit', requireAuth, async (req, res) => {
    const { remainingWallet, tableMinBet } = req.body;
    if (typeof remainingWallet !== 'number' || remainingWallet < 0)
        return res.status(400).json({ error: 'Invalid wallet amount' });

    const session = _holdemGetSession(req.userId);
    if (!session) {
        // No active session — refuse to credit. Prevents double-credit if /holdem/enter
        // never fired or a duplicate exit is dispatched.
        const user = await UserDB.findById(req.userId);
        return res.json({ ok:true, newBankBalance: user.bank_balance, skipped:'no-session' });
    }

    await UserDB.adjustBank(req.userId, remainingWallet);
    await TxnDB.record(req.userId, 'wallet_return', remainingWallet, null, `Exited Hold'em $${tableMinBet} table`);
    _holdemClearSession(req.userId);

    const user = await UserDB.findById(req.userId);
    res.json({ ok:true, newBankBalance: user.bank_balance });
});

// POST /api/game/holdem/exit-beacon — navigator.sendBeacon variant (token in query)
router.post('/holdem/exit-beacon', async (req, res) => {
    try {
        const token = req.query?.token;
        if (!token) return res.status(401).end();
        let userId;
        try { userId = jwt.verify(token, JWT_SECRET).userId; }
        catch { return res.status(401).end(); }

        const { remainingWallet, tableMinBet } = req.body || {};
        if (typeof remainingWallet !== 'number' || remainingWallet < 0)
            return res.status(400).end();

        const session = _holdemGetSession(userId);
        if (!session) { return res.status(204).end(); }

        await UserDB.adjustBank(userId, remainingWallet);
        await TxnDB.record(userId, 'wallet_return', remainingWallet, null,
            `Exited Hold'em $${tableMinBet} table (beacon)`);
        _holdemClearSession(userId);
        res.status(204).end();
    } catch (e) {
        console.error('[holdem/exit-beacon] error:', e);
        res.status(500).end();
    }
});

// ── SipSam wallet session guard ─────────────────────────────────────────
// Same pattern as bjActiveSessions: prevents the wallet from being
// returned multiple times when the client AND the game server AND the
// beacon all call exit on the same session.
const sipsamActiveSessions = new Map();
function _ssGetSession(userId)    { return sipsamActiveSessions.get(userId); }
function _ssSetSession(userId, walletSize, tableMinBet) {
    sipsamActiveSessions.set(userId, { walletSize, tableMinBet, at: Date.now() });
}
function _ssClearSession(userId)  { sipsamActiveSessions.delete(userId); }

// POST /api/game/enter — draw wallet from bank on entering a SipSam table
router.post('/enter', requireAuth, async (req, res) => {
    const { tableMinBet } = req.body;
    const cfg  = TABLE_CONFIG[tableMinBet];
    if (!cfg)  return res.status(400).json({ error: 'Invalid table' });

    // Idempotent: re-entering the same table without exiting just returns OK.
    const existing = _ssGetSession(req.userId);
    if (existing && existing.tableMinBet === Number(tableMinBet)) {
        const user = await UserDB.findById(req.userId);
        return res.json({
            ok: true, walletSize: existing.walletSize, tableConfig: cfg,
            newBankBalance: user.bank_balance, idempotent: true
        });
    }

    const user = await UserDB.findById(req.userId);
    if (user.bank_balance < cfg.minBank)
        return res.status(403).json({ error: `Need at least $${cfg.minBank.toLocaleString()} in your bank for this table` });
    if (user.bank_balance < cfg.walletSize)
        return res.status(403).json({ error: `Need at least $${cfg.walletSize.toLocaleString()} in your bank to fund wallet` });

    // Deduct wallet from bank
    await UserDB.adjustBank(req.userId, -cfg.walletSize);
    await TxnDB.record(req.userId, 'wallet_draw', -cfg.walletSize, null, `Entered $${tableMinBet} table`);
    _ssSetSession(req.userId, cfg.walletSize, Number(tableMinBet));

    res.json({
        ok: true,
        walletSize: cfg.walletSize,
        tableConfig: cfg,
        newBankBalance: user.bank_balance - cfg.walletSize
    });
});

// Recent-credit cooldown: prevents double-credits when both the explicit
// /exit and the beforeunload beacon fire within the same exit. Survives
// platform restarts only by losing the cooldown — but losing the cooldown
// on a fresh process means the FIRST credit wins and there is no in-flight
// double to defend against, so this is safe.
const _ssRecentCredits = new Map(); // userId -> lastCreditAtMs
const _SS_COOLDOWN_MS = 10000;
function _ssRecentlyCredited(userId) {
    const at = _ssRecentCredits.get(userId);
    return !!(at && Date.now() - at < _SS_COOLDOWN_MS);
}
function _ssMarkCredited(userId) { _ssRecentCredits.set(userId, Date.now()); }

// POST /api/game/exit — return remaining wallet chips to bank.
// Always credits when invoked explicitly UNLESS we credited the same user
// in the last 10 seconds (which means the beacon or an earlier call beat
// us to it). This is safer than the previous "no-session" skip, which
// silently dropped the wallet whenever the in-memory session map was
// missing (e.g. after a platform restart mid-game).
router.post('/exit', requireAuth, async (req, res) => {
    const { remainingWallet, tableMinBet } = req.body;
    if (typeof remainingWallet !== 'number' || remainingWallet < 0)
        return res.status(400).json({ error: 'Invalid wallet amount' });

    if (_ssRecentlyCredited(req.userId)) {
        const user = await UserDB.findById(req.userId);
        return res.json({ ok:true, skipped:'recent-credit', newBankBalance: user.bank_balance });
    }

    _ssClearSession(req.userId);
    _ssMarkCredited(req.userId);
    await UserDB.adjustBank(req.userId, remainingWallet);
    await TxnDB.record(req.userId, 'wallet_return', remainingWallet, null, `Exited $${tableMinBet} table`);

    const user = await UserDB.findById(req.userId);
    res.json({ ok:true, newBankBalance: user.bank_balance });
});

// POST /api/game/exit-beacon — beacon-friendly refund (used by beforeunload)
// navigator.sendBeacon cannot set Authorization headers, so the JWT is in the query.
// Body is a Blob containing JSON: { remainingWallet, tableMinBet }
router.post('/exit-beacon', async (req, res) => {
    try {
        const token = req.query?.token;
        if (!token) return res.status(401).end();
        let userId;
        try { userId = jwt.verify(token, JWT_SECRET).userId; }
        catch { return res.status(401).end(); }

        const { remainingWallet, tableMinBet } = req.body || {};
        if (typeof remainingWallet !== 'number' || remainingWallet < 0)
            return res.status(400).end();

        if (_ssRecentlyCredited(userId)) return res.status(204).end();

        _ssClearSession(userId);
        _ssMarkCredited(userId);
        await UserDB.adjustBank(userId, remainingWallet);
        await TxnDB.record(userId, 'wallet_return', remainingWallet, null,
            `Exited $${tableMinBet} table (beacon)`);
        res.status(204).end();
    } catch (e) {
        console.error('[exit-beacon] error:', e);
        res.status(500).end();
    }
});

// POST /api/game/replenish — top up wallet during game (SipSam, Rhum32, or Blackjack)
router.post('/replenish', requireAuth, async (req, res) => {
    const { tableMinBet, currentWallet, game } = req.body;
    const configMap = game === 'rhum32' ? RHUM32_TABLE_CONFIG
                    : game === 'blackjack' ? BJ_TABLE_CONFIG
                    : TABLE_CONFIG;
    const cfg = configMap[tableMinBet];
    if (!cfg)  return res.status(400).json({ error: 'Invalid table' });

    const user   = await UserDB.findById(req.userId);
    const topUp  = cfg.walletSize - currentWallet;
    if (topUp <= 0) return res.status(400).json({ error: 'Wallet already at maximum' });
    if (user.bank_balance < topUp)
        return res.status(400).json({ error: `Need $${topUp.toLocaleString()} in bank to replenish` });

    await UserDB.adjustBank(req.userId, -topUp);
    await TxnDB.record(req.userId, 'wallet_replenish', -topUp, null, `Replenished wallet at $${tableMinBet} table`);

    const updated = await UserDB.findById(req.userId);
    res.json({ ok:true, topUp, newBankBalance: updated.bank_balance, newWallet: cfg.walletSize });
});

// ── ADS ────────────────────────────────────────────────────────────

// GET /api/ads/status — can the user watch ads?
router.get('/media/status', requireAuth, async (req, res) => {
    const user    = await UserDB.findById(req.userId);
    const now     = Math.floor(Date.now() / 1000);
    const oneHour = 3600;
    const cooldownEnds = user.ad_last_session ? user.ad_last_session + oneHour : 0;
    const onCooldown   = now < cooldownEnds;
    res.json({
        ok: true,
        onCooldown,
        cooldownEndsAt: onCooldown ? cooldownEnds : null,
        secondsRemaining: onCooldown ? cooldownEnds - now : 0,
        adsWatchedThisSession: user.ad_session_count
    });
});

// POST /api/ads/watch — record an ad watch, grant chips
router.post('/media/watch', requireAuth, async (req, res) => {
    const { adType } = req.body; // 'reward' | 'pregame' | 'milestone'
    const user  = UserDB.findById(req.userId);
    const now   = Math.floor(Date.now() / 1000);
    const oneHour = 3600;

    if (adType === 'reward') {
        // Check cooldown
        const cooldownEnds = user.ad_last_session ? user.ad_last_session + oneHour : 0;
        if (now < cooldownEnds)
            return res.status(429).json({ error: 'Cooldown active', secondsRemaining: cooldownEnds - now });

        const maxAds = 5;
        if (user.ad_session_count >= maxAds)
            return res.status(400).json({ error: 'Maximum ads watched for this session' });

        const newCount = user.ad_session_count + 1;
        const chips    = 500;

        await UserDB.adjustBank(req.userId, chips);
        await UserDB.updateAdSession(req.userId, newCount >= maxAds ? 0 : newCount);

        // If they hit max, reset and start cooldown
        if (newCount >= maxAds) {
            await UserDB.updateAdSession(req.userId, 0);
        }

        await TxnDB.record(req.userId, 'ad_reward', chips, null, `Ad watch reward (${newCount}/${maxAds})`);

        const updatedUser = UserDB.findById(req.userId);
        return res.json({
            ok:          true,
            chipsEarned: chips,
            adsWatched:  newCount,
            maxAds,
            sessionComplete: newCount >= maxAds,
            newBankBalance:  updatedUser.bank_balance
        });
    }

    // Pre-game or milestone ads — just acknowledge
    res.json({ ok: true, adType });
});

// ── REWARDS / MILESTONES ───────────────────────────────────────────

// POST /api/rewards/check — check and optionally claim milestone
router.get('/rewards/check', requireAuth, async (req, res) => {
    const user      = UserDB.findById(req.userId);
    const available = [];

    // 50 wins
    if (user.total_wins >= 50 && !user.milestone_50_claimed)
        available.push({ id:'m50', label:'50 Wins', reward:1500, adRequired:true });

    // 100 wins
    if (user.total_wins >= 100 && !user.milestone_100_claimed)
        available.push({ id:'m100', label:'100 Wins', reward:5000, adRequired:true });

    // Every 100 thereafter
    const centuryNum = Math.floor(user.total_wins / 100);
    if (user.total_wins >= 200 && centuryNum > user.milestone_century_last)
        available.push({ id:'century', label:`${centuryNum * 100} Wins`, reward:2000, adRequired:true, century:centuryNum });

    res.json({ ok:true, available });
});

// POST /api/rewards/claim — claim after ad watched
router.post('/rewards/claim', requireAuth, async (req, res) => {
    const { milestoneId, centuryNum } = req.body;
    const user = await UserDB.findById(req.userId);
    let chips  = 0;

    if (milestoneId === 'm50') {
        if (user.total_wins < 50 || user.milestone_50_claimed)
            return res.status(400).json({ error: 'Not eligible' });
        chips = 1500;
        await UserDB.updateMilestone(req.userId, 'milestone_50_claimed');
    } else if (milestoneId === 'm100') {
        if (user.total_wins < 100 || user.milestone_100_claimed)
            return res.status(400).json({ error: 'Not eligible' });
        chips = 5000;
        await UserDB.updateMilestone(req.userId, 'milestone_100_claimed');
    } else if (milestoneId === 'century') {
        const cn = centuryNum || Math.floor(user.total_wins / 100);
        if (cn <= user.milestone_century_last)
            return res.status(400).json({ error: 'Already claimed' });
        chips = 2000;
        await UserDB.updateCenturyMilestone(req.userId, cn);
    } else {
        return res.status(400).json({ error: 'Unknown milestone' });
    }

    await UserDB.adjustBank(req.userId, chips);
    await TxnDB.record(req.userId, 'milestone_reward', chips, milestoneId, `Milestone reward: ${milestoneId}`);
    await NotifDB.create(req.userId, 'milestone', `🏆 Milestone reward claimed: +${chips.toLocaleString()} chips!`);

    const updated = UserDB.findById(req.userId);
    res.json({ ok:true, chips, newBankBalance: updated.bank_balance });
});

// ── CHIP PACKAGES ──────────────────────────────────────────────────

// GET /api/store/packages
router.get('/store/packages', (req, res) => {
    res.json({ ok:true, packages: CHIP_PACKAGES });
});

// POST /api/store/purchase/initiate — placeholder for Stripe/PayPal
router.post('/store/purchase/initiate', requireAuth, (req, res) => {
    const { packageId, paymentMethod } = req.body;
    const pkg = CHIP_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: 'Invalid package' });

    // TODO: integrate Stripe/PayPal SDK here
    // For now, return a mock checkout URL
    res.json({
        ok:          true,
        package:     pkg,
        checkoutUrl: `/checkout?pkg=${packageId}&method=${paymentMethod}`,
        message:     'Payment integration coming soon — contact support to purchase chips.'
    });
});

// POST /api/store/purchase/complete — called by payment webhook
router.post('/store/purchase/complete', (req, res) => {
    // TODO: verify webhook signature from Stripe/PayPal
    const { purchaseId, paymentRef } = req.body;
    const { PurchaseDB } = require('../db/database');
    const purchase = PurchaseDB.complete(purchaseId, paymentRef);
    if (!purchase) return res.status(400).json({ error: 'Invalid purchase' });
    NotifDB.create(purchase.user_id, 'purchase', `✅ Purchase complete! +${purchase.chips_amount.toLocaleString()} chips added to your bank.`);
    res.json({ ok:true });
});

// ── WIN RECORDING (called by game server) ─────────────────────────
router.post('/game/record-win', requireAuth, async (req, res) => {
    const { isWin, payout, roomId, tableMinBet } = req.body;
    if (isWin) await UserDB.incrementWins(req.userId);
    else await UserDB.incrementGames(req.userId);

    // Game winner reward check — called separately by game room
    res.json({ ok:true });
});

// ── ADS ────────────────────────────────────────────────────────────

// GET /api/ads/status — can the user watch ads?
router.get('/media/status', requireAuth, async (req, res) => {
    const user    = await UserDB.findById(req.userId);
    const now     = Math.floor(Date.now() / 1000);
    const oneHour = 3600;
    const cooldownEnds = user.ad_last_session ? user.ad_last_session + oneHour : 0;
    const onCooldown   = now < cooldownEnds;
    res.json({
        ok: true,
        onCooldown,
        cooldownEndsAt: onCooldown ? cooldownEnds : null,
        secondsRemaining: onCooldown ? cooldownEnds - now : 0,
        adsWatchedThisSession: user.ad_session_count
    });
});

// POST /api/ads/watch — record an ad watch, grant chips
router.post('/media/watch', requireAuth, async (req, res) => {
    const { adType } = req.body; // 'reward' | 'pregame' | 'milestone'
    const user  = UserDB.findById(req.userId);
    const now   = Math.floor(Date.now() / 1000);
    const oneHour = 3600;

    if (adType === 'reward') {
        // Check cooldown
        const cooldownEnds = user.ad_last_session ? user.ad_last_session + oneHour : 0;
        if (now < cooldownEnds)
            return res.status(429).json({ error: 'Cooldown active', secondsRemaining: cooldownEnds - now });

        const maxAds = 5;
        if (user.ad_session_count >= maxAds)
            return res.status(400).json({ error: 'Maximum ads watched for this session' });

        const newCount = user.ad_session_count + 1;
        const chips    = 500;

        await UserDB.adjustBank(req.userId, chips);
        await UserDB.updateAdSession(req.userId, newCount >= maxAds ? 0 : newCount);

        // If they hit max, reset and start cooldown
        if (newCount >= maxAds) {
            await UserDB.updateAdSession(req.userId, 0);
        }

        await TxnDB.record(req.userId, 'ad_reward', chips, null, `Ad watch reward (${newCount}/${maxAds})`);

        const updatedUser = UserDB.findById(req.userId);
        return res.json({
            ok:          true,
            chipsEarned: chips,
            adsWatched:  newCount,
            maxAds,
            sessionComplete: newCount >= maxAds,
            newBankBalance:  updatedUser.bank_balance
        });
    }

    // Pre-game or milestone ads — just acknowledge
    res.json({ ok: true, adType });
});

// ── REWARDS / MILESTONES ───────────────────────────────────────────

// POST /api/rewards/check — check and optionally claim milestone
router.get('/rewards/check', requireAuth, async (req, res) => {
    const user      = UserDB.findById(req.userId);
    const available = [];

    // 50 wins
    if (user.total_wins >= 50 && !user.milestone_50_claimed)
        available.push({ id:'m50', label:'50 Wins', reward:1500, adRequired:true });

    // 100 wins
    if (user.total_wins >= 100 && !user.milestone_100_claimed)
        available.push({ id:'m100', label:'100 Wins', reward:5000, adRequired:true });

    // Every 100 thereafter
    const centuryNum = Math.floor(user.total_wins / 100);
    if (user.total_wins >= 200 && centuryNum > user.milestone_century_last)
        available.push({ id:'century', label:`${centuryNum * 100} Wins`, reward:2000, adRequired:true, century:centuryNum });

    res.json({ ok:true, available });
});

// POST /api/rewards/claim — claim after ad watched
router.post('/rewards/claim', requireAuth, async (req, res) => {
    const { milestoneId, centuryNum } = req.body;
    const user = await UserDB.findById(req.userId);
    let chips  = 0;

    if (milestoneId === 'm50') {
        if (user.total_wins < 50 || user.milestone_50_claimed)
            return res.status(400).json({ error: 'Not eligible' });
        chips = 1500;
        await UserDB.updateMilestone(req.userId, 'milestone_50_claimed');
    } else if (milestoneId === 'm100') {
        if (user.total_wins < 100 || user.milestone_100_claimed)
            return res.status(400).json({ error: 'Not eligible' });
        chips = 5000;
        await UserDB.updateMilestone(req.userId, 'milestone_100_claimed');
    } else if (milestoneId === 'century') {
        const cn = centuryNum || Math.floor(user.total_wins / 100);
        if (cn <= user.milestone_century_last)
            return res.status(400).json({ error: 'Already claimed' });
        chips = 2000;
        await UserDB.updateCenturyMilestone(req.userId, cn);
    } else {
        return res.status(400).json({ error: 'Unknown milestone' });
    }

    await UserDB.adjustBank(req.userId, chips);
    await TxnDB.record(req.userId, 'milestone_reward', chips, milestoneId, `Milestone reward: ${milestoneId}`);
    await NotifDB.create(req.userId, 'milestone', `🏆 Milestone reward claimed: +${chips.toLocaleString()} chips!`);

    const updated = UserDB.findById(req.userId);
    res.json({ ok:true, chips, newBankBalance: updated.bank_balance });
});

// ── CHIP PACKAGES ──────────────────────────────────────────────────

// GET /api/store/packages
router.get('/store/packages', (req, res) => {
    res.json({ ok:true, packages: CHIP_PACKAGES });
});

// POST /api/store/purchase/initiate — placeholder for Stripe/PayPal
router.post('/store/purchase/initiate', requireAuth, (req, res) => {
    const { packageId, paymentMethod } = req.body;
    const pkg = CHIP_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: 'Invalid package' });

    // TODO: integrate Stripe/PayPal SDK here
    // For now, return a mock checkout URL
    res.json({
        ok:          true,
        package:     pkg,
        checkoutUrl: `/checkout?pkg=${packageId}&method=${paymentMethod}`,
        message:     'Payment integration coming soon — contact support to purchase chips.'
    });
});

// POST /api/store/purchase/complete — called by payment webhook
router.post('/store/purchase/complete', (req, res) => {
    // TODO: verify webhook signature from Stripe/PayPal
    const { purchaseId, paymentRef } = req.body;
    const { PurchaseDB } = require('../db/database');
    const purchase = PurchaseDB.complete(purchaseId, paymentRef);
    if (!purchase) return res.status(400).json({ error: 'Invalid purchase' });
    NotifDB.create(purchase.user_id, 'purchase', `✅ Purchase complete! +${purchase.chips_amount.toLocaleString()} chips added to your bank.`);
    res.json({ ok:true });
});

// ── WIN RECORDING (called by game server) ─────────────────────────
router.post('/game/record-win', requireAuth, async (req, res) => {
    const { isWin, payout, roomId, tableMinBet } = req.body;
    if (isWin) await UserDB.incrementWins(req.userId);
    else await UserDB.incrementGames(req.userId);

    // Game winner reward check — called separately by game room
    res.json({ ok:true });
});

module.exports = router;
module.exports.TABLE_CONFIG = TABLE_CONFIG;
module.exports.RHUM32_TABLE_CONFIG = RHUM32_TABLE_CONFIG;
module.exports.BJ_TABLE_CONFIG = BJ_TABLE_CONFIG;
