# SipSam Side Bets — Canonical Spec

Locked May 2026. Source of truth for behaviour, payouts, timing, and edge
cases. Any implementation discrepancy with this doc is a bug in the
implementation, not the spec. Update this doc *first* if rules change.

There are three side bets — **First Special**, **Beat Hand**, **Best Card**.
All stakes equal the table minBet. Wallet-only (bank untouched). No house
rake. All movements logged as `side_bet_buy_in` / `side_bet_payout` /
`side_bet_refund` transactions (no `side_bet_rake`).

---

## Lifecycle (all three bets)

1. **Initiation window** — during the *reveal* phase of round N. Players
   click side-bet buttons on the table; the server records each
   initiation but doesn't lock stakes yet.
2. **Side-bet phase(s)** — inserted between reveal and round N+1's
   betting phase, sequentially in this order: **First Special → Beat Hand
   → Best Card**, each lasting **7 seconds**. A phase is inserted *only if
   that type was initiated this round*. Zero initiations → no extra time.
3. **Acceptance** — targeted opponent(s) accept or decline during the
   phase. Stake deducted from accepter's wallet on accept. No response =
   decline.
4. **Resolution** — at end of round N+1 (and subsequent rounds for
   carry-over bets) per each bet's resolution rules.

### Universal rules

- **No side bets in the final round** of the game.
- **No side bets in Blitz mode** (5-round games, 20s reveal).
- **Bots auto-decline** every side-bet prompt. Bots may participate only
  if they were the initiator (which they never are in current logic — bots
  do not initiate).
- **`pendingExit` players auto-decline** all prompts. A player who clicks
  Exit *during* a side-bet phase keeps their already-locked stakes; the
  bet still resolves at the round end they're being deferred to.
- **Forfeit on exit** — any contribution already paid into any pot is
  forfeited; the leaving player never gets a refund of their stake.
- **Wallet-only** — stakes drawn from `player.chips`. Bank is touched only
  by main-game shortfalls (banker debt path), never by side bets.

---

## 1 · First Special — single table-wide pot

### Initiation
- One pot per table at any time. Any non-bot player can click "Initiate
  First Special" once per round during reveal phase.
- **Simultaneous-click tie-break:** first server-arrival wins. The button
  locks instantly across all clients; a player whose click landed second
  is shown the standard accept prompt instead of becoming a co-initiator.
- Bots cannot initiate. Banker *can* initiate.

### Locking
- Accepters confirmed at end of the First Special side-bet phase. Pot
  locks at the first deal of round N+1. **No new participants** join once
  locked.

### Stake
- Every participant (initiator + accepters) contributes `minBet` per round
  the bet stays unresolved, deducted from wallet at the start of each round.

### Drop-out / topup failure
- A participant who refuses or cannot afford the next round's top-up
  forfeits all prior contributions to the pot AND is auto-DQ'd from the
  main game that round. Any main-game debt is drawn from their bank per
  normal banker-debt rules.

### Resolution
- Winner = first participant to *correctly* declare a Special in any
  round while the bet is active.
- **Same-round multi-declare:** highest-ranked Special wins (Full Suit >
  6½ > Royal Flush > Flush-Flush-Flush > Straight-Straight-Straight >
  Four of a Kind > Straight Flush > No Face). Identical ranks → pot
  split equally among those declarers.
- **Wrong-Special DQ** in main game: that participant stays in the side
  bet for subsequent rounds if their wallet allows. Main-game DQ payment
  applies as normal.

### Concurrency
- A First Special being active does NOT block Beat Hand or Best Card
  initiations in the same or subsequent rounds.

### Game-end with no winner
- Pot refunded equally to current participants (`side_bet_refund`).

---

## 2 · Beat Hand — multi-pot, player-vs-player

### Initiation
- Each non-banker player has a "Beat Hand" button per opponent they can
  still challenge this round. Clicking it issues a challenge specifying
  the target opponent (one of the other non-banker players).
- **Banker may not participate** as challenger or accepter.
- Bots auto-decline.

### Multi-pot
- Multiple parallel Beat Hand pots can exist per round, each between a
  unique challenger/accepter pair.
- **Constraint:** once A and B are in a Beat Hand pot together this
  round, neither can issue another Beat Hand against the other this
  round. Either may still issue vs the third non-banker.
- Re-initiated every round (no auto-renew across rounds).

### Stake
- `minBet` per side, locked into the pot when the accepter accepts.

### Resolution (at end of round N+1)
- Compare the two players' three hands using main SipSam rules including
  Flush suit-tiebreak (H > S > D > C).
- Winner of 2 or more hands takes the pot. **1.5–1.5 → split.**
- Special declared by one side: pot resolves on hand-compare as normal
  (no multiplier applied — pot was fixed pre-round).
- **DQ in main game** → DQ'd side forfeits pot to the other side. If both
  sides DQ → pot split.

---

## 3 · Best Card — multi-pot, value-vs-value

### Initiation
- Each player (including banker) has a "Best Card" button. Clicking it
  starts a new pot; the initiator picks the value (2–A, no suit).
- Each player may have at most one **active** Best Card pot they
  initiated (cannot initiate a second while one is unresolved).
- Multiple parallel Best Card pots can exist per round, each with its
  own initiator, value, and participant set.

### Acceptance
- Other non-bot players (incl. banker) prompted to accept/decline each
  pot's specified value during the Best Card side-bet phase.

### Stake
- `minBet` per participant (initiator + accepters), deducted on accept
  or initiation.

### Resolution (at end of the same round)
- Among that round's participants who were dealt the chosen value:
  highest-suit copy wins (H > S > D > C). If a player holds multiple
  copies of that value, use their highest-suit copy.
- **No participant holds the value this round** → pot carries to next
  round with the same selected value. Same participants top up `minBet`;
  participants who are exiting or cannot top up forfeit their prior
  contribution to the pot. The pot remains active until won or refunded
  at game end.
- Players cannot *join* a carry-over pot once it has been locked — only
  the original participants top up.

### DQ in main game
- Does NOT affect Best Card eligibility. The dealt cards still count.

### Game-end with carry-over pot unwon
- Pot refunded equally to the participants still in the pot
  (`side_bet_refund`).

---

## State model (server)

```
gameState.sideBets = {
  firstSpecial: null | {
    id, pot, initiatorSid, participants: [{sid, contributedTotal}], status,
    initiatedRound, lockedAtRound
  },
  beatHand: [   // multi-pot
    { id, pot, challengerSid, accepterSid, status, initiatedRound }
  ],
  bestCard: [   // multi-pot
    { id, pot, initiatorSid, value, participants: [{sid, contributedTotal}],
      status, initiatedRound, carryOverRounds }
  ],
  phaseQueue: [],          // 'firstSpecial' | 'beatHand' | 'bestCard'
  phaseActive: null,
  phaseTimer: 0,
  initiationsThisRound: { firstSpecial: false, beatHand: false, bestCard: false }
}
```

Status values per pot: `pending_accept`, `locked`, `resolved`, `refunded`.

---

## Transactions

| Type | Sign | Reference | When |
|---|---|---|---|
| `side_bet_buy_in` | negative | `firstSpecial:<id>` / `beatHand:<id>` / `bestCard:<id>` | At stake deduction |
| `side_bet_payout` | positive | same | At resolution win |
| `side_bet_refund` | positive | same | At game-end refund or beatHand-both-DQ split |

No `side_bet_rake` — house takes nothing on side bets.
