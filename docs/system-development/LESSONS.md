# Lessons

## Reusable Patterns That Worked

- Keep a concise current handoff before touching code.
- Use project files for durable decisions, validation, lessons, and roadmap.
- Validate end-to-end game and platform flows after meaningful changes.
- Snapshot sensitive platform data before risky changes.
- Per-round action buttons (Push/Bet, arrange, etc.) that get `disabled = true` on use MUST be re-enabled when the phase is re-entered, keyed on the status transition (`status !== prevStatus`), not on every state tick. Symptom of the bug: round 1 works, round 2+ buttons are dead, the timer expires, the player is auto-folded/DQ'd. SipSam re-enables explicitly at phase start (`poker-client/game.js` ~1144/1250); Rhum32 had the gap (fixed 2026-05-18). Check Blackjack for the same class ("countdown blocking bet options" in the recovery doc).
- A game's exit/refund fix is meaningless unless its ENTER path actually drew the bank. Verify enter and exit symmetrically and trace the real entry path end-to-end — Rhum32 had a second entry function (`enterRhum32Table`) that bypassed the shared `confirmEnter` ad/draw flow, so the bank was never charged and "wallet not returning" was actually "wallet never drawn." Each game should funnel through the one shared `runAd('pregame')→confirmEnter` path; per-game bespoke entry functions are a money-path smell.
- Route every wallet/bank/refund change through `wallet-security-reviewer` before commit (ARCHITECTURE.md §6). It caught the missing-enter blocker above that static checks and the diff alone did not surface — the bug was in a *different* file than the change.
- Wallet draws must be game-server-authoritative: the client sends a WS request, the game server calls the platform `/api/game/replenish` with the player's JWT and credits the in-game wallet. If the client both calls the platform AND tells the server, you double-deduct the bank. Pattern: thread the token client→matchmake→session→`player.token`; SipSam `poker-server/PokerRoom.js _onReplenishWallet` is the reference.
- When a game server stores the player JWT on the player object, it MUST be stripped from every state broadcast. Rhum32 `getPublicState` does `delete player.token` on the deep clone before send; verify all egress paths (`broadcastState`, `broadcast`, request-state, hand-built msgs) when adding any secret to server-side player state.
- Invite payloads carry tier + rounds — the host UI must gate invite issuance until both are chosen, or invitees land in mismatched/default rooms. Pattern: disable invite input + button + show a helper note until `selectedRounds > 0`; `sendLobbyInvite` also hard-rejects with a friendly error. Invitees skip mode-select entirely (`isInvitedJoiner === true && roomId` in their `<game>_table` sessionStorage) and get a stripped lobby — rounds/invite/start hidden, Back relabeled to "Exit Lobby", "Waiting for host…" message — auto-connecting to the host's specific room without sending `startGame`. SipSam reference: `setupInvitedJoinerLobby` / `isInvited` checks in `poker-client/game.js` ~1767; Rhum32 mirror added 2026-05-20.
- Invite accepts that carry a specific room ID must also set `isPrivate:true`/`isInvitedJoiner:true` in session storage. Otherwise SipSam matchmake treats `sipsam_<tier>_<timestamp>` as a public quick-join tier hint and redirects the invitee into a different room.
- SipSam table tiers must be validated from the full entry path, not just the display card. Check dashboard `TABLES`, `shared/sipsam-tables.js`, `poker-client/game.js`, matchmake room id, `PokerRoom.gameState.tableMinBet/tableKey`, and `/api/game/enter` together. A Celestial badge can still sit on a $100 game if one hop falls back to default.
- SipSam Special settlement rule: valid declared Specials always receive their house bonus; the multiplier exchange is paid only to the higher-ranked Special winner. Never charge the losing side for house bonuses.
- Active wallet sessions should trust the live wallet amount on exit. Only fallback exits with no active session should cap to the original wallet draw; otherwise legitimate winnings can disappear.

- For recovered Blackjack client work, keep behavior in `blackjack-client/game.js`, visuals in `style.css`/`vl-card.css`, and markup in `index.html`. Do not re-add raw recovered inline `<style>` or `<script>` blocks to the bottom of `index.html`; they previously left malformed markup and dead menu paths.
- On this Windows workspace, use PowerShell searches when `rg` is blocked by permissions. Avoid PowerShell `Set-Content` for broad edits to existing UTF-8 game files with non-ASCII comments; use `apply_patch` for manual edits and UTF-8-safe tooling only when a mechanical cleanup is unavoidable.

## Do Not Repeat

| Date | Approach | Why It Failed or Wasted Cost | Better Path |
| --- | --- | --- | --- |
| 2026-05-15 | Rely on uncommitted throwaway worktrees or chat memory for important changes. | Existing handoff reports prior work was lost when temporary worktrees were deleted. | Commit meaningful changes promptly according to the project rule and preserve concise project memory in files. |
| 2026-05-15 | Start future work by rereading every large document. | It wastes time and tokens. | Read this folder first, then use targeted searches or specific handoff sections only when needed. |
| 2026-05-15 | Put every Claude Code rule into always-loaded `CLAUDE.md`. | It increases token use every session and makes procedures harder to trigger intentionally. | Keep `CLAUDE.md` short and move repeatable workflows into `.claude/skills`. |
| 2026-05-15 | Make Claude Code agents read-only when the user wants implementation handled by Claude. | It reduces Claude Code's usefulness and leaves more manual work for Mitstar. | Let specialist agents edit when requested, but keep safety rules around secrets, destructive commands, direct database edits, and validation. |
| 2026-05-15 | Leave meaningful Claude Code work uncommitted. | The project already lost substantial uncommitted work. | Claude Code should commit current-task changes after validation and avoid staging unrelated files. |

## Removed Failed Artifacts

| Date | Artifact | Reason Removed | Lesson Preserved |
| --- | --- | --- | --- |
|  |  |  |  |
