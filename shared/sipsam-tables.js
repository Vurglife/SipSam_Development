// ============================================================
// CANONICAL SIPSAM TABLE TIERS — SINGLE SOURCE OF TRUTH
// ============================================================
// This is the authoritative definition of every SipSam table tier.
// The SERVER (money path) reads ONLY this file — never an inline copy.
//
//   Node:    const SIPSAM_TABLES = require('../shared/sipsam-tables.js');
//   Browser: <script src="/shared/sipsam-tables.js"></script> → window.SIPSAM_TABLES
//            (optional; the two browser copies in poker-client/game.js
//             TABLE_CONFIGS and the dashboard TABLES are DISPLAY-ONLY
//             mirrors — they affect labels, not what the player is
//             charged. If they drift, the game still bills correctly;
//             only the dashboard text is cosmetically off.)
//
// Keyed by table selector. Canonical fields: minBet, increment, maxBet,
// walletSize, minBank.
// To add/adjust a tier, edit ONLY this file
// (plus the two display mirrors if you want the dashboard label to
// match — see ARCHITECTURE.md §3).
// ============================================================
(function (root, factory) {
    const TABLES = factory();
    if (typeof module === 'object' && module.exports) module.exports = TABLES;
    else root.SIPSAM_TABLES = TABLES;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    return {
        100:    { minBet:100,    increment:50,     maxBet:150,     walletSize:3000,    minBank:5000     },
        250:    { minBet:250,    increment:50,     maxBet:500,     walletSize:10000,   minBank:15000    },
        500:    { minBet:500,    increment:100,    maxBet:1000,    walletSize:20000,   minBank:30000    },
        1000:   { minBet:1000,   increment:500,    maxBet:2000,    walletSize:40000,   minBank:60000    },
        10000:  { minBet:10000,  increment:10000,  maxBet:50000,   walletSize:1000000, minBank:2000000  },
        100000: { minBet:100000, increment:100000, maxBet:500000,  walletSize:5000000, minBank:7000000  },
        500000: { minBet:500000, increment:250000, maxBet:1000000, walletSize:7000000, minBank:10000000 },
    };
});
