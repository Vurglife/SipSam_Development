// ============================================
// VURGLIFE — FRIENDS & INVITE API ROUTES
// ============================================
const express = require('express');
const router  = express.Router();
const { UserDB, FriendDB, NotifDB } = require('../db/database');
const { requireAuth }               = require('../middleware/auth');
const gameRoutes = require('./game');
const GAME_CONFIGS = {
    sipsam:    gameRoutes.TABLE_CONFIG,
    rhum32:    gameRoutes.RHUM32_TABLE_CONFIG,
    blackjack: gameRoutes.BJ_TABLE_CONFIG,
    holdem:    gameRoutes.HOLDEM_TABLE_CONFIG,
};
function minBankFor(game, tableMinBet) {
    const cfg = GAME_CONFIGS[game]?.[Number(tableMinBet)];
    if (cfg) return cfg.minBank ?? cfg.walletSize ?? 3000;
    // Unknown game/tier — be lenient so invite still sends; "meets min bank" just flagged false.
    return 3000;
}

// In-memory game invites (expire after 3 minutes)
const gameInvites = new Map(); // inviteId → { fromUserId, fromUsername, toUserId, game, tableMinBet, roomId, expiresAt }

// ── FRIEND MANAGEMENT ─────────────────────────────────────────────

// GET /api/friends — list my friends
router.get('/', requireAuth, async (req, res) => {
    const friends = await FriendDB.getFriends(req.userId);
    res.json({ ok: true, friends });
});

// GET /api/friends/pending — list pending requests
router.get('/pending', requireAuth, async (req, res) => {
    const { all } = require('../db/database');
    const pending = await all(
        `SELECT f.id, f.user_id as from_id, u.username as from_username, f.created_at
         FROM friendships f JOIN users u ON u.id = f.user_id
         WHERE f.friend_id = ? AND f.status = 'pending'`, [req.userId]
    );
    res.json({ ok: true, pending });
});


// GET /api/friends/search?q=... - compatibility for older clients
router.get('/search', requireAuth, async (req, res) => {
    const query = req.query.q || req.query.query;
    if (!query || query.length < 2) return res.status(400).json({ error: 'Query too short' });
    const { all } = require('../db/database');
    const users = await all(
        `SELECT id, username, avatar_url FROM users WHERE username LIKE ? AND id != ? LIMIT 20`,
        [`%${query}%`, req.userId]
    );
    for (const u of users) {
        u.isFriend = await FriendDB.areFriends(req.userId, u.id);
    }
    res.json({ ok: true, users, results: users });
});

// POST /api/friends/search — search users by username
router.post('/search', requireAuth, async (req, res) => {
    const { query } = req.body;
    if (!query || query.length < 2) return res.status(400).json({ error: 'Query too short' });
    const { all } = require('../db/database');
    const users = await all(
        `SELECT id, username, avatar_url FROM users WHERE username LIKE ? AND id != ? LIMIT 20`,
        [`%${query}%`, req.userId]
    );
    // Mark which ones are already friends
    for (const u of users) {
        u.isFriend = await FriendDB.areFriends(req.userId, u.id);
    }
    res.json({ ok: true, users });
});

// POST /api/friends/request — send friend request
router.post('/request', requireAuth, async (req, res) => {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'Missing targetUserId' });
    if (targetUserId === req.userId) return res.status(400).json({ error: 'Cannot friend yourself' });

    const target = await UserDB.findById(targetUserId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const already = await FriendDB.areFriends(req.userId, targetUserId);
    if (already) return res.status(400).json({ error: 'Already friends' });

    await FriendDB.sendRequest(req.userId, targetUserId);
    const me = await UserDB.findById(req.userId);
    await NotifDB.create(targetUserId, 'friend_request', `${me.username} sent you a friend request!`);
    res.json({ ok: true, message: 'Friend request sent' });
});

// POST /api/friends/accept — accept friend request
router.post('/accept', requireAuth, async (req, res) => {
    const { fromUserId } = req.body;
    if (!fromUserId) return res.status(400).json({ error: 'Missing fromUserId' });

    await FriendDB.accept(fromUserId, req.userId);
    const me = await UserDB.findById(req.userId);
    await NotifDB.create(fromUserId, 'friend_accepted', `${me.username} accepted your friend request!`);
    res.json({ ok: true, message: 'Friend request accepted' });
});

// POST /api/friends/reject — reject/remove friend
router.post('/reject', requireAuth, async (req, res) => {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'Missing targetUserId' });
    const { run } = require('../db/database');
    await run('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?', [targetUserId, req.userId]);
    await run('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?', [req.userId, targetUserId]);
    res.json({ ok: true, message: 'Removed' });
});

// ── GAME INVITES ──────────────────────────────────────────────────

// POST /api/friends/invite — send game invite to a friend
router.post('/invite', requireAuth, async (req, res) => {
    let { toUserId, toUsername, game, tableMinBet, roomId, tableConfig } = req.body;
    if (!game || !tableMinBet) return res.status(400).json({ error: 'Missing fields' });

    // Allow lookup by username if no toUserId provided
    if (!toUserId && toUsername) {
        const found = await UserDB.findByUsername(toUsername);
        if (!found) return res.status(404).json({ error: 'User not found' });
        toUserId = found.id;
    }
    if (!toUserId) return res.status(400).json({ error: 'Missing target user' });

    const isFriend = await FriendDB.areFriends(req.userId, toUserId);
    if (!isFriend) return res.status(403).json({ error: 'Not friends with this user' });

    const me     = await UserDB.findById(req.userId);
    const target = await UserDB.findById(toUserId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Check if friend meets min bank (per-game config, with safe fallback)
    const minBank = minBankFor(game, tableMinBet);
    const meetsMinBank = target.bank_balance >= minBank;

    const inviteId = 'inv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const expiresAt = Date.now() + 3 * 60 * 1000; // 3 minutes

    gameInvites.set(inviteId, {
        fromUserId: req.userId,
        fromUsername: me.username,
        toUserId,
        game,
        tableMinBet,
        roomId: roomId || null,
        tableConfig: tableConfig || null,
        expiresAt,
        meetsMinBank
    });

    // Auto-cleanup after expiry
    setTimeout(() => gameInvites.delete(inviteId), 3 * 60 * 1000);

    await NotifDB.create(toUserId, 'game_invite',
        `${me.username} invited you to ${game} ($${tableMinBet} table)!${!meetsMinBank ? ' You need more chips to join.' : ''}`
    );

    res.json({ ok: true, inviteId, expiresAt, meetsMinBank });
});

// GET /api/friends/invites — get my pending game invites
router.get('/invites', requireAuth, async (req, res) => {
    const now = Date.now();
    const invites = [];
    for (const [id, inv] of gameInvites) {
        if (inv.toUserId === req.userId && inv.expiresAt > now) {
            invites.push({ inviteId: id, ...inv });
        }
    }
    res.json({ ok: true, invites });
});

// POST /api/friends/invite/accept — accept a game invite
router.post('/invite/accept', requireAuth, async (req, res) => {
    const { inviteId } = req.body;
    const inv = gameInvites.get(inviteId);
    if (!inv) return res.status(404).json({ error: 'Invite not found or expired' });
    if (inv.toUserId !== req.userId) return res.status(403).json({ error: 'Not your invite' });
    if (inv.expiresAt < Date.now()) {
        gameInvites.delete(inviteId);
        return res.status(410).json({ error: 'Invite expired' });
    }
    gameInvites.delete(inviteId);
    res.json({ ok: true, game: inv.game, tableMinBet: inv.tableMinBet, roomId: inv.roomId, tableConfig: inv.tableConfig || null });
});

module.exports = router;
module.exports.gameInvites = gameInvites;
