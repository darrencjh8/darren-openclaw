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
    *) echo "unknown triage component" >&2; exit 64 ;;
esac

snapshot_dir=/opt/data/log-issue-triage/snapshots
state_dir=/opt/data/log-issue-triage/state
mkdir -p "$snapshot_dir" "$state_dir"
tmp=$(mktemp "$snapshot_dir/.${component}.raw.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM

# Capture failure separately; a broken Docker read must not masquerade as no logs.
timeout 30 docker logs --tail 500 "$component" >"$tmp"
python3 /opt/data/scripts/log-issue-triage-collect.py \
    --component "$component" \
    --source "$tmp" \
    --state-dir "$state_dir" \
    --max-lines 200 \
    --max-bytes 65536 \
    >"$snapshot_dir/$component.json"
printf '%s\n' "$snapshot_dir/$component.json"
