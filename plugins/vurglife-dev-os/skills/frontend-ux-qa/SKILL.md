---
name: frontend-ux-qa
description: Use for PokerProject frontend work, UI changes, visual QA, mobile/desktop behavior, game flow screens, lobby, dashboard, invites, overlays, and player-facing polish.
paths:
  - "poker-client/**"
  - "blackjack-client/**"
  - "rhum32-client/**"
  - "roulette-client/**"
  - "holdem-client/**"
  - "vurglife-platform/client/**"
---

Validate frontend changes through real workflows, not static inspection only.

Check:

- Main user path and affected edge states.
- Desktop and mobile layout.
- Text fit, overlap, z-index, loading, empty, disabled, and error states.
- Wallet/bank visibility when relevant.
- Touch, drag, modal, overlay, and countdown behavior for game screens.

Use browser screenshots or manual run checks when visual quality matters. Record what was checked in `docs/system-development/VALIDATION.md`.
