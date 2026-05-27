// ============================================
// VURGLIFE — AUTH MIDDLEWARE
// ============================================
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'vurglife_jwt_secret_change_in_prod';

function requireAuth(req, res, next) {
    const token = req.cookies?.vurglife_token
               || req.headers?.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.userId = payload.userId;
        next();
    } catch {
        res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
}

function optionalAuth(req, res, next) {
    const token = req.cookies?.vurglife_token
               || req.headers?.authorization?.replace('Bearer ', '');
    if (token) {
        try {
            const payload = jwt.verify(token, JWT_SECRET);
            req.userId = payload.userId;
        } catch {}
    }
    next();
}

// Verify WebSocket upgrade token
function verifyWsToken(token) {
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        return payload.userId;
    } catch {
        return null;
    }
}

module.exports = { requireAuth, optionalAuth, verifyWsToken };
