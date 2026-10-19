#!/bin/sh
# Deploy/CI guard: fails when a cached shell asset changed but version.txt did not.
# Usage: sh scripts/check-version.sh [base-ref]   (default: HEAD~1)
set -e

BASE="${1:-HEAD~1}"
CACHED='^(index\.html|styles\.css|favicon\.svg|manifest\.webmanifest|pw\.js|sw\.js|src/)'

CHANGED=$(git diff --name-only "$BASE" HEAD)

if echo "$CHANGED" | grep -Eq "$CACHED" && ! echo "$CHANGED" | grep -q '^version\.txt$'; then
  echo 'check-version: FAIL - cached assets changed but version.txt was not bumped'
  exit 1
fi
echo 'check-version: OK'
