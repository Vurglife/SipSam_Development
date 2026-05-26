// ============================================================
// SIPSAM SIDE BETS — Best Card implemented (step 3)
// ============================================================
// Source of truth for behaviour: docs/system-development/sidebets-spec.md
//
// Three bets: First Special, Beat Hand, Best Card.
// All wallet-only, no rake, txn-logged. Lifecycle:
//   reveal-phase initiate -> 7s side-bet phase(s) accept ->
//   round-end resolve. Final round + Blitz disable side bets.
//
// THIS COMMIT (step 3): Best Card behaviour — fresh-round only.
// If no participant holds the chosen value at reveal-end, the pot
// is refunded equally (carry-over deferred to step 3b; documented).
// First Special + Beat Hand remain stubs ('not-implemented') until
// steps 4 and 5 respectively.
// ============================================================

'use strict';

const SIDEBET_TYPES = Object.freeze({
    FIRST_SPECIAL: 'firstSpecial',
    BEAT_HAND:     'beatHand',
    BEST_CARD:     'bestCard',
});

const VALID_CARD_VALUES = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUIT_RANK = { H: 4, S: 3, D: 2, C: 1 };   // spec: H > S > D > C

let _potCounter = 0;
function _genPotId(prefix) { _potCounter += 1; return `${prefix}-${_potCounter}`; }

// Card-code helpers. SipSam cards encode as VALUE+SUIT, e.g.
// '7H', '10S', 'AH'. Value can be 1 or 2 chars; suit is the last char.
function _cardValue(card) { return String(card || '').slice(0, -1).toUpperCase(); }
function _cardSuit(card)  { return String(card || '').slice(-1).toUpperCase(); }
function _suitRank(card)  { return SUIT_RANK[_cardSuit(card)] || 0; }

function _findPlayerSid(room, player) {
    if (!room || !player) return null;
    const players = (room.gameState && room.gameState.players) || {};
    for (const k of Object.keys(players)) if (players[k] === player) return k;
    return null;
}

function _deductWallet(player, amount) {
    if (!player) return false;
    const a = Math.max(0, Math.floor(Number(amount) || 0));
    if ((player.chips || 0) < a) return false;
    player.chips = (player.chips || 0) - a;
    return true;
}

function _creditWallet(player, amount) {
    if (!player) return;
    const a = Math.max(0, Math.floor(Number(amount) || 0));
    player.chips = (player.chips || 0) + a;
}

// ── State factory ────────────────────────────────────────────
function emptyState() {
    return {
        firstSpecial: null,
        beatHand:     [],
        bestCard:     [],
        phaseQueue:   [],
        phaseActive:  null,
        phaseTimer:   0,
        initiationsThisRound: {
            firstSpecial: false,
            beatHand:     false,
            bestCard:     false,
        },
    };
}

function resetForNewRound(state) {
    if (!state) return;
    state.initiationsThisRound = {
        firstSpecial: false,
        beatHand:     false,
        bestCard:     false,
    };
    state.phaseQueue  = [];
    state.phaseActive = null;
    state.phaseTimer  = 0;
}

function sideBetsAllowed(gs) {
    if (!gs) return false;
    if (gs.blitz) return false;
    const round = Number(gs.round) || 0;
    const max   = Number(gs.maxRounds) || 0;
    if (max > 0 && round >= max) return false;     // final round
    return true;
}

function publicView(state /*, forSid */) { return state || emptyState(); }

// ── BEST CARD ────────────────────────────────────────────────

function _initiateBestCard(room, player, opts) {
    const value = String((opts && opts.value) || '').toUpperCase();
    if (!VALID_CARD_VALUES.includes(value)) {
        return { ok: false, error: `Invalid card value: ${value || '(empty)'}` };
    }
    const sid = _findPlayerSid(room, player);
    if (!sid) return { ok: false, error: 'Player not seated.' };

    const sb = room.gameState.sideBets;
    if (!sb) return { ok: false, error: 'Side bets uninitialised.' };

    // Spec: one active Best Card pot per initiator at a time.
    const conflict = sb.bestCard.find(p =>
        p.initiatorSid === sid &&
        p.status !== 'resolved' &&
        p.status !== 'refunded'
    );
    if (conflict) return { ok: false, error: 'You already have an active Best Card pot.' };

    const stake = Number(room.gameState.tableMinBet) || 0;
    if (stake <= 0) return { ok: false, error: 'Table min bet not set.' };
    if (!_deductWallet(player, stake)) {
        return { ok: false, error: `Insufficient wallet — need $${stake}.` };
    }

    const pot = {
        id:             _genPotId('bc'),
        type:           'bestCard',
        initiatorSid:   sid,
        value,
        participants:   [{ sid, contributedTotal: stake }],
        pot:            stake,
        status:         'pending_accept',
        initiatedRound: room.gameState.round,
    };
    sb.bestCard.push(pot);
    sb.initiationsThisRound.bestCard = true;
    console.log(`[SIDEBET][BC] ${player.username} initiated pot ${pot.id} value=${value} stake=$${stake}`);
    return { ok: true, potId: pot.id };
}

function _acceptBestCard(room, player, potId) {
    const sid = _findPlayerSid(room, player);
    if (!sid) return { ok: false, error: 'Player not seated.' };

    const sb = room.gameState.sideBets;
    const pot = sb && sb.bestCard.find(p => p.id === potId);
    if (!pot) return { ok: false, error: 'Best Card pot not found.' };
    if (pot.status !== 'pending_accept') return { ok: false, error: 'Pot already locked or resolved.' };
    if (pot.participants.find(p => p.sid === sid)) return { ok: false, error: 'Already in this pot.' };

    const stake = Number(room.gameState.tableMinBet) || 0;
    if (!_deductWallet(player, stake)) {
        return { ok: false, error: `Insufficient wallet — need $${stake}.` };
    }
    pot.participants.push({ sid, contributedTotal: stake });
    pot.pot += stake;
    console.log(`[SIDEBET][BC] ${player.username} accepted pot ${pot.id} pot=$${pot.pot} N=${pot.participants.length}`);
    return { ok: true };
}

function _declineBestCard(/* room, player, potId */) {
    return { ok: true };
}

// At end of the Best Card side-bet phase, lock pots that had accepters
// and refund + drop solo pots (no opponent took the bet).
function _finalizeBestCardPhase(room) {
    const sb = room.gameState.sideBets;
    if (!sb) return;
    for (let i = sb.bestCard.length - 1; i >= 0; i--) {
        const pot = sb.bestCard[i];
        if (pot.status !== 'pending_accept') continue;
        if (pot.participants.length < 2) {
            const init = room.gameState.players[pot.initiatorSid];
            _creditWallet(init, pot.pot);
            pot.status = 'refunded';
            console.log(`[SIDEBET][BC] pot ${pot.id} refunded (no accepters) — $${pot.pot} back to ${init && init.username}`);
            sb.bestCard.splice(i, 1);
        } else {
            pot.status = 'locked';
            console.log(`[SIDEBET][BC] pot ${pot.id} locked — value=${pot.value} pot=$${pot.pot} N=${pot.participants.length}`);
        }
    }
}

// At reveal-end of the round AFTER initiation, resolve every locked
// Best Card pot using each participant's dealt rawCards.
function _resolveBestCardAtRoundEnd(room) {
    const sb = room.gameState.sideBets;
    if (!sb) return [];
    const resolved = [];
    for (const pot of sb.bestCard) {
        if (pot.status !== 'locked') continue;

        let bestSid = null;
        let bestRank = -1;
        for (const part of pot.participants) {
            const p = room.gameState.players[part.sid];
            if (!p) continue;
            const dealt = Array.isArray(p.rawCards) ? p.rawCards : [];
            const copies = dealt.filter(c => _cardValue(c) === pot.value);
            if (copies.length === 0) continue;
            // Spec: if a player holds multiple copies, use their highest-suit.
            const myBest = copies.reduce((a, b) => _suitRank(a) >= _suitRank(b) ? a : b);
            const rank = _suitRank(myBest);
            if (rank > bestRank) {
                bestRank = rank;
                bestSid  = part.sid;
            }
        }

        if (bestSid) {
            const winner = room.gameState.players[bestSid];
            _creditWallet(winner, pot.pot);
            pot.status     = 'resolved';
            pot.winnerSid  = bestSid;
            console.log(`[SIDEBET][BC] pot ${pot.id} resolved — winner=${winner && winner.username} +$${pot.pot}`);
        } else {
            // STEP 3 (this commit): no carry-over yet. Spec calls for the
            // pot to carry to the next round; that state machine is added
            // in step 3b. For now, refund participants equally so no chips
            // are stranded.
            const n = pot.participants.length;
            const each = Math.floor(pot.pot / n);
            const remainder = pot.pot - (each * n);
            pot.participants.forEach((part, idx) => {
                const p = room.gameState.players[part.sid];
                _creditWallet(p, each + (idx === 0 ? remainder : 0));
            });
            pot.status = 'refunded';
            console.log(`[SIDEBET][BC] pot ${pot.id} no winner (value=${pot.value}) — refunded $${pot.pot} across ${n}`);
        }
        resolved.push(pot);
    }
    sb.bestCard = sb.bestCard.filter(p => p.status !== 'resolved' && p.status !== 'refunded');
    return resolved;
}

function _refundBestCardAtGameEnd(room) {
    const sb = room.gameState.sideBets;
    if (!sb) return [];
    const refunded = [];
    for (const pot of sb.bestCard) {
        if (pot.status === 'resolved' || pot.status === 'refunded') continue;
        const n = pot.participants.length || 1;
        const each = Math.floor(pot.pot / n);
        const remainder = pot.pot - (each * n);
        pot.participants.forEach((part, idx) => {
            const p = room.gameState.players[part.sid];
            _creditWallet(p, each + (idx === 0 ? remainder : 0));
        });
        pot.status = 'refunded';
        console.log(`[SIDEBET][BC] game-end refund pot ${pot.id} — $${pot.pot} across ${n}`);
        refunded.push(pot);
    }
    sb.bestCard = sb.bestCard.filter(p => p.status !== 'refunded');
    return refunded;
}

// ── Dispatch ─────────────────────────────────────────────────

function initiate(type, room, player, opts) {
    switch (type) {
        case SIDEBET_TYPES.BEST_CARD: return _initiateBestCard(room, player, opts);
        case SIDEBET_TYPES.FIRST_SPECIAL:
        case SIDEBET_TYPES.BEAT_HAND:
            return { ok: false, error: `Side bet '${type}' not implemented yet.` };
        default:
            return { ok: false, error: `Unknown side bet type: ${type}` };
    }
}

function accept(type, room, player, potId) {
    switch (type) {
        case SIDEBET_TYPES.BEST_CARD: return _acceptBestCard(room, player, potId);
        default: return { ok: false, error: `Accept for '${type}' not implemented yet.` };
    }
}

function decline(type, room, player, potId) {
    switch (type) {
        case SIDEBET_TYPES.BEST_CARD: return _declineBestCard(room, player, potId);
        default: return { ok: true };
    }
}

function finalizePhase(room, phaseType) {
    if (phaseType === SIDEBET_TYPES.BEST_CARD) _finalizeBestCardPhase(room);
}

function resolveAtRoundEnd(room) {
    const resolved = _resolveBestCardAtRoundEnd(room);
    return { resolved, carried: [] };
}

function refundUnwonAtGameEnd(room) {
    const refunded = _refundBestCardAtGameEnd(room);
    return { refunded };
}

module.exports = {
    emptyState,
    resetForNewRound,
    sideBetsAllowed,
    publicView,
    initiate,
    accept,
    decline,
    finalizePhase,
    resolveAtRoundEnd,
    refundUnwonAtGameEnd,
    SIDEBET_TYPES,
    // exported for unit smoke
    _cardValue,
    _cardSuit,
    _suitRank,
};
