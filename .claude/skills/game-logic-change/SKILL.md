---
name: game-logic-change
description: Use when changing or reviewing PokerProject game rules, SipSam poker hands, specials, payouts, banker logic, bots, rooms, rounds, timers, matchmake, or poker-server behavior.
paths:
  - "poker-server/**"
  - "poker-client/**"
  - "blackjack-server/**"
  - "blackjack-client/**"
  - "rhum32-server/**"
  - "rhum32-client/**"
  - "roulette-server/**"
  - "roulette-client/**"
  - "holdem-server/**"
  - "holdem-client/**"
  - "docs/system-development/**"
---

Before changing game logic:

1. Read the relevant rule source, current handoff section, and affected implementation files.
2. Identify the exact rule, state transition, payout path, and user-visible result.
3. Check edge cases: banker/player special, wrong declaration, DQ, tie, bot replacement, final round, reconnect, exit/refund, and wallet crediting.
   - Blackjack-specific checks: betting, optional tie/freeze tie, deal, insurance when dealer shows ace, hit/stand/double/split, bot turns, dealer draw rules, payout, round_end, chat broadcast, and menu actions.
4. Preserve deterministic server authority. Do not rely on client-only validation for money, payouts, or game outcome.
5. Run or add focused validation for the affected rule path.
6. Record validation and any durable rule decision in `docs/system-development`.

If the written game rules conflict with current code or handoff, stop and ask Mitstar which source is authoritative.
