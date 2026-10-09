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
    if [ "${SEED_JOBS_PRIMED:-0}" -eq 0 ]; then
        echo '{"jobs": []}' > "$jobs_path"
        export SEED_JOBS_PRIMED=1
    fi
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

# The real seed block is executed from the seed file (never copied): extract the
# github-app-auth-refresh PYEOF block and run it against the temp jobs path.
extract_seed_block() {
    python3 - "$SEED_SCRIPT" "$TMPDIR" <<'PY'
import re
import sys
seed_path, tmpdir = sys.argv[1], sys.argv[2]
content = open(seed_path, encoding="utf-8").read()
marker = "github-app-auth-refresh"
pos = content.find(marker)
if pos < 0:
    sys.exit("seed block marker missing: " + marker)
start_tag = "python3 <<'PYEOF' || true\n"
start = content.find(start_tag, pos)
if start < 0:
    start_tag = "python3 <<'PYEOF'\n"
    start = content.find(start_tag, pos)
end_tag = "\nPYEOF"
end = content.find(end_tag, start)
if start < 0 or end < 0:
    sys.exit("seed block boundaries missing for: " + marker)
block = content[start + len(start_tag):end]
print(block.replace("/opt/data/cron/jobs.json", tmpdir + "/cron/jobs.json"))
PY
}

prime_seed_jobs() {
    rm -rf "$TMPDIR/cron"
    export SEED_JOBS_PRIMED=0
}

echo "--- github-app-auth-refresh (from real seed) ---"
prime_seed_jobs
export SEED_JOBS_PRIMED=0
github_auth_snippet="$(extract_seed_block)"
[ -n "$github_auth_snippet" ] || { nope "seed block extracted" "github-app-auth-refresh block missing from $SEED_SCRIPT"; github_auth_snippet=":"; }
run_seed_python "$github_auth_snippet" >/dev/null
job_line=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for job in data.get('jobs', []):
    sched = job.get('schedule', {})
    print(f\"{job.get('name', '?')}|{sched.get('kind', type(sched).__name__)}|{job.get('schedule_display', 'missing')}\")
")
[ -n "$job_line" ] || { nope "seeded job is present" "jobs.json contains no jobs"; job_line="||"; }
name=$(echo "$job_line" | cut -d'|' -f1)
kind=$(echo "$job_line" | cut -d'|' -f2)
display=$(echo "$job_line" | cut -d'|' -f3)

[ "$name" = "github-app-auth-refresh" ] && ok "job name is github-app-auth-refresh" || nope "job name" "got: $name"
[ "$kind" = "interval" ] && ok "schedule kind is interval" || nope "schedule kind" "got: $kind"
[ "$display" = "every 15m" ] && ok "schedule_display is every 15m" || nope "schedule_display" "got: $display"

minutes_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('schedule', {}).get('minutes', 'missing'))
")
[ "$minutes_val" = "15" ] && ok "interval is 15 minutes" || nope "interval minutes" "got: $minutes_val"

cron_script_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('script', 'missing'))
")
[ "$cron_script_val" = "github-auth.sh" ] && ok "script is github-auth.sh" || nope "script" "got: $cron_script_val"

cron_no_agent_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('no_agent', 'missing'))
")
[ "$cron_no_agent_val" = "True" ] && ok "no_agent is True" || nope "no_agent" "got: $cron_no_agent_val"

cron_prompt_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('prompt', 'ABSENT'))
")
[ "$cron_prompt_val" = "ABSENT" ] && ok "no prompt field (zero-token cron)" || nope "no prompt field" "got: $cron_prompt_val"

cron_deliver_val=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
for j in data.get('jobs', []):
    print(j.get('deliver', 'missing'))
")
[ "$cron_deliver_val" = "local" ] && ok "deliver is local" || nope "deliver" "got: $cron_deliver_val"

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
# Re-run the real seed block against the already-seeded file: update-in-place must not append.
export SEED_JOBS_PRIMED=1
run_seed_python "$github_auth_snippet" >/dev/null 2>&1 || true
count=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
jobs = data.get('jobs', [])
print(len(jobs))
")
[ "$count" -eq 1 ] && ok "idempotent: exactly 1 job" || nope "idempotent" "got $count jobs"

echo ""
echo "--- migration: legacy github-auth-refresh 50m becomes the 15m job ---"
# Rename the seeded job to the legacy name/schedule, then run the real block:
# it must rename and reschedule in place, never append a second job.
python3 -c "
import json
path = '$TMPDIR/cron/jobs.json'
with open(path) as f:
    data = json.load(f)
jobs = data.get('jobs', [])
jobs[0]['name'] = 'github-auth-refresh'
jobs[0]['schedule'] = {'kind': 'interval', 'minutes': 50, 'display': 'every 50m'}
jobs[0]['schedule_display'] = 'every 50m'
with open(path, 'w') as f:
    json.dump(data, f)
"
run_seed_python "$github_auth_snippet" >/dev/null 2>&1 || true
mig_name=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
print(data.get('jobs', [])[0].get('name', 'missing'))
")
mig_minutes=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
print(data.get('jobs', [])[0].get('schedule', {}).get('minutes', 'missing'))
")
mig_count=$(python3 -c "
import json
with open('$TMPDIR/cron/jobs.json') as f:
    data = json.load(f)
print(len(data.get('jobs', [])))
")
[ "$mig_name" = "github-app-auth-refresh" ] && ok "migration renames legacy job" || nope "migration renames legacy job" "got: $mig_name"
[ "$mig_minutes" = "15" ] && ok "migration reschedules to 15m" || nope "migration reschedules" "got: $mig_minutes"
[ "$mig_count" -eq 1 ] && ok "migration keeps exactly 1 job" || nope "migration job count" "got $mig_count jobs"

echo ""
echo "--- boot precedence: App-first, scoped PAT fallback only when incomplete ---"
# The real seed must prefer the App helper and never invoke PAT login when the
# App triple is present. The fallback PAT arrives as the root-only secret file,
# never as an ambient FRIDAY_PAT environment variable.
boot_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import sys
content = open(sys.argv[1], encoding="utf-8").read()
marker = "Configure gh CLI authentication"
pos = content.find(marker)
print(content[pos:pos+2500] if pos >= 0 else "")
PY
)
echo "$boot_block" | grep -q "GH_APP_ID" || nope "boot: App-first branch" "App condition missing from $SEED_SCRIPT"
echo "$boot_block" | grep -q "github-auth.sh" || nope "boot: App helper invoked" "github-auth.sh missing from boot block"
echo "$boot_block" | grep -q "/run/secrets/friday_pat" || nope "boot: PAT fallback retained" "secret file missing from boot block"
echo "$boot_block" | grep -q 'GH_PAT="$PAT"' || nope "boot: PAT passed to helper" "GH_PAT not forwarded from the secret file"
if echo "$boot_block" | grep -q "FRIDAY_PAT"; then
    nope "boot: PAT is not ambient" "FRIDAY_PAT environment fallback is still present in the boot block"
else
    ok "T-precedence: boot prefers App, scoped PAT fallback only when incomplete"
fi

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
export SEED_JOBS_PRIMED=0
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
export SEED_JOBS_PRIMED=0
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
export SEED_JOBS_PRIMED=0
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

# Verify the portfolio block specifically rather than the first PYEOF block
# (the first block is now github-app-auth-refresh).
portfolio_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import sys
content = open(sys.argv[1], encoding="utf-8").read()
marker = "# Seed portfolio-sync cron job"
pos = content.find(marker)
start_tag = "python3 <<'PYEOF' || true\n"
start = content.find(start_tag, pos)
end = content.find("\nPYEOF", start)
print(content[start + len(start_tag):end] if pos >= 0 and start >= 0 and end >= 0 else "")
PY
)
[ -n "$portfolio_block" ] && ok "seed: portfolio block found" || nope "seed: portfolio block" "not found"
echo "$portfolio_block" | grep -q '"no_agent": True' && ok "seed: has no_agent field" || nope "seed: has no_agent field" "missing"
echo "$portfolio_block" | grep -q 'portfolio-sync.sh' && ok "seed: has script portfolio-sync.sh" || nope "seed: has script portfolio-sync.sh" "missing"
portfolio_prompt=$(printf '%s\n' "$portfolio_block" | grep -E '^[[:space:]]+"prompt"[[:space:]]*:' || true)
if [ -n "$portfolio_prompt" ]; then
    nope "seed: no prompt (zero-token)" "prompt present"
else
    ok "seed: no prompt (zero-token)"
fi
echo "$portfolio_block" | grep -q '"deliver": "local"' && ok "seed: deliver is local" || nope "seed: deliver is local" "missing"

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

# `hermes profile create` raises "A profile named ... already exists" for any directory that
# already carries an identity marker, and the seed copies write config.yaml/SOUL.md/profile.yaml
# before this call, so registration must be guarded by that same predicate.
profile_registration_guard=$(python3 -c "
import re
with open('$SEED_SCRIPT') as f:
    content = f.read()
guard = re.search(
    r'for marker in config\.yaml \.env SOUL\.md profile\.yaml auth\.json state\.db; do'
    r'.*?if \[ \"[$]identity\" -eq 0 \]; then\s*\n\s*su -s /bin/sh hermes -c \"hermes profile create [$]name --no-alias\"',
    content, re.DOTALL)
print('present' if guard else 'missing')
")
[ "$profile_registration_guard" = "present" ] && ok "profile registration is skipped when the profile already exists" || nope "profile registration guard" "got: $profile_registration_guard"

managed_routing_migration=$(python3 -c "
with open('$SEED_SCRIPT') as f:
    content = f.read()
profiles = 'managed_routing_profiles = (\"architect\", \"code-reviewer\", \"project-manager\", \"spec-auditor\")' in content
fields = 'for key in (\"providers\", \"model\", \"fallback_providers\")' in content
reviewer_isolation = 'if not isinstance(memory, dict):' in content and 'memory[\"memory_enabled\"] = False' in content and 'memory[\"user_profile_enabled\"] = False' in content
print('present' if profiles and fields and reviewer_isolation else 'missing')
")
[ "$managed_routing_migration" = "present" ] && ok "managed profile routing and reviewer isolation migrate on startup" || nope "managed profile migration" "got: $managed_routing_migration"

echo ""
echo "=== self-wiki-maintenance-and-reminders seed (MANAGED telegram) ==="

wiki_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re, sys
content = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", content, re.DOTALL)
named = [b for b in blocks if "self-wiki-maintenance-and-reminders" in b]
print(named[-1] if named else "")
PY
)
[ -n "$wiki_block" ] && ok "seed has a self-wiki-maintenance PYEOF block" || nope "self-wiki block" "not found"

rm -rf "$TMPDIR/cron-wiki"
mkdir -p "$TMPDIR/cron-wiki"
echo '{"jobs": []}' > "$TMPDIR/cron-wiki/jobs.json"
wiki_block_tmp=${wiki_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/cron-wiki\/jobs.json}
python3 -c "$wiki_block_tmp" >/dev/null 2>&1

wiki_fields=$(python3 - "$TMPDIR/cron-wiki/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
if len(jobs) != 1:
    print("fail count=%d" % len(jobs)); sys.exit()
j = jobs[0]
sched = j.get("schedule", {})
prompt = j.get("prompt") or ""
checks = {
    "name": j.get("name") == "self-wiki-maintenance-and-reminders",
    "kind": sched.get("kind") == "cron",
    "expr": sched.get("expr") == "0 9 * * 1",
    "display": j.get("schedule_display") == "every monday 9am",
    "enabled": j.get("enabled") is True,
    "deliver": j.get("deliver") == "telegram",
    "skills": j.get("skills") == ["llm-wiki", "expense-tracker", "notion", "notion-pitfalls", "github-issues", "cron-job-inspection", "docs-accuracy-verification"],
    "skill": j.get("skill") == "llm-wiki",
    "workdir": j.get("workdir") == "/workspace",
    "ctx": j.get("context_from") == ["self"],
    "prompt_len": len(prompt) > 500,
    "wiki_path": "/opt/data/home/wiki" in prompt,
    "schema": "SCHEMA.md" in prompt,
    "notion_ro": "Notion is read-only" in prompt,
    "target_line": "Send only to the configured delivery target" in prompt,
    "no_origin_claim": "Telegram is not connected" not in prompt,
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$wiki_fields" in
    pass) ok "job: monday 9am · telegram · llm-wiki stack · full-refresh prompt" ;;
    *) nope "self-wiki fields" "$wiki_fields" ;;
esac

# Idempotency: re-running the block must not duplicate the job.
python3 -c "$wiki_block_tmp" >/dev/null 2>&1
wiki2=$(python3 -c "import json;print(len(json.load(open('$TMPDIR/cron-wiki/jobs.json'))['jobs']))")
[ "$wiki2" = "1" ] && ok "idempotent: still 1 job on re-seed" || nope "self-wiki idempotent" "got $wiki2"

# Migration: existing installs get MANAGED fields (prompt/deliver/skills) updated
# in place, while schedule/enabled stay user-owned.
echo '{"jobs": [{"id": "legacywiki1", "name": "self-wiki-maintenance-and-reminders", "prompt": "legacy wiki prompt", "skills": ["llm-wiki"], "skill": "llm-wiki", "schedule": {"kind": "cron", "expr": "0 10 * * 2", "display": "tue 10am"}, "schedule_display": "tue 10am", "enabled": false, "deliver": "origin", "workdir": "/workspace", "context_from": ["self"]}]}' > "$TMPDIR/cron-wiki/jobs.json"
python3 -c "$wiki_block_tmp" >/dev/null 2>&1
wiki_mig=$(python3 - "$TMPDIR/cron-wiki/jobs.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))["jobs"][0]
prompt = j.get("prompt") or ""
ok = (
    len(json.load(open(sys.argv[1]))["jobs"]) == 1
    and j.get("deliver") == "telegram"
    and "Send only to the configured delivery target" in prompt
    and "Telegram is not connected" not in prompt
    and j.get("skills") == ["llm-wiki", "expense-tracker", "notion", "notion-pitfalls", "github-issues", "cron-job-inspection", "docs-accuracy-verification"]
    and j.get("schedule", {}).get("expr") == "0 10 * * 2"
    and j.get("enabled") is False
)
print("pass" if ok else "fail " + json.dumps({"deliver": j.get("deliver"), "expr": j.get("schedule", {}).get("expr"), "enabled": j.get("enabled")}))
PY
)
case "$wiki_mig" in
    pass) ok "migration: MANAGED telegram reconciled, schedule/enabled preserved" ;;
    *) nope "self-wiki migration" "$wiki_mig" ;;
esac
if ! python3 -c 'import yaml' >/dev/null 2>&1; then
    echo "  SKIP YAML-backed seed merge tests (PyYAML unavailable)"
    echo ""
    echo "========================================="
    echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
    echo "========================================="
    [ "$fail" -eq 0 ]
    exit $?
fi

migration_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re
import sys

content = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"# Migrate only routing fields.*?python3 - <<'PY'\n(.*?)\nPY\n", content, re.DOTALL)
print(match.group(1) if match else "")
PY
)
migration_defaults="$TMPDIR/hermes-defaults/profiles/code-reviewer"
migration_target="$TMPDIR/data/profiles/code-reviewer"
mkdir -p "$migration_defaults" "$migration_target"
cp "$SCRIPT_DIR/../profiles/code-reviewer/config.yaml" "$migration_defaults/config.yaml"
cat > "$migration_target/config.yaml" <<'YAML'
model:
  provider: stale
  default: stale
fallback_providers:
  - provider: stale
agent:
  reasoning_effort: low
  disabled_toolsets:
    - user-owned
memory:
  memory_enabled: true
  user_profile_enabled: true
approvals:
  mode: custom-preserved
mcp_servers:
  ktmb-booking:
    url: http://ktmb-booking:8082/mcp
  expense-tracker:
    url: http://expense-tracker:8080/mcp
YAML
migration_block=${migration_block//\/opt\/data/$TMPDIR/data}
migration_block=${migration_block//\/opt\/hermes-defaults/$TMPDIR/hermes-defaults}
python3 -c "$migration_block"
migration_result=$(python3 - "$migration_target/config.yaml" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
isolated = config["memory"]["memory_enabled"] is False and config["memory"]["user_profile_enabled"] is False
preserved = config["approvals"]["mode"] == "custom-preserved"
routed = config["model"] == {
    "provider": "custom:codex-router",
    "default": "commandcode/deepseek/deepseek-v4.1-flash",
}
escalating = config["fallback_providers"] == [
    {"provider": "custom:codex-router", "model": "auto-thinking"}
]
# The stale profile carries reasoning_effort low; the baked profile pins high. The
# effort must migrate, and the profile's own agent keys must survive it, or a
# bumped effort stays on disk at its old value and the change never takes effect.
effort = config["agent"]["reasoning_effort"] == "high"
agent_preserved = config["agent"]["disabled_toolsets"] == ["user-owned"]
# A retired MCP server (ktmb-booking) must leave the live profile file, or its
# connection fails on every boot; a server the profile still ships must stay.
servers = config.get("mcp_servers") or {}
retired_dropped = "ktmb-booking" not in servers
live_kept = "expense-tracker" in servers
print("pass" if isolated and preserved and routed and escalating and effort and agent_preserved and retired_dropped and live_kept else "fail")
PY
)
if [ "$migration_result" = "pass" ]; then
    ok "existing reviewer profile migrates to isolated round routing"
else
    nope "reviewer isolation fixture" "got: $migration_result"
fi
cat > "$migration_target/config.yaml" <<'YAML'
model:
  provider: stale
  default: stale
fallback_providers:
  - provider: stale
agent:
  reasoning_effort: low
memory:
approvals:
  mode: custom-preserved
YAML
null_memory_output=$(python3 -c "$migration_block" 2>&1) || null_memory_status=$?
null_memory_status=${null_memory_status:-0}
null_memory_result=$(python3 - "$migration_target/config.yaml" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
memory = config.get("memory")
isolated = isinstance(memory, dict) and memory.get("memory_enabled") is False and memory.get("user_profile_enabled") is False
preserved = config["approvals"]["mode"] == "custom-preserved"
routed = config["model"] == {
    "provider": "custom:codex-router",
    "default": "commandcode/deepseek/deepseek-v4.1-flash",
}
escalating = config["fallback_providers"] == [
    {"provider": "custom:codex-router", "model": "auto-thinking"}
]
effort = config["agent"]["reasoning_effort"] == "high"
print("pass" if isolated and preserved and routed and escalating and effort else "fail")
PY
)
if [ "$null_memory_status" -eq 0 ] && [ "$null_memory_result" = "pass" ]; then
    ok "null reviewer memory migrates safely"
else
    nope "null reviewer memory migration" "status=$null_memory_status result=$null_memory_result output=$null_memory_output"
fi

# A scalar, null, list or absent `agent` block must not crash the boot migration
# (the isinstance(agent, dict) guard) and must still end up pinned to high.
for agent_shape in 'agent: scalar-string' 'agent:' 'agent: [a, b]' 'unrelated: true'; do
    cat > "$migration_target/config.yaml" <<YAML
model:
  provider: stale
$agent_shape
YAML
    agent_status=0
    agent_output=$(python3 -c "$migration_block" 2>&1) || agent_status=$?
    agent_result=$(python3 - "$migration_target/config.yaml" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
agent = config.get("agent")
print("pass" if isinstance(agent, dict) and agent.get("reasoning_effort") == "high" else "fail")
PY
)
    if [ "$agent_status" -eq 0 ] && [ "$agent_result" = "pass" ]; then
        ok "malformed agent block migrates safely ($agent_shape)"
    else
        nope "malformed agent block ($agent_shape)" "status=$agent_status result=$agent_result output=$agent_output"
    fi
done

echo ""
echo "=== hermes config seeding ==="

# The seed script merges the baked canonical config into the live data dir: the
# baked file owns every key it defines, and a runtime-installed top-level key it
# does not define (codex-router's `hooks:`) survives. Run the real merge block
# against fixtures and parse the MERGED file, so the assertions fail if the
# seeded output loses either the compaction keys or a runtime-installed hook.
seed_merge_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re
import sys

with open(sys.argv[1]) as f:
    content = f.read()
match = re.search(r"<<'PYCONFIG'[^\n]*\n(.*?)\nPYCONFIG", content, re.DOTALL)
print(match.group(1) if match else "")
PY
)
[ -n "$seed_merge_block" ] \
    && ok "seed: has a config merge block" \
    || nope "seed: config merge block" "PYCONFIG block missing from $SEED_SCRIPT"

mkdir -p "$TMPDIR/seed/hermes-defaults" "$TMPDIR/seed/data"
cp "$SCRIPT_DIR/../config.yaml" "$TMPDIR/seed/hermes-defaults/config.yaml"
seed_config="$TMPDIR/seed/data/config.yaml"

# Live fixture: runtime-installed and hand-added top-level keys the baked config
# does not define, plus a drifted managed key the baked config must override.
cat > "$seed_config" <<'EOF'
hooks:
  pre_llm_call:
    - event: pre_llm_call
      command: /opt/data/agent-hooks/remind-worktree.sh
hooks_auto_accept: true
compression:
    threshold: 0.50
    threshold_tokens: 1
EOF

seed_ran=missing
if [ -n "$seed_merge_block" ]; then
    printf '%s\n' "$seed_merge_block" > "$TMPDIR/seed/merge.py"
    if python3 - "$TMPDIR/seed/hermes-defaults/config.yaml" "$seed_config" < "$TMPDIR/seed/merge.py"; then
        seed_ran=ok
    else
        seed_ran=failed
    fi
fi
[ "$seed_ran" = "ok" ] \
    && ok "seed: config merge block runs against a live config" \
    || nope "seed: config merge block runs" "status=$seed_ran"

seeded_hook=$(python3 - "$seed_config" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
hooks = config.get("hooks") or {}
entries = hooks.get("pre_llm_call") or []
command = entries[0].get("command", "") if entries and isinstance(entries[0], dict) else ""
print(command)
PY
)
if [ "$seed_ran" = "ok" ] && [ "$seeded_hook" = "/opt/data/agent-hooks/remind-worktree.sh" ]; then
    ok "config: runtime-installed hooks.pre_llm_call survives the seed"
else
    nope "seed preserves hooks.pre_llm_call" "status=$seed_ran got '$seeded_hook'"
fi

seeded_auto_accept=$(python3 - "$seed_config" <<'PY'
import sys

try:
    import yaml
except ModuleNotFoundError:
    print("SKIP_PYYAML")
    raise SystemExit(0)

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print(config.get("hooks_auto_accept"))
PY
)
if [ "$seed_ran" = "ok" ] && [ "$seeded_auto_accept" = "True" ]; then
    ok "config: other unknown top-level keys survive the seed"
else
    nope "seed preserves unknown top-level keys" "status=$seed_ran got '$seeded_auto_accept'"
fi

# A failing merge must never fall back to the raw copy that caused #461: an
# existing live config stays untouched, and only a missing file is bootstrapped.
seed_fallback=$(python3 - "$SEED_SCRIPT" <<'PY'
import re
import sys

with open(sys.argv[1]) as f:
    content = f.read()
match = re.search(
    r"(if ! python3 - /opt/hermes-defaults/config\.yaml /opt/data/config\.yaml <<'PYCONFIG'.*?\nPYCONFIG\n.*?\nfi)",
    content,
    re.DOTALL,
)
print(match.group(1) if match else "")
PY
)
mkdir -p "$TMPDIR/fallback/bin" "$TMPDIR/fallback/data"
printf '#!/bin/sh\nexit 1\n' > "$TMPDIR/fallback/bin/python3"
chmod +x "$TMPDIR/fallback/bin/python3"
if [ -n "$seed_fallback" ]; then
    seed_fallback=${seed_fallback//\/opt\/data/$TMPDIR/fallback/data}
    seed_fallback=${seed_fallback//\/opt\/hermes-defaults/$TMPDIR/seed/hermes-defaults}
    cp "$seed_config" "$TMPDIR/fallback/data/config.yaml"
    PATH="$TMPDIR/fallback/bin:$PATH" sh -c "$seed_fallback" 2>/dev/null
    cmp -s "$TMPDIR/fallback/data/config.yaml" "$seed_config" \
        && ok "seed: a failed merge leaves the live config untouched" \
        || nope "seed failure path preserves the live config" "live config was rewritten"

    # A first boot has no live config: the failure path must still bootstrap one.
    rm -f "$TMPDIR/fallback/data/config.yaml"
    PATH="$TMPDIR/fallback/bin:$PATH" sh -c "$seed_fallback" 2>/dev/null
    cmp -s "$TMPDIR/fallback/data/config.yaml" "$TMPDIR/seed/hermes-defaults/config.yaml" \
        && ok "seed: a failed merge still bootstraps a missing live config" \
        || nope "seed failure path bootstraps a missing config" "baked config was not copied"
else
    nope "seed failure path preserves the live config" "merge block not found in $SEED_SCRIPT"
fi

# Unparseable live YAML must not lose the carried keys without trace: the
# broken file is kept as config.yaml.invalid before the reseed overwrites it.
if [ -n "$seed_merge_block" ]; then
    printf 'hooks:\n  pre_llm_call:\n    - command: /x\n  bad: [unclosed\n' > "$TMPDIR/seed/data/config.yaml"
    cp "$TMPDIR/seed/data/config.yaml" "$TMPDIR/seed/data/broken.expected"
    # `|| true` keeps a merge regression from aborting the suite under set -e;
    # the cmp below then reports it as a named failure.
    python3 - "$TMPDIR/seed/hermes-defaults/config.yaml" "$TMPDIR/seed/data/config.yaml" \
        < "$TMPDIR/seed/merge.py" 2>/dev/null || true
    cmp -s "$TMPDIR/seed/data/config.yaml.invalid" "$TMPDIR/seed/data/broken.expected" \
        && ok "seed: an unparseable live config is backed up before reseeding" \
        || nope "seed backs up unparseable live config" "config.yaml.invalid missing or wrong"
else
    nope "seed backs up unparseable live config" "merge block not found in $SEED_SCRIPT"
fi

seeded_threshold_tokens=$(python3 - "$seed_config" <<'PY'
import sys

try:
    import yaml
except ModuleNotFoundError:
    print("SKIP_PYYAML")
    raise SystemExit(0)

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print((config.get("compression") or {}).get("threshold_tokens"))
PY
)
if [ "$seeded_threshold_tokens" = "300000" ]; then
    ok "config: compression.threshold_tokens is 300000 (seeded copy inherits 300k)"
else
    nope "compression.threshold_tokens" "expected 300000, got $seeded_threshold_tokens"
fi

seeded_threshold=$(python3 - "$seed_config" <<'PY'
import sys

try:
    import yaml
except ModuleNotFoundError:
    print("SKIP_PYYAML")
    raise SystemExit(0)

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print((config.get("compression") or {}).get("threshold"))
PY
)
if [ "$seeded_threshold" = "0.9" ]; then
    ok "config: compression.threshold is 0.90"
else
    nope "compression.threshold" "expected 0.9, got $seeded_threshold"
fi

# The merge must write the baked bytes unchanged, not re-serialise the parsed
# config: comments in the baked file are not round-tripped by PyYAML.
grep -q 'Keep this block AFTER `webhook`' "$seed_config" \
    && ok "config: seeded file keeps the baked file's comments" \
    || nope "seed keeps baked comments" "baked comment missing from seeded config"

# The memory core limit and session retention are the knobs the tier-2 design
# depends on: the judge prompt quotes the cap and retention decides how long the
# un-filed episodic record survives. Assert the seeded copy, not the repo file.
seeded_memory_limits=$(python3 - "$seed_config" <<'PY'
import sys

try:
    import yaml
except ModuleNotFoundError:
    print("SKIP_PYYAML")
    raise SystemExit(0)

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
sessions = config["sessions"]
print(
    config["memory"]["memory_char_limit"],
    sessions["retention_days"],
    sessions["auto_prune"],
    sessions["auto_archive"],
    sessions["auto_archive_days"],
)
PY
)
if [ "$seeded_memory_limits" = "2800 60 True True 14" ]; then
    ok "config: memory 2800 + retention 60 + prune/archive enabled (14d)"
else
    nope "memory/sessions config" "expected '2800 60 True True 14', got '$seeded_memory_limits'"
fi

echo ""
echo "=== compaction trigger derivation ==="

# threshold_tokens is a cap applied AFTER derivation, and Hermes floors the
# ratio to 0.75 for windows under its small-context limit (512000). Assert the
# derived trigger for stubbed windows, not just the literals: a cap that stops
# binding, or a threshold that no longer parses, must fail here. The compressor
# lives in the Hermes image, so this mirrors the documented formula rather than
# importing it and cannot see Hermes-side drift; that is the tradeoff #466 asked
# for over a literal restatement.
derived_trigger=$(python3 - "$seed_config" <<'PY'
import sys
import yaml

config = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
compression = config.get("compression") or {}
cap = compression.get("threshold_tokens")
ratio = compression.get("threshold")
# Mirrors agent/context_compressor.py in the Hermes image:
# _SMALL_CTX_WINDOW_LIMIT and the 0.75 floor applied by
# _effective_threshold_percent() below that limit.
HERMES_SMALL_CTX_WINDOW_LIMIT = 512_000
HERMES_SMALL_CTX_FLOOR_RATIO = 0.75


def trigger(window):
    if not isinstance(cap, (int, float)) or not isinstance(ratio, (int, float)):
        raise ValueError("compression.threshold_tokens={!r} compression.threshold={!r}".format(cap, ratio))
    effective = max(ratio, HERMES_SMALL_CTX_FLOOR_RATIO) if window < HERMES_SMALL_CTX_WINDOW_LIMIT else ratio
    return min(int(effective * window), int(cap))


failures = []
for window, expected in ((272_000, 244_800), (400_000, 300_000), (1_048_576, 300_000)):
    try:
        got = trigger(window)
    except ValueError as exc:
        failures.append(str(exc))
        continue
    if got != expected:
        failures.append("window {}: expected {}, got {}".format(window, expected, got))
print("pass" if not failures else "; ".join(failures))
PY
)
if [ "$derived_trigger" = "pass" ]; then
    ok "config: derived compaction trigger is min(floor_ratio x window, 300000)"
else
    nope "compaction trigger derivation" "$derived_trigger"
fi

echo ""
echo "=== opencode config seeding is retired ==="

# The image no longer installs the opencode CLI, so the seed script must not
# write an opencode config into either runtime home and must not seed the
# opencode log-triage agent. A leftover seed would recreate state for a runtime
# that no longer exists.
opencode_leftovers=$(python3 - "$SEED_SCRIPT" <<'PY'
import sys
with open(sys.argv[1]) as f:
    content = f.read()
markers = (
    "PYOPENCODE",
    "/opt/data/home/.config/opencode/opencode.json",
    "/opt/data/.config/opencode/opencode.json",
    "log-triage-worker.md",
)
found = [m for m in markers if m in content]
print("clean" if not found else "found " + repr(found))
PY
)
[ "$opencode_leftovers" = "clean" ] \
    && ok "seed script no longer writes opencode config or agents" \
    || nope "opencode seeding retired" "$opencode_leftovers"

echo ""
echo "=== memory-triage cron seeding (survives reinstall) ==="

# The memory-triage job drains the memory write-approval queue. It must be seeded
# so it survives a reinstall, along with the scripts + skill it depends on.
mt_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re, sys
content = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", content, re.DOTALL)
named = [b for b in blocks if "memory-triage" in b]
print(named[-1] if named else "")
PY
)
[ -n "$mt_block" ] && ok "seed has a memory-triage PYEOF block" || nope "memory-triage block" "not found"

rm -rf "$TMPDIR/cron"
mkdir -p "$TMPDIR/cron"
echo '{"jobs": []}' > "$TMPDIR/cron/jobs.json"
mt_block_tmp=${mt_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/cron\/jobs.json}
python3 -c "$mt_block_tmp" >/dev/null 2>&1

mt_fields=$(python3 - "$TMPDIR/cron/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
if len(jobs) != 1:
    print("fail count=%d" % len(jobs)); sys.exit()
j = jobs[0]
sched = j.get("schedule", {})
prompt = j.get("prompt") or ""
checks = {
    "name": j.get("name") == "memory-triage",
    "kind": sched.get("kind") == "cron",
    "expr": sched.get("expr") == "0 8 * * *",
    "display": j.get("schedule_display") == "0 8 * * *",
    "enabled": j.get("enabled") is True,
    "deliver": j.get("deliver") == "telegram",
    "skills": j.get("skills") == ["hermes-troubleshooting"],
    "prompt_len": len(prompt) > 500,
    "safe_rollback": "memory-triage.sh restore" in prompt,
    "cap": "--max-records" in prompt or "40 records" in prompt,
    "audit": "memory-triage-audit.jsonl" in prompt,
    "topic_rule": "memories/topics" in prompt,
    "untruncated_list": "list --full" in prompt,
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$mt_fields" in
    pass) ok "job: cron 0 8 * * * · telegram · hermes-troubleshooting · safe prompt (snapshot/cap/audit)" ;;
    *) nope "memory-triage fields" "$mt_fields" ;;
esac

# Idempotency: re-running the block must not duplicate the job.
python3 -c "$mt_block_tmp" >/dev/null 2>&1
mt2=$(python3 -c "import json;print(len(json.load(open('$TMPDIR/cron/jobs.json'))['jobs']))")
[ "$mt2" = "1" ] && ok "idempotent: still 1 job on re-seed" || nope "memory-triage idempotent" "got $mt2"

# Migration: an install that already has the job must get the managed fields updated
# in place. The seed only appends when the job is missing, so a prompt change that
# relied on the append path would never reach a running deployment.
echo ""
echo "=== memory-triage prompt migration (existing installs) ==="

rm -rf "$TMPDIR/cron-legacy"
mkdir -p "$TMPDIR/cron-legacy"
cat > "$TMPDIR/triage-config.yaml" <<'CFG'
memory:
    memory_char_limit: 2800
    user_char_limit: 1375
CFG
python3 - "$TMPDIR/cron-legacy/jobs.json" <<'PY'
import json, sys
legacy = "Triage the Hermes memory write-approval queue on this machine (HERMES_HOME=/opt/data).\n\nlegacy prompt without the topic-file rule"
json.dump({"jobs": [{
    "id": "legacy1234",
    "name": "memory-triage",
    "prompt": legacy,
    "skills": ["hermes-troubleshooting"],
    "skill": "hermes-troubleshooting",
    "schedule": {"kind": "cron", "expr": "30 3 * * *", "display": "30 3 * * *"},
    "schedule_display": "30 3 * * *",
    "enabled": False,
    "deliver": "local",
    "context_from": ["self"],
    "created_at": "2026-01-01T00:00:00+00:00",
    "user_note": "keep me",
}]}, open(sys.argv[1], "w"))
PY

mt_legacy_tmp=${mt_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/cron-legacy\/jobs.json}
mt_legacy_tmp=${mt_legacy_tmp//\/opt\/data\/config.yaml/$TMPDIR\/triage-config.yaml}
mt_migrate_out=$(python3 -c "$mt_legacy_tmp" 2>&1)

mt_migrate=$(python3 - "$TMPDIR/cron-legacy/jobs.json" <<'PY'
import json, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
if len(jobs) != 1:
    print("fail count=%d" % len(jobs)); sys.exit()
j = jobs[0]
prompt = j.get("prompt") or ""
checks = {
    "id_preserved": j.get("id") == "legacy1234",
    "created_at_preserved": j.get("created_at") == "2026-01-01T00:00:00+00:00",
    "user_field_preserved": j.get("user_note") == "keep me",
    "prompt_updated": "memories/topics" in prompt,
    "untruncated_list": "list --full" in prompt,
    "schedule_not_reverted": j.get("schedule_display") == "30 3 * * *",
    "disabled_stays_disabled": j.get("enabled") is False,
    "deliver_not_reverted": j.get("deliver") == "local",
    "cap_from_config": "memory 2800 chars" in prompt,
}
bad = [k for k, v in checks.items() if not v]
print("pass" if not bad else "fail " + repr(bad))
PY
)
case "$mt_migrate" in
    pass) ok "existing job migrated in place (prompt only; schedule/enabled/deliver/user fields preserved)" ;;
    *) nope "memory-triage migration" "$mt_migrate" ;;
esac
case "$mt_migrate_out" in
    *migrated*) ok "migration is reported" ;;
    *) nope "migration report" "got: $mt_migrate_out" ;;
esac

# An install created under the old 09:00 default moves to 08:00 once (#579).
# Only the exact legacy value is rewritten; a custom time is kept (above).
echo ""
echo "=== memory-triage legacy 09:00 schedule migration (#579) ==="
rm -rf "$TMPDIR/cron-0900"
mkdir -p "$TMPDIR/cron-0900"
python3 - "$TMPDIR/cron-0900/jobs.json" <<'PY'
import json, sys
json.dump({"jobs": [{
    "id": "old0900job", "name": "memory-triage", "prompt": "old",
    "skills": ["hermes-troubleshooting"], "skill": "hermes-troubleshooting",
    "schedule": {"kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *"},
    "schedule_display": "0 9 * * *", "enabled": False, "deliver": "local",
}]}, open(sys.argv[1], "w"))
PY
mt_0900=${mt_block//\/opt\/data\/cron\/jobs.json/$TMPDIR\/cron-0900\/jobs.json}
mt_0900=${mt_0900//\/opt\/data\/config.yaml/$TMPDIR\/triage-config.yaml}
mt_0900_out=$(python3 -c "$mt_0900" 2>&1)
mt_0900_res=$(python3 - "$TMPDIR/cron-0900/jobs.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))["jobs"][0]
ok = (j["schedule"].get("expr") == "0 8 * * *" and j["schedule"].get("display") == "0 8 * * *"
      and j.get("schedule_display") == "0 8 * * *" and j.get("enabled") is False
      and j.get("deliver") == "local")
print("pass" if ok else "fail " + json.dumps(j.get("schedule")) + " " + str(j.get("schedule_display")))
PY
)
[ "$mt_0900_res" = "pass" ] && ok "legacy 0 9 * * * schedule migrated to 0 8 * * *" || nope "legacy schedule migration" "$mt_0900_res"
case "$mt_0900_out" in
    *migrated*schedule*) ok "schedule migration is reported" ;;
    *) nope "schedule migration report" "got: $mt_0900_out" ;;
esac
mt_0900_again=$(python3 -c "$mt_0900" 2>&1)
case "$mt_0900_again" in
    *unchanged*) ok "schedule migration is idempotent" ;;
    *) nope "schedule migration idempotent" "got: $mt_0900_again" ;;
esac

# The routing rule must name the topic-file directory the seed creates.
grep -q "/opt/data/memories/topics" "$SEED_SCRIPT" \
    && ok "seed creates the topic-file directory" \
    || nope "topic-file directory" "seed does not reference /opt/data/memories/topics"

# Without a pointer in the always-on core, tier 2 is write-only: a fresh session
# that has not loaded the troubleshooting skill has no cue the files exist.
echo ""
echo "=== MEMORY.md topic-directory pointer ==="

ptr_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re, sys
content = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r"<<'PYPTR'[^\n]*\n(.*?)\nPYPTR", content, re.DOTALL)
print(blocks[-1] if blocks else "")
PY
)
[ -n "$ptr_block" ] && ok "seed has a MEMORY.md pointer block" || nope "pointer block" "not found"

mkdir -p "$TMPDIR/memories"
printf 'existing core line\n' > "$TMPDIR/memories/MEMORY.md"
ptr_tmp=${ptr_block//\/opt\/data\/memories\/MEMORY.md/$TMPDIR\/memories\/MEMORY.md}
ptr_tmp=${ptr_tmp//\/opt\/data\/config.yaml/$TMPDIR\/triage-config.yaml}
python3 -c "$ptr_tmp" >/dev/null 2>&1

grep -q "memories/topics" "$TMPDIR/memories/MEMORY.md" \
    && ok "pointer added to MEMORY.md" \
    || nope "pointer content" "MEMORY.md has no topic-directory pointer"
grep -q "existing core line" "$TMPDIR/memories/MEMORY.md" \
    && ok "pointer does not clobber existing entries" \
    || nope "pointer clobber" "existing entry lost"

python3 -c "$ptr_tmp" >/dev/null 2>&1
ptr_count=$(grep -c "memories/topics" "$TMPDIR/memories/MEMORY.md")
[ "$ptr_count" = "1" ] && ok "pointer is idempotent (added once)" || nope "pointer idempotency" "occurrences: $ptr_count"

# A full core must not be pushed over its cap by the pointer.
mkdir -p "$TMPDIR/fullmem"
python3 - "$TMPDIR/fullmem/MEMORY.md" <<'PY'
import sys
open(sys.argv[1], "w").write("x" * 200 + "\n")
PY
cat > "$TMPDIR/tiny-config.yaml" <<'CFG'
memory:
    memory_char_limit: 100
CFG
ptr_full_tmp=${ptr_block//\/opt\/data\/memories\/MEMORY.md/$TMPDIR\/fullmem\/MEMORY.md}
ptr_full_tmp=${ptr_full_tmp//\/opt\/data\/config.yaml/$TMPDIR\/tiny-config.yaml}
ptr_full_out=$(python3 -c "$ptr_full_tmp" 2>&1)
if grep -q "memories/topics" "$TMPDIR/fullmem/MEMORY.md"; then
    nope "pointer cap guard" "pointer written past the configured limit"
else
    ok "pointer refused when the core is full (reports it)"
fi

# Reinstall survival: scripts + skill must be baked in the repo (image) so the
# seed can restore them.
[ -f "$SCRIPT_DIR/../scripts/memory-triage.sh" ] && ok "baked: scripts/memory-triage.sh" || nope "scripts/memory-triage.sh" "missing"
[ -f "$SCRIPT_DIR/../scripts/memory_triage.py" ] && ok "baked: scripts/memory_triage.py" || nope "scripts/memory_triage.py" "missing"
[ -f "$SCRIPT_DIR/../skills/hermes-troubleshooting/SKILL.md" ] && ok "baked: skill SKILL.md" || nope "skill SKILL.md" "missing"
[ -f "$SCRIPT_DIR/../skills/hermes-troubleshooting/scripts/memory_triage.py" ] && ok "baked: skill triage engine" || nope "skill triage engine" "missing"

python3 -m py_compile "$SCRIPT_DIR/../scripts/memory_triage.py" 2>/dev/null \
    && ok "memory_triage.py compiles" || nope "py compile" "syntax error"

echo ""
echo "=== boot reconcile log probe ==="

# The hook keeps the reconcile's stderr in a boot log and falls back to
# /dev/null when the log path cannot be opened. Nothing else runs that branch:
# the probe block is extracted and executed under dash (the shell the hook runs
# as) against a stub reconciler. A revert to a bare `:` (which exits the shell on
# a failed redirection) or to a `mkdir -p`-only check (which returns 0 when the
# log path already exists as a directory) then fails here instead of silently
# skipping the reconcile on every boot.
probe_block=$(python3 - "$SEED_SCRIPT" <<'PY'
import re
import sys

content = open(sys.argv[1], encoding="utf-8").read()
match = re.search(
    r"(mkdir -p /opt/data/logs 2>/dev/null \|\| true\n"
    r"if true 2>/opt/data/logs/codex-router-skills-sync\.log; then\n.*?\nfi)",
    content,
    re.DOTALL,
)
print(match.group(1) if match else "")
PY
)
[ -n "$probe_block" ] \
    && ok "seed: has the boot reconcile log probe" \
    || nope "seed: boot reconcile log probe" "probe block missing from $SEED_SCRIPT"

probe_root="$TMPDIR/probe"
mkdir -p "$probe_root/hermes-defaults/scripts" "$probe_root/data/logs"
cat > "$probe_root/hermes-defaults/scripts/sync-codex-router-skills.sh" <<'STUB'
#!/bin/sh
printf 'stub reconcile ran\n' >> "$PROBE_MARKER"
printf 'stub reconcile stderr\n' >&2
STUB
chmod +x "$probe_root/hermes-defaults/scripts/sync-codex-router-skills.sh"

# The hook hardcodes absolute paths, so run the extracted block against the temp
# fixtures. It is executed as a file, never sourced: a special-builtin redirect
# failure exits the shell outright, and sourcing would apply that to this suite
# instead of to the hook under test.
probe_code=${probe_block//\/opt\/data/$probe_root/data}
probe_code=${probe_code//\/opt\/hermes-defaults/$probe_root/hermes-defaults}
probe_script="$TMPDIR/probe-hook.sh"
printf '%s\n' "$probe_code" > "$probe_script"
if command -v dash >/dev/null 2>&1; then
    probe_shell=dash
else
    probe_shell=sh
fi

probe_log="$probe_root/data/logs/codex-router-skills-sync.log"
probe_marker="$TMPDIR/probe-marker"

# Healthy log path: the reconcile must run and its stderr must land in the log.
: > "$probe_marker"
probe_rc=0
PROBE_MARKER="$probe_marker" "$probe_shell" "$probe_script" 2>"$TMPDIR/probe-hook-stderr" || probe_rc=$?
probe_ran=$(cat "$probe_marker" 2>/dev/null || true)
probe_logged=$(cat "$probe_log" 2>/dev/null || true)
probe_hook_stderr=$(cat "$TMPDIR/probe-hook-stderr" 2>/dev/null || true)
[ -n "$probe_block" ] && [ "$probe_rc" -eq 0 ] && [ "$probe_ran" = "stub reconcile ran" ] \
    && [ "$probe_logged" = "stub reconcile stderr" ] \
    && ok "boot probe: reconcile runs and its stderr lands in the log" \
    || nope "boot probe: healthy log path" \
        "rc=$probe_rc ran='$probe_ran' logged='$probe_logged' hook_stderr='$probe_hook_stderr'"

# Unwritable log path (a directory with that name): the hook must not exit and
# the reconcile must still run, with its stderr discarded.
rm -f "$probe_log"
mkdir -p "$probe_log"
: > "$probe_marker"
probe_fallback_rc=0
PROBE_MARKER="$probe_marker" "$probe_shell" "$probe_script" 2>"$TMPDIR/probe-fallback-stderr" || probe_fallback_rc=$?
probe_fallback_ran=$(cat "$probe_marker" 2>/dev/null || true)
probe_fallback_stderr=$(cat "$TMPDIR/probe-fallback-stderr" 2>/dev/null || true)
probe_fallback_litter=$(ls -A "$probe_log" 2>/dev/null || true)
[ -n "$probe_block" ] && [ "$probe_fallback_rc" -eq 0 ] \
    && [ "$probe_fallback_ran" = "stub reconcile ran" ] \
    && [ -z "$probe_fallback_litter" ] \
    && ok "boot probe: reconcile still runs when the log path is a directory" \
    || nope "boot probe: log path is a directory" \
        "rc=$probe_fallback_rc ran='$probe_fallback_ran' hook_stderr='$probe_fallback_stderr'"

echo "--- seeded script pruning (#605) ---"
seed_scripts_run() {
    # Run the real seed-scripts block with /opt paths rewritten into $TMPDIR/sp.
    local blk="$TMPDIR/seed-scripts-block.sh"
    awk '/# seed-scripts:begin/{f=1} f{print} /# seed-scripts:end/{f=0}' "$SEED_SCRIPT" \
        | sed "s#/opt/data#$TMPDIR/sp/data#g; s#/opt/hermes-defaults#$TMPDIR/sp/defaults#g" > "$blk"
    [ -s "$blk" ] || return 1
    sh "$blk"
}
SP="$TMPDIR/sp"
rm -rf "$SP"; mkdir -p "$SP/defaults/scripts" "$SP/data/scripts"
echo a > "$SP/defaults/scripts/keep.sh"; echo b > "$SP/defaults/scripts/old.sh"
echo op > "$SP/data/scripts/operator.sh"
echo stale > "$SP/data/scripts/preexisting-orphan.sh"

seed_scripts_run || nope "seed-scripts block runs (first boot)" "extract or run failed"
[ -f "$SP/data/scripts/preexisting-orphan.sh" ] && [ -f "$SP/data/scripts/operator.sh" ] \
    && ok "first boot with no manifest prunes nothing" || nope "first boot prune" "files removed"
[ -f "$SP/data/.hermes-seeded-scripts" ] && grep -qx old.sh "$SP/data/.hermes-seeded-scripts" \
    && ok "first boot writes manifest" || nope "first boot manifest" "missing or incomplete"

rm "$SP/defaults/scripts/old.sh"
seed_scripts_run || true
[ ! -e "$SP/data/scripts/old.sh" ] && ok "script removed from image is pruned" || nope "prune removed" "old.sh still present"
[ -f "$SP/data/scripts/operator.sh" ] && [ -f "$SP/data/scripts/preexisting-orphan.sh" ] \
    && ok "operator and pre-manifest files are kept" || nope "keep operator file" "removed"
[ -f "$SP/data/scripts/keep.sh" ] && ! grep -qx old.sh "$SP/data/.hermes-seeded-scripts" \
    && ok "manifest rewritten without pruned name" || nope "manifest rewrite" "$(cat "$SP/data/.hermes-seeded-scripts" 2>/dev/null)"

before=$(cat "$SP/data/.hermes-seeded-scripts")
seed_scripts_run || true
[ "$before" = "$(cat "$SP/data/.hermes-seeded-scripts")" ] && [ -f "$SP/data/scripts/keep.sh" ] && [ -f "$SP/data/scripts/operator.sh" ] \
    && ok "re-running is idempotent" || nope "idempotence" "state changed"


echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="
[ "$fail" -eq 0 ] || exit 1
