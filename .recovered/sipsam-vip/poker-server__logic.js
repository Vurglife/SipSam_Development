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
// [LINE 301 MISSING — no Read snapshot covers it]
// [LINE 302 MISSING — no Read snapshot covers it]
// [LINE 303 MISSING — no Read snapshot covers it]
// [LINE 304 MISSING — no Read snapshot covers it]
// [LINE 305 MISSING — no Read snapshot covers it]
// [LINE 306 MISSING — no Read snapshot covers it]
// [LINE 307 MISSING — no Read snapshot covers it]
// [LINE 308 MISSING — no Read snapshot covers it]
// [LINE 309 MISSING — no Read snapshot covers it]
// [LINE 310 MISSING — no Read snapshot covers it]
// [LINE 311 MISSING — no Read snapshot covers it]
// [LINE 312 MISSING — no Read snapshot covers it]
// [LINE 313 MISSING — no Read snapshot covers it]
// [LINE 314 MISSING — no Read snapshot covers it]
// [LINE 315 MISSING — no Read snapshot covers it]
// [LINE 316 MISSING — no Read snapshot covers it]
// [LINE 317 MISSING — no Read snapshot covers it]
// [LINE 318 MISSING — no Read snapshot covers it]
// [LINE 319 MISSING — no Read snapshot covers it]
// [LINE 320 MISSING — no Read snapshot covers it]
// [LINE 321 MISSING — no Read snapshot covers it]
// [LINE 322 MISSING — no Read snapshot covers it]
// [LINE 323 MISSING — no Read snapshot covers it]
// [LINE 324 MISSING — no Read snapshot covers it]
// [LINE 325 MISSING — no Read snapshot covers it]
// [LINE 326 MISSING — no Read snapshot covers it]
// [LINE 327 MISSING — no Read snapshot covers it]
// [LINE 328 MISSING — no Read snapshot covers it]
// [LINE 329 MISSING — no Read snapshot covers it]
// [LINE 330 MISSING — no Read snapshot covers it]
// [LINE 331 MISSING — no Read snapshot covers it]
// [LINE 332 MISSING — no Read snapshot covers it]
// [LINE 333 MISSING — no Read snapshot covers it]
// [LINE 334 MISSING — no Read snapshot covers it]
// [LINE 335 MISSING — no Read snapshot covers it]
// [LINE 336 MISSING — no Read snapshot covers it]
// [LINE 337 MISSING — no Read snapshot covers it]
// [LINE 338 MISSING — no Read snapshot covers it]
// [LINE 339 MISSING — no Read snapshot covers it]
// [LINE 340 MISSING — no Read snapshot covers it]
// [LINE 341 MISSING — no Read snapshot covers it]
// [LINE 342 MISSING — no Read snapshot covers it]
// [LINE 343 MISSING — no Read snapshot covers it]
// [LINE 344 MISSING — no Read snapshot covers it]
// [LINE 345 MISSING — no Read snapshot covers it]
// [LINE 346 MISSING — no Read snapshot covers it]
// [LINE 347 MISSING — no Read snapshot covers it]
// [LINE 348 MISSING — no Read snapshot covers it]
// [LINE 349 MISSING — no Read snapshot covers it]
// [LINE 350 MISSING — no Read snapshot covers it]
// [LINE 351 MISSING — no Read snapshot covers it]
// [LINE 352 MISSING — no Read snapshot covers it]
// [LINE 353 MISSING — no Read snapshot covers it]
// [LINE 354 MISSING — no Read snapshot covers it]
// [LINE 355 MISSING — no Read snapshot covers it]
// [LINE 356 MISSING — no Read snapshot covers it]
// [LINE 357 MISSING — no Read snapshot covers it]
// [LINE 358 MISSING — no Read snapshot covers it]
// [LINE 359 MISSING — no Read snapshot covers it]
// [LINE 360 MISSING — no Read snapshot covers it]
// [LINE 361 MISSING — no Read snapshot covers it]
// [LINE 362 MISSING — no Read snapshot covers it]
// [LINE 363 MISSING — no Read snapshot covers it]
// [LINE 364 MISSING — no Read snapshot covers it]
// [LINE 365 MISSING — no Read snapshot covers it]
// [LINE 366 MISSING — no Read snapshot covers it]
// [LINE 367 MISSING — no Read snapshot covers it]
// [LINE 368 MISSING — no Read snapshot covers it]
// [LINE 369 MISSING — no Read snapshot covers it]
// [LINE 370 MISSING — no Read snapshot covers it]
// [LINE 371 MISSING — no Read snapshot covers it]
// [LINE 372 MISSING — no Read snapshot covers it]
// [LINE 373 MISSING — no Read snapshot covers it]
// [LINE 374 MISSING — no Read snapshot covers it]
// [LINE 375 MISSING — no Read snapshot covers it]
// [LINE 376 MISSING — no Read snapshot covers it]
// [LINE 377 MISSING — no Read snapshot covers it]
// [LINE 378 MISSING — no Read snapshot covers it]
// [LINE 379 MISSING — no Read snapshot covers it]
// [LINE 380 MISSING — no Read snapshot covers it]
// [LINE 381 MISSING — no Read snapshot covers it]
// [LINE 382 MISSING — no Read snapshot covers it]
// [LINE 383 MISSING — no Read snapshot covers it]
// [LINE 384 MISSING — no Read snapshot covers it]
// [LINE 385 MISSING — no Read snapshot covers it]
// [LINE 386 MISSING — no Read snapshot covers it]
// [LINE 387 MISSING — no Read snapshot covers it]
// [LINE 388 MISSING — no Read snapshot covers it]
// [LINE 389 MISSING — no Read snapshot covers it]
// [LINE 390 MISSING — no Read snapshot covers it]
// [LINE 391 MISSING — no Read snapshot covers it]
// [LINE 392 MISSING — no Read snapshot covers it]
// [LINE 393 MISSING — no Read snapshot covers it]
// [LINE 394 MISSING — no Read snapshot covers it]
// [LINE 395 MISSING — no Read snapshot covers it]
// [LINE 396 MISSING — no Read snapshot covers it]
// [LINE 397 MISSING — no Read snapshot covers it]
// [LINE 398 MISSING — no Read snapshot covers it]
// [LINE 399 MISSING — no Read snapshot covers it]

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
    // Check submitted arrangement first, then check if raw cards CAN form SSS
    const canSSS = (() => {
        // Check submitted arrangement
        if (e1.isStraight && e2.isStraight && e3.isStraight) return true;
        // Check if all 13 raw cards can be split into 3+5+5 straights
        // Strategy: try all combinations of picking 3 cards that form a straight,
        // then check if the remaining 10 can split into two 5-card straights
        const vals = all.map(c => ({ card: c, val: cardValue(c) }));
        // Generate all combos of 3 cards from 13
        for (let i = 0; i < 13; i++) {
            for (let j = i+1; j < 13; j++) {
                for (let k = j+1; k < 13; k++) {
                    const h1Cards = [vals[i].card, vals[j].card, vals[k].card];
                    const h1Vals  = [vals[i].val, vals[j].val, vals[k].val];
                    if (!checkStraight(h1Vals)) continue;
                    // Remaining 10 cards — try all ways to split into 5+5
                    const rem = vals.filter((_, idx) => idx !== i && idx !== j && idx !== k);
                    // Generate all combos of 5 from remaining 10
                    for (let a = 0; a < 10; a++) {
                        for (let b = a+1; b < 10; b++) {
                            for (let c = b+1; c < 10; c++) {
                                for (let d = c+1; d < 10; d++) {
                                    for (let e = d+1; e < 10; e++) {
                                        const h2Vals = [rem[a].val, rem[b].val, rem[c].val, rem[d].val, rem[e].val];
                                        if (!checkStraight(h2Vals)) continue;
                                        const h3Idxs = new Set([a,b,c,d,e]);
                                        const h3Vals = rem.filter((_,idx) => !h3Idxs.has(idx)).map(v => v.val);
                                        if (checkStraight(h3Vals)) return true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return false;
    })();
    if (canSSS) return {name:'Straight-Straight-Straight', multiplier:5, rank:4};

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

// ── SPECIAL BONUSES ───────────────────────────────────────────────
// Flat chip bonus awarded ON TOP of the multiplier payout
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

// Best suit rank across a set of cards (Hearts=4 highest)
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
// Flat chip bonus awarded ON TOP of the multiplier payout
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
function resolveRound(playerHands, bankerHands, betAmount, playerDeclaredSpecial, bankerDeclaredSpecial, isVip) {
    const ps = playerDeclaredSpecial || null;
    const bs = bankerDeclaredSpecial || null;

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
        // BOTH players get their own special's bonus from the house — independent of who wins
        const playerBonus = getSpecialBonus(ps.name, isVip);
        const bankerBonus = getSpecialBonus(bs.name, isVip);
        // payout = pure bet exchange (winner receives bet × multiplier)
        const payout      = winner === 'player'
            ? betAmount * ps.multiplier   // player wins: receives bet × multiplier from banker
            : -(betAmount * bs.multiplier); // banker wins: player pays bet × multiplier to banker
        return { playerSpecial:ps, bankerSpecial:bs, payout,
                 playerBonus, bankerBonus,
                 specialWinner: winner, handResults:null };
    }

    // ── Only player has a special ─────────────────────────────────
    if (ps) {
        const playerBonus = getSpecialBonus(ps.name, isVip);
        const payout = betAmount * ps.multiplier; // pure bet exchange; bonus paid by house separately
        return { playerSpecial:ps, bankerSpecial:null, payout,
                 playerBonus, bankerBonus: 0,
module.exports = {
    createDeck, shuffleDeck, sortDesc, cardValue, cardSuit, suitRank,
    evaluate3CardHand, evaluate5CardHand, evaluateCombined,
    detectSpecial, validateHandOrder, compareHands,
    compare3CardHands, compare5CardHands,
    resolveRound, resolveSpecialTie, disqualifyResult, dealPlayerCards, hasFaceCard,
    longestStraightLength, getEffectiveRank,
    SPECIAL_BONUS, SPECIAL_BONUS_VIP, getSpecialBonus, bestSuitRank, sixHalfExtraCard,
    findSSSArrangement, findFFFArrangement,
    findStraightFlushArrangement, findRoyalFlushArrangement,
    canFormSpecial
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

// Find a valid SSS arrangement from 13 raw cards → { hand1:[3], hand2:[5], hand3:[5] } or null
function findSSSArrangement(rawCards) {
    if (!rawCards || rawCards.length !== 13) return null;
    const vals = rawCards.map(c => ({ card: c, val: cardValue(c) }));
    for (let i = 0; i < 13; i++) {
        for (let j = i+1; j < 13; j++) {
            for (let k = j+1; k < 13; k++) {
                const h1Cards = [vals[i].card, vals[j].card, vals[k].card];
                const h1Vals  = [vals[i].val, vals[j].val, vals[k].val];
                if (!checkStraight(h1Vals)) continue;
                const rem = vals.filter((_, idx) => idx !== i && idx !== j && idx !== k);
                for (let a = 0; a < 10; a++) {
                    for (let b = a+1; b < 10; b++) {
                        for (let c = b+1; c < 10; c++) {
                            for (let d = c+1; d < 10; d++) {
                                for (let e = d+1; e < 10; e++) {
                                    const h2Cards = [rem[a].card, rem[b].card, rem[c].card, rem[d].card, rem[e].card];
                                    const h2Vals  = [rem[a].val, rem[b].val, rem[c].val, rem[d].val, rem[e].val];
                                    if (!checkStraight(h2Vals)) continue;
                                    const h3Set = new Set([a,b,c,d,e]);
                                    const h3Cards = rem.filter((_,idx) => !h3Set.has(idx)).map(v => v.card);
                                    const h3Vals  = rem.filter((_,idx) => !h3Set.has(idx)).map(v => v.val);
                                    if (checkStraight(h3Vals)) {
                                        // Sort each hand by value descending for clean display
                                        const sort3 = arr => [...arr].sort((a,b) => cardValue(b) - cardValue(a));
                                        const sort5 = arr => [...arr].sort((a,b) => cardValue(b) - cardValue(a));
                                        return { hand1: sort3(h1Cards), hand2: sort5(h2Cards), hand3: sort5(h3Cards) };
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return null;
}

// Find a valid FFF arrangement from 13 raw cards → { hand1:[3], hand2:[5], hand3:[5] } or null
function findFFFArrangement(rawCards) {
    if (!rawCards || rawCards.length !== 13) return null;
    const bySuit = {};
    rawCards.forEach(c => { bySuit[c[1]] = (bySuit[c[1]]||[]); bySuit[c[1]].push(c); });
    const groups = Object.values(bySuit).filter(g => g.length > 0);
    const sizes = groups.map(g => g.length).sort((a,b) => a-b);
    // Need exactly 3+5+5 from suit groups
    if (groups.length === 3 && sizes[0] === 3 && sizes[1] === 5 && sizes[2] === 5) {
        const sorted = groups.sort((a,b) => a.length - b.length);
        return { hand1: sorted[0], hand2: sorted[1], hand3: sorted[2] };
    }
    if (groups.length === 2 && sizes[0] === 3 && sizes[1] === 10) {
        const small = groups.find(g => g.length === 3);
        const big   = groups.find(g => g.length === 10);
        return { hand1: small, hand2: big.slice(0,5), hand3: big.slice(5,10) };
    }
    return null;
}

// Find a valid SSS arrangement from 13 raw cards → { hand1:[3], hand2:[5], hand3:[5] } or null
function findSSSArrangement(rawCards) {
    if (!rawCards || rawCards.length !== 13) return null;
    const vals = rawCards.map(c => ({ card: c, val: cardValue(c) }));
    for (let i = 0; i < 13; i++) {
        for (let j = i+1; j < 13; j++) {
            for (let k = j+1; k < 13; k++) {
                const h1Cards = [vals[i].card, vals[j].card, vals[k].card];
                const h1Vals  = [vals[i].val, vals[j].val, vals[k].val];
                if (!checkStraight(h1Vals)) continue;
                const rem = vals.filter((_, idx) => idx !== i && idx !== j && idx !== k);
                for (let a = 0; a < 10; a++) {
                    for (let b = a+1; b < 10; b++) {
                        for (let c = b+1; c < 10; c++) {
                            for (let d = c+1; d < 10; d++) {
                                for (let e = d+1; e < 10; e++) {
                                    const h2Cards = [rem[a].card, rem[b].card, rem[c].card, rem[d].card, rem[e].card];
                                    const h2Vals  = [rem[a].val, rem[b].val, rem[c].val, rem[d].val, rem[e].val];
                                    if (!checkStraight(h2Vals)) continue;
                                    const h3Set = new Set([a,b,c,d,e]);
                                    const h3Cards = rem.filter((_,idx) => !h3Set.has(idx)).map(v => v.card);
                                    const h3Vals  = rem.filter((_,idx) => !h3Set.has(idx)).map(v => v.val);
                                    if (checkStraight(h3Vals)) {
                                        // Sort each hand by value descending for clean display
                                        const sort3 = arr => [...arr].sort((a,b) => cardValue(b) - cardValue(a));
                                        const sort5 = arr => [...arr].sort((a,b) => cardValue(b) - cardValue(a));
                                        return { hand1: sort3(h1Cards), hand2: sort5(h2Cards), hand3: sort5(h3Cards) };
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return null;
}

// Find a valid FFF arrangement from 13 raw cards → { hand1:[3], hand2:[5], hand3:[5] } or null
function findFFFArrangement(rawCards) {
    if (!rawCards || rawCards.length !== 13) return null;
    const bySuit = {};
    rawCards.forEach(c => { bySuit[c[1]] = (bySuit[c[1]]||[]); bySuit[c[1]].push(c); });
    const groups = Object.values(bySuit).filter(g => g.length > 0);
    const sizes = groups.map(g => g.length).sort((a,b) => a-b);
    // Need exactly 3+5+5 from suit groups
    if (groups.length === 3 && sizes[0] === 3 && sizes[1] === 5 && sizes[2] === 5) {
        const sorted = groups.sort((a,b) => a.length - b.length);
        return { hand1: sorted[0], hand2: sorted[1], hand3: sorted[2] };
    }
    if (groups.length === 2 && sizes[0] === 3 && sizes[1] === 10) {
        const small = groups.find(g => g.length === 3);
        const big   = groups.find(g => g.length === 10);
        return { hand1: small, hand2: big.slice(0,5), hand3: big.slice(5,10) };
    }
    return null;
}

function dealPlayerCards(deck) { return deck.splice(0, 13); }

// ── CAN FORM SPECIFIC SPECIAL ─────────────────────────────────────
// Unlike detectSpecial (which returns the single highest-priority special),
// this checks whether the declared special specifically CAN be formed from
// the raw 13 cards — regardless of whether other (higher-ranked) specials
// could also exist. Used for player declarations: if the player declares
// Straight Flush and the hand has both SF + SSS, they keep their SF (lower
// multiplier but that's their choice).
function canFormSpecial(rawCards, specialName) {
    if (!rawCards || rawCards.length !== 13) return false;

    const vc = {};
    rawCards.forEach(c => { const v = cardValue(c); vc[v] = (vc[v]||0)+1; });
    const bySuit = {};
    rawCards.forEach(c => { if (!bySuit[c[1]]) bySuit[c[1]] = []; bySuit[c[1]].push(c); });

    switch (specialName) {
        case 'Full Suit': {
            const fs = rawCards[0][1];
            return rawCards.every(c => c[1] === fs);
        }
        case '6½': {
            const ep = Object.values(vc).filter(c => c===2).length;
            const et = Object.values(vc).filter(c => c===3).length;
            const eq = Object.values(vc).filter(c => c===4).length;
            return eq === 0 && (ep === 6 || (ep === 5 && et === 1));
        }
        case 'Royal Flush': {
            for (const suitCards of Object.values(bySuit)) {
                const vals = new Set(suitCards.map(c => cardValue(c)));
                if ([10,11,12,13,14].every(v => vals.has(v))) return true;
            }
            return false;
        }
        case 'Flush-Flush-Flush': {
            return findFFFArrangement(rawCards) !== null;
        }
        case 'Straight-Straight-Straight': {
            return findSSSArrangement(rawCards) !== null;
        }
        case 'Four of a Kind': {
            return Object.values(vc).some(c => c === 4);
        }
        case 'Straight Flush': {
            // Any 5+ consecutive cards of the same suit anywhere in 13
            for (const suitCards of Object.values(bySuit)) {
                if (suitCards.length < 5) continue;
                const vals = [...new Set(suitCards.map(c => cardValue(c)))].sort((a,b)=>a-b);
                let run = 1;
                for (let i = 1; i < vals.length; i++) {
                    if (vals[i] === vals[i-1] + 1) {
                        run++;
                        if (run >= 5) return true;
                    } else run = 1;
                }
                // Ace-low A-2-3-4-5
                if (vals.includes(14)) {
                    const lowVals = [...new Set(vals.map(v => v===14?1:v))].sort((a,b)=>a-b);
                    let lr = 1;
                    for (let i = 1; i < lowVals.length; i++) {
                        if (lowVals[i] === lowVals[i-1] + 1) {
                            lr++;
                            if (lr >= 5) return true;
                        } else lr = 1;
                    }
                }
            }
            return false;
        }
        case 'No Face': {
            return !rawCards.some(c => ['J','Q','K'].includes(c[0]));
        }
        default:
            return false;
    }
}

// Find a valid Straight Flush arrangement — returns {hand1:[3], hand2:[5], hand3:[5]}
// where one of hand2/hand3 is the straight flush; other hands are filled from
// remaining cards (arranged weakest-to-strongest to satisfy hand-order rules).
function findStraightFlushArrangement(rawCards) {
    if (!rawCards || rawCards.length !== 13) return null;
    const bySuit = {};
    rawCards.forEach(c => { if (!bySuit[c[1]]) bySuit[c[1]] = []; bySuit[c[1]].push(c); });

    // Find the 5-card straight flush (use highest run of 5 in any suit)
    let sfCards = null;
    for (const suitCards of Object.values(bySuit)) {
        if (suitCards.length < 5) continue;
        // Sort suit cards by value
        const sorted = [...suitCards].sort((a,b) => cardValue(a) - cardValue(b));
        // Find any run of ≥5 consecutive values
        for (let start = 0; start <= sorted.length - 5; start++) {
            let ok = true;
            for (let k = 1; k < 5; k++) {
                if (cardValue(sorted[start+k]) !== cardValue(sorted[start+k-1]) + 1) { ok = false; break; }
            }
            if (ok) { sfCards = sorted.slice(start, start+5); break; }
        }
        if (sfCards) break;
        // Ace-low A-2-3-4-5
        const vals = sorted.map(cardValue);
        if (vals.includes(14) && vals.includes(2) && vals.includes(3) && vals.includes(4) && vals.includes(5)) {
            const ace = sorted.find(c => cardValue(c) === 14);
            const low = [2,3,4,5].map(v => sorted.find(c => cardValue(c) === v));
            sfCards = [ace, ...low];
            break;
        }
    }
    if (!sfCards) return null;

    // Remaining 8 cards split 3+5 (hand1 weakest, hand2 or hand3 gets SF)
    const remaining = rawCards.filter(c => !sfCards.includes(c));
    // Sort remaining by value asc — weakest 3 → hand1, next 5 → other hand
    const remSorted = [...remaining].sort((a,b) => cardValue(a) - cardValue(b));
    const hand1 = remSorted.slice(0, 3);
    const otherHand = remSorted.slice(3, 8);

    // SF goes in hand3 (strongest); otherHand in hand2
    return { hand1, hand2: otherHand, hand3: sfCards };
}

// Find a valid Royal Flush arrangement — royal goes in hand3
function findRoyalFlushArrangement(rawCards) {
    if (!rawCards || rawCards.length !== 13) return null;
    const bySuit = {};
    rawCards.forEach(c => { if (!bySuit[c[1]]) bySuit[c[1]] = []; bySuit[c[1]].push(c); });
    let royalCards = null;
    for (const suitCards of Object.values(bySuit)) {
        const byVal = {};
        suitCards.forEach(c => byVal[cardValue(c)] = c);
        if ([10,11,12,13,14].every(v => byVal[v])) {
            royalCards = [10,11,12,13,14].map(v => byVal[v]);
            break;
        }
    }
    if (!royalCards) return null;
    const remaining = rawCards.filter(c => !royalCards.includes(c));
    const remSorted = [...remaining].sort((a,b) => cardValue(a) - cardValue(b));
    return { hand1: remSorted.slice(0,3), hand2: remSorted.slice(3,8), hand3: royalCards };
}

module.exports = {
    createDeck, shuffleDeck, sortDesc, cardValue, cardSuit, suitRank,
    evaluate3CardHand, evaluate5CardHand, evaluateCombined,
    detectSpecial, validateHandOrder, compareHands,
    compare3CardHands, compare5CardHands,
    resolveRound, resolveSpecialTie, disqualifyResult, dealPlayerCards, hasFaceCard,
    longestStraightLength, getEffectiveRank,
    SPECIAL_BONUS, SPECIAL_BONUS_VIP, getSpecialBonus, bestSuitRank, sixHalfExtraCard,
    findSSSArrangement, findFFFArrangement