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
sh -n "$SCRIPT" && ok "refresh script parses as POSIX sh" || nope "refresh script parses as POSIX sh"

echo "=== both writers call the refresh ==="
grep -Fq -- 'refresh-codex-router-checkout.sh' "$DEPLOY_SCRIPT" \
    && ok "deploy.sh runs the refresh" || nope "deploy.sh runs the refresh"
grep -Fq -- 'docker exec -u hermes hermes' "$DEPLOY_SCRIPT" \
    && ok "deploy.sh runs it as the checkout's owner" || nope "deploy.sh runs it as the checkout's owner"
# The router-or-hermes scope itself is asserted against the new block in
# test_deploy_workflow_router.py: matching it here also matched the sibling
# skills block, so it passed before the block existed.
grep -Fq -- 'refresh-codex-router-checkout.sh' "$SEED_SCRIPT" \
    && ok "the boot hook refreshes the checkout" || nope "the boot hook refreshes the checkout"
grep -Eq "su -s /bin/sh hermes -c '/opt/hermes-defaults/scripts/refresh-codex-router-checkout\\.sh'" "$SEED_SCRIPT" \
    && ok "the boot hook runs the baked refresh as hermes" || nope "the boot hook runs the baked refresh as hermes"

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
    # Always through `sh`, never the shebang: the deploy runs `sh <path>`, so a
    # bash-only body must fail here rather than in production.
    rc=0
    out=$(CODEX_ROUTER_CHECKOUT="$checkout" sh "$SCRIPT" "$@" 2>&1) || rc=$?
}

# Already current: a no-op the deploy can run on every push.
before=$(git -C "$checkout" rev-parse HEAD)
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$before" ]; then
    ok "an up-to-date checkout is left alone and exits 0"
else
    nope "an up-to-date checkout is left alone and exits 0 (rc=$rc): $out"
fi

# Behind: fast-forward to the fetched head, and name the revision it landed on so
# a deploy log carries the SHA the container ended up at.
advance_origin second
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$(git -C "$sandbox/seed" rev-parse HEAD)" ] \
    && printf '%s' "$out" | grep -q "$(git -C "$checkout" rev-parse --short HEAD)"; then
    ok "a clean stale checkout fast-forwards to origin/main and prints the new short SHA"
else
    nope "a clean stale checkout fast-forwards to origin/main and prints the new short SHA (rc=$rc): $out"
fi

# An explicit target wins over the fetched head: the deploy pins the revision it
# checked out. HEAD is deliberately behind the target and the target is
# deliberately behind the fetched head, so an implementation that only
# fast-forwards to FETCH_HEAD lands on the wrong commit and fails here.
advance_origin third
advance_origin fourth
fetched=$(git -C "$sandbox/seed" rev-parse HEAD)
target=$(git -C "$sandbox/seed" rev-parse HEAD~1)
run_refresh "$target"
checkout_head=$(git -C "$checkout" rev-parse HEAD)
if [ "$rc" -eq 0 ] && [ "$checkout_head" = "$target" ] && [ "$checkout_head" != "$fetched" ]; then
    ok "an explicit revision is checked out instead of the fetched head"
else
    nope "an explicit revision is checked out instead of the fetched head (rc=$rc, head=$checkout_head, target=$target, fetched=$fetched): $out"
fi

# A target HEAD already contains is satisfied, not forced: boot may already have
# advanced past the revision a later deploy pins.
contained=$(git -C "$checkout" rev-parse HEAD~1 2>/dev/null || true)
run_refresh "$contained"
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$checkout_head" ]; then
    ok "a target the checkout already contains is a no-op"
else
    nope "a target the checkout already contains is a no-op (rc=$rc): $out"
fi

# On a session's own branch the base checkout is not ours to move.
git -C "$checkout" checkout -q -b session-work
advance_origin fifth
branch_head=$(git -C "$checkout" rev-parse HEAD)
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$branch_head" ] \
    && [ "$(git -C "$checkout" rev-parse --abbrev-ref HEAD)" = "session-work" ]; then
    ok "a checkout on another branch is skipped"
else
    nope "a checkout on another branch is skipped (rc=$rc): $out"
fi
git -C "$checkout" checkout -q main

# A detached HEAD is a skip, not a silent success with an empty branch name.
git -C "$checkout" checkout -q --detach
detached_head=$(git -C "$checkout" rev-parse HEAD)
run_refresh
if [ "$rc" -eq 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$detached_head" ] \
    && printf '%s' "$out" | grep -q "on 'HEAD'"; then
    ok "a detached HEAD is skipped and named"
else
    nope "a detached HEAD is skipped and named (rc=$rc): $out"
fi
git -C "$checkout" checkout -q main

# An object that exists locally but is not on the fetched branch is not a valid
# target: reachability is the contract, not local object presence.
git -C "$checkout" checkout -q -b side-work
printf 'side\n' > "$checkout/side.txt"
git -C "$checkout" add side.txt
git -C "$checkout" commit -qm side
side_commit=$(git -C "$checkout" rev-parse HEAD)
git -C "$checkout" checkout -q main
side_head=$(git -C "$checkout" rev-parse HEAD)
run_refresh "$side_commit"
if [ "$rc" -ne 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$side_head" ]; then
    ok "a target only reachable locally is refused without moving"
else
    nope "a target only reachable locally is refused without moving (rc=$rc): $out"
fi

# Dirty: a live session owns the checkout. Leave the bytes and the HEAD alone.
printf 'session work\n' >> "$checkout/file.txt"
advance_origin sixth
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

# A target the fetch did not bring is an error, not a silent no-op: the deploy's
# revision and the branch it fetched must agree.
diverged_head=$(git -C "$checkout" rev-parse HEAD)
run_refresh "$(git -C "$sandbox/seed" rev-parse HEAD)"
if [ "$rc" -ne 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$diverged_head" ]; then
    ok "a diverged checkout refuses a reachable target without moving"
else
    nope "a diverged checkout refuses a reachable target without moving (rc=$rc): $out"
fi
run_refresh 0000000000000000000000000000000000000000
if [ "$rc" -ne 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$diverged_head" ]; then
    ok "a target missing from the fetched history fails without moving"
else
    nope "a target missing from the fetched history fails without moving (rc=$rc): $out"
fi

# An unreachable origin is the most likely production failure (network, gh
# credentials). It must fail loudly and move nothing.
git -C "$checkout" remote set-url origin "$sandbox/absent.git"
run_refresh
if [ "$rc" -ne 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$diverged_head" ]; then
    ok "an unreachable origin fails the fetch without moving HEAD"
else
    nope "an unreachable origin fails the fetch without moving HEAD (rc=$rc): $out"
fi
git -C "$checkout" remote set-url origin "$origin"

# Busy lock: another writer is refreshing the same checkout. The deploy must see
# a failure rather than report success on a revision it never applied.
(
    flock -w 5 9
    sleep 5
) 9>"$checkout/.git/codex-router-checkout.lock" &
lock_holder=$!
sleep 1
rc=0
out=$(CODEX_ROUTER_CHECKOUT="$checkout" CODEX_ROUTER_LOCK_WAIT_SECONDS=1 sh "$SCRIPT" 2>&1) || rc=$?
wait "$lock_holder" 2>/dev/null || true
if [ "$rc" -ne 0 ] && [ "$(git -C "$checkout" rev-parse HEAD)" = "$diverged_head" ]; then
    ok "a held lock fails the run and leaves every ref alone"
else
    nope "a held lock fails the run and leaves every ref alone (rc=$rc): $out"
fi

# Absent: a container that has not created the checkout yet is not an error.
rc=0
out=$(CODEX_ROUTER_CHECKOUT="$sandbox/absent" CODEX_ROUTER_LOCK_WAIT_SECONDS=1 sh "$SCRIPT" 2>&1) || rc=$?
if [ "$rc" -eq 0 ]; then
    ok "an absent checkout is skipped and exits 0"
else
    nope "an absent checkout is skipped and exits 0 (rc=$rc): $out"
fi

exit "$fail"
