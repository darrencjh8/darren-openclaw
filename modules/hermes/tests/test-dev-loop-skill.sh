#!/bin/bash
# Contract tests for the baked-in dev-loop skill.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$SCRIPT_DIR/../skills"
DEV_LOOP_SKILL="$SKILL_DIR/dev-loop/SKILL.md"
CODE_REVIEWER_SKILL="$SKILL_DIR/code-reviewer/SKILL.md"
SPEC_AUDITOR_SKILL="$SKILL_DIR/spec-auditor/SKILL.md"
REPO_RULES="$SCRIPT_DIR/../../../AGENTS.md"
SPEC_AUDITOR_PROFILE="$SCRIPT_DIR/../profiles/spec-auditor"

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
[ -f "$SPEC_AUDITOR_SKILL" ] && ok "spec-auditor skill is baked in" || nope "spec-auditor skill is baked in"
require "$DEV_LOOP_SKILL" "skill pulls origin main before planning" "git pull --ff-only origin <default-branch>"
require "$DEV_LOOP_SKILL" "skill creates a worktree from verified origin" "Create a new isolated \`feat/...\` or \`fix/...\` worktree and branch from that verified \`origin/<default-branch>\` SHA"
require "$DEV_LOOP_SKILL" "skill uses the sole reviewer profile" "--profile code-reviewer"
require "$DEV_LOOP_SKILL" "skill uses one reviewer per round" "One fresh isolated Hermes process per round."
require "$DEV_LOOP_SKILL" "skill requires two consecutive clean rounds" "two clean rounds from fresh sessions on the **same unchanged HEAD SHA**"
require "$DEV_LOOP_SKILL" "skill resolves optional specifications" "If a relevant specification exists"
require "$DEV_LOOP_SKILL" "skill invokes spec-auditor before code review" "--profile spec-auditor"
require "$DEV_LOOP_SKILL" "skill verifies the launch routes to the caller-selected reviewer model" "the launch routes to the caller-selected reviewer model"
require "$DEV_LOOP_SKILL" "skill owns the loop through merge" "Own the loop through completion."
require "$CODE_REVIEWER_SKILL" "reviewer skill pins the managed profile" "managed \`code-reviewer\` profile"
require "$CODE_REVIEWER_SKILL" "reviewer skill allows the reviewer model set" "allowed set: \`gpt-5.6-terra\` (Terra), \`glm-5.2\` (OpenCode Go), or \`deepseek-v4-flash\`"
require "$REPO_RULES" "repo rules require one reviewer per round" "one independent fresh-context code-reviewer per round"
require "$REPO_RULES" "repo rules invoke spec-auditor when a spec exists" "invoke spec-auditor before code review"

for profile_file in config.yaml profile.yaml SOUL.md; do
    [ -f "$SPEC_AUDITOR_PROFILE/$profile_file" ] \
        && ok "spec-auditor profile has $profile_file" \
        || nope "spec-auditor profile has $profile_file"
done

if grep -Fq -- "--provider deepseek" "$DEV_LOOP_SKILL" || grep -Fq -- "deepseek-v4-pro --reasoning" "$DEV_LOOP_SKILL" || grep -Fq -- "pinned to **DeepSeek" "$CODE_REVIEWER_SKILL"; then
    nope "skills have no hardcoded DeepSeek reviewer invocation"
else
    ok "skills have no hardcoded DeepSeek reviewer invocation"
fi

if grep -Fqi -- "two independent fresh-context review" "$REPO_RULES"; then
    nope "repo rules do not require two reviewers per round"
else
    ok "repo rules do not require two reviewers per round"
fi

exit "$fail"
