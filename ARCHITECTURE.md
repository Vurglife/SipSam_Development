# VurgLife Platform — Architecture & Working Reference

**Read this first in every new chat.** It is the canonical map so you don't
re-explore. Keep it updated when structure changes (a `docs-curator` job).

Workspace root: `G:\SipSam\PokerProject\`
Repo: single git repo, branch `master`. Commit per feature, full file paths
in the commit body, only commit when the user asks.

---

## 1. Process & port map

The platform spawns every game server as a child automatically — you only
ever start the platform.

| Component | Entry | Ports | Served at |
|---|---|---|---|
| **Platform** (Express, dashboard, auth, bank API) | `vurglife-platform/server/index.js` | **3000** | `http://localhost:3000` |
| **SipSam** game server | `poker-server/index.js` | matchmake/HTTP **2999**, WS **3001** | `/sipsam` |
| **Blackjack** | `blackjack-server/index.js` | WS **3002** | `/blackjack` |
| **Hold'em** | `holdem-server/index.js` | WS **3004** | `/holdem` |
| **Rhum32** | `rhum32-server/index.js` | (own) | `/rhum32` |
| **Roulette** | `roulette-server/index.js` | API **3005**, WS **3006** | `/roulette` |

Run everything:
```
cd G:\SipSam\PokerProject\vurglife-platform
npm start
```

### Restart rules (critical — most "my fix didn't work" reports trace here)
- Editing **platform** code (`vurglife-platform/server/**`) → restart the
  platform (Ctrl+C, `npm start`). This also respawns all game children.
- Editing a **game server** (`poker-server/**`, `blackjack-server/**`, …) →
  the child process must restart. Restarting the platform is the reliable
  way; killing just the child PID also works.
- Editing **client** files (`poker-client/**`, `vurglife-platform/client/**`)
  → no restart; hard-refresh the browser **and** bump the cache-bust (below).
- In-memory game/session state is lost on any server restart. Mid-game
  restarts drop room state and pending exits.

---

## 2. Database

- File: `vurglife-platform/data/vurglife.db` (sql.js / SQLite).
- DB layer: `vurglife-platform/server/db/database.js` (`UserDB`, `TxnDB`,
  `FriendDB`, `NotifDB`).
- **Always snapshot before risky DB work:**
  `cp vurglife-platform/data/vurglife.db vurglife-platform/data/vurglife.db.bak.<timestamp>`
  (this `cp` is allow-listed in `.claude/settings.json`).
- The db file is deny-listed for Edit/Write — mutate only through the API/DB
  layer or sqlite, never by editing the file.
- Read-only analysis MCP: `.mcp.json` registers `vurglife-sqlite-readonly`,
  implemented at `.claude/mcp/sqlite-readonly-server.js`. It loads the DB
  into memory with `sql.js`, caps results, and rejects write SQL.
- Test accounts: `Vurg`, `Vurglife`.

---

## 3. TABLE_CONFIG — server is single-source ✅

**Authoritative money config:** `shared/sipsam-tables.js` (UMD module).
The server reads ONLY this — never an inline copy:
- `vurglife-platform/server/routes/game.js` → `require('../../../shared/sipsam-tables.js')`
- `poker-server/PokerRoom.js` → top-level `require('../shared/sipsam-tables.js')`,
  used by both `_onStartGame` and `_applyTableConfigFromRoomId`.

**To add/adjust a tier: edit `shared/sipsam-tables.js` ONLY.** All server
money paths pick it up on restart. No more 4-way edit; the Elite-increment
and wallet-refund desync bug class is structurally eliminated.

**Two browser DISPLAY-ONLY mirrors remain** (cosmetic — they set dashboard/
lobby labels, NOT what the player is charged; the server bills correctly even
if they drift):
- `poker-client/game.js` → `TABLE_CONFIGS` (field name `bankRequired`)
- `vurglife-platform/client/public/index.html` → `TABLES` (fields `inc`,
  `wallet`, `minBank`) + `buildGrid` tier-label branch logic

Update the two mirrors only when you want the dashboard label/preview to
match a tier change. A drift here is cosmetic, never a money bug.

Current SipSam tiers (minBet → bank / wallet / increment / maxBet):
`100`→5K/3K/50/150 · `250`→15K/10K/50/500 · `500`→30K/20K/100/1K ·
`1000`→60K/40K/500/2K · `10000`→2M/1M/10K/50K (VIP) ·
`100000`→7M/5M/100K/500K (Elite) · `500000`→10M/7M/250K/1M (Celestial)

---

## 4. Tier system

- **Single source of truth (server):** `vurglife-platform/server/lib/tiers.js`
  — `TIERS`, `computeTier`, `dailyBonusFor`, `adBonusFor`, `WELCOME_BONUS`.
- Bonuses scale by the player's bank tier at claim time. Daily bonus is
  awarded once per 24h on first login; ad bonus per watch-ad claim.
- **Client mirrors** (hardcoded copies — keep in sync with tiers.js):
  - `vurglife-platform/client/public/index.html` → `PLATFORM_TIERS`
  - `poker-client/index.html` → `SIPSAM_TIERS`
- Tiers (minBank / daily / ad): Bronze 5K/500/300 · Silver 15K/700/500 ·
  Gold 30K/1K/700 · Platinum 60K/1.5K/1K · VIP 2M/2K/1.3K ·
  Elite 7M/5K/1.7K · Celestial 10M/10K/2.5K. Below $5K = Unranked
  (locked out of real-money tables). New accounts get a $10K welcome bonus.

---

## 5. Cache-bust convention

When `poker-client/game.js` or `style.css` (or the blackjack equivalents)
changes, bump the query string in the client HTML so browsers refetch:
- `poker-client/index.html`: `<script src="game.js?v=N">` and
  `<link ... href="style.css?v=N">` — increment `N`.
- Same pattern for `blackjack-client/index.html`.

---

## 6. Money-path invariants (regression-prone — verify on every change)

- `/api/game/enter` deducts `walletSize` from bank, logs a `wallet_draw`
  txn, sets an in-memory session.
- `/api/game/exit` (+`/exit-beacon`) credits remaining wallet back to bank
  exactly once. Guards: synchronous `_ssMarkCredited` cooldown + session /
  unsettled-`wallet_draw` check + credit capped at table `walletSize`.
- Mid-round exit is **deferred to round end** (`pendingExit`). Exit during
  arrange phase auto-DQs (lose bet to banker) so reveal can start; exit
  during `roundEnd`/waiting settles immediately.
- Net rule: wallet at exit transfers to bank exactly; total (bank + wallet)
  must be conserved across enter→play→exit barring real game wins/losses.
- Route any wallet/bank/refund change through the `wallet-security-reviewer`
  agent.

---

## 7. Specialized sub-agents (use proactively — they don't cost main-thread tokens)

- Reusable plugin package: `.claude-plugin/marketplace.json` exposes
  `plugins/vurglife-dev-os` for these agents/skills/hooks plus the read-only
  SQLite MCP server.
- `wallet-security-reviewer` — any bank/wallet/refund/session/txn change.
- `game-rules-validator` — SipSam payouts, specials, banker logic, round flow.
- `frontend-reviewer` — UI/layout/responsive/overlay/mobile.
- `codebase-explorer` — locate code / architecture questions.
- `data-analyst` — metrics, schema, events, player behavior.
- `docs-curator` — keep this file + handoff docs current.

Mobile-first: design/test at 375px. User-facing copy: "Single Player" /
"Multiplayer" (never "Solo").

---

## 8. Key reference docs

- `ARCHITECTURE.md` (this file) — structure, ports, restart, config map.
- `SipSam_Development_Status_and_Handoff.md` — SipSam status/history.
- `VurgLife_Blackjack_Handoff.docx` — Blackjack work queue.
- `Fixes_required.docx` — current tier/table spec source.
- `~/.claude` auto-memory `MEMORY.md` — persists across chats; points here.
