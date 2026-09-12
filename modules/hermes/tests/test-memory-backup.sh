#!/bin/bash
# Unit tests for memory-backup.sh helpers.
# No real git operations — tests URL construction and token handling.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

# Extract the REPO_URL construction logic (lines 17-22 from memory-backup.sh)
build_repo_url() {
    local auth_token="$1"
    local memory_repo_url="${2:-https://example.com/owner/repo}"
    if echo "$auth_token" | grep -q '^ghs_'; then
        echo "https://x-access-token:${auth_token}@${memory_repo_url#https://}"
    else
        echo "https://${auth_token}@${memory_repo_url#https://}"
    fi
}

echo "=== REPO_URL construction ==="

result=$(build_repo_url "ghs_abc123token")
expected="https://x-access-token:ghs_abc123token@example.com/owner/repo"
[ "$result" = "$expected" ] && ok "App token (ghs_) uses x-access-token: prefix" \
    || nope "App token prefix" "got: $result"

result=$(build_repo_url "ghp_classicPatToken")
expected="https://ghp_classicPatToken@example.com/owner/repo"
[ "$result" = "$expected" ] && ok "PAT (ghp_) uses bare TOKEN@ format" \
    || nope "PAT bare format" "got: $result"

result=$(build_repo_url "github_pat_fineGrained")
expected="https://github_pat_fineGrained@example.com/owner/repo"
[ "$result" = "$expected" ] && ok "Fine-grained PAT uses bare TOKEN@ format" \
    || nope "FG PAT bare format" "got: $result"

result=$(build_repo_url "ghs_abc" "https://example.com/darrencjh8/friday-memory")
expected="https://x-access-token:ghs_abc@example.com/darrencjh8/friday-memory"
[ "$result" = "$expected" ] && ok "App token with real repo URL" \
    || nope "App token real URL" "got: $result"

result=$(build_repo_url "ghp_xyz" "https://example.com/darrencjh8/friday-memory")
expected="https://ghp_xyz@example.com/darrencjh8/friday-memory"
[ "$result" = "$expected" ] && ok "PAT with real repo URL" \
    || nope "PAT real URL" "got: $result"

echo ""
echo "=== Token prefix detection edge cases ==="

# ghs_ should match at start only
result=$(build_repo_url "ghs_token_with_ghs_inside")
expected="https://x-access-token:ghs_token_with_ghs_inside@example.com/owner/repo"
[ "$result" = "$expected" ] && ok "ghs_ at start, not middle" \
    || nope "ghs_ start only" "got: $result"

# Not starting with ghs_ should NOT use x-access-token
result=$(build_repo_url "abc_ghs_token")
expected="https://abc_ghs_token@example.com/owner/repo"
[ "$result" = "$expected" ] && ok "ghs_ not at start → bare format" \
    || nope "ghs_ not at start" "got: $result"

echo ""
echo "=== topic files are copied into the backup repo ==="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
backup_script="$SCRIPT_DIR/../scripts/memory-backup.sh"
topic_src="$TMPDIR/memories"
topic_clone="$TMPDIR/memories-backup"
mkdir -p "$topic_src/topics" "$topic_clone/.git" "$TMPDIR/stubbin"
printf 'core fact\n' > "$topic_src/MEMORY.md"
printf 'user fact\n' > "$topic_src/USER.md"
printf 'card 4605 -> Delta Extra\n' > "$topic_src/topics/accounts.md"
printf 'NTUC FairPrice -> Groceries\n' > "$topic_src/topics/expenses.md"

# Stub git so the copy loop runs without a real repository or network access.
cat > "$TMPDIR/stubbin/git" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "$TMPDIR/stubbin/git"

MEMORY_REPO_URL="https://example.com/owner/repo" \
GITHUB_TOKEN="ghp_test_token" \
MEMORY_SRC_DIR="$topic_src" \
MEMORY_CLONE_DIR="$topic_clone" \
PATH="$TMPDIR/stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 || true

[ -f "$topic_clone/topics/accounts.md" ] && ok "topics/accounts.md copied" \
    || nope "topics copied" "accounts.md missing from $topic_clone/topics"
[ -f "$topic_clone/topics/expenses.md" ] && ok "topics/expenses.md copied" \
    || nope "topics copied" "expenses.md missing from $topic_clone/topics"
grep -q "card 4605" "$topic_clone/topics/accounts.md" 2>/dev/null \
    && ok "topic file content preserved" \
    || nope "topic content" "content not preserved"
[ -f "$topic_clone/MEMORY.md" ] && ok "MEMORY.md still copied" \
    || nope "MEMORY.md copy" "regression: core store not copied"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
