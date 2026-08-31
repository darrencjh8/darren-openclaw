#!/bin/bash
# Verify Hermes uses the pooled Codex Router provider through Chat Completions.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/../config.yaml"

has_provider() {
    grep -Eq '^providers:$' "$CONFIG" && grep -Eq '^    codex-router:$' "$CONFIG"
}

has_provider && ok "named Codex Router provider exists" || nope "named Codex Router provider" "missing"
grep -Eq '^        api: http://codex-router:4100/v1$' "$CONFIG" && ok "provider uses internal router URL" || nope "provider URL" "missing or wrong"
grep -Eq '^        transport: chat_completions$' "$CONFIG" && ok "provider pins Chat Completions transport" || nope "provider transport" "missing"
grep -Eq '^    provider: custom:codex-router$' "$CONFIG" && ok "Hermes uses named Codex Router provider" || nope "Hermes provider" "missing"
grep -Eq '^    default: gpt-5\.6-terra$' "$CONFIG" && ok "main model uses pooled Terra alias" || nope "main model" "missing"
grep -Eq '^        model: gpt-5\.6-luna$' "$CONFIG" && ok "Luna consumers use pooled alias" || nope "Luna pool" "missing"

if grep -REq 'gpt-5\.6-(terra|luna|sol)-[123]' "$SCRIPT_DIR/../config.yaml" "$SCRIPT_DIR/../profiles"; then
    nope "no account-pinned GPT aliases" "found account suffix"
else
    ok "no account-pinned GPT aliases"
fi

printf '\n=========================================\n'
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ]
