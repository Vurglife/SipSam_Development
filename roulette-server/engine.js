'use strict';

// ─────────────────────────────────────────────────────────────
// VurgLife Roulette — engine.js
// Pure logic: wheel layout, bet validation, payout resolution.
// Supports two variants:
//   american  — 38 pockets (0, 00, 1-36). House edge 5.26%. Allows basket (0-00-1-2-3).
//   european  — 37 pockets (0, 1-36).    House edge 2.70%. No basket, but allows en prison
//               on even-money bets when 0 lands (half-back return).
// No randomness is imported — callers pass in spin results or use spin() helper.
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

// Red/black colouring. 0 and 00 are green.
const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);
const BLACK_NUMBERS = new Set([
  2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35,
]);

// Physical wheel order (not numerical). Used for animation.
const AMERICAN_WHEEL = [
  0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1,
  '00', 27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2,
];
const EUROPEAN_WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

function colorOf(n) {
  if (n === 0 || n === '00') return 'green';
  if (RED_NUMBERS.has(n)) return 'red';
  if (BLACK_NUMBERS.has(n)) return 'black';
  return null;
}

function wheelFor(variant) {
  return variant === 'american' ? AMERICAN_WHEEL : EUROPEAN_WHEEL;
}

function pocketsFor(variant) {
  return variant === 'american'
    ? [0, '00', ...Array.from({ length: 36 }, (_, i) => i + 1)]
    : [0, ...Array.from({ length: 36 }, (_, i) => i + 1)];
}

// Cryptographically random spin. Returns a pocket value (0, '00', or 1-36).
function spin(variant) {
  const wheel = wheelFor(variant);
  const idx = crypto.randomInt(0, wheel.length);
  return wheel[idx];
}

// ─────────────────────────────────────────────────────────────
// BET TYPES
// Each bet: { type, numbers: [...], amount }
// `numbers` is normalized — contains the pocket values the bet covers.
// Payout is "X to 1" — winner receives amount * (payout + 1) total (original + winnings).
// ─────────────────────────────────────────────────────────────

const BET_PAYOUTS = {
  straight: 35,   // 1 number
  split:    17,   // 2 adjacent numbers
  street:   11,   // 3 numbers in a row
  corner:    8,   // 4 numbers in a square
  line:      5,   // 6 numbers in two adjacent rows
  basket:    6,   // American only — 0, 00, 1, 2, 3 (house edge ~7.9%, worst bet)
  column:    2,   // 12 numbers (one of three columns)
  dozen:     2,   // 12 numbers (1-12, 13-24, 25-36)
  red:       1,
  black:     1,
  even:      1,
  odd:       1,
  low:       1,   // 1-18
  high:      1,   // 19-36
};

const BET_LABEL = {
  straight: 'Straight Up',
  split:    'Split',
  street:   'Street',
  corner:   'Corner',
  line:     'Line',
  basket:   'Basket (0-00-1-2-3)',
  column:   'Column',
  dozen:    'Dozen',
  red:      'Red',
  black:    'Black',
  even:     'Even',
  odd:      'Odd',
  low:      '1–18',
  high:     '19–36',
};

// Column groupings (bottom-to-top: col1 = 1,4,7,...,34 etc.)
const COLUMNS = {
  1: [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
  2: [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
  3: [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
};
const DOZENS = {
  1: Array.from({ length: 12 }, (_, i) => i + 1),
  2: Array.from({ length: 12 }, (_, i) => i + 13),
  3: Array.from({ length: 12 }, (_, i) => i + 25),
};

// Build the normalized `numbers` array for any bet descriptor.
// Descriptor forms:
//   { type:'straight', target: 17 }
//   { type:'split',    targets: [1, 2] }
//   { type:'street',   targets: [1, 2, 3] }
//   { type:'corner',   targets: [1, 2, 4, 5] }
//   { type:'line',     targets: [1, 2, 3, 4, 5, 6] }
//   { type:'basket' }                        — american only; fixed [0,'00',1,2,3]
//   { type:'column',   which: 1|2|3 }
//   { type:'dozen',    which: 1|2|3 }
//   { type:'red'|'black'|'even'|'odd'|'low'|'high' }
function normalizeBet(desc, variant) {
  const t = desc.type;
  switch (t) {
    case 'straight': {
      const n = desc.target;
      if (!isValidPocket(n, variant)) throw new Error('Invalid straight target');
      return { type: t, numbers: [n] };
    }
    case 'split': {
      const ns = normalizeTargets(desc.targets, variant, 2, 'Split');
      if (!isValidSplitTargets(ns, variant)) throw new Error('Invalid split shape');
      return { type: t, numbers: [...ns] };
    }
    case 'street': {
      const ns = normalizeTargets(desc.targets, variant, 3, 'Street');
      if (!isValidStreetTargets(ns)) throw new Error('Invalid street shape');
      return { type: t, numbers: [...ns] };
    }
    case 'corner': {
      const ns = normalizeTargets(desc.targets, variant, 4, 'Corner');
      if (!isValidCornerTargets(ns)) throw new Error('Invalid corner shape');
      return { type: t, numbers: [...ns] };
    }
    case 'line': {
      const ns = normalizeTargets(desc.targets, variant, 6, 'Line');
      if (!isValidLineTargets(ns)) throw new Error('Invalid line shape');
      return { type: t, numbers: [...ns] };
    }
    case 'basket': {
      if (variant !== 'american') throw new Error('Basket bet is American only');
      return { type: t, numbers: [0, '00', 1, 2, 3] };
    }
    case 'column': {
      const w = desc.which;
      if (!COLUMNS[w]) throw new Error('Invalid column');
      return { type: t, numbers: [...COLUMNS[w]], which: w };
    }
    case 'dozen': {
      const w = desc.which;
      if (!DOZENS[w]) throw new Error('Invalid dozen');
      return { type: t, numbers: [...DOZENS[w]], which: w };
    }
    case 'red':
      return { type: t, numbers: Array.from(RED_NUMBERS) };
    case 'black':
      return { type: t, numbers: Array.from(BLACK_NUMBERS) };
    case 'even':
      return { type: t, numbers: evensOrOdds(true) };
    case 'odd':
      return { type: t, numbers: evensOrOdds(false) };
    case 'low':
      return { type: t, numbers: Array.from({ length: 18 }, (_, i) => i + 1) };
    case 'high':
      return { type: t, numbers: Array.from({ length: 18 }, (_, i) => i + 19) };
    default:
      throw new Error('Unknown bet type: ' + t);
  }
}

function evensOrOdds(wantEven) {
  const out = [];
  for (let i = 1; i <= 36; i++) {
    const isEven = i % 2 === 0;
    if (wantEven === isEven) out.push(i);
  }
  return out;
}

function isValidPocket(n, variant) {
  if (n === 0) return true;
  if (n === '00') return variant === 'american';
  return Number.isInteger(n) && n >= 1 && n <= 36;
}

function normalizeTargets(targets, variant, count, label) {
  const ns = Array.isArray(targets) ? targets : [];
  if (ns.length !== count) throw new Error(`${label} needs ${count} targets`);
  if (!ns.every((n) => isValidPocket(n, variant))) throw new Error(`Invalid ${label.toLowerCase()} target`);
  const unique = uniquePockets(ns);
  if (unique.length !== ns.length) throw new Error(`Duplicate ${label.toLowerCase()} target`);
  return unique.sort((a, b) => pocketRank(a) - pocketRank(b));
}

function uniquePockets(ns) {
  const out = [];
  for (const n of ns) {
    if (!out.some((x) => samePocket(x, n))) out.push(n);
  }
  return out;
}

function pocketRank(n) {
  if (n === 0) return 0;
  if (n === '00') return 1;
  return n + 1;
}

function isNumericTablePocket(n) {
  return Number.isInteger(n) && n >= 1 && n <= 36;
}

function rowOf(n) {
  return Math.ceil(n / 3);
}

function colOf(n) {
  return ((n - 1) % 3) + 1;
}

function streetForRow(row) {
  const start = ((row - 1) * 3) + 1;
  return [start, start + 1, start + 2];
}

function samePocketSet(a, b) {
  return a.length === b.length && a.every((x) => b.some((y) => samePocket(x, y)));
}

function isValidSplitTargets(ns, variant) {
  const zeroSplits = variant === 'american'
    ? [[0, '00'], [0, 1], [0, 2], ['00', 2], ['00', 3]]
    : [[0, 1], [0, 2], [0, 3]];
  if (ns.some((n) => n === 0 || n === '00')) {
    return zeroSplits.some((pair) => samePocketSet(ns, pair));
  }
  if (!ns.every(isNumericTablePocket)) return false;
  const [a, b] = ns;
  const sameRow = rowOf(a) === rowOf(b) && Math.abs(colOf(a) - colOf(b)) === 1;
  const sameCol = colOf(a) === colOf(b) && Math.abs(rowOf(a) - rowOf(b)) === 1;
  return sameRow || sameCol;
}

function isValidStreetTargets(ns) {
  if (!ns.every(isNumericTablePocket)) return false;
  return samePocketSet(ns, streetForRow(rowOf(ns[0])));
}

function isValidCornerTargets(ns) {
  if (!ns.every(isNumericTablePocket)) return false;
  const rows = [...new Set(ns.map(rowOf))].sort((a, b) => a - b);
  const cols = [...new Set(ns.map(colOf))].sort((a, b) => a - b);
  if (rows.length !== 2 || cols.length !== 2) return false;
  if (rows[1] - rows[0] !== 1 || cols[1] - cols[0] !== 1) return false;
  const expected = [];
  for (const row of rows) {
    for (const col of cols) {
      expected.push(((row - 1) * 3) + col);
    }
  }
  return samePocketSet(ns, expected);
}

function isValidLineTargets(ns) {
  if (!ns.every(isNumericTablePocket)) return false;
  const rows = [...new Set(ns.map(rowOf))].sort((a, b) => a - b);
  const cols = [...new Set(ns.map(colOf))].sort((a, b) => a - b);
  if (rows.length !== 2 || rows[1] - rows[0] !== 1) return false;
  if (cols.length !== 3 || cols[0] !== 1 || cols[1] !== 2 || cols[2] !== 3) return false;
  return samePocketSet(ns, [...streetForRow(rows[0]), ...streetForRow(rows[1])]);
}

// Is this bet an "even-money" outside bet? (relevant for European en-prison rule)
function isEvenMoney(type) {
  return type === 'red' || type === 'black' || type === 'even' || type === 'odd' || type === 'low' || type === 'high';
}

// ─────────────────────────────────────────────────────────────
// RESOLVE BETS
// Given: array of bets (each with .amount and either raw descriptor or normalized),
//        winning pocket, variant.
// Returns: [{ type, amount, won, payout, net, label, numbers }]
//   won   — did this bet hit?
//   payout — total returned to player on win (amount * (ratio + 1)), else 0.
//            On a European zero with an even-money bet, payout = amount/2 (half-back "la partage").
//   net   — payout - amount (positive = profit, negative = loss, 0 = push on half-back).
// ─────────────────────────────────────────────────────────────
function resolveBets(bets, winning, variant) {
  return bets.map((b) => {
    const norm = b.numbers ? b : normalizeBet(b, variant);
    const won = norm.numbers.some((n) => samePocket(n, winning));
    let payout = 0;
    let halfBack = false;
    if (won) {
      payout = b.amount * (BET_PAYOUTS[norm.type] + 1);
    } else if (variant === 'european' && winning === 0 && isEvenMoney(norm.type)) {
      // La partage: zero landed, even-money bet returns half.
      payout = Math.floor(b.amount / 2);
      halfBack = true;
    }
    return {
      type: norm.type,
      label: BET_LABEL[norm.type] || norm.type,
      numbers: norm.numbers,
      amount: b.amount,
      won,
      halfBack,
      payout,
      net: payout - b.amount,
    };
  });
}

function samePocket(a, b) {
  // 0 vs '00' are distinct. String/number mismatches handled.
  if (a === b) return true;
  if (a === 0 && b === 0) return true;
  if (a === '00' && b === '00') return true;
  return String(a) === String(b);
}

// ─────────────────────────────────────────────────────────────
// BET VALIDATION
// Checks tier limits for a collection of bets from one player.
// ─────────────────────────────────────────────────────────────
function validateBets(bets, cfg) {
  let total = 0;
  for (const b of bets) {
    if (!Number.isFinite(b.amount) || b.amount <= 0) {
      return { ok: false, error: 'Invalid bet amount' };
    }
    if (b.amount < cfg.minBet) {
      return { ok: false, error: `Bet below minimum (${cfg.minBet})` };
    }
    if (b.amount > cfg.maxBet) {
      return { ok: false, error: `Bet above maximum (${cfg.maxBet})` };
    }
    total += b.amount;
  }
  if (total > cfg.walletSize) {
    return { ok: false, error: 'Total bet exceeds wallet' };
  }
  return { ok: true, total };
}

module.exports = {
  // constants
  RED_NUMBERS, BLACK_NUMBERS, AMERICAN_WHEEL, EUROPEAN_WHEEL,
  BET_PAYOUTS, BET_LABEL, COLUMNS, DOZENS,
  // helpers
  colorOf, wheelFor, pocketsFor, isValidPocket, isEvenMoney,
  isValidSplitTargets, isValidStreetTargets, isValidCornerTargets, isValidLineTargets,
  // core
  spin, normalizeBet, resolveBets, validateBets,
};
