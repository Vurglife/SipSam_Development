# VurgLife / PokerProject — Standing Rules

@../ARCHITECTURE.md

ARCHITECTURE.md (imported above) is the canonical map: process/port table,
restart matrix, single-source config, money-path invariants, cache-bust
convention. Read it before editing. These are the non-negotiable rules on
top of it.

## Workflow
- Product owner is tester. Claude does all implementation across sessions.
- Terse output. Skip testing walkthroughs — user is a veteran tester.
- Surface structural decisions (workspace / branch / file / approach);
  never silently pick. Show options, ask.
- One feature per commit. Full file paths in the commit body. Commit ONLY
  when the user explicitly asks.
- Before declaring any task done, run `/ship-check`. The Stop ship-gate
  hook also auto-blocks if changed JS/JSON fails to parse.

## Restart matrix (most "the fix didn't work" reports trace here)
- Server code (`*-server/**`, `vurglife-platform/server/**`) → restart the
  platform (`cd vurglife-platform && npm start`); it respawns game children.
- Client code (`*-client/**`, `vurglife-platform/client/**`) → no restart;
  hard-refresh AND bump `?v=N` on the changed game.js/style.css in that
  client's index.html.
- Any server restart drops in-memory game/session/pendingExit state.

## SipSam config
- Table tiers: edit `shared/sipsam-tables.js` ONLY (server-authoritative,
  single source). The two browser copies (poker-client/game.js
  TABLE_CONFIGS, dashboard TABLES) are display-only mirrors — drift there
  is cosmetic, never a money bug. Update them only to keep dashboard
  labels accurate.

## Money path (regression-prone — treat as critical)
- Route every bank / wallet / refund / session / txn change through the
  `wallet-security-reviewer` subagent before sign-off.
- Invariant: total (bank + wallet) is conserved across enter→play→exit
  except for genuine game wins/losses. /api/game/exit must credit exactly
  once, capped at table walletSize.
- Never edit the SQLite db file directly (deny-listed). Mutate only via
  the DB layer / API. Snapshot before risky DB work (`/db-snapshot`).
- For DB analysis, use the MCP server `vurglife-sqlite-readonly`; it loads
  `vurglife.db` into memory and rejects write SQL.

## Token economy
- Use subagents for exploration / review / analysis — their context is
  isolated and never bloats the main thread.
- Cheap models (haiku) for auxiliary agents (codebase-explorer,
  docs-curator, db-analyst).
- Don't re-explore: ARCHITECTURE.md + auto-memory answer most "where is X".

## UX
- Mobile-first. Design and test at 375px viewport.
- User-facing copy: "Single Player" / "Multiplayer". Never "Solo".
- Commodity games (blackjack, roulette): mimic proven digital
  conventions (WSOP / DraftKings / Zynga). Don't reinvent UX.

## Approval gates (enforced by .claude/settings.json)
- Denied: force-push, `git reset --hard`, `rm -rf`, any `*.db` edit/write,
  secret/key/pem reads.
- Ask: `git push`, `git reset`, `git clean`, `rm`.
- Allowed without prompt: read-only git, npm start/run/test/ci/install,
  db-backup `cp`.
