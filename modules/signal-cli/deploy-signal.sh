#!/usr/bin/env bash
# =============================================================================
# Signal CLI — standalone deploy
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/modules/signal-cli"

echo "=== Signal CLI Deploy ==="
echo ""

# Ensure shared network exists
echo "--- Ensuring shared network ---"
docker network create hermes_shared --driver bridge 2>/dev/null || true

# Ensure data dir
mkdir -p /home/runner/data/signal-cli

# Pull latest image
echo "--- Pulling latest image ---"
docker compose pull

# Deploy
echo ""
echo "--- Starting signal-cli ---"
docker compose up -d

# Health check
echo ""
echo "--- Health Check ---"
for i in $(seq 1 10); do
    if curl -sf http://127.0.0.1:8084/api/v1/check >/dev/null 2>&1; then
        echo "  ✓ signal-cli running"
        echo ""
        echo "=== Deploy complete ==="
        echo ""
        echo "Next: link your phone number"
        echo "  docker compose -f modules/signal-cli/docker-compose.yml run --rm signal-cli signal-cli link -n \"Friday\""
        exit 0
    fi
    echo "  ... waiting ($i/10)"
    sleep 3
done

echo "  ✗ signal-cli failed to start"
echo "  Check logs: cd modules/signal-cli && docker compose logs"
exit 1
