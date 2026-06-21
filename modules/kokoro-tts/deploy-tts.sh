#!/usr/bin/env bash
# =============================================================================
# Kokoro TTS — standalone deploy
#
# This compose is separate from the main modules/docker-compose.yml.
# deploy.sh never touches this service.
#
# Usage: ./modules/kokoro-tts/deploy-tts.sh
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/modules/kokoro-tts"

echo "=== Kokoro TTS Deploy ==="
echo ""

# Pull latest image
echo "--- Pulling latest image ---"
docker compose pull

# Deploy
echo ""
echo "--- Starting kokoro-tts ---"
docker compose up -d

# Health check
echo ""
echo "--- Health Check ---"
for i in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:8880/health 2>/dev/null || echo "000")
    if [ "$code" = "200" ]; then
        echo "  ✓ kokoro-tts healthy (http://127.0.0.1:8880)"
        echo ""
        echo "=== Deploy complete ==="
        exit 0
    fi
    echo "  ... waiting ($i/10)"
    sleep 3
done

echo "  ✗ kokoro-tts failed health check"
echo "  Check logs: cd modules/kokoro-tts && docker compose logs"
exit 1
