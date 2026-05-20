# Progress

## Current State - 2026-05-18

- Active repo: `G:\SipSam\PokerProject` (Rhum32 lives only here — untracked, not in any worktree)
- Active branch: `master`
- Recent anchors: `2a56050 Implement Blackjack fixed tier tables`; `6e0d252 Add tier explainer to rewards dashboard`; `119d815 Add current progress handoff for Claude sessions`; `ce8146a Require manual daily bonus claims`; `a6ea242 Fix Celestial table config and wallet session accounting`
- Platform run command: `cd G:\SipSam\PokerProject\vurglife-platform && npm start`

## Completed Recently

- Rhum32 multiplayer invite gate + invitee waiting lobby (mirrors SipSam). Host: invite input + Invite button are disabled until rounds are picked, with a helper note ("Select rounds first to enable invites"); `sendLobbyInvite()` hard-rejects if `!selectedRounds` so every invite carries tier + rounds. Invitee: when `rhum32_table.isInvitedJoiner === true && roomId`, `enterAsInvitee()` skips mode-select, opens the lobby in invitee mode (`applyInviteeLobby` hides rounds row/label, invite section, Start; relabels Back → "✕ Exit Lobby" wired to `rhumSettleAndLeave`), shows "⏳ Waiting for the host to start the game…", and `connectAsInvitee(roomId)` joins the host's specific room without sending `startGame`. The existing `renderState` 'waiting' → active transition fast-forwards mid-game joins to `screen-game`. Cache-bust `game.js?v=16`.
- Rhum32 in-game menu ported to SipSam's slide-in accordion (`#igm-overlay`/`#igm-panel`): header + player/wallet/bank bar + sections Invite / Replenish / Request / Send / Payouts / Rules / Exit, recoloured to Rhum32 green/gold. Old 3-overlay menu removed. Payouts & Rules content is Rhum32-accurate (sourced from `rhum32-server/logic.js`: A–5 100:1/$75k … 18–31 Normal 1:1; 47–50 face specials; tie 20:1; zero rules). `game.js` gained the `igm*` family wired to Rhum32 `lastState`/`sessionId`/WS fields.
- Rhum32 replenish is now server-authoritative (mirrors SipSam): client sends WS `replenishWallet`; `Rhum32Room._onReplenishWallet` calls the platform `/api/game/replenish` with the player's token (threaded client→matchmake→session→`player.token`) and credits `player.wallet += topUp`, replies `replenishResult`. `getPublicState` strips `player.token` so the JWT never broadcasts. Reviewed by `wallet-security-reviewer` — verdict safe (bank↔wallet conserved, no double-deduction, token server-only).
- Rhum32 wallet→bank money path fixed end-to-end. Root cause: `enterRhum32Table()` in `vurglife-platform/client/public/index.html` bypassed the shared pregame-ad → `confirmEnter()` flow, so `/api/game/rhum32/enter` never ran — the bank was never drawn and no wallet session existed, so exit credited nothing. `enterRhum32Table` now mirrors SipSam's `enterTable` (sets `pendingTable`/`pendingGameType='rhum32'`, calls `runAd('pregame')`); `confirmEnter` already handled the rhum32 enter endpoint + redirect. Reviewed by `wallet-security-reviewer` (blocker identified there, then fixed).
- Rhum32 exit now mirrors SipSam: `rhumSettleAndLeave()` always POSTs `/api/game/rhum32/exit` (dedicated endpoint, not generic), computes remaining wallet (live game wallet, or full walletSize pre-game so the lobby Back button doesn't burn the draw), then navigates to `/` (was `/#rhum32`, which caused the logout-to-landing bug). Added a `beforeunload` `sendBeacon` to `/api/game/rhum32/exit-beacon`.
- Rhum32 friends list / invites / replenish now use one `rhumToken()` resolver (global authToken → sessionStorage fallback, like SipSam's `igmToken`); replenish now sends `game:'rhum32'` so the server uses `RHUM32_TABLE_CONFIG` and reads `data.topUp`.
- Rhum32 round-flow blocker fixed: `rhum32-client/game.js` now re-enables `#decision-controls` Push/Bet on each transition into the `decision` phase. They were disabled by `makeDecision()` and never reset, so from round 2 on the buttons were dead, the 10s timer expired, and the player was auto-folded/DQ'd. Server round loop was already correct.
- Rhum32 table cards shrunk and fanned (`.seat-hand .card` smaller + negative `margin-left`); 6 seats re-arced along the curved side with vertical stagger (`.bj-seat-0..5`) plus a flatter/wider mobile arc so 5-card hands no longer overlap.
- Rhum32 card backs now use the shared VurgLife image: `backVurgLife.png` copied into `rhum32-client/`, `.card-back` switched to it, old gradient/♣ `::before`/`::after` neutralized. Matches SipSam/Blackjack.
- Rhum32 cache-bust bumped: `style.css?v=8`, `game.js?v=13`.
- SipSam public quick-join now matches active rooms only when table tier and selected round count match exactly and a non-banker bot can be replaced.
- SipSam public quick-join no longer drops strangers into waiting lobbies; no matching active table with a replaceable bot creates a new room.
- Added manual daily bonus claiming in `vurglife-platform/server/routes/auth.js`.
- Dashboard now shows an `Accept Bonus` control in `vurglife-platform/client/public/index.html`.
- Daily bonus message after claim: `Come back tomorrow so you do not miss your next Bonus.`
- Daily and watch-ad bonus values match the tier table:
  Bronze 500/300, Silver 700/500, Gold 1000/700, Platinum 1500/1000, VIP 2000/1300, Elite 5000/1700, Celestial 10000/2500.
- Login no longer auto-credits the daily bonus. Players must open the platform and accept the bonus. Missed days do not accumulate.
- Rewards & Milestones now opens with a Player Tiers section explaining minimum bank, daily bonus, and watch-ad bonus for each tier.
- Elite/Celestial SipSam table config now uses the current rule table:
  Elite 7M min bank, 5M wallet, 100K min bet, 100K increments, 500K max;
  Celestial 10M min bank, 7M wallet, 500K min bet, 250K increments, 1M max.
- SipSam Special bonus rule clarified in code: valid declared Specials get house bonuses; multiplier payment comes only from the higher-ranked Special winner.
- SipSam exit handling now trusts active wallet sessions, so a legitimate wallet above the starting draw is returned instead of capped away.
- Platform wallet/session guard added for server-side wallet draw/return consistency across VurgLife game routes.

## Validation Already Run

- `node --check poker-server/index.js`
- Direct extracted `quickJoinForTier` checks for exact tier/round matching, wrong-round rejection, no-bot rejection, waiting-lobby rejection, and final-round rejection.
- `node --check vurglife-platform/server/routes/auth.js`
- `node --check` for changed wallet/Celestial JS files in the previous commit.
- Dashboard HTML script parse via `vm.Script`.
- Tier bonus mapping check against `vurglife-platform/server/lib/tiers.js`.
- `node .claude\scripts\ship-gate.js`
- `git log --oneline -5` after each recent commit.

## Not Yet Live-Tested

- Rhum32 host invite gate: invite controls disabled before rounds picked; enabled after; helper note shows/hides; `sendLobbyInvite` rejects with friendly error if no rounds.
- Rhum32 invitee waiting lobby: friend accepts invite from dashboard, lands in stripped lobby (no rounds/invite/start), sees "Waiting for host…" + Exit Lobby, then transitions to game screen when host starts the round. Mid-game join (host already started) fast-forwards into the live game.
- Rhum32 in-game menu in a live game: open/close slide panel, each accordion section, invite a friend, replenish (WS round-trip + bank/wallet update), send/request chips, exit. Snapshot DB first (replenish/send move money).
- Rhum32 full money loop with a real account: enter ($X drawn from bank via pregame ad), play, exit (remaining returned); pre-game lobby Back returns full walletSize; tab-close beacon. Snapshot `vurglife-platform/data/vurglife.db` first.
- Rhum32 exit returns to dashboard still logged in (no landing-page re-login).
- Rhum32 friends list populates in lobby + in-game invite.
- Rhum32 round 2+ Push/Bet in a live game (platform + authed dashboard→Rhum32 flow required).
- Rhum32 seat/card layout visually at 375px and on desktop (no felt overlap, card back renders).
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

1. Live-test Rhum32 end-to-end (snapshot DB first): full money loop, round 2+ Push/Bet, seat/card layout at 375px + desktop, the new in-game menu (all sections, replenish WS round-trip, send/request, exit).
2. Remaining recovery-doc Rhum32 items if still open after live test: exit-logout edge cases, friends list in production.
3. Start platform and live-test manual daily bonus claim with a copied test DB or after a DB snapshot.
4. Live-test Celestial table entry and exit math with a test account.

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
