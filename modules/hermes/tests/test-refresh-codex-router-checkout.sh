#!/bin/bash
# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

# Contract + behaviour tests for scripts/refresh-codex-router-checkout.sh.
#
# Dev-loop sessions inside the Hermes container drive the gate from the
# container's own codex-router checkout (`codex/skills/dev-loop/scripts/loop.py`),
# so a checkout pinned to an old revision keeps running an old gate whatever the
# reconciled skill roots hold. Measured 2026-09-25: /workspace/codex-router sat at
# 2e0fcfc, six commits behind origin/main, while the skill roots were current.
#
# The refresh must therefore advance a clean checkout, never touch a dirty one (a
# live session owns it), skip an absent one, and fail only when a clean checkout
# cannot fast-forward. The behaviour cases run against real repositories, so the
# fast-forward and the dirty guard are executed rather than grepped.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE_DIR="$SCRIPT_DIR/.."
SCRIPT="$MODULE_DIR/scripts/refresh-codex-router-checkout.sh"
DEPLOY_SCRIPT="$SCRIPT_DIR/../../deploy.sh"
SEED_SCRIPT="$MODULE_DIR/50-seed-defaults"

fail=0
ok() { printf 'PASS %s\n' "$1"; }
nope() { printf 'FAIL %s\n' "$1"; fail=1; }

echo "=== the script ships and parses ==="
[ -f "$SCRIPT" ] && ok "refresh script exists" || nope "refresh script exists"
[ -x "$SCRIPT" ] && ok "refresh script is executable" || nope "refresh script is executable"
bash -n "$SCRIPT" && ok "refresh script parses" || nope "refresh script parses"

echo "=== both writers call the refresh ==="
grep -Fq -- 'refresh-codex-router-checkout.sh' "$DEPLOY_SCRIPT" \
    && ok "deploy.sh runs the refresh" || nope "deploy.sh runs the refresh"
grep -Fq -- 'docker exec -u hermes hermes' "$DEPLOY_SCRIPT" \
    && ok "deploy.sh runs it as the checkout's owner" || nope "deploy.sh runs it as the checkout's owner"
grep -Eq 'should_deploy "codex-router".*should_deploy "hermes"' "$DEPLOY_SCRIPT" \
    && ok "deploy.sh refreshes on a router-only and a hermes deploy" \
    || nope "deploy.sh refreshes on a router-only and a hermes deploy"
grep -Fq -- 'refresh-codex-router-checkout.sh' "$SEED_SCRIPT" \
    && ok "the boot hook refreshes the checkout" || nope "the boot hook refreshes the checkout"
grep -Eq "su -s /bin/sh hermes -c '[^']*refresh-codex-router-checkout" "$SEED_SCRIPT" \
    && ok "the boot hook runs the refresh as hermes" || nope "the boot hook runs the refresh as hermes"

echo "=== behaviour against real repositories ==="
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

origin="$sandbox/origin.git"
git init -q --bare "$origin"
git -C "$origin" symbolic-ref HEAD refs/heads/main
git init -q "$sandbox/seed"
(
    cd "$sandbox/seed"
    git symbolic-ref HEAD refs/heads/main
    printf 'one\n' > file.txt
    git add file.txt
    git commit -qm one
    git remote add origin "$origin"
    git push -q origin main
)
git clone -q "$origin" "$sandbox/checkout"
checkout="$sandbox/checkout"

advance_origin() {
    (
        cd "$sandbox/seed"
        printf '%s\n' "$1" >> file.txt
        git commit -qam "$1"
        git push -q origin main
    )
}

run_refresh() {
    rc=0
    out=$(CODEX_ROUTER_CHECKOUT="$checkout" "$SCRIPT" "$@" 2>&1) || rc=$?
}

# Already current: a no-op the deploy can run on every push.
before=$(git -C "$checkout" rev-parse HEAD)
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$before" ]; then
    ok "an up-to-date checkout is left alone and exits 0"
else
    nope "an up-to-date checkout is left alone and exits 0 (rc=$rc): $out"
fi

# Behind: fast-forward to the fetched head.
advance_origin second
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$(git -C "$sandbox/seed" rev-parse HEAD)" ]; then
    ok "a clean stale checkout fast-forwards to origin/main"
else
    nope "a clean stale checkout fast-forwards to origin/main (rc=$rc): $out"
fi

# An explicit target wins over the fetched head: the deploy pins its revision.
advance_origin third
target=$(git -C "$sandbox/seed" rev-parse HEAD~1)
run_refresh "$target"
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$target" ]; then
    ok "an explicit revision is checked out instead of the fetched head"
else
    nope "an explicit revision is checked out instead of the fetched head (rc=$rc): $out"
fi

# Dirty: a live session owns the checkout. Leave the bytes and the HEAD alone.
printf 'session work\n' >> "$checkout/file.txt"
advance_origin fourth
dirty_head=$(git -C "$checkout" rev-parse HEAD)
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$dirty_head" ] \
    && grep -q 'session work' "$checkout/file.txt"; then
    ok "a dirty checkout is skipped with its work intact"
else
    nope "a dirty checkout is skipped with its work intact (rc=$rc): $out"
fi
git -C "$checkout" checkout -q -- file.txt

# Diverged: clean but not a fast-forward. That is an environment bug, not a skip.
(
    cd "$checkout"
    printf 'local\n' > local.txt
    git add local.txt
    git commit -qm local
)
run_refresh
if [ "$rc" -ne 0 ]; then
    ok "a clean diverged checkout fails loudly instead of being forced"
else
    nope "a clean diverged checkout fails loudly instead of being forced: $out"
fi

# Absent: a container that has not created the checkout yet is not an error.
rc=0
out=$(CODEX_ROUTER_CHECKOUT="$sandbox/absent" "$SCRIPT" 2>&1) || rc=$?
if [ "$rc" -eq 0 ]; then
    ok "an absent checkout is skipped and exits 0"
else
    nope "an absent checkout is skipped and exits 0 (rc=$rc): $out"
fi

exit "$fail"
