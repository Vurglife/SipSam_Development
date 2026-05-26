// ============================================================
// SIPSAM SIDE BETS — module skeleton (no behaviour yet)
// ============================================================
// Source of truth for behaviour: docs/system-development/sidebets-spec.md
//
// Three bets: First Special, Beat Hand, Best Card.
// All wallet-only, no rake, txn-logged. Lifecycle:
//   reveal-phase initiate -> 7s side-bet phase(s) accept ->
//   round-end resolve. Final round + Blitz disable side bets.
//
// THIS COMMIT IS SCAFFOLD ONLY. Behaviour wires in subsequent
// commits (per the locked build plan: Best Card -> First
// Special -> Beat Hand). Importing this and calling emptyState()
// is the only contract used so far.
// ============================================================

'use strict';

// ── State factory ────────────────────────────────────────────
// Returned object lives at gameState.sideBets. Keep flat + JSON-
// serialisable; broadcast unchanged to clients (visibility is fine
// — pots / participants are public information at the table).
function emptyState() {
    return {
        firstSpecial: null,                  // single pot or null
        beatHand:     [],                    // multi-pot, per challenge
        bestCard:     [],                    // multi-pot, per initiator
        phaseQueue:   [],                    // ['firstSpecial'|'beatHand'|'bestCard']
        phaseActive:  null,
        phaseTimer:   0,
        initiationsThisRound: {
            firstSpecial: false,
            beatHand:     false,
            bestCard:     false
        }
    };
}

// ── Per-round reset ──────────────────────────────────────────
// Clear initiation flags and any per-round transient state at
// the start of every round (called from PokerRoom.startRound).
// Active multi-round pots (First Special, carry-over Best Card)
// are NOT cleared here — only the per-round flags are.
function resetForNewRound(state) {
    if (!state) return;
    state.initiationsThisRound = {
        firstSpecial: false,
        beatHand:     false,
        bestCard:     false
    };
    state.phaseQueue  = [];
    state.phaseActive = null;
    state.phaseTimer  = 0;
}

// ── Eligibility gate ─────────────────────────────────────────
// Spec: no side bets on the final round or in Blitz mode. Used
// by the (forthcoming) initiation handlers to short-circuit.
function sideBetsAllowed(gameState) {
    if (!gameState) return false;
    if (gameState.blitz) return false;
    const round = Number(gameState.round) || 0;
    const max   = Number(gameState.maxRounds) || 0;
    if (max > 0 && round >= max) return false;     // final round
    return true;
}

// ── Public view ──────────────────────────────────────────────
// What the client sees per session. For now identical to the
// raw state (no per-player redaction needed yet; pots/values
// are public). Hook left in place so later commits can filter
// (e.g., hide pre-locked accept-pending state from non-targets).
function publicView(state /*, forSessionId */) {
    return state || emptyState();
}

// ── Stake handling (stub — wires in Best Card commit) ────────
// Centralised so every pot type goes through the same idempotent
// wallet path. Signature placeholder; do not call yet.
function deductStake(/* room, player, potRef, amount */) {
    // TODO: wallet deduction + side_bet_buy_in txn.
    return { ok: false, error: 'not-implemented' };
}

function payoutPot(/* room, pot, winners */) {
    // TODO: split pot among winners + side_bet_payout txn(s).
    return { ok: false, error: 'not-implemented' };
}

function refundPot(/* room, pot, participants */) {
    // TODO: equal-split refund + side_bet_refund txn(s).
    return { ok: false, error: 'not-implemented' };
}

// ── Initiation / accept stubs (per-bet wiring lands later) ───
function initiate(/* type, room, initiator, opts */) {
    return { ok: false, error: 'not-implemented' };
}

function accept(/* type, room, accepter, potId */) {
    return { ok: false, error: 'not-implemented' };
}

function decline(/* type, room, decliner, potId */) {
    return { ok: false, error: 'not-implemented' };
}

// ── Round-end resolution (wires after each bet's commit) ─────
function resolveAtRoundEnd(/* room */) {
    return { resolved: [], carried: [] };
}

// ── Game-end refund (universal rule) ─────────────────────────
function refundUnwonAtGameEnd(/* room */) {
    return { refunded: [] };
}

module.exports = {
    emptyState,
    resetForNewRound,
    sideBetsAllowed,
    publicView,
    deductStake,
    payoutPot,
    refundPot,
    initiate,
    accept,
    decline,
    resolveAtRoundEnd,
    refundUnwonAtGameEnd,
};
