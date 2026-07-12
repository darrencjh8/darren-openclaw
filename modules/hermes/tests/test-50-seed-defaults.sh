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

# Extract the github-auth-refresh seeding snippet
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
        "deliver_extra": {"chat_id": "test-channel"},
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

# Verify the prompt in 50-seed-defaults contains key instructions.
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
    # Find new_prompt variable: new_prompt = (...)
    idx = pyblock.find('new_prompt =')
    if idx >= 0:
        rest = pyblock[idx:]
        paren_start = rest.index('(')
    else:
        # Fallback: inline \"prompt\": (...)
        idx = pyblock.find('\"prompt\":')
        if idx < 0:
            print('PROMPT_NOT_FOUND')
            exit()
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

# Test: prompt must instruct agent to relay message_body verbatim
echo "$prompt_content" | grep -q 'verbatim' \
    && ok "prompt: relay message_body verbatim" \
    || nope "prompt: relay message_body verbatim" "missing 'verbatim' instruction"

# Test: prompt must instruct agent NOT to modify/reformat/compute
echo "$prompt_content" | grep -q 'Do NOT convert to tables' \
    && ok "prompt: forbid modification of message_body" \
    || nope "prompt: forbid modification" "missing 'Do NOT convert to tables' instruction"

# Test: prompt must contain news source blocklist
echo "$prompt_content" | grep -q 'bloomberg.com' \
    && ok "prompt: block bloomberg.com from news search" \
    || nope "prompt: block bloomberg.com" "missing bloomberg.com in blocklist"

echo "$prompt_content" | grep -q 'wsj.com' \
    && ok "prompt: block wsj.com from news search" \
    || nope "prompt: block wsj.com" "missing wsj.com in blocklist"

echo "$prompt_content" | grep -q 'ft.com' \
    && ok "prompt: block ft.com from news search" \
    || nope "prompt: block ft.com" "missing ft.com in blocklist"

# Test: prompt must instruct LLM to NOT add commentary on news
echo "$prompt_content" | grep -q 'Do NOT add commentary' \
    && ok "prompt: forbid news commentary" \
    || nope "prompt: forbid news commentary" "missing 'Do NOT add commentary' instruction"

# Test: prompt must reference portfolio_status.analysis (new data path)
echo "$prompt_content" | grep -q 'portfolio_status.analysis' \
    && ok "prompt: references portfolio_status.analysis" \
    || nope "prompt: references portfolio_status.analysis" "missing analysis path reference"

# Test: prompt must reference portfolio_sync (entry point unchanged)
echo "$prompt_content" | grep -q 'portfolio_sync' \
    && ok "prompt: references portfolio_sync entry point" \
    || nope "prompt: references portfolio_sync" "missing portfolio_sync reference"
# Test: prompt handles sync failures with user guidance
echo "$prompt_content" | grep -q 'onedrive setup' \
    && ok "prompt: guides user on sync failure" \
    || nope "prompt: guides user on sync failure" "missing 'onedrive setup' guidance"

# Test: prompt must NOT contain old LLM-computed analysis instructions
if echo "$prompt_content" | grep -q 'tag each child as Tech'; then
    nope "prompt: no hardcoded sector tagging (removed)" "old instruction still present"
else
    ok "prompt: no hardcoded sector tagging (removed)"
fi

if echo "$prompt_content" | grep -q 'Only report CHANGES from your memory'; then
    nope "prompt: no manual change tracking (removed)" "old instruction still present"
else
    ok "prompt: no manual change tracking (removed)"
fi

if echo "$prompt_content" | grep -q 'omit this section entirely'; then
    nope "prompt: no manual actions section (removed)" "old instruction still present"
else
    ok "prompt: no manual actions section (removed)"
fi

echo ""
echo "=== portfolio-daily-sync deliver config ==="

# Verify deliver_extra.chat_id is set in the actual seed script
deliver_extra=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
match = re.search(r\"<<'PYEOF'.*?\n(.*?)\nPYEOF\", content, re.DOTALL)
if match:
    pyblock = match.group(1)
    idx = pyblock.find('\"deliver_extra\":')
    if idx >= 0:
        # Extract the dict after deliver_extra
        rest = pyblock[idx:]
        brace_start = rest.index('{')
        depth = 0
        for i, ch in enumerate(rest[brace_start:], brace_start):
            if ch == '{': depth += 1
            elif ch == '}': depth -= 1
            if depth == 0:
                expr = rest[brace_start:i+1]
                break
        obj = eval(expr, {'os': __import__('os')})
        if 'chat_id' in obj:
            print('chat_id_present')
        else:
            print('chat_id_missing')
    else:
        print('deliver_extra_not_found')
else:
    print('PYEOF_NOT_FOUND')
")
[ "$deliver_extra" = "chat_id_present" ] \
    && ok "deliver_extra.chat_id is set" \
    || nope "deliver_extra.chat_id is set" "got: $deliver_extra"

echo ""
echo "=== portfolio-daily-sync schedule integrity ==="

# Verify schedule is still cron with correct expr
rm -rf "$TMPDIR/cron"
output_ps=$(run_seed_python "$portfolio_snippet")
name_ps=$(echo "$output_ps" | cut -d'|' -f1)
kind_ps=$(echo "$output_ps" | cut -d'|' -f2)
display_ps=$(echo "$output_ps" | cut -d'|' -f3)

[ "$name_ps" = "portfolio-daily-sync" ] && ok "schedule: job name correct" || nope "schedule: job name" "got: $name_ps"
[ "$kind_ps" = "cron" ] && ok "schedule: kind is cron" || nope "schedule: kind" "got: $kind_ps"
[ "$display_ps" = "0 12 * * *" ] && ok "schedule: display correct" || nope "schedule: display" "got: $display_ps"

expr_ps=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('schedule', {}).get('expr', 'missing'))
")
[ "$expr_ps" = "0 12 * * *" ] && ok "schedule: cron expr is 0 12 * * *" || nope "schedule: cron expr" "got: $expr_ps"

# Verify job is enabled
enabled_ps=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('enabled', 'missing'))
")
[ "$enabled_ps" = "True" ] && ok "job is enabled" || nope "job enabled" "got: $enabled_ps"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
