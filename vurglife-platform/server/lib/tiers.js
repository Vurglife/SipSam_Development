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

// Each tier carries its own daily login bonus and per-ad reward so
// higher-tier players see proportionally bigger boosts. dailyBonus is
// awarded once per 24h on first login of the day; adBonus is the credit
// for a single watch-ad claim.
const TIERS = [
    { name: 'Celestial', minBank: 10000000, color: '#7ec8ff', glow: 'rgba(126,200,255,.55)', emoji: '✨', dailyBonus: 10000, adBonus: 2500 },
    { name: 'Elite',     minBank:  7000000, color: '#9b5cff', glow: 'rgba(155,92,255,.5)',   emoji: '💎', dailyBonus:  5000, adBonus: 1700 },
    { name: 'VIP',       minBank:  2000000, color: '#ff5577', glow: 'rgba(255,85,119,.5)',   emoji: '👑', dailyBonus:  2000, adBonus: 1300 },
    { name: 'Platinum',  minBank:    60000, color: '#cfd6e4', glow: 'rgba(207,214,228,.45)', emoji: '🔷', dailyBonus:  1500, adBonus: 1000 },
    { name: 'Gold',      minBank:    30000, color: '#e8c96a', glow: 'rgba(232,201,106,.45)', emoji: '🏆', dailyBonus:  1000, adBonus:  700 },
    { name: 'Silver',    minBank:    15000, color: '#bcc2c8', glow: 'rgba(188,194,200,.4)',  emoji: '🥈', dailyBonus:   700, adBonus:  500 },
    { name: 'Bronze',    minBank:     5000, color: '#cd7f32', glow: 'rgba(205,127,50,.4)',   emoji: '🥉', dailyBonus:   500, adBonus:  300 },
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

// Per-tier rates. dailyBonus / adBonus now live on each tier above so
// the amount scales with the player's bank tier at the moment of claim.
function dailyBonusFor(bankBalance) {
    const t = computeTier(bankBalance);
    return t ? t.dailyBonus : 0;
}
function adBonusFor(bankBalance) {
    const t = computeTier(bankBalance);
    return t ? t.adBonus : 0;
}

// Legacy export kept so older code paths that hard-coded $500 still
// resolve to something sensible (Bronze rate). Prefer dailyBonusFor.
const DAILY_BONUS = 500;

module.exports = {
    TIERS, computeTier, tierName,
    WELCOME_BONUS, DAILY_BONUS,
    dailyBonusFor, adBonusFor,
};
