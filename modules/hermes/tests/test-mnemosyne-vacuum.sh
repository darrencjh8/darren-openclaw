#!/bin/bash
# Tests mnemosyne-vacuum.sh: absent DBs exit 0, present DBs report + VACUUM.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VACUUM_SCRIPT="$SCRIPT_DIR/../scripts/mnemosyne-vacuum.sh"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "=== vacuum with absent DBs ==="
out=$(HERMES_HOME="$TMPDIR/empty-home" MNEMOSYNE_DATA_DIR="$TMPDIR/empty-home/mnemosyne/data" bash "$VACUUM_SCRIPT" 2>&1) \
    && ok "absent DBs exit 0" \
    || nope "absent DBs exit" "non-zero exit"
echo "$out" | grep -q "mnemosyne.db absent" && ok "absent mnemosyne reported" \
    || nope "absent mnemosyne report" "missing absent line"

echo ""
echo "=== vacuum with present DBs ==="
mkdir -p "$TMPDIR/home/mnemosyne/data"
if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$TMPDIR/home/mnemosyne/data/mnemosyne.db" "CREATE TABLE working_memory(id INTEGER); INSERT INTO working_memory VALUES(1); CREATE TABLE episodic_memory(id INTEGER);" 2>/dev/null || true
    sqlite3 "$TMPDIR/home/state.db" "CREATE TABLE sessions(id INTEGER);" 2>/dev/null || true
else
    printf 'x\n' > "$TMPDIR/home/mnemosyne/data/mnemosyne.db"
    printf 'x\n' > "$TMPDIR/home/state.db"
fi
out=$(HERMES_HOME="$TMPDIR/home" MNEMOSYNE_DATA_DIR="$TMPDIR/home/mnemosyne/data" bash "$VACUUM_SCRIPT" 2>&1) \
    && ok "present DBs exit 0" \
    || nope "present DBs exit" "non-zero exit"
echo "$out" | grep -q "size_after" && ok "vacuum reports sizes" \
    || nope "vacuum sizes" "missing size_after line"
echo "$out" | grep -q "older_than_30d" && ok "sessions older-than-30d reported" \
    || nope "session age report" "missing older_than_30d line"
echo "$out" | grep -qiE "delete|drop table" \
    && nope "vacuum never deletes" "destructive word in output" \
    || ok "vacuum never deletes"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
