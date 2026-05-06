// ============================================
// SIPSAM LOGIC ENGINE v6.0
//
// HAND RANKING:
//   3-card 1st hand:  HighCard(0) → Pair(1) → Trips(2)
//     Straights/Flushes in 1st hand = treated as High Card for ORDERING
//     (they can still exist; just don't rank higher than a plain High Card)
//
//   5-card 2nd/3rd hands:
//     HighCard(0) → Pair(1) → TwoPair(2) → Trips(3) →
//     Straight(4) → Flush(5) → FullHouse(6) →
//     StraightFlush(7) → RoyalFlush(8)
//     Four of a Kind = Special only
//
// VALIDATE ORDER:
//   3-card strength scale: HC=0, Pair=10, Trips=20
//   5-card strength scale: HC=0, Pair=10, TwoPair=20, Trips=30,
//     Straight=40, Flush=50, FullHouse=60, SF=70, Royal=80
//   Rule: s1 <= s2 <= s3 strictly
//   Same type same bucket: primary value must be strictly higher up
//   1st hand straight/flush → treated as HC (rank 0) for scale
//
// SPECIALS: player must declare; server verifies
// ============================================

function createDeck() {
    const suits  = ['h','s','d','c'];
    const values = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    const deck   = [];
    for (const s of suits) for (const v of values) deck.push(v+s);
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length-1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i+1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

const VALUE_MAP = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14};
const SUIT_RANK = {'h':4,'s':3,'d':2,'c':1};

function cardValue(card) { return VALUE_MAP[card[0]] || 0; }
function cardSuit(card)  { return card[1]; }
function suitRank(card)  { return SUIT_RANK[card[1]] || 0; }
function hasFaceCard(cards) { return cards.some(c => ['J','Q','K'].includes(c[0])); }

function sortDesc(cards) {
    return [...cards].sort((a,b) => {
        const vd = cardValue(b) - cardValue(a);
        return vd !== 0 ? vd : suitRank(b) - suitRank(a);
    });
}

function longestStraightLength(cards) {
    const vals = [...new Set(cards.map(cardValue))].sort((a,b) => a-b);
    let best = 1, cur = 1;
    for (let i = 1; i < vals.length; i++) {
        if (vals[i] === vals[i-1]+1) { cur++; best = Math.max(best, cur); }
        else cur = 1;
    }
    if (vals.includes(14) && vals.includes(2)) {
        const withAceLow = [1, ...vals.filter(v=>v!==14)].sort((a,b)=>a-b);
        let wc = 1, wb = 1;
        for (let i = 1; i < withAceLow.length; i++) {
            if (withAceLow[i] === withAceLow[i-1]+1) { wc++; wb = Math.max(wb, wc); }
            else wc = 1;
        }
        best = Math.max(best, wb);
    }
    return best;
}

function checkStraight(values) {
    const uniq = [...new Set(values)].sort((a,b) => a-b);
    if (uniq.length !== values.length) return false;
    if (uniq[uniq.length-1] - uniq[0] === uniq.length-1) return true;
    const j = uniq.join(',');
    if (j === '2,3,4,5,14') return true;
    if (j === '2,3,14')     return true;
    return false;
}

// ── EVALUATE 3-CARD HAND ──────────────────────────────────────────
// For ORDER purposes: straights/flushes in 1st hand = High Card (rank 0)
// isStraight/isFlush flags still set so specials can detect them
function evaluate3CardHand(cards) {
    if (!cards || cards.length < 2) return {rank:0, name:'High Card', cards:[], isFlush:false, isStraight:false};
    const sorted = sortDesc(cards);
    const values = sorted.map(cardValue);
    const suits  = sorted.map(cardSuit);
    const vc = {};
    values.forEach(v => vc[v] = (vc[v]||0)+1);
    const counts     = Object.values(vc).sort((a,b) => b-a);
    const isFlush    = suits.every(s => s === suits[0]);
    const isStraight = checkStraight(values);
    const isSF       = isFlush && isStraight;
    // Rank for ordering: ONLY Pair/Trips count — straight/flush = High Card
    if (counts[0] === 3) {
        const tripsSorted3 = [...sorted].sort((a,b) => {
            const ca = vc[cardValue(a)], cb = vc[cardValue(b)];
            if (ca !== cb) return cb - ca;
            return cardValue(b) - cardValue(a);
        });
        return {rank:2, name:'Trips', cards:tripsSorted3, isFlush, isStraight, isStraightFlush:isSF};
    }
    if (counts[0] === 2) {
        const pairSorted = [...sorted].sort((a,b) => {
            const ca = vc[cardValue(a)], cb = vc[cardValue(b)];
            if (ca !== cb) return cb - ca;
            return cardValue(b) - cardValue(a);
        });
        return {rank:1, name:'Pair', cards:pairSorted, isFlush, isStraight, isStraightFlush:isSF};
    }
    return                     {rank:0, name:'High Card', cards:sorted, isFlush, isStraight, isStraightFlush:isSF};
}

// ── EVALUATE 5-CARD HAND ──────────────────────────────────────────
function evaluate5CardHand(cards) {
    if (!cards || cards.length < 2) return {rank:0, name:'High Card', cards:[], isFlush:false, isStraight:false};
    const sorted = sortDesc(cards);
    const values = sorted.map(cardValue);
    const suits  = sorted.map(cardSuit);
    const vc = {};
    values.forEach(v => vc[v] = (vc[v]||0)+1);
    const counts     = Object.values(vc).sort((a,b) => b-a);
    const isFlush    = suits.every(s => s === suits[0]);
    const isStraight = checkStraight(values);
    const maxV = Math.max(...values);
    const minV = Math.min(...values);
    const isRoyal = isFlush && isStraight && maxV===14 && minV===10;
    if (isRoyal)                        return {rank:8, name:'Royal Flush',    cards:sorted, isFlush, isStraight};
    if (isFlush && isStraight)          return {rank:7, name:'Straight Flush', cards:sorted, isFlush, isStraight};
    if (counts[0]===4)                  return {rank:9, name:'Four of a Kind', cards:sorted, isFlush, isStraight}; // Special only — rank 9 so never confused with normal
    if (counts[0]===3 && counts[1]===2) {
        // Sort: trips first, then pair — so positional comparison works correctly
        // e.g. 444KK → [4,4,4,K,K], not [K,K,4,4,4]
        const tripsVal = parseInt(Object.entries(vc).find(([,c])=>c===3)[0]);
        const fhSorted = [...sorted].sort((a,b) => {
            const ca = vc[cardValue(a)], cb = vc[cardValue(b)];
            if (ca !== cb) return cb - ca; // trips (count=3) before pair (count=2)
            return cardValue(b) - cardValue(a); // within same group, higher value first
        });
        return {rank:6, name:'Full House', cards:fhSorted, isFlush, isStraight};
    }
    if (isFlush)                        return {rank:5, name:'Flush',          cards:sorted, isFlush, isStraight};
    if (isStraight)                     return {rank:4, name:'Straight',       cards:sorted, isFlush, isStraight};
    if (counts[0]===3) {
        const tripsSorted5 = [...sorted].sort((a,b) => {
            const ca = vc[cardValue(a)], cb = vc[cardValue(b)];
            if (ca !== cb) return cb - ca;
            return cardValue(b) - cardValue(a);
        });
        return {rank:3, name:'Trips', cards:tripsSorted5, isFlush, isStraight};
    }
    if (counts[0]===2 && counts[1]===2) {
        const pairVals = Object.entries(vc).filter(([,c])=>c===2).map(([v])=>parseInt(v)).sort((a,b)=>b-a);
        const tpSorted = [...sorted].sort((a,b) => {
            const va = cardValue(a), vb_v = cardValue(b);
            const isPairA = vc[va]===2, isPairB = vc[vb_v]===2;
            if (isPairA && !isPairB) return -1;
            if (!isPairA && isPairB) return 1;
            if (isPairA && isPairB) {
                const riA = pairVals.indexOf(va), riB = pairVals.indexOf(vb_v);
                if (riA !== riB) return riA - riB;
                return vb_v - va;
            }
            return vb_v - va;
        });
        return {rank:2, name:'Two Pair', cards:tpSorted, isFlush, isStraight};
    }
    if (counts[0]===2) {
        const pairSorted5 = [...sorted].sort((a,b) => {
            const ca = vc[cardValue(a)], cb = vc[cardValue(b)];
            if (ca !== cb) return cb - ca;
            return cardValue(b) - cardValue(a);
        });
        return {rank:1, name:'Pair', cards:pairSorted5, isFlush, isStraight};
    }
    return                                     {rank:0, name:'High Card',      cards:sorted, isFlush, isStraight};
}

function evaluateCombined(hand2, hand3) {
    const all = [...(hand2||[]), ...(hand3||[])];
    return { straightLen: longestStraightLength(all) };
}

// ── COMPARE TWO 3-CARD HANDS ──────────────────────────────────────
function compare3CardHands(handA, handB) {
    const eA = evaluate3CardHand(handA);
    const eB = evaluate3CardHand(handB);
    if (eA.rank > eB.rank) return  1;
    if (eA.rank < eB.rank) return -1;
    // Same rank — compare sorted descending values
    const aVals = eA.cards.map(cardValue);
    const bVals = eB.cards.map(cardValue);
    for (let i = 0; i < Math.min(aVals.length, bVals.length); i++) {
        if (aVals[i] > bVals[i]) return  1;
        if (aVals[i] < bVals[i]) return -1;
    }
    // Flush tie-break
    if (eA.isFlush && eB.isFlush) {
        const aS = Math.max(...eA.cards.map(suitRank));
        const bS = Math.max(...eB.cards.map(suitRank));
        if (aS > bS) return  1;
        if (aS < bS) return -1;
    }
    return 0; // true tie — banker wins upstream
}

// For a straight or straight flush:
//   - Royal (10-J-Q-K-A) = highest                → effective high = 14, isRoyal=true
//   - Wheel (A-2-3-4-5)  = second highest          → effective high = 13.5 (between K-high and Royal)
//   - All others ranked by normal high card (2-3-4-5-6 lowest, 9-10-J-Q-K highest before wheel)
// For a plain flush:
//   - Ranked by descending card values (Ace-high beats K-high etc.)
//   - Tie in values → suit ranking (Hearts > Spades > Diamonds > Clubs)
function isStraightWithAce(e) {
    // True if hand is a straight/SF containing an Ace but is NOT the Royal
    if (!e.isStraight) return false;
    if (e.rank === 8) return false; // Royal Flush — handled separately
    return e.cards.some(c => cardValue(c) === 14);
}

function straightEffectiveHigh(e) {
    // Royal = 14 (already rank 8, won't reach here in same-rank comparison)
    // Wheel (A-2-3-4-5) = 13.5 so it beats 9-K (high=13) but loses to Royal
    if (isStraightWithAce(e)) return 13.5;
    // Normal straight: high card is the top of sorted descending list
    return cardValue(e.cards[0]);
}

// ── COMPARE TWO 5-CARD HANDS ──────────────────────────────────────
function compare5CardHands(handA, handB, combinedLenA, combinedLenB) {
    const eA = evaluate5CardHand(handA);
    const eB = evaluate5CardHand(handB);
    const effectiveRankA = getEffectiveRank(eA, combinedLenA);
    const effectiveRankB = getEffectiveRank(eB, combinedLenB);

    if (effectiveRankA > effectiveRankB) return  1;
    if (effectiveRankA < effectiveRankB) return -1;

    // Same effective rank — card-value comparison
    // Special case: both are straights or straight flushes
    const bothStraight = eA.isStraight && eB.isStraight;
    if (bothStraight) {
        const hA = straightEffectiveHigh(eA);
        const hB = straightEffectiveHigh(eB);
        if (hA > hB) return  1;
        if (hA < hB) return -1;
        // Exact same straight — suit tie-break only for SF
        if (eA.isFlush && eB.isFlush) {
            const aS = Math.max(...eA.cards.map(suitRank));
            const bS = Math.max(...eB.cards.map(suitRank));
            if (aS > bS) return  1;
            if (aS < bS) return -1;
        }
        return 0;
    }

    // Normal comparison: descending card values
    const aVals = eA.cards.map(cardValue);
    const bVals = eB.cards.map(cardValue);
    for (let i = 0; i < Math.min(aVals.length, bVals.length); i++) {
        if (aVals[i] > bVals[i]) return  1;
        if (aVals[i] < bVals[i]) return -1;
    }
    // Flush tie-break: compare suit rank card-by-card (positionally, highest card first)
    if (eA.isFlush && eB.isFlush) {
        for (let i = 0; i < Math.min(eA.cards.length, eB.cards.length); i++) {
            const sa = suitRank(eA.cards[i]), sb = suitRank(eB.cards[i]);
            if (sa > sb) return  1;
            if (sa < sb) return -1;
        }
    }
    return 0;
}

function getEffectiveRank(e, combinedLen) {
    // Flush (rank 5) always beats Straight (rank 4) regardless of combined length.
    // Combined straights no longer get a rank boost above 5.
    return e.rank;
}

function compareHands(handA, handB) {
    if (!handA || !handB || !handA.length || !handB.length) return 0;
    return handA.length === 3
        ? compare3CardHands(handA, handB)
        : compare5CardHands(handA, handB, null, null);
}

// ── PRIMARY VALUE ─────────────────────────────────────────────────
// Returns the value of the most-frequent card (used for same-type ordering)
function primaryValue(cards) {
    const vc = {};
    cards.forEach(c => { const v = cardValue(c); vc[v] = (vc[v]||0)+1; });
    const sorted = Object.entries(vc).sort((a,b) => b[1]-a[1] || b[0]-a[0]);
    return parseInt(sorted[0][0]);
}

const fv = v => v===14?'A':v===13?'K':v===12?'Q':v===11?'J':String(v);

// ── VALIDATE HAND ORDER ───────────────────────────────────────────
// Strength scale:
//   3-card: HC=0, Pair=10, Trips=20
//     (straight/flush in 1st hand = HC for scale — rank 0)
//   5-card: HC=0, Pair=10, TwoPair=20, Trips=30, Straight=40,
//           Flush=50, FullHouse=60, SF=70, Royal=80
//
// Rules:
//   s1 must be <= s2 must be <= s3
//   When same bucket: primary card value must be strictly higher going up
//   Exception: 3-card Trips (s=20) vs 5-card TwoPair (s=20) → invalid (different types same scale)
//   Cross-Trips: 3-card Trips (scale 20) vs 5-card Trips (scale 30) → value must be higher in 2nd
function validateHandOrder(hand1, hand2, hand3) {
    const e1 = evaluate3CardHand(hand1);
    const e2 = evaluate5CardHand(hand2);
    const e3 = evaluate5CardHand(hand3);

    // Scale: 3-card rank 0/1/2 → 0/10/20; 5-card rank 0-8 → 0/10/.../80
    const s1 = e1.rank * 10;
    const s2 = e2.rank * 10;
    const s3 = e3.rank * 10;

    // ── 1st vs 2nd ──────────────────────────────────────────────────
    if (s1 > s2) {
        return `1st hand (${e1.name}) outranks 2nd hand (${e2.name}). Invalid.`;
    }

    if (s1 === s2) {
        // Case: same bucket but different underlying types (3-card Trips=20 vs 5-card TwoPair=20)
        if (e1.name !== e2.name && s1 !== 0) {
            return `1st hand (${e1.name}) and 2nd hand (${e2.name}) have incompatible rankings. Invalid.`;
        }
        // ── FIX: use evaluate().cards which sorts poker-correctly ──────────────
        // (pair cards first, then kickers desc) NOT raw sortDesc which just sorts by value
        // This ensures pair of Qs correctly outranks pair of Js even if Js hand has Ace kicker
        const sorted1 = e1.cards || sortDesc(hand1);
        const sorted2 = e2.cards || sortDesc(hand2);
        const vals1 = sorted1.map(cardValue);
        const vals2 = sorted2.map(cardValue);
        let valueVerdict = 0;
        for (let i = 0; i < Math.min(vals1.length, vals2.length); i++) {
            if (vals2[i] > vals1[i]) { valueVerdict =  1; break; }
            if (vals1[i] > vals2[i]) { valueVerdict = -1; break; }
        }
        if (valueVerdict === -1) {
            return `Both hands ${e1.name} — 2nd hand (${e2.name}) must be stronger than 1st hand (${e1.name}).`;
        }
        if (valueVerdict === 0 && e1.isFlush && e2.isFlush) {
            for (let i = 0; i < Math.min(sorted1.length, sorted2.length); i++) {
                const sv1 = suitRank(sorted1[i]), sv2 = suitRank(sorted2[i]);
                if (sv1 > sv2) return `Both Flush, same card values — 2nd hand suit must outrank 1st (Hearts > Spades > Diamonds > Clubs).`;
                if (sv2 > sv1) break;
            }
        }
    }

    // Cross-boundary Trips: 3-card Trips (s1=20) vs 5-card Trips (s2=30) — value still must go up
    if (e1.rank === 2 && e2.rank === 3) {
        const pv1 = primaryValue(hand1), pv2 = primaryValue(hand2);
        if (pv1 >= pv2)
            return `1st Trips (${fv(pv1)}s) must be lower value than 2nd Trips (${fv(pv2)}s).`;
    }

    // ── 2nd vs 3rd ──────────────────────────────────────────────────
    if (s2 > s3) {
        return `2nd hand (${e2.name}) outranks 3rd hand (${e3.name}). Invalid.`;
    }

    if (s2 === s3) {
        // ── FIX: use evaluate().cards which sorts poker-correctly ──────────────
        // (dominant cards first — pair/trips/etc — then kickers desc)
        const sorted2 = e2.cards || sortDesc(hand2);
        const sorted3 = e3.cards || sortDesc(hand3);
        const vals2 = sorted2.map(cardValue);
        const vals3 = sorted3.map(cardValue);
        let valueVerdict = 0; // -1 = 2nd stronger, 0 = equal, 1 = 3rd stronger
        for (let i = 0; i < Math.min(vals2.length, vals3.length); i++) {
            if (vals3[i] > vals2[i]) { valueVerdict =  1; break; }
            if (vals2[i] > vals3[i]) { valueVerdict = -1; break; }
        }
        if (valueVerdict === -1) {
            return `Both hands ${e2.name} — 3rd hand (${e3.name}) must be stronger than 2nd hand (${e2.name}).`;
        }
        if (valueVerdict === 0 && e2.isFlush && e3.isFlush) {
            for (let i = 0; i < Math.min(sorted2.length, sorted3.length); i++) {
                const sv2 = suitRank(sorted2[i]), sv3 = suitRank(sorted3[i]);
                if (sv2 > sv3) return `Both Flush, same card values — 3rd hand suit must outrank 2nd (Hearts > Spades > Diamonds > Clubs).`;
                if (sv3 > sv2) break;
            }
        }
        // valueVerdict === 1 means 3rd is stronger — valid, fall through
    }

    return null; // valid
}

// ── DETECT SPECIAL ────────────────────────────────────────────────
function detectSpecial(hand1, hand2, hand3) {
    if (!hand1 || !hand2 || !hand3) return null;
    const all = [...hand1, ...hand2, ...hand3];
    if (all.length !== 13) return null;

    // Full Suit (10:1)
    const fs = all[0]?.[1];
    if (fs && all.every(c => c[1] === fs))
        return {name:'Full Suit', multiplier:10, rank:8};

    // 6½ (8:1) — 13 cards form 6 effective pairs + 1 lone card.
    //   Quads (4-of-a-kind) count as 2 pairs (no lone).
    //   Trips (3-of-a-kind) count as 1 pair + 1 lone.
    //   Pairs count as 1 pair (no lone).
    //   Singles count as 1 lone (no pair).
    // Equation: 2*quads + trips + pairs == 6  AND  trips + singles == 1
    // Valid configs: 6 pairs+1 single; 5 pairs+1 trip; 4 pairs+1 quad+1 single;
    //   3 pairs+1 quad+1 trip; 2 pairs+2 quads+1 single; 1 pair+2 quads+1 trip;
    //   3 quads+1 single.
    const vc = {};
    all.forEach(c => { const v = cardValue(c); vc[v] = (vc[v]||0)+1; });
    const ep = Object.values(vc).filter(c => c===2).length;
    const et = Object.values(vc).filter(c => c===3).length;
    const eq = Object.values(vc).filter(c => c===4).length;
    const es = Object.values(vc).filter(c => c===1).length;
    const totalPairs = 2*eq + et + ep;
    const totalLone  = et + es;
    if (totalPairs === 6 && totalLone === 1)
        return {name:'6½', multiplier:8, rank:7};

    // Royal Flush (7:1) — in 2nd or 3rd hand
    const e2 = evaluate5CardHand(hand2);
    const e3 = evaluate5CardHand(hand3);
    if (e2.rank===8 || e3.rank===8)
        return {name:'Royal Flush', multiplier:7, rank:6};

    // FFF — all three hands are flushes (5:1)
    // Check both the submitted arrangement AND whether the 13 raw cards CAN form FFF
    // (handles declaration verification where cards may not be arranged yet)
    const e1 = evaluate3CardHand(hand1);
    const canFFF = (() => {
        // Check submitted arrangement first
        if (e1.isFlush && e2.isFlush && e3.isFlush) return true;
        // Check if raw cards can form FFF via suit grouping
        const bySuit = {};
        all.forEach(c => { bySuit[c[1]] = (bySuit[c[1]]||[]); bySuit[c[1]].push(c); });
        const groups = Object.values(bySuit).filter(g => g.length > 0);
        // 3 suit groups of sizes 3,5,5 in any order
        const sizes = groups.map(g => g.length).sort((a,b)=>a-b);
        if (groups.length === 3 && sizes[0]===3 && sizes[1]===5 && sizes[2]===5) return true;
        // 2 suit groups: one of 3, one of 10 (10 splits into 5+5 same suit)
        if (groups.length === 2 && sizes[0]===3 && sizes[1]===10) return true;
        return false;
    })();
    if (canFFF) return {name:'Flush-Flush-Flush', multiplier:5, rank:5};

    // SSS — all three hands are straights (5:1)
    // Check submitted arrangement; SSS requires player to arrange correctly
    if (e1.isStraight && e2.isStraight && e3.isStraight)
        return {name:'Straight-Straight-Straight', multiplier:5, rank:4};

    // Four of a Kind (3:1) — checked BEFORE Straight Flush (rarer, takes priority)
    if (eq > 0)
        return {name:'Four of a Kind', multiplier:3, rank:2};

    // Straight Flush (3:1) — detect from ALL 13 raw cards, not just arranged hands
    // Rule: 5 or more consecutive cards of the same suit anywhere in the 13 cards
    const hasStraightFlushInRaw = (() => {
        // Group by suit
        const bySuit = {};
        all.forEach(c => {
            const suit = c[1];
            if (!bySuit[suit]) bySuit[suit] = [];
            bySuit[suit].push(c);
        });
        for (const suitCards of Object.values(bySuit)) {
            if (suitCards.length < 5) continue;
            // Get unique values, handle Ace as both 1 and 14
            const vals = [...new Set(suitCards.map(c => cardValue(c)))].sort((a,b)=>a-b);
            // Check for any run of 5+ consecutive values
            let run = 1;
            for (let i = 1; i < vals.length; i++) {
                if (vals[i] === vals[i-1] + 1) {
                    run++;
                    if (run >= 5) return true;
                } else {
                    run = 1;
                }
            }
            // Check Ace-low straight (A-2-3-4-5): Ace=14, so check if 2,3,4,5 present
            if (vals.includes(14)) {
                const lowVals = [1,2,3,4,5];
                const withAceLow = [...new Set([...vals.map(v => v===14?1:v)])].sort((a,b)=>a-b);
                let lowRun = 1;
                for (let i = 1; i < withAceLow.length; i++) {
                    if (withAceLow[i] === withAceLow[i-1] + 1) {
                        lowRun++;
                        if (lowRun >= 5) return true;
                    } else {
                        lowRun = 1;
                    }
                }
            }
        }
        return false;
    })();

    // Also check arranged hands (keeps backward compatibility)
    if (hasStraightFlushInRaw || e2.rank===7 || e3.rank===7)
        return {name:'Straight Flush', multiplier:3, rank:3};

    // Royal Flush from raw cards — A,K,Q,J,10 of same suit anywhere in 13 cards
    // (already checked arranged hands above via e2/e3, also check raw)
    const hasRoyalInRaw = (() => {
        const bySuit = {};
        all.forEach(c => {
            if (!bySuit[c[1]]) bySuit[c[1]] = [];
            bySuit[c[1]].push(c);
        });
        const royalVals = new Set([10,11,12,13,14]); // 10,J,Q,K,A
        for (const suitCards of Object.values(bySuit)) {
            const vals = new Set(suitCards.map(c => cardValue(c)));
            if ([...royalVals].every(v => vals.has(v))) return true;
        }
        return false;
    })();
    if (hasRoyalInRaw && (e2.rank!==8 && e3.rank!==8)) {
        // Royal Flush found in raw but not in arranged hands — still valid
        return {name:'Royal Flush', multiplier:7, rank:6};
    }

    // No Face (2:1)
    if (!hasFaceCard(all))
        return {name:'No Face', multiplier:2, rank:1};

    return null;
}


// ── SPECIAL BONUSES ───────────────────────────────────────────────
// Flat chip bonus awarded ON TOP of the multiplier payout.
// Two tables: standard tables and the $10K VIP tier.
// Use getSpecialBonus(name, isVip) to read the right table.

const SPECIAL_DEFS = [
    { name:'Full Suit',                  multiplier:10, rank:8 },
    { name:'6Â½',                         multiplier:8,  rank:7 },
    { name:'Royal Flush',                multiplier:7,  rank:6 },
    { name:'Flush-Flush-Flush',          multiplier:5,  rank:5 },
    { name:'Straight-Straight-Straight', multiplier:5,  rank:4 },
    { name:'Four of a Kind',             multiplier:3,  rank:2 },
    { name:'Straight Flush',             multiplier:3,  rank:3 },
    { name:'No Face',                    multiplier:2,  rank:1 },
];

function specialDef(name) {
    const found = SPECIAL_DEFS.find(s => s.name === name);
    return found ? { ...found } : null;
}

function valueCounts(cards) {
    const vc = {};
    cards.forEach(c => { const v = cardValue(c); vc[v] = (vc[v] || 0) + 1; });
    return vc;
}

function combinations(arr, size, start = 0, prefix = [], out = []) {
    if (prefix.length === size) {
        out.push([...prefix]);
        return out;
    }
    for (let i = start; i <= arr.length - (size - prefix.length); i++) {
        prefix.push(arr[i]);
        combinations(arr, size, i + 1, prefix, out);
        prefix.pop();
    }
    return out;
}

function remainingCards(cards, used) {
    const usedSet = new Set(used);
    return cards.filter(c => !usedSet.has(c));
}

function cleanArrangement(arrangement) {
    if (!arrangement) return null;
    return {
        hand1: [...arrangement.hand1],
        hand2: [...arrangement.hand2],
        hand3: [...arrangement.hand3],
    };
}

function findArrangementByPredicate(rawCards, predicate) {
    const cards = [...rawCards];
    let fallback = null;
    for (const hand1 of combinations(cards, 3)) {
        const rem10 = remainingCards(cards, hand1);
        for (const hand2 of combinations(rem10, 5)) {
            const hand3 = remainingCards(rem10, hand2);
            if (hand3.length !== 5) continue;
            if (!predicate(hand1, hand2, hand3)) continue;
            const candidate = { hand1, hand2, hand3 };
            if (!fallback) fallback = cleanArrangement(candidate);
            if (validateHandOrder(hand1, hand2, hand3) === null) {
                return cleanArrangement(candidate);
            }
        }
    }
    return fallback;
}

function findArrangementWithFixedHand3(rawCards, fixedHand3) {
    const cards = [...rawCards];
    const rem8 = remainingCards(cards, fixedHand3);
    if (rem8.length !== 8) return null;
    let fallback = null;
    for (const hand1 of combinations(rem8, 3)) {
        const hand2 = remainingCards(rem8, hand1);
        if (hand2.length !== 5) continue;
        const candidate = { hand1, hand2, hand3: fixedHand3 };
        if (!fallback) fallback = cleanArrangement(candidate);
        if (validateHandOrder(hand1, hand2, fixedHand3) === null) {
            return cleanArrangement(candidate);
        }
    }
    return fallback;
}

function straightFlushHands(rawCards) {
    const hands = [];
    const bySuit = {};
    rawCards.forEach(c => {
        const suit = cardSuit(c);
        if (!bySuit[suit]) bySuit[suit] = [];
        bySuit[suit].push(c);
    });
    for (const suitCards of Object.values(bySuit)) {
        if (suitCards.length < 5) continue;
        for (const hand of combinations(suitCards, 5)) {
            const e = evaluate5CardHand(hand);
            if (e.rank === 7 || e.rank === 8) hands.push(sortDesc(hand));
        }
    }
    const seen = new Set();
    return hands
        .filter(hand => {
            const key = [...hand].sort().join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => {
            const ea = evaluate5CardHand(a), eb = evaluate5CardHand(b);
            if (eb.rank !== ea.rank) return eb.rank - ea.rank;
            return straightEffectiveHigh(eb) - straightEffectiveHigh(ea);
        });
}

function findRoyalFlushArrangement(rawCards) {
    for (const hand of straightFlushHands(rawCards)) {
        if (evaluate5CardHand(hand).rank !== 8) continue;
        const arranged = findArrangementWithFixedHand3(rawCards, hand);
        if (arranged) return arranged;
    }
    return null;
}

function findStraightFlushArrangement(rawCards) {
    for (const hand of straightFlushHands(rawCards)) {
        if (evaluate5CardHand(hand).rank !== 7) continue;
        const arranged = findArrangementWithFixedHand3(rawCards, hand);
        if (arranged) return arranged;
    }
    return null;
}

function findFFFArrangement(rawCards) {
    return findArrangementByPredicate(rawCards, (h1, h2, h3) =>
        evaluate3CardHand(h1).isFlush &&
        evaluate5CardHand(h2).isFlush &&
        evaluate5CardHand(h3).isFlush
    );
}

function findSSSArrangement(rawCards) {
    return findArrangementByPredicate(rawCards, (h1, h2, h3) =>
        evaluate3CardHand(h1).isStraight &&
        evaluate5CardHand(h2).isStraight &&
        evaluate5CardHand(h3).isStraight
    );
}

function arrangementForWholeHandSpecial(rawCards) {
    return findBestBotArrangement(rawCards);
}

// Check whether the player's raw 13 cards CAN form the named special.
// Returns the arrangement if yes, null if no.
// This is used by _onDeclareSpecial so that declaring a valid (achievable)
// special is accepted with the declared multiplier — even if the player
// also has a HIGHER unstated special. detectSpecialFromRaw, by contrast,
// returns only the highest available.
function canFormSpecial(rawCards, specialName) {
    if (!rawCards || rawCards.length !== 13) return null;
    const raw = [...rawCards];
    switch (specialName) {
        case 'Full Suit': {
            const firstSuit = cardSuit(raw[0]);
            if (firstSuit && raw.every(c => cardSuit(c) === firstSuit)) {
                return arrangementForWholeHandSpecial(raw);
            }
            return null;
        }
        case '6½': case '6Â½': {
            const vc = valueCounts(raw);
            const counts = Object.values(vc);
            const pairs = counts.filter(c => c === 2).length;
            const trips = counts.filter(c => c === 3).length;
            const quads = counts.filter(c => c === 4).length;
            if (quads === 0 && (pairs === 6 || (pairs === 5 && trips === 1))) {
                return arrangementForWholeHandSpecial(raw);
            }
            return null;
        }
        case 'Royal Flush':                return findRoyalFlushArrangement(raw);
        case 'Flush-Flush-Flush':          return findFFFArrangement(raw);
        case 'Straight-Straight-Straight': return findSSSArrangement(raw);
        case 'Four of a Kind': {
            const vc = valueCounts(raw);
            const quads = Object.values(vc).filter(c => c === 4).length;
            return quads > 0 ? arrangementForWholeHandSpecial(raw) : null;
        }
        case 'Straight Flush':             return findStraightFlushArrangement(raw);
        case 'No Face':                    return !hasFaceCard(raw) ? arrangementForWholeHandSpecial(raw) : null;
        default: return null;
    }
}

function detectSpecialFromRaw(rawCards) {
    if (!rawCards || rawCards.length !== 13) return null;
    const raw = [...rawCards];

    const firstSuit = cardSuit(raw[0]);
    if (firstSuit && raw.every(c => cardSuit(c) === firstSuit)) {
        return { special: specialDef('Full Suit'), arrangement: arrangementForWholeHandSpecial(raw) };
    }

    const vc = valueCounts(raw);
    const counts = Object.values(vc);
    const pairs = counts.filter(c => c === 2).length;
    const trips = counts.filter(c => c === 3).length;
    const quads = counts.filter(c => c === 4).length;
    if (quads === 0 && (pairs === 6 || (pairs === 5 && trips === 1))) {
        return { special: specialDef('6Â½'), arrangement: arrangementForWholeHandSpecial(raw) };
    }

    const royal = findRoyalFlushArrangement(raw);
    if (royal) return { special: specialDef('Royal Flush'), arrangement: royal };

    const fff = findFFFArrangement(raw);
    if (fff) return { special: specialDef('Flush-Flush-Flush'), arrangement: fff };

    const sss = findSSSArrangement(raw);
    if (sss) return { special: specialDef('Straight-Straight-Straight'), arrangement: sss };

    if (quads > 0) {
        return { special: specialDef('Four of a Kind'), arrangement: arrangementForWholeHandSpecial(raw) };
    }

    const sf = findStraightFlushArrangement(raw);
    if (sf) return { special: specialDef('Straight Flush'), arrangement: sf };

    if (!hasFaceCard(raw)) {
        return { special: specialDef('No Face'), arrangement: arrangementForWholeHandSpecial(raw) };
    }

    return null;
}


const SPECIAL_BONUS_VIP = {
    'No Face':                    100000,
    'Four of a Kind':             250000,
    'Straight Flush':             250000,
    'Straight-Straight-Straight': 500000,
    'Flush-Flush-Flush':          500000,
    'Royal Flush':                750000,
    '6½':                         1000000,
    'Full Suit':                  3000000,
};

function getSpecialBonus(specialName, isVip) {
    if (isVip) return SPECIAL_BONUS_VIP[specialName] || 0;
    return SPECIAL_BONUS[specialName] || 0;
}

const SPECIAL_BONUS = {
    'No Face':                    1000,
    'Four of a Kind':             2500,
    'Straight Flush':             2500,
    'Straight-Straight-Straight': 7000,
    'Flush-Flush-Flush':          7000,
    'Royal Flush':                10000,
    '6½':                         15000,
    'Full Suit':                  50000,
};

// Best suit rank across a set of cards (Hearts=4 highest)
function bestSuitRank(cards) {
    return Math.max(...cards.map(suitRank));
}

// Straight Flush tie-break: higher straight wins; suit rank breaks equal straights
function sfTieBreak(handA, handB) {
    const eA = evaluate5CardHand(handA);
    const eB = evaluate5CardHand(handB);
    const hA = straightEffectiveHigh(eA);
    const hB = straightEffectiveHigh(eB);
    if (hA > hB) return  1;
    if (hA < hB) return -1;
    const sA = bestSuitRank(handA), sB = bestSuitRank(handB);
    if (sA > sB) return  1;
    if (sA < sB) return -1;
    return 0;
}

// 6½ Pairs tie-break: find lone (non-paired) card value
function sixHalfExtraCard(cards) {
    const vc = {};
    cards.forEach(c => { const v = cardValue(c); vc[v] = (vc[v]||0)+1; });
    const extra = cards.find(c => vc[cardValue(c)] === 1);
    return extra ? cardValue(extra) : 0;
}

// ── RESOLVE SPECIAL TIE ───────────────────────────────────────────
// Returns 1 if A wins, -1 if B wins, 0 if truly equal
function resolveSpecialTie(special, handsA, handsB) {
    const name = special.name;

    // No Face: banker always wins a tie — caller handles direction
    if (name === 'No Face') return 0; // 0 = banker wins upstream

    // Four of a Kind: suit order on the quad cards
    if (name === 'Four of a Kind') {
        const allA = [...handsA.hand1, ...handsA.hand2, ...handsA.hand3];
        const allB = [...handsB.hand1, ...handsB.hand2, ...handsB.hand3];
        const vcA = {}, vcB = {};
        allA.forEach(c => { const v=cardValue(c); vcA[v]=(vcA[v]||0)+1; });
        allB.forEach(c => { const v=cardValue(c); vcB[v]=(vcB[v]||0)+1; });
        const quadCardsA = allA.filter(c => vcA[cardValue(c)] === 4);
        const quadCardsB = allB.filter(c => vcB[cardValue(c)] === 4);
        const sA = bestSuitRank(quadCardsA), sB = bestSuitRank(quadCardsB);
        if (sA > sB) return  1;
        if (sA < sB) return -1;
        return 0;
    }

    // Straight Flush: larger straight wins; more cards = bigger;
    // find the SF hand in each set and compare
    if (name === 'Straight Flush') {
        const sfA = [handsA.hand2, handsA.hand3].find(h => { const e=evaluate5CardHand(h); return e.rank===7||e.rank===8; }) || handsA.hand3;
        const sfB = [handsB.hand2, handsB.hand3].find(h => { const e=evaluate5CardHand(h); return e.rank===7||e.rank===8; }) || handsB.hand3;
        return sfTieBreak(sfA, sfB);
    }

    // Straight-Straight-Straight / Flush-Flush-Flush: normal hand-to-hand
    if (name === 'Straight-Straight-Straight' || name === 'Flush-Flush-Flush') {
        const r1 = compare3CardHands(handsA.hand1, handsB.hand1);
        const r2 = compare5CardHands(handsA.hand2, handsB.hand2, null, null);
        const r3 = compare5CardHands(handsA.hand3, handsB.hand3, null, null);
        const wins = [r1,r2,r3].filter(r=>r===1).length;
        if (wins >= 2) return  1;
        if (wins === 0) return -1;
        return 0; // banker wins ties
    }

    // Royal Flush: suit order on the Royal hand
    if (name === 'Royal Flush') {
        const rfA = [handsA.hand2, handsA.hand3].find(h => evaluate5CardHand(h).rank===8) || handsA.hand3;
        const rfB = [handsB.hand2, handsB.hand3].find(h => evaluate5CardHand(h).rank===8) || handsB.hand3;
        const sA = bestSuitRank(rfA), sB = bestSuitRank(rfB);
        if (sA > sB) return  1;
        if (sA < sB) return -1;
        return 0;
    }

    // 6½ Pairs: higher extra (lone) card wins
    if (name === '6½') {
        const allA = [...handsA.hand1, ...handsA.hand2, ...handsA.hand3];
        const allB = [...handsB.hand1, ...handsB.hand2, ...handsB.hand3];
        const eA = sixHalfExtraCard(allA), eB = sixHalfExtraCard(allB);
        if (eA > eB) return  1;
        if (eA < eB) return -1;
        return 0;
    }

    // Full Suit: suit order (all cards same suit — compare the suit)
    if (name === 'Full Suit') {
        const allA = [...handsA.hand1, ...handsA.hand2, ...handsA.hand3];
        const allB = [...handsB.hand1, ...handsB.hand2, ...handsB.hand3];
        const sA = bestSuitRank(allA), sB = bestSuitRank(allB);
        if (sA > sB) return  1;
        if (sA < sB) return -1;
        return 0;
    }

    return 0; // banker wins by default
}

// ── RESOLVE ROUND ─────────────────────────────────────────────────
// `isVip` toggles between SPECIAL_BONUS and SPECIAL_BONUS_VIP for bonus values.
// Payouts (bet × multiplier) are unchanged regardless of VIP.
function resolveRound(playerHands, bankerHands, betAmount, playerDeclaredSpecial, bankerDeclaredSpecial, isVip) {
    const ps = playerDeclaredSpecial || null;
    const bs = bankerDeclaredSpecial || null;
    const vip = !!isVip;

    // ── Both have a special ───────────────────────────────────────
    if (ps && bs) {
        let winner;
        if (ps.rank > bs.rank) {
            winner = 'player';
        } else if (bs.rank > ps.rank) {
            winner = 'banker';
        } else {
            // Same special — use tie-break rules
            const tb = resolveSpecialTie(ps, playerHands, bankerHands);
            // tb: 1=player wins, -1=banker wins, 0=banker wins (banker advantage)
            winner = tb === 1 ? 'player' : 'banker';
        }
        const winSpecial  = winner === 'player' ? ps : bs;
        const bonus       = getSpecialBonus(winSpecial.name, vip);
        // payout = pure bet exchange (winner receives bet × multiplier)
        // bonus is ALWAYS paid by the house to the winner — never charged to the loser
        const payout      = winner === 'player'
            ? betAmount * ps.multiplier   // player wins: receives bet × multiplier from banker
            : -(betAmount * bs.multiplier); // banker wins: player pays bet × multiplier to banker
        // Both player & banker bonuses returned so PokerRoom can credit each from the house
        const playerBonus = ps ? getSpecialBonus(ps.name, vip) : 0;
        const bankerBonus = bs ? getSpecialBonus(bs.name, vip) : 0;
        return { playerSpecial:ps, bankerSpecial:bs, payout, bonus, playerBonus, bankerBonus,
                 specialWinner: winner, handResults:null };
    }

    // ── Only player has a special ─────────────────────────────────
    if (ps) {
        const bonus  = getSpecialBonus(ps.name, vip);
        const payout = betAmount * ps.multiplier; // pure bet exchange; bonus paid by house separately
        return { playerSpecial:ps, bankerSpecial:null, payout, bonus, playerBonus:bonus, bankerBonus:0,
                 specialWinner:'player', handResults:null };
    }

    // ── Only banker has a special ─────────────────────────────────
    if (bs) {
        const bonus  = getSpecialBonus(bs.name, vip);
        const payout = -(betAmount * bs.multiplier); // pure bet exchange; house bonus paid to banker separately
        return { playerSpecial:null, bankerSpecial:bs, payout, bonus, playerBonus:0, bankerBonus:bonus,
                 specialWinner:'banker', handResults:null };
    }

    // ── Normal comparison ─────────────────────────────────────────
    const pCombinedLen = longestStraightLength([...playerHands.hand2, ...playerHands.hand3]);
    const bCombinedLen = longestStraightLength([...bankerHands.hand2, ...bankerHands.hand3]);

    const r1 = compare3CardHands(playerHands.hand1, bankerHands.hand1);
    const r2 = compare5CardHands(playerHands.hand2, bankerHands.hand2, pCombinedLen, bCombinedLen);
    const r3 = compare5CardHands(playerHands.hand3, bankerHands.hand3, pCombinedLen, bCombinedLen);

    // Banker wins ties (r===0 → banker wins that hand)
    const playerWins = [r1,r2,r3].filter(r => r === 1).length;

    // Sweep rule: win all 3 → 2× bet; lose all 3 → pay 2× bet; otherwise 1×
    let payout;
    if (playerWins === 3)      payout =  betAmount * 2;
    else if (playerWins === 0) payout = -betAmount * 2;
    else                       payout = playerWins >= 2 ? betAmount : -betAmount;

    // Hand names for UI display
    const n1p = evaluate3CardHand(playerHands.hand1).name;
    const n2p = evaluate5CardHand(playerHands.hand2).name;
    const n3p = evaluate5CardHand(playerHands.hand3).name;
    const n1b = evaluate3CardHand(bankerHands.hand1).name;
    const n2b = evaluate5CardHand(bankerHands.hand2).name;
    const n3b = evaluate5CardHand(bankerHands.hand3).name;

    const handResults = {
        r1, r2, r3,
        names: {
            player: [n1p, n2p, n3p],
            banker: [n1b, n2b, n3b]
        }
    };

    return { playerSpecial:null, bankerSpecial:null, handResults, playerWins, payout, bonus:0 };
}

function disqualifyResult(betAmount) {
    return {disqualified:true, payout: -betAmount};
}

function dealPlayerCards(deck) { return deck.splice(0, 13); }

module.exports = {
    createDeck, shuffleDeck, sortDesc, cardValue, cardSuit, suitRank,
    evaluate3CardHand, evaluate5CardHand, evaluateCombined,
    detectSpecial, validateHandOrder, compareHands,
    compare3CardHands, compare5CardHands,
    resolveRound, resolveSpecialTie, disqualifyResult, dealPlayerCards, hasFaceCard,
    longestStraightLength, getEffectiveRank,
    SPECIAL_BONUS, SPECIAL_BONUS_VIP, getSpecialBonus, bestSuitRank, sixHalfExtraCard
};

// ── BOT ARRANGEMENT ───────────────────────────────────────────────
// Strategy-aware bot arrangement engine.
//
// Core insight: maximising raw card values is wrong. The goal is to
// WIN as many of the 3 hands as possible. This means:
//
//  1. Find all "pattern groups" in the 13 cards (trips, pairs, straights,
//     flushes, etc.) — these are the building blocks.
//  2. Try assigning the BEST pattern to H3, second-best to H2.
//  3. For H1, use the STRONGEST remaining 3 cards — preferring high lone
//     cards (Ace, King) over low ones, since H1 is won by highest card.
//  4. Score arrangements by WIN PROBABILITY per hand, not raw card value.
//     - H3 rank dominates (most impactful hand)
//     - Within the same rank, prefer higher primary card
//     - H1 score = highest card value (Ace >> King >> ...)
//
// Implementation: enumerate candidate "pattern extractions" for H3 and H2,
// then pick the best valid combination, optimising H1 from leftovers.

function findBestBotArrangement(rawCards) {
    const cards = [...rawCards];

    // ── Helpers ────────────────────────────────────────────────────
    function h5rank(h)  { return evaluate5CardHand(h).rank; }
    function h3rank(h)  { return evaluate3CardHand(h).rank; }
    function topVal(h)  { return Math.max(...h.map(cardValue)); }
    function primaryVal(h) { return primaryValue(h); }

    // Straight tiebreak value: wheel=13.5 (2nd highest), others=high card
    function straightTiebreak(e) {
        return isStraightWithAce(e) ? 13.5 : cardValue(e.cards[0]);
    }

    // Card-value tiebreak for a 5-card hand (within same rank)
    function tiebreak5(h) {
        const e = evaluate5CardHand(h);
        if (e.isStraight) return straightTiebreak(e);
        return primaryVal(h);
    }

    // Card-value tiebreak for a 3-card hand (within same rank)
    // H1 is won by highest card — encode all 3 cards so:
    //   A,10,6 scores higher than A,4,3 (10 > 4 on 2nd card)
    //   This ensures when H2 has a pair, H1 gets the best remaining non-pair cards
    function tiebreak3(h) {
        const sorted = sortDesc(h); // highest first
        const v1 = cardValue(sorted[0]);
        const v2 = sorted[1] ? cardValue(sorted[1]) : 0;
        const v3 = sorted[2] ? cardValue(sorted[2]) : 0;
        const topCard = sorted[0];
        // Encode all 3 card values: v1 dominates, then v2, then v3, then suit
        return v1 * 10000 + v2 * 100 + v3 * 10 + suitRank(topCard);
    }

    // Full arrangement score using separated rank vs tiebreak.
    //
    // Priority order (highest to lowest):
    //   1. H3 rank              — hand type dominates above all
    //   2. H2 rank              — second most important
    //   3. H1 rank + top card   — winning H1 breaks ties and wins games
    //   4. H3 card tiebreak     — within same type, higher card is better
    //   5. H2 card tiebreak     — least important
    //
    // H1 sits ABOVE H3 tiebreak because:
    //   Moving an Ace from H3 (9-K-A straight) to H1 costs a minor
    //   tiebreak edge in H3 (A-high vs K-high straight), but gains a
    //   full Ace vs 8 in H1 — dramatically better H1 win chance.
    //   Both H3 straights beat the same range of opponent hands.
    function arrangementScore(h1, h2, h3) {
        const e3rank = evaluate5CardHand(h3).rank;
        const e2rank = evaluate5CardHand(h2).rank;
        const e1     = evaluate3CardHand(h1);
        const h1score = e1.rank * 10000 + tiebreak3(h1); // 0–~114000

        return e3rank   * 1e14    // H3 rank [0-8] step 1e14
             + e2rank   * 1e12    // H2 rank [0-8] step 1e12
             + h1score  * 1e7     // H1 strength [0-~114000] step 1e7 → max ~1.14e12 < 1e12 step ✓
             + tiebreak5(h3) * 1e4  // H3 tiebreak [0-14] step 1e4 → max 1.4e5 < 1e7 ✓
             + tiebreak5(h2);       // H2 tiebreak [0-14] lowest priority
    }

    // All C(10,5) from exactly 10 cards
    function all5from10(arr) {
        const r = [];
        for(let a=0;a<6;a++)
        for(let b=a+1;b<7;b++)
        for(let c=b+1;c<8;c++)
        for(let d=c+1;d<9;d++)
        for(let e=d+1;e<10;e++)
            r.push([arr[a],arr[b],arr[c],arr[d],arr[e]]);
        return r;
    }

    // ── Generate smart H1 candidates from 3 remaining cards ────────
    // After H2/H3 are chosen, pick best 3 from leftover for H1.
    // Best = highest single card (Ace > King > ...), prefer a pair if valid.
    function bestH1from(leftover3) {
        // leftover3 is exactly 3 cards — return them sorted best-first
        return leftover3;
    }

    // ── Generate smart hand1 candidates (3-card) ───────────────────
    // Covers three strategies:
    // A) Weak filler: bottom cards, freeing strong cards for H2/H3
    // B) High lone card: put Ace/King in H1 to win that hand, use rest for H2/H3
    // C) Pair in H1: only when a small pair improves H1 and isn't needed elsewhere
    function hand1Candidates(cards) {
        const byVal = sortDesc(cards); // highest first
        const vc = {};
        cards.forEach(c => vc[c[0]]=(vc[c[0]]||0)+1);
        const candidates = [];

        // Strategy A: all combos from bottom 7 (weak filler)
        const low7 = byVal.slice(-7);
        for(let a=0;a<low7.length-2;a++)
        for(let b=a+1;b<low7.length-1;b++)
        for(let c=b+1;c<low7.length;c++)
            candidates.push([low7[a],low7[b],low7[c]]);

        // Strategy B: high cards as H1 — maximise H1 strength
        // B1: one high card + 2 from the rest (original strategy)
        const top4 = byVal.slice(0,4);
        const bot5 = byVal.slice(-5);
        for(const highCard of top4){
            const rest = bot5.filter(c=>c!==highCard);
            for(let a=0;a<rest.length-1;a++)
            for(let b=a+1;b<rest.length;b++)
                candidates.push([highCard, rest[a], rest[b]]);
        }

        // B2: TWO high cards + 1 from the rest
        // This catches A+K+6, A+10+6, K+Q+5 etc that B1 misses
        // Critical for: when H2 uses a pair with small kickers,
        //               H1 should get the 2 highest remaining non-pair cards
        for(let i=0;i<top4.length-1;i++){
            for(let j=i+1;j<top4.length;j++){
                const hc1=top4[i], hc2=top4[j];
                const rest=byVal.filter(c=>c!==hc1&&c!==hc2);
                for(const kicker of rest)
                    candidates.push([hc1, hc2, kicker]);
            }
        }

        // Strategy C: pair in H1 (only small pairs — strongest pair goes to H2/H3)
        const pairs = Object.entries(vc)
            .filter(([,n])=>n>=2)
            .map(([r])=>r)
            .sort((a,b)=>VALUE_MAP[a]-VALUE_MAP[b]); // lowest pair first
        if(pairs.length>=1){
            const pc = cards.filter(c=>c[0]===pairs[0]).slice(0,2);
            const ot = cards.filter(c=>!pc.includes(c));
            for(const k of sortDesc(ot).slice(-4))
                candidates.push([...pc, k]);
        }

        // Deduplicate
        const seen = new Set();
        return candidates.filter(h => {
            if(!h || h.length!==3) return false;
            const k = [...h].sort().join(',');
            if(seen.has(k)) return false;
            seen.add(k); return true;
        });
    }

    // ── Main search ────────────────────────────────────────────────
    let bestScore = -Infinity;
    let bestH1 = cards.slice(0,3);
    let bestH2 = cards.slice(3,8);
    let bestH3 = cards.slice(8,13);

    for(const h1 of hand1Candidates(cards)){
        const rem = cards.filter(c=>!h1.includes(c));
        if(rem.length!==10) continue;

        const e1  = evaluate3CardHand(h1);
        const e1r = e1.rank;
        const pv1 = e1r>0 ? primaryValue(h1) : 0;

        for(const h2 of all5from10(rem)){
            const h3 = rem.filter(c=>!h2.includes(c));
            if(h3.length!==5) continue;

            // Fast pre-checks
            const e2 = evaluate5CardHand(h2);
            const e3 = evaluate5CardHand(h3);
            if(e1r*10 > e2.rank*10) continue;
            if(e2.rank > e3.rank) continue;
            if(e2.rank===e3.rank){
                if(primaryValue(h2) >= primaryValue(h3)) continue;
            }
            if(e1r===e2.rank && e1r>0 && pv1 >= primaryValue(h2)) continue;

            // Full validation
            if(validateHandOrder(h1,h2,h3) !== null) continue;

            const score = arrangementScore(h1,h2,h3);
            if(score > bestScore){
                bestScore = score;
                bestH1 = [...h1]; bestH2 = [...h2]; bestH3 = [...h3];
            }
        }
    }

    // Fallback: full C(13,3) outer loop if heuristic H1 candidates missed everything
    if(bestScore === -Infinity){
        const allH1 = [];
        for(let a=0;a<cards.length-2;a++)
        for(let b=a+1;b<cards.length-1;b++)
        for(let c=b+1;c<cards.length;c++)
            allH1.push([cards[a],cards[b],cards[c]]);

        for(const h1 of allH1){
            const rem = cards.filter(c=>!h1.includes(c));
            for(const h2 of all5from10(rem)){
                const h3 = rem.filter(c=>!h2.includes(c));
                if(h3.length!==5) continue;
                if(validateHandOrder(h1,h2,h3)!==null) continue;
                const score = arrangementScore(h1,h2,h3);
                if(score>bestScore){
                    bestScore=score;
                    bestH1=[...h1]; bestH2=[...h2]; bestH3=[...h3];
                }
            }
        }
    }

    return { hand1: bestH1, hand2: bestH2, hand3: bestH3 };
}

module.exports.findBestBotArrangement = findBestBotArrangement;

module.exports.SPECIAL_DEFS = SPECIAL_DEFS;
module.exports.detectSpecialFromRaw = detectSpecialFromRaw;
module.exports.canFormSpecial       = canFormSpecial;
module.exports.findSSSArrangement = findSSSArrangement;
module.exports.findFFFArrangement = findFFFArrangement;
module.exports.findRoyalFlushArrangement = findRoyalFlushArrangement;
module.exports.findStraightFlushArrangement = findStraightFlushArrangement;
