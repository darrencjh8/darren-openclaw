#!/bin/bash
# Emit one bounded, redacted snapshot for a fixed Docker service.
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: $0 expense-tracker|hermes|portfolio-tracker" >&2
    exit 64
fi

component=$1
case "$component" in
    expense-tracker|hermes|portfolio-tracker) ;;
    *) echo "unknown triage component" >&2; exit 64 ;;
esac

snapshot_dir=/opt/data/log-issue-triage/snapshots
state_dir=/opt/data/log-issue-triage/state
snapshot="$snapshot_dir/$component.json"
mkdir -p "$snapshot_dir" "$state_dir"
# Drop any previous run's snapshot first, so a failure below cannot leave the
# caller reading stale evidence from an earlier run.
rm -f "$snapshot"
# Write to a temp file and publish only on success. Redirecting straight at
# "$snapshot" truncates it before the collector runs, so a collector that died
# mid-write left a PARTIAL snapshot that the next run read as a fresh sample and
# re-triaged as new leads. With `set -e` a failing pipeline aborts before the
# move, so nothing is published and no path is printed.
tmp="$snapshot.tmp.$$"
trap 'rm -f "$tmp"' EXIT INT TERM

# Stream directly into the redactor: no raw log artifact is persisted and each
# bounded Docker tail is a standalone sample rather than a stale file cursor.
timeout 30 docker logs --tail 500 "$component" |
    python3 /opt/data/scripts/log-issue-triage-collect.py \
        --component "$component" \
        --source - \
        --state-dir "$state_dir" \
        --max-lines 200 \
        --max-bytes 65536 \
        >"$tmp"
mv "$tmp" "$snapshot"
printf '%s\n' "$snapshot"
