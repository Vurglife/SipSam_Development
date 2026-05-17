---
name: wallet-bank-safety
description: MUST BE USED before modifying or reviewing wallet, bank, balance, session, entry, exit, refund, invite acceptance, game result, payout, database, or VurgLife account logic.
paths:
  - "vurglife-platform/server/**"
  - "vurglife-platform/data/**"
  - "poker-server/**"
  - "blackjack-server/**"
  - "rhum32-server/**"
  - "roulette-server/**"
---

Treat wallet, bank, balance, session, game-result, and database behavior as business-critical.

Before edits:

1. Identify every affected balance/session/data path.
2. Determine whether the change can double-credit, drop credit, bypass bank requirements, corrupt data, or break rejoin/exit flows.
3. Do not edit `vurglife-platform/data/vurglife.db` directly unless Mitstar explicitly approves and a backup exists.
4. Prefer code changes with reproducible validation over manual data edits.
5. Validate entry, exit, refund, game result, restart/reconnect, and failure behavior where relevant.
6. Update `VALIDATION.md` with evidence and gaps.

If validation cannot cover a money-impacting path, state the risk before proceeding.
