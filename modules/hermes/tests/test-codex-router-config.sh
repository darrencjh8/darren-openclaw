#!/bin/bash
# Verify Hermes uses the pooled Codex Router provider through Chat Completions.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/../config.yaml"
OPENCODE_JSON="$SCRIPT_DIR/../opencode/opencode.json"

has_provider() {
    grep -Eq '^providers:$' "$CONFIG" && grep -Eq '^    codex-router:$' "$CONFIG"
}

has_provider && ok "named Codex Router provider exists" || nope "named Codex Router provider" "missing"
grep -Eq '^        api: http://codex-router:4100/v1$' "$CONFIG" && ok "provider uses internal router URL" || nope "provider URL" "missing or wrong"
grep -Eq '^        transport: chat_completions$' "$CONFIG" && ok "provider pins Chat Completions transport" || nope "provider transport" "missing"
grep -Eq '^    provider: custom:codex-router$' "$CONFIG" && ok "Hermes uses named Codex Router provider" || nope "Hermes provider" "missing"
grep -Eq '^    default: auto-thinking$' "$CONFIG" && ok "main model routes via auto-thinking" || nope "main model" "missing"
grep -Eq '^        model: gpt-5\.6-luna$' "$CONFIG" && ok "Luna consumers use pooled alias" || nope "Luna pool" "missing"

if grep -REq 'gpt-5\.6-(terra|luna|sol)-[123]' "$SCRIPT_DIR/../config.yaml" "$SCRIPT_DIR/../profiles"; then
    nope "no account-pinned GPT aliases" "found account suffix"
else
    ok "no account-pinned GPT aliases"
fi

echo ""
echo "=== canonical opencode.json (terminal/CLI default) ==="

opencode_check=$(python3 - "$OPENCODE_JSON" <<'PY'
import json
import sys

with open(sys.argv[1]) as f:
    config = json.load(f)

default = config.get("model")
models = config.get("provider", {}).get("codex-router", {}).get("models", {})

problems = []
if default != "codex-router/auto-thinking":
    problems.append(f"default model = {default!r}, want codex-router/auto-thinking")
expected = {"auto-thinking", "gpt-5.6-terra"}
if set(models) != expected:
    problems.append(f"models = {sorted(models)!r}, want {sorted(expected)!r}")
for retired in ("auto-thinking-free", "deepseek-v4-flash", "deepseek-v4-pro"):
    if retired in models:
        problems.append(f"retired model {retired} still exposed")
if "muse-spark-1.3-contributor-free" in models:
    # The free reviewer tier is served by the opencode CLI, not codex-router,
    # which returns HTTP 400 for it.
    problems.append("opencode-only model muse-spark-1.3-contributor-free wired to codex-router")

if problems:
    print("FAIL: " + "; ".join(problems))
else:
    print("OK: default=codex-router/auto-thinking; models=auto-thinking,gpt-5.6-terra")
PY
)

case "$opencode_check" in
    OK*) ok "opencode default is codex-router/auto-thinking with expected models" ;;
    *) nope "opencode.json default/model set" "$opencode_check" ;;
esac

printf '\n=========================================\n'
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ]
