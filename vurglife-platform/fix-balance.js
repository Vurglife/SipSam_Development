// ============================================
// VURGLIFE — SET BALANCE UTILITY
// Sets ALL user balances to $500,000
// Run: node fix-balance.js
// ============================================
const path = require('path');
const fs   = require('fs');

async function fix() {
    const SQL    = await require('sql.js')();
    const dbPath = path.join(__dirname, 'data/vurglife.db');

    if (!fs.existsSync(dbPath)) {
        console.log('❌ No database found at', dbPath);
        process.exit(1);
    }

    const database = new SQL.Database(fs.readFileSync(dbPath));

    // Show before
    console.log('\n📋 Before:\n');
    const before = database.prepare('SELECT id, username, bank_balance FROM users');
    while (before.step()) {
        const r = before.getAsObject();
        console.log(`  ${r.username}: $${r.bank_balance}`);
    }
    before.free();

    // Set balance to $500,000
    database.run('UPDATE users SET bank_balance = 500000');

    // Show after
    console.log('\n✅ After:\n');
    const after = database.prepare('SELECT id, username, bank_balance FROM users');
    while (after.step()) {
        const r = after.getAsObject();
        console.log(`  ${r.username}: $${r.bank_balance}`);
    }
    after.free();

    // Save
    fs.writeFileSync(dbPath, Buffer.from(database.export()));
    console.log('\n💾 Done. Restart your server and refresh the browser.\n');
    process.exit(0);
}

fix().catch(err => { console.error(err); process.exit(1); });
