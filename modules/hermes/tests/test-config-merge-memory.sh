#!/bin/bash
# Tests the config-merge memory carry: baked caps win, live provider survives.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_SCRIPT="$SCRIPT_DIR/../50-seed-defaults"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "=== config merge carries memory provider ==="

grep -q 'carried_memory\["provider"\]' "$SEED_SCRIPT" \
    && ok "merge carries live memory.provider" \
    || nope "provider carry" "carried provider missing from merge"
grep -q 'carried_memory\["mnemosyne"\]' "$SEED_SCRIPT" \
    && ok "merge carries live memory.mnemosyne" \
    || nope "mnemosyne carry" "carried mnemosyne missing from merge"
grep -q 'mem_block\[sub_key\] = sub_value' "$SEED_SCRIPT" \
    && ok "merge folds carried memory into baked block" \
    || nope "key-level merge" "fold into baked memory block missing"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
