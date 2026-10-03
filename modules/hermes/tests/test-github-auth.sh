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
    ok "exits 0 without GH_APP_ID"
else
    nope "exits 0 without GH_APP_ID" "got exit code $rc"
fi

# Only APP_ID set, missing INSTALLATION_ID — should skip
# T-precedence: incomplete App configuration must exit 0 without attempting auth.
output=$(GH_APP_ID=123 bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?
if [ "$rc" -eq 0 ]; then
    ok "T-precedence: exits 0 with only GH_APP_ID set"
else
    nope "T-precedence: exits 0 with only GH_APP_ID set" "got exit code $rc"
fi

# T-precedence: complete App config must send the minted JWT on the wire.
# Uses fake curl + fake openssl + stub key so no network or secret is needed.
echo ""
echo "=== T-precedence: JWT sent on the wire (fake curl) ==="
fakebin=$(mktemp -d)
trap 'rm -rf "$fakebin"' RETURN
cat > "$fakebin/openssl" <<'STUB'
#!/bin/bash
# fake signer: emit stable bytes regardless of key input
printf 'fake-signature-bytes'
STUB
chmod +x "$fakebin/openssl"
cat > "$fakebin/curl" <<'STUB'
#!/bin/bash
# fake GitHub API: capture args, return a canned installation token
printf '%s\n' "$@" > "${FAKE_CURL_ARGS_FILE:?}"
printf '{"token":"fake-token-123","expires_at":"2030-01-01T00:00:00Z"}'
printf '\n201'
STUB
chmod +x "$fakebin/curl"
export FAKE_CURL_ARGS_FILE="$fakebin/curl-args.txt"
fake_key="-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----"
curl_out=$(PATH="$fakebin:$PATH" GH_APP_ID=4090999 GH_APP_INSTALLATION_ID=141232599 GH_APP_PRIVATE_KEY="$fake_key" bash "$AUTH_SCRIPT" 2>&1) && curl_rc=$? || curl_rc=$?
captured_auth=$(grep -A1 "Authorization" "$FAKE_CURL_ARGS_FILE" 2>/dev/null || true)
if [ "$curl_rc" -eq 0 ] && grep -q "Bearer eyJ" "$FAKE_CURL_ARGS_FILE" 2>/dev/null; then
    ok "T-precedence: Authorization header carries the minted JWT"
else
    nope "T-precedence: Authorization header carries the minted JWT" "rc=$curl_rc args=$(cat "$FAKE_CURL_ARGS_FILE" 2>/dev/null | tr '\n' ' ' | head -c 300)"
fi
if echo "$captured_auth $curl_out" | grep -q "fake-token-123"; then
    nope "T-no-secret-output: token material must never appear in output" "token leaked into curl args or logs"
else
    ok "T-no-secret-output: no token material in args dump or logs"
fi

# T-atomic-replace: flat-file credential writes must be atomic (temp + rename).
# Fails at base: the helper writes /opt/data/.gh_token directly with no temp file.
echo ""
echo "=== T-atomic-replace: no partial credential writes ==="
atomic_probe=$(grep -cE 'mktemp|tmpfile|\.tmp' "$AUTH_SCRIPT" 2>/dev/null || true)
if [ "${atomic_probe:-0}" -ge 1 ]; then
    ok "T-atomic-replace: helper stages credential writes via temp file"
else
    nope "T-atomic-replace: helper stages credential writes via temp file" "no mktemp/tmp staging in $AUTH_SCRIPT"
fi

# Missing openssl should die with message
if command -v openssl >/dev/null; then
    ok "openssl available (pre-flight would pass)"

    # Bad private key format should die
    output=$(GH_APP_ID=123 GH_APP_INSTALLATION_ID=456 GH_APP_PRIVATE_KEY="not-a-key" bash "$AUTH_SCRIPT" 2>&1) && rc=$? || rc=$?
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
