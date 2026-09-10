#!/bin/bash
# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

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
require "$DEV_LOOP_SKILL" "skill pins paid round one" "Round 1 uses \`auto-thinking\`"
require "$DEV_LOOP_SKILL" "skill pins later free rounds" "Rounds 2-15 use \`auto-thinking-free\`"
require "$DEV_LOOP_SKILL" "skill caps free concurrency" "at most two concurrent reviewers"
require "$DEV_LOOP_SKILL" "skill requires three approvals" "three continuous fresh-context approvals on the **same unchanged HEAD SHA**"
require "$DEV_LOOP_SKILL" "skill disables cross-tier fallback" "Never substitute the paid and free reviewer models"
require "$DEV_LOOP_SKILL" "skill resolves optional specifications" "If a relevant specification exists"
require "$DEV_LOOP_SKILL" "skill invokes spec-auditor before code review" "--profile spec-auditor"
require "$DEV_LOOP_SKILL" "skill verifies the launch routes to the round model" "the launch routes to the model required for that round"
require "$DEV_LOOP_SKILL" "skill selects the free model for later launches" "REVIEWER_MODEL=auto-thinking-free"
require "$DEV_LOOP_SKILL" "review command passes the selected model" '--model "$REVIEWER_MODEL"'
require "$DEV_LOOP_SKILL" "skill owns the loop through merge" "Own the loop through completion."
require "$CODE_REVIEWER_SKILL" "reviewer skill pins the managed profile" "managed \`code-reviewer\` profile"
require "$CODE_REVIEWER_SKILL" "reviewer skill pins round models" "Round 1 uses \`auto-thinking\`; every later round uses \`auto-thinking-free\`"
require "$REPO_RULES" "repo rules permit free concurrency" "up to two concurrent fresh-context reviewers on free rounds"
require "$REPO_RULES" "repo rules require three approvals" "three continuous approvals on the same unchanged HEAD"
require "$REPO_RULES" "repo rules invoke spec-auditor when a spec exists" "invoke spec-auditor before code review"

selector=$(sed -n '/^case "${REVIEW_ROUND-}" in$/,/^esac$/p' "$DEV_LOOP_SKILL")
if [ -n "$selector" ]; then
    ok "round selector is executable"
else
    nope "round selector is executable"
fi
for pair in "1:auto-thinking" "2:auto-thinking-free" "15:auto-thinking-free"; do
    round=${pair%%:*}
    expected=${pair#*:}
    if actual=$(REVIEW_ROUND="$round" bash -c "$selector; printf '%s' \"\$REVIEWER_MODEL\"") && [ "$actual" = "$expected" ]; then
        ok "round $round selects $expected"
    else
        nope "round $round selects $expected"
    fi
done
for invalid_round in "" malformed 0 -1 16; do
    if REVIEW_ROUND="$invalid_round" bash -c "$selector" >/dev/null 2>&1; then
        nope "invalid round ${invalid_round:-unset} fails closed"
    else
        ok "invalid round ${invalid_round:-unset} fails closed"
    fi
done

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

exit "$fail"
