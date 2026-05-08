// ============================================
// VURGLIFE — PLATFORM TIER SYSTEM
// Single source of truth for player tier <-> bank-balance mapping.
// Used to gate table access, render badges, and drive perks.
//
// Rules:
//   - A player's tier is their CURRENT bank balance bucketed into the
//     band whose minBank threshold they meet.
//   - Players move up and down tiers freely as their bank changes.
//   - Below Bronze ($5K) the player is "untiered" — locked out of all
//     real-money tables. They can earn back via daily bonus + ads or
//     purchase chips.
//   - New accounts receive a $10,000 welcome bonus, so every new player
//     starts AT LEAST as Bronze.
// ============================================

const TIERS = [
    { name: 'Elite',    minBank: 5000000, color: '#9b5cff', glow: 'rgba(155,92,255,.5)',  emoji: '💎' },
    { name: 'VIP',      minBank: 2000000, color: '#ff5577', glow: 'rgba(255,85,119,.5)',  emoji: '👑' },
    { name: 'Platinum', minBank:   60000, color: '#cfd6e4', glow: 'rgba(207,214,228,.45)', emoji: '🔷' },
    { name: 'Gold',     minBank:   30000, color: '#e8c96a', glow: 'rgba(232,201,106,.45)', emoji: '🏆' },
    { name: 'Silver',   minBank:   15000, color: '#bcc2c8', glow: 'rgba(188,194,200,.4)',  emoji: '🥈' },
    { name: 'Bronze',   minBank:    5000, color: '#cd7f32', glow: 'rgba(205,127,50,.4)',   emoji: '🥉' },
];

// Returns the highest tier whose minBank threshold the player meets,
// or null if below Bronze.
function computeTier(bankBalance) {
    const b = Number(bankBalance) || 0;
    for (const t of TIERS) {
        if (b >= t.minBank) return t;
    }
    return null;
}

// Lightweight name-only helper for places that only need the label.
function tierName(bankBalance) {
    const t = computeTier(bankBalance);
    return t ? t.name : 'Unranked';
}

// Welcome bonus paid on registration so new accounts immediately qualify
// for Bronze (and the $100 SipSam table).
const WELCOME_BONUS = 10000;

// Daily login bonus — claimed at most once per 24h. No banking: a missed
// day is lost; the player must visit the platform that day to redeem.
const DAILY_BONUS = 500;

module.exports = { TIERS, computeTier, tierName, WELCOME_BONUS, DAILY_BONUS };
