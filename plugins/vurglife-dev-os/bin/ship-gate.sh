#!/usr/bin/env bash
# ============================================================
# SHIP-GATE — Stop-hook validation gate.
# Blocks the turn from finishing (exit 2) ONLY if a changed
# .js fails to parse or a changed .json is invalid. Safety net
# for the "shipped broken syntax -> stuck game" bug class.
#
# Fail-OPEN, ALWAYS: missing tool / no git / slow git / any
# internal error -> exit 0. A validation gate must never trap
# the user over its own failure or a pathological repo walk.
# ============================================================
set +e

PROJ="${CLAUDE_PROJECT_DIR:-}"
[ -z "$PROJ" ] && PROJ="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$PROJ" ] && exit 0
cd "$PROJ" 2>/dev/null || exit 0
command -v node >/dev/null 2>&1 || exit 0   # no node -> can't check -> fail open

# `timeout` lets us bound git/node so the hook can never stall the
# turn. If it's unavailable, define a pass-through (still fail-open
# via the explicit exclusions below).
# `timeout` MUST wrap git/node DIRECTLY (not a bash -c wrapper):
# timeout only signals its direct child, so wrapping bash leaves
# orphaned git grandchildren that keep the $() pipe open and stall
# the hook for 40s+. Direct `timeout N git ...` kills git itself,
# the pipe closes, and we fail-open fast on a slow/bloated repo.
# -s KILL because Windows git can ignore SIGTERM mid-IO.
if command -v timeout >/dev/null 2>&1; then TO() { timeout -s KILL "$@"; }
else TO() { shift; "$@"; }; fi

SRC_ROOTS="poker-server poker-client blackjack-server blackjack-client rhum32-server rhum32-client roulette-server roulette-client holdem-server holdem-client shared vurglife-platform/server vurglife-platform/client/public"
EXC=":(exclude)**/node_modules/**"
FILES="$(
  { TO 6 git diff --name-only HEAD -- $SRC_ROOTS "$EXC" 2>/dev/null
    TO 6 git diff --name-only --cached -- $SRC_ROOTS "$EXC" 2>/dev/null
    TO 6 git ls-files --others --exclude-standard -- $SRC_ROOTS "$EXC" 2>/dev/null
  } | sort -u
)"
[ -z "$FILES" ] && exit 0

FAIL=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  case "$f" in
    */node_modules/*|.git/*|*/.claude/*|*.bak.*|*/data/*.db*) continue ;;
  esac
  case "$f" in
    *.js)
      err="$(TO 10 node --check "$f" 2>&1)"
      rc=$?
      [ $rc -eq 124 ] && continue                 # node check timed out -> skip, fail open
      [ $rc -ne 0 ] && FAIL="${FAIL}
[JS PARSE]  $f
${err}"
      ;;
    *.json)
      TO 10 node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$f" >/dev/null 2>&1
      rc=$?
      [ $rc -eq 124 ] && continue
      [ $rc -ne 0 ] && FAIL="${FAIL}
[JSON BAD]  $f"
      ;;
  esac
done <<EOF
$FILES
EOF

if [ -n "$FAIL" ]; then
  {
    echo "SHIP-GATE BLOCKED — broken syntax in changed files. Fix before finishing:"
    echo "$FAIL"
  } >&2
  exit 2
fi
exit 0
