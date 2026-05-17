---
name: ship-check
description: Manual pre-done validation gate for VurgLife/PokerProject. Run before telling the user a task is finished. Verifies changed JS/JSON parse, the single-source SipSam config isn't drifted, client cache-bust was bumped, and summarises git state as a punch list.
disable-model-invocation: true
allowed-tools: Bash, Read, Grep
---

# /ship-check — pre-"done" validation gate

Run this before declaring any task complete. It is the manual, richer
counterpart to the automatic Stop ship-gate hook.

## Steps

1. **Syntax gate (hard).** Run the shared gate script and report its result:
   ```
   node .claude/scripts/ship-gate.js; echo "gate exit=$?"
   ```
   Exit 2 → there is broken JS/JSON in changed files. STOP, fix it, rerun.
   Exit 0 → syntax clean (or fail-open on slow git — note that).

2. **Single-source config drift (soft — warn only).** The server reads
   `shared/sipsam-tables.js`. The two browser mirrors are display-only.
   If a table tier changed this task, confirm the mirrors match so the
   dashboard label isn't misleading:
   ```
   node -e "const s=require('./shared/sipsam-tables.js');console.log(Object.entries(s).map(([k,v])=>k+':'+v.minBet+'/'+v.increment+'/'+v.maxBet+'/'+v.walletSize+'/'+v.minBank).join('\n'))"
   ```
   Eyeball against `poker-client/game.js` TABLE_CONFIGS and the dashboard
   `TABLES` in `vurglife-platform/client/public/index.html`. Drift here is
   cosmetic, not a money bug — report as a note, do not block.

3. **Cache-bust check (soft).** If any of `poker-client/game.js`,
   `poker-client/style.css` (or the blackjack equivalents) changed, confirm
   the matching `?v=N` in the client `index.html` was incremented. If not,
   bump it now.

4. **Restart reminder.** State which restart the change needs per
   ARCHITECTURE.md §1 (platform restart for server code; hard-refresh +
   cache-bust for client code).

5. **Money-path check.** If anything under the bank/wallet/refund/session/
   txn path changed, recommend dispatching the `wallet-security-reviewer`
   subagent before final sign-off.

6. **Punch list.** Output a tight checklist:
   - [ ] syntax gate exit 0
   - [ ] config mirrors consistent (or N/A)
   - [ ] cache-bust bumped (or N/A)
   - [ ] restart instruction stated
   - [ ] money-path reviewed (or N/A)
   - [ ] committed (only if the user asked)

Keep the report terse — the user is a veteran tester.
