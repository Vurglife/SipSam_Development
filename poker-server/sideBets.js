// ============================================================
// SIPSAM SIDE BETS
// ============================================================
// Source of truth for behaviour: docs/system-development/sidebets-spec.md
//
// Three bets: First Special, Beat Hand, Best Card.
// All wallet-only, no rake, txn-logged. Lifecycle:
//   reveal-phase initiate -> 7s side-bet phase(s) accept ->
//   round-end resolve. Final round + Blitz disable side bets.
//
// Implemented bets:
//   First Special: table-wide multi-round pot, ranked declaration wins.
//   Beat Hand: targeted player-vs-player best-of-3 challenge.
//   Best Card: chosen value, suit tiebreak H>S>D>C, fresh-round only.
// If no participant holds the chosen Best Card value at reveal-end, the
// pot is refunded equally; carry-over remains deferred.
// ============================================================

'use strict';

const Logic = require('./logic.js');     // for Beat Hand hand-comparison

const SIDEBET_TYPES = Object.freeze({
    FIRST_SPECIAL: 'firstSpecial',
    BEAT_HAND:     'beatHand',
    BEST_CARD:     'bestCard',
});

const VALID_CARD_VALUES = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUIT_RANK = { H: 4, S: 3, D: 2, C: 1 };   // spec: H > S > D > C

// Special ranks — mirrored from logic.js SPECIAL_DEFS so this module
// stays self-contained. Higher rank wins the First Special tie-break.
// Keep in sync with poker-server/logic.js if specials are added.
const SPECIAL_RANK_BY_NAME = {
    'Full Suit':                  8,
    '6½':                         7,
    '6Â½':                        7,  // mojibake fallback present in older code
    'Royal Flush':                6,
    'Flush-Flush-Flush':          5,
    'Straight-Straight-Straight': 4,
    'Straight Flush':             3,
    'Four of a Kind':             2,
    'No Face':                    1,
};
function _specialRank(name) {
    return SPECIAL_RANK_BY_NAME[String(name || '')] || 0;
}

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

function _recordWalletTxn(room, player, type, amount, ref, desc) {
    if (room && typeof room.recordSideBetTransaction === 'function') {
        room.recordSideBetTransaction(player, type, amount, ref, desc);
    }
}

function _deductWallet(player, amount, room, ref, desc) {
    if (!player) return false;
    const a = Math.max(0, Math.floor(Number(amount) || 0));
    if ((player.chips || 0) < a) return false;
    player.chips = (player.chips || 0) - a;
    _recordWalletTxn(room, player, 'side_bet_buy_in', -a, ref, desc);
    return true;
}

function _creditWallet(player, amount, room, type, ref, desc) {
    if (!player) return;
    const a = Math.max(0, Math.floor(Number(amount) || 0));
    player.chips = (player.chips || 0) + a;
    _recordWalletTxn(room, player, type || 'side_bet_payout', a, ref, desc);
}

function _refundWallet(player, amount, room, ref, desc) {
    _creditWallet(player, amount, room, 'side_bet_refund', ref, desc);
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
    // First Special: per-round declaration log resets each round so
    // resolution only considers declarations made this round.
    if (state.firstSpecial) state.firstSpecial.declarationsThisRound = [];
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
    const potId = _genPotId('bc');
    if (!_deductWallet(player, stake, room, `bestCard:${potId}`, `Best Card ${value} buy-in`)) {
        return { ok: false, error: `Insufficient wallet — need $${stake}.` };
    }

    const pot = {
        id:             potId,
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
    // Defence in depth — every accept path re-checks pendingExit + the
    // sideBetsAllowed gate so a future caller bypassing PokerRoom's WS
    // handlers can't sneak through.
    if (player && player.pendingExit) return { ok: false, error: 'You are exiting — accept blocked.' };
    if (!sideBetsAllowed(room.gameState)) return { ok: false, error: 'Side bets disabled this round.' };

    const sb = room.gameState.sideBets;
    const pot = sb && sb.bestCard.find(p => p.id === potId);
    if (!pot) return { ok: false, error: 'Best Card pot not found.' };
    if (pot.status !== 'pending_accept') return { ok: false, error: 'Pot already locked or resolved.' };
    if (pot.participants.find(p => p.sid === sid)) return { ok: false, error: 'Already in this pot.' };

    const stake = Number(room.gameState.tableMinBet) || 0;
    if (!_deductWallet(player, stake, room, `bestCard:${pot.id}`, `Best Card ${pot.value} accept`)) {
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
            _refundWallet(init, pot.pot, room, `bestCard:${pot.id}`, 'Best Card refund - no accepters');
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
            _creditWallet(winner, pot.pot, room, 'side_bet_payout', `bestCard:${pot.id}`, `Best Card ${pot.value} payout`);
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
                _refundWallet(p, each + (idx === 0 ? remainder : 0), room, `bestCard:${pot.id}`, 'Best Card refund - no matching card');
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
            _refundWallet(p, each + (idx === 0 ? remainder : 0), room, `bestCard:${pot.id}`, 'Best Card game-end refund');
        });
        pot.status = 'refunded';
        console.log(`[SIDEBET][BC] game-end refund pot ${pot.id} — $${pot.pot} across ${n}`);
        refunded.push(pot);
    }
    sb.bestCard = sb.bestCard.filter(p => p.status !== 'refunded');
    return refunded;
}

// ── FIRST SPECIAL ────────────────────────────────────────────
// One pot per table (game). Multi-round: participants top up minBet
// at the start of every round while the bet is locked, until someone
// correctly declares a Special or the game ends. Bots auto-decline.

function _initiateFirstSpecial(room, player /*, opts */) {
    const sid = _findPlayerSid(room, player);
    if (!sid) return { ok: false, error: 'Player not seated.' };
    const sb = room.gameState.sideBets;
    if (!sb) return { ok: false, error: 'Side bets uninitialised.' };
    if (sb.firstSpecial &&
        sb.firstSpecial.status !== 'resolved' &&
        sb.firstSpecial.status !== 'refunded') {
        return { ok: false, error: 'A First Special pot is already active.' };
    }
    const stake = Number(room.gameState.tableMinBet) || 0;
    if (stake <= 0) return { ok: false, error: 'Table min bet not set.' };
    const potId = _genPotId('fs');
    if (!_deductWallet(player, stake, room, `firstSpecial:${potId}`, 'First Special buy-in')) {
        return { ok: false, error: `Insufficient wallet — need $${stake}.` };
    }
    sb.firstSpecial = {
        id:                       potId,
        type:                     'firstSpecial',
        initiatorSid:             sid,
        participants:             [{ sid, contributedTotal: stake }],
        pot:                      stake,
        status:                   'pending_accept',
        initiatedRound:           room.gameState.round,
        lockedAtRound:            null,
        declarationsThisRound:    [],
    };
    sb.initiationsThisRound.firstSpecial = true;
    console.log(`[SIDEBET][FS] ${player.username} initiated First Special pot ${sb.firstSpecial.id} stake=$${stake}`);
    return { ok: true, potId: sb.firstSpecial.id };
}

function _acceptFirstSpecial(room, player /*, potId */) {
    const sid = _findPlayerSid(room, player);
    if (!sid) return { ok: false, error: 'Player not seated.' };
    if (player && player.pendingExit) return { ok: false, error: 'You are exiting — accept blocked.' };
    if (!sideBetsAllowed(room.gameState)) return { ok: false, error: 'Side bets disabled this round.' };
    const sb  = room.gameState.sideBets;
    const pot = sb && sb.firstSpecial;
    if (!pot) return { ok: false, error: 'No First Special pot active.' };
    if (pot.status !== 'pending_accept') return { ok: false, error: 'First Special already locked or resolved.' };
    if (pot.participants.find(p => p.sid === sid)) return { ok: false, error: 'Already in this pot.' };

    const stake = Number(room.gameState.tableMinBet) || 0;
    if (!_deductWallet(player, stake, room, `firstSpecial:${pot.id}`, 'First Special accept')) {
        return { ok: false, error: `Insufficient wallet — need $${stake}.` };
    }
    pot.participants.push({ sid, contributedTotal: stake });
    pot.pot += stake;
    console.log(`[SIDEBET][FS] ${player.username} accepted First Special pot=$${pot.pot} N=${pot.participants.length}`);
    return { ok: true };
}

function _declineFirstSpecial(/* room, player */) { return { ok: true }; }

function _finalizeFirstSpecialPhase(room) {
    const sb  = room.gameState.sideBets;
    const pot = sb && sb.firstSpecial;
    if (!pot || pot.status !== 'pending_accept') return;
    if (pot.participants.length < 2) {
        const init = room.gameState.players[pot.initiatorSid];
        _refundWallet(init, pot.pot, room, `firstSpecial:${pot.id}`, 'First Special refund - no accepters');
        pot.status = 'refunded';
        sb.firstSpecial = null;
        console.log(`[SIDEBET][FS] pot ${pot.id} refunded (no accepters) — $${pot.pot} back to ${init && init.username}`);
        return;
    }
    pot.status        = 'locked';
    pot.lockedAtRound = (room.gameState.round || 0) + 1;     // next round is the first paid round
    console.log(`[SIDEBET][FS] pot ${pot.id} locked — pot=$${pot.pot} N=${pot.participants.length} starts round ${pot.lockedAtRound}`);
}

// Called from PokerRoom.startRound (after round++) so each round past
// lockedAtRound charges the per-round top-up. Players who can't afford
// it forfeit (contributions stay in pot) and are flagged so the room
// can DQ them from the main game this round.
function _topupFirstSpecialAtRoundStart(room) {
    const sb  = room.gameState.sideBets;
    const pot = sb && sb.firstSpecial;
    if (!pot || pot.status !== 'locked') return { forfeited: [] };
    if (!Number.isFinite(pot.lockedAtRound)) return { forfeited: [] };
    const round = Number(room.gameState.round) || 0;
    if (round <= pot.lockedAtRound) return { forfeited: [] };    // first round already paid via init/accept

    const stake = Number(room.gameState.tableMinBet) || 0;
    if (stake <= 0) return { forfeited: [] };

    const forfeited = [];
    pot.participants = pot.participants.filter(part => {
        const p = room.gameState.players[part.sid];
        if (!p) { forfeited.push(part.sid); return false; }
        if (p.isGhostBot || p.pendingExit) { forfeited.push(part.sid); return false; }
        if (!_deductWallet(p, stake, room, `firstSpecial:${pot.id}`, `First Special round ${round} top-up`)) {
            forfeited.push(part.sid);
            return false;     // contribution forfeit-to-pot per spec; pot.pot already holds their prior stakes
        }
        part.contributedTotal += stake;
        pot.pot += stake;     // CRITICAL: successful top-up flows into the pot
        return true;
    });
    if (forfeited.length) {
        console.log(`[SIDEBET][FS] round ${round} top-up forfeits: ${forfeited.length}; remaining ${pot.participants.length}`);
    }
    return { forfeited };
}

// Called from PokerRoom._onDeclareSpecial when a player CORRECTLY
// declares a Special. Records the declaration so reveal-end can
// pick the highest-rank winner across all participants this round.
function recordFirstSpecialDeclaration(room, player, special) {
    const sb  = room.gameState && room.gameState.sideBets;
    const pot = sb && sb.firstSpecial;
    if (!pot || pot.status !== 'locked') return;
    const sid = _findPlayerSid(room, player);
    if (!sid) return;
    if (!pot.participants.find(p => p.sid === sid)) return;       // not a participant
    if (!special || !special.name) return;
    pot.declarationsThisRound = pot.declarationsThisRound || [];
    if (pot.declarationsThisRound.find(d => d.sid === sid)) return;  // dedup
    pot.declarationsThisRound.push({
        sid,
        specialName: special.name,
        rank:        _specialRank(special.name),
    });
    console.log(`[SIDEBET][FS] declaration recorded — ${player.username} declared ${special.name} (rank ${_specialRank(special.name)})`);
}

function _resolveFirstSpecialAtRoundEnd(room) {
    const sb  = room.gameState.sideBets;
    const pot = sb && sb.firstSpecial;
    if (!pot || pot.status !== 'locked') return null;
    const decls = pot.declarationsThisRound || [];
    if (decls.length === 0) {
        // No correct declaration this round — pot carries to next round.
        // Per-round declaration log clears in resetForNewRound.
        return null;
    }
    // Highest rank wins. Multiple at same top rank → split equally.
    const topRank = decls.reduce((m, d) => Math.max(m, d.rank), 0);
    const winners = decls.filter(d => d.rank === topRank);
    const each = Math.floor(pot.pot / winners.length);
    const remainder = pot.pot - (each * winners.length);
    winners.forEach((w, idx) => {
        const p = room.gameState.players[w.sid];
        _creditWallet(p, each + (idx === 0 ? remainder : 0), room, 'side_bet_payout', `firstSpecial:${pot.id}`, `First Special payout (${w.specialName})`);
        console.log(`[SIDEBET][FS] winner ${p && p.username} (${w.specialName} rank ${w.rank}) +$${each + (idx === 0 ? remainder : 0)}`);
    });
    pot.status = 'resolved';
    pot.winnerSids = winners.map(w => w.sid);
    sb.firstSpecial = null;
    return pot;
}

function _refundFirstSpecialAtGameEnd(room) {
    const sb  = room.gameState.sideBets;
    const pot = sb && sb.firstSpecial;
    if (!pot) return null;
    if (pot.status === 'resolved' || pot.status === 'refunded') return null;
    const n = pot.participants.length || 1;
    const each = Math.floor(pot.pot / n);
    const remainder = pot.pot - (each * n);
    pot.participants.forEach((part, idx) => {
        const p = room.gameState.players[part.sid];
        _refundWallet(p, each + (idx === 0 ? remainder : 0), room, `firstSpecial:${pot.id}`, 'First Special game-end refund');
    });
    pot.status = 'refunded';
    sb.firstSpecial = null;
    console.log(`[SIDEBET][FS] game-end refund — $${pot.pot} across ${n}`);
    return pot;
}

// ── BEAT HAND ────────────────────────────────────────────────
// Multi-pot, player-vs-player. Non-banker challenges a specific
// non-banker opponent. Re-initiated every round. Resolution uses
// the main SipSam hand-evaluator: +1 / +0.5 / 0 per hand (ties
// split between the two sides). 1.5–1.5 → pot splits.

function _isBanker(room, sid) {
    return sid === room.gameState.bankerSessionId;
}

function _initiateBeatHand(room, player, opts) {
    const challengerSid = _findPlayerSid(room, player);
    if (!challengerSid) return { ok: false, error: 'Player not seated.' };
    if (_isBanker(room, challengerSid)) return { ok: false, error: 'Banker cannot participate in Beat Hand.' };

    const targetSid = String((opts && (opts.target || opts.targetSid)) || '');
    if (!targetSid) return { ok: false, error: 'Beat Hand requires a target opponent.' };
    if (targetSid === challengerSid) return { ok: false, error: 'Cannot challenge yourself.' };
    if (_isBanker(room, targetSid)) return { ok: false, error: 'Banker cannot be challenged.' };

    const target = room.gameState.players[targetSid];
    if (!target || target.isGhostBot || target.disqualified || target.pendingExit) {
        return { ok: false, error: 'Target opponent is not available.' };
    }

    const sb = room.gameState.sideBets;
    if (!sb) return { ok: false, error: 'Side bets uninitialised.' };

    // Spec: once two players are in a Beat Hand pot together this round,
    // neither can issue another against the other. Check both directions.
    const conflict = sb.beatHand.find(p =>
        (p.challengerSid === challengerSid && p.accepterSid === targetSid) ||
        (p.challengerSid === targetSid     && p.accepterSid === challengerSid) ||
        // also block pending unaccepted pots between the same pair
        (p.status === 'pending_accept' &&
            ((p.challengerSid === challengerSid && p.targetSid === targetSid) ||
             (p.challengerSid === targetSid     && p.targetSid === challengerSid)))
    );
    if (conflict) return { ok: false, error: 'Already in a Beat Hand with this opponent this round.' };

    const stake = Number(room.gameState.tableMinBet) || 0;
    if (stake <= 0) return { ok: false, error: 'Table min bet not set.' };
    const potId = _genPotId('bh');
    if (!_deductWallet(player, stake, room, `beatHand:${potId}`, `Beat Hand challenge vs ${target.username}`)) {
        return { ok: false, error: `Insufficient wallet — need $${stake}.` };
    }

    const pot = {
        id:             potId,
        type:           'beatHand',
        challengerSid,
        targetSid,                 // the player invited to accept
        accepterSid:    null,      // populated on accept
        pot:            stake,
        status:         'pending_accept',
        initiatedRound: room.gameState.round,
    };
    sb.beatHand.push(pot);
    sb.initiationsThisRound.beatHand = true;
    console.log(`[SIDEBET][BH] ${player.username} challenged ${target.username} (pot ${pot.id} stake=$${stake})`);
    return { ok: true, potId: pot.id };
}

function _acceptBeatHand(room, player, potId) {
    const sid = _findPlayerSid(room, player);
    if (!sid) return { ok: false, error: 'Player not seated.' };
    if (player && player.pendingExit) return { ok: false, error: 'You are exiting — accept blocked.' };
    if (!sideBetsAllowed(room.gameState)) return { ok: false, error: 'Side bets disabled this round.' };
    if (_isBanker(room, sid)) return { ok: false, error: 'Banker cannot participate in Beat Hand.' };

    const sb  = room.gameState.sideBets;
    const pot = sb && sb.beatHand.find(p => p.id === potId);
    if (!pot) return { ok: false, error: 'Beat Hand pot not found.' };
    if (pot.status !== 'pending_accept') return { ok: false, error: 'Pot already locked or resolved.' };
    if (pot.targetSid !== sid)
        return { ok: false, error: 'This Beat Hand challenge was not addressed to you.' };

    const stake = Number(room.gameState.tableMinBet) || 0;
    if (!_deductWallet(player, stake, room, `beatHand:${pot.id}`, 'Beat Hand accept')) {
        return { ok: false, error: `Insufficient wallet — need $${stake}.` };
    }
    pot.accepterSid = sid;
    pot.pot        += stake;
    pot.status      = 'locked';
    console.log(`[SIDEBET][BH] ${player.username} accepted pot ${pot.id} — locked pot=$${pot.pot}`);
    return { ok: true };
}

function _declineBeatHand(room, player, potId) {
    // A targeted decline immediately refunds the challenger and removes the
    // pot — there is no other accepter to wait for in a 1-vs-1 challenge.
    const sid = _findPlayerSid(room, player);
    if (!sid) return { ok: true };
    const sb  = room.gameState.sideBets;
    const idx = sb && sb.beatHand.findIndex(p => p.id === potId);
    if (idx < 0) return { ok: true };
    const pot = sb.beatHand[idx];
    if (pot.status !== 'pending_accept') return { ok: true };
    if (pot.targetSid !== sid) {
        // Non-target tried to decline — surfaces a buggy/abusive client path.
        console.warn(`[SIDEBET][BH] non-target decline rejected: pot=${pot.id} from=${sid} expected=${pot.targetSid}`);
        return { ok: true };
    }
    const challenger = room.gameState.players[pot.challengerSid];
    _refundWallet(challenger, pot.pot, room, `beatHand:${pot.id}`, 'Beat Hand declined refund');
    pot.status = 'refunded';
    sb.beatHand.splice(idx, 1);
    console.log(`[SIDEBET][BH] ${player && player.username} declined pot ${pot.id} — refund $${pot.pot} to challenger`);
    return { ok: true };
}

// At end of the Beat Hand side-bet phase: any pot still pending_accept
// (no response from target) is refunded to challenger.
function _finalizeBeatHandPhase(room) {
    const sb = room.gameState.sideBets;
    if (!sb) return;
    for (let i = sb.beatHand.length - 1; i >= 0; i--) {
        const pot = sb.beatHand[i];
        if (pot.status !== 'pending_accept') continue;
        const challenger = room.gameState.players[pot.challengerSid];
        _refundWallet(challenger, pot.pot, room, `beatHand:${pot.id}`, 'Beat Hand no-response refund');
        pot.status = 'refunded';
        sb.beatHand.splice(i, 1);
        console.log(`[SIDEBET][BH] pot ${pot.id} refunded (no response) — $${pot.pot} back to challenger`);
    }
}

// Score one player's three hands vs another's. Returns numeric score
// for side A (the challenger). Uses main Logic.compareHands so Flush
// suit-tiebreak rules are applied identically to the main game.
function _scoreBeatHand(playerA, playerB) {
    const handsA = [playerA.hand1, playerA.hand2, playerA.hand3];
    const handsB = [playerB.hand1, playerB.hand2, playerB.hand3];
    let scoreA = 0;
    for (let i = 0; i < 3; i++) {
        const r = Logic.compareHands(handsA[i] || [], handsB[i] || []);
        if (r > 0)      scoreA += 1;
        else if (r < 0) scoreA += 0;        // B wins this hand
        else            scoreA += 0.5;      // tie → split this hand
    }
    return scoreA;
}

function _resolveBeatHandAtRoundEnd(room) {
    const sb = room.gameState.sideBets;
    if (!sb) return [];
    const resolved = [];
    for (const pot of sb.beatHand) {
        if (pot.status !== 'locked') continue;

        const chal = room.gameState.players[pot.challengerSid];
        const acc  = room.gameState.players[pot.accepterSid];
        const chalDq = !chal || chal.disqualified || chal.isGhostBot;
        const accDq  = !acc  || acc.disqualified  || acc.isGhostBot;

        let winnerSid = null;
        let split = false;
        if (chalDq && accDq) {
            split = true;
        } else if (chalDq) {
            winnerSid = pot.accepterSid;
        } else if (accDq) {
            winnerSid = pot.challengerSid;
        } else {
            const aScore = _scoreBeatHand(chal, acc);    // out of 3
            const bScore = 3 - aScore;
            if (aScore > bScore)       winnerSid = pot.challengerSid;
            else if (bScore > aScore)  winnerSid = pot.accepterSid;
            else                       split = true;     // 1.5–1.5
            console.log(`[SIDEBET][BH] pot ${pot.id} scored — challenger ${aScore} vs accepter ${bScore}`);
        }

        if (split) {
            const each = Math.floor(pot.pot / 2);
            const rem  = pot.pot - 2 * each;
            _refundWallet(chal, each + rem, room, `beatHand:${pot.id}`, 'Beat Hand split refund'); // rem goes to challenger
            _refundWallet(acc,  each, room, `beatHand:${pot.id}`, 'Beat Hand split refund');
            pot.status = 'refunded';
            console.log(`[SIDEBET][BH] pot ${pot.id} split (1.5–1.5 or both-DQ) — $${pot.pot}/2`);
        } else {
            const winner = room.gameState.players[winnerSid];
            _creditWallet(winner, pot.pot, room, 'side_bet_payout', `beatHand:${pot.id}`, 'Beat Hand payout');
            pot.status    = 'resolved';
            pot.winnerSid = winnerSid;
            console.log(`[SIDEBET][BH] pot ${pot.id} resolved — winner=${winner && winner.username} +$${pot.pot}`);
        }
        resolved.push(pot);
    }
    sb.beatHand = sb.beatHand.filter(p => p.status !== 'resolved' && p.status !== 'refunded');
    return resolved;
}

// Beat Hand is per-round. At game-end there shouldn't be unresolved
// locked pots (they resolve at their own round's reveal-end). Any
// stragglers refund to both sides.
function _refundBeatHandAtGameEnd(room) {
    const sb = room.gameState.sideBets;
    if (!sb) return [];
    const refunded = [];
    for (const pot of sb.beatHand) {
        if (pot.status === 'resolved' || pot.status === 'refunded') continue;
        const chal = room.gameState.players[pot.challengerSid];
        const acc  = pot.accepterSid && room.gameState.players[pot.accepterSid];
        if (acc) {
            const half = Math.floor(pot.pot / 2);
            _refundWallet(chal, half + (pot.pot - 2 * half), room, `beatHand:${pot.id}`, 'Beat Hand game-end refund');
            _refundWallet(acc, half, room, `beatHand:${pot.id}`, 'Beat Hand game-end refund');
        } else {
            _refundWallet(chal, pot.pot, room, `beatHand:${pot.id}`, 'Beat Hand game-end refund');
        }
        pot.status = 'refunded';
        refunded.push(pot);
    }
    sb.beatHand = sb.beatHand.filter(p => p.status !== 'refunded');
    return refunded;
}

// ── Dispatch ─────────────────────────────────────────────────

function initiate(type, room, player, opts) {
    switch (type) {
        case SIDEBET_TYPES.BEST_CARD:     return _initiateBestCard(room, player, opts);
        case SIDEBET_TYPES.FIRST_SPECIAL: return _initiateFirstSpecial(room, player, opts);
        case SIDEBET_TYPES.BEAT_HAND:     return _initiateBeatHand(room, player, opts);
        default:
            return { ok: false, error: `Unknown side bet type: ${type}` };
    }
}

function accept(type, room, player, potId) {
    switch (type) {
        case SIDEBET_TYPES.BEST_CARD:     return _acceptBestCard(room, player, potId);
        case SIDEBET_TYPES.FIRST_SPECIAL: return _acceptFirstSpecial(room, player, potId);
        case SIDEBET_TYPES.BEAT_HAND:     return _acceptBeatHand(room, player, potId);
        default: return { ok: false, error: `Accept for '${type}' not implemented yet.` };
    }
}

function decline(type, room, player, potId) {
    switch (type) {
        case SIDEBET_TYPES.BEST_CARD:     return _declineBestCard(room, player, potId);
        case SIDEBET_TYPES.FIRST_SPECIAL: return _declineFirstSpecial(room, player, potId);
        case SIDEBET_TYPES.BEAT_HAND:     return _declineBeatHand(room, player, potId);
        default: return { ok: true };
    }
}

function finalizePhase(room, phaseType) {
    if (phaseType === SIDEBET_TYPES.BEST_CARD)     _finalizeBestCardPhase(room);
    if (phaseType === SIDEBET_TYPES.FIRST_SPECIAL) _finalizeFirstSpecialPhase(room);
    if (phaseType === SIDEBET_TYPES.BEAT_HAND)     _finalizeBeatHandPhase(room);
}

function topupAtRoundStart(room) {
    const fs = _topupFirstSpecialAtRoundStart(room);
    return { firstSpecial: fs };
}

function resolveAtRoundEnd(room) {
    const resolved = _resolveBestCardAtRoundEnd(room);
    const fs = _resolveFirstSpecialAtRoundEnd(room);
    if (fs) resolved.push(fs);
    const bh = _resolveBeatHandAtRoundEnd(room);
    bh.forEach(p => resolved.push(p));
    return { resolved, carried: [] };
}

function resolveAfterSideBetPhase(room) {
    return resolveAtRoundEnd(room);
}

function resolveBestCardAfterSideBetPhase(room) {
    return resolveAfterSideBetPhase(room);
}

function refundUnwonAtGameEnd(room) {
    const refunded = _refundBestCardAtGameEnd(room);
    const fs = _refundFirstSpecialAtGameEnd(room);
    if (fs) refunded.push(fs);
    const bh = _refundBeatHandAtGameEnd(room);
    bh.forEach(p => refunded.push(p));
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
    topupAtRoundStart,
    recordFirstSpecialDeclaration,
    resolveAtRoundEnd,
    resolveAfterSideBetPhase,
    resolveBestCardAfterSideBetPhase,
    refundUnwonAtGameEnd,
    SIDEBET_TYPES,
    // exported for unit smoke
    _cardValue,
    _cardSuit,
    _suitRank,
    _specialRank,
};
