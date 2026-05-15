# Brief

## Purpose

PokerProject is the working repository for the SipSam/VurgLife gaming platform, including poker/SipSam, blackjack, rhum32, roulette, and the VurgLife platform layer. This project memory exists to make future development more efficient, validated, and recoverable across chats.

## Intended Users

- Mitstar as owner, product lead, and business operator.
- Players using the game clients.
- Internal developers or AI assistants maintaining the platform.

## Desired Outcome

Use this folder as the durable project memory for future app, AI, automation, data, and business-system work on PokerProject. Future work should avoid repeated context discovery, preserve validated decisions, record lessons, and keep implementation tied to evidence.

## Scope

In scope:

- Project planning and technical decisions.
- App and platform implementation records.
- AI and automation opportunities.
- Validation records.
- Lessons from working and failed approaches.
- Roadmap and modernization notes.

Out of scope:

- Replacing existing handoff documents.
- Making code changes as part of this template application.
- Changing git, deployment, wallet, or game-server behavior without a separate task.

## Data and Systems

- Repository: `G:\SipSam\PokerProject`
- Active folders observed: `poker-client`, `poker-server`, `blackjack-client`, `blackjack-server`, `rhum32-client`, `rhum32-server`, `roulette-client`, `roulette-server`, `holdem-client`, `holdem-server`, `vurglife-platform`
- Existing handoff: `SipSam_Development_Status_and_Handoff.md`
- Key platform data noted in handoff: `vurglife-platform/server/db/database.js`, `vurglife-platform/data/vurglife.db`

## Constraints

- Existing handoff says the active branch is `master` and meaningful changes should be committed immediately.
- The VurgLife database and wallet/bank/session behavior should be treated as sensitive and snapshotted before risky changes.
- Future work must be validated before being called complete.
- Chat-only memory is not enough; decisions and lessons should be recorded here.
- Git status may require a safe-directory configuration when run from sandboxed tooling.

## Success Criteria

- Future PokerProject work starts by checking this folder and the current handoff.
- Decisions, validations, and lessons are updated during meaningful work.
- Failed throwaway artifacts are removed when safe, with the lesson preserved in `LESSONS.md`.
- Modernization or AI recommendations are verified against current official sources when they depend on changing features, pricing, APIs, or platform capabilities.

## Open Questions

- Confirm the next PokerProject priority.
- Confirm whether the existing "commit every meaningful change directly to master" rule remains current.
