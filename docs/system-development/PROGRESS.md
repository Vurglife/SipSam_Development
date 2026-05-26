# Progress

## Current State - 2026-05-18

- Active repo: `G:\SipSam\PokerProject` (Rhum32 lives only here — untracked, not in any worktree)
- Active branch: `master`
- Recent anchors: `2a56050 Implement Blackjack fixed tier tables`; `6e0d252 Add tier explainer to rewards dashboard`; `119d815 Add current progress handoff for Claude sessions`; `ce8146a Require manual daily bonus claims`; `a6ea242 Fix Celestial table config and wallet session accounting`
- Platform run command: `cd G:\SipSam\PokerProject\vurglife-platform && npm start`

## Completed Recently

- **SipSam side bets (steps 1–7 of 7).** Three new optional bets per the locked spec at `docs/system-development/sidebets-spec.md`: **First Special** (single table-wide pot, multi-round, top-up each round, ranked tie-break), **Beat Hand** (multi-pot player-vs-player, banker excluded, best-of-3 SipSam hand-compare, 1.5–1.5 split), **Best Card** (multi-pot, suit-tiebreak H>S>D>C, banker may participate). All wallet-only, no rake, bot auto-decline, `pendingExit` auto-decline, forfeit-on-exit, game-end refund. New phase `sideBetPhase` (7s per active type) inserted between reveal and next round's betting. Server: `poker-server/sideBets.js` is the new module; `poker-server/PokerRoom.js` wires dispatch, phase, declare-special hook, startRound top-up, endGame refund. Client: `#sidebets-panel` in `poker-client/index.html` (initiate buttons during reveal, accept/decline rows during sideBetPhase, active-pot summary, modal for value/target picker), `poker-client/style.css` new section (mobile stacks below 600px), `poker-client/game.js` renderSideBets + sbOpen/sbAccept/sbDecline helpers. Cache-bust `style.css?v=30`, `game.js?v=45`. Reviewed by `wallet-security-reviewer` agent: PASS on money invariants (chip conservation, bank-untouched, idempotency, no double-credit, integer math, forfeit-on-exit). Defence-in-depth fixes applied: every `_accept*` re-checks `pendingExit` and `sideBetsAllowed`; Beat Hand decline by a non-target now logs a warning.

  **Known limitations to follow up on:**
  - **Best Card carry-over not yet implemented** (deferred as "step 3b"). Current behaviour when no participant holds the chosen value: refund equally and close the pot. Spec section §3 calls for the pot to carry to the next round with the same participants topping up and the original initiator picking a new value. No chip leak (refund == pot), but behaviour deviates from spec until step 3b lands.
  - **Server restart mid-`sideBetPhase` loses the in-flight pot.** Stakes were already deducted from `player.chips` but the pot lives in-memory only. Matches the main-game behaviour for the same restart class; flagged here so production runbook is aware. A future hardening pass could persist active side-bet pots to the DB.
  - **Wallet-shortfall on main-game bet after side-bet stake.** If a player's wallet is depleted by initial side-bet stakes such that the next `startRound` assignment of `player.bet = tableMinBet` drives them negative, the existing banker-debt path at settlement is expected to handle bankruptcy (drawing from bank). Not side-bet-specific; flagged for a runtime confirmation pass during smoke-testing.

- SipSam public Multiplayer bot-replacement quick-join now preserves the dashboard table/round selection before sessionStorage is cleared, so matchmake receives the selected `maxRounds` and can match active rooms by tier + round count. Cache-bust `style.css?v=29`, `game.js?v=44`.

- Dashboard friend chip sending finished. The main Bank panel now owns the send-chips flow, and Friends Network has shortcuts both at the top and on each friend card. The shared flow loads accepted friends, lets the player select one, validates a whole-chip amount against the current bank balance, and calls the new server-authoritative `POST /api/friends/chips/send` endpoint. The endpoint only allows accepted friends, rejects self/non-friend/invalid/over-bank sends, debits the sender bank, credits the recipient bank, records `chip_transfers`, and creates a recipient inbox message plus platform notification stating the sender and amount. `TransferDB.send` now rejects non-positive amounts and performs the debit/credit/transfer insert in one transaction.

- Rhum32 casino visual modernization pass finished. `rhum32-client/style.css` now adds a high-contrast casino layer across the mode select, multiplayer lobby, game table, bottom betting controls, in-game menu, and chat: black/velvet surfaces, brighter ivory body text, champagne-gold value emphasis, ruby felt, and emerald used mainly for live state/success cues. The prior low-contrast green/gold menu and bottom panel colors are overridden, background glow/orb effects are disabled, card/table/seat contrast is boosted, and mobile guardrails were added for touch-size controls, wrapped table metadata, narrow-phone mode/lobby cards, and stacked betting controls. The client cache-bust is now `style.css?v=13`.

- Rhum32 Table 4 payout and settlement pass finished. `rhum32-server/logic.js` now applies the supplied payment chart across Normal, VIP, Elite, and Celestial: 1-3 replaces the old 1-5 tier, 4-7 starts at value 4, all special bonuses match the new Normal/VIP/Elite/Celestial amounts, and 47/48/49/50 face-special back multipliers are table-tier aware. Dealer busts now still pay the correct special back multiplier/bonus while tie bets pay only when `playerValue === dealerValue`, including double-bust ties. Rhum32 round settlement now passes `tableMinBet` into the logic engine, draws any unpaid losses from bank via `/api/game/debt-payment`, queues mid-round exits until the round resolves, and calls trusted server-side `/api/game/rhum32/exit` when pending exits or full games complete. The platform wallet recent-credit guard now lets trusted Rhum32 server settlement reconcile both higher and lower final wallet amounts after a client beacon. `RoomManager` now preloads front/tie increments into waiting-room state. Rhum32 in-game payouts menu updated to the new chart and cache-bust `game.js?v=24`.

- Rhum32 six-tier table ladder continuation finished. The in-progress Claude Code config change is now synchronized across `rhum32-server/Rhum32Room.js`, `vurglife-platform/server/routes/game.js`, and dashboard `RHUM32_TABLES`: `$100`, `$500`, `$1,000`, `VIP $10,000`, `Elite $100,000`, `Celestial $250,000`. The dashboard table cards and requirements table no longer advertise the removed `$5,000` table or "No Limit" tie bet. Rhum32 client now carries `frontInc`/`tieInc` from session/invite/server state, updates front/tie button labels per tier, and sends those increments in lobby and in-game invites. Server now snaps front/tie bet amounts to the configured increments, while preserving reachable max bets such as Celestial `$1,000,000`. Removed the duplicate best-effort `/api/game/<game>/enter` call in dashboard `confirmEnter()` after the mandatory wallet funding call succeeds. Cache-bust `game.js?v=23`.

- Rhum32 look-and-feel pass: dropped the green palette (user dislike), adopted a deep **burgundy / wine** felt — `--felt: #5a0c20`, `--felt-dk: #3d0814`, `--felt-lt: #7a162c` — distinct from SipSam blue and Blackjack navy, classic baccarat-room feel. Replaced the text "RHUM32" watermark with the shared **VurgLife logo image** (`VurgLife_logo_table.png` copied into `rhum32-client/`, rendered via SipSam's `<img class="table-logo">` pattern at 46% width, 18% opacity, z-index 1). The bare freeze checkbox is now a **premium gradient button** styled after Blackjack's `.freeze-btn-bar` but recoloured to the Rhum32 gold palette: subtle gold-on-dark default, brighter on hover, solid gold gradient + glow when active, with a small `FROZEN` indicator chip beside it. `toggleFreeze` drives the active class + label flip (🔒 Freeze Bets ↔ 🔒 Bets Frozen). Cache-bust `style.css?v=11`, `game.js?v=22`.
- Rhum32 tie-bet payout rule corrected. Previous commit (`1e26d84`) misread the spec and paid the tie bet on ANY dealer bust. Correct rule: tie bet pays iff `playerValue === dealerValue` — bust state is irrelevant. Both busting at equal totals (40 vs 40, 35 vs 35) is still a tie and still pays 20:1. Dealer bust at a different value is a normal front-bet win with tie bet LOST. Implemented by moving the equality check before the `dealerCrossed` branch in `logic.js` and restoring the `tieBet` deduction in the dealer-bust branch of `Rhum32Room.resolveRound`.
- Rhum32 freeze now covers both bets + wider seat arc. `Rhum32Room.startRound` preserves `tieBet` (in addition to the already-frozen `frontBet`) when `p.frozen === true`, and the client `renderState` betting-phase entry re-syncs `currentFrontBet`/`currentTieBet` from `state.players[me]` for frozen players (no double-send to server). Seat layout adopted from Blackjack: `4% / 12.8% / 35.8% / 64.2% / 87.2% / 96%` left + `8% / 56% / 84%` three-tier vertical stagger — 5-card fanned hands no longer crowd neighbours even on mobile. `.seat-hand .card` slightly smaller (`clamp(24px,3vw,31px)`) with `-11px` overlap (was `-15px`) so each card's rank/suit stays legible. Felt got a golden vignette + a deeper outer ring shadow for a more table-feel finish. Cache-bust `style.css?v=10`, `game.js?v=21`.
- Rhum32 game-over stats now show net win/loss per player. Standings sort by net change (not gross wallet); each row displays the net (green `+$X` / red `−$X` / gold `$0`) plus the final wallet underneath. Headline reads "YOU WON +$X" / "YOU LOST −$X" / "YOU BROKE EVEN $0" plus rank-of-N and final wallet — past-tense, no `!` so the gold serif headline font doesn't render "YOU WIN!" as "YOU WINI". Server now tracks `startingWallet` (wallet at room join) and `replenishTotal` (sum of every bank top-up during play) on each player so net = `wallet − startingWallet − replenishTotal` is an honest "did this game put chips in or out" number rather than a bank-deep-pockets ranking. Cache-bust `game.js?v=20`.
- Rhum32 tie-bet payout fixes:
  - **Dealer-bust now pays the tie bet 20:1** as long as the player stayed in (didn't fold). Previously the `dealerCrossed` branch in `logic.js` never computed `tiePayout`, and `Rhum32Room.resolveRound`'s dealer-bust branch *subtracted* `p.tieBet` — so a player with a tie bet got a double penalty on dealer bust. Folded players are already filtered out before resolution.
  - **Race-condition fix for tie-bet placement.** `dealFourCards` flips status straight from `betting` → `decision`, and `_onPlaceTieBet`'s status guard silently dropped messages that arrived ~ms late. Now: server logs the rejection and sends a new `tieBetRejected` message with the actually-stored `tieBet` value; client rolls the on-screen tie-bet display back to that value and shows a "Bet refused" toast, so the player no longer waits for a payout that will never come. Client `adjustTieBet` also hard-gates on `lastStatus === 'betting'` so post-window clicks don't fire at all.
  - Cache-bust `game.js?v=19`.
- Rhum32 multiplayer lobby end-to-end fix: invitees now actually land in the host's lobby.
  - **Root cause:** the host's `currentRoomId` was null when `sendLobbyInvite()` fired because `connectAndStart()` did join + startGame in one shot. The invite carried no real roomId, so the invitee's matchmake call fell through to `joinOrCreate` and landed in a brand-new room.
  - **Server (`rhum32-server`):** matchmake now accepts `isHost: true` and routes hosts to `createRoom` (a fresh private room) instead of `joinOrCreate` (the strangers' quick-join path). `pendingSessions` propagates `isHost` through to `Rhum32Room.onJoin`, which sets `this.hostUsername` only on the first explicit-host joiner; the player object now carries `isHost`. `_onStartGame` rejects any non-host attempt. `onLeave` promotes the next remaining human to host if the host bails before the round starts.
  - **Client host:** new global `ensureHostRoom()` opens the WS room as soon as rounds are picked in Multiplayer mode (called from `selectRounds`); `sendLobbyInvite` awaits it before POSTing the invite so `roomId` is always real. `connectAndStart` no longer re-joins for multiplayer — it just sends `startGame` on the already-open socket. Single-player still creates its room on Start.
  - **Client invitee:** `enterAsInvitee()` now POSTs `/api/game/rhum32/enter` first (drawing bank → wallet via the same path the host uses) and only then `connectAsInvitee(roomId)` direct-joins the host's room. Bank-draw failure shows an error and bounces back to dashboard.
  - **Lobby player list:** new `#lobby-players-wrap` in `screen-lobby` is populated by `renderLobbyPlayers(state)` from each `stateUpdate` while `status === 'waiting'`. Shows HOST/READY tags, highlights the local player, visible to both host and invitees so everyone confirms they're in the same room before the host hits Start.
  - **Late join still works:** matchmake's roomId path is unchanged (direct-join an existing room); 6-seat cap enforced server-side; 3-min invite TTL already enforced at `/api/friends/invite/accept`.
  - Cache-bust `game.js?v=18`.
- Rhum32 game-over screen rebuilt to match SipSam stats pattern. Removed the "Play Again" button (was `location.reload()`); single `🏠 Return to Dashboard` button now wires to `rhumSettleAndLeave()` so any remaining wallet returns to bank via `/api/game/rhum32/exit` before navigating to `/`. Added `#gameover-result` headline ("YOU WIN!" / "2nd Place" / "Finished #N" + Final Wallet) above the sorted standings; standings now include 🏆/🥈/🥉/#N medals and a gold outline + "(you)" tag on the local player's row. Cache-bust `game.js?v=17`.
- SipSam Multiplayer invite accept now preserves the host's exact room and marks the invitee as private/invited. Root cause: dashboard accept stored `roomId` but not `isPrivate`, so SipSam matchmake treated `sipsam_<tier>_<timestamp>` as a public quick-join hint and created/joined a different room. Cache-bust `style.css?v=28`, `game.js?v=43`.

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
- `node --check poker-client/game.js`
- Dashboard HTML script parse via `vm.Script` with SipSam invite private-room assertions.
- Direct extracted `quickJoinForTier` checks for exact tier/round matching, wrong-round rejection, no-bot rejection, waiting-lobby rejection, and final-round rejection.
- `node --check vurglife-platform/server/routes/auth.js`
- `node --check` for changed wallet/Celestial JS files in the previous commit.
- Dashboard HTML script parse via `vm.Script`.
- Tier bonus mapping check against `vurglife-platform/server/lib/tiers.js`.
- `node .claude\scripts\ship-gate.js`
- `git log --oneline -5` after each recent commit.

## Not Yet Live-Tested

- SipSam two-account invite acceptance: host and invited friend should see each other in the same waiting lobby, and the host's lobby timer/start should move both into the same game room.
- Rhum32 host invite gate: invite controls disabled before rounds picked; enabled after; helper note shows/hides; `sendLobbyInvite` rejects with friendly error if no rounds.
- Rhum32 invitee waiting lobby: friend accepts invite from dashboard, lands in stripped lobby (no rounds/invite/start), sees "Waiting for host…" + Exit Lobby, then transitions to game screen when host starts the round. Mid-game join (host already started) fast-forwards into the live game.
- Rhum32 game-over screen: at game end, Return to Dashboard refunds remaining wallet to bank (via `/api/game/rhum32/exit`) and lands back at `/` still logged in; standings + result headline render correctly for the local player.
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
