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

# Log a compact summary
echo "$BODY" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    targets = data.get('sync_targets', [])
    for t in targets:
        name = t.get('name', '?')
        status = t.get('status', '?')
        delta = t.get('delta', 0)
        print(f'  {name}: {status} (delta={delta})')
except Exception as e:
    print(f'  (parse error: {e})')
" 2>/dev/null || true

log "sync complete"
