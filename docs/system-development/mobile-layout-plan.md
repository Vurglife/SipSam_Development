# SipSam Mobile Layout Plan

Locked May 31 2026. Portrait-first (375px baseline). All mobile changes
gated behind `@media (max-width: 600px)` and/or `body.is-mobile` so the
**desktop layout is provably untouched**.

## Decisions (product owner, May 31 2026)

1. **Table presentation:** Vertical strips on mobile — drop the oval.
   Banker = top strip; opponents = compact horizontal seat row over the
   felt watermark; tap a seat to expand its 3 hands.
2. **Side bets:** Segmented 2-tab switcher in the bottom area —
   `[ My Hand ] [ Side Bets •N ]`. Badge = active-pot count. No overlay
   collisions; both always one tap away.
3. **Sequencing:** Reachability first (Phase 1), polish second (Phase 2).

## Problems being fixed (current 375px state)

1. Oval becomes 96vw×52vw (~360×195px) — 4 seats overlap.
2. `.side-extras { width:0 }` hides p1/p3 avatar + chat rails.
3. `#sidebets-panel` goes `position:static` inside an `overflow:hidden`
   flex row next to a 96vw table → squeezed to ~4vw, clipped. Side bets
   unreachable on phone.
4. Five fixed overlays collide top-right (countdown, round-delta card,
   announce banner, low-wallet toast, side-bets panel).
5. Top bar + table + `.my-area` (max-height 56vh) overflow the viewport
   → scrolling during timed phases.

## Phase 1 — Reachability (functional mobile)

| # | Task | Files |
|---|---|---|
| 1 | `body.is-mobile` flag toggled on load + resize via matchMedia(600px). Drives CSS + tab JS. | game.js |
| 2 | Vertical-strip table: mobile query overrides all `.zone-*` absolute positioning (incl. `.banker-pov !important` rules) to flex flow — banker strip top, p1/p2/p3 compact row, watermark behind. | style.css |
| 3 | Bottom tab switcher `[My Hand][Side Bets •N]`. New `.mobile-tabbar` above `.my-area`; JS toggles `.my-area` vs `#sidebets-panel` as tab bodies; badge = active pot count. Hidden on desktop. | index.html, game.js, style.css |
| 4 | Single managed toast region (top-center, stacked) for announce banner + low-wallet + round-delta on mobile; countdown keeps its own corner chip. | style.css |
| 5 | Fold essential side-rail features (avatar, chip request, chat bubble) into the compact seat cards / seat tap-expand. | game.js, style.css |
| 6 | Fit top bar + strips + active tab body in `100dvh` with `env(safe-area-inset-*)`. Inactive tab `display:none` so only one work area consumes height. | style.css |

**Phase 1 validation:** DevTools device mode at 375px (iPhone SE) +
390px. Confirm: banker + 3 opponents visible, no overlap; both tabs
reachable; side-bet initiate/accept/opt-out usable; announcements
visible; nothing clipped; no scroll during betting/arrange beyond the
active tab body. Desktop unchanged (regression check at ≥1100px).

## Phase 2 — Polish (later)

Seat expand/collapse animation, tab transition, fine spacing, landscape
handling, larger tap targets audit, optional haptics.
