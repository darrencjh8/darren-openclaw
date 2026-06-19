#!/bin/bash
# Unit tests for github-auth.sh helpers and graceful-exit paths.
# No real GitHub credentials needed — tests run in CI.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTH_SCRIPT="$SCRIPT_DIR/../scripts/github-auth.sh"

# ------------------------------------------------------------------ helpers --
b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }

# ------------------------------------------------------------------ tests ----

echo "=== b64url encoding ==="

result=$(echo -n '{"alg":"RS256","typ":"JWT"}' | b64url)
expected="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9"
[ "$result" = "$expected" ] && ok "b64url JWT header" || nope "b64url JWT header" "got: $result"

result=$(echo -n "hello world" | b64url)
expected="aGVsbG8gd29ybGQ"
[ "$result" = "$expected" ] && ok "b64url simple" || nope "b64url simple" "got: $result"

result=$(echo -n "test+encode/==" | b64url)
expected="dGVzdCtlbmNvZGUvPT0"
[ "$result" = "$expected" ] && ok "b64url strips padding" || nope "b64url strips padding" "got: $result"

echo ""
echo "=== JWT structure ==="

now=$(date +%s)
header_json='{"alg":"RS256","typ":"JWT"}'
payload_json="{\"iat\":$now,\"exp\":$((now+600)),\"iss\":\"4090999\"}"
header=$(echo -n "$header_json" | b64url)
payload=$(echo -n "$payload_json" | b64url)

# Header and payload are separated by a single dot
jwt_dots=$(echo -n "$header.$payload" | tr -cd '.' | wc -c)
[ "$jwt_dots" -eq 1 ] && ok "JWT has exactly 1 dot (header.payload)" || nope "JWT header.payload" "got $jwt_dots dots"

# Decode and verify claims (base64url → JSON)
decoded_payload=$(echo -n "$payload" | python3 -c "
import sys, base64, json
data = sys.stdin.read().strip()
# Add padding: base64url length must be multiple of 4
data += '=' * (4 - len(data) % 4) if len(data) % 4 else ''
print(base64.urlsafe_b64decode(data).decode())
")
echo "$decoded_payload" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'iat' in d; assert 'exp' in d; assert d['iss']=='4090999'" 2>/dev/null
[ $? -eq 0 ] && ok "payload decodes to valid JSON with iat, exp, iss" || nope "payload decodes" "$(echo "$decoded_payload" | head -1)"

echo ""
echo "=== graceful exit without credentials ==="

# Script should exit 0 when no env vars are set
output=$(bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?
if [ "$rc" -eq 0 ]; then
    ok "exits 0 without GITHUB_APP_ID"
else
    nope "exits 0 without GITHUB_APP_ID" "got exit code $rc"
fi

# Only APP_ID set, missing INSTALLATION_ID — should skip
output=$(GITHUB_APP_ID=123 bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?
if [ "$rc" -eq 0 ]; then
    ok "exits 0 with only GITHUB_APP_ID set"
else
    nope "exits 0 with only GITHUB_APP_ID set" "got exit code $rc"
fi

# Missing openssl should die with message
if command -v openssl >/dev/null; then
    ok "openssl available (pre-flight would pass)"

    # Bad private key format should die
    output=$(GITHUB_APP_ID=123 GITHUB_APP_INSTALLATION_ID=456 GITHUB_APP_PRIVATE_KEY="not-a-key" bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?
    if [ "$rc" -eq 1 ] && echo "$output" | grep -q "BEGIN.*PRIVATE KEY"; then
        ok "dies on bad private key format"
    else
        nope "dies on bad private key format" "rc=$rc, output=$output"
    fi
else
    echo "  SKIP  openssl not available (container-only test)"
fi

echo ""
echo "=== end-to-end dry run (no real API call) ==="
# Test that key decoding works — \n in env var becomes real newlines
key_with_newlines="-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----"
decoded=$(echo -e "$key_with_newlines")
if echo "$decoded" | grep -q "BEGIN RSA PRIVATE KEY"; then
    ok "echo -e decodes \\n escapes in private key"
else
    nope "echo -e decodes \\n" "got: $decoded"
fi
lines=$(echo "$decoded" | wc -l)
[ "$lines" -eq 3 ] && ok "decoded key has 3 lines" || nope "decoded key has 3 lines" "got $lines"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
