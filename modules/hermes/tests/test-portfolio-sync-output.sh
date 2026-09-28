#!/bin/bash
# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

# Regression test for the round-trip status lines in portfolio-sync.sh.
#
# The defect this covers: a dead OneDrive grant was reported as a successful pull,
# so the daily job printed a clean summary and the spreadsheet was written from a
# stale local portfolio file. Its output was indistinguishable from a healthy run.
#
# This test runs the SHIPPED script with a stubbed curl and asserts on its stdout.
# It deliberately does NOT extract the parse block and run it separately: a test
# that reads the block off disk and feeds it to its own `python3 -c` bypasses
# bash's parse-time quote removal, which is the only step that mangles the text.
# Such a test passes on a script that prints nothing at all, so it certifies the
# defect instead of catching it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYNC_SCRIPT="$REPO_ROOT/modules/hermes/scripts/portfolio-sync.sh"

[ -f "$SYNC_SCRIPT" ] || { echo "FAIL: missing $SYNC_SCRIPT" >&2; exit 1; }

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Stub curl, first on PATH. It emits the body the real endpoint would return and
# appends the HTTP status the script splits off with `tail -1`.
mkdir -p "$TMPDIR_TEST/bin"
cat > "$TMPDIR_TEST/bin/curl" <<'STUB'
#!/bin/bash
printf '%s\n%s' "$STUB_BODY" "$STUB_CODE"
STUB
chmod +x "$TMPDIR_TEST/bin/curl"

# Run the real script and capture its stdout only. stderr carries the log lines,
# which are not under test.
run_sync() {
    PATH="$TMPDIR_TEST/bin:$PATH" \
        STUB_BODY="$1" \
        STUB_CODE="${2:-200}" \
        bash "$SYNC_SCRIPT" 2>/dev/null || true
}

FAILURES=0
check() {
    local label="$1" body="$2" expected="$3" unexpected="${4:-}"
    local out
    out="$(run_sync "$body")"
    if [ -n "$unexpected" ] && grep -qF -- "$unexpected" <<<"$out"; then
        echo "FAIL: $label — output unexpectedly contains: $unexpected" >&2
        printf '%s\n' "$out" >&2
        FAILURES=$((FAILURES + 1))
        return
    fi
    if grep -qF -- "$expected" <<<"$out"; then
        echo "ok: $label"
    else
        echo "FAIL: $label — expected output to contain: $expected" >&2
        printf 'actual stdout:\n%s\n' "$out" >&2
        FAILURES=$((FAILURES + 1))
    fi
}

HEALTHY='{"sync_targets":[{"name":"Deposit Account","status":"updated","delta":0}],"pull":{"status":"ok","detail":"downloaded"},"push":{"status":"ok","detail":"uploaded"}}'
DEAD_GRANT='{"sync_targets":[{"name":"Deposit Account","status":"unchanged","delta":0}],"pull":{"status":"error","detail":"Token HTTP 400"},"push":{"status":"error","detail":"Token HTTP 400"}}'
NO_LEG_KEYS='{"sync_targets":[{"name":"Deposit Account","status":"unchanged","delta":0}]}'
NULL_LEG='{"sync_targets":[{"name":"Deposit Account","status":"unchanged","delta":0}],"pull":null,"push":{"status":"ok","detail":"uploaded"}}'
# Review round 2, M1: the payload carries four remote legs but only pull and push
# were rendered, so an expired IBKR token produced a log identical to a healthy run.
FLEX_DEAD='{"sync_targets":[{"name":"Warchest","status":"updated","delta":0}],"pull":{"status":"ok","detail":"downloaded"},"flex_pull":{"success":false,"error":"IBKR Flex error 1012: Token has expired"},"flex_import":null,"push":{"status":"ok","detail":"uploaded"}}'
# Review round 2, M2: the AB budget fetch throws, so the payload is never assembled
# and the legs are absent entirely. The abort reason must still reach the log.
AB_ABORT='{"error":"Budget SGD Budget: HTTP 500: boom","sync_targets":[{"name":"Warchest","status":"skipped","delta":0,"error":"OneDrive not synced"}]}'
# Review round 2, M1: an explicit null status must render the placeholder, not the
# Python repr `None`, which reads as a parsing artifact rather than a missing value.
NULL_STATUS='{"sync_targets":[{"name":"Deposit Account","status":"unchanged","delta":0}],"pull":{"status":null,"detail":"x"},"push":{"status":"ok","detail":"uploaded"}}'

# A failed round trip must be visible rather than silent.
check "dead grant reports the failed pull" "$DEAD_GRANT" "pull: error (Token HTTP 400)"
check "dead grant reports the failed push" "$DEAD_GRANT" "push: error (Token HTTP 400)"

# A healthy round trip reports success and keeps the pre-existing target lines,
# so the new lines did not replace the summary that already worked.
check "healthy run reports the pull" "$HEALTHY" "pull: ok (downloaded)"
check "healthy run reports the push" "$HEALTHY" "push: ok (uploaded)"
check "healthy run still lists sync targets" "$HEALTHY" "Deposit Account: updated (delta=0)"

# Absent and explicit-null legs must degrade to the placeholder, not raise: a
# raise lands in the block's except and prints "(parse error: ...)", which hides
# every target line above it.
check "absent leg keys render a placeholder" "$NO_LEG_KEYS" "pull: ? ()"
check "absent leg keys keep the target lines" "$NO_LEG_KEYS" "Deposit Account: unchanged (delta=0)"
check "explicit null leg renders a placeholder" "$NULL_LEG" "pull: ? ()"
check "explicit null leg keeps the target lines" "$NULL_LEG" "Deposit Account: unchanged (delta=0)"

# A parse failure must never masquerade as a clean run.
check "dead grant does not print a parse error" "$DEAD_GRANT" "" "parse error"
check "absent keys do not print a parse error" "$NO_LEG_KEYS" "" "parse error"

# Review round 2, M1: a dead IBKR flex leg must be visible. This is the same defect
# class as #627 one leg over, and it reproduced on a healthy OneDrive grant.
check "dead flex pull is reported" "$FLEX_DEAD" "flex_pull: error (IBKR Flex error 1012: Token has expired)"
check "dead flex pull keeps the target lines" "$FLEX_DEAD" "Warchest: updated (delta=0)"
check "dead flex pull does not print a parse error" "$FLEX_DEAD" "" "parse error"

# Review round 2, M2: when the AB fetch aborts the sync the legs are absent, so the
# only signal left is the abort reason. It must not vanish.
check "aborted sync reports the reason" "$AB_ABORT" "error: Budget SGD Budget: HTTP 500: boom"
check "aborted sync does not print a parse error" "$AB_ABORT" "" "parse error"

# Review round 2, L4: an explicit null status renders the placeholder, not `None`.
check "explicit null status renders the placeholder" "$NULL_STATUS" "pull: ? (x)"
check "explicit null status never prints None" "$NULL_STATUS" "" "pull: None"

if [ "$FAILURES" -ne 0 ]; then
    echo "FAIL: $FAILURES check(s) failed" >&2
    exit 1
fi

echo "PASS: portfolio-sync.sh reports round-trip status"
