// ============================================
// VURGLIFE — GAME & REWARDS API ROUTES
// ============================================
const express = require('express');
const router  = express.Router();
const { UserDB, TxnDB, NotifDB } = require('../db/database');
const { requireAuth }            = require('../middleware/auth');
const { safeUser }               = require('./auth');

// ── TABLE CONFIG ──────────────────────────────────────────────────
const TABLE_CONFIG = {
    100:  { minBet:100,  increment:50,  maxBet:150,  minBank:5000,   walletSize:3000  },
    250:  { minBet:250,  increment:50,  maxBet:500,  minBank:15000,  walletSize:10000 },
    500:  { minBet:500,  increment:100, maxBet:1000, minBank:30000,  walletSize:20000 },
    1000: { minBet:1000, increment:500, maxBet:2000, minBank:60000,  walletSize:40000 }
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

// GET /api/game/tables
router.get('/tables', requireAuth, async (req, res) => {
    const user   = await UserDB.findById(req.userId);
    const tables = Object.entries(TABLE_CONFIG).map(([key, cfg]) => ({
        ...cfg,
        key,
        eligible: user.bank_balance >= cfg.minBank
    }));
    res.json({ ok:true, tables });
});

// POST /api/game/enter — draw wallet from bank on entering a table
router.post('/enter', requireAuth, async (req, res) => {
    const { tableMinBet } = req.body;
    const cfg  = TABLE_CONFIG[tableMinBet];
    if (!cfg)  return res.status(400).json({ error: 'Invalid table' });

    const user = await UserDB.findById(req.userId);
    if (user.bank_balance < cfg.minBank)
        return res.status(403).json({ error: `Need at least $${cfg.minBank.toLocaleString()} in your bank for this table` });
    if (user.bank_balance < cfg.walletSize)
        return res.status(403).json({ error: `Need at least $${cfg.walletSize.toLocaleString()} in your bank to fund wallet` });

    // Deduct wallet from bank
    await UserDB.adjustBank(req.userId, -cfg.walletSize);
    await TxnDB.record(req.userId, 'wallet_draw', -cfg.walletSize, null, `Entered $${tableMinBet} table`);

    res.json({
        ok: true,
        walletSize: cfg.walletSize,
        tableConfig: cfg,
        newBankBalance: user.bank_balance - cfg.walletSize
    });
});

// POST /api/game/exit — return remaining wallet chips to bank
router.post('/exit', requireAuth, async (req, res) => {
    const { remainingWallet, tableMinBet } = req.body;
    if (typeof remainingWallet !== 'number' || remainingWallet < 0)
        return res.status(400).json({ error: 'Invalid wallet amount' });

    await UserDB.adjustBank(req.userId, remainingWallet);
    await TxnDB.record(req.userId, 'wallet_return', remainingWallet, null, `Exited $${tableMinBet} table`);

    const user = await UserDB.findById(req.userId);
    res.json({ ok:true, newBankBalance: user.bank_balance });
});

// POST /api/game/replenish — top up wallet during game
router.post('/replenish', requireAuth, async (req, res) => {
    const { tableMinBet, currentWallet } = req.body;
    const cfg  = TABLE_CONFIG[tableMinBet];
    if (!cfg)  return res.status(400).json({ error: 'Invalid table' });

    const user   = UserDB.findById(req.userId);
    const topUp  = cfg.walletSize - currentWallet;
    if (topUp <= 0) return res.status(400).json({ error: 'Wallet already at maximum' });
    if (user.bank_balance < topUp)
        return res.status(400).json({ error: `Need $${topUp.toLocaleString()} in bank to replenish` });

    await UserDB.adjustBank(req.userId, -topUp);
    await TxnDB.record(req.userId, 'wallet_replenish', -topUp, null, `Replenished wallet at $${tableMinBet} table`);

    res.json({ ok:true, topUp, newBankBalance: user.bank_balance - topUp, newWallet: cfg.walletSize });
});

// ── ADS ────────────────────────────────────────────────────────────

// GET /api/ads/status — can the user watch ads?
router.get('/media/status', requireAuth, async (req, res) => {
    const user    = UserDB.findById(req.userId);
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
