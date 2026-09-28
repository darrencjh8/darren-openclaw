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
    # The sync can abort before it assembles a payload (an Actual Budget outage
    # throws out of fetchBudget). Report that reason first: without it the log
    # showed only placeholders and the aborting cause was lost entirely.
    if data.get('error'):
        print(f'  error: {data["error"]}')
    targets = data.get('sync_targets', [])
    for t in targets:
        name = t.get('name', '?')
        status = t.get('status', '?')
        delta = t.get('delta', 0)
        print(f'  {name}: {status} (delta={delta})')
        if t.get('error'):
            print(f'    {t["error"]}')
    # Every remote leg, not just pull/push: the IBKR flex legs fail silently
    # the same way and on their own token expiry. `or '?'` and `or ''` cover an
    # explicit null as well as a missing key, so a null never prints `None`.
    for leg in ('pull', 'push', 'flex_pull', 'flex_import'):
        r = data.get(leg)
        if not isinstance(r, dict):
            print(f'  {leg}: ? ()')
            continue
        status = r.get('status') or r.get('success')
        detail = r.get('detail') or r.get('error') or ''
        # A flex leg this deployment never configured is not a failure. The MCP
        # surface skips it via the `skipped` flag set by pullFlexXml; match that
        # here, and also accept the bare error string so both surfaces agree.
        if r.get('skipped') or detail == 'Not configured':
            continue
        if leg.startswith('flex') and status is True:
            status = 'ok'
        elif leg.startswith('flex') and status is False:
            status = 'error'
        # PpClient.importIbkr always sets status:"ok" and reports per-item
        # failures in a separate errors[] list, so a dropped import looks like a
        # success here unless the list itself is surfaced.
        item_errors = r.get('errors') or []
        if leg == 'flex_import' and item_errors:
            n = len(item_errors)
            print(f'  {leg}: error ({n} item{"" if n == 1 else "s"} failed to import - '
                  f'{"; ".join(str(e) for e in item_errors)})')
            continue
        print(f'  {leg}: {status if status is not None else "?"} ({detail})')
except Exception as e:
    print(f'  (parse error: {e})')
PARSE_EOF

echo "$BODY" | python3 -c "$PARSE_PROG" 2>/dev/null || true

log "sync complete"
