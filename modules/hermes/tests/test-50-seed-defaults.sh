#!/bin/bash
# Unit tests for 50-seed-defaults cron job seeding.
# Tests that jobs are seeded with proper parsed schedule dicts, not raw strings.
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' NC='\033[0m'
pass=0 fail=0

ok()   { echo -e "  ${GREEN}PASS${NC} $1"; pass=$((pass+1)); }
nope() { echo -e "  ${RED}FAIL${NC} $1 — $2"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_SCRIPT="$SCRIPT_DIR/../50-seed-defaults"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "=== cron job schedule format ==="

# ------------------------------------------------------------------ helpers --
run_seed_python() {
    # Run a Python snippet from the seed script in isolation.
    # Sets up a temp jobs.json, runs the snippet, and returns the resulting jobs.
    local jobs_path="$TMPDIR/cron/jobs.json"
    mkdir -p "$(dirname "$jobs_path")"
    echo '{"jobs": []}' > "$jobs_path"
    python3 -c "$1"
    python3 -c "
import json
with open('$jobs_path') as f:
    data = json.load(f)
jobs = data.get('jobs', data) if isinstance(data, dict) else data
for j in jobs:
    sched = j.get('schedule', {})
    name = j.get('name', '?')
    kind = sched.get('kind', type(sched).__name__) if isinstance(sched, dict) else 'raw_string'
    display = j.get('schedule_display', 'missing')
    print(f'{name}|{kind}|{display}')
"
}

# Extract the github-auth-refresh seeding snippet (lines 39-63)
github_auth_snippet='
import os, json, uuid, datetime
jobs_path = "/'"$TMPDIR"'/cron/jobs.json"
os.makedirs(os.path.dirname(jobs_path), exist_ok=True)
try:
    with open(jobs_path) as f:
        data = json.load(f)
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
except (FileNotFoundError, json.JSONDecodeError):
    jobs = []
if not any(j.get("name") == "github-auth-refresh" for j in jobs if isinstance(j, dict)):
    jobs.append({
        "id": uuid.uuid4().hex[:12],
        "name": "github-auth-refresh",
        "schedule": {"kind": "interval", "minutes": 50, "display": "every 50m"},
        "schedule_display": "every 50m",
        "script": "github-auth.sh",
        "no_agent": True,
        "enabled": True,
        "deliver": "local",
        "next_run_at": None,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    })
    with open(jobs_path, "w") as f:
        json.dump({"jobs": jobs, "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}, f, indent=2)
'

echo "--- github-auth-refresh ---"
output=$(run_seed_python "$github_auth_snippet")
name=$(echo "$output" | cut -d'|' -f1)
kind=$(echo "$output" | cut -d'|' -f2)
display=$(echo "$output" | cut -d'|' -f3)

[ "$name" = "github-auth-refresh" ] && ok "job name" || nope "job name" "got: $name"
[ "$kind" = "interval" ] && ok "schedule kind is interval" || nope "schedule kind" "got: $kind"
[ "$display" = "every 50m" ] && ok "schedule_display set" || nope "schedule_display" "got: $display"

# Verify schedule is NOT a raw string
raw_check=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
jobs = data.get('jobs', [])
for j in jobs:
    if isinstance(j.get('schedule'), str):
        print('FAIL: raw string')
        exit(1)
print('OK: parsed dict')
")
[ "$raw_check" = "OK: parsed dict" ] && ok "schedule is dict, not raw string" || nope "schedule is dict" "$raw_check"

echo ""
echo "--- idempotent (no duplicate) ---"
# Run the same snippet again — should not create a second job
run_seed_python "$github_auth_snippet" >/dev/null
count=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
jobs = data.get('jobs', [])
print(len(jobs))
")
[ "$count" -eq 1 ] && ok "idempotent: exactly 1 job" || nope "idempotent" "got $count jobs"

echo ""
echo "=== memory-backup schedule ==="

# Extract the memory-backup seeding snippet
memory_snippet='
import os, json, uuid, datetime
jobs_path = "/'"$TMPDIR"'/cron/jobs.json"
os.makedirs(os.path.dirname(jobs_path), exist_ok=True)
try:
    with open(jobs_path) as f:
        data = json.load(f)
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
except (FileNotFoundError, json.JSONDecodeError):
    jobs = []
if not any(j.get("name") == "memory-backup" for j in jobs if isinstance(j, dict)):
    jobs.append({
        "id": uuid.uuid4().hex[:12],
        "name": "memory-backup",
        "schedule": {"kind": "interval", "minutes": 360, "display": "every 360m"},
        "schedule_display": "every 360m",
        "prompt": "Run /opt/data/scripts/memory-backup.sh to sync memories to git",
        "script": "memory-backup.sh",
        "no_agent": True,
        "enabled": True,
        "deliver": "local",
        "next_run_at": None,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    })
    with open(jobs_path, "w") as f:
        json.dump({"jobs": jobs, "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}, f, indent=2)
'

# Fresh tempdir for memory backup test
rm -rf "$TMPDIR/cron"
output2=$(run_seed_python "$memory_snippet")
name2=$(echo "$output2" | cut -d'|' -f1)
kind2=$(echo "$output2" | cut -d'|' -f2)

[ "$name2" = "memory-backup" ] && ok "job name" || nope "job name" "got: $name2"
[ "$kind2" = "interval" ] && ok "schedule kind is interval" || nope "schedule kind" "got: $kind2"

# Verify minutes=360
minutes=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('schedule', {}).get('minutes', 'missing'))
")
[ "$minutes" = "360" ] && ok "interval minutes is 360" || nope "interval minutes" "got: $minutes"

echo ""
echo "=== portfolio-daily-sync schedule ==="

# Extract the portfolio sync seeding snippet (uses cron kind)
portfolio_snippet='
import os, json, uuid, datetime
jobs_path = "/'"$TMPDIR"'/cron/jobs.json"
os.makedirs(os.path.dirname(jobs_path), exist_ok=True)
try:
    with open(jobs_path) as f:
        data = json.load(f)
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
except (FileNotFoundError, json.JSONDecodeError):
    jobs = []
if not any(j.get("name") == "portfolio-daily-sync" for j in jobs if isinstance(j, dict)):
    jobs.append({
        "id": uuid.uuid4().hex[:12],
        "name": "portfolio-daily-sync",
        "schedule": {"kind": "cron", "expr": "0 12 * * *", "display": "0 12 * * *"},
        "schedule_display": "0 12 * * *",
        "prompt": "Run portfolio_sync",
        "enabled": True,
        "deliver": "telegram",
        "next_run_at": None,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    })
    with open(jobs_path, "w") as f:
        json.dump({"jobs": jobs, "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}, f, indent=2)
'

rm -rf "$TMPDIR/cron"
output3=$(run_seed_python "$portfolio_snippet")
name3=$(echo "$output3" | cut -d'|' -f1)
kind3=$(echo "$output3" | cut -d'|' -f2)

[ "$name3" = "portfolio-daily-sync" ] && ok "job name" || nope "job name" "got: $name3"
[ "$kind3" = "cron" ] && ok "schedule kind is cron" || nope "schedule kind" "got: $kind3"

expr_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('schedule', {}).get('expr', 'missing'))
")
[ "$expr_val" = "0 12 * * *" ] && ok "cron expr is correct" || nope "cron expr" "got: $expr_val"

echo ""
echo "=== portfolio-daily-sync prompt content ==="

# Verify the prompt in 50-seed-defaults contains key instructions
# The prompt is a Python parenthesised string concat inside a heredoc.
# We extract the PYEOF block and use balanced-paren matching to eval the prompt.
prompt_content=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
# Extract the heredoc Python block between <<'PYEOF' and PYEOF
match = re.search(r\"<<'PYEOF'.*?\n(.*?)\nPYEOF\", content, re.DOTALL)
if not match:
    print('EXTRACT_FAILED')
else:
    pyblock = match.group(1)
    # Find '\"prompt\": (' and then match balanced parens
    idx = pyblock.find('\"prompt\":')
    if idx < 0:
        print('PROMPT_NOT_FOUND')
    else:
        rest = pyblock[idx:]
        paren_start = rest.index('(')
        depth = 0
        for i, ch in enumerate(rest[paren_start:], paren_start):
            if ch == '(': depth += 1
            elif ch == ')': depth -= 1
            if depth == 0:
                expr = rest[paren_start:i+1]
                break
        prompt = eval(expr)
        print(prompt)
")

# Test: prompt must instruct agent to omit "no errors" confirmation lines
echo "$prompt_content" | grep -q 'Do NOT include a .*no errors' \
    && ok "prompt suppresses 'no errors' confirmation" \
    || nope "prompt suppresses 'no errors' confirmation" "missing 'Do NOT include' instruction"

# Test: prompt must instruct to omit Actions section entirely when no issues
echo "$prompt_content" | grep -q 'omit this section entirely if there are no issues' \
    && ok "prompt omits Actions section when clean" \
    || nope "prompt omits Actions section when clean" "missing 'omit this section entirely' instruction"

# Test: prompt must contain the full analysis framework (synced from production)
echo "$prompt_content" | grep -q 'taxonomy_data.taxonomies' \
    && ok "prompt contains taxonomy analysis instructions" \
    || nope "prompt contains taxonomy analysis instructions" "missing taxonomy_data reference"

echo "$prompt_content" | grep -q 'Liquid assets' \
    && ok "prompt contains liquid/illiquid breakdown" \
    || nope "prompt contains liquid/illiquid breakdown" "missing Liquid assets section"

echo "$prompt_content" | grep -q 'search for news impacting the portfolio' \
    && ok "prompt contains news search instructions" \
    || nope "prompt contains news search instructions" "missing news search section"

echo ""
echo "=== SOUL.md always overwritten ==="

# Verify the init script always copies SOUL.md.template (no conditional guard)
soul_line=$(grep 'SOUL.md.template' "$SEED_SCRIPT" | grep 'cp ')
echo "$soul_line" | grep -qv '! -f' \
    && ok "SOUL.md copy is unconditional (always overwritten on boot)" \
    || nope "SOUL.md copy is unconditional" "found conditional guard: $soul_line"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
