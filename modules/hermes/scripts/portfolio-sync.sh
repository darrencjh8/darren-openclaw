#!/bin/bash
# Portfolio sync — deterministic REST call, zero LLM tokens.
# curl → pp-sync-all → done. Cron runs this via no_agent: true.
set -euo pipefail

log()  { echo "[portfolio-sync] $(date -Iseconds) $*" >&2; }

ENDPOINT="http://portfolio-tracker:8081/tools/pp-sync-all"

log "triggering sync via $ENDPOINT"

RESP=$(curl -s -w "\n%{http_code}" -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d '{}' \
    --max-time 300 2>&1)

HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

log "HTTP $HTTP_CODE"

if [ "$HTTP_CODE" != "200" ]; then
    log "ERROR: sync failed — HTTP $HTTP_CODE"
    echo "$BODY" >&2
    exit 1
fi

# Log a compact summary.
# The program is read by a QUOTED heredoc, so bash performs no expansion and no
# quote removal on it, and it reaches python3 byte-identical. Passing the same
# text through `python3 -c "..."` mangles every quote inside it: double-quoted
# dict keys arrive as bare identifiers and raise SyntaxError, which the
# `2>/dev/null || true` below swallows, so the script would exit 0 having
# printed nothing at all. Keep the quoting out of bash's reach.
read -r -d '' PARSE_PROG <<'PARSE_EOF' || true
import sys, json
try:
    data = json.load(sys.stdin)
    targets = data.get('sync_targets', [])
    for t in targets:
        name = t.get('name', '?')
        status = t.get('status', '?')
        delta = t.get('delta', 0)
        print(f'  {name}: {status} (delta={delta})')
    for leg in ('pull', 'push'):
        r = data.get(leg) or {}
        print(f'  {leg}: {r.get("status", "?")} ({r.get("detail", "")})')
except Exception as e:
    print(f'  (parse error: {e})')
PARSE_EOF

echo "$BODY" | python3 -c "$PARSE_PROG" 2>/dev/null || true

log "sync complete"
