#!/bin/sh
set -e

# Write cron file at runtime — inject needed env vars so cron jobs see them
cat > /etc/cron.d/ktmb-worker << CRONEOF
SHELL=/bin/sh
PATH=/usr/local/bin:/usr/bin:/bin
KTMB_DB_PATH=${KTMB_DB_PATH:-/app/data/ktmb_jobs.db}
KTMB_NOTIFY_URL=${KTMB_NOTIFY_URL:-http://hermes:8644/webhooks/notify}
KTMB_NOTIFY_TOKEN=${KTMB_NOTIFY_TOKEN:-}
KTMB_EMAIL=${KTMB_EMAIL:-}
KTMB_PASSWORD=${KTMB_PASSWORD:-}
KTMB_CAPTCHA_KEY=${KTMB_CAPTCHA_KEY:-}
KTMB_POLL_INTERVAL=${KTMB_POLL_INTERVAL:-60}
KTMB_MAX_RETRIES=${KTMB_MAX_RETRIES:-5}
KTMB_SERVER_URL=${KTMB_SERVER_URL:-http://localhost:47079}
* * * * * root cd /app && /usr/local/bin/python ktmb_worker.py >> /var/log/ktmb-cron.log 2>&1
CRONEOF
chmod 0600 /etc/cron.d/ktmb-worker

# Graceful shutdown: stop cron, wait for worker, then exit
cleanup() {
    echo "[entrypoint] SIGTERM received — graceful shutdown..."
    # Stop new worker launches
    rm -f /etc/cron.d/ktmb-worker
    # Kill cron daemon
    pkill cron 2>/dev/null || true
    # Wait for running worker to finish (max 60s)
    for i in $(seq 1 60); do
        if [ ! -f /tmp/ktmb_worker.lock ]; then
            echo "[entrypoint] Worker finished after ${i}s"
            break
        fi
        sleep 1
    done
    # Kill MCP server
    kill "$MCP_PID" 2>/dev/null || true
    wait "$MCP_PID" 2>/dev/null || true
    echo "[entrypoint] Shutdown complete"
    exit 0
}
trap cleanup TERM INT

# Start cron daemon
cron

# Start MCP server in background (so shell stays as PID 1 for signal handling)
python -m src.mcp_server &
MCP_PID=$!
wait "$MCP_PID"
