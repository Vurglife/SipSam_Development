// ============================================
// RHUM32 LOGIC ENGINE v1.0
//
// CARD VALUES:
//   Ace = 1, 2-9 = face value, 10/J/Q/K = 10
//
// ZERO RULES (cards count as 0):
//   - 3 of a Kind (same rank)
//   - 4 of a Kind (same rank)
//   - Straight Flush of 3+ cards (consecutive same suit)
//
// HAND VALUE = sum of non-zero cards
//
// SPECIALS (winning hand bonuses):
//   A-5 Special (0): same suit A-5 straight flush → back 100:1, bonus $75000
//   0 Special:       any 5-card straight flush     → back 50:1,  bonus $30000
//   1-5 Special:     hand value 1-5                → back 20:1,  bonus $5000
//   4-7 Special:     hand value 6-7 (4-5 covered by 1-5) → back 4:1, bonus $2500
//   8-11 Special:    hand value 8-11               → back 3:1,   bonus $1000
//   12-17 Special:   hand value 12-17              → back 2:1
//   18-31 Normal:    hand value 18-31              → back 1:1
//   47 Special:      4 face cards + 7              → back 2:1
//   48 Special:      4 face cards + 8              → back 3:1
//   49 Special:      4 face cards + 9              → back 6:1
//   50 Special:      5 face cards                  → back 7:1
//
// DEALER RULES:
//   - Dealer > 32 → auto-lose, pays front 1:1 + bonuses for specials + back for 47-50
//   - Dealer <= 32 → compare with players
//   - Dealer never benefits from 47-50 specials
// ============================================

function createDeck() {
    const suits  = ['h', 's', 'd', 'c'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
    const deck   = [];
    for (const s of suits) for (const v of values) deck.push(v + s);
    return deck;
}

function shuffleDeck(deck) {
    const d = [...deck];
    for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
}

// Card value for Rhum32: A=1, 2-9=face, T/J/Q/K=10
const VALUE_MAP = {
    'A': 1, '2': 2, '3': 3, '4': 4, '5': 5,
    '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10,
    'J': 10, 'Q': 10, 'K': 10
};

function cardValue(card) { return VALUE_MAP[card[0]] || 0; }
function cardRank(card)  { return card[0]; }
function cardSuit(card)  { return card[1]; }
function isFaceCard(card) { return ['T', 'J', 'Q', 'K'].includes(card[0]); }

// Numeric rank for straight detection: A=1, 2=2, ..., K=13
const RANK_ORDER = {
    'A': 1, '2': 2, '3': 3, '4': 4, '5': 5,
    '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10,
    'J': 11, 'Q': 12, 'K': 13
};

function numericRank(card) { return RANK_ORDER[card[0]] || 0; }

// ── ZERO-VALUE DETECTION ────────────────────────────────────────────
// Returns an array of card indices (0-4) whose value should be zeroed out.
// A card can only be zeroed once even if it qualifies under multiple rules.

function findZeroCards(hand) {
    const zeroed = new Set();

    // 1. Check for N-of-a-kind (3 or 4 of same rank)
    const byRank = {};
    hand.forEach((card, i) => {
        const r = cardRank(card);
        if (!byRank[r]) byRank[r] = [];
        byRank[r].push(i);
    });
    for (const indices of Object.values(byRank)) {
        if (indices.length >= 3) {
            indices.forEach(i => zeroed.add(i));
        }
    }

    // 2. Check for straight flushes of 3+ cards (consecutive ranks, same suit)
    const bySuit = {};
    hand.forEach((card, i) => {
        const s = cardSuit(card);
        if (!bySuit[s]) bySuit[s] = [];
        bySuit[s].push({ rank: numericRank(card), index: i });
    });

    for (const cards of Object.values(bySuit)) {
        if (cards.length < 3) continue;
        // Sort by rank
        cards.sort((a, b) => a.rank - b.rank);
        // Find all consecutive runs of 3+
        let run = [cards[0]];
        for (let i = 1; i < cards.length; i++) {
            if (cards[i].rank === run[run.length - 1].rank + 1) {
                run.push(cards[i]);
            } else {
                if (run.length >= 3) run.forEach(c => zeroed.add(c.index));
                run = [cards[i]];
            }
        }
        if (run.length >= 3) run.forEach(c => zeroed.add(c.index));
    }

    return zeroed;
}

// Calculate hand value after applying zero rules
function calculateHandValue(hand) {
    const zeroed = findZeroCards(hand);
    let sum = 0;
    hand.forEach((card, i) => {
        if (!zeroed.has(i)) sum += cardValue(card);
    });
    return sum;
}

// ── SPECIAL DETECTION ───────────────────────────────────────────────

// Check if hand is A-5 straight flush (A,2,3,4,5 all same suit)
function isA5Special(hand) {
    if (hand.length !== 5) return false;
    const suits = hand.map(cardSuit);
    if (!suits.every(s => s === suits[0])) return false;
    const ranks = hand.map(numericRank).sort((a, b) => a - b);
    return ranks.join(',') === '1,2,3,4,5';
}

// Check if hand is a 5-card straight flush (any, not just A-5)
function isStraightFlush5(hand) {
    if (hand.length !== 5) return false;
    const suits = hand.map(cardSuit);
    if (!suits.every(s => s === suits[0])) return false;
    const ranks = hand.map(numericRank).sort((a, b) => a - b);
    // Check consecutive
    for (let i = 1; i < ranks.length; i++) {
        if (ranks[i] !== ranks[i - 1] + 1) return false;
    }
    return true;
}

// Check 47/48/49/50 specials
// Conditions: must NOT contain 3/4 of a kind, must NOT contain straight flush of 3+
function checkFaceCardSpecial(hand) {
    const faceCount = hand.filter(isFaceCard).length;
    const rawSum = hand.reduce((s, c) => s + cardValue(c), 0);

    // Must have 4 or 5 face cards
    if (faceCount < 4) return null;

    // Disqualifying conditions: 3/4 of a kind or straight flush 3+
    const zeroed = findZeroCards(hand);
    if (zeroed.size > 0) return null;

    if (faceCount === 5 && rawSum === 50) return { name: '50 Special', backMultiplier: 7 };
    if (faceCount === 4 && rawSum === 49) return { name: '49 Special', backMultiplier: 6 };
    if (faceCount === 4 && rawSum === 48) return { name: '48 Special', backMultiplier: 3 };
    if (faceCount === 4 && rawSum === 47) return { name: '47 Special', backMultiplier: 2 };

    return null;
}

// Determine the payment tier for a winning hand
function getPaymentTier(hand) {
    const value = calculateHandValue(hand);

    // Check A-5 Special first (value would be 0, same suit A-5)
    if (isA5Special(hand)) {
        return { name: 'A-5 Special', value: 0, backMultiplier: 100, bonus: 75000 };
    }

    // Check 0 Special (any 5-card straight flush)
    if (isStraightFlush5(hand) && value === 0) {
        return { name: '0 Special', value: 0, backMultiplier: 50, bonus: 30000 };
    }

    // Check face card specials (47-50)
    const faceSpecial = checkFaceCardSpecial(hand);
    if (faceSpecial) {
        return { ...faceSpecial, value: hand.reduce((s, c) => s + cardValue(c), 0), bonus: 0 };
    }

    // Value-based tiers (1-5 checked first — higher payout takes priority over 4-7 overlap)
    if (value >= 1 && value <= 5)   return { name: '1-5 Special',  value, backMultiplier: 20, bonus: 5000 };
    if (value >= 6 && value <= 7)   return { name: '4-7 Special',  value, backMultiplier: 4,  bonus: 2500 };
    if (value >= 8 && value <= 11)  return { name: '8-11 Special', value, backMultiplier: 3,  bonus: 1000 };
    if (value >= 12 && value <= 17) return { name: '12-17 Special',value, backMultiplier: 2,  bonus: 0 };
    if (value >= 18 && value <= 31) return { name: '18-31 Normal', value, backMultiplier: 1,  bonus: 0 };

    // Value of 32+ — cannot win normally (but still might win if dealer crosses 32)
    return { name: 'Over 31', value, backMultiplier: 0, bonus: 0 };
}

// ── ROUND RESOLUTION ────────────────────────────────────────────────

// Resolve a single player vs dealer
// Returns { result, frontPayout, backPayout, bonus, tiePayout, description }
function resolvePlayerVsDealer(playerHand, dealerHand, frontBet, backBet, tieBet) {
    const playerValue = calculateHandValue(playerHand);
    const dealerValue = calculateHandValue(dealerHand);
    const dealerCrossed = dealerValue > 32;

    let frontPayout = 0;
    let backPayout  = 0;
    let bonus       = 0;
    let tiePayout   = 0;
    let result      = '';
    let description = '';
    let tier        = null;

    // Tie check FIRST. Tie bet pays iff playerValue === dealerValue,
    // regardless of bust state. Double-bust at the same value (e.g.
    // both 40) is still a tie and still pays. Dealer busting with
    // values differing is NOT a tie — tie bet is lost in that branch.
    if (playerValue === dealerValue) {
        // Tie at any value (including double-bust at equal totals).
        frontPayout = 0;
        backPayout  = 0;
        bonus       = 0;
        result      = 'tie';
        description = `Tie at ${playerValue}. Front and back bets returned.`;
        if (tieBet > 0) {
            tiePayout = tieBet * 20;
            description += ` Tie bet pays $${tiePayout}!`;
        }
    } else if (dealerCrossed) {
        // Dealer crosses 32 with a value that doesn't match the player —
        // player wins the front bet. Tie bet is LOST (no tie).
        // Table 5: front bet always 1:1
        // Face card specials (47-50): back bet at multiplier, no bonus
        // Value-based specials (A-5, 0, 1-5, 4-7, 8-11): no back bet gain, bonus YES
        // 12-17 and above: front 1:1 only
        tier = getPaymentTier(playerHand);
        frontPayout = frontBet;

        const faceSpecial = checkFaceCardSpecial(playerHand);
        if (faceSpecial) {
            // 47-50 specials: back bet pays at multiplier, no bonus
            backPayout = backBet * faceSpecial.backMultiplier;
            bonus      = 0;
        } else {
            // Value-based: no back bet gain, but bonus still paid
            backPayout = 0;
            bonus      = tier.bonus || 0;
        }

        result      = 'dealer_bust';
        description = `Dealer busted with ${dealerValue}. You win front bet 1:1.`;
        if (faceSpecial) description += ` ${faceSpecial.name}: back bet ${faceSpecial.backMultiplier}:1!`;
        if (bonus > 0) description += ` ${tier.name} bonus: $${bonus}!`;
    } else if (playerValue < dealerValue) {
        // Player wins (lower is better)
        tier = getPaymentTier(playerHand);
        frontPayout = frontBet; // front always 1:1
        backPayout  = backBet * tier.backMultiplier;
        bonus       = tier.bonus || 0;
        result      = 'player_win';
        description = `You win with ${playerValue} vs dealer's ${dealerValue}. ${tier.name}.`;
    } else {
        // Dealer wins (player value > dealer value, and dealer <= 32)
        frontPayout = -frontBet;
        backPayout  = -backBet;
        bonus       = 0;
        result      = 'dealer_win';
        description = `Dealer wins with ${dealerValue} vs your ${playerValue}. You lose bets.`;
    }

    return {
        result,
        playerValue,
        dealerValue,
        dealerCrossed,
        frontPayout,
        backPayout,
        bonus,
        tiePayout,
        tier,
        totalPayout: frontPayout + backPayout + bonus + tiePayout,
        description
    };
}

// Deal cards from deck — removes from deck array
function dealCards(deck, count) {
    return deck.splice(0, count);
}

// Format hand for display
function formatHand(hand) {
    return hand.map(c => {
        const rank = c[0] === 'T' ? '10' : c[0];
        const suitMap = { h: '\u2665', d: '\u2666', c: '\u2663', s: '\u2660' };
        return rank + (suitMap[c[1]] || c[1]);
    }).join(' ');
}

module.exports = {
    createDeck,
    shuffleDeck,
    cardValue,
    cardRank,
    cardSuit,
    isFaceCard,
    numericRank,
    findZeroCards,
    calculateHandValue,
    isA5Special,
    isStraightFlush5,
    checkFaceCardSpecial,
    getPaymentTier,
    resolvePlayerVsDealer,
    dealCards,
    formatHand
};
