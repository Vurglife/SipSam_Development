# Progress

## Current State - 2026-05-17

- Active repo: `G:\SipSam\PokerProject`
- Active branch: `master`
- Recent anchors: `c2ad147 Blackjack: horizontal player hand, freeze tie bets, guest lobby roles`; `119d815 Add current progress handoff for Claude sessions`; `ce8146a Require manual daily bonus claims`; `a6ea242 Fix Celestial table config and wallet session accounting`
- Platform run command: `cd G:\SipSam\PokerProject\vurglife-platform && npm start`

## Completed Recently

- Added manual daily bonus claiming in `vurglife-platform/server/routes/auth.js`.
- Dashboard now shows an `Accept Bonus` control in `vurglife-platform/client/public/index.html`.
- Daily bonus message after claim: `Come back tomorrow so you do not miss your next Bonus.`
- Daily and watch-ad bonus values match the tier table:
  Bronze 500/300, Silver 700/500, Gold 1000/700, Platinum 1500/1000, VIP 2000/1300, Elite 5000/1700, Celestial 10000/2500.
- Login no longer auto-credits the daily bonus. Players must open the platform and accept the bonus. Missed days do not accumulate.
- Rewards & Milestones now opens with a Player Tiers section explaining minimum bank, daily bonus, and watch-ad bonus for each tier.
- Celestial SipSam table fixed:
  10M min bank, 7M wallet, 100K min bet, 100K increments, 1M max bet.
- Platform wallet/session guard added for server-side wallet draw/return consistency across VurgLife game routes.

## Validation Already Run

- `node --check vurglife-platform/server/routes/auth.js`
- `node --check` for changed wallet/Celestial JS files in the previous commit.
- Dashboard HTML script parse via `vm.Script`.
- Tier bonus mapping check against `vurglife-platform/server/lib/tiers.js`.
- `node .claude\scripts\ship-gate.js`
- `git log --oneline -5` after each recent commit.

## Not Yet Live-Tested

- Manual daily bonus claim in browser with a real account.
- Celestial wallet enter/exit in browser with a real account.
- Mid-round exit settlement with live game state after a platform restart.

These were not live-tested here because they mutate real account balances. Snapshot `vurglife-platform/data/vurglife.db` before balance-mutating tests if using production-like data.

## Dirty Worktree Notes

The worktree still contains unrelated modified/untracked files from earlier sessions. Do not stage them unless the current task explicitly owns them.

Known unrelated dirty examples observed on 2026-05-17:

- `README.md`
- `blackjack-client/game.js`
- `poker-client/game(1).js`
- `poker-client/style.css`
- `poker-server/logic.js`
- `vurglife-platform/data/vurglife.db`
- `vurglife-platform/package*.json`
- `vurglife-platform/server/index.js`
- `vurglife-platform/server/middleware/auth.js`
- untracked recovery, blackjack, rhum32, roulette, and `.claude` artifacts

## Next Suggested Work

1. Start platform and live-test manual daily bonus claim with a copied test DB or after a DB snapshot.
2. Live-test Celestial table entry and exit math with a test account.
3. Continue SipSam verification before shifting focus to Blackjack repair.

## New Chat Startup

Read these first:

1. `CLAUDE.md`
2. `ARCHITECTURE.md`
3. `docs/system-development/PROGRESS.md`
4. `docs/system-development/VALIDATION.md`

Then run:

```powershell
git branch --show-current
git log --oneline -5
git status --short
```
