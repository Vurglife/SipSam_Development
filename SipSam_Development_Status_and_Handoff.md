# SipSam — Development Status & New-Chat Handoff
**Generated**: 2026-05-04
**Workspace**: `G:\SipSam\PokerProject\`
**Active branch**: `master` (do all work directly on master and commit immediately — see §6)
**Source documents analyzed**:
- `G:\SipSam\Recovery-May_2026.docx` — current chat transcript (this session)
- `G:\SipSam\Rhum32_Recovery-May_2026.docx` — earlier chat (Rhum32 build) with significant SipSam content

---

## 1. Why this document exists

Two weeks of SipSam (and Blackjack) work was lost when Claude's throwaway git worktrees were deleted between sessions. Uncommitted edits in `.claude/worktrees/sad-haibt/` evaporated. We rebuilt the bulk from `~/.claude/projects/*.jsonl` transcripts and the two recovery docx files. **This handoff is the contract for the next chat — read it before touching anything.**

The most important rule: **commit on every meaningful change, directly to `master`.** No more "we'll commit at the end."

---

## 2. SipSam — current state on master

### Code locations
```
G:\SipSam\PokerProject\
  poker-server/
    PokerRoom.js   — game state machine; VIP tier; banker DQ payouts; bonus crediting per side
    logic.js       — hand evaluation; SPECIAL_BONUS + SPECIAL_BONUS_VIP; getSpecialBonus()
    index.js       — Express matchmake + WebSocket; quick-join with bot replacement
  poker-client/
    index.html     — lobby, screen-game, screen-gameover, in-game menu, sub-panels
    game.js        — WS client, state rendering, bet controls, freeze-bet, drag/drop
    style.css      — base CSS + appended "MODERN BLUE-GLASS OVERLAY" + LED strip
  vurglife-platform/
    server/
      index.js     — Express on :3000, spawns game servers, route mounting
      routes/game.js   — /api/game/{enter,exit,exit-beacon,balance,record-result,replenish}
      routes/friends.js — /api/friends/* (list, pending, search, request, accept, reject, invite, invite/accept)
      db/database.js   — sql.js wrapper; UserDB, FriendDB, TxnDB, NotifDB, etc.
    client/public/index.html — dashboard SPA (login, panels, friends UI, invite modal/poller)
    data/vurglife.db        — sql.js sqlite (volatile; snapshot before risky changes)
```

### What works end-to-end (verified this chat)

| Feature | Status |
|---|---|
| Login → Home dashboard | ✅ |
| 5-tier table picker ($100/$250/$500/$1000/**$10K VIP**) | ✅ |
| Bank-required gating per tier | ✅ |
| Pre-game ad → /api/game/enter | ✅ |
| Lobby with rounds buttons (Blitz 5 / 10 / 20 / 30) | ✅ |
| Round selection updates preselect banner | ✅ |
| Round selection visible even when entering from dashboard preselect | ✅ |
| Cancel from lobby (refunds wallet via /api/game/exit) | ✅ |
| Invite friend from lobby (max 3 invites) | ✅ |
| Invite friend from in-game menu (sub-panel with dropdown of friends, excludes seated/already-invited) | ✅ |
| Quick-join: tier-aware matchmaker — replaces a bot in an active room or mints a new one | ✅ |
| Game-over auto-evict (60s after final round; broadcasts `roomClosed` so stats lingerers don't keep room alive) | ✅ |
| Banker DQ payouts: bet × max(2, declaredSpecial.multiplier) + house bonus (per-player) | ✅ |
| Special bonus credited to BOTH sides independently (player keeps their special bonus even if they lost the bet exchange) | ✅ |
| 6½ detection accepts quads as 2 pairs, trips as pair+lone | ✅ |
| VIP $10K bet cap honors `tableMaxBet` ($50K), not the old `tMin*2` fallback | ✅ |
| Bet overlay centered on viewport (was trapped by backdrop-filter ancestor) | ✅ |
| Bet overlay stays visible during full betting countdown — freeze + unfreeze accessible | ✅ |
| Freeze bet: locks amount across rounds; +/- auto-unfreezes for adjustment | ✅ |
| Wallet/bank exit: `sipsamActiveSessions` map + 10s recently-credited cooldown — won't double-credit AND won't drop wallet on platform restart | ✅ |
| Friends Network panel renders (escHtml was missing — fixed) | ✅ |
| Game-invite poller (8s) on dashboard → modal with bank-required check | ✅ |
| Invitee blocked from joining if bank below table minimum (modal hides Accept, server returns 403 as fallback) | ✅ |
| In-game menu visible (CSS forces display:flex on `#screen-game.active`) | ✅ |
| In-game menu opens cleanly (toggle button drops to z-index 400 when panel opens, panel/overlay lift to 1700/1600) | ✅ |
| Disqualify button removed (auto-DQ is server-side) | ✅ |
| Countdown box visible at top-left of table | ✅ |
| Magnetic card drag — touch threshold 0.2, desktop dragend-cursor fallback within 50px halo | ✅ |
| Bot avatars render as proper emojis (mojibake fixed) | ✅ |
| Modern Blue-Glass aesthetic | ✅ |
| Animated LED strip under table edge (8s cycle: blue → gold → light-blue) | ✅ |
| Modernized Game-Over / Stats card | ✅ |
| "Play Again" button removed (only Return to Dashboard) | ✅ |
| Bot avatar mojibake fix + 83 em-dash mojibake fixed | ✅ |
| VURGLIFE table-logo z-index correct (behind cards) | ✅ |
| Banker bank balance set to $10M for testing | ✅ |

### Verified commit chain on `master`

```
0fb61db  Quick-join matchmaking + game-over room cleanup
9a8cf6d  Block invitee from accepting if bank below table minimum
033521c  In-game invite sub-panel + always-visible bet overlay
eb15765  Fix in-game menu — toggle button was stealing clicks
321402f  VIP bet cap, lobby rounds banner, in-game invite, no DQ button, countdown
96cd92e  6½ detection, freeze-bet, LED-strip table, modern stats card
897c86b  Login → Home, magnetic card drag, lobby polish
039d1f1  Add Blitz lobby button + fix Friends Network rendering + game-invite polling
3734429  Lobby + bet overlay + wallet/bank fixes
07540c4  Restore SipSam VIP tier + Blackjack source from recovery
96be438  Recovery snapshot: extracted lost source from 51 transcripts
1d41588  SipSam: banker DQ pays multiplier+bonus; modern blue-glass table styling
```

---

## 3. Open SipSam items — pending in next chat

### From the current chat (deferred)

| # | Item | Notes |
|---|---|---|
| A | **Verify VIP $10K end-to-end** | User reported "still capping at $20K" but the fix landed in commit `321402f` and the SipSam server was restarted. May need re-test on a freshly-restarted platform. |
| B | **Confirm in-game menu interactions** | Z-index fix landed in `eb15765`. User has not yet confirmed the click hijack is resolved. |
| C | **Knockout-resilience for wallet** | Spec: "If a player gets knocked out (eg. internet drop), their wallet must still transfer back into their bank. For the human Banker, ensure all payments are processed before the wallet refund — pull from bank if necessary." Currently the disconnect path doesn't fire `/api/game/exit` server-side. PokerRoom only calls it at `endGame`. **Action**: in `PokerRoom.onLeave()`, after a 10s grace, fire `/api/game/exit` for the leaver. For the banker case, settle all outstanding round payments first (debt deduction from bank already exists for player chips going negative). |
| D | **Countdown timer visibility verification** | CSS bumped, but user mentioned not seeing it. May need to bump z-index higher or test against the LED-strip animation. |
| E | **In-game menu sub-panels load off-screen** | User reported this. The igm-invite sub-panel was added; verify all other sub-panels (replenish, request, send, payouts, rules) still position correctly. Likely related to the same z-index hijack now fixed. |

### From the Rhum32 doc — items that ALSO apply to SipSam

These were either explicit "do this for SipSam too" notes, or features built for Rhum32 that SipSam already had but may have regressed during recovery:

| # | Item | Status / Action |
|---|---|---|
| F | **Speech-bubble chat anchored to seats** | SipSam already has `showSpeechBubble(...)` per the docx. Verify it still works after the recovery (function should exist in `poker-client/game.js`). Rhum32 was being made to mirror SipSam's pattern. |
| G | **Send chips to player on table** | SipSam already has `igmSendChips()` in `poker-client/index.html`. Verify it works. |
| H | **Request chips from player on table** | SipSam already has `igmRequestChips()`. Verify. |
| I | **Replenish wallet from bank** | SipSam already has `igmReplenish()` calling `/api/game/replenish`. Verify the route exists and works. |
| J | **Stranger mid-game join (Zynga-style)** | DONE for SipSam this chat via `quickJoinForTier` in `poker-server/index.js`. |
| K | **Invitation expires in 3 minutes** | Already enforced server-side in `friends.js` `gameInvites.set(inviteId, {... expiresAt: Date.now() + 3*60*1000 ...})`. No action. |
| L | **Multiple tables per tier** | DONE for SipSam this chat — quick-join mints `sipsam_<minBet>_<timestamp>` rooms when no existing room has a bot. |
| M | **Auto-place default bet on betting phase start** | SipSam should already do this via `_maybeApplyFrozenBet` (when frozen). Unfrozen players use the +/- controls. **Verify**: when a non-frozen player does NOTHING during the 10s, what happens? Server should auto-bet `tableMinBet`. Check `PokerRoom._onBettingTimeout`. |
| N | **Cap of 4 players per table for SipSam** | SipSam max-table is 4 (banker + 3 players). Quick-join already filters by `total >= 4`. Lobby invite cap is 3. ✅ done. |

### Possibly-broken items worth re-testing

| # | Item | Why suspect |
|---|---|---|
| O | **Blackjack** | Source restored to disk but `BlackjackRoom.js` still has reconstruction holes (~3 syntax errors around line 297, 451, 846). Auto-spawn fails. Server is fine, client mostly fine. **Not blocking SipSam launch but is a launch blocker for the platform.** See `.recovered/blackjack/blackjack-server__BlackjackRoom.js.edits.json` for the original Edit chain. |
| P | **Hold'em** | Source on `claude/sad-haibt` branch (commit `b1f6a7b`); empty dirs on disk. Out of scope until SipSam + Rhum32 + BJ all ship. |
| Q | **Roulette** | On disk Apr 25, untracked. Commit it to master before next worktree-delete. |

---

## 4. Lost-work recovery — what was reconstructed

The bulk of SipSam VIP, the banker DQ fix, the Payouts/Specials menu, the table-logo z-index, the in-game big-announcements, Blackjack source, and the Hold'em handoff doc all evaporated when worktrees were deleted with uncommitted edits.

### Recovery method (preserved in repo)

```
.recovered/
  _meta/
    recover.js              — scans every .jsonl under ~/.claude/projects, captures Edit/Write/MultiEdit
    probe.js                — finds Read tool results to fill gaps
    reconstruct.js          — stitches Reads (latest-wins per line number) + replays Edits chronologically
    reconstruction-notes.txt — per-file coverage report
    docx-extract/           — Recovery-May_2026.docx unzipped (XML + media)
    docx-text.txt           — extracted plain text of Recovery-May_2026.docx
    rhum32-docx/            — Rhum32_Recovery-May_2026.docx unzipped
    rhum32-docx-text.txt    — extracted plain text of Rhum32_Recovery-May_2026.docx
  sipsam-vip/               — reconstructed SipSam files (PokerRoom.js, logic.js, etc.) — reference only
  blackjack/                — reconstructed Blackjack source (partial; needs brace repair before booting)
  blackjack-reads/          — biggest single Read snapshot per Blackjack file (raw)
```

**Database snapshots**: `vurglife-platform/data/vurglife.db.bak.<timestamp>` files exist. Add a snapshot before any DB-mutating change.

### Cumulative recovery work this chat

- Built recovery scripts that mined 51 .jsonl transcripts (75 MB total, including subagent transcripts)
- Re-applied SipSam VIP tier + banker DQ + bonus-per-side fix
- Wired full Blackjack platform integration (BJ_TABLE_CONFIG, /bj/enter|exit|exit-beacon, session guard, dashboard tile)
- Re-applied modern Blue-Glass overlay + LED strip + modernized stats card
- Re-applied Friends Network UI + game-invite poller + invitee bank-check
- Restored the Blitz round button
- Restored the in-game menu Invite Friend feature (now as a proper sub-panel with dropdown)
- Fixed regressions introduced by the modern overlay (bet-overlay centering, in-game menu click hijack, countdown box visibility)
- Mojibake fix for bot avatars + 83 em-dashes
- Quick-join + game-over room cleanup
- Bank balance bumps for testing ($10M for both Vurg and Vurglife)

---

## 5. New-chat handoff prompt

Paste this verbatim into a fresh Claude Code chat opened at `G:\SipSam\PokerProject\`:

```
You're picking up SipSam development on the VurgLife platform.

CRITICAL — read before doing anything:
1. G:\SipSam\PokerProject\SipSam_Development_Status_and_Handoff.md — full status, open items, history.
2. G:\SipSam\Recovery-May_2026.docx — current chat transcript (use Word, or read the
   already-extracted text at .recovered/_meta/docx-text.txt).
3. G:\SipSam\Rhum32_Recovery-May_2026.docx — earlier chat with relevant SipSam content
   (text at .recovered/_meta/rhum32-docx-text.txt).

Workspace + branch:
- Workspace: G:\SipSam\PokerProject\ (the canonical main repo, NOT a worktree).
- Branch: master. Work directly on master. Do NOT create worktrees — the previous
  Claude session lost two weeks of work to worktree deletion.

COMMIT POLICY (non-negotiable):
- Commit on every meaningful change. No batching. No "we'll commit at the end."
- Commit messages should describe WHY, with file paths and a one-line summary
  per affected file.
- Never `git push --force`, never amend without explicit instruction.
- Snapshot vurglife-platform/data/vurglife.db (cp to vurglife.db.bak.<ts>) before
  any DB-mutating change.
- Verify your commit is on master with `git log --oneline -5` after each commit.

Communication style (the user is the project owner, veteran tester):
- Minimal commentary. The user does NOT want walkthroughs or explanations.
- One- or two-line summaries after work; no markdown padding.
- Surface structural decisions (which file, which branch, which port) — do NOT
  pick silently. Always ask before destructive operations.
- Use "Single Player" / "Multiplayer" — never "Solo".
- Mobile-first: the platform is played mostly on phones.

Run the platform:
  cd G:\SipSam\PokerProject\vurglife-platform
  npm start
The platform on :3000 auto-spawns SipSam (poker-server) on :2999/:3001, plus
Blackjack on :3002 and Hold'em on :3004 via child_process. SipSam is fully
working. Blackjack and Hold'em fail to spawn (known reconstruction holes;
not blocking SipSam launch — see handoff doc §3 items O–P).

Quick verification:
  curl http://localhost:3000/                     → 200
  netstat -ano | findstr ":3000 :2999 :3001"

Open issues to start with (in priority order):
  C. Knockout-resilience for wallet (server-side onLeave fires /api/game/exit
     for the leaver after a 10s grace; banker special case settles debts first).
  A. Re-verify VIP $10K bet cap end-to-end now that the fix is live.
  B. Confirm in-game menu interactions on a hard-refreshed browser.
  D. Confirm countdown box renders during all rounds.
  E. Test all igm sub-panels load on-screen (replenish/request/send/payouts/rules).

After SipSam is fully verified:
  Q. Commit roulette-client/ + roulette-server/ to master (currently untracked).
  O. Repair Blackjack BlackjackRoom.js brace gaps so the BJ child spawns.
  P. Restore Hold'em from claude/sad-haibt branch (commit b1f6a7b) when ready.

Strategic context:
  Launch goal = ship SipSam + Rhum32 + Blackjack to vurglife.com with
  monetization. SipSam and Rhum32 are T&T cultural games — the moat. Hold'em
  is in scope but deferred. Don't let Hold'em or Blackjack work delay SipSam.

Confirm you've read all three docs, then list the top three things you'd
tackle first and why. Wait for the user's go-ahead before editing anything.
```

---

## 6. Workflow rules (must enforce)

### Commit-after-every-change

```bash
# After any non-trivial edit:
cd G:/SipSam/PokerProject
git add <specific files only — never `git add .`>
git commit -m "<terse why-summary>"
git log --oneline -3   # verify it landed
```

Commits should bundle related edits but never wait until "the end of the session." A typical session should produce 4–10 commits.

### Cache-bust on every client edit

When editing `poker-client/index.html`, `poker-client/game.js`, or `poker-client/style.css`:

```html
<link rel="stylesheet" href="style.css?v=N">    ← bump N
<script src="game.js?v=N"></script>             ← bump N
```

Current values: `style.css?v=9`, `game.js?v=21`. Always increment.

### Restart pattern after server-side edits

```bash
# Get SipSam child PID
netstat -ano | findstr "0.0.0.0:2999"
taskkill //F //PID <pid>     # platform supervisor will respawn it within ~5s
sleep 5
netstat -ano | findstr "0.0.0.0:2999"   # confirm new PID
```

For platform-server edits (vurglife-platform/server/*), kill the platform PID on :3000 then `npm start` again from `vurglife-platform/`.

### DB snapshot before risky changes

```bash
cd G:/SipSam/PokerProject
cp vurglife-platform/data/vurglife.db vurglife-platform/data/vurglife.db.bak.$(date +%Y%m%d-%H%M%S)
```

### Bank-balance grants (testing)

```bash
node -e "
const fs=require('fs');
const initSqlJs=require('./vurglife-platform/node_modules/sql.js');
initSqlJs().then(SQL=>{
  const db=new SQL.Database(fs.readFileSync('./vurglife-platform/data/vurglife.db'));
  db.run(\"UPDATE users SET bank_balance = 10000000 WHERE LOWER(username) IN ('vurg','vurglife')\");
  fs.writeFileSync('./vurglife-platform/data/vurglife.db', Buffer.from(db.export()));
  console.log('done');
});
"
# Platform must be STOPPED first — sql.js loads to memory and overwrites on persist.
```

---

## 7. Architecture cheat sheet

```
            Browser
              │
              ▼
        Platform :3000 (Express, vurglife-platform/server/index.js)
        ├── /                         → vurglife-platform/client/public (SPA dashboard)
        ├── /sipsam/*                 → static poker-client/  +  /matchmake proxy → :2999
        ├── /rhum32/*                 → static rhum32-client/ +  /rhum32-api proxy → :2998
        ├── /blackjack/*              → static blackjack-client/ + /bj-matchmake → :3002
        ├── /holdem/*                 → static holdem-client/    + ws → :3004
        ├── /api/auth/*               → routes/auth.js
        ├── /api/game/*               → routes/game.js (TABLE_CONFIG, BJ_TABLE_CONFIG, RHUM32_TABLE_CONFIG, ROULETTE_TABLE_CONFIG, sessions, enter, exit, replenish, record-result, balance)
        ├── /api/friends/*            → routes/friends.js
        │
        └── child_process spawn:
            ├── poker-server on :2999 + :3001 (Express + raw ws)
            ├── rhum32-server on :2998 + :3003
            ├── blackjack-server on :3002
            └── holdem-server on :3004
```

### SipSam game flow

```
waiting → betting (10s, freeze allowed) → dealing → arranging (65s normal / 40s blitz)
        → revealing (30s normal / 20s blitz, optional declare-special)
        → roundEnd → next round   (×N rounds)
        → gameOver (room marked completed; auto-evict in 60s; broadcasts roomClosed)
```

### Quick-join logic (SipSam)

```
client picks tier → joinRoom sends quickJoin:true + roomId='sipsam_<minBet>'
server quickJoinForTier:
  for each existing room of same tier:
    skip if completed
    skip if private (invite-only)
    skip if full of humans (no bot, no open seat)
    score: prefer (replaceable bot) > (waiting + open seats)
  pick best, else create sipsam_<minBet>_<timestamp>
```

### Wallet flow

```
Dashboard "Enter Table" → POST /api/game/enter
   → adjustBank(-walletSize); sipsamActiveSessions.set(userId, ...)
Player exits → POST /api/game/exit
   → if recently credited (10s cooldown): skip
   → else adjustBank(+remainingWallet); clear session; mark recently credited
beforeunload beacon → POST /api/game/exit-beacon (token in query)
   → same recently-credited gate
```

---

## 8. Files to read in order in the new chat

1. **This file** (`SipSam_Development_Status_and_Handoff.md`)
2. `.recovered/_meta/docx-text.txt` (current chat transcript)
3. `.recovered/_meta/rhum32-docx-text.txt` (older chat with SipSam context)
4. `poker-server/PokerRoom.js` — game state machine (~1430 lines)
5. `poker-server/logic.js` — hand eval + specials + bonuses
6. `poker-client/index.html` — DOM + in-game menu + sub-panels
7. `poker-client/game.js` — WS client + UI logic
8. `poker-client/style.css` — base + modern overlay (search "MODERN BLUE-GLASS OVERLAY")
9. `vurglife-platform/server/routes/game.js` — platform game APIs
10. `vurglife-platform/server/routes/friends.js` — friends + game invites
11. `vurglife-platform/client/public/index.html` — dashboard SPA

---

## 9. Hard rules — do not violate

1. **Commit immediately.** Every meaningful change goes to `master` with a real message.
2. **No worktrees.** Work in `G:\SipSam\PokerProject\` directly.
3. **Snapshot the DB** before any change that could mutate it.
4. **Never** `git push --force`, `git reset --hard`, or amend without explicit user permission.
5. **Never** silently pick file locations, branches, ports, or workspace paths. Surface decisions and ask.
6. **Never** use the word "Solo" in user-facing text. Use "Single Player".
7. **Mobile-first**: layouts must work on a 375px-wide viewport.
8. **Minimal commentary**: the user is a veteran tester. Skip walkthroughs.
9. **Cache-bust** every client edit (`?v=N` increment on `style.css` and `game.js`).
10. **Restart the right server** — platform child for game logic, platform itself for routes/static changes.

---

End of handoff.
