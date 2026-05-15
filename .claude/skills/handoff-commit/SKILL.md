---
name: handoff-commit
description: Prepare a concise handoff, validation summary, and commit for PokerProject changes. Invoke manually before commits or session handoff.
disable-model-invocation: true
---

Before commit or handoff:

1. Inspect changed files.
2. Separate current-task changes from unrelated existing work.
3. Confirm validation performed and remaining gaps.
4. Update `docs/system-development/VALIDATION.md`, `DECISIONS.md`, `LESSONS.md`, or `ROADMAP.md` when needed.
5. Stage only current-task files.
6. Commit with a clear message. Claude Code is allowed and expected to commit current-task changes after validation.
7. Summarize commit hash, changed files, validation, unrelated changes left untouched, and residual risk.

Do not stage unrelated files. Do not push or use destructive git commands unless Mitstar explicitly asks.
