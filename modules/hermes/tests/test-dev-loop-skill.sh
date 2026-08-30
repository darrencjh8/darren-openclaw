#!/bin/bash
# Contract tests for the baked-in dev-loop skill.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$SCRIPT_DIR/../skills"
DEV_LOOP_SKILL="$SKILL_DIR/dev-loop/SKILL.md"
CODE_REVIEWER_SKILL="$SKILL_DIR/code-reviewer/SKILL.md"

fail=0
ok() { printf 'PASS %s\n' "$1"; }
nope() { printf 'FAIL %s\n' "$1"; fail=1; }
require() {
    local file="$1"
    local label="$2"
    local pattern="$3"
    if grep -Fq -- "$pattern" "$file"; then
        ok "$label"
    else
        nope "$label"
    fi
}

[ -f "$DEV_LOOP_SKILL" ] && ok "dev-loop skill is baked in" || { nope "dev-loop skill is baked in"; exit 1; }
[ -f "$CODE_REVIEWER_SKILL" ] && ok "code-reviewer skill is baked in" || { nope "code-reviewer skill is baked in"; exit 1; }
require "$DEV_LOOP_SKILL" "skill pulls origin main before planning" "git pull --ff-only origin <default-branch>"
require "$DEV_LOOP_SKILL" "skill creates a worktree from verified origin" "Create a new isolated \`feat/...\` or \`fix/...\` worktree and branch from that verified \`origin/<default-branch>\` SHA"
require "$DEV_LOOP_SKILL" "skill uses the sole reviewer profile" "--profile code-reviewer"
require "$DEV_LOOP_SKILL" "skill requires the Terra reviewer route" "managed GPT Terra route"
require "$DEV_LOOP_SKILL" "skill owns the loop through merge" "Own the loop through completion."
require "$CODE_REVIEWER_SKILL" "reviewer skill pins the managed profile" "managed \`code-reviewer\` profile"
require "$CODE_REVIEWER_SKILL" "reviewer skill requires Terra" "routes to GPT Terra through the codex router"

if grep -Fq -- "--provider deepseek" "$DEV_LOOP_SKILL" || grep -Fq -- "deepseek-v4-pro --reasoning" "$DEV_LOOP_SKILL" || grep -Fq -- "pinned to **DeepSeek" "$CODE_REVIEWER_SKILL"; then
    nope "skills have no hardcoded DeepSeek reviewer invocation"
else
    ok "skills have no hardcoded DeepSeek reviewer invocation"
fi

exit "$fail"
