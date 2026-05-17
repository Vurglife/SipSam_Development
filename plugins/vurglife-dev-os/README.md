# VurgLife Dev OS

Claude Code plugin package for VurgLife/PokerProject development.

Includes:
- Project agents for codebase exploration, data analysis, docs, frontend review, game rules, and wallet security.
- Project skills for feature builds, game logic, frontend QA, project memory, handoffs, wallet/bank safety, ship checks, and read-only DB analysis.
- Stop-hook validation through `bin/ship-gate.js`.
- Read-only SQLite MCP server through `bin/sqlite-readonly-server.js`.

Install from this repository:

```powershell
claude plugin marketplace add G:\SipSam\PokerProject --scope user
claude plugin install vurglife-dev-os@vurglife-tools
```

The plugin is reusable. The live PokerProject still uses the project-local
`.claude` setup and root `.mcp.json` as the source of truth.
