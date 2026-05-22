// ============================================
// VURGLIFE — GAME & REWARDS API ROUTES
// ============================================
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { UserDB, TxnDB, NotifDB, FriendDB } = require('../db/database');
const { requireAuth }            = require('../middleware/auth');
const { safeUser }               = require('./auth');
const JWT_SECRET = process.env.JWT_SECRET || 'vurglife_jwt_secret_change_in_prod';
const GAME_SERVER_SECRET = process.env.GAME_SERVER_SECRET || 'vurglife_local_game_server_secret';

// ── SIPSAM TABLE CONFIG ──────────────────────────────────────────────────
// Single source of truth — see shared/sipsam-tables.js + ARCHITECTURE.md §3.
const TABLE_CONFIG = require('../../../shared/sipsam-tables.js');

// ── BLACKJACK TABLE CONFIG ──────────────────────────────────────────────
// Blackjack tables use fixed main bets. Optional wager is Tie Bet only.
const BJ_TABLE_CONFIG = {
    100:   { minBet:100,   maxBet:100,   walletSize:2500,    minBank:2500,    tieBet:100,  tieBetPayout:2000,   blackjackPayout:null,   label:'standard' },
    500:   { minBet:500,   maxBet:500,   walletSize:15000,   minBank:15000,   tieBet:250,  tieBetPayout:5000,   blackjackPayout:null,   label:'standard' },
    1000:  { minBet:1000,  maxBet:1000,  walletSize:30000,   minBank:50000,   tieBet:500,  tieBetPayout:10000,  blackjackPayout:null,   label:'standard' },
    50000: { minBet:50000, maxBet:50000, walletSize:1000000, minBank:1500000, tieBet:5000, tieBetPayout:250000, blackjackPayout:170000, label:'vip' },
    100000:{ minBet:100000,maxBet:100000,walletSize:5000000, minBank:7000000, tieBet:10000,tieBetPayout:500000, blackjackPayout:350000, label:'elite' },
    500000:{ minBet:500000,maxBet:500000,walletSize:7000000, minBank:10000000,tieBet:25000,tieBetPayout:1000000,blackjackPayout:1000000,label:'celestial' },
};

// ── RHUM32 TABLE CONFIG ─────────────────────────────────────────────────
// Six tiers per Table 1 (May 2026). VIP/Elite/Celestial are the fancy rooms.
const RHUM32_TABLE_CONFIG = {
    100:    { minBet:100,    maxBet:500,    tieBetMin:50,    tieBetMax:100,    frontInc:50,    tieInc:50,    minBank:3000,     walletSize:3000     },
    500:    { minBet:500,    maxBet:3000,   tieBetMin:100,   tieBetMax:500,    frontInc:500,   tieInc:100,   minBank:15000,    walletSize:15000    },
    1000:   { minBet:1000,   maxBet:5000,   tieBetMin:500,   tieBetMax:1000,   frontInc:1000,  tieInc:100,   minBank:25000,    walletSize:25000    },
    10000:  { minBet:10000,  maxBet:100000, tieBetMin:5000,  tieBetMax:10000,  frontInc:10000, tieInc:1000,  minBank:1000000,  walletSize:1000000  },
    100000: { minBet:100000, maxBet:500000, tieBetMin:50000, tieBetMax:100000, frontInc:50000, tieInc:10000, minBank:7000000,  walletSize:5000000  },
    250000: { minBet:250000, maxBet:1000000,tieBetMin:100000,tieBetMax:300000, frontInc:150000,tieInc:50000, minBank:10000000, walletSize:7000000  }
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
// Platform-wide wallet session guard. A wallet can only return to bank when
// there is a matching wallet_draw, and each active wallet returns once.
const walletActiveSessions = new Map(); // `${game}:${userId}` -> { walletSize, tableMinBet, at }
const walletRecentCredits  = new Map(); // `${game}:${userId}` -> { at, amount }
const walletExitLocks      = new Map();
const WALLET_CREDIT_COOLDOWN_MS = 60000;

function _walletKey(game, userId) {
    return `${game || 'sipsam'}:${userId}`;
}
function _walletGetSession(game, userId) {
    return walletActiveSessions.get(_walletKey(game, userId));
}
function _walletSetSession(game, userId, walletSize, tableMinBet) {
    walletActiveSessions.set(_walletKey(game, userId), {
        walletSize: Math.max(0, Math.floor(Number(walletSize) || 0)),
        tableMinBet: Number(tableMinBet),
        at: Date.now()
    });
}
function _walletClearSession(game, userId) {
    walletActiveSessions.delete(_walletKey(game, userId));
}
function _walletRecentCredit(game, userId) {
    const key = _walletKey(game, userId);
    const rec = walletRecentCredits.get(key);
    if (!rec) return null;
    if (Date.now() - rec.at >= WALLET_CREDIT_COOLDOWN_MS) {
        walletRecentCredits.delete(key);
        return null;
    }
    return rec;
}
function _walletMarkCredited(game, userId, amount) {
    walletRecentCredits.set(_walletKey(game, userId), {
        at: Date.now(),
        amount: Math.max(0, Math.floor(Number(amount) || 0))
    });
}
function _walletClearRecent(game, userId) {
    walletRecentCredits.delete(_walletKey(game, userId));
}
async function _walletWithExitLock(game, userId, fn) {
    const key = _walletKey(game, userId);
    const previous = walletExitLocks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const cleanup = run.finally(() => {
        if (walletExitLocks.get(key) === cleanup) walletExitLocks.delete(key);
    });
    walletExitLocks.set(key, cleanup);
    return run;
}
async function _walletFindUnsettledDraw(game, userId) {
    try {
        let last = null;
        if (TxnDB.lastByTypesAndRef) {
            last = await TxnDB.lastByTypesAndRef(userId, ['wallet_draw','wallet_return'], game);
        }
        if (last && last.type === 'wallet_draw') return last;

        // Legacy fallback for older transactions that did not store game in reference.
        last = await TxnDB.lastByTypes(userId, ['wallet_draw','wallet_return']);
        if (last && last.type === 'wallet_draw' && (!last.reference || last.reference === game)) return last;
    } catch(e) {}
    return null;
}
async function _walletEnter(game, userId, tableMinBet, cfg, description) {
    const numericTable = Number(tableMinBet);
    const existing = _walletGetSession(game, userId);
    if (existing && existing.tableMinBet === numericTable) {
        const user = await UserDB.findById(userId);
        return {
            ok: true,
            walletSize: existing.walletSize,
            tableConfig: cfg,
            newBankBalance: user.bank_balance,
            idempotent: true
        };
    }
    if (existing) {
        return { status:409, error:'You already have an active wallet session. Exit that table before entering another.' };
    }

    const user = await UserDB.findById(userId);
    if (user.bank_balance < cfg.minBank) {
        return { status:403, error:`Need at least $${cfg.minBank.toLocaleString()} in your bank for this table` };
    }
    if (user.bank_balance < cfg.walletSize) {
        return { status:403, error:`Need at least $${cfg.walletSize.toLocaleString()} in your bank to fund wallet` };
    }

    await UserDB.adjustBank(userId, -cfg.walletSize);
    await TxnDB.record(userId, 'wallet_draw', -cfg.walletSize, game, description);
    _walletClearRecent(game, userId);
    _walletSetSession(game, userId, cfg.walletSize, numericTable);

    return {
        ok: true,
        walletSize: cfg.walletSize,
        tableConfig: cfg,
        newBankBalance: user.bank_balance - cfg.walletSize
    };
}
async function _walletExit(game, userId, remainingWallet, tableMinBet, trusted, sourceLabel) {
    const requested = Math.max(0, Math.floor(Number(remainingWallet) || 0));
    const recent = _walletRecentCredit(game, userId);
    if (recent) {
        if (trusted && requested !== recent.amount) {
            const delta = requested - recent.amount;
            await UserDB.adjustBank(userId, delta);
            await TxnDB.record(userId, 'wallet_return', delta, game,
                `${game} server wallet reconciliation at $${tableMinBet} table (${sourceLabel || 'server'})`);
            _walletMarkCredited(game, userId, requested);
            const user = await UserDB.findById(userId);
            return { ok:true, reconciled:true, returned:delta, totalReturned:requested, newBankBalance:user.bank_balance };
        }
        const user = await UserDB.findById(userId);
        return { ok:true, skipped:'recent-credit', credited:recent.amount, newBankBalance:user.bank_balance };
    }

    const session = _walletGetSession(game, userId);
    _walletClearSession(game, userId);

    let allowedCeiling = 0;
    if (session) {
        allowedCeiling = session.walletSize;
    } else {
        const unsettled = await _walletFindUnsettledDraw(game, userId);
        if (!unsettled) {
            console.warn(`[WALLET EXIT] ${game}:${userId} called exit with no session and no unsettled draw - refusing to credit`);
            const user = await UserDB.findById(userId);
            return { ok:true, skipped:'no-draw', newBankBalance:user.bank_balance };
        }
        allowedCeiling = Math.abs(unsettled.amount);
    }

    // Active sessions trust the game's current wallet value. Fallback exits
    // after a restart are capped because no server state remains to verify
    // winnings above the original wallet.
    const credit = (session || trusted) ? requested : Math.min(requested, allowedCeiling);
    if (!session && !trusted && credit !== requested) {
        console.warn(`[WALLET EXIT] ${game}:${userId} claimed $${requested} but ceiling is $${allowedCeiling} - capping fallback credit`);
    }

    await UserDB.adjustBank(userId, credit);
    await TxnDB.record(userId, 'wallet_return', credit, game,
        `Exited ${game} $${tableMinBet} table${trusted ? ' (server settled)' : sourceLabel ? ' (' + sourceLabel + ')' : ''}`);
    _walletMarkCredited(game, userId, credit);

    const user = await UserDB.findById(userId);
    return { ok:true, returned:credit, trusted, newBankBalance:user.bank_balance };
}
function _legacyExitGameFor(userId) {
    if (_walletGetSession('sipsam', userId)) return 'sipsam';
    for (const game of ['rhum32', 'roulette', 'blackjack', 'holdem']) {
        if (_walletGetSession(game, userId)) return game;
    }
    return 'sipsam';
}

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

// GET /api/game/balance — bank balance + computed tier (used by in-game UI)
router.get('/balance', requireAuth, async (req, res) => {
    const user  = await UserDB.findById(req.userId);
    const { computeTier } = require('../lib/tiers');
    const t = computeTier(user.bank_balance);
    res.json({
        ok: true,
        user: {
            id:           user.id,
            username:     user.username,
            bankBalance:  user.bank_balance,
            bank_balance: user.bank_balance,   // legacy alias
            tier:         t ? t.name  : null,
            tierEmoji:    t ? t.emoji : null,
            tierColor:    t ? t.color : null,
        }
    });
});

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

    const result = await _walletEnter('rhum32', req.userId, tableMinBet, cfg,
        `Entered Rhum32 $${tableMinBet} table`);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error || 'Entry failed' });
    res.json(result);
});

// POST /api/game/rhum32/exit - return remaining Rhum32 wallet to bank
router.post('/rhum32/exit', requireAuth, async (req, res) => {
    const { remainingWallet, tableMinBet } = req.body;
    if (!Number.isFinite(remainingWallet) || remainingWallet < 0)
        return res.status(400).json({ error: 'Invalid wallet amount' });

    try {
        const result = await _walletWithExitLock('rhum32', req.userId, () =>
            _walletExit('rhum32', req.userId, remainingWallet, tableMinBet, _isTrustedGameServer(req), req.body?.reason)
        );
        res.json(result);
    } catch(e) {
        console.error('[rhum32/exit] error:', e);
        res.status(500).json({ error:'Exit settlement failed' });
    }
});

router.post('/rhum32/exit-beacon', async (req, res) => {
    try {
        const token = req.query?.token;
        if (!token) return res.status(401).end();
        let userId;
        try { userId = jwt.verify(token, JWT_SECRET).userId; }
        catch { return res.status(401).end(); }

        const { remainingWallet, tableMinBet } = req.body || {};
        if (!Number.isFinite(remainingWallet) || remainingWallet < 0)
            return res.status(400).end();

        await _walletWithExitLock('rhum32', userId, () =>
            _walletExit('rhum32', userId, remainingWallet, tableMinBet, false, 'beacon')
        );
        res.status(204).end();
    } catch(e) {
        console.error('[rhum32/exit-beacon] error:', e);
        res.status(500).end();
    }
});

// ── BJ wallet session guard ─────────────────────────────────────────────
// In-memory map of active Blackjack wallet sessions: userId → { walletSize, tableMinBet, at }.
// Enter inserts a session (and deducts bank). Exit ONLY credits back if a session
// exists, preventing the "exit credits without a matching enter" bug.
// GET /api/game/roulette/tables - Roulette tables
router.get('/roulette/tables', requireAuth, async (req, res) => {
    const user   = await UserDB.findById(req.userId);
    const tables = Object.entries(ROULETTE_TABLE_CONFIG).map(([key, cfg]) => ({
        ...cfg,
        key,
        eligible: user.bank_balance >= cfg.minBank
    }));
    res.json({ ok:true, tables });
});

// POST /api/game/roulette/enter - draw wallet from bank for Roulette table
router.post('/roulette/enter', requireAuth, async (req, res) => {
    const { tableMinBet } = req.body;
    const cfg = ROULETTE_TABLE_CONFIG[tableMinBet];
    if (!cfg) return res.status(400).json({ error:'Invalid Roulette table' });

    const result = await _walletEnter('roulette', req.userId, tableMinBet, cfg,
        `Entered Roulette $${tableMinBet} table`);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error || 'Entry failed' });
    res.json(result);
});

// POST /api/game/roulette/exit - return remaining Roulette wallet to bank
router.post('/roulette/exit', requireAuth, async (req, res) => {
    const { remainingWallet, tableMinBet } = req.body;
    if (!Number.isFinite(remainingWallet) || remainingWallet < 0)
        return res.status(400).json({ error:'Invalid wallet amount' });

    try {
        const result = await _walletWithExitLock('roulette', req.userId, () =>
            _walletExit('roulette', req.userId, remainingWallet, tableMinBet, false, req.body?.reason)
        );
        res.json(result);
    } catch(e) {
        console.error('[roulette/exit] error:', e);
        res.status(500).json({ error:'Exit settlement failed' });
    }
});

router.post('/roulette/exit-beacon', async (req, res) => {
    try {
        const token = req.query?.token;
        if (!token) return res.status(401).end();
        let userId;
        try { userId = jwt.verify(token, JWT_SECRET).userId; }
        catch { return res.status(401).end(); }

        const { remainingWallet, tableMinBet } = req.body || {};
        if (!Number.isFinite(remainingWallet) || remainingWallet < 0)
            return res.status(400).end();

        await _walletWithExitLock('roulette', userId, () =>
            _walletExit('roulette', userId, remainingWallet, tableMinBet, false, 'beacon')
        );
        res.status(204).end();
    } catch(e) {
        console.error('[roulette/exit-beacon] error:', e);
        res.status(500).end();
    }
});

const bjActiveSessions = new Map();
function _bjGetSession(userId)   { return _walletGetSession('blackjack', userId); }
function _bjSetSession(userId, walletSize, tableMinBet) {
    _walletSetSession('blackjack', userId, walletSize, tableMinBet);
}
function _bjClearSession(userId) { _walletClearSession('blackjack', userId); }

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

    const result = await _walletEnter('blackjack', req.userId, tableMinBet, cfg,
        `Entered Blackjack $${tableMinBet} table`);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error || 'Entry failed' });
    res.json(result);
});

// POST /api/game/bj/exit — return remaining Blackjack wallet to bank
router.post('/bj/exit', requireAuth, async (req, res) => {
    const { remainingWallet, tableMinBet } = req.body;
    if (typeof remainingWallet !== 'number' || remainingWallet < 0)
        return res.status(400).json({ error: 'Invalid wallet amount' });

    try {
        const result = await _walletWithExitLock('blackjack', req.userId, () =>
            _walletExit('blackjack', req.userId, remainingWallet, tableMinBet, false, req.body?.reason)
        );
        res.json(result);
        return;
    } catch(e) {
        console.error('[bj/exit] error:', e);
        return res.status(500).json({ error:'Exit settlement failed' });
    }

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

        await _walletWithExitLock('blackjack', userId, () =>
            _walletExit('blackjack', userId, remainingWallet, tableMinBet, false, 'beacon')
        );
        return res.status(204).end();

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
function _holdemGetSession(userId)   { return _walletGetSession('holdem', userId); }
function _holdemSetSession(userId, walletSize, tableMinBet) {
    _walletSetSession('holdem', userId, walletSize, tableMinBet);
}
function _holdemClearSession(userId) { _walletClearSession('holdem', userId); }

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

    const result = await _walletEnter('holdem', req.userId, tableMinBet, cfg,
        `Entered Hold'em $${tableMinBet} table`);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error || 'Entry failed' });
    res.json(result);
});

// POST /api/game/holdem/exit — return remaining Hold'em wallet to bank
router.post('/holdem/exit', requireAuth, async (req, res) => {
    const { remainingWallet, tableMinBet } = req.body;
    if (typeof remainingWallet !== 'number' || remainingWallet < 0)
        return res.status(400).json({ error: 'Invalid wallet amount' });

    try {
        const result = await _walletWithExitLock('holdem', req.userId, () =>
            _walletExit('holdem', req.userId, remainingWallet, tableMinBet, false, req.body?.reason)
        );
        res.json(result);
        return;
    } catch(e) {
        console.error('[holdem/exit] error:', e);
        return res.status(500).json({ error:'Exit settlement failed' });
    }

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

        await _walletWithExitLock('holdem', userId, () =>
            _walletExit('holdem', userId, remainingWallet, tableMinBet, false, 'beacon')
        );
        return res.status(204).end();

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
function _ssGetSession(userId)    { return _walletGetSession('sipsam', userId); }
function _ssSetSession(userId, walletSize, tableMinBet) {
    _walletSetSession('sipsam', userId, walletSize, tableMinBet);
}
function _ssClearSession(userId)  { _walletClearSession('sipsam', userId); }

// POST /api/game/enter — draw wallet from bank on entering a SipSam table
router.post('/enter', requireAuth, async (req, res) => {
    const { tableMinBet } = req.body;
    const cfg  = TABLE_CONFIG[tableMinBet];
    if (!cfg)  return res.status(400).json({ error: 'Invalid table' });

    const result = await _walletEnter('sipsam', req.userId, tableMinBet, cfg,
        `Entered SipSam $${tableMinBet} table`);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error || 'Entry failed' });
    res.json(result);
});

// Recent-credit guard: prevents double credits when explicit exit,
// beforeunload beacon, and server-side onLeave all fire for the same session.
// Trusted game-server settlement can still add the difference if a client
// beacon returned only the capped starting wallet before the server reported
// the final, post-payout wallet.
const _ssRecentCredits = new Map(); // userId -> { at, amount }
const _SS_COOLDOWN_MS = 60000;
const _ssExitLocks = new Map();

function _ssRecentCredit(userId) {
    return _walletRecentCredit('sipsam', userId);
}
function _ssMarkCredited(userId, amount) {
    _walletMarkCredited('sipsam', userId, amount);
}
function _isTrustedGameServer(req) {
    return req.get('x-game-server-secret') === GAME_SERVER_SECRET;
}
async function _ssWithExitLock(userId, fn) {
    const previous = _ssExitLocks.get(userId) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const cleanup = run.finally(() => {
        if (_ssExitLocks.get(userId) === cleanup) _ssExitLocks.delete(userId);
    });
    _ssExitLocks.set(userId, cleanup);
    return run;
}

// Look up whether the player has an outstanding (unsettled) wallet_draw
// in the transaction log. Used as a fallback when the in-memory session
// map is empty (for example after a platform restart).
async function _findUnsettledDraw(userId) {
    return _walletFindUnsettledDraw('sipsam', userId);
}

async function _handleSipSamExit(userId, remainingWallet, tableMinBet, trusted, sourceLabel) {
    const requested = Math.max(0, Math.floor(Number(remainingWallet) || 0));
    const recent = _ssRecentCredit(userId);
    if (recent) {
        if (trusted && requested > recent.amount) {
            const delta = requested - recent.amount;
            await UserDB.adjustBank(userId, delta);
            await TxnDB.record(userId, 'wallet_return', delta, 'sipsam',
                `SipSam server wallet reconciliation at $${tableMinBet} table (${sourceLabel || 'server'})`);
            _ssMarkCredited(userId, requested);
            const user = await UserDB.findById(userId);
            return { ok:true, reconciled:true, returned:delta, totalReturned:requested, newBankBalance:user.bank_balance };
        }
        const user = await UserDB.findById(userId);
        return { ok:true, skipped:'recent-credit', credited:recent.amount, newBankBalance:user.bank_balance };
    }

    const session = _ssGetSession(userId);
    _ssClearSession(userId);

    let allowedCeiling = 0;
    if (session) {
        allowedCeiling = session.walletSize;
    } else {
        const unsettled = await _findUnsettledDraw(userId);
        if (!unsettled) {
            console.warn(`[EXIT] ${userId} called /exit with no session and no unsettled draw - refusing to credit`);
            const user = await UserDB.findById(userId);
            return { ok:true, skipped:'no-draw', newBankBalance:user.bank_balance };
        }
        allowedCeiling = Math.abs(unsettled.amount);
    }

    const credit = (session || trusted) ? requested : Math.min(requested, allowedCeiling);
    if (!session && !trusted && credit !== requested) {
        console.warn(`[EXIT] ${userId} claimed $${requested} but ceiling is $${allowedCeiling} - capping client credit`);
    }

    await UserDB.adjustBank(userId, credit);
    await TxnDB.record(userId, 'wallet_return', credit, 'sipsam',
        `Exited $${tableMinBet} table${trusted ? ' (server settled)' : sourceLabel ? ' (' + sourceLabel + ')' : ''}`);
    _ssMarkCredited(userId, credit);

    const user = await UserDB.findById(userId);
    return { ok:true, returned:credit, trusted, newBankBalance:user.bank_balance };
}

// POST /api/game/exit - return remaining wallet chips to bank.
router.post('/exit', requireAuth, async (req, res) => {
    const { remainingWallet, tableMinBet } = req.body;
    if (!Number.isFinite(remainingWallet) || remainingWallet < 0)
        return res.status(400).json({ error: 'Invalid wallet amount' });

    try {
        const legacyGame = _legacyExitGameFor(req.userId);
        if (legacyGame !== 'sipsam') {
            const result = await _walletWithExitLock(legacyGame, req.userId, () =>
                _walletExit(legacyGame, req.userId, remainingWallet, tableMinBet, false, req.body?.reason || 'legacy_exit')
            );
            return res.json(result);
        }
        const result = await _ssWithExitLock(req.userId, () =>
            _handleSipSamExit(req.userId, remainingWallet, tableMinBet, _isTrustedGameServer(req), req.body?.reason)
        );
        res.json(result);
    } catch(e) {
        console.error('[exit] error:', e);
        res.status(500).json({ error:'Exit settlement failed' });
    }
});

// POST /api/game/exit-beacon - beacon-friendly refund (used by beforeunload)
// navigator.sendBeacon cannot set Authorization headers, so this path remains
// client-capped. If the game server later reports a higher final wallet, the
// trusted /exit path reconciles the difference.
router.post('/exit-beacon', async (req, res) => {
    try {
        const token = req.query?.token;
        if (!token) return res.status(401).end();
        let userId;
        try { userId = jwt.verify(token, JWT_SECRET).userId; }
        catch { return res.status(401).end(); }

        const { remainingWallet, tableMinBet } = req.body || {};
        if (!Number.isFinite(remainingWallet) || remainingWallet < 0)
            return res.status(400).end();

        const legacyGame = _legacyExitGameFor(userId);
        if (legacyGame !== 'sipsam') {
            await _walletWithExitLock(legacyGame, userId, () =>
                _walletExit(legacyGame, userId, remainingWallet, tableMinBet, false, 'legacy_beacon')
            );
            return res.status(204).end();
        }

        await _ssWithExitLock(userId, () =>
            _handleSipSamExit(userId, remainingWallet, tableMinBet, false, 'beacon')
        );
        res.status(204).end();
    } catch (e) {
        console.error('[exit-beacon] error:', e);
        res.status(500).end();
    }
});

// POST /api/game/debt-payment — pull a banker debt from bank when wallet is exhausted.
// Called by poker-server PokerRoom.onLeave when a banker disconnects with negative
// chips (forfeited round, owed payouts). The bank may go negative — players must
// purchase chips or watch ads to recover.
router.post('/debt-payment', requireAuth, async (req, res) => {
    const { amount, tableMinBet, reason, game } = req.body;
    if (typeof amount !== 'number' || amount <= 0)
        return res.status(400).json({ error: 'Invalid debt amount' });

    await UserDB.adjustBank(req.userId, -amount);
    await TxnDB.record(req.userId, 'banker_debt_settle', -amount, game || null,
        `${game === 'rhum32' ? 'Rhum32' : 'Banker'} debt settled at $${tableMinBet} table (${reason || 'forfeit'})`);

    const user = await UserDB.findById(req.userId);
    res.json({ ok:true, debtPaid: amount, newBankBalance: user.bank_balance });
});

// POST /api/game/replenish — top up wallet during game (SipSam, Rhum32, or Blackjack)
router.post('/replenish', requireAuth, async (req, res) => {
    const { tableMinBet, currentWallet, game, amount } = req.body;
    const gameKey = game || req.body.gameType;
    const configMap = gameKey === 'rhum32' ? RHUM32_TABLE_CONFIG
                    : gameKey === 'blackjack' ? BJ_TABLE_CONFIG
                    : TABLE_CONFIG;
    const cfg = configMap[tableMinBet];
    if (!cfg)  return res.status(400).json({ error: 'Invalid table' });

    const user   = await UserDB.findById(req.userId);
    const wallet = Math.max(0, Number(currentWallet) || 0);
    const needed = cfg.walletSize - wallet;
    const requested = Math.floor(Number(amount) || 0);
    const topUp  = requested > 0 ? Math.min(requested, needed) : needed;
    if (topUp <= 0) return res.status(400).json({ error: 'Wallet already at maximum' });
    if (user.bank_balance < topUp)
        return res.status(400).json({ error: `Need $${topUp.toLocaleString()} in bank to replenish` });

    await UserDB.adjustBank(req.userId, -topUp);
    await TxnDB.record(req.userId, 'wallet_replenish', -topUp, null, `Replenished wallet at $${tableMinBet} table`);

    const updated = await UserDB.findById(req.userId);
    res.json({ ok:true, topUp, newBankBalance: updated.bank_balance, newWallet: wallet + topUp });
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
    const user  = await UserDB.findById(req.userId);
    const now   = Math.floor(Date.now() / 1000);
    const oneHour = 3600;

    if (adType === 'reward') {
        const cooldownEnds = user.ad_last_session ? user.ad_last_session + oneHour : 0;
        if (now < cooldownEnds)
            return res.status(429).json({ error: 'Cooldown active', secondsRemaining: cooldownEnds - now });

        const maxAds = 5;
        if (user.ad_session_count >= maxAds)
            return res.status(400).json({ error: 'Maximum ads watched for this session' });

        const newCount = user.ad_session_count + 1;
        // Per-tier ad reward from lib/tiers.js. Falls back to 300 for
        // sub-Bronze players so the reward path always credits something.
        const { adBonusFor } = require('../lib/tiers');
        const chips = adBonusFor(user.bank_balance) || 300;

        await UserDB.adjustBank(req.userId, chips);
        await UserDB.updateAdSession(req.userId, newCount >= maxAds ? 0 : newCount);

        if (newCount >= maxAds) {
            await UserDB.updateAdSession(req.userId, 0);
        }

        await TxnDB.record(req.userId, 'ad_reward', chips, null, `Ad watch reward (${newCount}/${maxAds})`);

        const updatedUser = await UserDB.findById(req.userId);
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
    const user  = await UserDB.findById(req.userId);
    const now   = Math.floor(Date.now() / 1000);
    const oneHour = 3600;

    if (adType === 'reward') {
        const cooldownEnds = user.ad_last_session ? user.ad_last_session + oneHour : 0;
        if (now < cooldownEnds)
            return res.status(429).json({ error: 'Cooldown active', secondsRemaining: cooldownEnds - now });

        const maxAds = 5;
        if (user.ad_session_count >= maxAds)
            return res.status(400).json({ error: 'Maximum ads watched for this session' });

        const newCount = user.ad_session_count + 1;
        // Per-tier ad reward from lib/tiers.js. Falls back to 300 for
        // sub-Bronze players so the reward path always credits something.
        const { adBonusFor } = require('../lib/tiers');
        const chips = adBonusFor(user.bank_balance) || 300;

        await UserDB.adjustBank(req.userId, chips);
        await UserDB.updateAdSession(req.userId, newCount >= maxAds ? 0 : newCount);

        if (newCount >= maxAds) {
            await UserDB.updateAdSession(req.userId, 0);
        }

        await TxnDB.record(req.userId, 'ad_reward', chips, null, `Ad watch reward (${newCount}/${maxAds})`);

        const updatedUser = await UserDB.findById(req.userId);
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
