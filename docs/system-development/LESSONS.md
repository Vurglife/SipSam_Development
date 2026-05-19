# Lessons

## Reusable Patterns That Worked

- Keep a concise current handoff before touching code.
- Use project files for durable decisions, validation, lessons, and roadmap.
- Validate end-to-end game and platform flows after meaningful changes.
- Snapshot sensitive platform data before risky changes.
- Per-round action buttons (Push/Bet, arrange, etc.) that get `disabled = true` on use MUST be re-enabled when the phase is re-entered, keyed on the status transition (`status !== prevStatus`), not on every state tick. Symptom of the bug: round 1 works, round 2+ buttons are dead, the timer expires, the player is auto-folded/DQ'd. SipSam re-enables explicitly at phase start (`poker-client/game.js` ~1144/1250); Rhum32 had the gap (fixed 2026-05-18). Check Blackjack for the same class ("countdown blocking bet options" in the recovery doc).
- A game's exit/refund fix is meaningless unless its ENTER path actually drew the bank. Verify enter and exit symmetrically and trace the real entry path end-to-end — Rhum32 had a second entry function (`enterRhum32Table`) that bypassed the shared `confirmEnter` ad/draw flow, so the bank was never charged and "wallet not returning" was actually "wallet never drawn." Each game should funnel through the one shared `runAd('pregame')→confirmEnter` path; per-game bespoke entry functions are a money-path smell.
- Route every wallet/bank/refund change through `wallet-security-reviewer` before commit (ARCHITECTURE.md §6). It caught the missing-enter blocker above that static checks and the diff alone did not surface — the bug was in a *different* file than the change.

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
