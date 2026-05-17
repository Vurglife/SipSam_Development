---
name: feature-build
description: Use for implementing PokerProject features, fixes, automations, data tools, UI changes, or business workflows from request through validation and project-memory update.
---

Follow this workflow:

1. Read `docs/system-development/BRIEF.md` and the smallest relevant code or documentation set.
2. Identify the task class, affected modules, user impact, data risk, and validation path.
3. Ask one direct blocking question if a decision affects architecture, cost, security, data, or user experience.
4. Make scoped edits only after understanding existing patterns.
5. Validate with the narrowest reliable check first, then broaden if risk justifies it.
6. Update `docs/system-development/VALIDATION.md` and, when needed, `DECISIONS.md`, `DESIGN.md`, `LESSONS.md`, or `ROADMAP.md`.
7. Summarize changed files, validation, residual risk, and next step.

Prefer deterministic code for game rules, payouts, wallet updates, database writes, and repeatable business logic. Use AI for planning, summarization, support, analysis, and workflows where natural language adds value.
