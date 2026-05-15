# Decisions

| Date | Decision | Reason | Alternatives Rejected | Revisit Trigger |
| --- | --- | --- | --- | --- |
| 2026-05-15 | Apply the `system-developer-analyst` project template to PokerProject. | PokerProject is a multi-app, multi-session platform where durable memory, validation, and lessons reduce cost and repeated discovery. | Continue relying on chat history and scattered handoff documents only. | If the template becomes too heavy or is not being used during real work. |
| 2026-05-15 | Place the project memory in `docs/system-development`. | The repository root already contains many handoff and recovery files. A dedicated docs folder is cleaner and easier to find. | Add `BRIEF.md`, `DESIGN.md`, and related files directly to the root. | If the team standardizes on root-level planning files later. |
| 2026-05-15 | Do not change application code during template application. | The current task is to apply the project operating system, not modify game behavior. | Combine project setup with feature changes. | When a specific PokerProject development task is requested. |
