// ============================================
// One-off admin script: grant chips to users
// Usage: node scripts/grant-chips.js
// ============================================
const path = require('path');
const fs   = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'vurglife.db');

// SET mode: set bank_balance to exact amount (not additive)
const SET_BALANCE = [];

// ADD mode: add (or subtract, with negative delta) to current bank_balance
const ADD_BALANCE = [
    { username: 'Vurg', delta: 5000000 },
];

(async () => {
    if (!fs.existsSync(DB_PATH)) {
        console.error('[grant-chips] Database not found at', DB_PATH);
        process.exit(1);
    }

    const SQL = await require('sql.js')();
    const fileBuffer = fs.readFileSync(DB_PATH);
    const db = new SQL.Database(fileBuffer);

    function lookup(username) {
        const stmt = db.prepare('SELECT id, username, bank_balance FROM users WHERE username = ? COLLATE NOCASE');
        stmt.bind([username]);
        if (!stmt.step()) {
            stmt.free();
            return null;
        }
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }

    function logTx(userId, delta, description) {
        try {
            db.run(
                `INSERT INTO transactions (user_id, type, amount, description, created_at)
                 VALUES (?, 'admin_grant', ?, ?, strftime('%s','now'))`,
                [userId, delta, description]
            );
        } catch (e) {
            // Table may not exist or schema differs — fine to ignore for this one-off
        }
    }

    for (const g of SET_BALANCE) {
        const row = lookup(g.username);
        if (!row) { console.warn(`[grant-chips] User "${g.username}" not found — skipping.`); continue; }
        const oldBal = row.bank_balance;
        const delta  = g.target - oldBal;
        db.run('UPDATE users SET bank_balance = ? WHERE id = ?', [g.target, row.id]);
        logTx(row.id, delta, `Admin set balance to ${g.target} chips (was ${oldBal})`);
        console.log(`[grant-chips] SET ${row.username}: ${oldBal.toLocaleString()} -> ${g.target.toLocaleString()} (delta: ${delta >= 0 ? '+' : ''}${delta.toLocaleString()})`);
    }

    for (const g of ADD_BALANCE) {
        const row = lookup(g.username);
        if (!row) { console.warn(`[grant-chips] User "${g.username}" not found — skipping.`); continue; }
        const oldBal = row.bank_balance;
        const newBal = oldBal + g.delta;
        db.run('UPDATE users SET bank_balance = ? WHERE id = ?', [newBal, row.id]);
        logTx(row.id, g.delta, `Admin added ${g.delta} chips (was ${oldBal}, now ${newBal})`);
        console.log(`[grant-chips] ADD ${row.username}: ${oldBal.toLocaleString()} -> ${newBal.toLocaleString()} (delta: ${g.delta >= 0 ? '+' : ''}${g.delta.toLocaleString()})`);
    }

    const out = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(out));
    db.close();
    console.log('[grant-chips] Database persisted.');
})().catch(err => {
    console.error('[grant-chips] Error:', err);
    process.exit(1);
});
