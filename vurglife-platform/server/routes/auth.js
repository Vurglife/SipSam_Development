// ============================================
// VURGLIFE PLATFORM — AUTH ROUTES
// vurglife-platform/server/routes/auth.js
// ============================================
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { UserDB, TxnDB } = require('../db/database');
const { computeTier, WELCOME_BONUS, DAILY_BONUS, dailyBonusFor } = require('../lib/tiers');

const JWT_SECRET  = process.env.JWT_SECRET || 'vurglife_jwt_secret_change_in_prod';
const SALT_ROUNDS = 10;

// ── Strip sensitive fields + attach computed tier ─────────────────
function safeUser(user) {
    if (!user) return null;
    const { password_hash, verify_token, reset_token, reset_expires, ...safe } = user;
    const t = computeTier(safe.bank_balance);
    safe.tier      = t ? t.name : null;
    safe.tierEmoji = t ? t.emoji : null;
    safe.tierColor = t ? t.color : null;
    safe.dailyBonus = dailyBonusState(user);
    return safe;
}

// ── Sign a JWT for a user ─────────────────────────────────────────
function signToken(user) {
    return jwt.sign(
        { userId: user.id, username: user.username },
        JWT_SECRET,
        { expiresIn: '30d' }
    );
}

function dailyBonusAmountFor(user) {
    return dailyBonusFor(user.bank_balance) || DAILY_BONUS;
}

function dailyBonusState(user) {
    const now = Math.floor(Date.now() / 1000);
    const lastClaimedAt = Number(user.last_daily_bonus) || 0;
    const nextClaimAt = lastClaimedAt ? lastClaimedAt + 86400 : 0;
    const available = !lastClaimedAt || now >= nextClaimAt;
    return {
        available,
        amount: dailyBonusAmountFor(user),
        lastClaimedAt: lastClaimedAt || null,
        nextClaimAt: available ? null : nextClaimAt,
        secondsRemaining: available ? 0 : Math.max(0, nextClaimAt - now)
    };
}

async function authUserFromRequest(req, res) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

    if (!token) {
        res.status(401).json({ ok: false, error: 'Not authenticated.' });
        return null;
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        res.status(401).json({ ok: false, error: 'Session expired — please sign in again.' });
        return null;
    }

    const user = await UserDB.findById(decoded.userId);
    if (!user) {
        res.status(401).json({ ok: false, error: 'Account not found.' });
        return null;
    }

    return { decoded, user };
}

// ══════════════════════════════════════════════════════════════════
// POST /api/auth/register
// ══════════════════════════════════════════════════════════════════
router.post('/register', async (req, res) => {
    try {
        const { email, username, password } = req.body;

        if (!email || !username || !password)
            return res.status(400).json({ error: 'Email, username and password are required.' });

        if (username.length < 3 || username.length > 20)
            return res.status(400).json({ error: 'Username must be 3-20 characters.' });

        if (!/^[a-zA-Z0-9_]+$/.test(username))
            return res.status(400).json({ error: 'Username may only contain letters, numbers and underscores.' });

        if (password.length < 6)
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return res.status(400).json({ error: 'Please enter a valid email address.' });

        const existingEmail = await UserDB.findByEmail(email);
        if (existingEmail)
            return res.status(409).json({ error: 'An account with that email already exists.' });

        const existingUsername = await UserDB.findByUsername(username);
        if (existingUsername)
            return res.status(409).json({ error: 'That username is already taken.' });

        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        const result = await UserDB.create(email, username, passwordHash);

        const newUser = await UserDB.findById(result.lastInsertRowid);
        if (!newUser)
            return res.status(500).json({ error: 'Account created but could not retrieve user — try logging in.' });

        // Auto-verify so the account can log in immediately
        await UserDB.setVerified(newUser.id);

        // Log the welcome bonus as a transaction so it shows in history.
        // The bank credit itself is built into UserDB.create.
        try {
            await TxnDB.record(newUser.id, 'welcome_bonus', WELCOME_BONUS, null,
                'Welcome bonus — start at Bronze tier');
        } catch(e) { console.warn('[AUTH] welcome bonus txn log failed:', e.message); }

        const token = signToken(newUser);
        await UserDB.updateLastLogin(newUser.id);

        const freshUser = await UserDB.findById(newUser.id);

        console.log('[AUTH] Registered: ' + username + ' (' + email + ')');
        res.json({ ok: true, token, user: safeUser(freshUser) });

    } catch (err) {
        console.error('[AUTH] Register error:', err);
        res.status(500).json({ error: 'Registration failed — please try again.' });
    }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/auth/login
// Body: { identifier: "email or username", password: "..." }
// ══════════════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;

        if (!identifier || !password)
            return res.status(400).json({ error: 'Username/email and password are required.' });

        // Find by email OR username (case-insensitive — fixed in DB)
        const user = await UserDB.findByEmailOrUsername(identifier.trim());

        if (!user)
            return res.status(401).json({ error: 'No account found with that username or email.' });

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match)
            return res.status(401).json({ error: 'Incorrect password.' });

        // NOTE: is_verified is NOT checked — accounts work immediately after registration.
        // Uncomment below if you add email verification later:
        // if (!user.is_verified)
        //     return res.status(403).json({ error: 'Please verify your email before signing in.' });

        const token = signToken(user);
        await UserDB.updateLastLogin(user.id);

        const freshUser = await UserDB.findById(user.id);

        console.log('[AUTH] Login: ' + user.username);
        res.json({ ok: true, token, user: safeUser(freshUser) });

    } catch (err) {
        console.error('[AUTH] Login error:', err);
        res.status(500).json({ error: 'Login failed — please try again.' });
    }
});

// POST /api/auth/daily-bonus/claim
router.post('/daily-bonus/claim', async (req, res) => {
    try {
        const auth = await authUserFromRequest(req, res);
        if (!auth) return;

        const { user } = auth;
        const state = dailyBonusState(user);
        if (!state.available) {
            return res.status(409).json({
                ok: false,
                error: 'Daily bonus already claimed. Come back tomorrow.',
                dailyBonus: state
            });
        }

        const amount = dailyBonusAmountFor(user);
        await UserDB.claimDailyBonus(user.id, amount);
        try {
            await TxnDB.record(user.id, 'daily_bonus', amount, 'daily',
                `Daily bonus claimed (${computeTier(user.bank_balance)?.name || 'Free Chips'})`);
        } catch(e) { console.warn('[AUTH] daily bonus txn log failed:', e.message); }

        const freshUser = await UserDB.findById(user.id);
        console.log(`[AUTH] Daily bonus $${amount} claimed for ${user.username}`);
        res.json({
            ok: true,
            amount,
            newBankBalance: freshUser.bank_balance,
            user: safeUser(freshUser)
        });
    } catch (err) {
        console.error('[AUTH] Daily bonus claim error:', err);
        res.status(500).json({ ok: false, error: 'Daily bonus claim failed.' });
    }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/auth/logout
// ══════════════════════════════════════════════════════════════════
router.post('/logout', (req, res) => {
    res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// POST /api/auth/avatar — save avatar preset
router.post('/avatar', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
        let decoded;
        try { decoded = jwt.verify(token, JWT_SECRET); }
        catch(e) { return res.status(401).json({ ok: false, error: 'Session expired.' }); }
        const { avatar } = req.body;
        if (!avatar) return res.status(400).json({ ok: false, error: 'No avatar provided.' });
        await UserDB.updateAvatar(decoded.userId, avatar);
        console.log(`[AVATAR] ${decoded.username} → ${avatar}`);
        res.json({ ok: true });
    } catch(err) {
        res.status(500).json({ ok: false, error: 'Server error.' });
    }
});

// GET /api/auth/me
// ══════════════════════════════════════════════════════════════════
router.get('/me', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.startsWith('Bearer ')
            ? authHeader.slice(7)
            : null;

        if (!token)
            return res.status(401).json({ ok: false, error: 'Not authenticated.' });

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (e) {
            return res.status(401).json({ ok: false, error: 'Session expired — please sign in again.' });
        }

        const user = await UserDB.findById(decoded.userId);
        if (!user)
            return res.status(401).json({ ok: false, error: 'Account not found.' });

        const newToken = signToken(user);
        res.json({ ok: true, token: newToken, user: safeUser(user) });

    } catch (err) {
        console.error('[AUTH] /me error:', err);
        res.status(500).json({ ok: false, error: 'Server error.' });
    }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/auth/forgot-password
// ══════════════════════════════════════════════════════════════════
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email)
            return res.status(400).json({ error: 'Email is required.' });

        const user = await UserDB.findByEmail(email.trim());

        if (!user)
            return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });

        const resetToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const expires    = Math.floor(Date.now() / 1000) + 3600;

        await UserDB.setResetToken(user.id, resetToken, expires);
        console.log('[AUTH] Password reset for ' + user.email + ': token=' + resetToken);

        res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });

    } catch (err) {
        console.error('[AUTH] Forgot password error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/auth/reset-password
// ══════════════════════════════════════════════════════════════════
router.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password)
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
