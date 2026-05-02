'use strict';

// ─────────────────────────────────────────────────────────────
// VurgLife Blackjack — logic.js
// Pure card logic. No I/O, no state. Fully testable.
// Owner: Amit Ramoutar
// ─────────────────────────────────────────────────────────────

const SUITS  = ['♠', '♣', '♥', '♦'];
const RANKS  = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
// ── Deck ─────────────────────────────────────────────────────
// One standard 52-card deck, freshly shuffled every round.
// No shoe, no multi-deck — guaranteed unique cards each round.

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit, faceDown: false });
    }
  }
  return shuffle(deck);
}

// Keep buildShoe as alias so nothing breaks
function buildShoe() { return buildDeck(); }

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Card Values ───────────────────────────────────────────────

function cardValue(rank) {
  if (['J','Q','K'].includes(rank)) return 10;
  if (rank === 'A') return 11; // aces start high
  return parseInt(rank, 10);
}

function isTenValue(rank) {
  return ['10','J','Q','K'].includes(rank);
}

// ── Hand Calculation ──────────────────────────────────────────

/**
 * Calculate best hand total from visible cards (skips faceDown).
 * Returns { total, isSoft, isBust }
 */
function calcHand(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.faceDown) continue;
    if (c.rank === 'A') { aces++; total += 11; }
    else total += cardValue(c.rank);
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10; aces--;
    if (aces === 0) soft = false;
  }
  return { total, isSoft: soft, isBust: total > 21 };
}

/**
 * Calculate hand total including face-down cards (full dealer hand).
 */
function calcHandFull(cards) {
  const revealed = cards.map(c => ({ ...c, faceDown: false }));
  return calcHand(revealed);
}

// ── Hand Classification ───────────────────────────────────────

function isBlackjack(cards) {
  if (cards.length !== 2) return false;
  const ranks = cards.map(c => c.rank);
  return ranks.includes('A') && ranks.some(r => isTenValue(r));
}

function isPair(cards) {
  return cards.length === 2 && cards[0].rank === cards[1].rank;
}

/**
 * Same 10-value cards can be split (e.g. J+K or 10+Q).
 */
function isTenValuePair(cards) {
  if (cards.length !== 2) return false;
  return cardValue(cards[0].rank) === cardValue(cards[1].rank);
}

function isAcePair(cards) {
  return cards.length === 2 && cards[0].rank === 'A' && cards[1].rank === 'A';
}

// ── Dealer Logic ──────────────────────────────────────────────

/**
 * Dealer stands on soft 17. Hits on anything less.
 */
function dealerShouldHit(cards) {
  const { total, isSoft } = calcHandFull(cards);
  if (total < 17) return true;
  if (total === 17 && isSoft) return false; // stands on soft 17
  return false;
}

// ── Result Resolution ─────────────────────────────────────────

/**
 * Compare player hand vs dealer and return result string.
 * @returns {'blackjack'|'win'|'push'|'lose'|'bust'}
 */
function resolveHand(playerCards, dealerCards, playerBusted) {
  if (playerBusted) return 'bust';

  const playerBJ = isBlackjack(playerCards);
  const dealerBJ = isBlackjack(dealerCards);

  if (playerBJ && dealerBJ) return 'push';
  if (playerBJ) return 'blackjack';
  if (dealerBJ) return 'lose';

  const { total: pTotal }             = calcHandFull(playerCards);
  const { total: dTotal, isBust: dB } = calcHandFull(dealerCards);

  if (dB)           return 'win';
  if (pTotal > dTotal) return 'win';
  if (pTotal === dTotal) return 'push';
  return 'lose';
}

// ── Payout Calculator ─────────────────────────────────────────

/**
 * Calculate total chips to CREDIT back to wallet at payout.
 * The original bet was already deducted from wallet when placed.
 *
 * Blackjack (3:2): returns bet × 2.5  (bet back + 1.5× profit)
 * Win (1:1):       returns bet × 2    (bet back + 1× profit)
 * Push:            returns bet × 1    (bet back, no profit)
 * Lose / Bust:     returns 0          (bet already gone)
 *
 * @returns {number} chips to add to wallet (always >= 0)
 */
function calcPayout(result, bet, insuranceBet = 0, dealerHasBlackjack = false, blackjackPayoutOverride = null) {
  let credit = 0;

  switch (result) {
    case 'blackjack':
      // VIP tiers define a flat blackjack payout; standard uses 3:2 formula
      credit = blackjackPayoutOverride !== null && blackjackPayoutOverride !== undefined
        ? bet + blackjackPayoutOverride         // bet back + flat bonus
        : bet + Math.floor(bet * 1.5);          // 3:2 + bet back
      break;
    case 'win':       credit = bet * 2; break; // 1:1 + bet back
    case 'tie':                                 // tie = push for main bet;
    case 'push':      credit = bet;   break;   // tie bonus handled separately
    case 'lose':
    case 'bust':      credit = 0;     break;   // lose bet
  }

  // Insurance side bet (deducted separately at bet time)
  if (insuranceBet > 0) {
    if (dealerHasBlackjack) credit += insuranceBet * 3; // 2:1 + insurance bet back
    else                    credit += 0;                // insurance lost
  }

  return credit;
}

// ── VurgLife Caribbean Special Bets ──────────────────────────

/**
 * Evaluate all VurgLife special side bets for a player's hand.
 * Called after the third card is dealt (where applicable).
 *
 * @param {Array}  playerCards  - player's current cards
 * @param {string} specialBet   - which special was placed
 * @param {number} sideBetAmt   - amount wagered on the side bet
 * @returns {{ win: boolean, multiplier: number, houseBonus: number, label: string }}
 */
function evalSpecialBet(playerCards, specialBet, sideBetAmt) {
  const none = { win: false, multiplier: 0, houseBonus: 0, label: '' };

  switch (specialBet) {

    case 'island_blackjack': {
      // Blackjack where the Ace AND King are the same suit
      if (playerCards.length !== 2) return none;
      const [c1, c2] = playerCards;
      const hasAce  = (r) => r === 'A';
      const hasKing = (r) => r === 'K';
      const suited  = c1.suit === c2.suit;
      const isIBJ   = suited &&
        ((hasAce(c1.rank) && hasKing(c2.rank)) ||
         (hasKing(c1.rank) && hasAce(c2.rank)));
      return isIBJ
        ? { win: true, multiplier: 3, houseBonus: 500,  label: 'Island Blackjack! 3:1' }
        : none;
    }

    case 'triple_7s': {
      // First 3 cards are all 7s
      if (playerCards.length < 3) return none;
      const first3 = playerCards.slice(0, 3);
      const allSevens = first3.every(c => c.rank === '7');
      return allSevens
        ? { win: true, multiplier: 5, houseBonus: 2500, label: 'Triple 7s! 5:1' }
        : none;
    }

    case 'rum_runner': {
      // First 3 cards total exactly 21, but NOT a blackjack
      if (playerCards.length < 3) return none;
      const first3  = playerCards.slice(0, 3);
      const { total } = calcHandFull(first3);
      const notBJ  = !isBlackjack(playerCards.slice(0, 2));
      return (total === 21 && notBJ)
        ? { win: true, multiplier: 4, houseBonus: 1000, label: 'Rum Runner! 4:1' }
        : none;
    }

    case 'dealer_bust_bonus': {
      // Evaluated at payout time by BlackjackRoom — not here
      return none;
    }

    default:
      return none;
  }
}

/**
 * Evaluate Dealer Bust Bonus — dealer busts with exactly 22.
 */
function evalDealerBustBonus(dealerCards) {
  const { total, isBust } = calcHandFull(dealerCards);
  return isBust && total === 22;
}

// ── Exports ───────────────────────────────────────────────────

module.exports = {
  buildDeck,
  buildShoe,
  shuffle,
  cardValue,
  isTenValue,
  calcHand,
  calcHandFull,
  isBlackjack,
  isPair,
  isTenValuePair,
  isAcePair,
  dealerShouldHit,
  resolveHand,
  calcPayout,
  evalSpecialBet,
  evalDealerBustBonus,
};
