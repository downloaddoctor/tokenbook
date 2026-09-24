#!/bin/sh
# Regenerate the SHELL_ASSETS array in sw.js from the git-tracked filesystem.
# Writes between the /* SHELL_ASSETS:BEGIN */ and /* SHELL_ASSETS:END */ markers.
# Run from the repo root (the pre-commit hook does this automatically).
#
# Uses `git ls-files` (not find) so the list is the tracked tree, identical on
# every platform, and free of untracked junk. Dev-only modules are excluded.

set -e

SW="sw.js"
[ -f "$SW" ] || { echo "gen-shell-assets: $SW not found"; exit 1; }

BEGIN='/* SHELL_ASSETS:BEGIN */'
END='/* SHELL_ASSETS:END */'
TMP="${SW}.tmp.$$"
BODY="${SW}.body.$$"

# --- collect the asset list (tracked files only) ---

# Root shell files, fixed order, only if tracked.
ROOT=$(git ls-files index.html styles.css favicon.svg manifest.webmanifest 2>/dev/null || true)

# All tracked JS under src/, excluding dev-only modules (never precached).
SRC=$(git ls-files 'src/**/*.js' 'src/*.js' 2>/dev/null \
  | grep -v '^src/dev/' \
  | sort || true)

# --- write the new array body ---

{
  printf '%s\n' "const SHELL_ASSETS = ["
  printf "  '%s',\n" "./"
  printf '%s\n' "$ROOT" | while IFS= read -r f; do
    [ -n "$f" ] && printf "  './%s',\n" "$f"
  done
  printf '%s\n' "$SRC" | while IFS= read -r f; do
    [ -n "$f" ] && printf "  './%s',\n" "$f"
  done
  printf '%s\n' "];"
} > "$BODY"

# --- splice the body between the markers ---

awk -v begin="$BEGIN" -v end="$END" -v bodyfile="$BODY" '
  $0 == begin { print; while ((getline l < bodyfile) > 0) print l; skip=1; next }
  $0 == end   { skip=0 }
  !skip       { print }
' "$SW" > "$TMP"

if ! cmp -s "$SW" "$TMP"; then
  mv "$TMP" "$SW"
  echo "gen-shell-assets: updated $SW"
else
  rm -f "$TMP"
fi
rm -f "$BODY"
