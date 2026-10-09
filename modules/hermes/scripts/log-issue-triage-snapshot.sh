#!/bin/bash
# Emit one bounded, redacted snapshot of the LATEST logs for a fixed service.
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: $0 expense-tracker|hermes|portfolio-tracker|actual-api|codex-router" >&2
    exit 64
fi

component=$1
case "$component" in
    expense-tracker|hermes|portfolio-tracker|actual-api|codex-router) ;;
    *) echo "unknown triage component" >&2; exit 64 ;;
esac

# Compose runs with project name `modules` (modules/deploy.sh), so containers
# are modules-<service>-1; hermes alone sets container_name. `docker logs`
# takes a container, not a service, so the bare service name is "no such
# container" for everything but hermes. codex-router is three containers: the
# caddy front plus both colour backends.
case "$component" in
    hermes) containers="hermes" ;;
    codex-router) containers="modules-codex-router-1 modules-codex-router-a-1 modules-codex-router-b-1" ;;
    *) containers="modules-$component-1" ;;
esac

snapshot_dir=/opt/data/log-issue-triage/snapshots
state_dir=/opt/data/log-issue-triage/state
snapshot="$snapshot_dir/$component.json"
since_file="$state_dir/$component.since"
mkdir -p "$snapshot_dir" "$state_dir"
# Drop any previous run's snapshot first, so a failure below cannot leave the
# caller reading stale evidence from an earlier run.
rm -f "$snapshot"

# Latest-only window: the first run bounds to the last 24h; each success stores
# its start time and the next run resumes from it. A failure exits before the
# store, so the next run retries the same window instead of skipping past it.
# The start (not end) timestamp is stored so logs written during the run are
# re-seen rather than lost.
run_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
since="24h"
if [ -s "$since_file" ]; then
    since=$(cat "$since_file")
fi

# Write to a temp file and publish only on success. Redirecting straight at
# "$snapshot" truncates it before the collector runs, so a collector that died
# mid-write left a PARTIAL snapshot that the next run read as a fresh sample and
# re-triaged as new leads. With `set -e` a failing pipeline aborts before the
# move, so nothing is published and no path is printed.
tmp="$snapshot.tmp.$$"
trap 'rm -f "$tmp"' EXIT INT TERM

# Stream directly into the redactor: no raw log artifact is persisted and each
# bounded Docker tail is a standalone sample rather than a stale file cursor.
# Missing containers (e.g. the idle colour backend) contribute nothing; each
# present container gets its own --since/--tail bound so one chatty container
# cannot starve the others. A component with no evidence in the window is a
# broken snapshotter window, not a healthy one: exit non-zero so the cron job
# reports TRIAGE-BROKEN instead of triaging silence as clean.
{
    # shellcheck disable=SC2086
    for container in $containers; do
        timeout 30 docker logs --since "$since" --tail 200 "$container" 2>/dev/null || true
    done
} |
    python3 /opt/data/scripts/log-issue-triage-collect.py \
        --component "$component" \
        --source - \
        --state-dir "$state_dir" \
        --max-lines 200 \
        --max-bytes 65536 \
        >"$tmp"
if ! python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["line_count"] else 1)' "$tmp"; then
    echo "no log evidence for $component since $since" >&2
    exit 69
fi
mv "$tmp" "$snapshot"
printf '%s' "$run_started" >"$since_file"
printf '%s\n' "$snapshot"
