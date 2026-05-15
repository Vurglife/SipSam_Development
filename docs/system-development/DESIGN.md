# Design

## Current Architecture

PokerProject is a multi-game platform repository. The observed top-level structure includes separate client/server folders for multiple games and a shared VurgLife platform folder.

Observed code areas:

- `poker-server`: game state machine, hand evaluation, matchmake/WebSocket server, tests, package files.
- `poker-client`: browser client files referenced by the existing handoff.
- `vurglife-platform`: platform server, routes, client dashboard, and sql.js database layer referenced by the existing handoff.
- Other game areas: blackjack, rhum32, roulette, and holdem folders.

## User Experience

Existing handoff states that SipSam/VurgLife includes login, dashboard, table picker, lobby, friend invites, in-game menu, game-over stats, and modernized game UI behavior.

Future UI work should prioritize:

- Real player workflows over decorative screens.
- Clear game state and wallet/bank outcomes.
- Mobile and desktop usability.
- Error states for rejected joins, insufficient bank, lost connections, and closed rooms.

## AI and Automation Design

Use the `system-developer-analyst` skill for future work involving:

- AI-assisted feature design.
- Automation design.
- Data analysis.
- Project decisions.
- Validation planning.
- Cost and token discipline.

AI should support planning, analysis, documentation, testing support, and user-facing assistance where it adds value. Deterministic code should handle game rules, payouts, wallet updates, authentication, database writes, and other repeatable business logic.

## Data Design

The existing handoff identifies `vurglife-platform/data/vurglife.db` as a sql.js sqlite data file. Treat platform data, balances, sessions, invitations, and game results as sensitive business data. Snapshot before risky changes.

## Confirmed Working Patterns

- Read the current handoff before touching game or platform code.
- Keep project memory in files, not only in chat.
- Validate each meaningful change before marking it complete.
- Record decisions and lessons so future chats do not rediscover the same context.

## Implementation Notes

- This project memory lives in `docs/system-development`.
- Existing root documents remain the historical handoff source.
- This folder should become the concise current working memory for future Codex sessions.

## Known Constraints

- Repository ownership can cause git safe-directory warnings from sandboxed tooling.
- The root already contains several handoff and recovery documents, so new persistent memory is intentionally placed under `docs/system-development`.
