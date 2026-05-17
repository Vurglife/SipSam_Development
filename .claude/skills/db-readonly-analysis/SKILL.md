---
name: db-readonly-analysis
description: Use for VurgLife SQLite schema inspection, player/account analysis, balance checks, reporting, and data-quality questions that require database reads without mutating data.
disable-model-invocation: true
---

# DB Read-Only Analysis

Use the project MCP server `vurglife-sqlite-readonly` when available. It reads
`vurglife-platform/data/vurglife.db` into memory through `sql.js`; it does not
write back to disk and rejects non-read SQL.

Rules:
- Never edit `vurglife-platform/data/vurglife.db` directly.
- For mutations, use application routes or DB-layer code only, and snapshot the
  DB before any risky work.
- Keep result sets small. Default MCP limit is 100 rows; request only columns
  needed for the question.
- For balance/wallet questions, report formulas and edge cases, not just rows.

Useful checks:
```bash
node .claude/mcp/sqlite-readonly-server.js
```

Inside Claude Code, use MCP tools:
- `mcp__vurglife-sqlite-readonly__list_tables`
- `mcp__vurglife-sqlite-readonly__describe_table`
- `mcp__vurglife-sqlite-readonly__get_schema`
- `mcp__vurglife-sqlite-readonly__read_query`
