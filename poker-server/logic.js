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
        // Same strength bucket
        // Case: both High Card (s=0)
        if (s1 === 0) {
            // 1st hand straight/flush is treated as High Card — compare highest card
            const top1 = Math.max(...hand1.map(cardValue));
            const top2 = Math.max(...hand2.map(cardValue));
            if (top1 > top2)
                return `Both hands High Card — highest card must be in 2nd hand (1st best: ${fv(top1)}, 2nd best: ${fv(top2)}).`;
        }
        // Case: same bucket but different underlying types (3-card Trips=20 vs 5-card TwoPair=20)
        else if (e1.name !== e2.name) {
            return `1st hand (${e1.name}) and 2nd hand (${e2.name}) have incompatible rankings. Invalid.`;
        }
        // Case: same type in same bucket (both Pair, or both Trips)
        else {
            const pv1 = primaryValue(hand1), pv2 = primaryValue(hand2);
            if (pv1 > pv2)
                return `Both hands ${e1.name} — 2nd hand primary (${fv(pv2)}) must be higher than 1st (${fv(pv1)}).`;
            if (pv1 === pv2) {
                // Equal primary values — for flushes check suit ordering
                if (e1.isFlush && e2.isFlush) {
                    const s1cards = sortDesc(hand1), s2cards = sortDesc(hand2);
                    for (let i = 0; i < Math.min(s1cards.length, s2cards.length); i++) {
                        const sv1 = suitRank(s1cards[i]), sv2 = suitRank(s2cards[i]);
                        if (sv1 > sv2) return `Both Flush same values — 2nd hand suit must outrank 1st (Hearts > Spades > Diamonds > Clubs).`;
                        if (sv2 > sv1) break;
                    }
                } else {
                    return `Both hands ${e1.name} — 2nd hand primary (${fv(pv2)}) must be strictly higher than 1st (${fv(pv1)}).`;
                }
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
        if (s2 === 0) {
            const top2 = Math.max(...hand2.map(cardValue));
            const top3 = Math.max(...hand3.map(cardValue));
            if (top2 > top3)
                return `Both hands High Card — highest card must be in 3rd hand (2nd best: ${fv(top2)}, 3rd best: ${fv(top3)}).`;
        } else {
            const pv2 = primaryValue(hand2), pv3 = primaryValue(hand3);
            if (pv2 > pv3)
                return `Both hands ${e2.name} — 3rd hand primary (${fv(pv3)}) must be higher than 2nd (${fv(pv2)}).`;
            // If primary values equal, check suit (Flush tie: higher suit wins, so 3rd must have ≥ suit)
            if (pv2 === pv3 && e2.isFlush && e3.isFlush) {
                // Compare full hand positionally by suit — 3rd must be >= 2nd in suit
                const s2cards = sortDesc(hand2), s3cards = sortDesc(hand3);
                for (let i = 0; i < Math.min(s2cards.length, s3cards.length); i++) {
                    const sv2 = suitRank(s2cards[i]), sv3 = suitRank(s3cards[i]);
                    if (sv2 > sv3) return `Both Flush same values — 3rd hand suit must outrank 2nd (Hearts > Spades > Diamonds > Clubs).`;
                    if (sv3 > sv2) break; // 3rd has higher suit at this position — valid
                }
            } else if (pv2 === pv3) {
                return `Both hands ${e2.name} — 3rd hand primary (${fv(pv3)}) must be strictly higher than 2nd (${fv(pv2)}).`;
            }
        }
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

    // 6½ (8:1) — exactly 6 pairs OR 5 pairs + 1 trips (no quads)
    const vc = {};
    all.forEach(c => { const v = cardValue(c); vc[v] = (vc[v]||0)+1; });
    const ep = Object.values(vc).filter(c => c===2).length;
    const et = Object.values(vc).filter(c => c===3).length;
    const eq = Object.values(vc).filter(c => c===4).length;
    if (eq === 0 && (ep===6 || (ep===5 && et===1)))
        return {name:'6½', multiplier:8, rank:7};

    // Royal Flush (7:1) — in 2nd or 3rd hand
    const e2 = evaluate5CardHand(hand2);
    const e3 = evaluate5CardHand(hand3);
    if (e2.rank===8 || e3.rank===8)
        return {name:'Royal Flush', multiplier:7, rank:6};

    // FFF — all three hands are flushes (5:1)
    const e1 = evaluate3CardHand(hand1);
    if (e1.isFlush && e2.isFlush && e3.isFlush)
        return {name:'Flush-Flush-Flush', multiplier:5, rank:5};

    // SSS — all three hands are straights (5:1)
    if (e1.isStraight && e2.isStraight && e3.isStraight)
        return {name:'Straight-Straight-Straight', multiplier:5, rank:4};

    // Four of a Kind (3:1) — checked BEFORE Straight Flush (rarer, takes priority)
    if (eq > 0)
        return {name:'Four of a Kind', multiplier:3, rank:2};

    // Straight Flush (3:1) — in 2nd or 3rd
    if (e2.rank===7 || e3.rank===7)
        return {name:'Straight Flush', multiplier:3, rank:3};

    // No Face (2:1)
    if (!hasFaceCard(all))
        return {name:'No Face', multiplier:2, rank:1};

    return null;
}

// ── RESOLVE ROUND ─────────────────────────────────────────────────
function resolveRound(playerHands, bankerHands, betAmount, playerDeclaredSpecial, bankerDeclaredSpecial) {
    const ps = playerDeclaredSpecial || null;
    const bs = bankerDeclaredSpecial || null;

    if (ps && bs) {
        const won = ps.rank > bs.rank;
        return {playerSpecial:ps, bankerSpecial:bs, payout: won ? betAmount*ps.multiplier : -(betAmount*bs.multiplier)};
    }
    if (ps) return {playerSpecial:ps, bankerSpecial:null, payout: betAmount * ps.multiplier, handResults:null};
    if (bs) return {playerSpecial:null, bankerSpecial:bs, payout: -(betAmount * bs.multiplier), handResults:null};

    // Normal comparison
    const pCombinedLen = longestStraightLength([...playerHands.hand2, ...playerHands.hand3]);
    const bCombinedLen = longestStraightLength([...bankerHands.hand2, ...bankerHands.hand3]);

    const r1 = compare3CardHands(playerHands.hand1, bankerHands.hand1);
    const r2 = compare5CardHands(playerHands.hand2, bankerHands.hand2, pCombinedLen, bCombinedLen);
    const r3 = compare5CardHands(playerHands.hand3, bankerHands.hand3, pCombinedLen, bCombinedLen);

    // Banker wins ties (r===0 → banker wins)
    const playerWins = [r1,r2,r3].filter(r => r === 1).length;
    // Sweep rule: win all 3 → 2x bet; lose all 3 → pay 2x bet; otherwise 1x
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

    return {playerSpecial:null, bankerSpecial:null, handResults, playerWins, payout};
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
    resolveRound, disqualifyResult, dealPlayerCards, hasFaceCard,
    longestStraightLength, getEffectiveRank
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
    // H1 is won by highest card — Ace = strongest possible H1
    function tiebreak3(h) {
        const e = evaluate3CardHand(h);
        const topCard = sortDesc(h)[0];
        // rank already handled by arrangementScore — just return card strength
        return topVal(h) * 10 + suitRank(topCard);
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

        // Strategy B: high lone card + 2 weak fillers
        // Try each of the top 4 cards paired with 2 of the bottom 5
        const top4 = byVal.slice(0,4);
        const bot5 = byVal.slice(-5);
        for(const highCard of top4){
            const rest = bot5.filter(c=>c!==highCard);
            for(let a=0;a<rest.length-1;a++)
            for(let b=a+1;b<rest.length;b++)
                candidates.push([highCard, rest[a], rest[b]]);
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
