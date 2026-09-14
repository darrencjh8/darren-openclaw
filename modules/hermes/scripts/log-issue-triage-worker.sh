#!/bin/sh
# Run one read-only OpenCode triage worker against a prepared redacted snapshot.
set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: $0 SNAPSHOT.json" >&2
    exit 64
fi

snapshot=$1
case "$(basename "$snapshot")" in
    expense-tracker.json|hermes.json|portfolio-tracker.json) ;;
    *) echo "refusing unknown triage snapshot" >&2; exit 64 ;;
esac
snapshot=/opt/data/log-issue-triage/snapshots/"$(basename "$snapshot")"
[ -f "$snapshot" ] || { echo "snapshot does not exist" >&2; exit 66; }

output_dir=/opt/data/log-issue-triage/worker-output
mkdir -p "$output_dir"
name=$(basename "$snapshot" .json)
output="$output_dir/$name.txt"
tmp="$output.tmp"

# The agent has no edit, shell, task, web, question, or planning permission.
# `timeout` bounds stalled model calls and the only input is the redacted file.
timeout 120 opencode run \
    --dir /opt/data/log-issue-triage \
    --agent log-triage-worker \
    --model opencode/muse-spark-1.3-contributor-free \
    --variant high \
    --file "$snapshot" \
    "Inspect only the attached snapshot. Follow your agent contract exactly." \
    >"$tmp"
mv "$tmp" "$output"
printf '%s\n' "$output"
