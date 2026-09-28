#!/bin/sh
# Syntax check every JS file in the repo. Fast, node-only, no dependencies.
# Invoked by .githooks/pre-commit (warn-only) and usable standalone.
#   Usage: sh scripts/check.sh
# Exit 0 = all files parse. Exit 1 = at least one file has a syntax error.

set -e
[ -f package.json ] || true  # informational only

FILES=$(git ls-files '*.js' 'src/**/*.js' 'src/*.js' 2>/dev/null | sort -u)
if [ -z "$FILES" ]; then
  echo "check.sh: no JS files found"
  exit 0
fi

FAIL=0
for f in $FILES; do
  if ! node --check "$f" >/dev/null 2>&1; then
    echo "check.sh: SYNTAX ERROR in $f"
    node --check "$f" 2>&1 || true
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
echo "check.sh: OK ($(echo "$FILES" | wc -l) files)"
