// ============================================
// VURGLIFE PLATFORM — DATABASE LAYER
// Uses sql.js (pure JavaScript SQLite — no C++ required)
// Data persisted to disk as vurglife.db binary file
// ============================================
const path = require('path');
const fs   = require('fs');

const DB_PATH  = path.join(__dirname, '../../data/vurglife.db');
const DATA_DIR = path.dirname(DB_PATH);

let db  = null;
let SQL = null;

// ── INIT ──────────────────────────────────────
async function getDb() {
    if (db) return db;

    if (!SQL) {
        SQL = await require('sql.js')();
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });

    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // Enable WAL-equivalent and foreign keys
    db.run('PRAGMA foreign_keys = ON;');

    initSchema();
    return db;
}

// Save DB to disk after every write
function persist() {
    if (!db) return;
    const data = db.export();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Wrapper: run a write statement and persist
function run(sql, params = []) {
    db.run(sql, params);
    persist();
}

// Wrapper: get one row
function get(sql, params = []) {
    const stmt    = db.prepare(sql);
    stmt.bind(params);
    const hasRow  = stmt.step();
    if (!hasRow) { stmt.free(); return null; }
    const row     = stmt.getAsObject();
    stmt.free();
    return row;
}

// Wrapper: get all rows
function all(sql, params = []) {
    const stmt   = db.prepare(sql);
    stmt.bind(params);
    const rows   = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
}

// Wrapper: insert and return lastInsertRowid
function insert(sql, params = []) {
    db.run(sql, params);
    const result = get('SELECT last_insert_rowid() as id');
    persist();
    return { lastInsertRowid: result?.id };
}

function initSchema() {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            email            TEXT    UNIQUE NOT NULL,
            username         TEXT    UNIQUE NOT NULL,
            password_hash    TEXT    NOT NULL,
            bank_balance     INTEGER NOT NULL DEFAULT 5000,
            avatar_url       TEXT    DEFAULT NULL,
            avatar_preset    TEXT    DEFAULT 'default',
            is_verified      INTEGER NOT NULL DEFAULT 0,
            verify_token     TEXT    DEFAULT NULL,
            reset_token      TEXT    DEFAULT NULL,
            reset_expires    INTEGER DEFAULT NULL,
            created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            last_login       INTEGER DEFAULT NULL,
            ad_last_session  INTEGER DEFAULT NULL,
            ad_session_count INTEGER NOT NULL DEFAULT 0,
            total_wins       INTEGER NOT NULL DEFAULT 0,
            total_games      INTEGER NOT NULL DEFAULT 0,
            milestone_50_claimed      INTEGER NOT NULL DEFAULT 0,
            milestone_100_claimed     INTEGER NOT NULL DEFAULT 0,
            milestone_century_last    INTEGER NOT NULL DEFAULT 0,
            last_daily_bonus INTEGER DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS friendships (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL REFERENCES users(id),
            friend_id  INTEGER NOT NULL REFERENCES users(id),
            status     TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            UNIQUE(user_id, friend_id)
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            type        TEXT NOT NULL,
            amount      INTEGER NOT NULL,
            reference   TEXT DEFAULT NULL,
            description TEXT DEFAULT NULL,
            created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS game_sessions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id      TEXT NOT NULL DEFAULT 'sipsam',
            room_id      TEXT NOT NULL,
            table_min    INTEGER NOT NULL,
            started_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            ended_at     INTEGER DEFAULT NULL,
            winner_id    INTEGER DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS game_participants (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id    INTEGER NOT NULL,
            user_id       INTEGER,
            username      TEXT NOT NULL,
            wallet_start  INTEGER NOT NULL,
            wallet_end    INTEGER DEFAULT NULL,
            rounds_played INTEGER NOT NULL DEFAULT 0,
            wins          INTEGER NOT NULL DEFAULT 0,
            losses        INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id    TEXT NOT NULL,
            user_id    INTEGER,
            username   TEXT NOT NULL,
            content    TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS notifications (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL,
            type       TEXT NOT NULL,
            content    TEXT NOT NULL,
            data       TEXT DEFAULT NULL,
            is_read    INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS chip_transfers (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id     INTEGER NOT NULL,
            to_id       INTEGER NOT NULL,
            amount      INTEGER NOT NULL,
            context     TEXT NOT NULL DEFAULT 'gift',
            created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS purchases (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id        INTEGER NOT NULL,
            package_id     TEXT NOT NULL,
            chips_amount   INTEGER NOT NULL,
            usd_amount     REAL NOT NULL,
            payment_method TEXT NOT NULL,
            payment_ref    TEXT DEFAULT NULL,
            status         TEXT NOT NULL DEFAULT 'pending',
            created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_friends_user   ON friendships(user_id);
        CREATE INDEX IF NOT EXISTS idx_txn_user       ON transactions(user_id);
        CREATE INDEX IF NOT EXISTS idx_msg_room       ON messages(room_id);
        CREATE INDEX IF NOT EXISTS idx_notif_user     ON notifications(user_id);
    `);
    persist();
    console.log('[DB] Schema initialised — sql.js (no C++ required)');
}

// ── USER QUERIES ──────────────────────────────
const UserDB = {
    async create(email, username, passwordHash) {
        await getDb();
        // Starting bank = $10,000 welcome bonus, per platform tier policy
        // (places every new player at Bronze immediately). See lib/tiers.js.
        return insert(
            `INSERT INTO users (email, username, password_hash, bank_balance) VALUES (?,?,?,10000)`,
            [email.toLowerCase(), username, passwordHash]
        );
    },
    async findByEmail(email) {
        await getDb();
        return get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    },
    async findByUsername(username) {
        await getDb();
        return get('SELECT * FROM users WHERE username = ?', [username]);
    },
    async findById(id) {
        await getDb();
        return get('SELECT * FROM users WHERE id = ?', [id]);
    },
    async findByEmailOrUsername(identifier) {
        await getDb();
        return get('SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)',
            [identifier, identifier]);
    },
    async updateLastLogin(id) {
        await getDb();
        run(`UPDATE users SET last_login = strftime('%s','now') WHERE id = ?`, [id]);
    },
    async adjustBank(id, delta) {
        await getDb();
        run('UPDATE users SET bank_balance = bank_balance + ? WHERE id = ?', [delta, id]);
    },
    async updateAdSession(id, count) {
        await getDb();
        run(`UPDATE users SET ad_last_session = strftime('%s','now'), ad_session_count = ? WHERE id = ?`,
            [count, id]);
    },
    async claimDailyBonus(id) {
        await getDb();
        run(`UPDATE users SET last_daily_bonus = strftime('%s','now'), bank_balance = bank_balance + 500 WHERE id = ?`, [id]);
    },
    async setVerifyToken(id, token) {
        await getDb();
        run('UPDATE users SET verify_token = ? WHERE id = ?', [token, id]);
    },
    async verifyEmail(token) {
        await getDb();
        const user = get('SELECT * FROM users WHERE verify_token = ?', [token]);
        if (user) run('UPDATE users SET is_verified = 1, verify_token = NULL WHERE id = ?', [user.id]);
        return user;
    },
    async setResetToken(id, token, expires) {
        await getDb();
        run('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?', [token, expires, id]);
    },
    async resetPassword(token, newHash) {
        await getDb();
        const now  = Math.floor(Date.now() / 1000);
        const user = get('SELECT * FROM users WHERE reset_token = ? AND reset_expires > ?', [token, now]);
        if (user) run('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?',
            [newHash, user.id]);
        return user;
    },
    async incrementWins(id) {
        await getDb();
        run('UPDATE users SET total_wins = total_wins + 1, total_games = total_games + 1 WHERE id = ?', [id]);
    },
    async incrementGames(id) {
        await getDb();
        run('UPDATE users SET total_games = total_games + 1 WHERE id = ?', [id]);
    },
    async updateMilestone(id, field) {
        await getDb();
        run(`UPDATE users SET ${field} = 1 WHERE id = ?`, [id]);
    },
    async updateCenturyMilestone(id, century) {
        await getDb();
        run('UPDATE users SET milestone_century_last = ? WHERE id = ?', [century, id]);
    },
    async searchByUsername(query) {
        await getDb();
        return all("SELECT id, username, avatar_url, avatar_preset FROM users WHERE username LIKE ? LIMIT 10",
            [`%${query}%`]);
    }
};

// ── FRIENDSHIP QUERIES ────────────────────────
const FriendDB = {
    async sendRequest(fromId, toId) {
        await getDb();
        try {
            run('INSERT OR IGNORE INTO friendships (user_id, friend_id, status) VALUES (?,?,"pending")', [fromId, toId]);
        } catch(e) {}
    },
    async accept(fromId, toId) {
        await getDb();
        run('UPDATE friendships SET status = "accepted" WHERE user_id = ? AND friend_id = ?', [fromId, toId]);
        try {
            run('INSERT OR IGNORE INTO friendships (user_id, friend_id, status) VALUES (?,?,"accepted")', [toId, fromId]);
        } catch(e) {}
    },
    async getFriends(userId) {
        await getDb();
        return all(`SELECT u.id, u.username, u.avatar_url, u.last_login
            FROM friendships f JOIN users u ON u.id = f.friend_id
            WHERE f.user_id = ? AND f.status = 'accepted'`, [userId]);
    },
    async areFriends(a, b) {
        await getDb();
        return !!get("SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'accepted'", [a, b]);
    }
};

// ── TRANSACTION QUERIES ───────────────────────
const TxnDB = {
    async record(userId, type, amount, ref = null, desc = null) {
        await getDb();
        insert('INSERT INTO transactions (user_id, type, amount, reference, description) VALUES (?,?,?,?,?)',
            [userId, type, amount, ref, desc]);
    },
    async history(userId, limit = 20) {
        await getDb();
        return all('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
    }
};

// ── NOTIFICATION QUERIES ──────────────────────
const NotifDB = {
    async create(userId, type, content, data = null) {
        await getDb();
        insert('INSERT INTO notifications (user_id, type, content, data) VALUES (?,?,?,?)',
            [userId, type, content, data ? JSON.stringify(data) : null]);
    },
    async getUnread(userId) {
        await getDb();
        return all('SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC', [userId]);
    },
    async markAllRead(userId) {
        await getDb();
        run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);
    }
};

// ── PURCHASE QUERIES ──────────────────────────
const PurchaseDB = {
    async create(userId, packageId, chips, usd, method) {
        await getDb();
        return insert('INSERT INTO purchases (user_id, package_id, chips_amount, usd_amount, payment_method) VALUES (?,?,?,?,?)',
            [userId, packageId, chips, usd, method]);
    },
    async complete(id, paymentRef) {
        await getDb();
        const p = get('SELECT * FROM purchases WHERE id = ?', [id]);
        if (!p || p.status !== 'pending') return null;
        run('UPDATE purchases SET status = "completed", payment_ref = ? WHERE id = ?', [paymentRef, id]);
        run('UPDATE users SET bank_balance = bank_balance + ? WHERE id = ?', [p.chips_amount, p.user_id]);
        return p;
    }
};

// ── TRANSFER QUERIES ──────────────────────────
const TransferDB = {
    async send(fromId, toId, amount, context = 'gift') {
        await getDb();
        const from = get('SELECT bank_balance FROM users WHERE id = ?', [fromId]);
        if (!from || from.bank_balance < amount) return { ok: false, reason: 'Insufficient balance' };
        run('UPDATE users SET bank_balance = bank_balance - ? WHERE id = ?', [amount, fromId]);
        run('UPDATE users SET bank_balance = bank_balance + ? WHERE id = ?', [amount, toId]);
        insert('INSERT INTO chip_transfers (from_id, to_id, amount, context) VALUES (?,?,?,?)',
            [fromId, toId, amount, context]);
        return { ok: true };
    }
};

module.exports = { getDb, run, get, all, UserDB, FriendDB, TxnDB, NotifDB, TransferDB, PurchaseDB };
