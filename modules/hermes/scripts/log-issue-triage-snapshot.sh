#!/bin/sh
# Emit one bounded, redacted snapshot for a fixed Docker service.
set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: $0 expense-tracker|hermes|portfolio-tracker" >&2
    exit 64
fi

component=$1
case "$component" in
    expense-tracker|hermes|portfolio-tracker) ;;
    *) echo "unsupported component: $component" >&2; exit 64 ;;
esac

snapshot_dir=/opt/data/log-issue-triage/snapshots
mkdir -p "$snapshot_dir"
tmp="$snapshot_dir/$component.json.tmp"
output="$snapshot_dir/$component.json"

# Docker is the sole raw-log reader. The collector receives stdin, redacts before
# writing, and caps the artifact that the external worker may inspect.
docker logs --since 25h --tail 1500 "$component" 2>&1 | \
    python3 /opt/data/scripts/log-issue-triage-collect.py \
        --component "$component" \
        --source - \
        --state-dir /opt/data/log-issue-triage/cursors \
        --max-lines 300 \
        --max-bytes 32768 >"$tmp"
mv "$tmp" "$output"
printf '%s\n' "$output"
