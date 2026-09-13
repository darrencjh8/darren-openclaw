#!/bin/bash
# Tests URL construction plus memory-backup.sh end-to-end with stubbed git and gh.
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
echo "=== expense-tracker memory copy ==="

expense_src="$TMPDIR/expense-memories"
expense_clone="$TMPDIR/expense-backup"
mkdir -p "$expense_src" "$expense_clone" "$TMPDIR/expense-stubbin"
printf 'expense memory: password stays verbatim\n' > "$expense_src/MEMORY.md"
printf 'not memory\n' > "$expense_src/dedup.db"
printf 'not memory\n' > "$expense_src/metadata.json"
printf 'not memory\n' > "$expense_src/statement.db"
printf 'not memory\n' > "$expense_src/.env"

# Stub all git calls made by the backup script; clone creates local repository shape.
cat > "$TMPDIR/expense-stubbin/git" <<'STUB'
#!/bin/sh
if [ "$1" = clone ]; then
    mkdir -p "$3/.git"
    exit 0
fi
if [ "$1" = diff ]; then
    exit 1
fi
exit 0
STUB
cat > "$TMPDIR/expense-stubbin/gh" <<'STUB'
#!/bin/sh
if [ "$1" = auth ] && [ "$2" = token ]; then
    printf 'ghp_test_token\n'
fi
STUB
chmod +x "$TMPDIR/expense-stubbin/git" "$TMPDIR/expense-stubbin/gh"

MEMORY_REPO_URL="https://example.com/owner/repo" \
MEMORY_SRC_DIR="$topic_src" \
MEMORY_CLONE_DIR="$expense_clone" \
EXPENSE_TRACKER_DATA="$expense_src" \
PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1

cmp -s "$expense_src/MEMORY.md" "$expense_clone/expense-tracker/MEMORY.md" \
    && ok "expense-tracker MEMORY.md copied verbatim" \
    || nope "expense-tracker memory copy" "MEMORY.md missing or changed"
[ -f "$expense_clone/expense-tracker/MEMORY.md" ] \
    && ok "expense-tracker copy exists before exclusion checks" \
    || nope "expense-tracker copy" "MEMORY.md missing"
for excluded in dedup.db metadata.json statement.db .env; do
    [ ! -e "$expense_clone/expense-tracker/$excluded" ] \
        && ok "expense-tracker $excluded excluded" \
        || nope "expense-tracker exclusions" "$excluded copied"
done

missing_clone="$TMPDIR/expense-backup-missing"
mkdir -p "$missing_clone"
if env -u EXPENSE_TRACKER_DATA \
    MEMORY_REPO_URL="https://example.com/owner/repo" \
    MEMORY_SRC_DIR="$topic_src" \
    MEMORY_CLONE_DIR="$missing_clone" \
    PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >/dev/null 2>&1 \
    && [ ! -e "$missing_clone/expense-tracker/MEMORY.md" ]; then
    ok "unset expense directory creates no partial memory"
else
    nope "unset expense directory" "backup failed or created expense-tracker/MEMORY.md"
fi

empty_expense="$TMPDIR/empty-expense"
empty_clone="$TMPDIR/expense-backup-empty"
stale_memory="$TMPDIR/stale-expense-memory"
empty_log="$TMPDIR/empty-expense.log"
mkdir -p "$empty_expense" "$empty_clone/expense-tracker"
printf 'stale expense memory\n' > "$stale_memory"
cp "$stale_memory" "$empty_clone/expense-tracker/MEMORY.md"
if MEMORY_REPO_URL="https://example.com/owner/repo" \
    MEMORY_SRC_DIR="$topic_src" \
    MEMORY_CLONE_DIR="$empty_clone" \
    EXPENSE_TRACKER_DATA="$empty_expense" \
    PATH="$TMPDIR/expense-stubbin:$PATH" \
    bash "$backup_script" >"$empty_log" 2>&1 \
    && grep -Fq "WARN: expense memory missing:" "$empty_log" \
    && cmp -s "$stale_memory" "$empty_clone/expense-tracker/MEMORY.md"; then
    ok "missing expense MEMORY.md warns without changing stale memory"
else
    nope "missing expense MEMORY.md" "backup lacked warning or changed stale memory"
fi

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
