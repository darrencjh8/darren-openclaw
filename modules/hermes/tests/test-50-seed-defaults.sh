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

# Extract the portfolio sync seeding snippet (no_agent + script, cron kind)
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
        "script": "portfolio-sync.sh",
        "no_agent": True,
        "enabled": True,
        "deliver": "local",
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
display3=$(echo "$output3" | cut -d'|' -f3)

[ "$name3" = "portfolio-daily-sync" ] && ok "job name" || nope "job name" "got: $name3"
[ "$kind3" = "cron" ] && ok "schedule kind is cron" || nope "schedule kind" "got: $kind3"
[ "$display3" = "0 12 * * *" ] && ok "schedule display correct" || nope "schedule display" "got: $display3"

expr_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('schedule', {}).get('expr', 'missing'))
")
[ "$expr_val" = "0 12 * * *" ] && ok "cron expr is correct" || nope "cron expr" "got: $expr_val"

echo ""
echo "=== portfolio-daily-sync no_agent config ==="

# Verify no_agent is True
no_agent_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('no_agent', 'missing'))
")
[ "$no_agent_val" = "True" ] && ok "no_agent is True" || nope "no_agent" "got: $no_agent_val"

# Verify script is portfolio-sync.sh
script_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('script', 'missing'))
")
[ "$script_val" = "portfolio-sync.sh" ] && ok "script is portfolio-sync.sh" || nope "script" "got: $script_val"

# Verify deliver is local
deliver_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('deliver', 'missing'))
")
[ "$deliver_val" = "local" ] && ok "deliver is local" || nope "deliver" "got: $deliver_val"

# Verify no prompt field (no LLM agent)
prompt_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('prompt', 'ABSENT'))
")
[ "$prompt_val" = "ABSENT" ] && ok "no prompt field (zero-token cron)" || nope "no prompt field" "got: $prompt_val"

# Verify no deliver_extra field
deliver_extra_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('deliver_extra', 'ABSENT'))
")
[ "$deliver_extra_val" = "ABSENT" ] && ok "no deliver_extra field" || nope "no deliver_extra field" "got: $deliver_extra_val"

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
echo "=== portfolio-daily-sync seed script integrity ==="

# Verify real 50-seed-defaults script has no_agent: True for portfolio-daily-sync
seed_has_no_agent=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
match = re.search(r\"<<'PYEOF'.*?\n(.*?)\nPYEOF\", content, re.DOTALL)
if not match:
    print('PYEOF_NOT_FOUND')
else:
    pyblock = match.group(1)
    has_no_agent = '\"no_agent\":' in pyblock or \"'no_agent':\" in pyblock
    print('found' if has_no_agent else 'missing')
")
[ "$seed_has_no_agent" = "found" ] && ok "seed: has no_agent field" || nope "seed: has no_agent field" "got: $seed_has_no_agent"

# Verify real 50-seed-defaults script has script: portfolio-sync.sh
seed_has_script=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
match = re.search(r\"<<'PYEOF'.*?\n(.*?)\nPYEOF\", content, re.DOTALL)
if not match:
    print('PYEOF_NOT_FOUND')
else:
    pyblock = match.group(1)
    has_script = 'portfolio-sync.sh' in pyblock
    print('found' if has_script else 'missing')
")
[ "$seed_has_script" = "found" ] && ok "seed: has script portfolio-sync.sh" || nope "seed: has script portfolio-sync.sh" "got: $seed_has_script"

# Verify real 50-seed-defaults script does NOT have a prompt for portfolio-daily-sync
seed_has_prompt=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
match = re.search(r\"<<'PYEOF'.*?\n(.*?)\nPYEOF\", content, re.DOTALL)
if not match:
    print('PYEOF_NOT_FOUND')
else:
    pyblock = match.group(1)
    has_prompt = 'new_prompt' in pyblock
    print('has_prompt' if has_prompt else 'no_prompt')
")
[ "$seed_has_prompt" = "no_prompt" ] && ok "seed: no prompt (zero-token)" || nope "seed: no prompt (zero-token)" "got: $seed_has_prompt"

# Verify real 50-seed-defaults script has deliver: local
seed_deliver=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
match = re.search(r\"<<'PYEOF'.*?\n(.*?)\nPYEOF\", content, re.DOTALL)
if not match:
    print('PYEOF_NOT_FOUND')
else:
    pyblock = match.group(1)
    has_local_deliver = '\"deliver\": \"local\"' in pyblock or \"'deliver': 'local'\" in pyblock or '\"deliver\":\"local\"' in pyblock
    print('local' if has_local_deliver else 'not_local')
")
[ "$seed_deliver" = "local" ] && ok "seed: deliver is local" || nope "seed: deliver is local" "got: $seed_deliver"

echo ""
echo "=== retired profile migration ==="
retired_profiles=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
match = re.search(r'for retired_profile in (.*?); do(.*?)done', content, re.DOTALL)
if not match:
    print('missing')
else:
    names = match.group(1) + match.group(2)
    expected = ('static-analyst', 'qa-engineer', 'quality-assurance')
    print('present' if all(name in names for name in expected) else 'incomplete')
")
[ "$retired_profiles" = "present" ] && ok "retired profiles are removed on startup" || nope "retired profile migration" "got: $retired_profiles"

code_reviewer_seed=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
print('present' if 'hermes profile create \$name --no-alias' in content else 'missing')
")
[ "$code_reviewer_seed" = "present" ] && ok "remaining profiles are registered on startup" || nope "profile registration" "got: $code_reviewer_seed"

managed_routing_migration=$(python3 -c "
with open('$SEED_SCRIPT') as f:
    content = f.read()
expected = 'managed_routing_profiles = (\"architect\", \"code-reviewer\", \"project-manager\")'
print('present' if expected in content else 'missing')
")
[ "$managed_routing_migration" = "present" ] && ok "managed profile routing migrates on startup" || nope "managed profile routing migration" "got: $managed_routing_migration"

echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
