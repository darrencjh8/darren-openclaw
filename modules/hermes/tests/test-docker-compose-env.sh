#!/bin/bash
# Verify docker-compose.yml has required env vars for the hermes service.
# HERMES_WRITE_SAFE_ROOT must include both /opt/data and /workspace
# so Hermes can write to both its internal data volume and git worktrees.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../../docker-compose.yml"

echo "=== docker-compose.yml: hermes env vars ==="

# Extract env vars for the hermes service from the compose file.
# Uses awk to get all lines between "hermes:" and the next top-level key (dedented or end of file).
get_hermes_env() {
    awk '/^[[:space:]]*hermes:/,/^[a-z]/' "$COMPOSE_FILE" | grep -E '^\s+- ' || true
}

# Test: HERMES_WRITE_SAFE_ROOT is present
test_has_safe_root() {
    if grep -q 'HERMES_WRITE_SAFE_ROOT' "$COMPOSE_FILE"; then
        ok "HERMES_WRITE_SAFE_ROOT is present in docker-compose.yml"
    else
        nope "HERMES_WRITE_SAFE_ROOT" "not found in docker-compose.yml"
    fi
}

# Test: HERMES_WRITE_SAFE_ROOT includes /opt/data
test_has_opt_data() {
    local val
    val=$(grep 'HERMES_WRITE_SAFE_ROOT' "$COMPOSE_FILE" | head -1)
    if echo "$val" | grep -q '/opt/data'; then
        ok "HERMES_WRITE_SAFE_ROOT includes /opt/data"
    else
        nope "HERMES_WRITE_SAFE_ROOT includes /opt/data" "value: $val"
    fi
}

# Test: HERMES_WRITE_SAFE_ROOT includes /workspace
test_has_workspace() {
    local val
    val=$(grep 'HERMES_WRITE_SAFE_ROOT' "$COMPOSE_FILE" | head -1)
    if echo "$val" | grep -q '/workspace'; then
        ok "HERMES_WRITE_SAFE_ROOT includes /workspace"
    else
        nope "HERMES_WRITE_SAFE_ROOT includes /workspace" "value: $val"
    fi
}

# Test: /workspace volume mount exists for hermes service
test_has_workspace_volume() {
    if grep -A 50 'hermes:' "$COMPOSE_FILE" | grep -q '/workspace'; then
        ok "/workspace volume mount exists for hermes service"
    else
        nope "/workspace volume mount exists" "not found in hermes service section"
    fi
}

test_has_safe_root
test_has_opt_data
test_has_workspace
test_has_workspace_volume

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
