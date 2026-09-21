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
# Overridable so the harness can exercise this script end to end against a
# fixture instead of the live tree. Production keeps the default. Issue #582.
triage_root=${TRIAGE_ROOT:-/opt/data/log-issue-triage}
snapshot=$triage_root/snapshots/"$(basename "$snapshot")"
[ -f "$snapshot" ] || { echo "snapshot does not exist" >&2; exit 66; }

output_dir=$triage_root/worker-output
mkdir -p "$output_dir"
name=$(basename "$snapshot" .json)
output="$output_dir/$name.txt"

# Drop any previous run's verdict first so a failed or timed-out worker can
# never leave stale leads that the orchestrator would read as fresh.
rm -f "$output"
tmp="$output.tmp.$$"
trap 'rm -f "$tmp"' EXIT INT TERM

# The agent has no edit, shell, task, web, question, or planning permission.
# `timeout` bounds stalled model calls and the only input is the redacted file.
#
# The message must come BEFORE the options: `--file` is an array-typed option
# (opencode CLI 1.18.31), so it greedily consumes every following non-option
# token. With the message last, `opencode run` received no message, treated the
# prompt as a second attachment, and exited with
# `Error: File not found: Inspect only the attached snapshot...`, so the daily
# triage produced no lead while its status still read ok. Issue #582.
timeout 120 opencode run \
    "Inspect only the attached snapshot. Follow your agent contract exactly." \
    --dir "$triage_root" \
    --agent log-triage-worker \
    --model opencode/muse-spark-1.3-contributor-free \
    --variant high \
    --file "$snapshot" \
    >"$tmp"
mv "$tmp" "$output"
printf '%s\n' "$output"
