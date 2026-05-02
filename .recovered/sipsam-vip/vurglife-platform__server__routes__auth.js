// ============================================
// VURGLIFE — AUTH ROUTES
// POST /api/auth/register
// POST /api/auth/login
// POST /api/auth/logout
// GET  /api/auth/verify/:token
// POST /api/auth/forgot-password
// POST /api/auth/reset-password
// GET  /api/auth/me
// ============================================
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const router   = express.Router();
const { UserDB, TxnDB, NotifDB } = require('../db/database');
const { sendEmail }              = require('../utils/email');
const { requireAuth }            = require('../middleware/auth');

const JWT_SECRET  = process.env.JWT_SECRET  || 'vurglife_dev_secret_change_in_prod';
const BASE_URL    = process.env.BASE_URL    || 'http://localhost:3000';
const SALT_ROUNDS = 12;

function makeToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

// ── REGISTER ──────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
    try {
        const { email, username, password } = req.body;

        // Validation
        if (!email || !username || !password)
            return res.status(400).json({ error: 'All fields required' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return res.status(400).json({ error: 'Invalid email address' });
        if (username.length < 3 || username.length > 20)
            return res.status(400).json({ error: 'Username must be 3–20 characters' });
        if (!/^[a-zA-Z0-9_]+$/.test(username))
            return res.status(400).json({ error: 'Username: letters, numbers and underscores only' });
        if (password.length < 8)
            return res.status(400).json({ error: 'Password must be at least 8 characters' });

        // Check duplicates
        if (await UserDB.findByEmail(email))
            return res.status(409).json({ error: 'Email already registered' });
        if (await UserDB.findByUsername(username))
            return res.status(409).json({ error: 'Username already taken' });

        // Hash and create
        const hash  = await bcrypt.hash(password, SALT_ROUNDS);
        const result = await UserDB.create(email, username, hash);
        const userId = result.lastInsertRowid;

        // Verification token
        const verifyToken = crypto.randomBytes(32).toString('hex');
        await UserDB.setVerifyToken(userId, verifyToken);

        // Welcome notification
        await NotifDB.create(userId, 'welcome', `Welcome to VurgLife, ${username}! You've been given 5,000 chips to start.`);
        await TxnDB.record(userId, 'welcome_bonus', 5000, null, 'Welcome bonus chips');

        // Send verification email
        await sendEmail(email, 'Verify your VurgLife account', `
            <h2>Welcome to VurgLife, ${username}!</h2>
            <p>Click the link below to verify your email address:</p>
            <a href="${BASE_URL}/verify/${verifyToken}" style="background:#1a8cff;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">
                Verify Email
            </a>
            <p>If you didn't create this account, you can safely ignore this email.</p>
        `);

        const token = makeToken(userId);
        res.cookie('vurglife_token', token, {
            httpOnly: true, secure: process.env.NODE_ENV === 'production',
            maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax'
        });

        const user = await UserDB.findById(userId);
        res.status(201).json({
            ok: true,
            user: safeUser(user || { id: userId, email, username, bank_balance: 5000,
                avatar_url: null, avatar_preset: 'default', is_verified: 0,
                total_wins: 0, total_games: 0, last_login: null, created_at: Math.floor(Date.now()/1000),
                ad_last_session: null, ad_session_count: 0, last_daily_bonus: null,
                milestone_50_claimed: 0, milestone_100_claimed: 0, milestone_century_last: 0 }),
            token
        });

    } catch (err) {
        console.error('[Auth] Register error:', err);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});

// ── LOGIN ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { identifier, password } = req.body; // identifier = email or username

        if (!identifier || !password)
            return res.status(400).json({ error: 'Email/username and password required' });

        const user = await UserDB.findByEmailOrUsername(identifier);
        if (!user)
            return res.status(401).json({ error: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match)
            return res.status(401).json({ error: 'Invalid credentials' });

        await UserDB.updateLastLogin(user.id);

        // Daily login bonus
        const now        = Math.floor(Date.now() / 1000);
        const oneDayAgo  = now - 86400;
        if (!user.last_daily_bonus || user.last_daily_bonus < oneDayAgo) {
            await UserDB.claimDailyBonus(user.id);
            TxnDB.record(user.id, 'daily_bonus', 500, null, 'Daily login bonus');
            await NotifDB.create(user.id, 'daily_bonus', '🎁 Daily login bonus: +500 chips added to your bank!');
        }

        const token = makeToken(user.id);
        res.cookie('vurglife_token', token, {
            httpOnly: true, secure: process.env.NODE_ENV === 'production',
            maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax'
        });

        res.json({ ok: true, user: safeUser(await UserDB.findById(user.id)), token });

    } catch (err) {
        console.error('[Auth] Login error:', err);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// ── LOGOUT ────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
    res.clearCookie('vurglife_token');
    res.json({ ok: true });
});

// ── VERIFY EMAIL ──────────────────────────────────────────────────
router.get('/verify/:token', async (req, res) => {
    const user = await UserDB.verifyEmail(req.params.token);
    if (!user) return res.redirect('/?verified=failed');
    await NotifDB.create(user.id, 'verified', '✅ Email verified! Your account is fully active.');
    res.redirect('/?verified=success');
});

// ── FORGOT PASSWORD ───────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        const user = await UserDB.findByEmail(email);
        // Always respond OK (don't leak whether email exists)
        if (user) {
            const token   = crypto.randomBytes(32).toString('hex');
            const expires = Math.floor(Date.now() / 1000) + 3600; // 1 hour
            await UserDB.setResetToken(user.id, token, expires);
            await sendEmail(email, 'Reset your VurgLife password', `
                <h2>Password Reset</h2>
                <p>Click below to reset your password. This link expires in 1 hour.</p>
                <a href="${BASE_URL}/reset-password/${token}" style="background:#1a8cff;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">
                    Reset Password
                </a>
            `);
        }
        res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
    } catch (err) {
        console.error('[Auth] Forgot password error:', err);
        res.status(500).json({ error: 'Failed to send reset email.' });
    }
});

// ── RESET PASSWORD ────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password || password.length < 8)
            return res.status(400).json({ error: 'Invalid request' });
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        const user = await UserDB.resetPassword(token, hash);
        if (!user) return res.status(400).json({ error: 'Reset link invalid or expired' });
        res.json({ ok: true, message: 'Password reset successfully. Please log in.' });
    } catch (err) {
        res.status(500).json({ error: 'Password reset failed.' });
    }
});

// ── GET CURRENT USER ──────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
    const user = await UserDB.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const token = makeToken(req.userId);
    res.json({ ok: true, user: safeUser(user), token });
});

// ── SAFE USER OBJECT (no password hash) ──────────────────────────
function safeUser(u) {
    if (!u) return null;
    return {
        id:           u.id,
        email:        u.email,
        username:     u.username,
        bankBalance:  u.bank_balance,
        avatarUrl:    u.avatar_url,
        avatarPreset: u.avatar_preset,
        isVerified:   !!u.is_verified,
        totalWins:    u.total_wins,
        totalGames:   u.total_games,
        lastLogin:    u.last_login,
        createdAt:    u.created_at,
        adLastSession:  u.ad_last_session,
        adSessionCount: u.ad_session_count,
        lastDailyBonus: u.last_daily_bonus,
        milestones: {
            m50:     !!u.milestone_50_claimed,
            m100:    !!u.milestone_100_claimed,
            century: u.milestone_century_last
        }
    };
}

module.exports = router;
module.exports.safeUser = safeUser;

            return res.status(400).json({ error: 'Token and new password are required.' });

        if (password.length < 6)
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });

        const newHash = await bcrypt.hash(password, SALT_ROUNDS);
        const user    = await UserDB.resetPassword(token, newHash);

        if (!user)
            return res.status(400).json({ error: 'Invalid or expired reset token.' });

        console.log('[AUTH] Password reset: ' + user.username);
        res.json({ ok: true, message: 'Password updated — you can now sign in.' });

    } catch (err) {
        console.error('[AUTH] Reset password error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ══════════════════════════════════════════════════════════════════
// GET /api/auth/verify-email?token=xxx
// ══════════════════════════════════════════════════════════════════
router.get('/verify-email', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.redirect('/?verified=fail');

        const user = await UserDB.verifyEmail(token);
        if (!user)  return res.redirect('/?verified=fail');

        console.log('[AUTH] Email verified: ' + user.username);
        res.redirect('/?verified=success');

    } catch (err) {
        console.error('[AUTH] Verify email error:', err);
        res.redirect('/?verified=fail');
    }
});

module.exports = router;
module.exports.safeUser  = safeUser;
module.exports.signToken = signToken;
